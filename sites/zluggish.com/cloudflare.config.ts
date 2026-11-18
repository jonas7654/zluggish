import { defineConfig } from 'cf/config';

export default defineConfig({
  worker: {
    name: 'zluggish-com',
    compatibilityDate: '2026-11-18',
    workersDev: false,
    domains: ['zluggish.com'],
    assets: {
      htmlHandling: 'auto-trailing-slash',
      notFoundHandling: '404-page',
    },
  },
});
