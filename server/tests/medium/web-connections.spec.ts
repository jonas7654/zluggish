import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebApp } from '#src/http/web-app';
import { responseStatus } from '#tests/support/html';
import { mediumFixture } from '#tests/medium/support';

await test('web connections require web authentication and CSRF, isolate riders and hide secrets', async (t) => {
  const f = await mediumFixture(t);
  const app = createWebApp(f);
  const owner = f.services.management.sessions.create(f.accounts.identityOf(f.rider));

  const request = (path: string, method = 'GET', data?: Record<string, string>, csrf = owner.session.csrf) =>
    app.request(`https://web.example${path}`, {
      method,
      headers: {
        Cookie: `zluggish_web_session=${owner.id}`,
        Origin: 'https://web.example',
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      ...(data && { body: JSON.stringify(data) }),
    });

  assert.equal(await responseStatus(app.request('/api/me/connections')), 401);
  assert.equal(
    await responseStatus(
      request('/api/me/connections/garmin', 'PUT', { username: 'athlete', secret: 'private-password' }, 'wrong'),
    ),
    403,
  );

  for (const provider of ['strava', 'garmin', 'intervals']) {
    assert.equal(
      await responseStatus(
        request(`/api/me/connections/${provider}`, 'PUT', { username: '12345', secret: 'private-password' }),
      ),
      200,
    );
    assert.equal(
      await responseStatus(request(`/api/me/connections/${provider}`, 'PUT', { username: '12345', secret: '' })),
      200,
    );
  }

  assert.equal(
    await responseStatus(request('/api/me/connections/strava/cookie', 'PUT', { cookie: 'private-cookie' })),
    200,
  );
  const response = await request('/api/me/connections');
  const body = await response.text();
  assert.ok(!body.includes('private-password'));
  assert.ok(!body.includes('private-cookie'));
  assert.equal(JSON.parse(body).strava.cookie, true);
  assert.deepEqual(f.services.connections.read(f.rider.player_id, 'garmin'), ['12345', 'private-password']);
  assert.equal(f.services.connections.read(f.other.player_id, 'garmin'), null);
  const authorizationResponse = await request('/api/me/connections/strava/authorize', 'POST', {});
  const authorization = await authorizationResponse.json();
  const url = new URL(authorization.url);
  assert.equal(url.origin, 'https://www.strava.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://web.example/settings');
  assert.notEqual(url.searchParams.get('state'), owner.session.csrf);
  assert.equal(
    await responseStatus(request('/api/me/connections/strava/authorize', 'POST', { code: 'code', state: 'wrong' })),
    403,
  );
  assert.equal(await responseStatus(request('/api/me/connections/strava', 'DELETE')), 200);
  assert.equal(f.services.documents.has(f.rider.player_id, 'strava4_session.txt'), false);
  assert.equal(f.services.connections.has(f.rider.player_id, 'strava'), false);
  f.services.management.sessions.end(owner.id);
  assert.equal(await responseStatus(request('/api/me/connections')), 401);
});

await test('web Strava authorization consumes state and rejects a completion after sign-out', async (t) => {
  const f = await mediumFixture(t);
  const app = createWebApp(f);
  const owner = f.services.management.sessions.create(f.accounts.identityOf(f.rider));
  f.services.connections.save(f.rider.player_id, 'strava', ['client', 'secret']);

  const post = (data: Record<string, string>) =>
    app.request('https://web.example/api/me/connections/strava/authorize', {
      method: 'POST',
      headers: {
        Cookie: `zluggish_web_session=${owner.id}`,
        Origin: 'https://web.example',
        'X-CSRF-Token': owner.session.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

  const started = await post({});
  const { url } = await started.json();
  const state = new URL(url).searchParams.get('state')!;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(f.accounts.repositories.stravaRepository, 'exchangeCode', async () => {
    entered.resolve();
    await release.promise;

    return {
      clientId: 'client',
      clientSecret: 'secret',
      access: 'access',
      refresh: 'refresh',
      expiresAt: 9_999_999_999,
    };
  });
  const pending = post({ code: 'code', state });
  await entered.promise;
  assert.equal(await responseStatus(post({ code: 'code', state })), 403);
  f.services.management.sessions.end(owner.id);
  release.resolve();
  assert.equal(await responseStatus(pending), 400);
  assert.equal(f.services.documents.has(f.rider.player_id, 'strava_token.txt'), false);
});
