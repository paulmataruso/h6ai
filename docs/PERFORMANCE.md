# Performance

Measured with `test-integration/bench.sh` against the Docker development setup
(`compose.yaml` + `compose.dev.yaml`), on
2026-10-22. Re-run it after changes:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build   # wait until big/big-7g.bin exists: docker compose logs h6ai | grep big
test-integration/bench.sh
```

## Test machine

| | |
|---|---|
| CPU | 10 × Intel Xeon E5-2670 v2 @ 2.50 GHz (VM, ~2013 generation) |
| Memory | 31 GiB (≈7 GiB available during the run, so the 7 GiB file doesn't fit in the page cache) |
| Disk | `sda`, "Virtual disk" (VM, reported rotational), LVM, overlay2 |
| Software | PHP 8.3.36 (FPM, OPcache + JIT), nginx 1.30.4, Docker 29.5.3 |
| Client | `curl` / Node on the **same host**, via the published port `172.16.1.67:8687` |
| Test file | `big/big-7g.bin`: 7,516,192,768 bytes of random data (not sparse) |

**Caveat:** the published port is reached through Docker's userland proxy (`docker-proxy`; the
daemon has `userland-proxy` at its default `true`) because client and server run on the same host.
That adds a userspace copy. Clients on the LAN go through iptables DNAT instead and are closer to
the "inside the container" numbers. All figures are single runs on a shared VM, so expect ±20 %.

## Results

### Static file serving (nginx: sendfile, `directio 16m` + `aio threads`, gate check per request)

| Test | Throughput | TTFB |
|------|-----------:|-----:|
| 7 GiB full download, published port | 151 MiB/s | 0.02–0.10 s |
| 7 GiB full download, again | 152 MiB/s | 0.02 s |
| 7 GiB full download, inside the container (loopback, no docker-proxy) | **247–285 MiB/s** | 0.01–0.03 s |
| 4 parallel 7 GiB downloads, published port | **507–518 MiB/s aggregate** | |
| Range: 256 MiB from the middle of the file | 158–163 MiB/s | 0.014 s |

* TTFB is ~15 ms, including the PHP permission check (`auth_request`).
* A single stream is limited by the per-connection path (docker-proxy, VM disk latency with
  `directio`). Parallel streams scale to ~3.4× a single one, so the disk is not saturated by one
  client. Large files are read with `O_DIRECT` (`directio 16m`), so the numbers reflect real disk
  reads, not the page cache.
* Range requests (resume, video seeking) cost the same as sequential reads.

### Archives streamed through PHP (`/big/`, ≈ 7.06 GiB, `download.enabled`)

| Type | Before | After `fastcgi_buffer_size 256k` |
|------|-------:|------:|
| `php-tar` (published port) | 19 MiB/s | **73 MiB/s** (115–119 MiB/s for a 64 MiB archive) |
| `php-tar` (inside the container) | – | 81 MiB/s |
| `shell-tar` (GNU tar via `proc_open`) | – | 24 MiB/s |

**Fixed:** archives send `X-Accel-Buffering: no`, so nginx relays them through a single
`fastcgi_buffer_size` buffer. The default of one page (4 KiB) capped archives at ~19 MiB/s, and
`deploy/nginx/server.conf` now sets 256 KiB (6× faster).

Remaining bottlenecks, for follow-up in `src/_h6ai/private/php/ext/class-archive.php`:

1. **`php-tar`** reads with buffered `fread` and copies every byte through PHP strings and FastCGI
   records. It reaches ~1/3 of nginx's direct throughput on this VM. PHP CLI read rates on this
   disk vary between 120 and 380 MiB/s depending on cache state, so the disk is part of it.
2. **`shell-tar` is slower than `php-tar`.** It reads tar's stdout pipe with
   `fread($pipe, 4 MiB)`, which returns after each pipe chunk (≤ 64 KiB), followed by an `echo` +
   `flush()` per chunk. Suggested fix: accumulate into larger writes (e.g. `stream_copy_to_stream`
   to `php://output`, or loop until ≥ 1 MiB is buffered before `flush()`), or enlarge the pipe
   (`F_SETPIPE_SZ` isn't available in PHP, so buffering in PHP is the practical option).
3. If maximum archive speed matters more than avoiding PHP, nginx can't help directly (archives
   are generated on the fly). Pre-built archives in the share are served at full nginx speed.

### API latency (POST `items`, keep-alive, 50 sequential requests)

| Folder | p50 | p95 | max |
|--------|----:|----:|----:|
| `/` (14 folders, recursive folder sizes cached) | 22 ms | 29 ms | 40 ms |
| `/big/` (2 files, 7.1 GiB) | 22–26 ms | 27–38 ms | 45 ms |
| `/many/` (150 files) | 49–51 ms | 66–73 ms | 93 ms |

Cost grows with the number of entries (stat calls, permission checks and JSON per item). Folder
sizes are served from the persistent folder-size cache (`foldersize.cacheTtl`).

### File gate overhead (16 concurrent keep-alive clients, 10 s, small file)

| Request | Requests/s | p50 | p95 |
|---------|-----------:|----:|----:|
| static asset, no gate (`/_h6ai/public/...`) | 1156–1216 | 11–12 ms | 24–26 ms |
| `/docs/notes.txt` through the gate, no rules | 556–823 | 17–27 ms | 40–45 ms |
| `/docs/notes.txt` through the gate, rules configured | 849 | 15 ms | 41 ms |
| `/private/secret.txt`, gate denies (401) | 654 | 22 ms | 44 ms |

The gate costs one PHP-FPM request per file request: roughly **+5–15 ms latency** and **30–50 %
fewer small-file requests per second** than plain nginx on this VM. Configured permission rules
make no measurable difference (the variance between runs is larger). For large files it's
irrelevant: the check happens once per request, before the transfer.

Ideas if small-file request rates ever matter: run more FPM children (`pm.max_children`), or cache
gate decisions in nginx (`proxy_cache`-style caching of the `auth_request` subrequest, keyed by
session cookie + URI, with a short TTL).

## Tuning in place

* nginx: `sendfile`, `tcp_nopush`, `aio threads`, `directio 16m`, `output_buffers 2 1m`,
  `open_file_cache`, gzip only for text types, `fastcgi_buffer_size 256k` for the PHP endpoint.
* PHP-FPM: OPcache + JIT (tracing), 4 MiB realpath cache, `pm.max_children=32`,
  `request_terminate_timeout=0` for long downloads, `output_buffering=Off`.
* h6ai: compiled config cache (OPcache-served), persistent folder-size cache, thumbnails cached
  with immutable URLs.
