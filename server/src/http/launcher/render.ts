import { packageRoot } from '#src/config/load';
import type { PrototypePage } from '#src/dtos/launcher.dto';
import type { HttpRuntime } from '#src/http/runtime';
import { z } from 'zod';
import { resolve } from 'node:path';

export async function prototypeDocument(props: PrototypePage, files: HttpRuntime['services']['files']) {
  const { renderPrototype } = await import('#launcher');
  const rendered = renderPrototype(props);

  const manifest = z
    .record(z.string(), z.object({ file: z.string(), css: z.array(z.string()).optional() }))
    .parse(JSON.parse(files.read(resolve(packageRoot(), 'dist/web/client/.vite/manifest.json'), 'utf8')));

  const entry = manifest['web/client.ts'];

  if (!entry) throw new Error('Build the launcher client with pnpm build:web first');

  const serialized = JSON.stringify(props)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026');

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${rendered.head}${(entry.css ?? []).map((file) => `<link rel="stylesheet" href="/static/launcher-ui/${file}">`).join('')}</head><body><div id="launcher-ui">${rendered.body}</div><script type="application/json" id="launcher-props">${serialized}</script><script type="module" src="/static/launcher-ui/${entry.file}"></script></body></html>`;
}
