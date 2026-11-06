# Search: indexed, bounded, tuned for big shares

How h6ai's search works on file servers with millions of files: the index, the indexer, the
query engine, admission control, what the first plan got wrong, and measurements on a million
files. User-facing setup is in the install guides ([native](install/native.md#the-search-index),
[Docker](install/docker.md#5-settings), [drop-in](install/dropin.md#search)).

## 1. What was wrong with search before

`ext/class-search.php` walked the tree on every request. It went breadth first from the current
folder, with `scandir` + `is_dir` + `is_readable` + `view.hidden` regexes per entry and
`is_managed_path` per folder. It stopped when it had `search.maxResults` (1000) hits or
`search.timeLimit` (10 s) ran out. The client fired it as you typed (300 ms debounce) and never
cancelled a request.

On a share with millions of files:

1. **Every keystroke was a tree walk**: up to 10 s of CPU and disk per request, several per word
   typed. Results were the first 1000 found in walk order, not the best 1000. A query whose
   matches were deep in the tree found nothing before the time limit.
2. **It starved downloads.** Every file request goes through PHP (the gate), and so do listings.
   Searches shared the same `pm.max_children` (32) workers. A handful of people typing could hold
   all of them.
3. **Folder results computed their size**, a recursive walk of each result folder with
   `foldersize.enabled`.
4. **No admission control**: no limit on concurrent searches, no rate limit per client.
5. **The client re-sorted results by name**, so ranking would have been thrown away anyway.
6. **Fuzzy "advanced" matching** (`abc` → `a.*?b.*?c`) matched far too much on big trees and
   couldn't be indexed.

## 2. Goals

* A query costs milliseconds to a few hundred milliseconds of CPU, however big the share, and
  touches the disk only for the results it returns (a `stat` each).
* Every query has a hard upper bound on work, by construction. SQLite queries can't be
  interrupted from PHP, so every statement carries a `LIMIT` and work is split into windows with
  a deadline check in between.
* Search never occupies more than `search.concurrency` PHP workers. Downloads, the gate and
  listings always have workers left.
* Results are ranked: exact name, then name prefix, then word start, then anywhere. Folders come
  first, then shorter names and shallower paths.
* Never show a name the visitor couldn't see in a listing.
* Index maintenance is incremental, cheap when nothing changed, runs outside user requests at low
  CPU and disk priority, and survives crashes.
* No new dependencies: `pdo_sqlite` with FTS5. Without it, a bounded walk remains as the fallback.

## 3. Design

### 3.1 Storage

One SQLite database per generation, in WAL mode (readers never block the writer, and the
writer doesn't block readers):

```sql
CREATE TABLE node (
  id      INTEGER PRIMARY KEY AUTOINCREMENT, -- depth-first pre-order on a full build; never reused
  parent  INTEGER NOT NULL,       -- id of the folder
  name    TEXT NOT NULL,          -- as on disk
  key     TEXT NOT NULL,          -- folded name (3.4)
  is_dir  INTEGER NOT NULL,
  path    TEXT,                   -- folders: "/a/b/" relative to the root, as the ACL uses it
  hi      INTEGER,                -- folders: the last id of the subtree from the build
  mtime   INTEGER, ctime INTEGER, -- folders: change detection (3.2)
  fid     TEXT,                   -- folders: device:inode, recognises renames and moves
  flags   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX node_parent ON node(parent);
CREATE INDEX node_key ON node(key);                                  -- exact and prefix tiers
CREATE UNIQUE INDEX node_path ON node(path) WHERE path IS NOT NULL;  -- scope lookup
CREATE INDEX node_fid ON node(fid) WHERE fid IS NOT NULL;            -- reattach
CREATE VIRTUAL TABLE node_fts USING fts5(key, content='node', content_rowid='id',
                                         tokenize='trigram', detail=full);
CREATE TABLE moved (id INTEGER PRIMARY KEY, hi INTEGER NOT NULL);   -- subtrees moved since the build
CREATE TABLE stack (...);                                           -- the resumable build
CREATE TABLE meta (k TEXT PRIMARY KEY, v);
```

* **Trigram FTS5** gives substring matching through an index: a fragment of 3 or more characters
  is a phrase of its trigrams. Triggers keep `node_fts` in sync with `node`.
* **Names only.** Sizes and dates change all the time without changing the folder, so they aren't
  stored. They're read live (one `stat`) for the returned results only. That keeps incremental
  updates cheap.
* **A folder's subtree is an id range.** The full build numbers entries depth first, so a folder
  with id `i` covers `(i, hi]`. Entries added later get ids above `base_max` (the build's last
  id). Folders moved since the build keep their ids and are listed in `moved`. A scoped search,
  or a user who may see only a few folders, looks only at those ranges. Everything found is
  still checked against the scope by path.
* **Folder flags**: `1` unmanaged (`view.unmanaged`, nested install: listed, not descended),
  `2` a symlink into the tree or a second link to the same place (listed, not descended),
  `4` below `search.index.maxDepth` (listed, not descended), `16` a symlink out of the tree
  (another disk linked in: descended, once).

**Where:** `private/cache/search-<h>/index-<gen>.sqlite`, with `current.json` and
`building.json` pointing at generations. `<h>` is an HMAC of the installation secret. On drop-in
installs `private/cache` is inside the web root and nginx could serve it. The index holds every
name, including those in restricted folders, so its file names must not be guessable (the same
way the file links next to it work). The folder also gets an `index.php`, so it can't be listed.
Native and Docker installs deny `private/` in nginx anyway.

**Generations:** a rebuild writes `index-<gen+1>.sqlite` and switches `current.json` (written with
rename). Readers that opened the old generation finish on it; it's deleted after 2 minutes. A WAL
database is never renamed over another, because a stale `-wal` would be applied to the wrong
file.

**Fingerprints:** the *hard* fingerprint (schema, folding version, root path and href, h6ai path)
must match, or the index isn't used at all. The *soft* fingerprint (`view.hidden`,
`view.unmanaged`, the entry and depth limits) only decides what gets indexed. On a mismatch the
index is still used (every result is checked again anyway) and a rebuild starts.

### 3.2 Indexer

Folder contents change ⇔ the folder's mtime/ctime change: create, delete and rename of an entry
all update them. ctime can't be set from user space, so `rsync -a` or `tar` restoring an old
mtime still changes it.

* **Full build** (no index, hard fingerprint changed, `rebuild`, or a soft mismatch): depth first
  over the tree, with an explicit stack stored in the database, so it can run in slices and
  resume. Batched inserts in transactions of about 0.5 s, so the WAL stays small. With the
  daemon, it runs as one bulk pass.
* **Refresh pass** (every `search.index.refreshInterval`, 300 s): visit every folder in path order,
  with a cursor in `meta`, so a pass can be sliced and resumed.
  * `stat` each folder; mtime and ctime unchanged → skip. An unchanged tree costs one `stat` per
    folder, not per file.
  * Changed → `scandir`, a type check per entry (PHP's `scandir` returns no types), diff by name,
    insert or delete the difference. If only the ctime changed (a `chmod` of the folder), the
    known types are reused.
  * New folders get no mtime, so the same pass visits them (their path sorts after the cursor).
  * Times have one-second resolution, so a change in the same second as the indexer's `stat`
    would look like no change next time. A folder changed within the last second is stored as
    dirty (`ctime = -1`) and fully re-listed on the next pass.
  * A folder that is gone at its own visit is detached, and its parent is marked dirty.
* **Renames and moves keep the subtree.** A folder that disappears is *detached*: its subtree's
  paths move below `#<id>/`, outside every search scope. If a folder with the same device:inode
  shows up elsewhere in the same pass, the subtree is *reattached* under its new path and keeps
  its ids. Renaming a folder of a million files costs one path update per folder below it, not a
  re-index. Detached subtrees that are still left at the end of the pass are deleted, in chunks.
* **Verify pass** every `search.index.verifyInterval` (7 days): re-list every folder whether or
  not its times changed. This catches what mtimes don't show, such as network file systems with
  unreliable times. With `search.index.trustMtime: false`, every pass is a verify pass.
* **Rebuild when fragmented**: once more than max(100 000, 25 %) entries have been added since the
  build, or more than 1000 subtrees moved, a background rebuild restores the id locality (the
  old generation answers meanwhile).
* **Single writer**: `flock` on `writer.lock`, non-blocking. A second indexer exits ("busy").

**Where it runs:**

* **Docker**: the entrypoint starts `h6ai-index.php daemon` next to PHP-FPM under `nice -n 19` and
  `ionice -c 3`, and restarts it after 10 s if it exits. It exits by itself when the code
  changed, so an update takes effect. `H6AI_SEARCH_INDEXER=0` turns it off.
* **Native** (`install.sh`): the `h6ai-index` service, as the PHP-FPM user. On systemd it runs with
  `Nice=19`, `CPUSchedulingPolicy=idle`, `IOSchedulingClass=idle` and `ProtectSystem=strict`
  (only `private/cache` writable); on OpenRC with supervise-daemon, nice 19 and ionice 3.
* **Anything else** (drop-in, shared hosting): **request-tail slices**. After a response has been
  sent (`fastcgi_finish_request`), and only if work is due and no daemon has reported in
  recently, one worker runs a slice of `search.index.sliceTime` (2 s) under the writer lock, at
  most one attempt every 15 s. `search.index.background` (`auto`, `daemon`, `requests`) chooses.
  A drop-in can add the daemon as a service or a cron line ([dropin.md](install/dropin.md#search)).
* **Shell**: `h6ai-index status | refresh [--verify] | rebuild | search [--in /folder/] [--all]
  WORDS...`. That's `deploy/h6ai-index` around `_h6ai/private/bin/h6ai-index.php`; it runs as
  the owner of `private/cache`, niced. The admin page's **System → Search index** card shows
  the same status and has a Rebuild button.

### 3.3 What's indexed

The listing rules, minus everything that depends on the visitor (permissions, readability for
`hideIf403`). Those are applied per search, and a `chmod` doesn't change the parent folder's
times, so the index couldn't follow them anyway.

* `view.hidden` on names and hrefs, `_h6ai` and `_h5ai`: not indexed.
* `view.unmanaged` (a folder with an `index.html`) and nested h6ai installs: the folder is
  indexed, its contents aren't.
* At most `search.index.maxEntriesPerFolder` (100 000) entries per folder and
  `search.index.maxDepth` (64) levels.
* **Symlinked folders**: followed once if the link leads *out of* the tree, so another disk
  linked into the share is searchable. A target inside or above the root, a loop, or a target
  that overlaps one already followed is listed and not descended. A name is never indexed twice
  under two paths, and a cycle can't make the index grow. The fallback walk follows the same rule.

### 3.4 Folding

`key = fold(name)`: `mb_strtolower`, then a fixed table for precomposed Latin letters
(é→e, ß→ss, æ→ae, ø→o, ł→l, …), then removal of combining marks (NFD names from macOS). No
`intl` dependency. Queries go through the same function. Its version is part of the hard
fingerprint.

### 3.5 Query language

| Typed | Meaning |
|---|---|
| `ubuntu iso` | every word occurs in the name, in any order |
| `"release notes"` | exact text, spaces included |
| `-draft` | the name must not contain it |
| `*.iso`, `IMG_20??*` | wildcards over the whole name (`GLOB` on the folded name) |
| `re:^IMG_\d+` | a regular expression on the real name (`search.regex`) |

Case and accents don't matter. Limits: 1000 bytes, 8 words; more is a 400. With
`search.advanced: false` the input is one literal. The old client's `pattern` parameter (a
regular expression) is still accepted.

### 3.6 Engine

Scope and permissions are turned into id ranges first (3.1), plus the entries added and moved
since the build. Then:

1. **Exact and prefix tiers** (unless `re:`): through the `key` B-tree, the first word as the
   whole name (or with an extension: `ubuntu.iso`, a separate lookup because it sorts after
   `ubuntu-…` and `ubuntu_…`), then names starting with it, at most 1000 and 5000 candidates.
   If they fill the page, nothing else can rank higher and the search is done. This finds the
   folder `ubuntu` even when two million names contain "ubuntu".
2. **FTS**: every literal fragment of 3 or more characters (words, phrases, literal runs of
   globs) → `node_fts MATCH '"f1" AND "f2"'`, per id window of 2 million, at most
   `search.candidates` (20 000) candidates in total. Hitting that sets `truncated`.
3. **Short words** (1–2 characters, `*.c`): a scan of id windows of 100 000, at most 300 000
   entries per search (`truncated` beyond), each window ranked and the best kept.
4. **`re:`**: the same windows with a PHP `REGEXP` function that checks the deadline itself, so
   a slow expression stops at `search.timeLimit`, under PCRE's backtrack limits.

Every shape filters in SQL: the scope, each word with `instr(key, …)`, exclusions, globs, and the
visitor's permissions (3.7). Every shape also ranks in SQL: 0 the exact name (also with an
extension), 1 starts with the first word, 2 the word starts after a space, `_`, `-`, `.` or `(`,
3 anywhere. Ties go to folders first, then shorter names, shallower paths, the name and the id. A
page is always the best `fetch` rows of everything looked at, so a short page is exactly the top
of the full ranking (tested, 4.2).

Joins are written as `CROSS JOIN`, which SQLite keeps in the given order. Left to itself, its
planner started the prefix tier from the scope condition on the parent folder and walked the
whole tree for a handful of candidates (0.5–0.8 s instead of 20 ms on a million entries).

The engine asks for `maxResults + 25 %` rows, so that results dropped by the per-result check
(3.8) still leave a full page. A full page means `more`.

### 3.7 Permissions in SQL

`Acl::level` is decided by the most specific rule whose path is a prefix of the folder and that
grants something to the user, or else by the default. For one user that's a fixed list, compiled
into a `CASE` over byte ranges of the folder path:

```sql
CASE WHEN p.path >= '/private/' AND p.path < '/private0' THEN 0
     WHEN p.path >= '/team/'    AND p.path < '/team0'    THEN 1
     ELSE 3 END
```

Files are visible if their folder's level is at least *list*. Folders are visible if they're
*reachable*: their own level is at least *list*, or they lie on the way to a folder that is (a
precomputed `IN (...)` list). Users who can't list the root are searched in the subtrees they
can list only, as id ranges, so a user who sees one folder of a big share never pays for the
rest. Admins, and installs without rules, skip all of it. Anonymous (`anon`) accounts use the
same code with their defaults.

### 3.8 Per-result checks

The SQL is an optimisation, not the security boundary. Every result is checked again in PHP the
way a listing would show it to this visitor, right now:

* the folder is managed: not hidden (by name or by any ancestor), not unmanaged, not in a nested
  install;
* with `hideIf403`, every folder on the way down is readable, and so is the entry;
* the visitor has *list* on the folder (files) or can reach the folder (folders);
* `stat` succeeds, and the type matches. The `stat` also gives the size and date. A folder's size
  comes from the folder-size cache only, never computed.

What subfolders inherit from "managed" (hidden ancestors, nested installs) is remembered per
request. A page of 200 results in 200 different deep folders shares most ancestors, and this cut
the check from 0.5 to 0.07 ms per folder.

Responses carry `searchInfo: {indexed, more, truncated}`. Admins also get `ms`, `reason` (why the
index wasn't used), `indexAge` and `stale`.

### 3.9 Admission control

* **Concurrency slots**: `search.concurrency` (4) lock files, `flock(LOCK_EX | LOCK_NB)`. With
  every slot taken, a request may wait up to 150 ms for one, but only if it gets one of as many
  *wait* slots. Any further request gets `503` `ERR_BUSY` with `Retry-After` at once. So search
  holds at most 2 × `concurrency` PHP workers (8 of the default 32), running or waiting, however
  many clients search. A crashed worker's locks are released by the kernel.
* **Per client IP**: `search.rateLimit` (60 per 10 s), a sliding window like the login limiter's.
  Over it, the answer is `429` `ERR_RATE_LIMITED` with `Retry-After`. Behind a proxy it uses the
  real address (trusted proxies only).
* **The client**:
  * It waits for a 250 ms typing pause (Enter searches at once) and keeps one request in flight
    per tab.
  * A newer query waits for the request in flight, or aborts it after a second. That frees the
    browser, though a running search finishes on the server within its limits.
  * It keeps the last 20 answers for a minute and retries busy or rate-limited answers with
    exponential, jittered pauses (0.5 s or 3 s base, 4 tries).
  * Results keep their ranking (`view.changed` with `ranked`), so the sort extension leaves them
    alone until a column header is clicked.
  * The status line says "The best 200 results … Add words to narrow it down" or "The search
    stopped early …".

### 3.10 Fallback walk

When there's no usable index (no `pdo_sqlite`, SQLite older than 3.34, not built yet, a folder
not in it), searches walk the folders breadth first:

* under the same slots and rate limit;
* until the time limit or a full page;
* ranked the same way;
* without folder sizes;
* following symlinks by the same rule as the index.

`searchInfo.indexed` is `false`.

## 4. Critique of the first plan, and what changed

The plan was reviewed before and during the implementation; the tests in 4.2 found the rest.
Each point is the problem first, then what was done.

### 4.1 Design

| Plan v1 | Problem | Now |
|---|---|---|
| Breadth-first ids, scope as a path range on the parent folder | A scoped search in a big subtree still walks `node_path` and joins every entry. Permission pruning can't skip anything. | Depth-first ids: a subtree is an id range. Scope and permissions become a few ranges, the delta and moved subtrees two more. |
| A rename is delete + re-add of the subtree | Renaming a top folder of a share re-indexes millions of entries, and they're missing from search until then. | Detach by path, reattach by device:inode in the same pass; the subtree keeps its ids. `moved` keeps their ranges searchable. |
| Exact/prefix tier only for a single word | `ubuntu iso` loses the folder `ubuntu-24.04-iso` once FTS candidates are cut off. | The first word always runs through the tiers, with the other words as filters. |
| Exact match as `key = t` | `ubuntu.iso` sorts after `ubuntu-…`; with 5000 prefix candidates cut off, the exact file can fall out. | A separate exact lookup (`t` and `t.…`, 1000 candidates). |
| Short words: name prefix only | `x` or `ab` can't use trigrams, but "prefix only" silently misses `linux-x.iso`. | The prefix tier, then a bounded, ranked scan (300 000 entries), with an honest "stopped early". |
| Small scope: count, then scan if ≤ 50 000 | The count is itself a scan, and the threshold is arbitrary. | Unnecessary: a small scope is a small id range, and every shape is windowed. |
| `regexTimeLimit` separate from `timeLimit` | Two clocks; the regex could use up the request's budget. | The `REGEXP` function checks the request's own deadline. |
| `stat` per result plus `Acl` re-check | `is_managed_path` re-walks every ancestor per result: 0.5 ms per deep folder, 130–200 ms per page of 200 (6.4). | A per-request memo of the inherited part. |
| Concurrency: wait 1.5 s for a slot | A worker waiting for a slot is a worker downloads can't have. Even 150 ms was too much: with 64 clients searching, every PHP worker was waiting for a slot, and downloads dropped from about 700 to 19 a second (measured, 6.3). | At most as many waiting as running (2 × `concurrency` workers in all); the rest get 503 at once, and the browser retries with backoff. |
| 30 searches per 10 s per IP | Fast typing with a 250 ms pause rule, corrections and Enter can reach 3–4 a second, and several visitors behind one NAT share an address. | 60 per 10 s; the client cache and in-flight rule keep one visitor well below it. |
| `searchInfo.ms`, `indexAge` for everyone | Timings tell visitors about the server's load and the index's freshness. | Admins only. |
| Symlinked folders "followed once by device+inode" | Which path wins depends on traversal order; a link back into the tree indexes folders twice; a link above the root indexes the whole disk. | Only links leading out of the tree are followed, each target once, never one inside or above another (3.3). |
| `inotify` considered | One watch per folder, set up by a full walk at every start, within `fs.inotify.max_user_watches`. It misses changes other hosts make on NFS, SMB and FUSE, and needs a long-running process (none on a drop-in). | Not used: an unchanged pass costs a `stat` per folder (1 s for 28 000 folders, 6.2), cheap enough every 5 minutes. |

### 4.2 Bugs the tests found

`test-php/search.test.php` builds random trees and applies random changes between passes:

* creates, deletes and renames;
* moves across folders, file ↔ folder swaps;
* `chmod 0`, symlinks into the tree, loops, another "disk" linked in;
* nested installs, unmanaged folders, same-second changes;
* sliced and bulk passes.

After every pass, every query (words, phrases, exclusions, globs, `re:`, short words) in every
scope and for several permission sets is compared with a reference walk that uses the listing
code. A page of 3 must also equal the top 3 of the full ranking. The concurrency and wait slots
are checked from a child process. It runs on PHP 8.2, 8.3 and 8.4 (CI: 8.2 and 8.4, a new seed
every run) and passed 20 seeded runs of 16 rounds across them. What it found:

* **Same-second changes**: a build and a change within the same second left a folder with "equal"
  times, so a broken symlink created in that second never appeared. A dirty folder (changed
  within the last second) is now always fully re-listed, and a folder found gone marks its parent
  dirty.
* **Links taken for renames**: a symlink to a folder has the target's device:inode, so a deleted
  folder could be "reattached" to a link. Link rows are excluded from reattaching.
* **Rename, then mkdir of the old name** lost the new folder's subtree. Fixed with an explicit
  re-insert.
* **An unmanaged folder as a permission root**: anonymous searches missed it. Fixed with a range
  of its own id.
* **Id reuse after deletes** could put a new entry inside an old range. Fixed with
  `AUTOINCREMENT`.
* **A short page wasn't the top of the full ranking**, three ways:
  * exact rows merged without their ids as keys;
  * the scan stopped at the first rows found instead of the best ones;
  * bind parameter names reused across statements, which silently compared ids with strings.

  All three are fixed, and the engine now throws on any unbound parameter.

The integration suite (`test-integration/40-search.test.mjs`) covers the HTTP side:

* the query language, ranking, scope and caps;
* `searchInfo` and its admin-only fields;
* that hidden, unmanaged and `_h6ai` entries are never found;
* 400 for bad input, and the rate limit (429 with `Retry-After`).

The browser test covers the UI: ranking kept until a header is clicked, the status line, no
match, Escape. `test-native/systemd.sh` covers the indexer service under its sandbox, through a
reboot.

### 4.3 Measured limitations

* **Freshness**: new files appear in search within `refreshInterval` (5 minutes), or at once with
  `h6ai-index refresh`. Listings are always live.
* **Size**: about 180 bytes per entry (175 MiB for a million): the trigram postings
  (`detail=full`, needed for phrases) are most of it. The disk it lives on needs that much
  free, twice during a rebuild.
* **Very common first words** (`ubuntu` on a share where 12 000 names start with it): the prefix
  tier ranks the first 5000 by name, and the answer says `truncated`. Adding a word narrows it.
* **1–2 character words on big trees** look at 300 000 entries, then stop and say so.
* **Network file systems** with unreliable mtimes need `trustMtime: false` (every pass re-lists
  every folder) or a shorter `verifyInterval`.

## 5. Configuration (`search` in options.json)

```json
"search": {
    "enabled": false, "advanced": true, "debounceTime": 250, "ignorecase": true,
    "maxResults": 200, "timeLimit": 3, "concurrency": 4,
    "rateLimit": {"max": 60, "window": 10},
    "candidates": 20000, "regex": true,
    "index": {
        "enabled": true, "refreshInterval": 300, "verifyInterval": 604800, "trustMtime": true,
        "sliceTime": 2, "maxEntriesPerFolder": 100000, "maxDepth": 64, "background": "auto"
    }
}
```

Every option is documented in `options.json`.

## 6. Measurements

### 6.1 Setup

| | |
|---|---|
| Machine | 10 × Intel Xeon E5-2670 v2 @ 2.50 GHz (VM), 15 GiB (swap in use: memory was tight), LVM on a virtual disk |
| Software | the Docker image: PHP 8.3.36 (FPM, OPcache + JIT, `pm.max_children` 32), nginx 1.30.6, SQLite 3.53.4, Docker 29.9.2 |
| Tree | `test-php/bench/gen-tree.php`: 1 000 000 entries, 28 354 folders, empty files with realistic names (camera dumps, releases, documents, TV episodes, accented and non-Latin words), up to 7 levels deep, a few folders of 2000–8000 files |
| Old | h6ai 1.0.1 on the same tree, its own defaults (`maxResults` 1000, `timeLimit` 10), sent what its UI sends |
| New | this version, defaults, except `search.rateLimit.max: 0` for the load test (all clients share one IP) |
| Client | `test-php/bench/search-bench.mjs` on the same host, keep-alive |

Single runs on a shared VM with other work on it: expect ±20 %.

### 6.2 The index

| | |
|---|---|
| Full build, 1 000 000 entries | 112–136 s at `nice 19`, `ionice` idle (165 s with a Docker build running next to it) |
| Index size | 175.5 MiB (184 bytes per entry); during a rebuild both generations exist for up to 2 minutes |
| Indexer memory | 2 MiB for a refresh pass, 4 MiB for a full build (peak) |
| Refresh pass, nothing changed | 1.0–1.4 s: a `stat` of each of 28 356 folders |
| Refresh pass after changes | 4.4 s for 10 000 new files in 100 new folders, a top folder of 60 685 entries renamed and a file removed: 105 folders re-listed, 10 103 changes. The renamed folder was reattached (no re-index), and its entries were found under the new path at once |

### 6.3 Downloads and listings while people search

4 clients download a small file through the gate and 2 list a folder, for 30 s, while N clients
search without pause. Searchers behave like the browser: one search in flight each, and a
backoff on 503.

| | downloads/s | download p50 / p99 | listing p50 / p99 | searches/s | search p50 |
|---|---:|---:|---:|---:|---:|
| new, no search | 689 | 5.3 / 15 ms | 15 / 38 ms | | |
| new, 16 searching | 843 | 3.4 / 20 ms | 9.1 / 45 ms | 34 | 146 ms |
| new, 64 searching | 1026 | 3.3 / 11 ms | 8.9 / 29 ms | 43 | 215 ms |
| old, no search | 793 | 4.9 / 11 ms | 14 / 28 ms | | |
| old, 16 searching | 696 | 3.9 / 19 ms (max 3.2 s) | 16 / 38 ms | 3.9 | 3180 ms |
| old, 64 searching | **0.8** | **6171 / 8996 ms** | **6401 / 9021 ms** | 7.8 | 9978 ms |

With the new search, downloads and listings don't notice searches: the variation is within
the noise of the machine. Search throughput is capped by the 4 slots, about 40 searches a
second here. Past that, searchers wait: 0.5 % of the searches at 16 and 9 % at 64 non-stop
searchers still got "busy" after 4 retries. A real visitor reads results between searches. Old h6ai with 64
searchers held every PHP worker for up to 10 s per search, and downloads all but stopped.

The first version of the slots let every rejected request wait 150 ms for a turn. With 64
searchers that held all 32 workers, and downloads fell to 19 a second with a p50 of 189 ms. Hence
the wait slots (3.9).

### 6.4 Query latency (one client, HTTP, server idle)

New: 200 results per page, median of 7 after a warm-up. Old: up to 1000 results, median of 3.

| Query | New: results | p50 | max | Old: results | p50 | max |
|---|---:|---:|---:|---:|---:|---:|
| `ubuntu` | 200 (more, truncated) | 65 ms | 77 ms | 1000 | 1345 ms | 3749 ms |
| `ubuntu iso` | 200 (more) | 85 ms | 107 ms | 1000 | 972 ms | 1502 ms |
| `img_2019` | 200 (more, truncated) | 48 ms | 52 ms | 1000 | 344 ms | 390 ms |
| `final report` | 200 (more) | 84 ms | 99 ms | 1000 | 832 ms | 2994 ms |
| `*.iso` | 200 (more, truncated) | 97 ms | 239 ms | 0 | 10 009 ms | 10 011 ms |
| `cafe` (finds `café`) | 200 (more, truncated) | 64 ms | 95 ms | 1000 | 4562 ms | 4798 ms |
| `mkv` | 200 (more, truncated) | 82 ms | 82 ms | 1000 | 196 ms | 227 ms |
| `x` | 200 (more, truncated) | 200 ms | 240 ms | 1000 | 641 ms | 2447 ms |
| `ab` | 0 (truncated) | 90 ms | 92 ms | 1000 | 514 ms | 1143 ms |
| `S03E07` | 200 (more) | 49 ms | 54 ms | 195 | 10 013 ms | 10 085 ms |
| `budget 2015` | 1 | 47 ms | 50 ms | 1000 | 901 ms | 4625 ms |
| `zzqqxx` (no match) | 0 | 8.7 ms | 9.1 ms | 0 | 10 009 ms | 10 094 ms |
| `notes -draft` | 200 (more, truncated) | 68 ms | 80 ms | 1000 | 1864 ms | 2617 ms |
| `"meeting notes"` | 115 | 46 ms | 47 ms | 0 | 10 018 ms | 10 064 ms |
| `firmware 12.3` | 38 | 50 ms | 53 ms | 1000 | 1676 ms | 2770 ms |
| `résumé` | 200 (more, truncated) | 66 ms | 73 ms | 1000 | 1665 ms | 5576 ms |

How to read the old column: its 1000 results are the first matches in walk order, not the best
ones. Its matching was fuzzy: `budget 2015` became `b.*?u.*?d…|2.*?0.*?1.*?5`, which matches
about anything with those letters in that order, so "1000" there is mostly noise. The new
`budget 2015` finds the one file with both words. A query with few or no matches walked until
the 10 s limit, and `S03E07` found 195 of its roughly 580 matches by then. *(truncated)* on the new side
means a candidate limit was reached (3.6). The page still holds the best matches among them,
and the status line says so.

About 30–40 ms of each new query is the per-result check of 200 results (3.8). Before that check
remembered inherited folder state, it was 130–200 ms. A query without results shows the fixed
cost (9 ms).

### 6.5 Reproduce

```sh
docker volume create h6ai-bench-files
docker run --rm -v h6ai-bench-files:/b -v "$PWD/test-php/bench:/x:ro" php:8.3-cli php /x/gen-tree.php /b 1000000
# a container of the image with the volume mounted below its web root, search on, no per-IP limit:
#   -v h6ai-bench-files:/srv/www/bench:ro and options.local.json
#   {"search": {"enabled": true, "rateLimit": {"max": 0}}, "thumbnails": {"enabled": false}}
docker exec <container> h6ai-index rebuild
node test-php/bench/search-bench.mjs latency http://127.0.0.1:<port> new 7
node test-php/bench/search-bench.mjs load http://127.0.0.1:<port> new 30 64 /small.txt /bench/
```

List the folder once before a load test: its first listing computes the folder sizes of the
whole tree (40–60 s), and that would distort the baseline.
