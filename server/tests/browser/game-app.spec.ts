import { runtimeFixture } from '#tests/support/runtime';
import { createWebApp } from '#src/http/web-app';
import { serve } from '@hono/node-server';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { z } from 'zod';
import { create, toBinary } from '@bufbuild/protobuf';
import { PlayerProfileSchema } from '#src/protocol/generated/profile_pb';

async function browserFixture(t: TestContext) {
  const network = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected external provider call in browser test');
  });

  t.after(() => assert.equal(network.mock.callCount(), 0));
  const f = runtimeFixture(t);
  const server = serve({ fetch: f.app.fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => server.close());

  if (!server.listening) await once(server, 'listening');
  const address = z.object({ port: z.number() }).parse(server.address());
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());

  const web = serve({ fetch: createWebApp(f).fetch, hostname: '127.0.0.1', port: 0 });
  t.after(() => web.close());

  if (!web.listening) await once(web, 'listening');
  const webAddress = z.object({ port: z.number() }).parse(web.address());

  return { ...f, origin, browser, webOrigin: `http://127.0.0.1:${webAddress.port}` };
}

async function signIn(page: Page, origin: string, id: number, password = 'test-password', remember = false) {
  await page.goto(`${origin}/login/`);
  await page.locator(`form:has(input[name=player_id][value="${id}"]) button`).click();
  await page.getByLabel('Password', { exact: true }).fill(password);

  if (remember) await page.getByLabel('Remember password', { exact: true }).check();
  // A sign-in password is not a setting, so the form must not report unsaved changes.
  assert.equal(await page.getByText('Unsaved changes').count(), 0);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('**/user/**');
}

for (const javaScriptEnabled of [true, false]) {
  await test(`web-created rider, protected login and native POST with JavaScript ${javaScriptEnabled}`, async (t) => {
    const f = await browserFixture(t);

    const context = await f.browser.newContext({
      javaScriptEnabled,
      viewport: { width: 420, height: 600 },
      reducedMotion: 'reduce',
    });

    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    await f.services.management.setup({
      mode: 'new',
      key: f.services.management.issueSetupKey()!,
      username: 'browser',
      first_name: 'New Browser',
      last_name: 'Rider',
      password: 'browser-password',
    });
    await page.goto(`${f.origin}/login/`);
    const rider = f.accounts.list()[0]!;
    await page.getByRole('button', { name: 'New Browser Rider' }).click();
    await page.getByLabel('Password', { exact: true }).fill('wrong');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Wrong password. Try again.', { exact: true }).first().waitFor();
    await signIn(page, f.origin, rider.player_id, 'browser-password', true);

    // Switching ends the session and returns to the user list; the remembered user needs no password.
    await page.getByRole('button', { name: 'Switch rider' }).click();
    await page.waitForURL('**/login/');
    await page.getByRole('button', { name: 'New Browser Rider' }).click();
    await page.waitForURL('**/user/**');
    // Inspect the native request while preventing the browser's external protocol handler.
    let posted = '';
    await page.route('**/start-zwift', async (route) => {
      posted = route.request().postData() ?? '';
      const response = await route.fetch({ maxRedirects: 0 });
      assert.equal(response.status(), 302);
      assert.equal(response.headers().location, '/ride');
      await route.fulfill({ status: 200, contentType: 'text/html', body: 'Launch POST accepted' });
    });
    await page.getByRole('button', { name: 'Start Zwift', exact: true }).click();
    await page.getByText('Launch POST accepted').waitFor();
    assert.match(posted, /csrf_token=/);
    assert.match(posted, /map=CALENDAR/);
    const handoff = await context.request.get(`${f.origin}/ride`, { maxRedirects: 0 });
    assert.equal(handoff.status(), 302);
    assert.match(handoff.headers().location!, /^http:\/\/zwift\/\?code=zwift_refresh_token/);
    assert.deepEqual(errors, []);
    await context.close();
  });
}

