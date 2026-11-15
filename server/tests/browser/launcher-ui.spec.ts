import { runtimeFixture } from '#tests/support/runtime';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { z } from 'zod';
import { test } from 'node:test';

await test('prototype hydrates, submits multipart once, and works without JavaScript', async (t) => {
  const f = runtimeFixture(t);
  const rider = await f.accounts.create('Browser Rider', '', true);
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  if (!server.listening) await once(server, 'listening');
  const address = z.object({ port: z.number() }).parse(server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const javaScriptEnabled of [true, false]) {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const errors: string[] = [];
    let submits = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/ui/prototype/settings')) submits++;
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    await page.goto(`${origin}/login/`);
    const csrf = await page.locator('[name=csrf_token]').inputValue();
    await context.request.post(`${origin}/login/`, { form: { csrf_token: csrf, player_id: String(rider.player_id) } });
    await page.goto(`${origin}/ui/prototype/settings`);
    assert.match(await page.title(), /Svelte launcher prototype/);
    await page.locator('#bridge-folder').fill('browser-draft');

    if (javaScriptEnabled) {
      await page.getByText('Draft changed', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Check form' }).click();
      await page.getByText('Form received. This prototype does not save preferences.', { exact: true }).waitFor();
      assert.equal(await page.locator('#bridge-folder').inputValue(), 'browser-draft');
      await page.locator('#bridge-folder').fill('x'.repeat(501));
      await page.getByRole('button', { name: 'Check form' }).click();
      assert.equal(await page.locator('#bridge-folder').getAttribute('aria-invalid'), 'true');
    } else {
      await Promise.all([
        page.waitForResponse(
          (response) => response.url().endsWith('/ui/prototype/settings') && response.status() === 303,
        ),
        page.getByRole('button', { name: 'Check form' }).click(),
      ]);
      assert.match(await page.title(), /Svelte launcher prototype/);
    }

    assert.equal(submits, 1);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
