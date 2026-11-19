import { Effect } from 'effect';
import { effectRoutes } from '#src/http/effect';
import { FilesService } from '#src/services/files.service';
import { authenticated } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

export function workoutRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  const appRoutes = effectRoutes(app, runtime);

  const workouts = runtime.services.workouts;

  const selected = (id: number, sport = 'CYCLING') => (sport.toUpperCase() === 'CYCLING' ? workouts.list(id) : []);

  app.get('/api/workout/schedule/list', (c) => {
    const user = authenticated(c);
    c.header('Cache-Control', 'private, no-store');

    return c.json(selected(user.player_id, c.req.query('sport')).map((item) => item.schedule));
  });
  app.get('/api/head-unit-bff/game-home', (c) => {
    const user = authenticated(c);
    c.header('Cache-Control', 'private, no-store');

    return c.json(selected(user.player_id, c.req.query('sport'))[0]?.home ?? {});
  });
  app.get('/api/head-unit-bff/carousels/for-you', (c) => {
    const user = authenticated(c);
    c.header('Cache-Control', 'private, no-store');

    return c.json(
      selected(user.player_id, c.req.query('sport')).map((workout) => ({
        recommendationType: 'workout',
        workoutUUID: workout.id,
        workoutHash: null,
        assetUrl: workout.schedule.workoutUri,
        providerId: 'intervalsicu',
        provider: null,
        scheduleId: workout.schedule.scheduleId,
        score: 1,
        explanation: null,
        sourceData: null,
        source: 'SCHEDULED',
        sourceId: workout.schedule.scheduleId,
        ribbon: null,
        recommendedDurationMinutes: null,
      })),
    );
  });
  app.get('/api/workout/workouts/:id', (c) => {
    const user = authenticated(c);

    const workout = selected(user.player_id, c.req.query('sport')).find((item) => item.id === c.req.param('id'));

    if (!workout) throw new HTTPException(404);
    c.header('Cache-Control', 'private, no-store');

    return c.json(workout.schedule.workoutSummary);
  });
  appRoutes.get('/tp-workouts/intervalsicu/:id', (c) =>
    Effect.gen(function* () {
      const filesService = yield* FilesService;

      const file = workouts.file(c.req.param('id').replace(/\.zwo$/, ''));

      if (!file || !(yield* filesService.exists(file))) throw new HTTPException(404);

      return c.body(yield* filesService.read(file), 200, {
        'Content-Type': 'application/xml',
      });
    }),
  );
  app.get('/api/assetcms/*', (c) =>
    c.json(c.req.path.endsWith('/partner_name_map.json/download') ? { intervalsicu: 'Intervals.icu' } : null),
  );
}
