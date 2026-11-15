import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compile } from 'svelte/compiler';

registerHooks({
  load(url, context, nextLoad) {
    if (!new URL(url).pathname.endsWith('.svelte')) return nextLoad(url, context);
    const filename = fileURLToPath(url);
    const result = compile(readFileSync(filename, 'utf8'), { filename, generate: 'server' });
    return { format: 'module', source: result.js.code, shortCircuit: true };
  },
});
