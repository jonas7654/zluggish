import { openDatabase } from '#src/db/open';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema, StreaksSchema } from '#src/protocol/generated/profile_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { migrateStorage, MigrationStep, StorageFile } from '#src/migrations/storage';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import { RiderDocuments } from '#src/repositories/rider-document.repository';
import { SettingsStore } from '#src/repositories/settings.repository';
import { StreakService } from '#src/services/streak.service';
import { legacyDatabase } from '#tests/support/legacy';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { test } from 'node:test';
import { z } from 'zod';

const crypto = new CryptoRepository();
const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));
const key = crypto.randomBytes(32);

const activity = (id: number, name: string, extra: { fit?: Uint8Array } = {}) =>
  create(ActivitySchema, {
    id: BigInt(id),
    playerId: 1n,
    courseId: 6n,
    name,
    startDate: '2026-11-02T10:00:00Z',
    distanceInMeters: 3000,
    sport: 0,
    fitFilename: 'ride.fit',
    ...extra,
  });

const previous = create(StreaksSchema, { curStreak: 1, curStreakDistance: 1000, weekEnd: 1n });

function write(storage: string, path: string, data: string | Uint8Array) {
  mkdirSync(resolve(storage, path, '..'), { recursive: true });
  writeFileSync(resolve(storage, path), data);
}

/** A version 5 storage directory with every legacy store the merge must import. */
function legacy(t: TestContext) {
  const storage = mkdtempSync(resolve(tmpdir(), 'zluggish-legacy-'));
  t.after(() => rmSync(storage, { recursive: true, force: true }));
  const db = legacyDatabase(storage);
  db.exec(`INSERT INTO user (player_id, username, first_name, last_name, pass_hash, is_admin)
    VALUES (1, 'one', 'One', 'Rider', NULL, 1), (2, 'two', 'Two', 'Rider', NULL, 0)`);
  // A completed activity whose FIT lives in its journal and its export file.
  const done = activity(10, 'Done', { fit });
  db.prepare('INSERT INTO activity (id, player_id, name) VALUES (10, 1, ?)').run('Done');
  db.prepare('INSERT INTO activity_completion VALUES (10, 1, ?, NULL, 1)').run(toBinary(ActivitySchema, done));
  // A legacy activity from before the journal: only its export file has the FIT bytes.
  db.prepare("INSERT INTO activity (id, player_id, name, end_date) VALUES (11, 1, 'Old', '2026-01-01')").run();
  db.exec(`INSERT INTO activity_upload VALUES (10, 'runalyze', 'sending'), (10, 'intervals', 'pending'),
    (10, 'garmin', 'failed')`);
  db.close();

  const settings = SettingsStore.legacy(storage);
  settings.save(1, { 'ghosts.enabled': true });
  settings.saveWorld('blob:1', { riders: 4 });
  settings.close();

  writeFileSync(resolve(storage, StorageFile.CredentialsKey), key);
  write(storage, '1/profile.bin', toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { firstName: 'One' })));
  write(storage, '1/streaks.bin', toBinary(StreaksSchema, previous));
  write(storage, '1/strava_token.txt', '1\nsecret\naccess\nrefresh\n9\n');
  write(storage, '1/runalyze_token.txt', 'runalyze');
  write(storage, '1/zwift_credentials.bin', crypto.encryptCredentials(key, ['user', 'pass']));
  write(storage, '1/encryption_key.bin', crypto.randomBytes(16));
  write(storage, '1/bookmarks/6/0/Home.bin', toBinary(PlayerStateSchema, create(PlayerStateSchema, { x: 5 })));
  write(storage, '1/fit/10 - ride.fit', fit);
  write(storage, '1/fit/11 - old.fit', fit);
  write(storage, '1/medias/1.mp4', 'video');
  write(storage, '99/profile.bin', 'orphan');

  return storage;
}

function journal(storage: string, streak: Uint8Array | null) {
  const db = openLegacy(storage);
  const pending = activity(20, 'Journal name', { fit });
  db.prepare("INSERT INTO activity (id, player_id, name) VALUES (20, 1, 'Draft name')").run();
  db.prepare('INSERT INTO activity_completion VALUES (20, 1, ?, ?, 0)').run(toBinary(ActivitySchema, pending), streak);
  db.close();

  return pending;
}

