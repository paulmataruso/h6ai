# Modernisation plan

## Draft v1

1. **Rewrite the frontend in a framework** (Svelte/React + Vite), new REST-style PHP API.
2. Fix every finding in `AUDIT.md`.
3. New design system: CSS variables, dark mode, new icon set.
4. Replace the build with Vite; ESLint 9; Vitest.
5. Raise PHP floor to 8.2, add strict types everywhere.
6. Ship Docker (nginx + php-fpm) for testing.

## Critique of v1

* **A framework rewrite is the wrong trade.** The JS is ~4k lines, already modular (event bus + ext
  modules), and escapes correctly almost everywhere (`.text()`). The XSS holes are two specific
  sinks, not an architectural flaw. A rewrite throws away 10 years of edge-case handling (URL
  encoding quirks, lighttpd script names, fast browsing/history) and breaks every existing
  `options.json`, custom header and theme. **Keep the architecture; modernise in place.**
* **A new REST API** breaks third-party themes/scripts that call `POST ?action=get` and
  gains nothing security-wise. Keep the wire protocol, harden the handlers.
* **Vite** is designed for SPAs with a dev server; h5ai is a PHP-served page with one JS and one CSS
  bundle. **esbuild** via a 60-line Node script does the job with one dependency and no config.
* **Strict types everywhere** in one pass is a big-bang change that's hard to verify. Add
  `declare(strict_types=1)` to the files we touch, plus type hints on the security-relevant
  boundaries (path resolution, request parsing).
* v1 "fix everything" has no verification story. Every security fix needs a **regression test
  that runs against the Docker container**, otherwise we can't claim it's fixed.
* **Symlinks:** a naive "realpath must be inside root" fix breaks a very common setup (media
  folders symlinked into the web root). The web server already follows those symlinks to serve
  files, so h5ai listing them isn't a new exposure. The real bug is *lexical* traversal
  (`..`) and missing managed/hidden checks; fix those, plus cycle protection.
* **Default password:** simply disallowing the empty password must not lock people out silently.
  The info page must explain how to generate a hash, and we need a CLI helper.
* **CSP:** a strict CSP breaks user-configured `resources.scripts/styles` and Matomo. CSP must be
  derived from config (add configured origins) and be overrideable / disable-able.
* **Custom header HTML** is a deliberate feature; sanitising it by default could break existing
  sites, but rendering markdown unsanitised is never intended. Decision: always sanitise markdown;
  sanitise HTML by default with an explicit `custom.allowUnsafeHtml` escape hatch.
* **Docker:** ~~provide nginx and Apache targets~~. Revised per owner decision: **nginx + PHP-FPM only**.

## Final plan (v2) — what is implemented

### Phase 1 — Tooling
* Remove `ghu`, webpack, babel, uglify, less, pug, scar.
* `build.mjs` (esbuild): bundle + minify JS (ESM, target `es2020`), bundle + minify CSS, render the
  two page templates (plain PHP now, no Pug), copy assets, stamp version, zip release.
* ESLint 9 flat config; tests on `node:test` + `jsdom`.
* Deps: `esbuild`, `marked@latest`, `dompurify`, `lolight`, `kjua` (+ dev: `eslint`, `jsdom`).

### Phase 2 — Backend hardening (PHP ≥ 8.2)
* Central `Context::resolve_href()` that rejects traversal/NUL/out-of-root hrefs; every handler uses it.
* Thumbs: managed + hidden + type checks; integer-clamped dimensions; pixel/size caps; subprocess
  timeout; video seek fallback; WebP/AVIF support; `0644` files.
* Fallback: escape all output.
* Auth: `password_hash()`/`password_verify()` (legacy SHA-512 still accepted via `hash_equals`);
  empty password = login disabled; file-based rate limiter; `session_regenerate_id`; hardened
  cookie; sessions only started for API requests; `bin/h5ai-passhash` CLI.
* API: `$_POST`/JSON only; JSON requires `application/json`; same-origin check for
  state-changing actions.
* Search: delimiter-safe pattern wrapping, compile check, PCRE backtrack limit, max results/depth/
  time, symlink-loop guard.
* Archive: hrefs must be inside base; full-path hidden check; RFC 6266 filename; PAX headers for long
  names and >8 GiB files.
* Custom: managed check; stop at root always for `headers`; sanitise flag passed to client.
* Security headers + config-derived CSP with nonce; no runtime `<style>` injection in JS.
* Foldersize: symlink cycle guard; robustness fixes for PHP 8 warnings.

### Phase 3 — Frontend
* `fetch` API client with error surfacing; guarded storage; `key` events; no `document.domain`.
* DOMPurify for all markdown/custom HTML; `marked` upgrade.
* Remove demo context menu, PayPal block, dead GA-UA ext; Piwik → Matomo (old key still read).
* Accessibility: real `<button>`s with labels, focus styles, keyboard navigation in the list
  (arrows/Enter/Backspace), `/` to focus filter.

