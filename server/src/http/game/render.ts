import { packageRoot } from '#src/config/load';
import type { FormResult, GamePageModel, GameSaved } from '#src/dtos/game-app.dto';
import { browserJson } from '#src/http/game/results';
import type { HttpRuntime, RuntimeEnv } from '#src/http/runtime';
import type { Context } from 'hono';
import { z } from 'zod';
import { resolve } from 'node:path';

function serialize(props: GamePageModel) {
  return JSON.stringify(props).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

function document(
  props: GamePageModel,
  rendered: { head: string; body: string },
  files: HttpRuntime['services']['files'],
) {
  const manifest = z
    .record(z.string(), z.object({ file: z.string(), css: z.array(z.string()).optional() }))
    .parse(JSON.parse(files.read(resolve(packageRoot(), '../web/dist/game/client/.vite/manifest.json'), 'utf8')));

  const entry = manifest['src/game/client.ts'];

  if (!entry) throw new Error('Build the game app with pnpm build:web first');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${rendered.head}${(entry.css ?? []).map((file) => `<link rel="stylesheet" href="/static/launcher-ui/${file}">`).join('')}</head><body><div id="launcher-ui">${rendered.body}</div><script type="application/json" id="launcher-props">${serialize(props)}</script><script type="module" src="/static/launcher-ui/${entry.file}"></script></body></html>`;
}

export async function gamePage(c: Context<RuntimeEnv>, runtime: HttpRuntime, model: GamePageModel, redirect?: string) {
  c.header('Cache-Control', 'no-store');

  if (c.req.method === 'POST' && browserJson(c)) {
    const result: FormResult<GameSaved> = model.failed
      ? { ok: false, message: model.message ?? 'The form could not be saved.' }
      : { ok: true, data: { page: model }, message: model.message ?? 'Saved.' };

    return c.json(result, model.failed ? (model.errorStatus ?? 400) : 200);
  }

  if (redirect) return c.redirect(redirect);
  const { renderGamePage } = await import('#game');

  return c.html(document(model, renderGamePage(model), runtime.services.files));
}
