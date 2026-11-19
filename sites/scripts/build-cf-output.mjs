import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Package a static site build/ directory as cf Build Output for `cf deploy --prebuilt`.
// Shared by the sites in sites/. Run it from a site directory. Adapted from Kondis: sites/kondis.org/scripts/build-cf-output.mjs.
const projectRoot = process.cwd();
const buildDir = join(projectRoot, 'build');
const outputRoot = join(projectRoot, '.cloudflare/output/v0');
const workerOutput = join(outputRoot, 'workers/default');

const { default: config } = await import(pathToFileURL(join(projectRoot, 'cloudflare.config.ts')).href);
// `--preview` packages a branch Preview for `cf previews deploy --prebuilt`.
const isPreview = process.argv.includes('--preview');
const resolvedConfig = typeof config === 'function' ? await config({ isPreview, mode: undefined }) : config;

if (!resolvedConfig.worker) {
  throw new Error('cloudflare.config.ts must define a Worker.');
}
if (resolvedConfig.worker.entrypoint) {
  throw new Error('This script only supports assets-only Workers.');
}

try {
  await stat(join(buildDir, 'index.html'));
} catch {
  throw new Error('build/index.html is missing. Run `pnpm build` first.');
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(workerOutput, { recursive: true });
await writeFile(
  join(outputRoot, 'config.json'),
  JSON.stringify(
    {
      ...(resolvedConfig.accountId && { accountId: resolvedConfig.accountId }),
      ...(resolvedConfig.complianceRegion && { complianceRegion: resolvedConfig.complianceRegion }),
      buildContext: { isPreview },
    },
    null,
    2,
  ),
);
await writeFile(join(workerOutput, 'worker.config.json'), JSON.stringify(resolvedConfig.worker, null, 2));
await cp(buildDir, join(workerOutput, 'assets'), { recursive: true });

console.log(`Build Output written to ${outputRoot}`);
