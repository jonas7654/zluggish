import { StravaMethod } from '#src/enum';
import { mediumFixture, mediumWeb } from '#tests/medium/support';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { z } from 'zod';

const settings = z.object({
  revision: z.number(),
  overrides: z.record(z.string(), z.json()),
  defaults: z.object({ uploads: z.object({ strava: z.object({ method: z.enum(StravaMethod) }) }) }),
});

await test('web settings resolve the Strava method and preserve it on save', async (t) => {
  const f = await mediumFixture(t);
  const web = mediumWeb(f, f.rider);
  const defaultMethod = f.config.riderDefaults.uploads.strava.method;

  for (const override of [undefined, StravaMethod.Free, StravaMethod.Paid]) {
    f.settings.save(f.rider.player_id, override ? { 'uploads.strava.method': override } : {});
    const response = await web.request('/api/me/settings');
    assert.equal(response.status, 200);
    const current = settings.parse(await response.json());
    const resolved = current.overrides['uploads.strava.method'] ?? current.defaults.uploads.strava.method;
    const expected = override ?? defaultMethod;
    assert.equal(resolved, expected);

    const saved = await web.request('/api/me/settings', 'PATCH', {
      revision: current.revision,
      operation: randomUUID(),
      overrides: { ...current.overrides, 'uploads.strava.method': resolved },
    });

    assert.equal(saved.status, 200);
    assert.equal(f.settings.read(f.rider.player_id)['uploads.strava.method'], expected);
  }
});
