import { runtimeFixture } from '#tests/support/runtime';
import { packageRoot } from '#src/config/load';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';

/* The shared theme moved out of the game app. The game app must not change one pixel.
Baselines are screenshots of the release before the move, per platform, because font
rendering differs between platforms. UPDATE_BASELINES=1 writes the current pages instead.
*/
const baselines = resolve(packageRoot(), 'tests/browser/baselines', process.platform);

function compare(name: string, actual: Buffer) {
  const expected = resolve(baselines, `${name}.png`);

  if (process.env.UPDATE_BASELINES === '1') {
    mkdirSync(baselines, { recursive: true });
    writeFileSync(expected, actual);

    return;
  }

  // Chromium encodes identical pixels to identical bytes, so equal files mean equal pixels.
  const same = actual.equals(readFileSync(expected));

  if (!same) writeFileSync(resolve(baselines, `${name}.actual.png`), actual);
  assert.ok(same, `${name} differs from the baseline; compare ${name}.actual.png`);
}

await test(
  'the game app looks exactly as before the shared theme moved',
  {
    timeout: 40_000,
    skip:
      existsSync(baselines) || process.env.UPDATE_BASELINES === '1' ? false : `no baselines for ${process.platform}`,
  },
  async (t) => {
    const f = runtimeFixture(t);
    await f.accounts.create('Owner Rider', 'test-password', 'owner@example.test');
    const rider = await f.accounts.create('Plain Rider', 'test-password', 'plain@example.test');
    const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
    t.after(() => server.close());

    if (!server.listening) await once(server, 'listening');
    const origin = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}`;
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 800, height: 460 }, reducedMotion: 'reduce' });

    const shot = async (name: string) => {
      await page.mouse.move(0, 0);
      compare(name, await page.screenshot({ fullPage: true }));
    };

    await page.goto(`${origin}/login/`);
    await page.locator(`form:has(input[name=player_id][value="${rider.player_id}"]) button`).click();
    await page.getByLabel('Password', { exact: true }).waitFor();
    await shot('password');
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.waitForURL('**/user/**');
    await shot('user');
    await page.goto(`${origin}/settings/${rider.username}/`);
    await shot('settings');
  },
);
