# h6ai in Docker (nginx + php-fpm)

One image, one container: **nginx** in the foreground (PID 1) and **php-fpm** behind it on
`127.0.0.1:9000`. It's meant for testing the modernised h6ai. The same layout works as a production
starting point once you replace the sample data with your own (see *Your own files*).

## Quick start

```sh
docker compose up --build -d
```

| What | URL |
|------|-----|
| File index | <http://172.16.1.67:8687/> |
| Info / admin page | <http://172.16.1.67:8687/_h6ai/public/> |

The bind address and port come from `H6AI_BIND` (default `172.16.1.67`) and `H6AI_PORT`
(default `8687`):

```sh
H6AI_BIND=127.0.0.1 H6AI_PORT=8080 docker compose up -d   # loopback only
```

**Admin login:** user `admin`, password `admin-test`. This is the *bootstrap admin*, taken from
`H6AI_PASSHASH` (a bcrypt hash in `compose.yaml`). It only works while no users exist in the user
database. Create real users on the admin page, then remove or change `H6AI_PASSHASH`.

Make a new hash with:

```sh
docker compose exec h6ai php -r 'echo password_hash("your-password", PASSWORD_DEFAULT), "\n";'
```

In `compose.yaml`, every `$` in the hash has to be written as `$$`.

## What's in the image

| Path | Purpose |
|------|---------|
| `/srv/www` | web root = **`./webroot` on the host** (bind mount). Put your files there. |
| `/opt/h6ai/_h6ai` | the h6ai build inside the image |
| `/srv/www/_h6ai` | h6ai as installed into the web root on every start (code read-only for PHP) |
| `/srv/www/_h6ai/private/data` | users, roles, folder groups, permissions, settings, activity log. **Named volume `h6ai-data`** |
| `/srv/www/_h6ai/private/cache` | rate limiter, folder-size, compiled config and command caches |
| `/srv/www/_h6ai/public/cache` | generated thumbnails (served statically, immutable) |
| `/srv/outside` | files *outside* the web root (traversal test targets), re-created on every start |

### Web root on the host

`./webroot/` (next to `compose.yaml`) is the web root. On every start the entrypoint copies the
current h6ai build from the image into `./webroot/_h6ai`. It replaces the code (`public/js`,
`public/css`, `public/images` (overlay, so extra icon themes survive), `public/index.php`,
`private/php`, `private/bin`, `private/conf/*.json`, `private/conf/l10n`) and never touches
`private/conf/options.local.json`, `private/data`, `private/cache`, `public/cache` or an existing
`public/ext`. Rebuilding the image therefore updates the app without touching your files.

Files you add under `./webroot/` show up immediately. Seeded files are owned by the owner of the
`./webroot` directory itself; the h6ai install is owned by root.

Config files (in this folder):

| File | Installed as |
|------|-------------|
| `nginx/nginx.conf` | `/etc/nginx/nginx.conf`: large-file tuning (sendfile, `aio threads`, `directio 16m`, `open_file_cache`), gzip for text types only |
| `nginx/h6ai.conf` | `/etc/nginx/http.d/h6ai.conf`: server, file gate, active-content sandbox, robots/sitemap routes, request limits, loopback-only fpm status server |
| `php/conf.d/h6ai.ini` | `/usr/local/etc/php/conf.d/zz-h6ai.ini`: OPcache + JIT, realpath cache, streaming, sessions, request input limits |
| `php/fpm-pool.conf` | `/usr/local/etc/php-fpm.d/zz-h6ai.conf`: pool sizing, loopback listener, status/ping |
| `imagemagick-policy.xml` | ImageMagick policy: resource limits, no network/script coders, PDF read-only |
| `options.local.json` | h6ai option overrides (bind-mounted, deep-merged over `options.json`) |

### File gate

