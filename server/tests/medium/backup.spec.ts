import { openDatabase } from '#src/db/open';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { backupStorage, restoreStorage } from '#src/migrations/backup';
import { StorageFile } from '#src/migrations/storage';
import { AccountsService } from '#src/services/auth.service';
import { JobsService } from '#src/services/jobs.service';
import { UploadsService } from '#src/services/uploads.service';
import { binary, mediumFixture } from '#tests/medium/support';
import { create } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { z } from 'zod';

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

/** A storage directory with one completed activity and one pending delivery, backed up. */
async function backedUp(t: TestContext) {
  const f = await mediumFixture(t);
  f.services.documents.put(f.rider.player_id, 'runalyze_token.txt', 'token');

  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Backed up',
    startDate: new Date().toISOString(),
    distanceInMeters: 3000,
    fitFilename: 'ride.fit',
    fit,
  };

  const response = await f.request(`/api/profiles/${f.rider.player_id}/activities`, {
    method: 'POST',
    ...binary(ActivitySchema, data),
  });

  const { id } = z.object({ id: z.number() }).parse(await response.json());
  f.services.activities.finalize(create(ActivitySchema, { ...data, id: BigInt(id) }));
  const backup = mkdtempSync(resolve(tmpdir(), 'zluggish-backup-'));
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  backupStorage(f.config.storageDir, backup, null);

  return { f, backup };
}

function reopen(t: TestContext, f: Awaited<ReturnType<typeof mediumFixture>>) {
  const accounts = new AccountsService(f.config.storageDir);
  const context = { ...f, accounts, settings: accounts.repositories.settingsRepository };
  const uploads = new UploadsService(context);
  const jobs = new JobsService(context);
  uploads.registerJobs(jobs);
  t.after(async () => {
    await jobs.close();
    accounts.close();
  });

  return { accounts, uploads, jobs };
}

await test('a restored backup sends no delivery that was sent after the backup', async (t) => {
  const { f, backup } = await backedUp(t);
  const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));
  await f.services.jobs.drain();
  assert.equal(sends.mock.callCount(), 1);
  assert.equal(f.services.uploads.status(f.rider.player_id)[0]?.state, 'sent');
  f.accounts.close();

  restoreStorage(f.config.storageDir, backup, null);
  const restored = reopen(t, f);
  restored.uploads.start();
  restored.jobs.start();
  await restored.jobs.drain();
  assert.equal(restored.uploads.status(f.rider.player_id)[0]?.state, 'pending');
  assert.equal(sends.mock.callCount(), 1, 'the upload pause stops the restored delivery');
  assert.equal(restored.accounts.repositories.systemFlagsRepository.get('uploads.paused')?.startsWith('restore'), true);

  // The operator cancels the restored delivery before clearing the pause.
  assert.equal(restored.accounts.repositories.uploadsRepository.cancel(1, 'runalyze'), true);
  restored.accounts.repositories.systemFlagsRepository.clear('uploads.paused');
  await restored.jobs.drain();
  assert.equal(sends.mock.callCount(), 1);
});

await test('a restore without the credentials key stops with a clear error', async (t) => {
  const { f, backup } = await backedUp(t);
  rmSync(resolve(backup, StorageFile.CredentialsKey));
  const manifestPath = resolve(backup, 'backup-manifest.json');

  const manifest = z
    .object({ checksums: z.record(z.string(), z.string()) })
    .loose()
    .parse(JSON.parse(readFileSync(manifestPath, 'utf8')));

  delete manifest.checksums[StorageFile.CredentialsKey];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  f.accounts.close();
  assert.throws(() => restoreStorage(f.config.storageDir, backup, null), /no credentials-key\.bin/);
  assert.equal(existsSync(resolve(f.config.storageDir, StorageFile.RestoreMarker)), false);
});

await test('a backup holds the configuration and a restore puts it back', async (t) => {
  const { f } = await backedUp(t);
  const config = resolve(f.config.storageDir, '..', 'zluggish-test.config.ts');
  writeFileSync(config, 'export default { storageDir: "x" };');
  t.after(() => rmSync(config, { force: true }));
  const backup = mkdtempSync(resolve(tmpdir(), 'zluggish-backup-'));
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  backupStorage(f.config.storageDir, backup, config);
  assert.equal(
    readFileSync(resolve(backup, 'config', 'zluggish-test.config.ts'), 'utf8'),
    'export default { storageDir: "x" };',
  );
  assert.throws(() => backupStorage(f.config.storageDir, backup, config), /not empty/);
  writeFileSync(config, 'changed');
  f.accounts.close();
  restoreStorage(f.config.storageDir, backup, config);
  assert.equal(readFileSync(config, 'utf8'), 'export default { storageDir: "x" };');
});

await test('a changed backup file stops the restore before it changes storage', async (t) => {
  const { f, backup } = await backedUp(t);
  writeFileSync(resolve(backup, StorageFile.CredentialsKey), 'changed');
  f.accounts.close();
  assert.throws(() => restoreStorage(f.config.storageDir, backup, null), /missing or changed/);
});

for (const step of ['marked', 'prepared', 'published', 'copied'] as const)
  await test(`a restore stopped after the ${step} step blocks startup until it runs again`, async (t) => {
    const { f, backup } = await backedUp(t);
    const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));
    f.accounts.close();

    assert.throws(
      () =>
        restoreStorage(f.config.storageDir, backup, null, (reached) => {
          if (reached === step) throw new Error('stopped');
        }),
      /stopped/,
    );

    assert.throws(() => openDatabase(f.config.storageDir), /restore did not finish/);
    restoreStorage(f.config.storageDir, backup, null);
    const restored = reopen(t, f);
    restored.jobs.start();
    await restored.jobs.drain();
    assert.equal(sends.mock.callCount(), 0);
    assert.equal(restored.uploads.status(f.rider.player_id)[0]?.state, 'pending');
  });
