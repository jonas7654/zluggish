import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
  build: {
    outDir: 'build',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: resolve(root, 'index.html'),
        notFound: resolve(root, '404.html'),
      },
    },
  },
  // The logo and the screenshots come from the repository's media/ folder.
  server: { fs: { allow: [resolve(root, '../..')] } },
});
