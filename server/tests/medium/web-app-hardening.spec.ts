import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { create } from '@bufbuild/protobuf';
import { validateConfig } from '#src/config/index';
import { packageRoot } from '#src/config/load';
import { createWebApp } from '#src/http/web-app';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import { Simulation } from '#src/world/simulation';
import { worldTime } from '#src/world/state';
import { runtimeFixture } from '#tests/support/runtime';
import { responseStatus } from '#tests/support/html';

const flush = () => Promise.resolve();

await test('requests without cookies allocate no web sessions, and anonymous writes need the CSRF cookie', async (t) => {
  const f = runtimeFixture(t);
  const web = createWebApp(f);
  const sessions = f.services.management.sessions;

  for (let i = 0; i < 200; i++) assert.equal(await responseStatus(web.request('http://local:8080/api/setup')), 200);
  assert.equal(sessions.sessions.size, 0);

  const state = await web.request('http://local:8080/api/setup');
  const { csrf } = await state.json();
  const cookie = state.headers.getSetCookie()[0]!.split(';', 1)[0]!;

  const setup = (headers: Record<string, string>) =>
    web.request('http://local:8080/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://local:8080', ...headers },
      body: JSON.stringify({
        mode: 'new',
        key: f.services.management.issueSetupKey(),
        username: 'owner',
        first_name: 'First',
        last_name: 'Rider',
        password: 'test-password',
      }),
    });

  // The token alone, or a cookie for another token, is refused.
  assert.equal(await responseStatus(setup({ 'X-CSRF-Token': csrf })), 403);
  assert.equal(await responseStatus(setup({ Cookie: cookie, 'X-CSRF-Token': 'x'.repeat(43) })), 403);
  // A page on another host is refused even with a valid token.
  assert.equal(
    await responseStatus(setup({ Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'https://evil.example' })),
    403,
  );
  assert.equal(sessions.sessions.size, 0);
  // A TLS-terminating proxy forwards the https page's requests over http.
  const signedIn = await setup({ Cookie: cookie, 'X-CSRF-Token': csrf, Origin: 'https://local:8080' });
  assert.equal(signedIn.status, 200);
  assert.equal(sessions.sessions.size, 1);
});

await test('a rider password change in the game app is audited as that rider, not as offline recovery', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Game Rider', 'test-password', 'game');
  await f.accounts.changePassword(rider.player_id, 'next-password', false, () => true, {
    kind: 'rider',
    playerId: rider.player_id,
  });
  await f.accounts.changePassword(rider.player_id, 'offline-password');
  const history = f.services.management.store.history(rider.player_id);
  assert.deepEqual(
    history.map((row) => [row.action, row.actor_kind, row.actor_player_id]),
    [
      ['recover-password', 'offline operator', null],
      ['change-own-password', 'rider', rider.player_id],
    ],
  );
});

await test('login names match after Unicode normalization, and similar imported names stay ambiguous', async (t) => {
  const f = runtimeFixture(t);
  const imported = await f.accounts.create('Åsa Rider', 'test-password', 'ÅSA');
  assert.equal(f.accounts.byUsername('ÅSA')?.player_id, imported.player_id);
  assert.equal(f.accounts.byUsername('åsa')?.player_id, imported.player_id);
  assert.equal(f.accounts.loginNameTaken('åsa'), true);
  assert.equal(f.accounts.loginNameTaken('åsa', imported.player_id), false);

  const upper = await f.accounts.create('Anna Upper', 'test-password', 'ANNA');
  const mixed = await f.accounts.create('Anna Mixed', 'test-password', 'Anna');
  assert.equal(f.accounts.byUsername('ANNA')?.player_id, upper.player_id);
  assert.equal(f.accounts.byUsername('Anna')?.player_id, mixed.player_id);
  assert.equal(f.accounts.byUsername('anna'), null);
  assert.equal(f.accounts.loginNameTaken('anna'), true);

  const service = f.services.management;

  const owner = await service.setup({
    mode: 'new',
    key: service.issueSetupKey()!,
    username: 'owner',
    first_name: 'First',
    last_name: 'Rider',
    password: 'test-password',
  });

  const opened = service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000);
  await assert.rejects(
    service.create(
      opened.id,
      { username: 'anna', first_name: 'Third', last_name: 'Anna', password: 'test-password' },
      crypto.randomUUID(),
    ),
    /Login name already exists/,
  );
});

await test('disabled and passwordless riders cost the same password work as other riders', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Timed Rider', 'test-password', 'timed');
  f.accounts.db.exec(`UPDATE user SET enabled=0 WHERE player_id=${rider.player_id}`);
  const hashing = t.mock.method(f.accounts.repositories.cryptoRepository, 'hashPassword');
  assert.equal(await f.accounts.verify(f.accounts.get(rider.player_id)!, 'test-password'), false);
  assert.equal(hashing.mock.callCount(), 1);
});

