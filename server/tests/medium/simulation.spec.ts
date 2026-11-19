import { Effect } from 'effect';
import { RideRecoveryService } from '#src/services/ride-recovery.service';
import { validateConfig } from '#src/config/index';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';
import { GhostSchema, PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { AssetFiles } from '#src/repositories/files.repository';
import { worldTime } from '#src/world/state';
import { Simulation } from '#src/world/simulation';
import { runtimeFixture } from '#tests/support/runtime';
import { create, toBinary } from '@bufbuild/protobuf';
import assert from 'node:assert/strict';
import fs, { rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

await test('simulation playback stops, resumes and removes deleted pacers on reload', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.UTC(2026, 10, 12) });
  const f = runtimeFixture(t);
  const folder = resolve(f.accounts.storage, 'robopacers/demo');
  new AssetFiles().writeDurable(
    resolve(folder, 'profile.bin'),
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 100n, firstName: 'Pacer' })),
  );
  new AssetFiles().writeDurable(
    resolve(folder, 'route.bin'),
    toBinary(
      GhostSchema,
      create(GhostSchema, {
        playerId: 100,
        states: [0, 1000, 2000].map((x) => create(PlayerStateSchema, { id: 100n, x, roadTime: x + 1 })),
      }),
    ),
  );
  const simulation = new Simulation(f, () => Date.now() / 1000);
  t.after(() => simulation.close());
  await simulation.ready;
  const first = f.world.synthetic.get(100n)?.x;
  assert.ok(first !== undefined);
  simulation.start();
  simulation.start();
  t.mock.timers.tick(1000);
  const moved = f.world.synthetic.get(100n)?.x;
  assert.notEqual(moved, first);
  await simulation.close();
  t.mock.timers.tick(1000);
  assert.equal(f.world.synthetic.get(100n)?.x, moved);
  simulation.start();
  t.mock.timers.tick(1000);
  assert.notEqual(f.world.synthetic.get(100n)?.x, moved);
  rmSync(folder, { recursive: true });
  await simulation.reload();
  assert.equal(f.world.synthetic.has(100n), false);
  assert.equal(f.profiles.synthetic.has(100n), false);
});

await test('ghost regroup before lazy loading preserves independent playback and loading states', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Ghost Rider', 'test-password');
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  let now = 100;
  const simulation = new Simulation(f, () => now);
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

  f.world.receive(id, state);
  simulation.regroup(id);
  assert.equal(simulation.ghosts.get(id)?.loading, 'waiting');
  assert.equal(simulation.ghosts.get(id)?.playback, 'playing');
  const file = resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/test.bin');
  new AssetFiles().writeDurable(
    file,
    toBinary(GhostSchema, create(GhostSchema, { playerId: rider.player_id, states: [state] })),
  );
  f.world.receive(id, { ...state, roadTime: 2000, worldTime: state.worldTime + 1n });
  assert.equal(simulation.ghosts.get(id)?.loading, 'loading');
  await simulation.idle();
  assert.equal(simulation.ghosts.get(id)?.loading, 'loaded');
  now += 3;
  simulation.tick();
  const ghostId = id + 10_000_000n;
  assert.equal(f.world.personal.get(id)?.has(ghostId), true);
  now += 3;
  simulation.tick();
  assert.equal(f.world.personal.get(id)?.has(ghostId), false);
  f.world.receive(id, { ...state, roadTime: 500, worldTime: state.worldTime + 2n });
  simulation.regroup(id);
  now += 3;
  simulation.tick();
  assert.equal(f.world.personal.get(id)?.has(ghostId), true);
  f.world.logout(id);
  assert.equal(simulation.ghosts.has(id), false);
  assert.equal(f.world.personal.has(id), false);
});

