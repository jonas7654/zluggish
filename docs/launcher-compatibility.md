# Svelte launcher compatibility

The code migration is implemented. Real Windows and macOS launcher checks remain a manual release gate. The project owner requested the remaining migration in one PR after merging the spike. Do not treat automated Chromium coverage as a real launcher result.

## Run the migrated pages

Use Node 24 and pnpm from `server/mise.toml`.

```sh
cd server
pnpm install --frozen-lockfile
pnpm build:web
pnpm dev
# In another terminal:
pnpm dev:web
```

Sign in through Hono and use the dashboard links. The temporary `/ui/prototype/settings` probe has been removed. Settings, login, rider creation, dashboard, password, provider connections, workout sync, import/review and maintenance now use typed Svelte forms. Ordinary saves return results in place. Native launch and attachment downloads remain normal form submissions; OAuth and successful identity/import transitions use full navigation.

Login, rider creation and dashboard hydrate SSR HTML. Other pages mount over server-rendered fallback HTML from the same typed Svelte view; there are no parallel legacy templates. Every page still has a normal form POST path when JavaScript fails. Destructive commands require a confirmation checkbox checked by the server. Session or CSRF expiry stops submissions instead of replaying them.

Upload summaries use `/ui/status/uploads` only; they never poll the dashboard GET. Polling runs every five seconds while visible with nonterminal jobs, backs off after errors, and stops on completion, navigation or identity change. The passive status/session endpoints cannot create anonymous sessions. Other tabs receive a session-change notification without account data; focus/visibility checks cover sessions changed without JavaScript.

The source hook compiles Svelte in memory. Node watch restarts development on imported source changes. Client watch writes hashed assets to `dist/web/client`; reload after rebuilding. Production imports the bundled SSR entry through the default `#launcher` condition. No loader, compiler or Vite server runs in production.

## Verification

- `pnpm check:web`: typed Svelte components and browser entry.
- `pnpm test`: unit and medium tests, including source Svelte rendering.
- `pnpm test:browser`: compiled app with Chromium hydration, bound drafts, multipart fetch, validation and JavaScript-off POST.
- Container CI fetches authenticated settings and its JS/CSS after pruning development dependencies.

Provisional targets remain ES2022 and Chrome 100 CSS pending real webview checks. The migration bundle is approximately 51.6 kB raw JavaScript, 19.5 kB gzip (Node default gzip), 0.86 kB raw CSS, and 72.1 kB raw bundled SSR on Node 24.22.1 / TypeScript 6. The build enforces the spike's 20,000-byte gzip JavaScript budget across all client chunks with `scripts/check-ui-size.mjs`. A release usability budget still needs real launcher measurements.

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

Record observations, tester and date here. If either launcher cannot run the bundle, stop and decide the next step with the owner. Chromium is not proof of launcher compatibility. The single migration PR follows the owner's updated scope; the manual launcher gate remains pending before release.

References: [Svelte compiler](https://svelte.dev/docs/svelte/svelte-compiler), [Vite backend integration](https://vite.dev/guide/backend-integration), [Node module hooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions).
