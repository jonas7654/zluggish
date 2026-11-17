import { responseStatus } from '#tests/support/html';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeFixture } from '#tests/support/runtime';
import { createWebApp } from '#src/http/web-app';

await test('setup is atomic, permanent, independent of legacy ownership, and does not leak credentials', async (t) => {
  const f = runtimeFixture(t);
  const service = f.services.management;
  const legacy = await f.accounts.create('Legacy Owner', 'legacy-password', 'legacy');
  assert.equal(legacy.role, 'rider');
  assert.equal(service.store.complete(), false);
  const key = service.issueSetupKey()!;

  const input = {
    mode: 'existing' as const,
    key: key.toLowerCase().replaceAll('-', ' '),
    username: 'legacy',
    password: 'legacy-password',
  };

  const outcomes = await Promise.allSettled([service.setup(input), service.setup(input)]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(service.store.complete(), true);
  const rider = f.accounts.get(legacy.player_id)!;
  assert.equal(rider.role, 'administrator');
  assert.equal(rider.auth_version, legacy.auth_version + 1);
  assert.equal(service.issueSetupKey(), null);
  await assert.rejects(service.setup(input));
  assert.throws(() => f.accounts.db.exec("UPDATE web_setup_state SET state='unclaimed'"));
  assert.throws(() => f.accounts.db.exec("INSERT OR REPLACE INTO web_setup_state VALUES(1,'unclaimed')"));
  assert.equal(JSON.stringify(service.store.history(rider.player_id)).includes('legacy-password'), false);
  assert.equal(JSON.stringify(service.publicRider(rider)).includes('pass_hash'), false);
});

await test('last administrator, exact confirmation expiry, revisions, retries and revocation', async (t) => {
  const f = runtimeFixture(t);
  const service = f.services.management;

  const administrator = await service.setup({
    mode: 'new',
    key: service.issueSetupKey()!,
    username: 'owner',
    first_name: 'First',
    last_name: 'Rider',
    password: 'test-password',
  });

  const opened = service.sessions.create(f.accounts.identityOf(administrator), Date.now() + 900_000);
  const input = { revision: administrator.revision, operation: crypto.randomUUID() };
  await assert.rejects(service.mutate(opened.id, administrator.player_id, 'disable', input), /at least one/);
  await assert.rejects(
    service.mutate(opened.id, administrator.player_id, 'role', { ...input, role: 'rider' }),
    /at least one/,
  );

  const created = await service.create(
    opened.id,
    { username: 'second', first_name: 'Second', last_name: 'Rider', password: 'test-password' },
    crypto.randomUUID(),
  );

  const second = f.accounts.get(created.player_id)!;
  const oldToken = f.sessions.tokens(second, f.tokens).access_token;
  const op = { revision: second.revision, operation: crypto.randomUUID() };
  const disabled = await service.mutate(opened.id, second.player_id, 'disable', op);
  assert.equal(disabled.enabled, 0);
  assert.deepEqual(await service.mutate(opened.id, second.player_id, 'disable', op), disabled);
  assert.equal(f.sessions.bearer(oldToken), null);
  await assert.rejects(
    service.mutate(opened.id, second.player_id, 'enable', { ...op, operation: crypto.randomUUID() }),
    /changed/,
  );
  await assert.rejects(service.signIn('second', 'test-password'));
  const deadline = opened.session.confirmedUntil;
  t.mock.method(Date, 'now', () => deadline - 1);
  assert.equal(service.sessions.require(opened.id, true).player_id, administrator.player_id);
  t.mock.method(Date, 'now', () => deadline);
  assert.equal(service.sessions.require(opened.id, true).player_id, administrator.player_id);
});

await test('web and game routes and credential stores are isolated; mutations need origin and CSRF', async (t) => {
  const f = runtimeFixture(t);
  const web = createWebApp(f);
  assert.equal(await responseStatus(f.app.request('/api/setup')), 404);
  assert.equal(await responseStatus(f.app.request('/assets/index.js')), 404);
  assert.equal(await responseStatus(web.request('/login/')), 404);
  assert.equal(await responseStatus(web.request('/api/unknown')), 404);
  assert.equal(await responseStatus(web.request('/assets/missing.js')), 404);
  const state = await web.request('http://local:8080/api/setup');
  const body = await state.json();
  const cookie = state.headers.getSetCookie()[0]!.split(';', 1)[0]!;

  const input = {
    mode: 'new',
    key: f.services.management.issueSetupKey(),
    username: 'owner',
    first_name: 'First',
    last_name: 'Rider',
    password: 'test-password',
  };

  assert.equal(
    await responseStatus(
      web.request('http://local:8080/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': body.csrf },
        body: JSON.stringify(input),
      }),
    ),
    403,
  );

  const setup = await web.request('http://local:8080/api/setup', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': body.csrf,
      Origin: 'http://local:8080',
    },
    body: JSON.stringify(input),
  });

  assert.equal(setup.status, 200);
  const sessionCookie = setup.headers.getSetCookie().at(-1)!.split(';', 1)[0]!;
  assert.equal(
    await responseStatus(web.request('http://local:8080/api/manage/riders', { headers: { Cookie: sessionCookie } })),
    200,
  );
  const user = f.accounts.list()[0]!;
  assert.equal(
    await responseStatus(
      web.request('/api/manage/riders', {
        headers: { Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}` },
      }),
    ),
    401,
  );
  const game = f.sessions.open();
  f.sessions.transition(game.session, { type: 'login', identity: f.accounts.identityOf(user) });
  assert.equal(
    await responseStatus(web.request('/api/me', { headers: { Cookie: `zluggish_session=${game.id}` } })),
    401,
  );

  for (const path of ['/riders/add/', '/signup/', '/api/users'])
    assert.equal(await responseStatus(f.app.request(path, { method: 'POST' })), 403);
});

await test('stale asynchronous verification cannot sign in or complete setup', async (t) => {
  const f = runtimeFixture(t);
  const user = await f.accounts.create('Existing Rider', 'test-password', 'existing');
  const service = f.services.management;
  const original = f.accounts.verify.bind(f.accounts);
  t.mock.method(f.accounts, 'verify', async (...args: Parameters<typeof original>) => {
    const result = await original(...args);
    service.store.transaction(() => service.store.update(user.player_id, { enabled: 0 }));

    return result;
  });
  await assert.rejects(service.signIn('existing', 'test-password'));
  assert.equal(service.store.complete(), false);
  await assert.rejects(
    service.setup({
      mode: 'existing' as const,
      key: service.issueSetupKey()!,
      username: 'existing',
      password: 'test-password',
    }),
  );
  assert.equal(service.store.complete(), false);
});

await test('disabled native ride only saves its captured activity and final retries do not write', async (t) => {
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
  const rider = await f.accounts.create('Connected Rider', 'test-password');
  const token = `Bearer ${f.sessions.tokens(rider, f.tokens).access_token}`;
  const { create, toBinary } = await import('@bufbuild/protobuf');
  const { ActivitySchema } = await import('#src/protocol/generated/activity_pb');
  const { PlayerStateSchema } = await import('#src/protocol/generated/udp-node-msgs_pb');
  const { worldTime } = await import('#src/world/state');
  f.world.login(BigInt(rider.player_id), Buffer.alloc(16, 1));
  f.world.online.set(
    BigInt(rider.player_id),
    create(PlayerStateSchema, { id: BigInt(rider.player_id), worldTime: worldTime() }),
  );

  const activity = create(ActivitySchema, {
    playerId: BigInt(rider.player_id),
    courseId: 6n,
    name: 'Ride',
    startDate: new Date().toISOString(),
    distanceInMeters: 100,
    date: new Date().toISOString(),
  });

  const started = await f.app.request(`/api/profiles/${rider.player_id}/activities`, {
    method: 'POST',
    headers: { Authorization: token },
    body: toBinary(ActivitySchema, activity),
  });

  assert.equal(started.status, 200);
  const startedBody = await started.json();
  activity.id = BigInt(startedBody.id);
  await service.mutate(opened.id, rider.player_id, 'disable', {
    revision: rider.revision,
    operation: crypto.randomUUID(),
  });
  assert.ok(f.services.rideCompletion.permission(rider.player_id));
  assert.equal(await responseStatus(f.app.request('/api/profiles/me', { headers: { Authorization: token } })), 401);
  assert.equal(
    await responseStatus(
      f.app.request(`/api/profiles/${rider.player_id}/activities`, {
        method: 'POST',
        headers: { Authorization: token },
        body: toBinary(ActivitySchema, activity),
      }),
    ),
    401,
  );
  const path = `/api/profiles/${rider.player_id}/activities/${activity.id}`;
  assert.equal(
    await responseStatus(
      f.app.request(path, {
        method: 'PUT',
        headers: { Authorization: token },
        body: toBinary(ActivitySchema, activity),
      }),
    ),
    200,
  );
  const wrong = create(ActivitySchema, { ...activity, id: activity.id + 1n });
  assert.equal(
    await responseStatus(
      f.app.request(path, { method: 'PUT', headers: { Authorization: token }, body: toBinary(ActivitySchema, wrong) }),
    ),
    403,
  );
  activity.distanceInMeters = 0;
  const bytes = toBinary(ActivitySchema, activity);

  const finish = await f.app.request(path + '?upload-to-strava=true', {
    method: 'PUT',
    headers: { Authorization: token },
    body: bytes,
  });

  assert.equal(finish.status, 200);
  assert.equal(f.services.rideCompletion.permission(rider.player_id), null);
  const changes = f.services.durability.changes();

  const retry = await f.app.request(path + '?upload-to-strava=true', {
    method: 'PUT',
    headers: { Authorization: token },
    body: bytes,
  });

  assert.equal(retry.status, 200);
  assert.equal(f.services.durability.changes(), changes);
  activity.name = 'different';
  assert.equal(
    await responseStatus(
      f.app.request(path + '?upload-to-strava=true', {
        method: 'PUT',
        headers: { Authorization: token },
        body: toBinary(ActivitySchema, activity),
      }),
    ),
    409,
  );
});

await test('offline administrator recovery enables and completes setup atomically; failure rolls back', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Recovered Rider', 'old');
  f.services.management.store.transaction(() => f.services.management.store.update(rider.player_id, { enabled: 0 }));
  await f.accounts.changePassword(rider.player_id, 'first');
  assert.equal(f.accounts.get(rider.player_id)!.enabled, 0);
  assert.equal(f.services.management.store.complete(), false);
  f.accounts.db.exec(
    "CREATE TRIGGER fail_recovery BEFORE INSERT ON management_audit BEGIN SELECT RAISE(ABORT,'injected'); END",
  );
  const before = f.accounts.get(rider.player_id);
  await assert.rejects(f.accounts.changePassword(rider.player_id, 'second', true), /injected/);
  assert.deepEqual(f.accounts.get(rider.player_id), before);
  assert.equal(f.services.management.store.complete(), false);
  f.accounts.db.exec('DROP TRIGGER fail_recovery');
  await f.accounts.changePassword(rider.player_id, 'third', true);
  const after = f.accounts.get(rider.player_id)!;
  assert.equal(after.enabled, 1);
  assert.equal(after.role, 'administrator');
  assert.equal(after.auth_version, before!.auth_version + 1);
  assert.equal(f.services.management.store.complete(), true);
});

await test('world settings and administrator event changes use revisions, audit and durable retries', async (t) => {
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
  const world = { operation: crypto.randomUUID(), revision: 0, id: `blob:${owner.player_id}`, values: { riders: 3 } };
  const saved = service.saveWorld(opened.id, world);
  assert.equal(saved.revision, 1);
  assert.deepEqual(service.saveWorld(opened.id, world), saved);
  assert.throws(() => service.saveWorld(opened.id, { ...world, operation: crypto.randomUUID() }), /Settings changed/);

  const input = {
    culling: false,
    description: 'Before',
    distanceInMeters: 1000,
    durationInSeconds: 0,
    eventStart: new Date(Date.now() + 3_600_000).toISOString(),
    invitedProfileIds: [],
    laps: 1,
    routeId: 1,
    rubberbanding: false,
    showResults: true,
    sport: 'CYCLING' as const,
    workoutHash: 0,
  };

  const id = f.services.events.createMeetup(owner, input);
  const event = f.services.events.read(String(id));
  const edit = { operation: crypto.randomUUID(), revision: event.updateDate, changes: { description: 'After' } };
  service.editEvent(opened.id, id, 'edit-event', edit);
  assert.equal(f.services.events.read(String(id)).description, 'After');
  assert.deepEqual(service.editEvent(opened.id, id, 'edit-event', edit), { id, action: 'edit-event' });
  const current = f.services.events.read(String(id));
  service.editEvent(opened.id, id, 'delete-event', { operation: crypto.randomUUID(), revision: current.updateDate });
  assert.throws(() => f.services.events.read(String(id)));
  assert.ok(service.store.history(id).some((row) => row.action === 'delete-event'));
});

await test('backup and restore preserve complete setup, audit, operation results and the fingerprint key', async (t) => {
  const f = runtimeFixture(t);
  const service = f.services.management;

  const owner = await service.setup({
    mode: 'new',
    key: service.issueSetupKey()!,
    username: 'owner',
    first_name: 'First',
    last_name: 'Rider',
    password: 'test|password',
  });

  const opened = service.sessions.create(f.accounts.identityOf(owner), Date.now() + 900_000);
  const operation = crypto.randomUUID();

  const result = await service.create(
    opened.id,
    { username: 'second', first_name: 'Second', last_name: 'Rider', password: 'test|password' },
    operation,
  );

  assert.match(service.store.operation(owner.player_id, operation)!.fingerprint, /^[a-f0-9]{128}$/);
  const secret = Buffer.from(f.sessions.secret);
  const { backupStorage, restoreStorage } = await import('#src/migrations/backup');
  const { AccountsService } = await import('#src/services/auth.service');
  const { SessionsService } = await import('#src/services/browser-session.service');
  const { ManagementRepository } = await import('#src/repositories/management.repository');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { resolve } = await import('node:path');
  const backup = mkdtempSync(resolve(tmpdir(), 'zluggish-management-backup-'));
  t.after(() => rmSync(backup, { recursive: true, force: true }));
  backupStorage(f.accounts.storage, backup, null);
  f.accounts.close();
  restoreStorage(f.config.storageDir, backup, null);
  const restored = new AccountsService(f.config.storageDir);
  t.after(() => restored.close());
  const store = new ManagementRepository(restored.db);
  assert.equal(store.complete(), true);
  assert.equal(restored.get(owner.player_id)!.role, 'administrator');
  assert.deepEqual(JSON.parse(store.operation(owner.player_id, operation)!.result!), result);
  assert.ok(store.history(owner.player_id).some((row) => row.action === 'setup'));
  const sessions = new SessionsService(restored);
  assert.deepEqual(sessions.secret, secret);
  assert.equal(sessions.browsers.size, 0);
  restored.close();
});

await test('setup lists only safe rider fields after checking the key and selects the exact rider by ID', async (t) => {
  const f = runtimeFixture(t);
  const upper = await f.accounts.create('Anna Upper', 'upper-password', 'ANNA');
  const mixed = await f.accounts.create('Anna Mixed', 'mixed-password', 'Anna');
  const service = f.services.management;
  const key = service.issueSetupKey()!;
  const web = createWebApp(f);
  const state = await web.request('http://local:8080/api/setup');
  const { csrf, ...publicState } = await state.json();
  assert.equal('riders' in publicState, false);
  const cookie = state.headers.getSetCookie()[0]!.split(';', 1)[0]!;

  const check = (key: string) =>
    web.request('http://local:8080/api/setup/key', {
      method: 'POST',
      headers: {
        Origin: 'http://local:8080',
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrf,
      },
      body: JSON.stringify({ key }),
    });

  const denied = await check('wrong-key');
  assert.equal(denied.status, 403);
  assert.equal('riders' in (await denied.json()), false);
  const accepted = await check(key);
  assert.equal(accepted.status, 200);
  const body = await accepted.json();
  assert.deepEqual(
    body.riders,
    [mixed, upper].map((r) => ({
      player_id: r.player_id,
      username: r.username,
      first_name: r.first_name,
      last_name: r.last_name,
      enabled: r.enabled,
      has_password: true,
    })),
  );
  await assert.rejects(
    service.setup({ mode: 'existing', key, player_id: mixed.player_id, password: 'upper-password' }),
  );
  const admin = await service.setup({ mode: 'existing', key, player_id: mixed.player_id, password: 'mixed-password' });
  assert.equal(admin.player_id, mixed.player_id);
  assert.equal(f.accounts.get(upper.player_id)!.role, 'rider');
  const finished = await check(key);
  assert.equal(finished.status, 403);
});
