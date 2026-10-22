# Deploying h6ai on nginx + PHP-FPM

The Docker image (`Dockerfile`, `docker/`) is the reference setup. This page explains the parts you
need when integrating h6ai into your own nginx.

## 1. Install

```sh
npm ci && npm run build
cp -r build/_h6ai /srv/www/_h6ai          # your web root
chown -R www-data: /srv/www/_h6ai/private/cache /srv/www/_h6ai/private/data /srv/www/_h6ai/public/cache
```

Requirements: PHP ≥ 8.2 (FPM) with `gd` (JPEG, optionally WebP/AVIF), `exif`, `opcache`. Optional
tools: `ffmpeg` (video thumbnails), ImageMagick + Ghostscript (PDF thumbnails), `zip`, GNU `tar`,
`du`, `timeout`.

## 2. nginx server block

```nginx
server {
    root /srv/www;
    absolute_redirect off;

    location / {
        # File gate: nginx asks h6ai before serving any file (needed for folder permissions).
        set $h6ai_gate_uri $uri;
        auth_request /_h6ai_auth;
        auth_request_set $h6ai_cc $upstream_http_x_h6ai_cache_control;
        add_header Cache-Control $h6ai_cc always;

        index index.html index.htm /_h6ai/public/index.php;
        try_files $uri $uri/ =404;
    }

    location = /_h6ai_auth {
        internal;
        fastcgi_pass_request_body off;
        fastcgi_param SCRIPT_FILENAME /srv/www/_h6ai/public/index.php;
        fastcgi_param SCRIPT_NAME     /_h6ai/public/index.php;
        fastcgi_param REQUEST_METHOD  GET;
        fastcgi_param REQUEST_URI     $request_uri;
        fastcgi_param H6AI_GATE_URI   $h6ai_gate_uri;
        fastcgi_param H6AI_GATE_METHOD $request_method;   # HEAD requests aren't logged
        fastcgi_param H6AI_GATE       check;
        fastcgi_param REMOTE_ADDR     $remote_addr;
        fastcgi_param SERVER_SOFTWARE nginx/$nginx_version;
        fastcgi_param HTTPS           $https if_not_empty;
        fastcgi_param CONTENT_LENGTH  "";
        fastcgi_param CONTENT_TYPE    "";
        fastcgi_pass unix:/run/php/php-fpm.sock;
    }

    location = /_h6ai/public/index.php {
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        fastcgi_param H6AI_GATE "";            # never let the gate flag leak into normal requests
        fastcgi_read_timeout 3600s;            # long archive downloads
        fastcgi_pass unix:/run/php/php-fpm.sock;
    }

    location ^~ /_h6ai/public/ {
        index index.php;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location ^~ /_h6ai/ { deny all; }          # private dir, sources, docs
}
```

Notes:

* `H6AI_GATE` must only ever be set by nginx (a FastCGI param). Clients can't set it, because request
  headers arrive as `HTTP_*` variables.
* `$h6ai_gate_uri` is captured in `location /` because inside the subrequest `$uri` is
  `/_h6ai_auth`. It's re-evaluated after internal redirects, so `/folder/` → `/folder/index.html` is
  checked as well.
* Without any permission rules the gate answers 204 immediately. You can leave it out if you never
  plan to use permissions, but then **direct file URLs are not protected**.
* Behind a TLS-terminating proxy, pass `X-Forwarded-Proto` so h6ai sets `Secure` cookies, and make
  sure the `Host` header the browser sends reaches PHP unchanged: login checks `Origin` against it.

### Hardening (recommended, see SECURITY.md)

```nginx
# server {} level: h6ai never needs multipart bodies or other methods (CVE-2026-109618)
if ($request_method !~ ^(GET|HEAD|POST)$) { return 405; }
if ($content_type ~* "^\s*multipart/") { return 415; }

# inside location /: user supplied HTML/SVG/XML is served without script (CVE-2026-10961)
location ~* \.(?:html?|xhtml|shtml|svgz?|xml|xslt?|mht|mhtml)$ {
    set $h6ai_gate_uri $uri;                       # repeated: nested locations don't inherit it
    auth_request /_h6ai_auth;
    auth_request_set $h6ai_cc $upstream_http_x_h6ai_cache_control;
    add_header Cache-Control $h6ai_cc always;
    add_header X-Content-Type-Options nosniff always;
    add_header Content-Security-Policy "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:" always;
    try_files $uri =404;
}
```

And in the PHP endpoint location: `client_max_body_size 1m;`. The complete, tested version is
`docker/nginx/h6ai.conf`.

### Search engines

```nginx
location = /robots.txt  { try_files $uri /_h6ai/public/index.php$is_args$args; }
location = /sitemap.xml { try_files $uri /_h6ai/public/index.php$is_args$args; }
```

h6ai generates both unless a real file exists. Indexing, the sitemap, Google Search Console
verification and Google Analytics / Tag Manager are configured on the admin page
(**Google & SEO** tab). Only content an anonymous visitor may read is ever listed.

## 3. Large files

nginx serves all file bytes. Recommended `http {}` settings (see `docker/nginx/nginx.conf`):

```nginx
sendfile on; tcp_nopush on; tcp_nodelay on;
aio threads; directio 16m; output_buffers 2 1m;
open_file_cache max=10000 inactive=60s; open_file_cache_valid 60s; open_file_cache_errors on;
gzip on; gzip_types text/plain text/css application/javascript application/json image/svg+xml text/markdown;
```

Range requests (resume, video seeking), `ETag`/`Last-Modified` and `304` work out of the box. Files
in protected folders are sent with `Cache-Control: private, no-cache`, public ones with
`public, no-cache` (cacheable, always revalidated).

Archives are streamed by PHP with `X-Accel-Buffering: no`, so nginx doesn't spool them to disk. PHP
needs `output_buffering=Off`, `zlib.output_compression=Off` and `max_execution_time=0`.

## 4. PHP-FPM

See `docker/php/conf.d/h6ai.ini` and `docker/php/fpm-pool.conf`. The important bits:

* OPcache on. In production, `opcache.validate_timestamps=0` (restart FPM after upgrades).
* `realpath_cache_size=4096K`, `realpath_cache_ttl=600`: h6ai is filesystem heavy.
* `request_terminate_timeout=0`, so long downloads aren't killed.
* `clear_env=no` if you pass `H6AI_PASSHASH` through the environment.

## 5. First login and permissions

1. Set a bootstrap password: `php _h6ai/private/bin/h6ai-passhash.php`, then put the hash into
   `options.local.json` (`{"passhash": "..."}`) or the `H6AI_PASSHASH` env variable.
2. Open `/_h6ai/public/`, log in as `admin` with that password, and create a real admin user. The
   bootstrap password stops working as soon as an enabled admin exists.
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
