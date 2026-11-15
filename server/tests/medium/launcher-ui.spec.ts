import { mediumBrowser, mediumFixture } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

await test('Svelte SSR settings keeps identity, CSRF, multipart and static asset boundaries', async (t) => {
  const f = await mediumFixture(t);
  const unauthorized = await f.app.request(`/settings/${f.rider.username}/`);
  assert.equal(unauthorized.status, 401);
  const browser = await mediumBrowser(f);
  const page = await browser.request(`/settings/${f.rider.username}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  const html = await page.text();
  assert.match(html, /Rider settings/);
  assert.match(html, /name="csrf_token"/);

  const props = z
    .object({ csrf: z.string() })
    .parse(JSON.parse(/id="launcher-props">([^<]+)<\/script>/.exec(html)![1]!));

  assert.ok(props.csrf);
  const asset = /src="(\/static\/launcher-ui\/[^"]+\.js)"/.exec(html)![1]!;
  const script = await f.app.request(asset);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('Content-Type'), 'text/javascript');
  assert.match(script.headers.get('Cache-Control')!, /immutable/);
  assert.equal(script.headers.get('Set-Cookie'), null);

  for (const path of [
    '/static/launcher-ui/missing.js',
    '/static/launcher-ui/.vite/manifest.json',
    '/static/launcher-ui/assets/%2e%2e%2f.vite%2fmanifest.json',
  ]) {
    const missing = await f.app.request(path);
    assert.equal(missing.status, 404);
  }

  const form = new FormData();
  form.set('csrf_token', props.csrf);
  form.set('bridge_folder', 'test-folder');
  form.set('strava_method', 'free');

  const checked = await browser.request(`/settings/${f.rider.username}/`, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
  });

  assert.equal(checked.status, 200);
  const result = await checked.json();
  assert.equal(result.ok, true);
  assert.equal(f.settings.read(f.rider.player_id)['workouts.trainingpeaks.bridgeFolder'], 'test-folder');
  form.set('csrf_token', 'invalid');
  const rejected = await browser.request(`/settings/${f.rider.username}/`, { method: 'POST', body: form });
  assert.equal(rejected.status, 400);
});

await test('serialized props and SSR escape user content', async (t) => {
  const f = await mediumFixture(t);
  f.settings.save(f.rider.player_id, { 'workouts.trainingpeaks.bridgeFolder': '</script><script>evil()</script>&' });
  const browser = await mediumBrowser(f);
  const page = await browser.request(`/settings/${f.rider.username}/`);
  const html = await page.text();
  assert.ok(!html.includes('</script><script>evil()'));
  assert.match(html, /\\u003c/);
});

await test('upload and session probes never create anonymous sessions or trigger workout sync', async (t) => {
  const f = await mediumFixture(t);
  const before = f.sessions.browsers.size;

  for (const path of ['/ui/status/uploads', '/ui/status/session']) {
    const response = await f.app.request(path, { headers: { Accept: 'application/json' } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(f.sessions.browsers.size, before);
  }

  const browser = await mediumBrowser(f);
  const sync = t.mock.method(f.services.workouts, 'syncWorkoutsAutomatically', () => Promise.resolve());

  const status = t.mock.method(f.services.uploads, 'status', (id: number) => {
    assert.equal(id, f.rider.player_id);

    return Array.from({ length: 150 }, (_, index) => ({ activity_id: index, provider: 'strava', state: 'pending' }));
  });

  const response = await browser.request('/ui/status/uploads', { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.jobs.length, 100);
  assert.equal(status.mock.callCount(), 1);
  assert.equal(sync.mock.callCount(), 0);
});

await test('JSON mutations keep the session rider as owner, return canonical values and reject stale contexts', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const path = `/settings/${f.other.username}/`;
  const page = await browser.request(path);
  const html = await page.text();

  const props = z
    .object({ csrf: z.string() })
    .parse(JSON.parse(/id="launcher-props">([^<]+)<\/script>/.exec(html)![1]!));

  const post = (fields: Record<string, string>, context = props.csrf) =>
    browser.request(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Launcher-Context': context },
      body: new URLSearchParams({
        csrf_token: props.csrf,
        bridge_folder: 'new-folder',
        strava_method: 'free',
        ...fields,
      }),
    });

  const saved = await post({ 'uploads.zwift.enabled': 'on' });
  assert.equal(saved.status, 200);
  const result = await saved.json();
  assert.equal(result.ok, true);
  assert.equal(result.data.page.kind, 'settings');
  assert.equal(f.settings.read(f.rider.player_id)['workouts.trainingpeaks.bridgeFolder'], 'new-folder');
  assert.equal(f.settings.read(f.rider.player_id)['uploads.zwift.enabled'], undefined);
  assert.equal(f.settings.read(f.other.player_id)['workouts.trainingpeaks.bridgeFolder'], undefined);
  const invalid = await post({ bridge_folder: 'x'.repeat(501) });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.ok, false);
  assert.ok(invalidBody.fieldErrors.bridge_folder.length);
  assert.equal(invalidBody.reload, undefined);
  const csrf = await post({ csrf_token: 'expired' });
  assert.equal(csrf.status, 400);
  const csrfBody = await csrf.json();
  assert.equal(csrfBody.reload, true);
  const stale = await post({ bridge_folder: 'must-not-save' }, 'another-rider-context');
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.reload, true);
  assert.equal(f.settings.read(f.rider.player_id)['workouts.trainingpeaks.bridgeFolder'], 'new-folder');
});

await test('browser JSON errors do not change game API responses and never serialize saved secrets', async (t) => {
  const f = await mediumFixture(t);
  const game = await f.app.request('/api/profiles/me', { headers: { Accept: 'application/json' } });
  assert.equal(game.status, 401);
  assert.ok(!game.headers.get('Content-Type')?.includes('application/json'));
  const browser = await mediumBrowser(f);
  f.services.connections.save(f.rider.player_id, 'garmin', ['public-user', 'never-send-garmin-password']);
  f.services.connections.save(f.rider.player_id, 'strava', ['123', 'never-send-client-secret']);
  f.services.connections.save(f.rider.player_id, 'intervals', ['42', 'never-send-api-key']);

  for (const provider of ['garmin', 'strava', 'intervals', 'zwift']) {
    const page = await browser.request(`/${provider}/${f.rider.username}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('Cache-Control'), 'no-store');
    const html = await page.text();
    assert.ok(!html.includes('never-send-'));
  }
});
