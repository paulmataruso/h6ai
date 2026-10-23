# Drop-in install (unzip into your web root)

The h5ai way. You already run nginx with PHP: unzip one folder into the web root, add one line to
the server block, and finish the setup in the browser. No installer, and no shell needed for
the setup. Other ways to install: [native](native.md), [Docker](docker.md), or the
[overview](../INSTALL.md).

```
web root /var/www/html            files folder /srv/files (outside the web root)
└── _h6ai/  ◀── h6ai              ├── docs/
                                   └── videos/

browser ──▶ nginx: "no such file in the web root" ──error_page──▶ h6ai
                     h6ai: listing, or a file after the permission check, logging, sandbox
                     big files go back to nginx (X-Accel-Redirect) to send at full speed
```

Your files live outside the web root, so nginx can't hand them out on its own: every request
reaches h6ai first. That gives a drop-in the same feature set as the native and Docker installs:
* folder permissions also cover direct links;
* downloads are logged;
* HTML and SVG files are sandboxed;
* `robots.txt` and `sitemap.xml` are generated.

## Contents

1. [Requirements](#1-requirements)
2. [Unzip h6ai into the web root](#2-unzip-h6ai-into-the-web-root)
3. [The files folder](#3-the-files-folder)
4. [The nginx line](#4-the-nginx-line)
5. [First run in the browser](#5-first-run-in-the-browser)
6. [The drop-in checks](#6-the-drop-in-checks)
7. [How it works](#7-how-it-works)
8. [Moving from h5ai or a web root full of files](#8-moving-from-h5ai-or-a-web-root-full-of-files)
9. [HTTPS and reverse proxies](#9-https-and-reverse-proxies)
10. [Upgrade, backup, uninstall](#10-upgrade-backup-uninstall)
11. [Troubleshooting](#11-troubleshooting)
12. [Differences from native and Docker](#12-differences-from-native-and-docker)

## 1. Requirements

* nginx with PHP-FPM **8.2 or later**, with the `gd` and `mbstring` extensions. Optional: `exif`
  (photo orientation), `zip`, ffmpeg (video thumbnails), Ghostscript (PDF thumbnails).
* A server block (site) for h6ai whose web root contains nothing but `_h6ai`. A subdomain such as
  `files.example.com` is ideal. The line from step 4 sends every "not found" of that server
  block to h6ai, so don't share the block with another site.
* The usual PHP location in that block: `location ~ \.php$ { … fastcgi_pass …; }`.
* A way to put files on the server: shell, SFTP, FTP or a file manager.

Check the PHP version and extensions:

```sh
php -v
php -m | grep -E '^(gd|mbstring|exif)$'
```

On Debian and Ubuntu, `sudo apt install php-fpm php-gd php-mbstring` installs everything needed;
on Fedora and RHEL, `sudo dnf install php-fpm php-gd php-mbstring`.

## 2. Unzip h6ai into the web root

Get `h6ai-1.0.1-dropin.zip` (a release download, or `npm run release` in a git checkout, which
writes it to `build/`). It contains one folder, `_h6ai`. Unzip it into the web root:

```sh
cd /var/www/html
sudo unzip ~/h6ai-1.0.1-dropin.zip
sudo rm -f index.html index.nginx-debian.html   # a default welcome page would win over h6ai
```

With FTP or a file manager: upload the zip and extract it there, or extract locally and upload
the `_h6ai` folder.

Let PHP write three folders. Skip this where PHP runs as your own user (most shared hosting):

```sh
# PHP-FPM's user: www-data on Debian and Ubuntu, apache on RHEL and Fedora, nobody on Alpine
grep -h '^user' /etc/php/*/fpm/pool.d/www.conf /etc/php-fpm.d/www.conf 2>/dev/null
sudo chown -R www-data: _h6ai/private/data _h6ai/private/cache _h6ai/public/cache
```

## 3. The files folder

The folder to share must be **outside the web root** and readable for PHP:

```sh
sudo mkdir -p /srv/files
sudo cp -r ~/my-files/* /srv/files/        # or move your files there
sudo chmod -R o+rX /srv/files              # readable for PHP and nginx
```

h6ai never writes there. URLs follow the folder: `/srv/files/docs/report.pdf` is
`https://files.example.com/docs/report.pdf`.

On SELinux systems (RHEL, Fedora) let nginx and PHP-FPM read it, and PHP write its own folders:

```sh
sudo semanage fcontext -a -t httpd_sys_content_t '/srv/files(/.*)?'
sudo semanage fcontext -a -t httpd_sys_rw_content_t '/var/www/html/_h6ai/(public/cache|private/cache|private/data)(/.*)?'
sudo restorecon -R /srv/files /var/www/html/_h6ai
```

## 4. The nginx line

Add one line to the server block, next to the PHP location:

```nginx
error_page 403 404 = /_h6ai/public/index.php;
```

Debian and Ubuntu, a complete site (`/etc/nginx/sites-available/default` or your own):

```nginx
server {
    listen 80;
    server_name files.example.com;
    root /var/www/html;
    index index.html index.htm index.php;

    location / {
        try_files $uri $uri/ =404;
    }
    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;   # your PHP version
    }

    error_page 403 404 = /_h6ai/public/index.php;
    log_not_found off;

    location ^~ /_h6ai/private/ {
        internal;
    }
}
```

The last two parts are recommended, not required:
* `log_not_found off;` keeps nginx from writing an `[error]` line for every request it hands to
  h6ai: to nginx each one is a file it didn't find.
* `location ^~ /_h6ai/private/ { internal; }` closes the links h6ai hands big files back through
  (section 7) to requests from outside. Their names are secret, but a secret can leak, for example
  through a log format that records `$uri`. The location also keeps your other locations away from
  big files: a caching rule for `.mp4` or `.zip` would otherwise give them its own headers and
  logging. The admin page's **Secret links** and **Big files** checks show both.

Fedora and RHEL: their PHP location comes from `/etc/nginx/default.d/php.conf`. Add the
`error_page` line to the server block in `/etc/nginx/nginx.conf`, or to your own site in
`/etc/nginx/conf.d/`.

Then test and reload:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

Notes:
* Keep `try_files $fastcgi_script_name =404;` in the PHP location (Debian's
  `snippets/fastcgi-php.conf` has it). Without it, `.php` files of your share would get PHP's
  "File not found." instead of h6ai.
* No other `error_page` for 403 or 404 in this server block.
* `index` may list anything; h6ai doesn't depend on it.
* Adding h6ai to a server block that already has a lot in it (logs, caching rules, basic auth,
  HTTP/3)? See [section 8](#8-moving-from-h5ai-or-a-web-root-full-of-files).

## 5. First run in the browser

Open `https://files.example.com/_h6ai/public/`. **Set up h6ai** asks for two things:

1. **Files folder**: `/srv/files`. h6ai warns right away if it doesn't exist, can't be read, or
   is inside the web root.
2. **Password** for the first login.

**Create the setup file** then shows an `options.local.php` (password hash and files folder) and
offers it for download:

```
<?php http_response_code(404); exit; ?>
{
    "passhash": "$2y$10$…",
    "filesFolder": "/srv/files"
}
```

Save it as `_h6ai/private/conf/options.local.php` on the server, by FTP, file manager or shell.
Its first line makes PHP answer 404 if anyone requests it over the web. Saving it is also the
proof that you own the server: h6ai never writes this file itself, so nobody can claim a fresh
install before you.

Reload the page, log in as `admin` with the password you chose, and create your own admin account
under **Access → Users**. The setup password stops working once an admin account exists.

With a shell you can skip the setup file:

```sh
sudo -u www-data php /var/www/html/_h6ai/private/bin/h6ai-user.php add yourname --admin
echo '<?php http_response_code(404); exit; ?>
{"filesFolder": "/srv/files"}' | sudo tee /var/www/html/_h6ai/private/conf/options.local.php
```

## 6. The drop-in checks

**System → Drop-in install** tests, from your browser, what the server actually does:

| Check | Means | If it fails |
|---|---|---|
| Files folder | outside the web root | move the files out and point `filesFolder` at the new place |
| Routing | nginx hands unknown paths to h6ai | the `error_page` line is missing, or another `error_page` overrides it |
| Private data | `_h6ai/private/` can't be read over the web | the server sends `.php` files as text: PHP must run for every `.php` file (the usual location) |
| Private cache | nginx doesn't list it (it holds the secret file links) | `autoindex on` plus an `index` without `index.php`; add `index.php` to `index` |
| Fast downloads | nginx sends big files after h6ai's check, for every file type | see [Troubleshooting](#11-troubleshooting); until then PHP sends them, which works but holds a PHP worker per download |
| Big files | nginx sends what h6ai hands back as it is (h6ai's `Cache-Control`), for every file type | a location of the server block catches them (typically a caching rule for `.mp4`, `.zip`, …): add the internal location from step 4 |
| Secret links | the links h6ai hands big files through are refused from outside | recommended: the internal location from step 4 |
| File types | nginx hands requests for every file type to h6ai | a location of the server block answers some types itself; the banner names them. Most often the PHP location lacks its "not found" check (step 4 notes) |
| Request bodies | PHP leaves them to h6ai (`_h6ai/public/.user.ini`) | the server ignores `.user.ini` files (`user_ini.filename` is empty); h6ai still refuses multipart requests itself |
| Server version | nginx's own header hides its version | optional: `server_tokens off;` in `nginx.conf` |

Red banners at the top of the admin page point out anything urgent. The checks send your browser's
credentials, so they also work on a site behind basic auth. Under **System**, **Old h5ai folder**
reports an h5ai install left in the files folder.

## 7. How it works

* **Every request reaches h6ai.** The web root has no files of yours, so nginx answers almost
  everything with 404 or 403, and `error_page` hands that to h6ai with the original URL. h6ai
  serves `robots.txt` and `sitemap.xml`, renders folders, and checks permissions for files. It
  logs downloads and sandboxes HTML, SVG and XML with a Content-Security-Policy, exactly like the
  native and Docker installs.
* **Big files at nginx speed.** For files of 4 MiB and more, h6ai answers with an
  `X-Accel-Redirect` to a link inside `_h6ai/private/cache` whose name is a secret derived from
  your installation. nginx then sends the file itself: sendfile, Range requests, resume, ETag. The
  admin page checks once that nginx does this (**Fast downloads**), for a dozen file types. Smaller
  files, PHP files of the share and active documents are sent by PHP, with Range and ETag as well.
  With the internal location from step 4, only nginx itself can follow those links.
* **Every file type reaches h6ai.** The admin page requests made-up files of about 70 types; h6ai
  notes each one that arrives (**File types**). A location of your own that answers some types
  without handing them over shows up there.
* **Nothing inside `_h5ai`.** An h5ai install left in the files folder is never listed, searched,
  archived or served, also on direct links: its `options.json` holds h5ai's password hash.
* **Private data stays private.** Users, settings, the secret, the activity log and login rate
  limits are stored as `.php` files whose first line answers 404 and stops. When anyone requests
  them over the web, PHP runs that line; their content never leaves the server.
* **PHP never parses request bodies.** `_h6ai/public/.user.ini` sets
  `enable_post_data_reading = Off`, and h6ai reads its JSON and form posts itself. PHP's multipart
  parser, the trigger of CVE-2026-109618, never runs, and multipart requests get 415.
* **h6ai's own assets** (CSS, JS, thumbnails) are requested through h6ai with versioned URLs. They
  get the headers h6ai's nginx snippet would set: cacheable for a year, gzipped, nosniff.

## 8. Moving from h5ai or a web root full of files

The classic h5ai layout: your files in the web root, `_h5ai` next to them, and an `index` line in
the server block that ends in `/_h5ai/public/index.php`. There are two ways to a drop-in.

**Point the server block at a new web root (recommended, nothing moves).** Unzip h6ai (step 2) into
a new, empty folder, point the server block's `root` at it, and enter the old web root as the files
folder in the first run (step 5):

```sh
sudo mkdir -p /var/www/files-h6ai && cd /var/www/files-h6ai   # holds nothing but _h6ai
sudo unzip ~/h6ai-1.0.1-dropin.zip
# server block: root /var/www/files-h6ai;   first run: files folder /var/www/html
```

That suits big shares and network mounts best. The URLs of your files don't change:
`/docs/report.pdf` is still `/docs/report.pdf`.

**Or move the files out of the web root:**

```sh
sudo mkdir -p /srv/files
cd /var/www/html
sudo find . -mindepth 1 -maxdepth 1 ! -name _h6ai ! -name _h5ai -exec mv -t /srv/files/ {} +
```

Either way:
1. **Replace h5ai's `index` line** with `index index.php;` and the `error_page` line from step 4.
   While the old line and `_h5ai` are both there, h5ai keeps answering the start page.
2. **Move `_h5ai` out of the files folder** (keep a copy if you want a way back). h6ai never lists,
   searches, archives or serves anything inside an `_h5ai` folder, but it holds h5ai's settings and
   password hash. **System → Old h5ai folder** shows it until it's gone.
3. **Remove h5ai's own locations**: `location /_h5ai/private { … }`, and an internal location you
   set up for h5ai's `X-Accel-Redirect`. The internal location from step 4 takes its place; move
   settings such as `limit_req` or `aio threads` into it.

Without moving the files, h6ai still works, and the System tab says so: nginx then hands out the
files in the web root directly. Folder rules only hide entries, and direct links neither reach
the activity log nor get the HTML sandbox.

### A server block that has grown around h5ai

Everything that doesn't change how files are found keeps working, because h6ai's answers pass
through your server block like any other: TLS (certbot), HTTP/2 and HTTP/3, `access_log` and
`error_log` lines and their formats, basic auth, rate limits, `sendfile` and other tuning,
custom 401, 429, 503 and 504 pages, redirects. No reverse proxy is involved. What to check:

| In your server block | With h6ai |
|---|---|
| `error_page 404 …` or `error_page 403 …` (your own "not found" page) | Remove it: those two codes are how nginx hands requests to h6ai, which shows its own "not found" page. |
| `access_log` inside a location, e.g. a statistics log in the PHP location | A location's `access_log` replaces the server block's, and requests for your files now end in the PHP location (big files in the internal location). Keep the logs at server level. |
| `$uri` in a `log_format` or `map` | After the hand-over `$uri` is `/_h6ai/public/index.php`, for big files h6ai's internal link with its secret name. Use `$request_uri` or `$request`: they keep the visitor's URL. |
| A caching rule for static files: `location ~* \.(jpg\|css\|js\|mp4\|zip)$ { expires 30d; … }` | Only h6ai's own files match it now, since yours aren't in the web root. Keep it away from big files with the internal location from step 4: otherwise nginx sends protected files as `public` for 30 days, and its `access_log off` hides the downloads. |
| A cache for h5ai in front of PHP (`fastcgi_cache`, hashing request bodies, `fastcgi_hide_header Set-Cookie`) | Remove it. Hiding `Set-Cookie` stops every sign-in, the admin's included, and a cache keyed without the session hands one visitor's protected listing or file to the next. |
| `limit_conn` or `limit_req` in the PHP location | Now counts every request for your files, downloads included. |
| `client_max_body_size 10G` or similar | h6ai takes no uploads over HTTP: `1m` is plenty. |
| The PHP location | Keep its "not found" check: `try_files $fastcgi_script_name =404;` or `if (!-f $document_root$fastcgi_script_name) { return 404; }`. For folder downloads (zip, tar) at full speed add `fastcgi_buffer_size 256k; fastcgi_buffers 16 256k; fastcgi_busy_buffers_size 512k;`. |
| `ssl_early_data on` (TLS 0-RTT) | Add `fastcgi_param HTTP_EARLY_DATA $ssl_early_data;` to the PHP location ([section 9](#9-https-and-reverse-proxies)). |
| `auth_basic` for the whole site | Works, admin checks included. Pick one gate, though: keep basic auth and let everyone past it browse (Visitors → "Anonymous, no sign-in" hides h6ai's sign-in from them), or drop it and give people h6ai accounts with per-folder permissions. |

A tested example of such a server block, with all of the above:
[`test-native/dropin-custom.conf`](../../test-native/dropin-custom.conf) (lines marked `@…` are
switched by its test, `test-native/dropin-custom.sh`).

## 9. HTTPS and reverse proxies

* **TLS on this nginx:** add it to the server block as usual, e.g. `sudo certbot --nginx -d
  files.example.com`. h6ai notices HTTPS and marks its cookies `Secure`. HTTP/2 and HTTP/3
  (`http2 on;`, `listen 443 quic;`) need nothing from h6ai.
* **TLS early data** (`ssl_early_data on;`, 0-RTT): a request sent in it can be replayed by anyone
  on the network path. Add this to the PHP location:

  ```nginx
  fastcgi_param HTTP_EARLY_DATA $ssl_early_data;
  ```

  h6ai then answers sign-ins, admin changes and other API requests sent as early data with
  `425 Too Early`, and the browser sends them again once the handshake is complete.
* **Behind a proxy or load balancer:** **System → Public address and reverse proxy**. Enter the
  address visitors use and the proxy's IP; the card shows where your own requests come from.

## 10. Upgrade, backup, uninstall

**Upgrade:** unzip the new `-dropin.zip` over the old one and overwrite. Your `options.local.php`,
users, settings and caches aren't in the zip, so they stay. If PHP has
`opcache.validate_timestamps=0`, reload PHP-FPM afterwards.

```sh
cd /var/www/html && sudo unzip -o ~/h6ai-1.1.0-dropin.zip
```

**Backup:** `_h6ai/private/data/` (users, permissions, settings, activity log) and
`_h6ai/private/conf/options.local.php`:

```sh
sudo tar czf h6ai-data-$(date +%F).tgz -C /var/www/html/_h6ai/private data conf/options.local.php
```

**Uninstall:** remove the `error_page` line, reload nginx, delete `/var/www/html/_h6ai`. Your files
folder is untouched.

## 11. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `/` works, every folder is 404 | the `error_page` line is missing (or overridden): step 4 |
| `/` shows a different page | the web root has its own `index.html` (e.g. `index.nginx-debian.html`): delete it |
| Folders are empty | the files folder isn't set or can't be read: System → Drop-in install |
| `.php` files of the share say "File not found." | the PHP location lacks `try_files $fastcgi_script_name =404;` |
| Fast downloads stay off | nginx can't follow the link: `disable_symlinks` is on, or the nginx user can't read the files folder or traverse `_h6ai/private/cache` (`chmod 755` it); with SELinux, label the files folder (step 3). Or one file type doesn't arrive (**Big files**): add the internal location from step 4 |
| Banner "nginx replaces h6ai's headers on big … files" | a location of the server block (a caching rule) catches what h6ai hands back: add the internal location from step 4 |
| Banner "nginx answers requests for .php files itself" | the PHP location lacks its "not found" check (step 4 notes). For other types: a location of your own that answers without a 404 |
| "cross-origin request rejected" from scripts, on a port other than 80/443 | Debian's `fastcgi_params` passes `HTTP_HOST $host`, which drops the port (browsers still sign in). Add `fastcgi_param HTTP_HOST $http_host;` after the include |
| Red banner "sends .php files … as plain text" | PHP doesn't run for all `.php` files; use the usual `location ~ \.php$` |
| `502 Bad Gateway` | PHP-FPM isn't running, or `fastcgi_pass` points to the wrong socket |
| Locked out after failed logins | wait 15 minutes, or delete `_h6ai/private/cache/ratelimit-*` |
| Lost the admin password | `sudo -u www-data php _h6ai/private/bin/h6ai-user.php passwd NAME` |

## 12. Differences from native and Docker

Features are the same. What differs is what belongs to your server:

* **nginx's `Server` header** shows its version unless `nginx.conf` has `server_tokens off;`.
  That is a server-wide setting h6ai doesn't touch.
* **Files of 4 MiB and more** come from nginx after h6ai's check. nginx keeps only a few of h6ai's
  headers then, so they lack `X-Content-Type-Options: nosniff`. That's media, archives and disk
  images, which browsers don't sniff into anything dangerous. Smaller files and every HTML, SVG
  or XML file are sent by PHP with all headers.
* **Small files go through PHP**, so each holds a PHP-FPM worker for a moment. On a very busy
  site, raise `pm.max_children`, or use the native or Docker install, where nginx sends every
  file.
* **Large-file tuning** (sendfile, thread pools, open file cache) is your nginx's configuration.
  The native and Docker installs bring h6ai's (`deploy/nginx/large-files.conf`).
