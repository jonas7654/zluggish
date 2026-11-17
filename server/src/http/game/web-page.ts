import type { Context } from 'hono';
import type { HttpRuntime, RuntimeEnv } from '#src/http/runtime';
import { model } from '#src/http/game/models';
import { gamePage } from '#src/http/game/render';

export function movedToWeb(
  c: Context<RuntimeEnv>,
  runtime: HttpRuntime,
  title: string,
  path: string,
  message = '',
  failed = false,
) {
  const { publicUrl, port } = runtime.config.network.web;

  return gamePage(
    c,
    runtime,
    model(c, 'message', title, [], {
      message,
      failed,
      paragraphs: [`Manage this in the web app${publicUrl ? '.' : ` on port ${port}.`}`],
      links: publicUrl ? [{ href: `${publicUrl}${path}`, label: 'Open in the web app' }] : [],
    }),
  );
}
