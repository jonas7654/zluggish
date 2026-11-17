import { movedToWeb } from '#src/http/game/web-page';
import { checkbox, field, form as makeForm, model, secret } from '#src/http/game/models';
import { gamePage } from '#src/http/game/render';
import { gameRedirect } from '#src/http/game/results';
import { RemovableCredentialFile, StravaMethod } from '#src/enum';
import { authenticated, csrf } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { Rider } from '#src/repositories/accounts.repository';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

type Env = Context<RuntimeEnv>;

const removable = z.enum(RemovableCredentialFile);

const text = z.string().catch('');

export function integrationRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.integrations;

  const connections = runtime.services.connections;

  const documents = runtime.services.documents;

  function cookieOf(rider: Rider) {
    return documents.text(rider.player_id, 'strava4_session.txt')?.split(/\r?\n/, 1)[0] ?? '';
  }

  function stravaPage(c: Env, rider: Rider, message = '', failed = false, redirect?: string) {
    const method = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(rider.player_id),
    ).uploads.strava.method;

    const client = connections.read(rider.player_id, 'strava');
    const authorized = documents.has(rider.player_id, 'strava_token.txt');
    const cookie = !!cookieOf(rider);

    return gamePage(
      c,
      runtime,
      model(
        c,
        'connection',
        'Strava',
        [
          makeForm(
            'strava-method',
            `/strava/${rider.username}/`,
            [
              field('method', 'Upload method', {
                type: 'select',
                value: method,
                options: [
                  { value: 'paid', label: 'API' },
                  { value: 'free', label: 'Session cookie' },
                ],
              }),
            ],
            'Save method',
          ),
          makeForm(
            'strava-api',
            `/strava/${rider.username}/`,
            [
              field('client_id', 'Client ID', { value: client?.[0] ?? '', required: true }),
              secret('client_secret', 'Client secret', !!client),
            ],
            'Save API credentials',
            { title: 'API', method: 'paid' },
          ),
          makeForm(
            'strava-cookie',
            `/strava/${rider.username}/`,
            [secret('_strava4_session', '_strava4_session', cookie)],
            'Save cookie',
            { title: 'Session cookie', method: 'free' },
          ),
          ...removable.options
            .filter((file) => file.startsWith('strava') && documents.has(rider.player_id, file))
            .map((file) =>
              makeForm(`remove-${file}`, `/delete/${file}`, [], `Remove ${file}`, { confirmation: `Remove ${file}?` }),
            ),
        ],
        {
          message,
          failed,
          stravaMethod: method,
          paragraphs: [authorized ? 'Authorized.' : 'Not authorized.'],
          links: [
            ...(client ? [{ href: '/strava_auth', label: 'Authorize with Strava' }] : []),
            ...(cookie ? [{ href: `/strava/${rider.username}/test`, label: 'Test session' }] : []),
          ],
        },
      ),
      redirect,
    );
  }

  function zwiftPage(c: Env, _rider: Rider, message = '', failed = false) {
    return movedToWeb(c, runtime, 'Zwift connection', '/zwift', message, failed);
  }

  app.on(['GET', 'POST'], '/zwift/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method === 'GET') return zwiftPage(c, rider);
    const form = await csrf(c, runtime);

    if (form.action === 'settings') {
      const username = text.parse(form.username).trim();
      const password = text.parse(form.password);

      if (username || password) {
        if (!username || !password) return zwiftPage(c, rider, 'Enter both username and password.', true);
        connections.save(rider.player_id, 'zwift', [username, password]);
      }

      if (!connections.read(rider.player_id, 'zwift') && (form.upload || form.click))
        return zwiftPage(c, rider, 'Save credentials before enabling uploads or Click.', true);
      runtime.services.settings.save(rider.player_id, {
        ...runtime.services.settings.read(rider.player_id),
        'uploads.zwift.enabled': form.upload === 'on',
        'devices.zwiftClick.enabled': form.click === 'on',
      });

      return zwiftPage(c, rider, 'Connection settings saved.');
    }

    if (form.action !== 'import') throw new HTTPException(400);
    const credentials = connections.read(rider.player_id, 'zwift');

    if (!credentials || (!form.profile && !form.achievements))
      return zwiftPage(c, rider, 'Save credentials and choose at least one download.', true);

    if (runtime.world.active(rider.player_id))
      return gamePage(
        c,
        runtime,
        model(c, 'message', 'Zwift connection', [], {
          message: 'Finish the active ride before importing.',
          failed: true,
          errorStatus: 409,
        }),
      );

    try {
      const files = await runtime.services.integrations.downloadOfficialData(
        credentials[0],
        credentials[1],
        form.profile === 'on',
        form.achievements === 'on',
      );

      if (
        !runtime.services.sessions.current(
          c.get('browserId'),
          c.get('browser'),
          runtime.services.accounts.identityOf(rider),
        )
      )
        throw new Error('Import identity changed');
      const imports = runtime.services.imports;
      const stage = imports.prepare(rider, files);
      const browser = c.get('browser');

      if (browser.pendingImport) imports.cancel(rider, browser.pendingImport);
      runtime.services.sessions.transition(browser, { type: 'stage-import', stage });

      return gameRedirect(c, `/profile/${rider.username}/confirm/`);
    } catch {
      return zwiftPage(c, rider, 'Download failed. Existing rider data was retained.', true);
    }
  });

  app.on(['GET', 'POST'], '/strava/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method !== 'POST') return stravaPage(c, rider);
    const form = await csrf(c, runtime);
    let message: string;
    let failed = false;

    if ('_strava4_session' in form) {
      const cookie = text.parse(form._strava4_session).trim();

      if (cookie) {
        documents.put(rider.player_id, 'strava4_session.txt', cookie);
        message = 'Session cookie saved.';
      } else if (cookieOf(rider)) message = 'Session cookie retained.';
      else {
        failed = true;
        message = "Session cookie can't be empty.";
      }
    } else if ('method' in form) {
      const method = z.enum(StravaMethod).safeParse(form.method);

      if (method.success) {
        runtime.services.settings.save(rider.player_id, {
          ...runtime.services.settings.read(rider.player_id),
          'uploads.strava.method': method.data,
        });
        message = 'Strava upload method saved.';
      } else {
        failed = true;
        message = 'Unknown upload method.';
      }
    } else {
      const id = text.parse(form.client_id).trim();
      const secret = text.parse(form.client_secret).trim() || connections.read(rider.player_id, 'strava')?.[1];

      if (id && secret) {
        connections.save(rider.player_id, 'strava', [id, secret]);
        message = 'Credentials saved.';
      } else {
        failed = true;
        message = "Client ID and secret can't be empty.";
      }
    }

    return stravaPage(c, rider, message, failed);
  });

  app.get('/strava/:username/test', async (c) => {
    const rider = authenticated(c);
    const cookie = cookieOf(rider);

    if (!cookie) return stravaPage(c, rider, 'No session configured.');

    try {
      return stravaPage(
        c,
        rider,
        (await runtime.services.integrations.checkSession(cookie))
          ? 'Session is valid.'
          : 'Session is not valid. Update the cookie.',
      );
    } catch {
      return stravaPage(c, rider, 'Could not reach Strava. Check your internet connection.');
    }
  });

  app.get('/strava_auth', (c) => {
    const rider = authenticated(c);
    const client = connections.read(rider.player_id, 'strava');

    if (!client?.[0]) return stravaPage(c, rider, 'Save API credentials first.');

    return c.redirect(runtime.services.integrations.authorizationUrl(client[0], c.get('browser').csrf));
  });

  app.on(['GET', 'POST'], '/authorization', async (c) => {
    const rider = authenticated(c);
    const client = connections.read(rider.player_id, 'strava');
    const code = c.req.query('code');

    // The state echoes this browser's CSRF token so a foreign code cannot be attached.
    const browserToken = c.get('browser').csrf;

    if (!client || !code || !browserToken || c.req.query('state') !== browserToken)
      return stravaPage(c, rider, 'Strava authorization canceled.');

    try {
      await service.authorizeStrava(c.get('browserId'), c.get('browser'), rider, code);

      return stravaPage(c, rider, 'Strava authorized.');
    } catch {
      return stravaPage(c, rider, 'Strava authorization canceled.');
    }
  });

  function garminPage(c: Env, rider: Rider, message = '', failed = false, redirect?: string) {
    const client = connections.read(rider.player_id, 'garmin');
    const authorized = documents.has(rider.player_id, 'garth/oauth1_token.json');

    return gamePage(
      c,
      runtime,
      model(
        c,
        'connection',
        'Garmin',
        [
          makeForm(
            'garmin-credentials',
            `/garmin/${rider.username}/`,
            [
              field('username', 'Username', { value: client?.[0] ?? '', required: true }),
              secret('password', 'Password', !!client),
            ],
            'Save credentials',
          ),
          ...(client ? [makeForm('garmin-authorize', '/garmin_auth', [], 'Authorize with Garmin')] : []),
          ...removable.options
            .filter((file) => file.startsWith('gar') && documents.has(rider.player_id, file))
            .map((file) =>
              makeForm(`remove-${file}`, `/delete/${file}`, [], `Remove ${file}`, { confirmation: `Remove ${file}?` }),
            ),
        ],
        { message, failed, paragraphs: [authorized ? 'Authorized.' : 'Not authorized.'] },
      ),
      redirect,
    );
  }

  app.on(['GET', 'POST'], '/garmin/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method !== 'POST') return garminPage(c, rider);
    const form = await csrf(c, runtime);
    const username = text.parse(form.username).trim();
    const password = text.parse(form.password) || connections.read(rider.player_id, 'garmin')?.[1];

    if (!username || !password) return garminPage(c, rider, "Garmin credentials can't be empty.", true);

    connections.save(rider.player_id, 'garmin', [username, password]);

    return garminPage(c, rider, 'Credentials saved.');
  });

  app.get('/garmin_auth', (c) => garminPage(c, authenticated(c), 'Use the authorization button to connect.'));
  app.post('/garmin_auth', async (c) => {
    const rider = authenticated(c);
    const form = await csrf(c, runtime);

    try {
      const outcome = await service.authorizeGarmin(
        c.get('browserId'),
        c.get('browser'),
        rider,
        form.code === undefined ? undefined : z.string().min(1).max(32).parse(form.code),
      );

      if (outcome === 'mfa')
        return gamePage(
          c,
          runtime,
          model(
            c,
            'connection',
            'Garmin verification',
            [
              makeForm(
                'garmin-mfa',
                '/garmin_auth',
                [
                  field('code', 'Verification code', {
                    type: 'password',
                    required: true,
                    maxLength: 32,
                    autocomplete: 'one-time-code',
                  }),
                ],
                'Verify',
              ),
            ],
            { links: [{ href: `/garmin/${rider.username}/`, label: 'Restart Garmin authorization' }] },
          ),
        );

      return garminPage(c, rider, 'Garmin authorized.');
    } catch {
      return garminPage(c, rider, 'Garmin authorization failed or expired. Try again.', true);
    }
  });

  app.post('/delete/*', async (c) => {
    const rider = authenticated(c);
    const input = await csrf(c, runtime);

    const file = removable.safeParse(decodeURIComponent(c.req.path.slice('/delete/'.length)));

    if (!file.success) throw new HTTPException(403);

    if (input.confirm_action !== 'on') throw new HTTPException(400, { message: 'Confirm the removal first.' });
    runtime.services.uploads.disconnect(rider.player_id, file.data);

    if (file.data.startsWith('strava'))
      return stravaPage(c, rider, `Removed ${file.data}.`, false, `/strava/${rider.username}/`);

    if (file.data.startsWith('garmin') || file.data.startsWith('garth'))
      return garminPage(c, rider, `Removed ${file.data}.`, false, `/garmin/${rider.username}/`);

    return gameRedirect(c, `/settings/${rider.username}/`);
  });

  app.on(['GET', 'POST'], '/power_curves/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      if (form.confirm_action !== 'on')
        throw new HTTPException(400, { message: 'Confirm deleting power curves first.' });

      if (form.create) runtime.services.activities.rebuildPowerCurves(rider.player_id);
      else service.deletePowerCurve(rider.player_id);

      return gamePage(
        c,
        runtime,
        model(c, 'message', 'Power curves', [], {
          message: form.create ? 'Power curves rebuilt.' : 'Power curves deleted.',
        }),
        `/settings/${rider.username}/`,
      );
    }

    return gamePage(
      c,
      runtime,
      model(c, 'maintenance', 'Power curves', [
        makeForm(
          'power-curves',
          `/power_curves/${rider.username}/`,
          [checkbox('create', 'Recreate from saved activities')],
          'Delete existing power curves',
          { confirmation: 'Delete existing power curves? Rebuilding may take some time.' },
        ),
      ]),
    );
  });

  app.post('/api/d-lock-service/device/authenticate', async (c) => {
    const rider = authenticated(c);
    const credentials = connections.read(rider.player_id, 'zwift');

    const enabled = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(rider.player_id),
    ).devices.zwiftClick.enabled;

    if (!enabled || !credentials) return c.body(null, 204);

    try {
      const token = await runtime.services.integrations.officialLogin(credentials[0], credentials[1]);

      const response = await runtime.services.integrations.request(
        `${runtime.services.integrations.officialRelay}/api/d-lock-service/device/authenticate`,
        {
          method: 'POST',
          headers: {
            ...runtime.services.integrations.officialHeaders(token),
            'Content-Type': c.req.header('Content-Type') ?? 'application/octet-stream',
            Accept: c.req.header('Accept') ?? '*/*',
          },
          body: new Uint8Array(await c.req.arrayBuffer()),
          signal: AbortSignal.timeout(30_000),
        },
      );

      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
        },
      });
    } catch {
      return c.body(null, 204);
    }
  });
}
