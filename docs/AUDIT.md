# h5ai code & security audit

Baseline: upstream `lrsjng/h5ai` @ `aa94de49` (v0.30.0 of 2021-01-24, the last version and last commit; unmaintained since).
Scope: all PHP (`src/_h5ai/private/php`, `public/index.php`), all frontend JS/LESS/Pug,
config (`options.json`, `.htaccess`), build tooling and dependencies.

Severity scale: **Critical** / **High** / **Medium** / **Low** / **Info**.

---

## 1. Security findings

| # | Sev | Area | Finding |
|---|-----|------|---------|
| S1 | **High** | `ext/class-thumb.php` | `thumb()` maps a client-supplied href to a filesystem path and only checks `file_exists()`. No `is_managed` / hidden / traversal check. `href=/../../some/dir/secret.jpg` (or anything inside a *hidden* folder such as `/.private/`) produces a thumbnail. Any readable image on the host can be exfiltrated (at thumbnail resolution, or full resolution through `preview-img.size` / `height=0`). |
| S2 | **High** | `ext/class-thumb.php` | The same unchecked path is handed to `ffmpeg`/`avconv`/`convert`/`gm`. An attacker can make the server run ImageMagick/ffmpeg on arbitrary local files (classic ImageTragick / ffmpeg HLS-SSRF attack surface). No time limit on the subprocess. |
| S3 | **High** | `ext/class-thumb.php` | `width`/`height` are not validated. `imagecreatetruecolor(100000, 100000)` → memory exhaustion (unauthenticated DoS). The raw values are also concatenated into the cache filename (`thumb-<sha>-<w>x<h>.jpg`), so non-numeric input lands in a filesystem path. There's also no pixel cap on the source image (decompression bomb). |
| S4 | **High** | `core/class-fallback.php` | Stored XSS: in fallback mode (text browsers, `view.fallbackMode`, and any client whose UA matches `curl/links/lynx/w3m`), file names are echoed into HTML **without escaping** (`basename($item->path)`). A file named `<img src=x onerror=alert(1)>` runs script in the h5ai origin. |
| S5 | **High** | `js/ext/custom.js`, `js/ext/preview/preview-txt.js` | Stored XSS: `*.md` files (both in-preview and `_h5ai.header.md`/`footer.md`) are rendered with `marked()` and injected with `innerHTML` **without sanitisation**. Anyone who can drop a `.md` file into a listed folder (upload dir, shared drive, FTP) gets script execution when someone previews it. `marked@1.2.7` additionally has known ReDoS CVEs (CVE-2022-21680, CVE-2022-21681). |
| S6 | **Medium** | `core/class-context.php` | Admin login: unsalted single-round SHA-512; default password is the **empty string** (login is open on fresh installs and discloses PHP/server versions and tool availability); compared with `strcasecmp` (not constant-time); no rate limiting / lockout; no `session_regenerate_id()` after login (session fixation). |
| S7 | **Medium** | `class-bootstrap.php` | `session_start()` on **every** request with PHP defaults: no `HttpOnly`/`SameSite`/`Secure`, generic `PHPSESSID` name. Creates a session file per anonymous visitor. |
| S8 | **Medium** | `core/class-request.php`, `core/class-api.php` | Params come from `$_REQUEST` (merges GET + POST + **cookies**). No CSRF protection or Origin check for `login`/`logout`. JSON bodies are accepted regardless of `Content-Type`, so a cross-site `text/plain` form can post JSON. |
| S9 | **Medium** | `ext/class-search.php` | Unauthenticated user-supplied regex is passed to `preg_match` → ReDoS; unbounded recursive walk (no depth/result/time limit); symlink loops recurse forever. Delimiter escaping is broken: `\@` becomes `\\@`, which terminates the pattern and lets the caller append modifiers. |
| S10 | **Medium** | `ext/class-archive.php` | `hrefs` aren't required to be inside `baseHref`; only the *basename* is checked against `view.hidden` (not full-path patterns). `as` (download filename) is placed into `Content-Disposition` unsanitised (quote injection). `php-tar` silently truncates names > 255 bytes and breaks files ≥ 8 GiB (ustar octal limits). `catch (Exeption …)` typo. |
| S11 | **Medium** | `ext/class-custom.php` | `get_customizations()` doesn't check that the href is managed / inside the root before walking up the filesystem; with `stopSearchingAtRoot=false` it reads `_h5ai.headers.*` all the way to `/`. Custom HTML is injected raw (by design, but there is no way to opt for sanitised output). |
| S12 | **Medium** | all HTML responses | No security headers: no CSP, `X-Frame-Options`/`frame-ancestors`, `Referrer-Policy`, `Permissions-Policy`. JS injects `<style>` elements at runtime, which prevents a strict CSP. |
| S13 | **Low** | `core/class-filesize.php` | Recursive PHP folder size follows symlinks with no cycle protection → infinite recursion / timeouts. |
| S14 | **Low** | `core/class-context.php` | `to_path()` doesn't verify the href starts with `ROOT_HREF` and never resolves `.`/`..` segments; each caller is responsible for safety (S1 is the result of one caller forgetting). NUL bytes cause uncaught `ValueError` on PHP 8. |
| S15 | **Low** | thumbnails | Thumbs written with mode `0775` (executable, group-writable). |
| S16 | **Low** | `options.json` | Default config loads Google Fonts from a third-party CDN (privacy / GDPR; leaks every visitor's IP to Google). `google-analytics-ua` targets Universal Analytics, which Google shut down in 2023. |
| S17 | **Info** | design | Raw files (HTML/SVG) are served from the same origin as h5ai. Any HTML file in the share can script against h5ai. Not fixable in h5ai itself; document it and recommend a separate origin for untrusted uploads. |
| S18 | **Info** | `core/class-setup.php` | Undefined `$_SERVER['HTTP_USER_AGENT']` / `SERVER_SOFTWARE` → PHP 8 warnings; a `null` server name makes `Setup::set()` `exit` with a blank page. |

## 2. Code quality / correctness

* **Search** `get_items()` uses an undefined `$cache` inside a closure (warning on each result).
* **Sort** restore: `order.column || settings.column` — column `0` is falsy, so a stored "Name" sort is ignored when the default is something else; same for `reverse=false`.
* **Tree** item template has a mismatched `</span>` closing a `<div>`.
* **Thumbs** for video always seek to `0:00:10`; clips shorter than 10 s get no thumbnail.
* **No WebP / AVIF / HEIC / Opus / M4V / MKV-audio types**; no thumbnails for WebP.
* **JSON comment stripper** mis-handles `"\\"` (escaped backslash before a quote).
* `server.request()` swallows network errors and HTTP status codes; the UI shows "loading…" forever.
* Uses deprecated APIs: `document.domain`, `KeyboardEvent.keyCode`, `XMLHttpRequest`, `x-ua-compatible` meta, `browsehappy.com` link (dead).
* `localStorage` access isn't guarded — throws in some privacy modes and kills the app.
* `contextmenu` ext ships demo menu entries ("testing context menus").
* Info page embeds the upstream author's PayPal donation form.

## 3. Platform / dependencies

| Item | Current | Problem |
|------|---------|---------|
| PHP min | 7.0 | EOL since 2019. 8.1 is the oldest security-supported line in 2026 → target **8.2+**. |
| Build tool | `ghu@0.26` (author's own, unmaintained) wrapping webpack 4, uglify, less, pug | Unmaintained, many transitive advisories, slow. |
| Babel | 7.12 | Unneeded for evergreen browsers. |
| ESLint | 7 | EOL; legacy config format. |
| `marked` | 1.2.7 | ReDoS CVEs; no sanitiser. |
| `jsdom` | 16 | Old; only used by tests. |
| Test harness | `scar` + browser runner | Unmaintained. |
| CSS | LESS, float-based layout, fixed palette | No dark mode, no CSS variables, poor mobile layout. |

## 4. UX / accessibility

* Toolbar "buttons" are `<div><img></div>` — not focusable, no accessible names.
* No keyboard navigation of the listing; preview uses `keyCode`.
* No dark mode; low contrast greys (#999 on white) fail WCAG AA.
* Mobile: sidebar overlays content, tiny touch targets.
* "Loading…" notification is the only feedback; errors are invisible.