await test('bot commands run only from the management area, once per operation', async (t) => {
  const f = runtimeFixture(t);
  const service = f.services.management;

  const owner = await service.setup({
    mode: 'new',
    key: service.issueSetupKey()!,
    username: 'owner',
    first_name: 'First',
    last_name: 'Rider',
    password: 'test-password',
  });

  const simulation = new Simulation(f, () => 100);
  t.after(() => simulation.close());
  await simulation.ready;
  const id = BigInt(owner.player_id);
  assert.equal(simulation.command(id, 'group'), 'Use the web app management area for server commands.');
  assert.equal(simulation.command(id, 'peloton 5'), 'Use the web app management area for server commands.');

  const opened = service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000);
  const sent: string[] = [];

  const dispatch = {
    reload: flush,
    bots: (rider: number, command: string) => {
      sent.push(`${rider}:${command}`);

      return simulation.command(BigInt(rider), command, true);
    },
  };

  const operation = crypto.randomUUID();
  const input = { operation, rider: owner.player_id, command: 'group' as const };
  await assert.rejects(service.serverOperation(opened.id, 'bots', input, flush, dispatch), /riding now/);
  f.world.online.set(id, create(PlayerStateSchema, { id, worldTime: worldTime() }));

  const second = { ...input, operation: crypto.randomUUID() };

  const outcomes = await Promise.all([
    service.serverOperation(opened.id, 'bots', second, flush, dispatch),
    service.serverOperation(opened.id, 'bots', second, flush, dispatch),
  ]);

  assert.deepEqual(sent, [`${owner.player_id}:group`]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['complete', 'unknown'],
  );
  assert.deepEqual(await service.serverOperation(opened.id, 'bots', second, flush, dispatch), outcomes[0]);
  await assert.rejects(
    service.serverOperation(opened.id, 'bots', { ...second, command: 'disperse' }, flush, dispatch),
    /Operation changed/,
  );
});

await test('a lapsed confirmation records a server operation as not run, and a retry never dispatches', async (t) => {
  const f = runtimeFixture(t);
  const service = f.services.management;

  const owner = await service.setup({
    mode: 'new',
    key: service.issueSetupKey()!,
    username: 'owner',
    first_name: 'First',
    last_name: 'Rider',
    password: 'test-password',
  });

  const opened = service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000);
  let reloads = 0;

  const dispatch = {
    reload: () => {
      reloads++;

      return Promise.resolve();
    },
    bots: () => '',
  };

  const input = { operation: crypto.randomUUID() };

  const lapse = () => {
    opened.session.confirmedUntil = 0;

    return Promise.resolve();
  };

  await assert.rejects(service.serverOperation(opened.id, 'reload-bots', input, lapse, dispatch), /confirmation/);
  opened.session.confirmedUntil = Date.now() + 900_000;
  const retry = await service.serverOperation(opened.id, 'reload-bots', input, flush, dispatch);
  assert.equal(retry.ok, false);
  assert.match(retry.message!, /did not run/);
  assert.equal(reloads, 0);
});

await test('ride completion rejects malformed ride identities with 400', async (t) => {
  const f = runtimeFixture(t);

  for (const path of ['/api/profiles/abc/activities/1', '/api/profiles/1/activities/nope'])
    assert.equal(
      await responseStatus(
        f.app.request(path, { method: 'PUT', headers: { Authorization: 'Bearer stale' }, body: 'x' }),
      ),
      400,
    );
});

await test('the game app bundle contains no web app code', () => {
  const game = resolve(packageRoot(), '../web/dist/game');
  const assets = resolve(game, 'client/assets');

  const bundles = [
    ...readdirSync(assets)
      .filter((name) => name.endsWith('.js'))
      .map((name) => resolve(assets, name)),
    resolve(game, 'server/entry.js'),
  ];

  for (const file of bundles) {
    const text = readFileSync(file, 'utf8');

    for (const marker of ['/api/manage', '/api/session', '/api/me', 'Confirm your password to manage'])
      assert.equal(text.includes(marker), false, `${file} contains ${marker}`);
  }
});

await test('a public URL pins the accepted origin and marks https cookies Secure', async (t) => {
  const f = runtimeFixture(t);

  const config = validateConfig({
    storageDir: f.config.storageDir,
    network: { web: { publicUrl: 'https://zluggish.example.com' } },
  });

  const web = createWebApp({ ...f, config });

  const state = await web.request('http://local:8080/api/setup');
  const { csrf } = await state.json();
  const cookie = state.headers.getSetCookie()[0]!;
  assert.match(cookie, /; Secure/);

  const check = (origin: string) =>
    web.request('http://local:8080/api/setup/key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        Cookie: cookie.split(';', 1)[0]!,
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({ key: f.services.management.issueSetupKey() }),
    });

  // The request host no longer decides: only the configured address passes.
  assert.equal(await responseStatus(check('https://local:8080')), 403);
  assert.equal(await responseStatus(check('https://zluggish.example.com:8443')), 403);
  assert.equal(await responseStatus(check('https://zluggish.example.com')), 200);
});
