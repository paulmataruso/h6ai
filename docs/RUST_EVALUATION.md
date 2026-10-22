# Should the backend be rewritten in Rust?

## What would actually be rewritten

h5ai is two parts:

| Part | Size | Rust rewrite? |
|------|------|---------------|
| Frontend (JS/CSS, runs in the browser) | ~4k lines JS, ~1.5k CSS | **No.** Stays JS whichever backend serves it. All GUI work carries over unchanged. |
| Backend (PHP) | ~1.7k lines before this fork, ~3k after RBAC/gate | Yes. Listing, search, thumbnails, archives, auth/RBAC, admin API. |

So the question is really about ~3k lines of backend code plus deployment.

## Where Rust would clearly win

1. **Enforcing permissions on files.** This is the biggest architectural argument. In the PHP model nginx
   serves file bytes, so per-folder permissions need a *gate* (nginx `auth_request` → PHP). That's a
   second configuration surface. If it's misconfigured, the listing is protected but the files are not. A standalone Rust server (axum + tower-http) serves the
   bytes itself, so the check can't be bypassed.
2. **Large files.** `tower-http::ServeDir` / `hyper` gives sendfile-class performance, Range, ETag and
   conditional requests out of the box. tar/zip archives stream with async backpressure and no PHP
   execution-time or memory limits.
3. **Operations.** One static binary (or a 15 MB distroless image): no PHP-FPM, no OPcache tuning, no
   web server matrix (Apache/nginx/lighttpd/Caddy quirks such as the lighttpd `SCRIPT_NAME` hack).
4. **Safety and performance.** Memory-safe image decoding (`image` crate) instead of GD, real
   concurrency, and no per-request bootstrap (config parsed once, not on every gate check).

## Where Rust loses

1. **It becomes a different product.** h5ai's niche is "unzip `_h5ai` into an existing web root that
   already runs Apache/nginx + PHP, add one index line". That works on shared hosting, NAS boxes and
   existing vhosts. A Rust binary needs its own port/process, a reverse proxy in front for TLS, and
   a service manager. (Since this fork targets nginx + PHP-FPM in Docker only, this point is weaker
   for you than for upstream h5ai's users.) That's the model of **dufs**, **miniserve** (Rust), **filebrowser** (Go) and
   **copyparty** (Python), all mature, maintained projects. A Rust h5ai would compete with them rather
   than with the original h5ai.
2. **Thumbnails still shell out.** Video and PDF thumbnails need ffmpeg/ImageMagick/Ghostscript either
   way. Rust only improves raster image thumbnails.
3. **Cost and risk.** Re-implementing and re-testing everything (URL-encoding edge cases, symlinks,
   hidden/unmanaged semantics, PAX archives, l10n, custom headers, fallback mode) is roughly 4–6 weeks
   for one developer to reach parity, plus a migration path for existing `options.json` users.
4. **Contributors.** PHP + vanilla JS is approachable for the self-hosting crowd. Rust raises the bar.

## Recommendation

* **Now:** finish the PHP modernisation (this branch). The security fixes, GUI, RBAC and caching
  deliver value immediately, and the nginx `auth_request` gate covers file permissions while nginx
  keeps serving the bytes (sendfile, Range, ETag), which is hard to beat for large files.
* **Keep the door open:** the backend is behind one JSON API (`POST action=get|login|admin|download`)
  plus the gate contract (`auth_request` check → 204/401/403). These are documented and
  covered by the integration tests in `test-integration/`. A Rust backend that speaks the same API can
  reuse the frontend and the whole integration suite unchanged.
* **Go Rust if** your deployment is Docker/standalone-only (no shared hosting, no existing web server
  to plug into) **and** per-folder permissions are a hard security requirement. In that case the
  single-process model removes the gate misconfiguration risk entirely, which is worth the rewrite.
  Suggested stack: `axum` + `tower-http` (ServeDir, compression), `tokio-tar`/`async_zip`, `image` +
  `fast_image_resize`, `argon2`, `serde_json`, sessions via signed cookies, config compatible with
  `options.json`.
