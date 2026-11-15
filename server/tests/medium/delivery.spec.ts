import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { ZwiftRepository } from '#src/repositories/zwift.repository';
import { binary, mediumFixture } from '#tests/medium/support';
import { create, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));

async function completed(f: Awaited<ReturnType<typeof mediumFixture>>) {
  const data = {
    playerId: BigInt(f.rider.player_id),
    courseId: 6n,
    name: 'Delivered',
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

  return id;
}

const reset = () =>
  Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }));

for (const [outcome, response, state] of [
  ['confirmed success', () => Promise.resolve(new Response(null, { status: 200 })), 'sent'],
  ['a rejection', () => Promise.resolve(new Response(null, { status: 400 })), 'failed'],
  ['a server error after the request', () => Promise.resolve(new Response(null, { status: 503 })), 'ambiguous'],
  ['remote acceptance with a lost response', reset, 'ambiguous'],
  ['a connection reset', reset, 'ambiguous'],
  ['a timeout', () => Promise.reject(new DOMException('The operation timed out', 'TimeoutError')), 'ambiguous'],
] as const)
  await test(`a delivery with ${outcome} becomes ${state} and never sends twice on its own`, async (t) => {
    const f = await mediumFixture(t);
    f.services.documents.put(f.rider.player_id, 'runalyze_token.txt', 'token');
    await completed(f);
    const sends = t.mock.method(globalThis, 'fetch', response);
    await f.services.jobs.drain();
    assert.equal(f.services.uploads.status(f.rider.player_id)[0]?.state, state);
    await f.services.jobs.drain();
    assert.equal(sends.mock.callCount(), 1);
  });

await test('a stop during each delivery state never sends a delivery twice', async (t) => {
  const f = await mediumFixture(t);
  f.services.documents.put(f.rider.player_id, 'runalyze_token.txt', 'token');
  const id = await completed(f);
  const sends = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response(null, { status: 200 })));

  // Stopped while sending: the restart records an unknown result and does not send.
  f.accounts.db.prepare("UPDATE activity_upload SET state='sending', attempt='lost' WHERE activity_id=?").run(id);
  f.services.uploads.start();
  await f.services.jobs.drain();
  assert.equal(f.services.uploads.status(f.rider.player_id)[0]?.state, 'ambiguous');
  assert.equal(sends.mock.callCount(), 0);

  // Stopped while pending: the queued job sends once after the restart.
  f.accounts.db.prepare("UPDATE activity_upload SET state='pending' WHERE activity_id=?").run(id);
  f.accounts.repositories.jobsRepository.enqueue('delivery', { activityId: id, provider: 'runalyze' });
  f.services.uploads.start();
  await f.services.jobs.drain();
  assert.equal(sends.mock.callCount(), 1);

  // Stopped after a result: neither sent nor failed deliveries run again.
  for (const final of ['sent', 'failed']) {
    f.accounts.db.prepare('UPDATE activity_upload SET state=? WHERE activity_id=?').run(final, id);
    f.accounts.repositories.jobsRepository.enqueue('delivery', { activityId: id, provider: 'runalyze' });
    f.services.uploads.start();
    await f.services.jobs.drain();
  }

  assert.equal(sends.mock.callCount(), 1);
});

await test('a partial Zwift delivery keeps its remote activity and a retry uploads to it', async (t) => {
  const f = await mediumFixture(t);
  f.services.connections.save(f.rider.player_id, 'zwift', ['user', 'pass']);
  f.settings.save(f.rider.player_id, { 'uploads.zwift.enabled': true });
  t.mock.method(ZwiftRepository.prototype, 'officialLogin', () => Promise.resolve('token'));
  await completed(f);
  const calls: string[] = [];
  let uploads = 0;

  t.mock.method(globalThis, 'fetch', (input: string | URL, init?: RequestInit) => {
    const call = `${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`;
    calls.push(call);

    if (call.endsWith('/profiles/me'))
      return Promise.resolve(new Response(toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 555n }))));

    if (call.startsWith('POST')) return Promise.resolve(Response.json({ id: 77 }));

    return Promise.resolve(new Response(null, { status: ++uploads === 1 ? 503 : 200 }));
  });

  await f.services.jobs.drain();
  const record = f.accounts.db.prepare('SELECT state, remote_id, step FROM activity_upload').get();
  assert.deepEqual({ ...record }, { state: 'ambiguous', remote_id: '77', step: 'created' });

  await f.services.uploads.retry(f.rider.player_id, true);
  assert.equal(f.services.uploads.status(f.rider.player_id)[0]?.state, 'sent');
  assert.deepEqual(
    calls.filter((call) => !call.endsWith('/profiles/me')),
    ['POST /api/profiles/555/activities', 'PUT /api/profiles/555/activities/77', 'PUT /api/profiles/555/activities/77'],
  );
});

await test('deleting every FIT export breaks neither details, charts nor delivery; a job creates them again', async (t) => {
  const f = await mediumFixture(t);
  f.services.documents.put(f.rider.player_id, 'runalyze_token.txt', 'token');
  const delivered: Uint8Array[] = [];
  t.mock.method(globalThis, 'fetch', async (_input: string | URL, init?: RequestInit) => {
    const file = z.instanceof(FormData).parse(init?.body).get('file');
    delivered.push(new Uint8Array(await z.instanceof(Blob).parse(file).arrayBuffer()));

    return new Response(null, { status: 200 });
  });
  const id = await completed(f);
  const folder = resolve(f.profiles.folder(f.rider.player_id), 'fit');
  await f.services.jobs.drain();
  assert.deepEqual(readdirSync(folder), [`${id} - ride.fit`]);
  rmSync(folder, { recursive: true });
  rmSync(resolve(f.config.storageDir, 'activities'), { recursive: true });

  f.accounts.db.exec("UPDATE activity_upload SET state='failed'");
  await f.services.uploads.retry(f.rider.player_id);
  assert.equal(delivered.length, 2);
  assert.deepEqual(Buffer.from(delivered[1] ?? []), fit);

  const details = await f.request(`/api/activities/${id}`);
  assert.equal(details.status, 200);
  await f.services.jobs.drain();

  const detail = await f.request(`/api/activities/${id}`);
  const ready = z.object({ fitnessData: z.object({ fullDataUrl: z.string() }) }).parse(await detail.json());
  const chart = await f.request(new URL(ready.fitnessData.fullDataUrl).pathname);
  assert.equal(chart.status, 200);

  f.accounts.repositories.jobsRepository.enqueue('fit_export', { activityId: id });
  await f.services.jobs.drain();
  assert.deepEqual(readFileSync(resolve(folder, `${id} - ride.fit`)), fit);
});