Every request below `/` goes through nginx `auth_request` to PHP first
(`H6AI_GATE=check`, plus `H6AI_GATE_URI` = nginx's decoded `$uri` and `H6AI_GATE_METHOD` = the
client's method; request headers such as `Cookie`, `Range` and `Sec-Fetch-Dest` arrive as usual). PHP answers `204` (allowed),
`401` (guest denied) or `403` (user denied), and can set the file's `Cache-Control` through
`X-H6AI-Cache-Control`. nginx then serves the file itself, with sendfile, Range and ETag/304.
Internal redirects (e.g. `/site/` → `/site/index.html`) go through the gate again.

Only `/_h6ai/public/index.php` is ever executed. `.php` files in the share are served as plain
data. `/_h6ai/private/` and the rest of `/_h6ai/` (except `public/`) are denied.

`/robots.txt` and `/sitemap.xml` are served from the web root if such files exist, otherwise h6ai
generates them (indexing settings live in the admin UI). They are not gated.

### Security hardening

**CVE-2026-109618** (PHP: RCE via out-of-memory `longjmp` corruption, fixed in 8.2.35 / 8.3.36 /
8.4.27 / 8.5.12, advisory GHSA-w8hw-w9fx-j79w):

* The image is pinned to `php:8.3.36-fpm-alpine`. The build **fails** if the PHP version is an
  affected one (`--build-arg PHP_VERSION=...` can't accidentally downgrade).
* The bug's main trigger is multipart body parsing. h6ai never uses multipart or uploads, so nginx
  answers `415` for any `multipart/*` request and `405` for methods other than GET/HEAD/POST
  before PHP is involved; bodies over 1 MiB get `413`.
* PHP input limits: `file_uploads=Off`, `max_file_uploads=0`, `post_max_size=1M`,
  `max_multipart_body_parts=1`, `max_input_vars=5000`, `max_input_nesting_level=8`. No
  `RLIMIT_AS`/`RLIMIT_DATA` limits (they cause the `mmap()` failures the advisory warns about).
* The admin page's *System* tab shows whether the running PHP is fixed.

**CVE-2026-10961** (Chrome for iOS < 149.0.7827.53: sandbox escape via a crafted HTML page, needs
script in the renderer). h6ai can't patch browsers, but it no longer serves user-supplied active
documents as script-capable pages from its origin. Files ending in `.html .htm .xhtml .shtml .svg
.svgz .xml .xsl .xslt .mht .mhtml` (including an unmanaged folder's `index.html`) get
`Content-Security-Policy: sandbox; default-src 'none'; ...`: no script, no forms, opaque origin.
Images, styles and media inside such pages still load. Users should still update Chrome on iOS.

To host a trusted static site inside the share with working JavaScript, exempt its prefix in
`nginx/h6ai.conf`:

```nginx
map $uri $h6ai_trusted_html {
    default 0;
    ~^/my-trusted-site/   1;
}
```

### PHP tuning (environment overridable)

| Variable | Default | Notes |
|----------|---------|-------|
| `PHP_OPCACHE_VALIDATE_TIMESTAMPS` | `1` | set `0` in production (code is immutable in the image) |
| `PHP_OPCACHE_REVALIDATE_FREQ` | `2` | seconds between file checks when validating |
| `PHP_MEMORY_LIMIT` | `256M` | |

php-fpm status and ping live at `http://127.0.0.1:8081/fpm-status` and `/fpm-ping`, reachable
**only inside the container**. The healthcheck uses `/fpm-ping`, so it covers both nginx and php-fpm:

```sh
docker compose exec h6ai curl -s http://127.0.0.1:8081/fpm-status
```

The slow-request log (`request_slowlog_timeout=10s`) writes "executing too slow" warnings to the
container log. Stack traces need ptrace; to get them, uncomment `cap_add: [SYS_PTRACE]` in
`compose.yaml`. It isn't granted by default.

## Sample tree

`seed.sh` (with `seed-media.php` for deterministic images/PDF/binary data) fills the web root on
the first start, **but only if `./webroot` is empty** (apart from `_h6ai`). Your own files are
never overwritten. It creates images in every supported format, plus a decompression
bomb; short and long videos; markdown with XSS payloads; XSS file and folder names; hidden files; a
256+ byte path; a symlink loop; an unmanaged folder; unicode names; 150 files in `many/`;
`private/` and `team/` for permission tests; a deterministic 64 MiB `big/big.bin`; and active
documents with script (`docs/page.html`, `docs/vector.svg`) for the sandbox tests.

* Disable seeding: `H6AI_SEED=0`.
* Re-create the sample files: `H6AI_RESEED=1 docker compose up -d --force-recreate` (overwrites
  sample files of the same name, nothing else). The marker is `./webroot/.h6ai-seeded`.
* Start from scratch: `docker compose down && rm -rf ./webroot && docker compose up -d`.

### 7 GiB performance test file

`H6AI_SEED_BIG_GB` (compose default `7`) creates `big/big-7g.bin` with N GiB of **random** data
(real disk reads, not a sparse file), in the background after start-up. It takes about 3 minutes
(`docker compose logs -f h6ai | grep big`) and only happens in the seeded sample web root. It is
written as a hidden `.partial` file and renamed when complete. It's kept across rebuilds because
it lives in `./webroot`. Set `H6AI_SEED_BIG_GB=0` to skip it. See `docs/PERFORMANCE.md` for
benchmark results (`test-integration/bench.sh`).

## Your own files

Copy or move them into `./webroot/`. To serve an existing directory instead, point the bind
mount at it and turn seeding off, e.g. in a `compose.override.yaml`:

```yaml
services:
  h6ai:
    environment:
      H6AI_SEED: "0"
      H6AI_SEED_BIG_GB: "0"
    volumes:
      - /path/to/files:/srv/www
```

h6ai installs itself into `/path/to/files/_h6ai` (hidden in listings).

## Maintenance

```sh
docker compose logs -f h6ai                                      # nginx + php-fpm logs
docker compose exec h6ai sh -c 'rm -f /srv/www/_h6ai/private/cache/ratelimit-*.json'   # unlock logins
docker compose exec h6ai rm /srv/www/_h6ai/private/data/auth.json  # forget all users/rules
docker compose down -v                                           # remove container AND user volume (./webroot stays)
```
