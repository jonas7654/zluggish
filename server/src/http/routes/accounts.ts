import { checkbox, field, form as makeForm, hidden, model, secret } from '#src/http/launcher/models';
import { launcherPage } from '#src/http/launcher/render';
import { browserJson, launcherRedirect } from '#src/http/launcher/results';
import { climbSchema, createUserSchema } from '#src/dtos/accounts.dto';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

export function authenticated(c: Context<RuntimeEnv>) {
  const rider = c.get('rider');

  if (!rider) throw new HTTPException(401);

  return rider;
}

function riderName(user: { first_name: string; last_name: string }) {
  return `${user.first_name} ${user.last_name}`.trim();
}

// The password step shown after choosing a protected rider.
function unlockPage(
  c: Context<RuntimeEnv>,
  user: { player_id: number; first_name: string; last_name: string },
  error = '',
) {
  return model(
    c,
    'unlock',
    riderName(user),
    [
      makeForm(
        'unlock',
        '/login/',
        [
          hidden('player_id', String(user.player_id)),
          hidden('step', 'password'),
          field('password', 'Password', {
            type: 'password',
            required: true,
            autocomplete: 'current-password',
            autofocus: true,
          }),
        ],
        'Sign in',
        { primary: true },
      ),
    ],
    { message: error, failed: !!error, links: [{ href: '/login/', label: 'Choose another rider' }] },
  );
}

type FormFields = Record<string, string | File | (string | File)[]>;

export async function csrf(c: Context<RuntimeEnv>, runtime: Runtime): Promise<FormFields> {
  const form = await c.req.parseBody();

  if (!runtime.services.sessions.validCsrf(c.get('browser'), z.string().catch('').parse(form.csrf_token)))
    throw new HTTPException(400, {
      message: 'The form expired. Reload and retry.',
    });

  return z
    .record(z.string(), z.union([z.string(), z.instanceof(File), z.array(z.union([z.string(), z.instanceof(File)]))]))
    .parse(form);
}

export function peerAddress(c: Context<RuntimeEnv>) {
  try {
    return getConnInfo(c).remote.address ?? '';
  } catch {
    return '';
  }
}

