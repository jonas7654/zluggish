# Svelte launcher compatibility spike

The real Windows and macOS launcher checks are pending. This PR implements the first software spike from the Svelte launcher plan; it does not migrate production forms.

## Run the prototype

Use Node 24 and pnpm from `server/mise.toml`.

```sh
cd server
pnpm install --frozen-lockfile
pnpm build:web
pnpm dev
# In another terminal:
pnpm dev:web
```

Sign in through Hono, then visit `/ui/prototype/settings` on the same origin. The page loads the session rider's resolved preferences. **Check form** tests multipart submission and CSRF but does not save preferences. Use normal settings to save. The native launch flow is unchanged.

The source hook compiles Svelte in memory. Node watch restarts development on imported source changes. Client watch writes hashed assets to `dist/web/client`; reload after rebuilding. Production imports the bundled SSR entry through the default `#launcher` condition. No loader, compiler or Vite server runs in production.

## Verification

- `pnpm check:web`: typed Svelte components and browser entry.
- `pnpm test`: unit and medium tests, including source Svelte rendering.
- `pnpm test:browser`: compiled app with Chromium hydration, bound drafts, multipart fetch, validation and JavaScript-off POST.
- Container CI fetches the authenticated prototype and its JS/CSS after pruning development dependencies.

Provisional targets: ES2022 and Chrome 100 CSS. Confirm them against real webviews before migration. Initial Node 24.22.1 bundle: about 38.34 kB raw / 15.03 kB gzip JavaScript, 0.35 kB raw CSS, 64.25 kB raw bundled SSR. Provisional spike budget: 20 kB gzip JavaScript. Set the release budget after measuring real launcher usability.

## Required real launcher tests

| Measurement                        | Windows | macOS   |
| ---------------------------------- | ------- | ------- |
| Tester/date                        | Pending | Pending |
| OS version                         | Pending | Pending |
| Launcher version                   | Pending | Pending |
| Webview engine/version             | Pending | Pending |
| Page/asset origins                 | Pending | Pending |
| Modules, hydration, bindings       | Pending | Pending |
| Cookies, same-origin fetch         | Pending | Pending |
| Multipart with JS on/off           | Pending | Pending |
| Save preference in normal settings | Pending | Pending |
| Real Start Zwift to ride handoff   | Pending | Pending |
| Time until usable                  | Pending | Pending |

Record observations, tester and date here. If either launcher cannot run the bundle, stop and decide the next step with the owner. Chromium is not proof of launcher compatibility. Later migrations remain one page per PR, in the plan's order.

References: [Svelte compiler](https://svelte.dev/docs/svelte/svelte-compiler), [Vite backend integration](https://vite.dev/guide/backend-integration), [Node module hooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions).
