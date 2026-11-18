---
sidebar_position: 7
description: Build, check and test Zluggish from source.
---

# Development

## Set up

1. Install [mise](https://mise.jdx.dev/getting-started.html).
2. From the repository root, run:

   ```sh
   cd server
   mise install
   mise run install
   mise run check
   ```

`mise run check` builds, lints, typechecks and tests the server and its CLI. It also checks the formatting.

## Individual checks

From `server/`, run one of these commands:

| Command           | Result                |
| ----------------- | --------------------- |
| `pnpm lint`       | Lint the code.        |
| `pnpm typecheck`  | Typecheck the code.   |
| `pnpm test`       | Run the tests.        |
| `pnpm format`     | Check the formatting. |
| `pnpm lint:fix`   | Fix lint problems.    |
| `pnpm format:fix` | Fix the formatting.   |

Linting and formatting do not include the generated protobuf codecs, the bundled assets and the vendored lint rules.

## Web app

- Build the web app with `pnpm --dir web build`.
- Typecheck it with `pnpm --dir web check`.

## Screenshots

To make the screenshots in `media/screenshots/` again, run `pnpm --dir server screenshots`. The command uses fictional riders on a temporary server.

## Documentation

This site is in [`docs/`](https://github.com/zluggish/zluggish/tree/main/docs). The Docusaurus configuration is in [`sites/docs.zluggish.com/`](https://github.com/zluggish/zluggish/tree/main/sites/docs.zluggish.com).

1. Install the dependencies from the repository root:

   ```sh
   pnpm install --frozen-lockfile --filter @zluggish/docs...
   ```

2. Start the local site:

   ```sh
   pnpm --filter @zluggish/docs start
   ```

3. Build the site:

   ```sh
   pnpm --filter @zluggish/docs build
   ```

Write new text in [ASD-STE100](https://www.asd-ste100.org/) Simplified Technical English. Give one action in each step.

## Lint rules

ESLint uses TypeScript-aware correctness rules, import checks and Unicorn conventions. The first configuration came from the `server/eslint.config.mjs` file of `immich-app/immich`. The vendored Oxlint rules record their source revision in [UPSTREAM.md](https://github.com/zluggish/zluggish/blob/main/server/tools/oxlint/anti-slop/UPSTREAM.md).

The shared ESLint, Oxlint, Prettier and mise configuration is in `server/`.
