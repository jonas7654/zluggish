import { checkbox, field, form as makeForm, hidden, model } from '#src/http/launcher/models';
import { launcherPage } from '#src/http/launcher/render';
import { DownloadFile, StravaMethod } from '#src/enum';
import { authenticated, csrf } from '#src/http/routes/accounts';
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { resolve } from 'node:path';
import { z } from 'zod';

const downloadable = z.enum(DownloadFile);

export function settingsRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  app.on(['GET', 'POST'], '/settings/:username/', async (c) => {
    const rider = authenticated(c);

    if (c.req.method === 'POST') {
      const form = await csrf(c, runtime);

      const input = z
        .object({
          bridge_folder: z.string().max(500).default(''),
          strava_method: z.enum(StravaMethod).default(StravaMethod.Paid),
        })
        .parse(form);

      runtime.services.settings.save(rider.player_id, {
        ...runtime.services.settings.read(rider.player_id),
        'ghosts.enabled': form.enableghosts !== undefined,
        'workouts.trainingpeaks.bridgeFolder': input.bridge_folder,
        'uploads.strava.method': input.strava_method,
      });
    }

    const settings = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(rider.player_id),
    );

    return launcherPage(
      c,
      runtime,
      model(
        c,
        'settings',
        'Rider settings',
        [
          makeForm(
            'preferences',
            `/settings/${rider.username}/`,
            [
              checkbox('enableghosts', 'Enable ghosts', settings.ghosts.enabled),
              field('bridge_folder', 'TrainingPeaks export folder', {
                value: settings.workouts.trainingpeaks.bridgeFolder,
                maxLength: 500,
              }),
              field('strava_method', 'Strava method', {
                type: 'select',
                value: settings.uploads.strava.method,
                options: [
                  { value: 'paid', label: 'API' },
                  { value: 'free', label: 'Session cookie' },
                ],
              }),
            ],
            'Save preferences',
          ),
          ...downloadable.options
            .filter((name) => runtime.services.documents.has(rider.player_id, name))
            .map((name) =>
              makeForm(`download-${name}`, '/download', [hidden('filename', name)], `Download ${name}`, {
                navigation: true,
              }),
            ),
        ],
        { links: [{ href: `/profile/${rider.username}/`, label: 'Restore rider data or import a profile' }] },
      ),
      c.req.method === 'POST' ? `/settings/${rider.username}/` : undefined,
    );
  });
  app.post('/download', async (c) => {
    const rider = authenticated(c);
    const form = await csrf(c, runtime);
    const file = downloadable.parse(form.filename);
    const data = runtime.services.documents.get(rider.player_id, file);

    if (!data) throw new HTTPException(404);

    return c.body(new Uint8Array(data), 200, {
      'Content-Disposition': `attachment; filename="${file}"`,
    });
  });
  app.get('/download/:id/avatarLarge.jpg', (c) => {
    const id = z.coerce.number().int().positive().safe().parse(c.req.param('id'));

    const path = resolve(runtime.services.profiles.folder(id), 'avatarLarge.jpg');

    if (!runtime.services.files.exists(path)) throw new HTTPException(404);

    return c.body(runtime.services.files.read(path), 200, { 'Content-Type': 'image/jpeg' });
  });
}
