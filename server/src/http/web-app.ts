import { effectRoutes } from '#src/http/effect';
import { RecordsService } from '#src/services/records.service';
import { webConnectionRoutes } from '#src/http/web-connections';
import { webProfileRoutes } from '#src/http/web-profile';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Effect, Schema } from 'effect';
import { fieldErrors, NumberFromInput, Strict } from '#src/schema';
import { ApplicationError, UnreadableCredentialsError } from '#src/errors';
import { credentials, password, newUser } from '#src/dtos/management.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { climbFacts, readClimbSegments, readClimbs } from '#src/http/climbs';
import { peerAddress } from '#src/http/routes/accounts';
import { WORLD_TIME_EPOCH_MS } from '#src/world/state';
import { resolve } from 'node:path';
import { packageRoot, packageVersion, supportedZwiftVersion } from '#src/config/load';

export type WebEnv = { Variables: { sessionId: string; csrf: string } };

/** Matches the public URL exactly, or else the host only: a TLS proxy forwards https requests over http. */
function sameOrigin(origin: string | undefined, url: string, publicUrl: string | null) {
  if (publicUrl) return origin === publicUrl;

  try {
    return !!origin && new URL(origin).host === new URL(url).host;
  } catch {
    return false;
  }
}

export function createWebApp(runtime: HttpRuntime) {
  const app = new Hono<WebEnv>();
  const { management, accounts, durability, files, activities } = runtime.services;
  const { sessions } = management;
  const attempts = new Map<string, { count: number; until: number }>();
  const cookie = 'zluggish_web_session';
  const csrfCookie = 'zluggish_web_csrf';
  const { publicUrl } = runtime.config.network.web;

  const cookieOptions = (c: Context<WebEnv>) => ({
    httpOnly: true,
    sameSite: 'Lax' as const,
    path: '/',
    secure: new URL(publicUrl ?? c.req.url).protocol === 'https:',
    maxAge: 86_400,
  });

  // A pre-authentication request fails if the caller's session changed while the password work ran.
  const unchanged = (c: Context<WebEnv>) => {
    const id = c.get('sessionId');
    const before = id ? sessions.sessions.get(id) : undefined;

    return () => !id || sessions.sessions.get(id) === before;
  };

  app.use('*', async (c, next) => {
    const upload = c.req.method === 'POST' && c.req.path === '/api/me/import';

    const avatar =
      c.req.method === 'PUT' &&
      (c.req.path === '/api/me/avatar' || /^\/api\/manage\/users\/\d+\/avatar$/.test(c.req.path));

    return bodyLimit({ maxSize: upload ? 81 * 1024 * 1024 : avatar ? 2 * 1024 * 1024 : 64 * 1024 })(c, next);
  });
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    const before = durability.changes();
    await next();

    if (durability.changes() !== before) await durability.flush();
  });
  app.get('/health', (c) => c.json({ name: 'zluggish', version: packageVersion(), status: 'ok' }));

  app.use('/api/*', async (c, next) => {
    // This listener accepts only its own opaque session store. Bearer tokens are never used.
    const id = getCookie(c, cookie);
    const session = sessions.find(id);
    let token = session?.csrf ?? getCookie(c, csrfCookie);

    // Anonymous requests get a double-submit token and allocate nothing on the server.
    if (!session && !/^[\w-]{43}$/.test(token ?? '')) {
      token = sessions.token();
      setCookie(c, csrfCookie, token, cookieOptions(c));
    }

    c.set('sessionId', session ? id! : '');
    c.set('csrf', token!);

    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (!sameOrigin(c.req.header('Origin'), c.req.url, publicUrl) || c.req.header('X-CSRF-Token') !== c.get('csrf'))
        throw new ApplicationError({ status: 403, message: 'Reload the page and retry.' });

      if (
        !(c.req.method === 'POST' && c.req.path === '/api/me/import'
          ? c.req.header('Content-Type')?.startsWith('multipart/form-data;')
          : c.req.method === 'PUT' &&
              (c.req.path === '/api/me/avatar' || /^\/api\/manage\/users\/\d+\/avatar$/.test(c.req.path))
            ? c.req.header('Content-Type') === 'image/jpeg'
            : c.req.header('Content-Type')?.startsWith('application/json'))
      )
        throw new ApplicationError({ status: 400, message: 'JSON required.' });
    }

    if (
      ['/api/setup', '/api/setup/key', '/api/session', '/api/session/confirm'].includes(c.req.path) &&
      c.req.method === 'POST'
    ) {
      const now = Date.now();

      for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
      const key = peerAddress(c);
      const limit = attempts.get(key) ?? { count: 0, until: now + 60_000 };

      if (limit.count >= 10 || attempts.size >= 10_000) return c.json({ message: 'Try again shortly.' }, 429);
      limit.count++;
      attempts.set(key, limit);
    }

    await next();
  });

  function login(c: Context<WebEnv>, user: NonNullable<ReturnType<typeof accounts.get>>, confirmed = false) {
    sessions.end(c.get('sessionId'));
    const fresh = sessions.create(accounts.identityOf(user), confirmed ? Date.now() + 900_000 : 0);
    setCookie(c, cookie, fresh.id, cookieOptions(c));

    return c.json({ user: management.publicUser(user), csrf: fresh.session.csrf });
  }

  app.get('/api/setup', (c) =>
    c.json({
      complete: management.store.complete(),
      csrf: c.get('csrf'),
      version: packageVersion(),
      zwiftVersion: supportedZwiftVersion(),
    }),
  );
  app.post('/api/setup', async (c) => {
    const user = await management.setup(await c.req.json(), unchanged(c));

    return login(c, user, true);
  });
  app.post('/api/setup/key', async (c) => {
    const input = Schema.decodeUnknownSync(Strict({ key: Schema.String.check(Schema.isMaxLength(200)) }))(
      await c.req.json(),
    );

    management.checkSetupKey(input.key);

    return c.json({
      users: accounts.list().map(({ player_id, username, first_name, last_name, enabled, pass_hash }) => ({
        player_id,
        username,
        first_name,
        last_name,
        enabled,
        has_password: !!pass_hash,
      })),
    });
  });
  app.post('/api/session', async (c) => {
    const input = Schema.decodeUnknownSync(credentials)(await c.req.json());
    const live = unchanged(c);
    const user = await management.signIn(input.username, input.password);

    if (!live()) throw new ApplicationError({ status: 401, message: 'Session changed.' });

    return login(c, user);
  });
  app.delete('/api/session', (c) => {
    sessions.end(c.get('sessionId'));
    deleteCookie(c, cookie, { path: '/' });

    return c.json({ ok: true });
  });
  app.get('/api/me', (c) =>
    c.json({ user: management.publicUser(sessions.require(c.get('sessionId'))), csrf: c.get('csrf') }),
  );
  app.post('/api/session/confirm', async (c) => {
    const input = Schema.decodeUnknownSync(Strict({ password }))(await c.req.json());
    await management.confirm(c.get('sessionId'), input.password);

    return c.json({ confirmedUntil: sessions.find(c.get('sessionId'))!.confirmedUntil });
  });
  app.post('/api/me/password', async (c) => {
    const input = Schema.decodeUnknownSync(Strict({ current_password: Schema.optional(password), password }))(
      await c.req.json(),
    );

    await management.changeOwnPassword(c.get('sessionId'), input.current_password, input.password);
    sessions.end(c.get('sessionId'));

    return c.json({ ok: true });
  });
  app.get('/api/me/profile', (c) => c.json(management.ownProfile(c.get('sessionId'))));
  app.patch('/api/me/profile', async (c) => c.json(management.editOwnProfile(c.get('sessionId'), await c.req.json())));
  app.get('/api/me/avatar', (c) => {
    const path = management.avatarPath(sessions.require(c.get('sessionId')).player_id);

    if (!files.exists(path)) throw new ApplicationError({ status: 404, message: 'No photo.' });

    return c.body(new Uint8Array(files.read(path)), 200, { 'Content-Type': 'image/jpeg' });
  });
  app.put('/api/me/avatar', async (c) =>
    c.json(management.saveAvatar(c.get('sessionId'), new Uint8Array(await c.req.arrayBuffer()))),
  );
  app.delete('/api/me/avatar', (c) => c.json(management.removeAvatar(c.get('sessionId'))));
  app.get('/api/me/settings', (c) => c.json(management.settings(sessions.require(c.get('sessionId')).player_id)));
  app.patch('/api/me/settings', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;

    return c.json(management.saveSettings(c.get('sessionId'), player, await c.req.json()));
  });
  webConnectionRoutes(app, runtime);
  webProfileRoutes(app, runtime);

  const activityId = Schema.String.check(Schema.isPattern(/^\d{1,19}$/));
  app.get('/api/me/activities', (c) => {
    const page = Schema.decodeUnknownSync(
      NumberFromInput.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
    )(c.req.query('page') ?? '0');

    const rows = activities.own(sessions.require(c.get('sessionId')).player_id, undefined, page);

    return c.json({ activities: rows.slice(0, 20), hasMore: rows.length > 20 });
  });
  const appRoutes = effectRoutes(app, runtime);
  appRoutes.get('/api/me/climbs', (c) =>
    Effect.gen(function* () {
      const recordsService = yield* RecordsService;

      const stats = new Map(
        (yield* recordsService.climbPortalStats(sessions.require(c.get('sessionId')).player_id)).map((row) => [
          String(row.route_hash),
          row,
        ]),
      );

      const climbs = [];
      const segments = readClimbSegments(runtime);
      const all = readClimbs(runtime);

      for (const climb of all) {
        const row = stats.get(climb.road);

        if (row)
          climbs.push({
            road: climb.road,
            ...climbFacts(climb.name),
            rides: row.rides,
            bestMs: row.best_ms,
            strava: segments[climb.road] ?? null,
            lastRide:
              row.last_world_time === null ? null : new Date(row.last_world_time + WORLD_TIME_EPOCH_MS).toISOString(),
          });
      }

      return c.json({ climbs, total: all.length });
    }),
  );
  app.get('/api/me/activities/:id', (c) =>
    c.json(
      activities.ownDetail(
        sessions.require(c.get('sessionId')).player_id,
        Schema.decodeUnknownSync(activityId)(c.req.param('id')),
      ),
    ),
  );
  app.get('/api/me/activities/:id/fit', (c) => {
    const { fit, filename } = activities.ownFit(
      sessions.require(c.get('sessionId')).player_id,
      Schema.decodeUnknownSync(activityId)(c.req.param('id')),
    );

    return c.body(new Uint8Array(fit), 200, {
      'Content-Type': 'application/vnd.ant.fit',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
  });
  app.get('/api/me/activities/:id/images/:image', (c) => {
    const id = Schema.decodeUnknownSync(activityId)(c.req.param('id'));

    const image = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(
      c.req.param('image'),
    );

    const jpg = activities.ownImage(sessions.require(c.get('sessionId')).player_id, id, image);

    return c.body(jpg, 200, {
      'Content-Type': 'image/jpeg',
      ...(c.req.query('download') !== undefined && {
        'Content-Disposition': `attachment; filename="${id}-${image}.jpg"`,
      }),
    });
  });
  app.use('/api/manage/*', async (c, next) => {
    sessions.require(c.get('sessionId'), true);
    await next();
  });
  app.get('/api/manage/users', (c) => c.json({ users: accounts.list().map((user) => management.publicUser(user)) }));
  app.post('/api/manage/users', async (c) => {
    const input = Schema.decodeUnknownSync(
      Strict({ operation: Schema.String.check(Schema.isUUID()), user: Schema.Record(Schema.String, Schema.Json) }),
    )(await c.req.json());

    return c.json(
      await management.create(c.get('sessionId'), Schema.decodeUnknownSync(newUser)(input.user), input.operation),
      201,
    );
  });
  app.get('/api/manage/users/:id', (c) => {
    const user = accounts.get(
      Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
    );

    if (!user) throw new ApplicationError({ status: 404, message: 'User not found.' });

    return c.json(management.publicUser(user));
  });

  app.get('/api/manage/users/:id/profile', (c) =>
    c.json(
      management.ownProfile(
        c.get('sessionId'),
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
      ),
    ),
  );
  app.patch('/api/manage/users/:id/profile', async (c) =>
    c.json(
      management.editOwnProfile(
        c.get('sessionId'),
        await c.req.json(),
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
      ),
    ),
  );
  app.put('/api/manage/users/:id/avatar', async (c) =>
    c.json(
      management.saveAvatar(
        c.get('sessionId'),
        new Uint8Array(await c.req.arrayBuffer()),
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
      ),
    ),
  );
  app.delete('/api/manage/users/:id/avatar', (c) =>
    c.json(
      management.removeAvatar(
        c.get('sessionId'),
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
      ),
    ),
  );

  app.get('/api/manage/users/:id/avatar', (c) => {
    const id = Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(
      c.req.param('id'),
    );

    const path = management.avatarPath(id);

    if (!accounts.get(id) || !files.exists(path)) throw new ApplicationError({ status: 404, message: 'No photo.' });

    return c.body(new Uint8Array(files.read(path)), 200, { 'Content-Type': 'image/jpeg' });
  });

  for (const action of ['password', 'disable', 'enable', 'revoke-sessions', 'role'])
    app.on(action === 'role' ? 'PUT' : 'POST', `/api/manage/users/:id/${action}`, async (c) =>
      c.json(
        await management.mutate(
          c.get('sessionId'),
          Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
          action,
          await c.req.json(),
        ),
      ),
    );

  app.patch('/api/manage/users/:id', async (c) =>
    c.json(
      management.edit(
        c.get('sessionId'),
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
        await c.req.json(),
      ),
    ),
  );
  app.get('/api/manage/users/:id/settings', (c) =>
    c.json(
      management.settings(
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
      ),
    ),
  );
  app.patch('/api/manage/users/:id/settings', async (c) =>
    c.json(
      management.saveSettings(
        c.get('sessionId'),
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
        await c.req.json(),
        true,
      ),
    ),
  );
  app.get('/api/manage/settings', (c) =>
    c.json({
      configuration: management.configuration({
        network: runtime.config.network,
        riderDefaults: runtime.config.riderDefaults,
      }),
      worldSettings: management.worldSettings(),
      readOnly: true,
    }),
  );

  for (const action of ['reload-bots', 'bots'])
    app.post(`/api/manage/server/${action}`, async (c) =>
      c.json(
        await management.serverOperation(c.get('sessionId'), action, await c.req.json(), () => durability.flush(), {
          reload: async () => {
            await runtime.world.simulation?.reload();
          },
          bots: (user, command) =>
            runtime.world.simulation?.command(BigInt(user), command, true) ?? 'Bots are not running.',
        }),
      ),
    );

  app.patch('/api/manage/settings', async (c) => c.json(management.saveWorld(c.get('sessionId'), await c.req.json())));
  app.get('/api/manage/events', (c) => c.json({ events: management.events() }));
  app.on(['PATCH', 'DELETE'], '/api/manage/events/:id', async (c) =>
    c.json(
      management.editEvent(
        c.get('sessionId'),
        Schema.decodeUnknownSync(NumberFromInput.check(Schema.isInt(), Schema.isGreaterThan(0)))(c.req.param('id')),
        c.req.method === 'DELETE' ? 'delete-event' : 'edit-event',
        await c.req.json(),
      ),
    ),
  );
  const clientRoot = resolve(packageRoot(), '../web/dist/app');
  app.get('/assets/:file', (c) => {
    const name = c.req.param('file');

    if (!/^[\w.-]+\.(?:js|css|woff2|png|jpg|svg)$/.test(name)) return c.notFound();
    const path = resolve(clientRoot, 'assets', name);

    if (!files.exists(path)) return c.notFound();
    const ext = name.split('.').at(-1)!;

    const types = {
      js: 'text/javascript',
      css: 'text/css',
      woff2: 'font/woff2',
      png: 'image/png',
      jpg: 'image/jpeg',
      svg: 'image/svg+xml',
    };

    // SAFETY: the filename extension was restricted to these MIME types above.
    return c.body(files.read(path), 200, { 'Content-Type': types[ext as keyof typeof types]! });
  });

  for (const path of [
    '/',
    '/setup',
    '/sign-in',
    '/settings',
    '/profile/:id',
    '/integrations',
    '/import',
    '/import/*',
    '/export',
    '/zwift',
    '/activities',
    '/activities/*',
    '/climbs',
    '/manage',
    '/manage/*',
  ])
    app.get(path, (c) => {
      const index = resolve(clientRoot, 'index.html');

      return files.exists(index)
        ? c.html(files.read(index, 'utf8'))
        : c.text('Build the web app before starting.', 503);
    });
  app.onError((error, c) => {
    if (Schema.isSchemaError(error))
      return c.json({ message: 'Check the form fields.', fieldErrors: fieldErrors(error) }, 400);

    if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);

    if (error instanceof ApplicationError) return c.json({ message: error.message }, error.status);

    const route = c.req.routePath === '*' ? 'unmatched' : c.req.routePath;

    if (error instanceof UnreadableCredentialsError) {
      runtime.world.lifecycle.log.warn('connections.unreadable', 'Saved credentials cannot be decrypted', {
        method: c.req.method,
        route,
        error,
      });

      return c.json({ message: 'The saved credentials cannot be read. Enter them again in Integrations.' }, 409);
    }

    runtime.world.lifecycle.log.error('web.failed', 'Web request failed unexpectedly', {
      method: c.req.method,
      route,
      error: error instanceof Error ? error : String(error),
    });

    return c.json({ message: 'The server hit an unexpected error. The server log has the details.' }, 500);
  });

  return app;
}
