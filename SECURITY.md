# Security

## Reporting

Please report vulnerabilities privately to the maintainers of this fork rather than in a public
issue. Include steps to reproduce and the affected version (shown on the admin page).

## Security model

* **h6ai is read-only.** It lists, previews and packages files. It never writes into served folders.
  It only writes to `_h6ai/private/{cache,data}` and `_h6ai/public/cache`.
* **Permissions:** with folder rules configured, h6ai checks every listing, search, thumbnail,
  archive and custom header request. Raw file requests are only protected if **nginx asks h6ai first**
  via `auth_request` (see `docs/DEPLOYMENT.md`). Without that config, the listing is protected but
  anyone who knows a file's URL can still download it.
* **Forwarded headers.** `X-Forwarded-For`, `-Host` and (once proxies are configured)
  `-Proto` are only believed from the trusted proxies set in Admin → System. Without that list,
  the rate limiter and the activity log use the connecting address, which a client can't forge.
* **Hidden is not protected.** `view.hidden` only removes entries from listings and API results.
  Use folder permissions or nginx rules to deny access.
* **Active content in the share** (HTML, SVG, XML, XSL, MHTML) is served with a
  `Content-Security-Policy: sandbox; default-src 'none' …` header by the reference nginx config:
  no script, no forms, opaque origin. Trusted static sites inside the share can be exempted with
  `deploy/nginx/trusted-html.map` (installed as `/etc/nginx/h6ai/trusted-html.map`).
* **Custom header/footer files** (`_h6ai.header.html` etc.) are sanitised unless
  `custom.allowUnsafeHtml` is enabled. Markdown is always sanitised.

## Hardening in this fork

| Area | Measure |
|------|---------|
| Paths | Every client href goes through one resolver that rejects `..` (also percent-encoded), NUL bytes and anything outside the root. Thumbnails, archives, search and custom headers check managed/hidden status and permissions. |
| Auth | `password_hash` (bcrypt/argon2), constant-time comparisons, legacy SHA-512 hashes still accepted, no default password, per-IP login rate limiting, session id regeneration, `HttpOnly` + `SameSite=Strict` (+ `Secure` on HTTPS) cookies, sessions only created on login, session invalidation on password/role change, max session age. |
| CSRF | JSON API requires `Content-Type: application/json`; `login`/`logout` require same origin (`Origin`/`Sec-Fetch-Site`); admin operations additionally need a per-session CSRF token. |
| XSS | All server-rendered names are escaped; markdown and custom HTML go through DOMPurify; strict, config-derived CSP with nonces; no runtime `<style>` injection. |
| Headers | CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `Permissions-Policy`; `Cache-Control: no-store` on API responses, `private` for protected files. |
| DoS | Thumbnail dimensions clamped (≤ 2048), source pixel cap (decompression bombs), subprocess timeouts, ReDoS-bounded search (PCRE limits, result/time/depth caps), symlink cycle protection in search, archives and folder sizes. |
| Subprocesses | No shell anywhere for user-influenced input (`proc_open` with argv arrays), forced ImageMagick coders (`pdf:`/`ps:`), `file:` prefix for ffmpeg inputs, restrictive ImageMagick policy in Docker. |
| Thumbnails | Names are an HMAC of the path with a server secret, so protected files' thumbnails can't be guessed. |
| Archives | Only the configured archive type is accepted, entries must be inside the base folder and readable for the user, RFC 6266 filenames, PAX headers for long names and > 8 GiB files. |

## Tracked CVEs

| CVE | Component | Status in h6ai |
|-----|-----------|----------------|
| [CVE-2026-109618](https://nvd.nist.gov/vuln/detail/CVE-2026-109618) (GHSA-w8hw-w9fx-j79w): RCE via out-of-memory corruption, CVSS 4.0 9.2 | PHP < 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12 | **Fixed by version:** the Docker image is pinned to `php:8.3.36-fpm-alpine` and the build fails on an affected PHP. The admin page (System tab + banner) flags affected PHP versions on other installs. **Defence in depth** (the advisory's risk reducers): nginx rejects `multipart/*` bodies (415), methods other than GET/HEAD/POST (405) and bodies > 1 MiB (413) before PHP; PHP runs with `file_uploads=Off`, `max_multipart_body_parts=1`, `post_max_size=1M`, `max_input_vars=5000`, `max_input_nesting_level=8`; h6ai never raises `memory_limit` and bounds attacker-influenced allocations (thumbnail pixel/memory headroom check, folder listing and archive entry caps, search result caps). Patching PHP is the only complete fix. |
| [CVE-2026-10961](https://nvd.nist.gov/vuln/detail/CVE-2026-10961): use-after-free sandbox escape via crafted HTML page | Google Chrome for iOS < 149.0.7827.53 (client side) | **Not fixable server side** (visitors must update Chrome). h6ai makes sure it can't be the delivery vehicle: HTML/SVG/XML files from the share are served sandboxed without script (the exploit chain needs a compromised renderer, i.e. script); markdown and custom header/footer HTML are sanitized with DOMPurify; the h6ai UI runs under a strict nonce-based CSP. |
