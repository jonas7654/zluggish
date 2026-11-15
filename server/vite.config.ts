import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [svelte()],
  base: '/static/launcher-ui/',
  ssr: { noExternal: true },
  build: {
    // Provisional targets; real launcher results must confirm them before migration.
    target: 'es2022',
    cssTarget: 'chrome100',
    outDir: isSsrBuild ? 'dist/web/server' : 'dist/web/client',
    manifest: !isSsrBuild,
    rollupOptions: {
      input: isSsrBuild ? 'web/server.ts' : 'web/client.ts',
      output: isSsrBuild ? { entryFileNames: 'entry.js' } : undefined,
    },
  },
}));
