import { runtimeFixture } from '#tests/support/runtime';
import { createWebApp } from '#src/http/web-app';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { once } from 'node:events';
import { test } from 'node:test';

for (const existing of [false, true])
  await test(
    `web setup with ${existing ? 'existing' : 'new'} rider, management, and game login`,
    { timeout: 40_000 },
    async (t) => {
      const f = runtimeFixture(t);

      if (existing) await f.accounts.create('First Rider', 'test-password', false, 'owner');
      const key = f.services.management.issueSetupKey()!;
      const web = serve({ fetch: createWebApp(f).fetch, hostname: '127.0.0.1', port: 0 });
      const game = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
      t.after(() => {
        web.close();
        game.close();
      });
      await Promise.all([web, game].flatMap((s) => (s.listening ? [] : [once(s, 'listening')])));
      const address = z.object({ port: z.number() }).parse(web.address());
      const gameAddress = z.object({ port: z.number() }).parse(game.address());
      const origin = `http://127.0.0.1:${address.port}`;
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width: 360, height: 800 }, reducedMotion: 'reduce' });
      page.setDefaultTimeout(7000);
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        errors.push(error.message);
      });
      await page.goto(origin + '/setup');
      await page.getByLabel('Setup key').fill(key);

      if (existing) await page.getByLabel('Setup method').selectOption('existing');
      else {
        await page.getByLabel('First name', { exact: true }).fill('First');
        await page.getByLabel('Last name', { exact: true }).fill('Rider');
        await page.getByLabel('Confirm password', { exact: true }).fill('test-password');
      }

      await page.getByLabel('Login name', { exact: true }).fill('owner');
      await page.getByLabel('Password', { exact: true }).fill('test-password');
      await page.getByRole('button', { name: 'Complete setup' }).click();
      await page.getByRole('heading', { name: 'Create rider' }).waitFor();
      const create = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Create rider' }) });
      await create.getByLabel('First name').fill('Second');
      await create.getByLabel('Last name').fill('Rider');
      await create.getByLabel('Login name').fill('second');
      await create.getByLabel('Password', { exact: true }).fill('second-password');
      await create.getByRole('button', { name: 'Create rider' }).click();
      await page.getByText('Rider created.', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Sign out', exact: true }).click();
      await page.getByLabel('Login name', { exact: true }).fill('owner');
      await page.getByLabel('Password', { exact: true }).fill('test-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await page.getByRole('button', { name: 'Manage', exact: true }).click();
      await page.getByRole('heading', { name: 'Confirm your password' }).waitFor();
      await page.getByLabel('Password', { exact: true }).fill('test-password');
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await page.getByRole('heading', { name: 'Create rider' }).waitFor();
      const gamePage = await browser.newPage();
      await gamePage.goto(`http://127.0.0.1:${gameAddress.port}/login/`);
      await gamePage.getByRole('button', { name: /Second Rider/ }).click();
      await gamePage.getByLabel('Password', { exact: true }).fill('second-password');
      await gamePage.getByRole('button', { name: 'Sign in', exact: true }).click();
      await gamePage.waitForURL('**/user/**');
      assert.deepEqual(errors, []);
    },
  );
