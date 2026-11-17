import { gameUrls } from '#src/http/game/urls';
import { parseProtobuf } from '#src/http/protobuf';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import {
  ActivityImageSchema,
  ActivityListSchema,
  ActivityMediaSaveRequestSchema,
  ActivityMediaSaveResultSchema,
  ActivitySchema,
} from '#src/protocol/generated/activity_pb';
import { create, toBinary } from '@bufbuild/protobuf';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export function activityRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const service = runtime.services.activities;

  const records = runtime.services.recordData;

  app.on(['GET', 'POST'], ['/api/profiles/:id/activities', '/api/profiles/:id/activities/'], async (c) => {
    const user = authenticated(c);
    const id = BigInt(c.req.param('id'));

    if (c.req.method === 'POST') {
      if (id !== BigInt(user.player_id)) throw new HTTPException(401);

      const activity = parseProtobuf(ActivitySchema, new Uint8Array(await c.req.arrayBuffer()));

      if (!runtime.services.accounts.identity(runtime.services.accounts.identityOf(user))) throw new HTTPException(401);
      activity.playerId = id;

      if (!activity.date) activity.date = new Date().toISOString();

      const activityId = records.insert('activity', ActivitySchema, activity, ['fit']);
      runtime.services.rideCompletion.register(user.player_id, BigInt(activityId), c.req.header('Authorization') ?? '');

      return c.body(JSON.stringify({ id: Number(activityId) }), 200, {
        'Content-Type': 'text/html; charset=utf-8',
      });
    }

    return c.body(
      toBinary(
        ActivityListSchema,
        create(ActivityListSchema, {
          activities: (() => {
            return service
              .recentActivities(id, user.player_id)
              .map((row) => service.forViewer(records.decode(ActivitySchema, row), user.player_id));
          })(),
        }),
      ),
    );
  });

  app.on(['PUT', 'DELETE'], '/api/profiles/:id/activities/:activityId', async (c) => {
    const user = authenticated(c);
    const id = BigInt(c.req.param('activityId'));

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    if (c.req.header('Source') === 'zwift-companion') throw new HTTPException(400);

    if (!service.findActivity(id, user.player_id)) throw new HTTPException(404);

    if (c.req.method === 'DELETE') {
      service.deleteActivity(id, user.player_id);
      runtime.world.logout(BigInt(user.player_id), 'activity_finished');

      return c.text('true');
    }

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const activity = parseProtobuf(ActivitySchema, bytes);
    activity.playerId = BigInt(user.player_id);
    activity.id = id;

    const finish = c.req.query('upload-to-strava') === 'true';

    const outcome = await service.saveInTurn(activity, finish, () => {
      if (!runtime.services.accounts.identity(runtime.services.accounts.identityOf(user))) throw new HTTPException(401);
    });

    if (finish && outcome !== 'unchanged') runtime.world.logout(BigInt(user.player_id), 'activity_finished');

    return c.body(JSON.stringify({ id: Number(id) }), 200, {
      'Content-Type': 'text/html; charset=utf-8',
    });
  });

  app.get('/api/activities/:activityId', (c) => {
    const user = authenticated(c);

    const row = service.activityById(c.req.param('activityId'));

    if (!row) throw new HTTPException(404);
    const activity = service.forViewer(records.decode(ActivitySchema, row), user.player_id);

    if (!service.visible(activity, user.player_id)) throw new HTTPException(404);
    const fitness = service.fitnessVisible(activity, user.player_id);
    const data = service.companion(activity, fitness);

    // Charts come from the canonical FIT payload. A missing chart is created by a job;
    // the details omit fitness data until it is ready.
    const fileId = fitness ? service.chartFile(activity.id) : null;

    if (fileId !== null) {
      const url = gameUrls(
        runtime.config,
        `https://us-or-rly101.zwift.com/api/activities/${activity.id}/file/${fileId}`,
      );

      return c.json({
        ...data,
        fitnessData: {
          status: 'AVAILABLE',
          fullDataUrl: url,
          smallDataUrl: url,
        },
      });
    }

    return c.json(data);
  });
  app.on(
    'GET',
    [
      '/api/activity-feed-service-v2/feed/:feedType',
      '/api/activity-feed-service-v2/feed/:feedType/:profileId',
      '/api/activity-feed/feed/',
    ],
    (c) => {
      const user = authenticated(c);

      const type = c.req.param('feedType') ?? c.req.query('feedType')?.toLowerCase().replaceAll('_', '-');

      const limit = z.coerce
        .number()
        .int()
        .min(0)
        .max(1000)
        .parse(c.req.query('limit') ?? 50);

      const id =
        type === 'just-me' ? user.player_id : Number(c.req.param('profileId') ?? c.req.query('profile_id')) || null;

      const before = c.req.query('start_after_activity_id');

      const activities = service
        .activityFeed(id, before ?? null, type === 'preview' ? 1 : 0, user.player_id, limit)
        .map((row) => service.forViewer(records.decode(ActivitySchema, row), user.player_id));

      return c.json(activities.map((activity) => service.companion(activity)));
    },
  );
  app.get('/api/activities/:activityId/file/:fileId', (c) => {
    const user = authenticated(c);
    const activity = service.activityById(c.req.param('activityId'));

    if (!activity || !service.fitnessVisible(records.decode(ActivitySchema, activity), user.player_id))
      throw new HTTPException(404);
    const id = z.coerce.number().int().positive().safe().parse(c.req.param('fileId'));

    if (!service.findOwnedActivityFile(id, c.req.param('activityId'))) throw new HTTPException(404);
    const file = service.chartPath(id);

    if (!runtime.services.files.exists(file)) throw new HTTPException(404);

    return c.body(runtime.services.files.read(file), 200, {
      'Content-Type': 'application/json',
    });
  });
  app.post('/api/profiles/:id/activities/:activityId/images', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const image = parseProtobuf(ActivityImageSchema, new Uint8Array(await c.req.arrayBuffer()));

    if (!service.findActivity(c.req.param('activityId'), user.player_id)) throw new HTTPException(404);
    const id = await service.saveImage(user.player_id, c.req.param('activityId'), image.jpg);

    return c.json({ id, id_str: String(id) });
  });
  app.post('/api/profiles/:id/activities/:activityId/medias', async (c) => {
    const user = authenticated(c);

    if (String(user.player_id) !== c.req.param('id')) throw new HTTPException(401);

    const body = parseProtobuf(ActivityMediaSaveRequestSchema, new Uint8Array(await c.req.arrayBuffer()));

    if (!service.findActivity(c.req.param('activityId'), user.player_id)) throw new HTTPException(404);
    const id = service.insertActivityMedia(user.player_id, c.req.param('activityId'), body.contentType).lastInsertRowid;

    const { token, expires } = service.issueMedia(String(id));

    return c.body(
      toBinary(
        ActivityMediaSaveResultSchema,
        create(ActivityMediaSaveResultSchema, {
          uploadUrl: gameUrls(
            runtime.config,
            `https://us-or-rly101.zwift.com/uploads/media/${id}?token=${token.toString('base64url')}`,
          ),
          expirationInMillis: BigInt(expires),
          signedHeaders: { 'Content-Type': { values: [body.contentType] } },
        }),
      ),
    );
  });
  app.put('/uploads/media/:id', async (c) => {
    await service.receiveMedia(c.req.param('id'), Buffer.from(c.req.query('token') ?? '', 'base64url'), () =>
      c.req.arrayBuffer(),
    );

    return c.body(null, 200);
  });
}
