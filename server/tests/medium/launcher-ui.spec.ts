import { mediumBrowser, mediumFixture } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

await test('Svelte SSR prototype keeps identity, CSRF, multipart and static asset boundaries', async (t) => {
  const f = await mediumFixture(t);
  const unauthorized = await f.app.request('/ui/prototype/settings');
  assert.equal(unauthorized.status, 401);
  const browser = await mediumBrowser(f);
  const page = await browser.request('/ui/prototype/settings');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
  const html = await page.text();
  assert.match(html, /Svelte launcher prototype/);
  assert.match(html, /Medium Rider/);
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

  for (const path of ['/static/launcher-ui/missing.js', '/static/launcher-ui/.vite/manifest.json']) {
    const missing = await f.app.request(path);
    assert.equal(missing.status, 404);
  }

  const form = new FormData();
  form.set('csrf_token', props.csrf);
  form.set('bridge_folder', 'test-folder');
  form.set('strava_method', 'free');

  const checked = await browser.request('/ui/prototype/settings', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
  });

  assert.equal(checked.status, 200);
  const result = await checked.json();
  assert.equal(result.ok, true);
  form.set('csrf_token', 'invalid');
  const rejected = await browser.request('/ui/prototype/settings', { method: 'POST', body: form });
  assert.equal(rejected.status, 400);
});

await test('serialized props and SSR escape user content', async (t) => {
  const f = await mediumFixture(t);
  f.settings.save(f.rider.player_id, { 'workouts.trainingpeaks.bridgeFolder': '</script><script>evil()</script>&' });
  const browser = await mediumBrowser(f);
  const page = await browser.request('/ui/prototype/settings');
  const html = await page.text();
  assert.ok(!html.includes('</script><script>evil()'));
  assert.match(html, /\\u003c/);
});
