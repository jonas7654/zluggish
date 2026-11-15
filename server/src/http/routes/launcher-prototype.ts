import { prototypeDocument } from '#src/http/launcher/render';
import { authenticated, csrf } from '#src/http/routes/accounts';
import type { HttpRuntime, RuntimeEnv } from '#src/http/runtime';
import type { Hono } from 'hono';
import { z } from 'zod';

// Isolated compatibility probe. Production page migration waits for real launcher tests.
export function launcherPrototypeRoutes(app: Hono<RuntimeEnv>, runtime: HttpRuntime) {
  app.get('/ui/prototype/settings', async (c) => {
    c.header('Cache-Control', 'no-store');
    const rider = authenticated(c);

    const settings = runtime.services.settings.resolveRiderSettings(
      runtime.config.riderDefaults,
      runtime.services.settings.read(rider.player_id),
    );

    return c.html(
      await prototypeDocument(
        {
          csrf: c.get('browser').csrf,
          riderName: `${rider.first_name} ${rider.last_name}`,
          settingsPath: `/settings/${encodeURIComponent(rider.username)}/`,
          ghosts: settings.ghosts.enabled,
          bridgeFolder: settings.workouts.trainingpeaks.bridgeFolder,
          stravaMethod: settings.uploads.strava.method,
        },
        runtime.services.files,
      ),
    );
  });
  app.post('/ui/prototype/settings', async (c) => {
    c.header('Cache-Control', 'no-store');
    authenticated(c);
    const form = await csrf(c, runtime);
    z.object({ bridge_folder: z.string().max(500), strava_method: z.enum(['paid', 'free']) }).parse(form);

    // Exercise multipart, cookies and CSRF without changing rider data.
    return c.req.header('Accept')?.includes('application/json')
      ? c.json({ ok: true, message: 'Prototype received; no preferences saved.' })
      : c.redirect('/ui/prototype/settings', 303);
  });
}