await test('riding, ghost and bookmark loads, blobs, recovery and logout make no synchronous file calls', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Async Rider', 'test-password');
  f.settings.save(rider.player_id, { 'ghosts.enabled': true });
  const id = BigInt(rider.player_id);

  const state = (index: number) =>
    create(PlayerStateSchema, {
      id,
      f19: (6 << 16) | 4,
      aux3: 1 << 8,
      roadTime: 1000 + index,
      worldTime: worldTime() + BigInt(index) * 3000n,
    });

  new AssetFiles().writeDurable(
    resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/old.bin'),
    toBinary(GhostSchema, create(GhostSchema, { playerId: rider.player_id, states: [state(0), state(1)] })),
  );
  let now = 100;
  const simulation = new Simulation(f, () => now);
  t.after(() => simulation.close());
  await simulation.ready;
  f.effects.runSync(RideRecoveryService.use((service) => service.start()));
  // The fixture disposes the runtime first: the close runs on the service itself.
  const recovery = f.effects.runSync(RideRecoveryService);
  t.after(() => Effect.runPromise(recovery.close()));

  // From here on every synchronous file call throws and is recorded.
  const calls: string[] = [];

  const names = [
    'readFileSync',
    'readdirSync',
    'existsSync',
    'statSync',
    'lstatSync',
    'openSync',
    'writeFileSync',
    'appendFileSync',
    'fsyncSync',
    'renameSync',
    'mkdirSync',
    'rmSync',
    'unlinkSync',
    'linkSync',
    'copyFileSync',
  ] as const;

  const mocks = names.map((name) =>
    t.mock.method(fs, name, () => {
      calls.push(name);
      throw new Error(`${name} on the riding path`);
    }),
  );

  syncBuiltinESMExports();

  try {
    f.world.login(id, new Uint8Array(16));

    for (let index = 0; index < 6; index++) {
      now++;
      f.world.receive(id, state(index));
      simulation.tick();
    }

    assert.equal(simulation.command(id, 'blob 4'), 'Blob settings saved.');
    simulation.command(id, 'bookmark Home');
    await simulation.loadBookmarks(id);
    await f.effects.runPromise(RideRecoveryService.use((service) => service.checkpoint()));
    await simulation.idle();
    f.world.logout(id);
    await simulation.idle();
    await f.effects.runSync(RideRecoveryService).recordings.idle();
  } finally {
    for (const mock of mocks) mock.mock.restore();
    syncBuiltinESMExports();
  }

  assert.deepEqual(calls, []);
  assert.equal(simulation.ghosts.has(id), false);
  assert.equal(simulation.bookmarks.get(id)?.size, 2, 'the command bookmark and the last ride bookmark');
});

await test('synthetic riders carry an FTP: pacers 400, bots and blobs from their owner, pelotons from their power', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Owner Rider', 'test-password');
  const owner = f.profiles.get(rider.player_id);
  owner.ftp = 250;
  owner.weightInGrams = 70_000;
  f.profiles.save(rider.player_id, owner);

  const pacer = resolve(f.accounts.storage, 'robopacers/demo');
  new AssetFiles().writeDurable(
    resolve(pacer, 'profile.bin'),
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 100n, weightInGrams: 80_000 })),
  );
  new AssetFiles().writeDurable(
    resolve(pacer, 'route.bin'),
    toBinary(
      GhostSchema,
      create(GhostSchema, {
        playerId: 100,
        states: [0, 1000, 2000].map((x) => create(PlayerStateSchema, { id: 100n, x, roadTime: x + 1, power: 240 })),
      }),
    ),
  );

  const ghost = toBinary(
    GhostSchema,
    create(GhostSchema, { playerId: 1, states: [create(PlayerStateSchema, { id: 1n, roadTime: 1 })] }),
  );

  new AssetFiles().writeDurable(resolve(f.profiles.folder(rider.player_id), 'ghosts/6/1/a.bin'), ghost);
  // A folder without an account falls back to the defaults.
  new AssetFiles().writeDurable(resolve(f.accounts.storage, '999999', 'ghosts/6/1/b.bin'), ghost);

  const runtime = {
    ...f,
    config: validateConfig({
      storageDir: f.config.storageDir,
      bots: { enabled: true },
      pelotons: [{ id: 'demo', pacer: 100, bots: 3 }],
      soloBlob: { enabled: true, playerId: rider.player_id, riders: 3 },
    }),
  };

  const simulation = new Simulation(runtime, () => 100);
  t.after(() => simulation.close());
  await simulation.ready;

  assert.equal(simulation.replays.get(100n)?.profile.ftp, 400);

  const bots = simulation.replays
    .values()
    .filter((replay) => !replay.pacer)
    .map((replay) => [replay.profile.ftp, replay.profile.weightInGrams] as const)
    .toArray()
    .sort((a, b) => a[0] - b[0]);

  assert.deepEqual(bots, [
    [250, 70_000],
    [300, 80_000],
  ]);

  const peloton = simulation.pelotons.get('demo');
  assert.ok(peloton);
  assert.equal(peloton.riders.length, 3);

  for (const bot of peloton.riders) {
    assert.ok(bot.profile.ftp > 0);
    assert.equal(bot.profile.ftp, Math.trunc(bot.ftp));
  }

  const blob = simulation.blobs.get(BigInt(rider.player_id));
  assert.ok(blob);
  assert.equal(blob.riders.length, 3);

  for (const bot of blob.riders) assert.equal(bot.profile.ftp, 250);
});