### Phase 4 — GUI redesign
* New CSS (plain CSS, custom properties): light/dark (auto + toggle), modern top bar with breadcrumb,
  sticky column header, card-style grid/icons views, responsive drawer sidebar, modern preview
  lightbox, system font stack (no Google Fonts).
* New UI icon set (inline-able SVG, `currentColor`, so icons follow the theme).

### Phase 5 — Docker & verification
* Multi-stage `Dockerfile` (node build → nginx + PHP-FPM runtime), `compose.yaml`, seeded sample tree
  including malicious filenames/markdown, a 64 MiB file and permission fixtures.
* `test-integration/`: node:test regression suite for every audit finding, RBAC and large-file behaviour.
* PHP lint inside the container; JS unit tests and ESLint locally.

## Scope additions (requested mid-implementation) and their critique

### Users, RBAC, folder permissions, admin UI
First idea: store users, check permissions in the listing API. **Critique:** nginx serves the files,
so a listing-only check hides files but anyone with the URL still downloads them. That's security
theatre. Revised design:
* **File gate:** nginx `auth_request` sends every file request to PHP (`H5AI_GATE=check`), which answers
  204/401/403. nginx keeps serving the bytes. Directory URLs and `/_h5ai/public/*` bypass the gate.
* **Cost of the gate:** a PHP bootstrap per file request. Mitigations: compiled config cache
  (`var_export` → OPcache), read-only session access, and a gate fast path that skips shell-command
  detection and listing setup.
* **Model:** levels `none < list < read < download`. Rules are attached to folder paths, and the most
  specific rule wins. Within a rule, a `user:` grant overrides role grants, and role grants and `*`
  (everyone) are max-combined. `admin` always has full access. With no rules everything is
  `download`, so behaviour matches classic h5ai.
* **Reachability:** a user with access only to `/team/` must still see `/team/` in the root listing even
  if `/` is `none`. Folders are shown if they or any rule below them grant ≥ `list`.
* **Thumbnail leak:** thumbnails live in the public cache, named `sha1(path)` and therefore guessable.
  Fix: HMAC names with a server secret.
* **Store:** `_h5ai/private/data/auth.json` (flock + atomic rename). No DB extension needed, and a few
  hundred users is plenty for this use case.
* **Sessions:** user name + per-user session version (bumped on password change, role change or
  disable) → stale sessions die immediately. CSRF token for admin mutations on top of SameSite=Strict
  and the Origin check.
* **Bootstrap:** while no users exist, the legacy `passhash`/`H5AI_PASSHASH` logs in as `admin`.
  Once an admin user exists the legacy password stops working.

### Large files and caching
* nginx serves all file bytes (sendfile, aio threads + directio for big files, open_file_cache,
  Range/ETag/Last-Modified for free). Protected files get `Cache-Control: private` via the gate.
* PHP-streamed archives send `X-Accel-Buffering: no` (no temp-file double write in nginx).
* Versioned asset URLs (`?v=`) and thumbnail URLs (`?v=mtime`) → `immutable` long-lived caching.
* Thumbnail cache size cap with LRU-ish pruning. Persistent folder-size cache with a TTL (recursive
  sizes of big trees were recomputed on every request).
* PHP-FPM + OPcache (JIT tracing), large realpath cache, FPM pool sized for long-running downloads.

### Rust
Evaluated separately in `RUST_EVALUATION.md`. Decision: finish PHP now and keep the API/gate
contract clean so a Rust backend could drop in later.

### Out of scope (documented, not done)
* Uploads / file management, user accounts.
* Serving untrusted HTML from a separate origin (S17) — deployment concern, documented in `SECURITY.md`.

## Status (2026-10-22)

All phases above are implemented on branch `modernize`.

| Check | Result |
|-------|--------|
| ESLint 9 + unit tests (`npm run check`) | 9/9 pass, lint clean |
| PHP lint (8.3) | clean |
| Integration/security suite (`npm run test:integration`, 88 tests) | 87 pass + 1 todo (passes) |
| Browser E2E (`npm run test:e2e`, Playwright, 14 steps) | all pass, no console errors |

Known limitations / follow-ups:
* Old translations only cover the original strings; new UI strings fall back to English.
* `lolight` tries to inject its default CSS at runtime; the CSP blocks it (harmless console warning,
  h5ai styles the tokens itself).
* Rate limiting is keyed by `REMOTE_ADDR`. Behind a reverse proxy, all clients share one bucket
  unless nginx passes the real client address (`set_real_ip_from` + `real_ip_header`).
* EXIF orientation test is marked todo in the suite (it passes, the assertion is heuristic).
