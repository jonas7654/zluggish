import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

// Scoped CSS class hashes come from the path relative to rootDir. Vite builds from the web
// package, so source rendering must use the same root or the built stylesheet never matches.
const rootDir = fileURLToPath(new URL('../../web/', import.meta.url));

registerHooks({
  load(url, context, nextLoad) {
    if (!new URL(url).pathname.endsWith('.svelte')) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    const result = compile(readFileSync(filename, 'utf8'), { filename, rootDir, generate: 'server' });
    return { format: 'module', source: result.js.code, shortCircuit: true };
  },
});
