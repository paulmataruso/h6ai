# Integration & security regression tests

Black-box tests that run against a live h6ai instance, normally the Docker container from
`compose.yaml` (seeded with `docker/seed.sh`). They use only Node's built-in `node:test` and
`node:http`, so nothing needs installing. Every security test names the finding it covers
(`S1`…`S18`, see `docs/AUDIT.md`).

## Run

```sh
docker compose up --build -d
test-integration/run.sh
```

`run.sh` targets `H6AI_URL` (default `http://172.16.1.67:8687`, or `http://$H6AI_BIND:$H6AI_PORT`).
It:

1. clears the login rate limiter inside the container,
2. runs all files **sequentially** (`--test-concurrency=1`, in file-name order),
3. checks that no generated thumbnail is executable (S15),
4. clears the rate limiter again.

Extra arguments go to `node --test`, e.g. `test-integration/run.sh --test-reporter=dot`.

Running without the script:

```sh
H6AI_URL=http://127.0.0.1:8687 node --test --test-concurrency=1 test-integration/
```

## Files

| File | Covers |
|------|--------|
| `10-smoke` | listing, unicode round-trip, unmanaged folders, API contract, guest `setup` disclosure (S6), text/plain JSON (S8), symlink loop + folder sizes (S13), missing UA (S18) |
| `15-cve` | CVE-2026-109618 (PHP OOM RCE: fixed PHP, multipart 415, methods 405, body 413) and CVE-2026-10961 (sandbox CSP for user HTML/SVG) |
| `20-thumbs` | traversal/hidden thumbnails (S1, S14), converter input (S2), dimension limits + decompression bomb (S3), video/PDF/WebP/AVIF thumbs |
| `30-pages-headers` | fallback XSS (S4), no session on page views (S7), CSP & security headers (S12), no third-party fonts (S16), `/_h6ai/private` denial, fpm status not exposed, `.php` served as data |
| `40-search` | ReDoS, delimiter injection, hidden/out-of-root results, symlink loops (S9) |
| `50-download` | PAX long names, hidden files, scope & traversal checks, header injection (S10) |
| `60-custom` | header/footer lookup outside the root (S11) |
| `65-files-caching` | 64 MiB file: Range (exact bytes), 416, ETag/304, no gzip on media, immutable assets |
| `66-seo` | generated `robots.txt` / `sitemap.xml` (public content only, permissions respected), robots meta tag vs. the indexing setting |
| `67-google` | admin settings API: pasted Google snippets → extracted ids only, verification meta + nonce'd gtag/GTM loaders, CSP additions, id validation, write-only API secret |
| `68-activity` | activity log: guest file downloads and user archive downloads recorded, Range-from-middle and HEAD not, admin only |
| `70-auth` | origin/CSRF checks (S8), session fixation + cookie flags (S6/S7), logout |
| `80-rbac` | users, roles and per-folder rules across file gate, listings, search, thumbs, downloads, internal redirects |
| `85-groups-anon` | folder groups for users and roles, `anon` accounts (default deny, download only, no password change), group deletion |
| `90-ratelimit` | login rate limiting + no `X-Forwarded-For` bypass (S6). **Must run last** |

Tests for features the backend doesn't implement (yet) skip themselves with
`# SKIP backend pending: ...` (detected via `ERR_UNSUPPORTED` from the admin API), so the suite
can run against older builds.

## Benchmark

`test-integration/bench.sh` measures large-file throughput, archive streaming, API latency and
file-gate overhead against the running container. Results and hardware notes are in
`docs/PERFORMANCE.md`.

## Notes

* **Rate limiting:** `90-ratelimit` locks the test client out of logins for the limiter window.
  Without `run.sh`, unlock with
  `docker compose exec h6ai sh -c 'rm -f /srv/www/_h6ai/private/cache/ratelimit-*.json'`.
* **RBAC state:** `80-rbac` creates user `alice` and rules on `/private/` and `/site/`; `68-activity`
  and `85-groups-anon` create users, a role, folder groups and a rule. All of them are removed in
  `after()`. If a run is killed half-way, `alice` can stay in the `h6ai-data` volume. While
  any user exists, the bootstrap admin (`H6AI_PASSHASH`) is disabled. Reset with
  `docker compose exec h6ai rm /srv/www/_h6ai/private/data/auth.json`.
* Names of seeded files are mirrored in `lib.mjs`. Keep them in sync with `docker/seed.sh`.
* `lib.mjs` sends paths byte-for-byte (no URL normalisation), so traversal probes such as
  `/%2e%2e/` really reach the server.