await test('preferences keep drafts on failures, block double submits and lock on session expiry', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Preferences Rider', 'test-password');
  f.settings.save(rider.player_id, { 'uploads.strava.method': 'free' });
  const context = await f.browser.newContext();
  const page = await context.newPage();
  await signIn(page, f.origin, rider.player_id);
  await page.goto(`${f.origin}/settings/${rider.username}/`);
  assert.equal(await page.getByLabel('Strava method').inputValue(), 'free');
  const folder = page.getByLabel('TrainingPeaks export folder');
  await folder.fill('draft-folder');
  await page.getByText('Unsaved changes', { exact: true }).waitFor();
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  let posts = 0;
  await page.route('**/settings/**', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    await held;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Save preferences' }).click();
  assert.equal(await page.getByRole('button', { name: 'Submitting…' }).isDisabled(), true);
  await page
    .locator('form')
    .first()
    .evaluate((element: HTMLFormElement) => element.requestSubmit());
  release();
  await page.getByText('Saved.', { exact: true }).waitFor();
  assert.equal(posts, 1);
  assert.equal(f.settings.read(rider.player_id)['workouts.trainingpeaks.bridgeFolder'], 'draft-folder');
  await page.unroute('**/settings/**');
  await folder.fill('keep-on-error');
  await page.route('**/settings/**', (route) =>
    route.fulfill({
      status: 400,
      json: { ok: false, message: 'Folder refused', fieldErrors: { bridge_folder: ['Choose another folder'] } },
    }),
  );
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await page.getByText('Choose another folder', { exact: true }).waitFor();
  assert.equal(await folder.inputValue(), 'keep-on-error');
  assert.equal(await folder.evaluate((element) => element === document.activeElement), true);
  await page.unroute('**/settings/**');
  await page.route('**/settings/**', (route) => route.abort());
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await page.getByText('Could not submit. Your draft is kept. Try again.', { exact: true }).waitFor();
  assert.equal(await folder.inputValue(), 'keep-on-error');
  await page.unroute('**/settings/**');
  f.sessions.browsers.clear();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await page.getByRole('button', { name: 'Reload this page' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save preferences' }).isDisabled(), true);
  await context.close();
});

await test('connections preserve blank saved secrets and show conditional fields and Garmin MFA', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Connected Rider', 'test-password');
  const context = await f.browser.newContext();
  const page = await context.newPage();
  await signIn(page, f.origin, rider.player_id);
  await page.goto(`${f.origin}/strava/${rider.username}/`);
  await page.getByLabel('Client ID').fill('123');
  await page.getByLabel('Client secret').fill('private-client-secret');
  await page.getByRole('button', { name: 'Save API credentials' }).click();
  await page.getByText('Credentials saved.', { exact: true }).first().waitFor();
  assert.equal(await page.getByLabel('Client secret').inputValue(), '');
  await page.getByLabel('Client ID').fill('456');
  await page.getByRole('button', { name: 'Save API credentials' }).click();
  await page.getByText('Credentials saved.', { exact: true }).first().waitFor();
  assert.deepEqual(f.services.connections.read(rider.player_id, 'strava'), ['456', 'private-client-secret']);
  await page.getByLabel('Upload method').selectOption('free');
  assert.equal(await page.getByLabel('Client secret').isVisible(), false);
  assert.equal(await page.getByLabel('_strava4_session').isVisible(), true);
  await page.goto(`${f.origin}/garmin/${rider.username}/`);
  await page.getByLabel('Username').fill('garmin-user');
  await page.getByLabel('Password', { exact: true }).fill('garmin-secret');
  await page.getByRole('button', { name: 'Save credentials' }).click();
  await page.getByRole('button', { name: 'Authorize with Garmin' }).waitFor();
  t.mock.method(f.services.integrations, 'authorizeGarmin', () => Promise.resolve('mfa' as const));
  await page.getByRole('button', { name: 'Authorize with Garmin' }).click();
  await page.getByLabel('Verification code').waitFor();
  await context.close();
});

await test('import review requires source confirmation and cancel bypasses validation', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Import Rider', 'test-password');
  f.accounts.repository.updateImportedProfile(rider.player_id, 'Import', 'Rider', 123);
  await f.services.management.setup({
    mode: 'existing',
    key: f.services.management.issueSetupKey()!,
    player_id: rider.player_id,
    password: 'test-password',
  });
  const context = await f.browser.newContext();
  const page = await context.newPage();
  await page.goto(`${f.webOrigin}/sign-in`);
  await page.getByLabel('Login name', { exact: true }).fill(rider.username);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();

  const buffer = Buffer.from(
    toBinary(PlayerProfileSchema, create(PlayerProfileSchema, { id: 999n, firstName: 'Remote', lastName: 'Source' })),
  );

  for (const cancel of [true, false]) {
    await page.goto(`${f.webOrigin}/import/local`);
    await page
      .locator('[name="profile.bin"]')
      .setInputFiles({ name: 'profile.bin', mimeType: 'application/octet-stream', buffer });
    await page.getByRole('button', { name: 'Review import' }).click();
    await page.getByRole('heading', { name: 'Confirm profile import' }).waitFor();

    if (cancel) {
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    } else {
      await page.getByLabel('Confirm this source may differ or be shared with another user').check();
      await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
    }

    await page
      .getByText(cancel ? 'Import canceled. Your user data is unchanged.' : 'Profile data imported.', { exact: true })
      .waitFor();
    assert.equal(f.accounts.get(rider.player_id)?.first_name, cancel ? 'Import' : 'Remote');
  }

  await context.close();
});

