import { Option, Schema } from 'effect';
import type { Hono } from 'hono';
import type { HttpRuntime, RuntimeEnv } from '#src/http/runtime';
import { ApplicationError } from '#src/errors';
import { parseProtobuf } from '#src/http/protobuf';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';

/** Only these native requests may use a completion permission. They never set rider context. */
export function rideCompletionRoutes(app: Hono<RuntimeEnv>, runtime: HttpRuntime) {
  app.on(['PUT', 'DELETE'], '/api/profiles/:id/activities/:activityId', async (c, next) => {
    const bearer = c.req.header('Authorization') ?? '';

    if (!bearer || runtime.services.sessions.bearer(bearer.replace(/^Bearer /i, ''))) return next();

    const ids = Schema.decodeUnknownOption(
      Schema.Struct({
        id: Schema.String.check(Schema.isPattern(/^\d{1,10}$/)),
        activityId: Schema.String.check(Schema.isPattern(/^\d{1,19}$/)),
      }),
    )(c.req.param());

    if (Option.isNone(ids)) throw new ApplicationError({ status: 400, message: 'Invalid ride identity.' });
    const player = Number(ids.value.id);
    const activityId = BigInt(ids.value.activityId);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const completion = runtime.services.rideCompletion;
    const permitted = completion.authorize(player, activityId, bearer, bytes);

    if (permitted.receipt !== null && (c.req.method !== 'PUT' || c.req.query('upload-to-strava') !== 'true'))
      throw new ApplicationError({ status: 401, message: 'Final save retry only.' });

    if (permitted.receipt !== null)
      return c.body(permitted.receipt, 200, { 'Content-Type': 'text/html; charset=utf-8' });

    if (c.req.header('Source') === 'zwift-companion')
      throw new ApplicationError({ status: 403, message: 'Native ride saves only.' });

    if (c.req.method === 'DELETE') {
      runtime.services.activities.deleteActivity(activityId, player);
      completion.cancel(player);

      return c.text('true');
    }

    const activity = parseProtobuf(ActivitySchema, bytes);

    if (activity.playerId !== BigInt(player) || activity.id !== activityId)
      throw new ApplicationError({ status: 403, message: 'Ride identity does not match.' });
    const finish = c.req.query('upload-to-strava') === 'true';
    await runtime.services.activities.saveInTurn(
      activity,
      finish,
      () => completion.authorize(player, activityId, bearer, bytes).receipt === null,
    );
    const result = JSON.stringify({ id: Number(activityId) });

    if (finish) completion.finish(player, activityId, bearer, bytes, result);
    else completion.touch(player);

    return c.body(result, 200, { 'Content-Type': 'text/html; charset=utf-8' });
  });
}
