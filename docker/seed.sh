#!/bin/sh
# Populates the web root with a sample tree for manual and automated testing of h6ai.
#
# * Files outside the web root (traversal targets) live in the container and are re-created on
#   every start.
# * The web root (a host directory with compose) is only seeded once, and only if it is empty
#   apart from _h6ai - your own files are never touched. H6AI_RESEED=1 re-creates the sample
#   files (it overwrites files of the same name, nothing else).
# Names used here are mirrored in test-integration/lib.mjs - keep them in sync.
set -eu

WWW=${H6AI_WEBROOT:-/srv/www}
OUTSIDE=${H6AI_OUTSIDE:-/srv/outside}
MARKER=$WWW/.h6ai-seeded
HERE=$(cd "$(dirname "$0")" && pwd)
MEDIA="php $HERE/seed-media.php"

# --- outside the web root (S1, S11): every start --------------------------------------------
mkdir -p "$OUTSIDE"
[ -f "$OUTSIDE/secret.jpg" ] || $MEDIA jpeg "$OUTSIDE/secret.jpg" 400 300
echo "OUTSIDE-SECRET" > "$OUTSIDE/secret.txt"
echo "<p>OUTSIDE-SECRET header</p>" > "$OUTSIDE/_h6ai.header.html"
echo "<p>OUTSIDE-SECRET headers</p>" > "$OUTSIDE/_h6ai.headers.html"
# parent of the web root: must never be used as a custom header source (S11)
echo "<p>ABOVE-ROOT-SECRET</p>" > "$(dirname "$WWW")/_h6ai.headers.html"
chmod -R a+rX "$OUTSIDE"

# --- web root: once ----------------------------------------------------------------------------
if [ -f "$MARKER" ] && [ "${H6AI_RESEED:-0}" != "1" ]; then
    echo "[seed] web root already seeded ($MARKER exists), skipping"
    exit 0
fi
if [ ! -f "$MARKER" ] && [ "${H6AI_RESEED:-0}" != "1" ] \
    && [ -n "$(ls -A "$WWW" | grep -v -x -e _h6ai -e lost+found || true)" ]; then
    echo "[seed] $WWW already has content - not seeding the sample tree (H6AI_RESEED=1 forces it)"
    exit 0
fi

echo "[seed] populating $WWW"
started=$(date +%s)

repeat() { # repeat <char> <count>
    printf "%${2}s" "" | tr ' ' "$1"
}

# --- images -------------------------------------------------------------------
$MEDIA images "$WWW/images"
$MEDIA bomb "$WWW/images/bomb.png"

# --- videos / audio -----------------------------------------------------------
mkdir -p "$WWW/videos" "$WWW/audio"
ff() { ffmpeg -nostdin -hide_banner -loglevel error -y "$@"; }
ff -f lavfi -i testsrc2=duration=5:size=640x360:rate=25 -f lavfi -i sine=frequency=440:duration=5 \
    -shortest -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "$WWW/videos/clip-5s.mp4" \
  || ff -f lavfi -i testsrc2=duration=5:size=640x360:rate=25 -c:v mpeg4 "$WWW/videos/clip-5s.mp4"
ff -f lavfi -i testsrc=duration=20:size=320x180:rate=15 -f lavfi -i sine=frequency=660:duration=20 \
    -shortest -c:v libvpx -b:v 200k -deadline realtime -cpu-used 8 -c:a libopus "$WWW/videos/clip-20s.webm" \
  || ff -f lavfi -i testsrc=duration=20:size=320x180:rate=15 -c:v libvpx -b:v 200k "$WWW/videos/clip-20s.webm"
ff -f lavfi -i sine=frequency=523:duration=3 -c:a libmp3lame -q:a 6 "$WWW/audio/tone.mp3" || true
ff -f lavfi -i sine=frequency=392:duration=3 -c:a libopus "$WWW/audio/tone.ogg" || true

# --- docs (incl. stored-XSS payloads in markdown, S5) ----------------------------
mkdir -p "$WWW/docs"
cat > "$WWW/docs/readme.md" <<'EOF'
# Sample README