function openLegacy(storage: string) {
  return new DatabaseSync(resolve(storage, 'zluggish.db'));
}

const blob = (value: SQLOutputValue | undefined) => Buffer.from(z.instanceof(Uint8Array).parse(value));

await test('the storage merge imports every legacy store once and keeps the legacy files', (t) => {
  const storage = legacy(t);
  const db = openDatabase(storage);
  t.after(() => db.close());
  const documents = new RiderDocuments(db, storage);

  assert.equal(db.prepare('SELECT version FROM version').get()?.version, 6);
  assert.equal(db.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  assert.deepEqual(new SettingsStore(db).read(1), { 'ghosts.enabled': true });
  assert.deepEqual(new SettingsStore(db).world('blob:1'), { riders: 4 });
  assert.equal(fromBinary(PlayerProfileSchema, documents.get(1, 'profile.bin') ?? new Uint8Array()).firstName, 'One');
  assert.equal(documents.text(1, 'strava_token.txt'), '1\nsecret\naccess\nrefresh\n9\n');
  assert.equal(
    blob(db.prepare("SELECT data FROM rider_document WHERE name='strava_token.txt'").get()?.data).includes('access'),
    false,
    'imported secrets are encrypted',
  );
  assert.deepEqual(crypto.decryptCredentials(key, documents.get(1, 'zwift_credentials.bin') ?? new Uint8Array()), [
    'user',
    'pass',
  ]);
  assert.equal(db.prepare('SELECT name FROM bookmark WHERE player_id=1').get()?.name, 'Home');
  assert.equal(db.prepare('SELECT count(*) AS n FROM rider_document WHERE player_id=99').get()?.n, 0);

  // One canonical FIT copy: the column. Journal payloads hold none.
  assert.deepEqual(blob(db.prepare('SELECT fit FROM activity WHERE id=10').get()?.fit), fit);
  assert.deepEqual(blob(db.prepare('SELECT fit FROM activity WHERE id=11').get()?.fit), fit);

  const payload = fromBinary(
    ActivitySchema,
    blob(db.prepare('SELECT payload FROM activity_completion').get()?.payload),
  );

  assert.equal(payload.fit.length, 0);
  assert.equal(payload.name, 'Done');

  assert.deepEqual(
    db
      .prepare('SELECT provider, state FROM activity_upload ORDER BY provider')
      .all()
      .map((row) => [row.provider, row.state]),
    [
      ['garmin', 'failed'],
      ['intervals', 'pending'],
      ['runalyze', 'ambiguous'],
    ],
  );
  assert.deepEqual(
    db
      .prepare("SELECT payload FROM job WHERE type='delivery'")
      .all()
      .map((row) => row.payload),
    ['{"activityId":10,"provider":"intervals"}'],
  );

  const manifest = z
    .object({ state: z.string(), backup: z.string(), report: z.object({ orphanFolders: z.array(z.string()) }) })
    .parse(JSON.parse(readFileSync(resolve(storage, StorageFile.Manifest), 'utf8')));

  assert.equal(manifest.state, 'published');
  assert.deepEqual(manifest.report.orphanFolders, ['99']);

  const backup = z
    .object({ checksums: z.record(z.string(), z.string()) })
    .parse(JSON.parse(readFileSync(resolve(manifest.backup, 'backup-manifest.json'), 'utf8')));

  for (const name of ['zluggish.db', 'settings.db', '1/streaks.bin', '1/medias/1.mp4', 'credentials-key.bin'])
    assert.ok(backup.checksums[name], `backup holds ${name}`);

  for (const name of ['settings.db', '1/profile.bin', '1/strava_token.txt', '1/bookmarks/6/0/Home.bin'])
    assert.ok(existsSync(resolve(storage, name)), `legacy ${name} is kept`);
});

await test('a repeated start does not migrate again', (t) => {
  const storage = legacy(t);
  openDatabase(storage).close();
  const before = readdirSync(resolve(storage, 'backups'));
  const db = openDatabase(storage);
  t.after(() => db.close());
  assert.deepEqual(readdirSync(resolve(storage, 'backups')), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM rider_document').get()?.n, 6);
});

const snapshot = toBinary(StreaksSchema, StreakService.advancedStreak(previous, activity(20, 'Journal name', { fit })));

for (const [point, prepare] of [
  ['before the streak file was written', () => {}],
  ['after the streak file was written', (storage: string) => write(storage, '1/streaks.bin', snapshot)],
  [
    'with no streak file and the profile fallback',
    (storage: string) => {
      rmSync(resolve(storage, '1/streaks.bin'));
    },
  ],
] as const)
  await test(`a stopped completion applies progression once: ${point}`, (t) => {
    const storage = legacy(t);

    const expected =
      point === 'with no streak file and the profile fallback'
        ? toBinary(StreaksSchema, StreakService.advancedStreak(StreakService.fromProfile(null), activity(20, 'x')))
        : snapshot;

    journal(storage, expected);
    prepare(storage);
    const db = openDatabase(storage);
    t.after(() => db.close());
    const documents = new RiderDocuments(db, storage);
    assert.deepEqual(Buffer.from(documents.get(1, 'streaks.bin') ?? []), Buffer.from(expected));
    assert.equal(db.prepare('SELECT done FROM activity_completion WHERE activity_id=20').get()?.done, 1);
    assert.equal(db.prepare('SELECT name FROM activity WHERE id=20').get()?.name, 'Journal name');
    assert.deepEqual(
      db
        .prepare('SELECT type FROM job WHERE payload=\'{"activityId":20}\' ORDER BY type')
        .all()
        .map((row) => row.type),
      ['completion_deliveries', 'fit_export', 'power_curve'],
    );
  });

await test('a stopped completion whose journal disagrees with the rider files stops the migration', (t) => {
  const storage = legacy(t);
  journal(storage, snapshot);
  write(storage, '1/streaks.bin', toBinary(StreaksSchema, create(StreaksSchema, { curStreak: 40, maxStreak: 40 })));
  assert.throws(() => openDatabase(storage), /disagrees/);
  // The source stays unchanged and usable by the previous release.
  const db = openLegacy(storage);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT version FROM version').get()?.version, 5);
});

await test('required FIT copies that differ stop the migration', (t) => {
  const storage = legacy(t);
  const db = openLegacy(storage);
  db.prepare('UPDATE activity SET fit=? WHERE id=10').run(new Uint8Array([1, 2, 3]));
  db.close();
  assert.throws(() => openDatabase(storage), /two different FIT payloads/);
});

await test('committed data in a legacy WAL file is migrated', (t) => {
  const storage = legacy(t);
  const path = resolve(storage, 'zluggish.db');
  const db = openLegacy(storage);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; UPDATE user SET first_name='Walled' WHERE player_id=2",
  );
  copyFileSync(path, `${path}.copy`);
  copyFileSync(`${path}-wal`, `${path}-wal.copy`);
  db.close();
  copyFileSync(`${path}.copy`, path);
  copyFileSync(`${path}-wal.copy`, `${path}-wal`);
  rmSync(`${path}.copy`);
  rmSync(`${path}-wal.copy`);
  const migrated = openDatabase(storage);
  t.after(() => migrated.close());
  assert.equal(migrated.prepare('SELECT first_name FROM user WHERE player_id=2').get()?.first_name, 'Walled');
});

for (const step of Object.values(MigrationStep))
  await test(`a stop after the ${step} step restarts into one complete database`, (t) => {
    const storage = legacy(t);

    assert.throws(
      () =>
        migrateStorage(storage, (reached) => {
          if (reached === step) throw new Error('stopped');
        }),
      /stopped/,
    );

    const db = openDatabase(storage);
    t.after(() => db.close());
    assert.equal(db.prepare('SELECT version FROM version').get()?.version, 6);
    assert.equal(db.prepare('SELECT count(*) AS n FROM rider_document').get()?.n, 6);
    assert.equal(db.prepare("SELECT count(*) AS n FROM job WHERE type='delivery'").get()?.n, 1);
    assert.equal(existsSync(resolve(storage, StorageFile.Temporary)), false);
    assert.ok(existsSync(resolve(storage, '1/profile.bin')));
  });

await test('an interrupted publication with an unknown database stops with a recovery instruction', (t) => {
  const storage = legacy(t);
  assert.throws(
    () =>
      migrateStorage(storage, (reached) => {
        if (reached === 'publishing') throw new Error('stopped');
      }),
    /stopped/,
  );
  writeFileSync(resolve(storage, 'zluggish.db'), 'damaged');
  assert.throws(() => openDatabase(storage), /matches neither the source nor the migrated copy.*Restore/);
});
