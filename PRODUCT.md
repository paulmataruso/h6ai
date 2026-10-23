# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary: visitors of a public download archive.** Anyone on the internet, arriving from a
  search engine, a link or a bookmark, looking for a specific file (software releases, datasets,
  media, documents) or browsing to see what is there. Many arrive on a deep folder URL and leave
  after one download. They use desktop and phone browsers, and command-line tools (`curl`, `wget`)
  on the same URLs.
- **Operator / admin:** the person who runs the server. They drop files into the web root, decide
  what is public, manage users, folder groups and permissions, connect Google Search Console /
  Analytics and read the activity log on the admin page (`/_h6ai/public/`).
- **Secondary: account holders.** Standard users and "anon" download-only accounts that see only
  the folder groups shared with them (e.g. clients collecting deliverables).

## Product Purpose

h6ai turns a folder tree served by nginx into a fast, browsable file index: listing, search,
thumbnails, previews, packaged (tar/zip) downloads and per-folder access control. Success for a
visitor: find the file and get it downloading within seconds, on any device. Success for the
operator: publishing is "copy files into a folder", and they can see who downloaded what.

## Positioning

- **Huge files, fast.** nginx serves every byte (sendfile, Range/resume, ETag); h6ai only
  authorises (`auth_request`) and never sits in the data path of a single-file download. Multi-GB
  files resume, stream and seek. Archives stream without buffering.
- **Zero-friction browsing.** No app to learn and no account needed for public content: a URL is
  a folder, the listing is instantly usable, works on phones and without JavaScript (fallback
  listing), previews just work.
- Installs three ways with the same features: natively (`install.sh`), in Docker, or as a
  drop-in for an existing nginx web root (an `_h6ai` folder plus one `error_page` line). Never a
  separate file-server process.

## Operating Context

- Deployed as nginx + PHP-FPM (Docker image provided); content lives in a host folder.
- Visitors frequently land on deep links shared elsewhere or from Google results; the sitemap and
  robots.txt expose all public folders and files.
- Downloads are recorded in the activity log and optionally sent to Google Analytics (GA4
  Measurement Protocol), including direct links that never load the UI.
- The admin works on a desktop browser; visitors on anything.

## Capabilities and Constraints

- Views: details (table), grid, icons (gallery with thumbnails); folder tree; breadcrumb;
  filter (current folder) and search (recursive); info panel with QR code; preview lightbox for
  images, video, audio, text, code and sanitized markdown; multi-select + packaged download.
- Access levels per folder: none < list < read < download; roles, users, folder groups, folder
  rules; "anon" accounts are download-only and default-deny.
- Strict Content-Security-Policy (nonce based); no third-party assets unless the operator
  configures Google tags. No web fonts are loaded by default (system font stacks).
- Read-only product: no uploads, renames or deletions.
- Frontend is vanilla JS + plain CSS bundled by esbuild; 35 UI languages (translations cover the
  original strings, newer strings fall back to English).
- Dark only: five dark themes (Midnight default, Graphite, Deep Sea, Ember, OLED Black). The admin
  sets the site default; visitors can pick another theme for themselves.
- Repository: https://github.com/paulmataruso/h6ai. Project page:
  https://paulmataruso.github.io/h6ai/ (`docs/index.html`, GitHub Pages from `main` `/docs`).

## Brand Commitments

- Name: **h6ai** (lowercase), a maintained successor of h5ai; credit to the original h5ai by
  Lars Jung stays in the license and credits.
- The h6ai brand is front and centre on every install: logo and name visible in the UI. The
  operator's configurable site name appears alongside it.
- Logo: blue→violet (`#4c8dff` → `#8b5cf6`) hexagon holding a bulleted index (three rows),
  wordmark "h6ai" with the "6" in the gradient (`src/_h6ai/public/images/brand/`).

## Evidence on Hand

- Benchmarks in `docs/PERFORMANCE.md` (7 GiB file: ~151 MiB/s single stream through the docker
  proxy, ~250–285 MiB/s on loopback, >500 MiB/s for 4 parallel downloads, ~15 ms TTFB including
  the permission check).
- Security audit and regression suite: `docs/AUDIT.md`, `test-integration/`.
- No testimonials, user counts, customers or press exist; do not fabricate any.

## Product Principles

1. The file is the hero: every screen gets a visitor to "downloading" in as few steps as possible.
2. Never in the way of the bytes: performance features (Range, resume, streaming) are never
   traded for UI convenience.
3. Obvious over clever: patterns visitors already know from file managers; no learning curve.
4. Public by default, private precisely: access control is exact and auditable, and invisible to
   visitors who don't need it.
5. Safe with untrusted content: file names, markdown, HTML and SVG in the share are hostile until
   proven otherwise.

## Accessibility & Inclusion

Keyboard operable (arrow navigation, `/` to filter, Space to select), visible focus, reduced
motion respected, WCAG 2.2 AA contrast as the floor in every theme.
