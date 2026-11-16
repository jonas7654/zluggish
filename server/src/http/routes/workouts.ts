import { field, form as makeForm, model, secret } from '#src/http/launcher/models';
import { launcherPage } from '#src/http/launcher/render';
import { authenticated, csrf } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

export function workoutRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
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
  app.get('/tp-workouts/intervalsicu/:id', (c) => {
    const file = workouts.file(c.req.param('id').replace(/\.zwo$/, ''));

    if (!file || !runtime.services.files.exists(file)) throw new HTTPException(404);

    return c.body(runtime.services.files.read(file), 200, {
      'Content-Type': 'application/xml',
    });
  });
  app.get('/api/assetcms/*', (c) =>
    c.json(c.req.path.endsWith('/partner_name_map.json/download') ? { intervalsicu: 'Intervals.icu' } : null),
  );
  app.on(['GET', 'POST'], '/intervals/:username/', async (c) => {
    const user = authenticated(c);
    const connections = runtime.services.connections;

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      const athlete = z.string().regex(/^\d+$/).parse(form.athlete_id);

      const key = z
        .string()
        .min(1)
        .parse(form.api_key || connections.read(user.player_id, 'intervals')?.[1]);

      connections.save(user.player_id, 'intervals', [athlete, key]);
    }

    const connected = runtime.services.files.exists(connections.file(user.player_id, 'intervals'));

    const credentials = connections.read(user.player_id, 'intervals');

    return launcherPage(
      c,
      runtime,
      model(
        c,
        'workouts',
        'Intervals.icu',
        [
          makeForm(
            'intervals-credentials',
            `/intervals/${user.username}/`,
            [
              field('athlete_id', 'Athlete ID', { value: credentials?.[0] ?? '', pattern: '^\\d+$', required: true }),
              secret('api_key', 'API key', connected),
            ],
            'Save connection',
          ),
          makeForm('intervals-sync', `/intervals/${user.username}/sync`, [], 'Sync workouts'),
        ],
        { paragraphs: [connected ? 'Connected' : 'Enter your athlete ID and API key.'] },
      ),
      c.req.method === 'POST' ? `/settings/${user.username}/` : undefined,
    );
  });
  app.on(['GET', 'POST'], '/trainingpeaks/:username/', async (c) => {
    const user = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);
      const overrides = runtime.services.settings.read(user.player_id);
      overrides['workouts.trainingpeaks.bridgeFolder'] = z.string().max(500).parse(form.bridge_folder).trim();
      runtime.services.settings.save(user.player_id, overrides);
    }

    const folder =
      runtime.services.settings.read(user.player_id)['workouts.trainingpeaks.bridgeFolder'] ??
      runtime.config.riderDefaults.workouts.trainingpeaks.bridgeFolder;

    return launcherPage(
      c,
      runtime,
      model(
        c,
        'workouts',
        'TrainingPeaks bridge',
        [
          makeForm(
            'trainingpeaks-folder',
            `/trainingpeaks/${user.username}/`,
            [field('bridge_folder', 'Export folder', { value: folder, maxLength: 500 })],
            'Save folder',
          ),
          makeForm('trainingpeaks-sync', `/trainingpeaks/${user.username}/sync`, [], 'Import workouts'),
        ],
        {
          paragraphs: [
            'Export .zwo workouts to a local folder. Automatic TrainingPeaks API access requires approved partner credentials.',
          ],
        },
      ),
    );
  });
  app.post('/:provider{intervals|trainingpeaks}/:username/sync', async (c) => {
    const user = authenticated(c);
    await csrf(c, runtime);

    const provider = c.req.param('provider') === 'intervals' ? 'intervals-icu' : 'trainingpeaks';

    runtime.services.files.write(
      resolve(runtime.services.profiles.folder(user.player_id), 'active_workout_provider.txt'),
      provider,
      true,
    );
    let message: string;

    try {
      message = await workouts.sync(user.player_id);
    } catch {
      message = 'Workout sync failed. Existing workouts were retained.';
    }

    if (
      !runtime.services.sessions.current(
        c.get('browserId'),
        c.get('browser'),
        runtime.services.accounts.identityOf(user),
      )
    )
      throw new HTTPException(401);

    return launcherPage(
      c,
      runtime,
      model(c, 'message', 'Workout sync', [], {
        message,
        failed: message.includes('failed'),
        links: [{ href: `/settings/${user.username}/`, label: 'Settings' }],
      }),
    );
  });
}
