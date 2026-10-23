# Running h6ai on an nginx you configure yourself

Most installs should use the [native installer](install/native.md), [Docker](install/docker.md)
or a [drop-in](install/dropin.md) (unzip `_h6ai`, one nginx line); see [INSTALL.md](INSTALL.md).
This page is for wiring h6ai into a server block of your own by hand, with h6ai's nginx snippets:
nginx then serves the web root itself and asks h6ai about every file (`auth_request`). The
pieces are the same ones the installer and the Docker image use, from `deploy/`. Once
`server.conf` is included, h6ai no longer runs as a drop-in.

## 1. Install the application

```sh
npm ci && npm run build            # or take _h6ai from a release bundle
sudo deploy/install-app.sh build/_h6ai /srv/www/_h6ai www-data
```

`install-app.sh SOURCE TARGET USER` copies the code (root owned, read-only for PHP) and makes
`public/cache`, `private/cache` and `private/data` writable for `USER`, the account PHP-FPM runs
as. Re-run it to upgrade: options, data and caches are kept.

Requirements: PHP ≥ 8.2 (FPM) with `gd` (JPEG, optionally WebP/AVIF), `exif`, `mbstring` and
`opcache`. Optional tools: `ffmpeg` (video thumbnails), Ghostscript or ImageMagick (PDF
thumbnails), `zip`, GNU `tar`, `du`, `timeout`.

## 2. nginx

Copy the snippets:

```sh
sudo mkdir -p /etc/nginx/h6ai
sudo cp deploy/nginx/http.conf deploy/nginx/server.conf deploy/nginx/large-files.conf /etc/nginx/h6ai/
sudo cp -n deploy/nginx/trusted-html.map /etc/nginx/h6ai/
```

Then a site, at `http {}` level (e.g. `/etc/nginx/conf.d/h6ai.conf`):

```nginx
include h6ai/http.conf;

upstream h6ai_php {
    server unix:/run/php/php8.3-fpm.sock;      # your PHP-FPM pool
}

server {
    listen 80;
    server_name files.example.com;
    root /srv/www;                              # the folder with _h6ai in it

    include h6ai/large-files.conf;              # optional: sendfile, aio threads, gzip for text
    include h6ai/server.conf;
}
```

`server.conf` is everything h6ai needs inside the server block:

* **File gate.** `location /` asks PHP about every file before nginx serves it (`auth_request`),
  so folder permissions also cover direct links. PHP answers 204, 401 or 403 and can set
  `Cache-Control`. Folders without an `index.html` are rendered by h6ai.
* **Only `/_h6ai/public/index.php` runs.** `.php` files in the share are plain data, and
  `/_h6ai/private/` and the rest of `/_h6ai/` are denied.
* **CVE-2026-109618 hardening.** Methods other than GET/HEAD/POST get 405, multipart bodies 415,
  bodies over 1 MiB 413, before PHP sees them.
* **CVE-2026-10961 hardening.** HTML, SVG and XML files from the share are served with a sandbox
  CSP (no script). Trusted prefixes can opt out in `trusted-html.map`.
* `robots.txt` and `sitemap.xml` are generated unless real files exist.

Notes:

* `H6AI_GATE` must only ever be set by nginx (a FastCGI param). Clients can't set it, because
  request headers arrive as `HTTP_*` variables.
* `$h6ai_gate_uri` is captured in `location /` because inside the subrequest `$uri` is
  `/_h6ai_auth`. It's re-evaluated after internal redirects, so `/folder/` → `/folder/index.html`
  is checked as well.
* Without any permission rules the gate answers 204 immediately.
* Behind a reverse proxy, set the public address and the proxy's IP or range under **Admin →
  System → Public address and reverse proxy**. h6ai then believes the proxy's
  `X-Forwarded-For/-Proto/-Host`: real visitor addresses in logs and rate limits, `Secure` cookies,
  and logins checked against the public address. `server.conf` passes the `Host` header as sent
  (`$http_host`; some distributions' `fastcgi_params` pass `$host`, which drops the port).
* nginx's own access log keeps showing the proxy's address. For visitor addresses there too, add
  `set_real_ip_from <proxy>;` and `real_ip_header X-Forwarded-For;` to the server block.
* `aio threads` needs nginx built `--with-threads` (all major distributions are). Comment it out
  in `large-files.conf` otherwise.

## 3. Large files

nginx serves all file bytes, with Range/resume, `ETag`/`Last-Modified` and `304` out of the box.
`large-files.conf` adds sendfile, thread-pool reads, `directio` for files ≥ 16 MiB and an open
file cache. Files in protected folders are sent with `Cache-Control: private, no-cache`, public
ones with `public, no-cache`.

Archives are streamed by PHP with `X-Accel-Buffering: no`, so nginx doesn't spool them to disk.
`server.conf` raises `fastcgi_buffer_size` to 256k, which makes archive streams ~6× faster than
the default (see `PERFORMANCE.md`). PHP needs `output_buffering=Off`,
`zlib.output_compression=Off` and `max_execution_time=0`.

For many parallel downloads, raise `worker_connections` (main nginx.conf, `events {}`) to a few
thousand and `worker_rlimit_nofile` accordingly.

## 4. PHP-FPM

`deploy/php/h6ai.ini` has all settings. A dedicated pool keeps them away from other PHP sites;
that's what the native installer does:

* the `opcache.*` and `realpath_cache_*` lines are process wide: put them into the FPM `conf.d`;
* every other line becomes a `php_admin_value[...]` of the h6ai pool (`${VAR:-default}` means
  `default`);
* `session.save_path` should be a folder only the pool's user can read;
* `request_terminate_timeout = 0`, so long archive downloads aren't killed.

The OPcache settings matter most: OPcache on, `realpath_cache_size=4096K` and
`realpath_cache_ttl=600` (h6ai is filesystem heavy).

## 5. First login and permissions

1. Create the first admin as the PHP-FPM user:
   `sudo -u www-data php /srv/www/_h6ai/private/bin/h6ai-user.php add admin --admin`.
   (Alternatively, the bootstrap password: `php _h6ai/private/bin/h6ai-passhash.php` prints a
   hash for `options.local.json` (`{"passhash": "..."}`) or the `H6AI_PASSHASH` env variable. Log
   in as `admin` with it and create a real admin user; it stops working once one exists.)
2. Open `/_h6ai/public/` and sign in.
3. Add users, roles and folder rules on the **Permissions** tab. For example, to make the whole site
   private and give the `staff` role read access:
   * `/` → `Everyone: none`
   * `/` → `Role: staff: download`

Users, roles, folder groups and rules are stored in `_h6ai/private/data/auth.json`, site settings
in `settings.json`, the activity log in `logs/`. Back up that directory.

### Folder groups and download-only accounts

* **Folder groups** (admin → Folder groups) are named lists of folders, e.g. `acme` =
  `/clients/acme/`, `/shared/brochures/`.
* Assign a group to a **user** or a **role** with a level (`list`, `read`, `download`).
* Account type **anon** = download-only account: it ignores "everyone" and role grants, so it
  sees nothing but its own folder groups (plus the parent folders needed to navigate there), gets
  no previews (clicking a file downloads it) and can't change its password.