await test('upload polling pauses while hidden and stops when all jobs are terminal', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Uploading Rider', 'test-password');
  let terminal = false;

  const status = t.mock.method(f.services.uploads, 'status', () => [
    { activity_id: 1, provider: 'strava', state: terminal ? 'sent' : 'pending' },
  ]);

  const context = await f.browser.newContext();
  const page = await context.newPage();
  await page.clock.install();
  await signIn(page, f.origin, rider.player_id);
  const initial = status.mock.callCount();
  await page.evaluate(() => {
    // Browser callback runs in the page's DOM environment.
    const { document } = globalThis;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(15_000);
  assert.equal(status.mock.callCount(), initial);
  terminal = true;
  await page.evaluate(() => {
    // Browser callback runs in the page's DOM environment.
    const { document } = globalThis;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(5100);
  await page.getByText('Activity 1: strava — sent', { exact: true }).waitFor();
  const stopped = status.mock.callCount();
  await page.clock.runFor(15_000);
  assert.equal(status.mock.callCount(), stopped);
  await context.close();
});

await test('a rider switch discards drafts and ignores a late save response', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('First Rider', 'test-password');
  const other = await f.accounts.create('Second Rider', 'test-password');
  const context = await f.browser.newContext();
  const page = await context.newPage();
  await signIn(page, f.origin, rider.player_id);
  await page.goto(`${f.origin}/settings/${rider.username}/`);
  const folder = page.getByLabel('TrainingPeaks export folder');
  const baseline = await folder.inputValue();
  await folder.fill('old-rider-draft');
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const { promise: received, resolve: captured } = Promise.withResolvers<void>();
  await page.route('**/settings/**', async (route) => {
    const response = await route.fetch();
    captured();
    await held;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await received;
  const second = await context.newPage();
  await signIn(second, f.origin, other.player_id);
  await page.getByRole('button', { name: 'Reload this page' }).waitFor();
  release();
  assert.equal(await folder.inputValue(), baseline);
  assert.equal(await page.getByRole('button', { name: 'Save preferences' }).isDisabled(), true);
  assert.equal(f.settings.read(other.player_id)['workouts.trainingpeaks.bridgeFolder'], undefined);
  await context.close();
});

await test('plain forms save settings and connections, link to web imports and change passwords', async (t) => {
  const f = await browserFixture(t);
  const rider = await f.accounts.create('Plain Rider', 'test-password');
  t.mock.method(f.services.workouts, 'syncWorkoutsAutomatically', () => Promise.resolve());
  const context = await f.browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await signIn(page, f.origin, rider.player_id);

  const visit = async (path: string) => {
    const response = await page.goto(`${f.origin}/${path}/${rider.username}/`);
    assert.equal(response?.status(), 200);
    const reloaded = await page.reload();
    assert.equal(reloaded?.status(), 200);
  };

  const submit = async (label: string) => {
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: label, exact: true }).click()]);
  };

  await visit('settings');
  await page.getByLabel('TrainingPeaks export folder').fill('plain-folder');
  await submit('Save preferences');
  assert.equal(f.settings.read(rider.player_id)['workouts.trainingpeaks.bridgeFolder'], 'plain-folder');
  await visit('zwift');
  await page.getByText('Manage this in the web app on port 8080.', { exact: true }).waitFor();
  await visit('strava');
  await page.getByLabel('Upload method').selectOption('paid');
  await submit('Save method');
  await page.getByLabel('Client ID').fill('123');
  await page.getByLabel('Client secret').fill('strava-secret');
  await submit('Save API credentials');
  assert.deepEqual(f.services.connections.read(rider.player_id, 'strava'), ['123', 'strava-secret']);
  await visit('garmin');
  await page.getByLabel('Username').fill('garmin-user');
  await page.getByLabel('Password', { exact: true }).fill('garmin-secret');
  await submit('Save credentials');
  await visit('intervals');
  await page.getByLabel('Athlete ID').fill('42');
  await page.getByLabel('API key').fill('intervals-secret');
  await submit('Save connection');
  assert.deepEqual(f.services.connections.read(rider.player_id, 'intervals'), ['42', 'intervals-secret']);
  await visit('trainingpeaks');
  await page.getByLabel('Export folder').fill('plain-training-folder');
  await submit('Save folder');
  assert.equal(f.settings.read(rider.player_id)['workouts.trainingpeaks.bridgeFolder'], 'plain-training-folder');
  await visit('profile');

  await page.getByText('Manage this in the web app on port 8080.', { exact: true }).waitFor();
  await visit('power_curves');
  await page.getByLabel(/I confirm:/).check();
  await submit('Delete existing power curves');
  await page.goto(`${f.origin}/user/${rider.username}/`);
  assert.equal(await page.getByRole('button', { name: 'Reload bots', exact: true }).count(), 0);
  await visit('reset');
  await page.getByLabel('Current password').fill('test-password');
  await page.getByLabel('New password').fill('new-local-password');
  await page.getByLabel('Confirm password').fill('new-local-password');
  await submit('Save');
  await page.waitForURL('**/login/');
  await signIn(page, f.origin, rider.player_id, 'new-local-password');
  await visit('reset');
  assert.equal(await page.getByLabel('Remove password', { exact: true }).count(), 0);
  await context.close();
});
