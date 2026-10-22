# Contributing to h6ai

Thanks for helping! A few ground rules keep h6ai small, fast and safe.

## Setup

```sh
npm ci
npm run build:dev          # or: npm run watch
docker compose -f compose.yaml -f compose.dev.yaml up -d --build   # test environment with sample data
```

The test site runs at `http://$H6AI_BIND:$H6AI_PORT/` (see `compose.dev.yaml`). Files you put into
`./webroot/` show up there.

## Checks before a pull request

```sh
npm run check              # ESLint + unit tests
npm run lint:php           # php -l in Docker
npm run test:integration   # API, security and permission regression tests against the container
npm run test:e2e           # browser tests (Playwright in Docker)
npm run lint:sh            # shellcheck for the installer and container scripts
```

Changes to `install.sh`, `deploy/` or the PHP requirements: also run `npm run test:native`
(about 5 minutes per distribution, `test-native/run.sh debian12` for one).

## Guidelines

* **Security first.** Every client supplied path goes through `Context::to_path()`; every
  file exposed through the API needs `is_exposed_file()` / permission checks; shell commands use
  argv arrays (`Util::exec_argv`), never strings; HTML is built with `textContent` or sanitized
  with DOMPurify. Add an integration test for every security relevant change.
* **No new runtime dependencies** without discussion. The backend is plain PHP ≥ 8.2, the
  frontend vanilla JS bundled by esbuild.
* **Keep the wire protocol stable** (`POST action=get|login|logout|password|download|admin`), it is
  documented in `test-integration/`.
* Match the surrounding code style; ESLint config is in `eslint.config.mjs`, PHP uses 4 spaces,
  `declare(strict_types=1)` and snake_case methods.
* Write commit messages in the imperative ("add folder groups", "fix sitemap for hidden dirs").

## Project layout

| Path | What |
|------|------|
| `src/_h6ai/private/php` | backend (core, extensions, page template) |
| `src/_h6ai/private/conf` | default options, types, translations |
| `src/_h6ai/public/js` | frontend modules (bundled to `public/js/scripts.js`) |
| `src/_h6ai/public/css` | styles (bundled to `public/css/styles.css`) |
| `install.sh` | native installer |
| `deploy/` | nginx and PHP configuration shared by Docker and the native install |
| `docker/` | container entrypoint, seed data for the test environment |
| `test/` | unit tests · `test-integration/` API/security tests · `test-e2e/` browser tests · `test-native/` installer tests |
| `docs/` | audit, plan, deployment, performance, project website |
