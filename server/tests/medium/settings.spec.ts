import { StravaMethod } from '#src/enum';
import { mediumBrowser, mediumFixture } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('settings page selects the resolved Strava method and preserves it on save', async (t) => {
  const f = await mediumFixture(t);
  const browser = await mediumBrowser(f);
  const path = `/settings/${f.rider.username}/`;

  const defaultMethod = f.config.riderDefaults.uploads.strava.method;

  for (const override of [undefined, StravaMethod.Free, StravaMethod.Paid]) {
    f.settings.save(f.rider.player_id, override ? { 'uploads.strava.method': override } : {});
    const response = await browser.request(path);
    assert.equal(response.status, 200);
    const html = await response.text();
    const select = /<select name="strava_method">([\s\S]*?)<\/select>/.exec(html)?.[1];
    assert.ok(select);

    const selected = select
      .matchAll(/<option value="([^"]+)"\s+selected>/g)
      .map((match) => match[1])
      .toArray();

    const expected = override ?? defaultMethod;
    assert.deepEqual(selected, [expected]);

    const saved = await browser.form(path, { strava_method: selected[0]! });
    assert.equal(saved.status, 302);
    assert.equal(f.settings.read(f.rider.player_id)['uploads.strava.method'], expected);
  }
});