Regular **markdown** with a [normal link](https://example.com) and `inline code`.

```js
console.log('fenced code block');
```

## XSS payloads (must be neutralised by the sanitiser)

<script>alert('xss-script')</script>

<img src=x onerror="alert('xss-img')">

[click me](javascript:alert('xss-link'))

<a href="javascript:alert('xss-a')">raw anchor</a>

<iframe src="javascript:alert('xss-iframe')"></iframe>

<svg><script>alert('xss-svg')</script></svg>
EOF
cat > "$WWW/docs/_h6ai.header.md" <<'EOF'
**Header from `_h6ai.header.md`** - the payloads below must not execute.

<img src=x onerror="alert('xss-header')"> <script>alert('xss-header-script')</script> [bad](javascript:alert('xss-header-link'))
EOF
cat > "$WWW/docs/_h6ai.footer.html" <<'EOF'
<p>Footer from <code>_h6ai.footer.html</code>. <img src=x onerror="alert('xss-footer')"><script>alert('xss-footer-script')</script></p>
EOF
cat > "$WWW/docs/notes.txt" <<'EOF'
Plain text notes.
Line two with <b>tags</b> that must be shown literally.
EOF
cat > "$WWW/docs/code.js" <<'EOF'
// syntax highlighting sample
const greet = name => `hello ${name}`;
export default function main() {
    return [1, 2, 3].map(n => greet(String(n)));
}
EOF
cat > "$WWW/docs/style.css" <<'EOF'
body { color: #333; background: #fff; }
EOF
cat > "$WWW/docs/data.json" <<'EOF'
{"name": "h6ai", "values": [1, 2, 3], "nested": {"ok": true}}
EOF
printf '<?php echo "this must never execute"; ?>\n' > "$WWW/docs/not-executed.php"
# active documents (CVE-2026-10961): nginx must serve these with a script-free CSP sandbox
cat > "$WWW/docs/page.html" <<'EOF'
<!doctype html><meta charset="utf-8"><title>Active content test</title>
<h1>Active content</h1><p id="state">script did not run (sandboxed)</p>
<script>document.getElementById('state').textContent = 'SCRIPT RAN'; alert(1);</script>
EOF
cat > "$WWW/docs/vector.svg" <<'EOF'
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">
  <rect width="120" height="60" fill="#4c8dff"/><text x="10" y="35" fill="#fff">svg</text>
  <script>alert('svg-script')</script>
</svg>
EOF
$MEDIA pdf "$WWW/docs/sample.pdf"

# --- XSS via file and folder names (S4) ------------------------------------------
mkdir -p "$WWW/xss"
echo "xss filename" > "$WWW/xss/<img src=x onerror=alert(1)>.txt"
mkdir -p "$WWW/xss/\"><svg onload=alert(1)>"
echo "inside" > "$WWW/xss/\"><svg onload=alert(1)>/inside.txt"
echo "quote" > "$WWW/xss/it's \"quoted\" & <b>bold.txt"

# --- hidden content (S1, S9, S10) ---------------------------------------------------
mkdir -p "$WWW/.hidden" "$WWW/visible"
$MEDIA jpeg "$WWW/.hidden/secret.jpg" 400 300
$MEDIA jpeg "$WWW/visible/.secret.jpg" 400 300
echo "this file is visible" > "$WWW/visible/public.txt"
echo "secret note" > "$WWW/.hidden/secret.txt"

# --- long names for php-tar PAX headers (S10) ---------------------------------------
D1="L1_$(repeat a 97)"
D2="L2_$(repeat b 97)"
F="F_$(repeat c 174).txt"
mkdir -p "$WWW/deep/$D1/$D2"
echo "long path content" > "$WWW/deep/$D1/$D2/$F"
echo "small" > "$WWW/deep/small.txt"
echo "short" > "$WWW/deep/$D1/short.txt"

# --- symlink cycle (S9, S13) --------------------------------------------------------
mkdir -p "$WWW/loop"
echo "file in loop" > "$WWW/loop/file.txt"
ln -sfn .. "$WWW/loop/self"

# --- unmanaged folder (has its own index.html) ---------------------------------------
mkdir -p "$WWW/site"
cat > "$WWW/site/index.html" <<'EOF'
<!doctype html><meta charset="utf-8"><title>Unmanaged site</title><h1>Unmanaged site</h1>
<p>This folder has its own index.html, so h6ai does not manage it.</p>
EOF

# --- unicode and special characters in names ----------------------------------------
mkdir -p "$WWW/unicode"
echo "unicode" > "$WWW/unicode/Ünïcödé — 日本語.txt"
echo "space" > "$WWW/unicode/space name.txt"
echo "percent" > "$WWW/unicode/100%.txt"
echo "hash" > "$WWW/unicode/a#b?.txt"
echo "plus" > "$WWW/unicode/c++ & friends.txt"
mkdir -p "$WWW/unicode/Ordner mit Ümlaut"
echo "nested" > "$WWW/unicode/Ordner mit Ümlaut/datei.txt"

# --- permission-controlled folders (RBAC tests) ---------------------------------------
mkdir -p "$WWW/private" "$WWW/team"
echo "TOP-SECRET private content" > "$WWW/private/secret.txt"
$MEDIA jpeg "$WWW/private/photo.jpg" 800 600
$MEDIA pdf "$WWW/private/report.pdf"
echo "team notes" > "$WWW/team/notes.txt"

# --- large file (Range / ETag / sendfile tests) ----------------------------------------
mkdir -p "$WWW/big"
$MEDIA bigfile "$WWW/big/big.bin" 64

# --- misc -----------------------------------------------------------------------------
mkdir -p "$WWW/empty"
mkdir -p "$WWW/many"
i=1
while [ $i -le 150 ]; do
    echo "file $i" > "$WWW/many/file-$i.txt"
    i=$((i + 1))
done

# readable by nginx/php; owned like the web root itself (the host user with a bind mount);
# never touch the h6ai install (contains read-only bind mounts)
owner=$(stat -c %u:%g "$WWW")
find "$WWW" -path "$WWW/_h6ai" -prune -o ! -path "$WWW" -exec chmod a+rX {} + -exec chown -h "$owner" {} +
date -u +%FT%TZ > "$MARKER"
chown "$owner" "$MARKER"
echo "[seed] done in $(( $(date +%s) - started ))s"