export function accountRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const { accounts, sessions } = runtime.services;
  const { world } = runtime;
  app.use('*', async (c, next) => {
    const authorization = c.req.header('Authorization');
    const existing = getCookie(c, 'zluggish_session');

    const browserPage =
      !/^\/(?:api|relay|health|download|uploads|style|static|mochi|gameassets|experimentation|live-segment-results-service|player-playback)(?:\/|$)/.test(
        c.req.path,
      );

    const passive = c.req.path.startsWith('/ui/status/');
    const previous = existing ? sessions.browsers.get(existing) : undefined;
    const live = previous !== undefined && Date.now() - previous.touched <= 86_400_000;

    const persistent =
      !authorization &&
      !c.req.path.startsWith('/static/launcher-ui/') &&
      (passive ? live : browserPage || (existing !== undefined && sessions.browsers.has(existing)));

    const opened = persistent
      ? sessions.open(existing)
      : {
          id: '',
          session: {
            csrf: '',
            identity: null,
            selected: false,
            pendingImport: null,
            touched: Date.now(),
          },
        };

    c.set('browser', opened.session);
    c.set('browserId', opened.id);

    if (persistent && existing !== opened.id)
      setCookie(c, 'zluggish_session', opened.id, {
        httpOnly: true,
        sameSite: 'Lax',
        secure: c.req.url.startsWith('https:'),
        path: '/',
        maxAge: 86_400,
      });
    c.set(
      'rider',
      authorization ? sessions.bearer(authorization.replace(/^Bearer /i, '')) : sessions.rider(opened.session),
    );

    if (authorization && !c.get('rider')) throw new HTTPException(401);

    if (browserPage || browserJson(c)) c.header('Cache-Control', 'no-store');
    const context = c.req.header('X-Launcher-Context');

    if (browserJson(c) && context && context !== c.get('browser').csrf)
      throw new HTTPException(c.get('rider') ? 409 : 401, {
        message: 'Your session or rider changed. Reload and retry.',
      });
    await next();
  });

  app.get('/', (c) => launcherRedirect(c, '/login/'));
  app.on(['GET', 'POST'], '/signup/', (c) => launcherRedirect(c, '/riders/add/'));
  app.on(['GET', 'POST'], '/login/', async (c) => {
    const session = c.get('browser');
    sessions.transition(session, { type: 'clear-selection' });

    if (!accounts.setupComplete()) return launcherRedirect(c, '/riders/add/');
    let error = '';

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      const id = z.coerce.number().int().positive().safe().safeParse(form.player_id);

      const user = id.success ? accounts.get(id.data) : null;
      const password = z.string().catch('').parse(form.password);
      const unlocking = form.step === 'password';

      // Choosing a protected rider opens its password step instead of failing.
      if (user?.pass_hash && !unlocking) return launcherPage(c, runtime, unlockPage(c, user));

      if (user && (!user.pass_hash || (await accounts.verify(user, password)))) {
        if (sessions.browsers.get(c.get('browserId')) !== session) throw new HTTPException(401);
        sessions.end(c.get('browserId'));
        const fresh = sessions.open();
        sessions.transition(fresh.session, { type: 'login', identity: runtime.services.accounts.identityOf(user) });
        setCookie(c, 'zluggish_session', fresh.id, {
          httpOnly: true,
          sameSite: 'Lax',
          secure: c.req.url.startsWith('https:'),
          path: '/',
          maxAge: 86_400,
        });

        runtime.world.lifecycle.log.info('auth.login_succeeded', 'User logged in', {
          playerId: user.player_id,
          flow: 'browser',
        });

        return launcherRedirect(c, `/user/${encodeURIComponent(user.username)}/`);
      }

      runtime.world.lifecycle.diagnostic('auth.login_failed', 'Login rejected', true);

      if (user && unlocking) return launcherPage(c, runtime, unlockPage(c, user, 'Wrong password. Try again.'));
      error = 'That rider no longer exists. Choose another rider.';
    }

    return launcherPage(
      c,
      runtime,
      model(
        c,
        'login',
        'Who’s riding?',
        accounts.list().map((user) =>
          makeForm(
            `rider-${user.player_id}`,
            '/login/',
            [hidden('player_id', String(user.player_id))],
            riderName(user),
            {
              rider: {
                initials: `${user.first_name.charAt(0)}${user.last_name.charAt(0)}`.toUpperCase(),
                photo: runtime.services.files.exists(
                  resolve(runtime.services.profiles.folder(user.player_id), 'avatarLarge.jpg'),
                )
                  ? `/download/${user.player_id}/avatarLarge.jpg`
                  : null,
                locked: !!user.pass_hash,
              },
            },
          ),
        ),
        { message: error, failed: !!error, links: [{ href: '/riders/add/', label: 'Add rider' }] },
      ),
    );
  });

  app.on(['GET', 'POST'], '/riders/add/', async (c) => {
    const first = !accounts.setupComplete();
    const current = c.get('rider');

    if (!first && !runtime.config.accounts.allowSelfRegistration && !current?.is_admin) throw new HTTPException(403);
    let error = '';

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      const password = z.string().catch('').parse(form.password);

      if (password === z.string().catch('').parse(form.confirm_password)) {
        await accounts.create(z.string().parse(form.display_name), password, first);

        return launcherRedirect(c, '/login/');
      }

      error = 'Passwords did not match.';
    }

    return launcherPage(
      c,
      runtime,
      model(
        c,
        'add',
        'Add rider',
        [
          makeForm(
            'add-rider',
            '/riders/add/',
            [
              field('display_name', 'Name', { value: first ? 'zluggish' : '', maxLength: 100, required: true }),
              secret('password', 'Optional password'),
              field('confirm_password', 'Confirm password', {
                type: 'password',
                matches: 'password',
                autocomplete: 'new-password',
              }),
            ],
            'Create rider',
            { primary: true },
          ),
        ],
        { message: error, failed: !!error, links: first ? [] : [{ href: '/login/', label: 'Cancel' }] },
      ),
    );
  });

  app.post('/riders/switch/', async (c) => {
    await csrf(c, runtime);
    sessions.end(c.get('browserId'));
    deleteCookie(c, 'zluggish_session', { path: '/' });

    return launcherRedirect(c, '/login/');
  });

  app.on(['GET', 'POST'], '/user/:username/', async (c) => {
    const user = authenticated(c);

    if (c.req.method === 'POST') {
      await csrf(c, runtime);
      void runtime.services.uploads.retry(user.player_id);

      return launcherPage(
        c,
        runtime,
        model(c, 'message', 'Activity uploads', [], {
          message: 'Retry requested. Check the provider before retrying again.',
          uploads: runtime.services.uploads.status(user.player_id).slice(0, 100),
        }),
        `/user/${user.username}/`,
      );
    }

    await runtime.services.workouts.syncWorkoutsAutomatically(user.player_id);

    const climbs = z
      .array(climbSchema)
      .parse(JSON.parse(runtime.services.files.read(resolve(runtime.assets, 'data/climbs.txt'), 'utf8')));

    const settings = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(user.player_id),
    );

    return launcherPage(
      c,
      runtime,
      model(
        c,
        'dashboard',
        `${user.first_name} ${user.last_name}`,
        [
          makeForm('retry-uploads', `/user/${user.username}/`, [], 'Retry failed uploads'),
          makeForm(
            'launch',
            '/start-zwift',
            [
              field('map', 'Map', {
                type: 'select',
                value: 'CALENDAR',
                options: [
                  { value: 'CALENDAR', label: 'Calendar' },
                  ...[
                    [2, 'Richmond'],
                    [6, 'Watopia'],
                    [7, 'London'],
                    [8, 'New York'],
                    [9, 'Innsbruck'],
                    [11, 'Yorkshire'],
                    [13, 'Makuri Islands'],
                    [14, 'France'],
                    [15, 'Paris'],
                    [17, 'Scotland'],
                  ].map(([id, name]) => ({ value: String(id), label: String(name) })),
                ],
              }),
              field('climb', 'Climb', {
                type: 'select',
                value: 'CALENDAR',
                options: [
                  { value: 'CALENDAR', label: 'Calendar' },
                  ...climbs.map((climb) => ({ value: climb.road, label: climb.name })),
                ],
              }),
              checkbox('enableghosts', 'Enable ghosts', settings.ghosts.enabled),
            ],
            'Start Zwift',
            { navigation: true, primary: true },
          ),
          makeForm('switch', '/riders/switch/', [], 'Switch rider'),
          ...(user.is_admin
            ? [
                makeForm('restart', '/restart', [], 'Restart with countdown', {
                  title: 'Server',
                  confirmation: 'Schedule a server restart? Riders will be disconnected when the countdown ends.',
                }),
                makeForm('cancel-restart', '/cancelrestart', [], 'Cancel restart'),
                makeForm('reload-bots', '/reloadbots', [], 'Reload bots', { confirmation: 'Reload server bots?' }),
              ]
            : []),
        ],
        {
          uploads: runtime.services.uploads.status(user.player_id).slice(0, 100),
          paragraphs: [
            'Check the provider before retrying a failed upload: it may have received the activity before the connection failed.',
          ],
          links: [
            ['profile', 'Profile'],
            ['zwift', 'Zwift connection'],
            ['reset', 'Password'],
            ['settings', 'Settings'],
            ['strava', 'Strava'],
            ['garmin', 'Garmin'],
            ['intervals', 'Intervals.icu'],
            ['trainingpeaks', 'TrainingPeaks'],
            ['power_curves', 'Power curves'],
          ].map(([path, label]) => ({ href: `/${path}/${encodeURIComponent(user.username)}/`, label: label! })),
        },
      ),
    );
  });

  app.on(['GET', 'POST'], '/reset/:username/', async (c) => {
    const user = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      if (user.pass_hash && !(await accounts.verify(user, z.string().catch('').parse(form.current_password))))
        throw new HTTPException(403);

      if (!sessions.current(c.get('browserId'), c.get('browser'), accounts.identityOf(user)))
        throw new HTTPException(401);
      const password = form.remove_password === 'on' ? null : z.string().min(1).parse(form.password);

      if (password !== null && password !== form.confirm_password) throw new HTTPException(400);

      await accounts.changePassword(user.player_id, password);
      sessions.end(c.get('browserId'));

      return launcherRedirect(c, '/login/');
    }

    return launcherPage(
      c,
      runtime,
      model(
        c,
        'password',
        'Local password',
        [
          makeForm(
            'password',
            `/reset/${user.username}/`,
            [
              ...(user.pass_hash
                ? [
                    field('current_password', 'Current password', {
                      type: 'password',
                      required: true,
                      autocomplete: 'current-password',
                    }),
                  ]
                : []),
              checkbox('remove_password', 'Remove password'),
              field('password', 'New password', {
                type: 'password',
                required: true,
                when: { field: 'remove_password', value: false },
                autocomplete: 'new-password',
              }),
              field('confirm_password', 'Confirm password', {
                type: 'password',
                matches: 'password',
                when: { field: 'remove_password', value: false },
                autocomplete: 'new-password',
              }),
            ],
            'Save',
          ),
        ],
        {
          paragraphs: [
            'Removing the password allows anyone with server access to select this rider. Saving ends your session.',
          ],
        },
      ),
    );
  });

  app.get('/ui/status/session', (c) => {
    if (!c.get('browserId')) throw new HTTPException(401);
    c.header('Cache-Control', 'no-store');

    return c.body(null, 204);
  });

  app.get('/ui/status/uploads', (c) => {
    const rider = authenticated(c);

    if (!c.get('browserId')) throw new HTTPException(401);
    c.header('Cache-Control', 'no-store');

    return c.json({ jobs: runtime.services.uploads.status(rider.player_id).slice(0, 100) });
  });

  const launchAliases = [
    '/launcher',
    '/launcher/ride',
    '/launcher/realms/zwift/protocol/openid-connect/auth',
    '/launcher/realms/zwift/protocol/openid-connect/registrations',
    '/auth/realms/zwift/protocol/openid-connect/auth',
    '/auth/realms/zwift/login-actions/request/login',
    '/auth/realms/zwift/protocol/openid-connect/registrations',
    '/auth/realms/zwift/login-actions/startriding',
    '/auth/realms/zwift/tokens/login',
    '/auth/realms/zwift/tokens/registrations',
    '/ride',
  ];

  app.on(['GET', 'POST'], launchAliases, (c) => {
    const user = c.get('rider');

    if (c.req.path !== '/ride' || !user || !c.get('browser').selected) {
      sessions.transition(c.get('browser'), { type: 'clear-selection' });

      return c.redirect('/login/');
    }

    if (world.active(user.player_id)) throw new HTTPException(409);

    return c.redirect(
      `http://zwift/?code=zwift_refresh_token${sessions.token(runtime.services.accounts.identityOf(user), runtime.tokens.refresh)}`,
    );
  });

  app.post('/start-zwift', async (c) => {
    const user = authenticated(c);
    const form = await csrf(c, runtime);

    if (!c.get('browser').selected) return c.redirect('/login/');

    if (world.active(user.player_id)) throw new HTTPException(409);

    runtime.services.settings.save(user.player_id, {
      ...runtime.services.settings.read(user.player_id),
      'ghosts.enabled': form.enableghosts !== undefined,
    });
    const address = peerAddress(c);

    if (form.map && form.map !== 'CALENDAR') world.mapOverrides.set(address, z.string().parse(form.map));
    else if (form.map === 'CALENDAR') world.mapOverrides.delete(address);

    if (form.climb && form.climb !== 'CALENDAR') world.climbOverrides.set(address, z.string().parse(form.climb));
    else if (form.climb === 'CALENDAR') world.climbOverrides.delete(address);

    return c.redirect('/ride');
  });

  app.post('/auth/realms/zwift/protocol/openid-connect/token', async (c) => {
    const form = await c.req.parseBody();
    let user;

    if (form.username) {
      user = accounts.byUsername(z.string().parse(form.username));

      if (!user || !(await accounts.verify(user, z.string().catch('').parse(form.password)))) {
        runtime.world.lifecycle.diagnostic('auth.login_failed', 'Login rejected', true);
        throw new HTTPException(401);
      }
    } else {
      const token = form.code ? z.string().parse(form.code) : z.string().parse(form.refresh_token);

      if (form.code && !token.startsWith('zwift_refresh_token')) throw new HTTPException(401);

      user = sessions.bearer(form.code ? token.slice(19) : token);

      if (!user) throw new HTTPException(401);
    }

    const result = sessions.tokens(user, runtime.tokens);

    if (form.username)
      runtime.world.lifecycle.log.info('auth.login_succeeded', 'User logged in', {
        playerId: user.player_id,
        flow: 'credentials',
      });
    else
      runtime.world.lifecycle.log.verbose('auth.token_exchanged', 'Authentication token exchanged', {
        playerId: user.player_id,
      });

    return c.json(result);
  });

  app.post('/api/users', async (c) => {
    if (!accounts.setupComplete() || !runtime.config.accounts.allowSelfRegistration) throw new HTTPException(403);

    const input = createUserSchema.parse(await c.req.json());

    try {
      await accounts.create(`${input.profile.firstName} ${input.profile.lastName}`, input.password, false, input.email);
    } catch {
      throw new HTTPException(400);
    }

    return c.body(null, 200);
  });
  app.post('/api/users/password-reset/', async (c) => {
    const user = authenticated(c);

    const form = c.req.header('Authorization') ? await c.req.parseBody() : await csrf(c, runtime);

    if (user.pass_hash && !(await accounts.verify(user, z.string().catch('').parse(form.current_password))))
      throw new HTTPException(403);
    const password = z.string().min(1).parse(form['password-new']);

    if (password !== form['password-confirm']) throw new HTTPException(400);

    await accounts.changePassword(user.player_id, password);
    sessions.end(c.get('browserId'));

    return c.body(null, 204);
  });
  app.get('/logout/:username', (c) => {
    const user = c.get('rider');

    if (user) runtime.world.lifecycle.log.info('auth.logout', 'User logged out', { playerId: user.player_id });
    sessions.end(c.get('browserId'));

    return c.redirect('/login/');
  });

  app.post('/auth/realms/zwift/protocol/openid-connect/logout', (c) => {
    sessions.end(c.get('browserId'));

    return c.body(null, 204);
  });
  app.post('/auth/rb_bf03269xbi', (c) => c.text('OK(Java)'));
}
