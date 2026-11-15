import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { GhostSchema, PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { FitQueueFullError, FitRepository } from '#src/repositories/fit.repository';
import { AssetFiles } from '#src/repositories/files.repository';
import { FitService } from '#src/services/fit.service';
import { worldTime } from '#src/world/state';
import { Simulation } from '#src/world/simulation';
import { runtimeFixture } from '#tests/support/runtime';
import { create, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

async function ghostRider(t: Parameters<typeof runtimeFixture>[0]) {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Ghost Rider', '', true);
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  const simulation = new Simulation(f, () => 100);
  t.after(() => simulation.close());
  await simulation.ready;
  const id = BigInt(rider.player_id);

  const state = create(PlayerStateSchema, {
    id,
    f19: (6 << 16) | 4,
    aux3: 1 << 8,
    roadTime: 1000,
    worldTime: worldTime(),
  });

  new AssetFiles().writeDurable(
    resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/old.bin'),
    toBinary(GhostSchema, create(GhostSchema, { playerId: rider.player_id, states: [state] })),
  );
  f.world.login(id, new Uint8Array(16));
  f.world.receive(id, state);
  f.world.receive(id, { ...state, roadTime: 2000, worldTime: state.worldTime + 1n });

  return { f, simulation, id, state };
}

await test('a ghost load does not attach to a session that started during the read', async (t) => {
  const { f, simulation, id, state } = await ghostRider(t);
  assert.equal(simulation.ghosts.get(id)?.loading, 'loading');
  f.world.login(id, new Uint8Array(16));
  await simulation.idle();
  assert.equal(simulation.ghosts.get(id)?.loading, 'waiting');
  assert.equal(simulation.ghosts.get(id)?.playbacks.length, 0);
  assert.equal(f.profiles.synthetic.has(id + 10_000_000n), false);

  // The next packet of the new session loads the recordings again.
  f.world.receive(id, { ...state, roadTime: 3000, worldTime: state.worldTime + 2n });
  await simulation.idle();
  assert.equal(simulation.ghosts.get(id)?.loading, 'loaded');
  assert.equal(simulation.ghosts.get(id)?.playbacks.length, 1);
});

await test('a ghost load does not attach after logout', async (t) => {
  const { f, simulation, id } = await ghostRider(t);
  f.world.logout(id);
  await simulation.idle();
  assert.equal(simulation.ghosts.has(id), false);
  assert.equal(f.profiles.synthetic.has(id + 10_000_000n), false);
});

function encode(firstName: string) {
  return toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 1n, firstName }));
}

await test('the profile cache follows each committed save and each invalidation', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Old Name', '', true);
  const documents = f.accounts.repositories.riderDocuments;

  documents.put(rider.player_id, 'profile.bin', encode('Old'));
  assert.equal(f.profiles.get(rider.player_id).firstName, 'Old');

  const saved = f.profiles.get(rider.player_id);
  saved.firstName = 'New';
  f.profiles.save(rider.player_id, saved);
  const loaded = await f.profiles.load(rider.player_id);
  assert.equal(loaded.firstName, 'New');
  assert.equal(f.accounts.get(rider.player_id)?.first_name, 'New');

  // A change outside save() is visible only after invalidation.
  documents.put(rider.player_id, 'profile.bin', encode('Imported'));
  assert.equal(f.profiles.get(rider.player_id).firstName, 'New');
  f.profiles.invalidate(rider.player_id);
  assert.equal(f.profiles.get(rider.player_id).firstName, 'Imported');

  // A save inside a transaction that rolls back leaves no cached value behind.
  f.accounts.db.exec('BEGIN');
  const rolled = f.profiles.get(rider.player_id);
  rolled.firstName = 'Rolled back';
  f.profiles.save(rider.player_id, rolled);
  f.accounts.db.exec('ROLLBACK');
  assert.equal(f.profiles.get(rider.player_id).firstName, 'Imported');
});

await test('settings reads come from the cache and follow each committed change', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Cached Rider', '', true);
  assert.deepEqual(f.settings.read(rider.player_id), {});
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  assert.deepEqual(f.settings.read(rider.player_id), { 'ghosts.enabled': true });

  const copy = f.settings.read(rider.player_id);
  copy['ghosts.enabled'] = false;
  assert.deepEqual(f.settings.read(rider.player_id), { 'ghosts.enabled': true });

  assert.throws(() => f.settings.import('conflict', [{ playerId: rider.player_id, overrides: {} }]));
  assert.deepEqual(f.settings.read(rider.player_id), { 'ghosts.enabled': true });

  f.settings.saveWorld('blob:1', { riders: 3 });
  const world = f.settings.world('blob:1');
  world.riders = 9;
  assert.deepEqual(f.settings.world('blob:1'), { riders: 3 });
  f.settings.resetWorld('blob:1');
  assert.deepEqual(f.settings.world('blob:1'), {});
});

await test('the FIT worker matches synchronous processing and bounds its queue', async () => {
  const fit = readFileSync(new URL('../fixtures/ride.fit', import.meta.url));
  assert.deepEqual(await FitService.chart(fit), FitService.activityChart(fit));
  const curve = await FitService.powerBests(fit);
  assert.deepEqual(curve.bests, [{ time: 5, power: 200 }]);
  await assert.rejects(FitService.chart(new Uint8Array([1, 2, 3])), /Invalid FIT/);

  const pool = new FitRepository(1);
  const first = pool.chart(fit);
  await assert.rejects(pool.chart(fit), FitQueueFullError);
  assert.equal(fit.length, 265, 'the caller keeps the canonical payload');
  await first;
  await pool.close();
});
