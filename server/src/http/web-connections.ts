import type { Hono } from 'hono';
import { z } from 'zod';
import { ApplicationError } from '#src/errors';
import type { HttpRuntime } from '#src/http/runtime';
import type { WebEnv } from '#src/http/web-app';

const provider = z.enum(['strava', 'garmin', 'intervals']);
const credentials = z.strictObject({ username: z.string().trim().min(1).max(500), secret: z.string().max(10_000) });

export function webConnectionRoutes(app: Hono<WebEnv>, runtime: HttpRuntime) {
  const { management, connections, documents, integrations, uploads } = runtime.services;
  const sessions = management.sessions;
  app.get('/api/me/connections', (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;

    return c.json({
      strava: {
        username: connections.read(player, 'strava')?.[0] ?? '',
        saved: connections.has(player, 'strava'),
        authorized: documents.has(player, 'strava_token.txt'),
        cookie: documents.has(player, 'strava4_session.txt'),
      },
      garmin: {
        username: connections.read(player, 'garmin')?.[0] ?? '',
        saved: connections.has(player, 'garmin'),
        authorized: documents.has(player, 'garth/oauth1_token.json'),
      },
      intervals: {
        username: connections.read(player, 'intervals')?.[0] ?? '',
        saved: connections.has(player, 'intervals'),
      },
    });
  });
  app.put('/api/me/connections/:provider', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;
    const name = provider.parse(c.req.param('provider'));
    const input = credentials.parse(await c.req.json());

    if (name === 'intervals') z.string().regex(/^\d+$/).parse(input.username);
    const secret = input.secret || connections.read(player, name)?.[1];

    if (!secret) throw new ApplicationError(400, 'Enter a secret.');
    connections.save(player, name, [input.username, secret]);

    return c.json({ ok: true });
  });
  app.put('/api/me/connections/strava/cookie', async (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;

    const input = z
      .strictObject({
        cookie: z
          .string()
          .trim()
          .min(1)
          .max(10_000)
          .regex(/^[^\r\n]+$/),
      })
      .parse(await c.req.json());

    documents.put(player, 'strava4_session.txt', input.cookie);

    return c.json({ ok: true });
  });
  app.delete('/api/me/connections/:provider', (c) => {
    const player = sessions.require(c.get('sessionId')).player_id;
    const name = provider.parse(c.req.param('provider'));
    connections.remove(player, name);

    if (name === 'strava') {
      uploads.disconnect(player, 'strava_token.txt');
      uploads.disconnect(player, 'strava4_session.txt');
    } else if (name === 'garmin') uploads.disconnect(player, 'garth/oauth1_token.json');

    return c.json({ ok: true });
  });
  app.post('/api/me/connections/garmin/authorize', async (c) => {
    const id = c.get('sessionId');
    const user = sessions.require(id);
    const identity = runtime.services.accounts.identityOf(user);
    const input = z.strictObject({ code: z.string().min(1).max(32).optional() }).parse(await c.req.json());

    try {
      const status = await integrations.authorizeGarminSession(
        `web:${id}`,
        () => sessions.current(id, identity),
        user,
        input.code,
      );

      return c.json({ status });
    } catch {
      throw new ApplicationError(400, 'Garmin authorization failed or expired. Try again.');
    }
  });
  app.post('/api/me/connections/strava/authorize', async (c) => {
    const id = c.get('sessionId');
    const user = sessions.require(id);
    const identity = runtime.services.accounts.identityOf(user);

    const input = z
      .strictObject({ code: z.string().min(1).max(2000).optional(), state: z.string().optional() })
      .parse(await c.req.json());

    if (input.code) {
      const session = sessions.find(id)!;

      if (!session.stravaState || input.state !== session.stravaState)
        throw new ApplicationError(403, 'Authorization expired.');
      delete session.stravaState;

      try {
        await integrations.authorizeStravaSession(() => sessions.current(id, identity), user, input.code);

        return c.json({ ok: true });
      } catch {
        throw new ApplicationError(400, 'Strava authorization failed. Try again.');
      }
    }

    const client = connections.read(user.player_id, 'strava');

    if (!client) throw new ApplicationError(400, 'Save Strava API credentials first.');
    const redirect = new URL('/settings', runtime.config.network.web.publicUrl ?? c.req.url).href;
    const state = sessions.token();
    sessions.find(id)!.stravaState = state;

    return c.json({ url: integrations.authorizationUrl(client[0], state, redirect) });
  });
}
