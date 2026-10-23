# Installing h6ai

Three ways to run h6ai. Pick one; each has a step-by-step guide.

| | [Native](install/native.md) | [Docker](install/docker.md) | [Drop-in](install/dropin.md) |
|---|---|---|---|
| What it is | nginx and PHP-FPM on the server's OS (bare metal or VM), set up by `install.sh` | one container with its own nginx and PHP-FPM | `_h6ai` unzipped into the web root of the nginx + PHP you already run |
| You need | root on Debian, Ubuntu, Fedora, RHEL/Rocky/Alma or Alpine | Docker with the Compose plugin | nginx + PHP 8.2, one line in the server block, FTP or a shell |
| Setup | `sudo ./install.sh --native` | `sudo ./install.sh --docker`, or `docker compose up -d` | unzip, add the line, finish in the browser |
| Your files | any folder; nginx serves them after h6ai's check | a host folder mounted into the container | a folder outside the web root; h6ai checks, nginx sends big files |
| Upgrade | run the new release's `install.sh` | run the new `install.sh`, or `git pull` and `up -d --build` | unzip the new release over it |
| Best for | a dedicated server or VM | any host with Docker, a clean host | an existing web server, shared hosting with nginx |

All three have the same features: folder permissions that also cover direct links, download-only
accounts and folder groups, anonymous mode, the activity log, Google integration, the HTML sandbox
and the CVE-2026-109618 hardening. They differ in what they set up for you; see the end of each
guide.

## Get h6ai

A release has two downloads:

* `h6ai-<version>.tar.gz` (or `.zip`): the installer bundle for native and Docker installs.
  Contains `install.sh`, `deploy/`, the Docker files and the built `_h6ai`.
* `h6ai-<version>-dropin.zip` (or `.tar.gz`): just the `_h6ai` folder, for a drop-in.

To build both from a git checkout (needs Node.js 20 or later):

```sh
npm ci
npm run release        # build/h6ai-<version>.{tar.gz,zip} and build/h6ai-<version>-dropin.{tar.gz,zip}
```

## One installer for native and Docker

```sh
tar xzf h6ai-1.0.0.tar.gz && cd h6ai-1.0.0
sudo ./install.sh              # asks: 1) natively on this system  2) in Docker
```

`--native` or `--docker` skips the question. Running it again upgrades, and `--uninstall`
removes it. `./install.sh --help` lists all options.

## After any install

* **Users from the shell.** `h6ai-user` creates admins, resets lost passwords and lists accounts:

  ```sh
  h6ai-user list
  h6ai-user add NAME --admin          # asks for the password
  h6ai-user add NAME --anon           # a download-only account
  h6ai-user passwd NAME               # new password, signs the user out everywhere
  h6ai-user disable NAME | enable NAME
  ```

  How to run it:
  * Native: as a command.
  * Docker: as a command after `install.sh --docker`; otherwise prefix it with
    `docker compose exec h6ai`.
  * Drop-in: `php _h6ai/private/bin/h6ai-user.php ...`, as PHP-FPM's user.
* **Options** that aren't on the admin page go into `_h6ai/private/conf/options.local.json` (or
  `options.local.php` on a drop-in). Upgrades keep it; the README lists the common ones.
* **The admin page's System tab** shows whether everything works: PHP, tools, writable folders,
  the CVE fix, and on a drop-in the [drop-in checks](install/dropin.md#6-the-drop-in-checks).

## Your own nginx configuration

To add h6ai to an existing server block with all of h6ai's nginx settings (the file gate on your
web root, large-file tuning), include the snippets from `deploy/nginx/` by hand:
[DEPLOYMENT.md](DEPLOYMENT.md).
