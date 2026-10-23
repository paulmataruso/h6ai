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

Get `h6ai-1.0.0-dropin.zip` (a release download, or `npm run release` in a git checkout, which
writes it to `build/`). It contains one folder, `_h6ai`. Unzip it into the web root:

```sh
cd /var/www/html
sudo unzip ~/h6ai-1.0.0-dropin.zip
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
}
```

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
| Fast downloads | nginx sends big files after h6ai's check | see [Troubleshooting](#11-troubleshooting); until then PHP sends them, which works but holds a PHP worker per download |
| Request bodies | PHP leaves them to h6ai (`_h6ai/public/.user.ini`) | the server ignores `.user.ini` files (`user_ini.filename` is empty); h6ai still refuses multipart requests itself |
| Server version | nginx's own header hides its version | optional: `server_tokens off;` in `nginx.conf` |

Red banners at the top of the admin page point out anything urgent.

## 7. How it works

* **Every request reaches h6ai.** The web root has no files of yours, so nginx answers almost
  everything with 404 or 403, and `error_page` hands that to h6ai with the original URL. h6ai
  serves `robots.txt` and `sitemap.xml`, renders folders, and checks permissions for files. It
  logs downloads and sandboxes HTML, SVG and XML with a Content-Security-Policy, exactly like the
  native and Docker installs.
* **Big files at nginx speed.** For files of 4 MiB and more, h6ai answers with an
  `X-Accel-Redirect` to a link inside `_h6ai/private/cache` whose name is a secret derived from
  your installation. nginx then sends the file itself: sendfile, Range requests, resume, ETag. The
  admin page checks once that nginx does this (**Fast downloads**). Smaller files, PHP files of
  the share and active documents are sent by PHP, with Range and ETag as well.
* **Private data stays private.** Users, settings, the secret, the activity log and login rate
  limits are stored as `.php` files whose first line answers 404 and stops. When anyone requests
  them over the web, PHP runs that line; their content never leaves the server.
* **PHP never parses request bodies.** `_h6ai/public/.user.ini` sets
  `enable_post_data_reading = Off`, and h6ai reads its JSON and form posts itself. PHP's multipart
  parser, the trigger of CVE-2026-109618, never runs, and multipart requests get 415.
* **h6ai's own assets** (CSS, JS, thumbnails) are requested through h6ai with versioned URLs. They
  get the headers h6ai's nginx snippet would set: cacheable for a year, gzipped, nosniff.

## 8. Moving from h5ai or a web root full of files

If your files are in the web root today (the classic h5ai layout):

```sh
sudo mkdir -p /srv/files
cd /var/www/html
sudo find . -mindepth 1 -maxdepth 1 ! -name _h6ai ! -name _h5ai -exec mv -t /srv/files/ {} +
```

Then follow steps 2 to 5 (an old `_h5ai` folder can be deleted). The URLs of your files don't
change: `/docs/report.pdf` is still `/docs/report.pdf`.

Without moving them, h6ai still works, and the System tab says so: nginx then hands out the
files in the web root directly. Folder rules only hide entries, and direct links neither reach
the activity log nor get the HTML sandbox.

## 9. HTTPS and reverse proxies

* **TLS on this nginx:** add it to the server block as usual, e.g. `sudo certbot --nginx -d
  files.example.com`. h6ai notices HTTPS and marks its cookies `Secure`.
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
| Fast downloads stay off | nginx can't follow the link: `disable_symlinks` is on, or the nginx user can't read the files folder or traverse `_h6ai/private/cache` (`chmod 755` it); with SELinux, label the files folder (step 3) |
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
