#!/bin/sh
# Performance benchmark against the running compose service (see docs/PERFORMANCE.md).
#
#   test-integration/bench.sh                   # http://172.16.1.67:8687
#   H6AI_URL=http://host:port test-integration/bench.sh
#
# Needs the seeded sample web root incl. big/big-7g.bin (H6AI_SEED_BIG_GB=7) and the bootstrap
# admin (no other admin user) for the gate-overhead part. Temporarily switches download.type in
# docker/options.local.json for the shell-tar run and restores it afterwards.
set -eu
cd "$(dirname "$0")/.."

URL=${H6AI_URL:-http://${H6AI_BIND:-172.16.1.67}:${H6AI_PORT:-8687}}
export H6AI_URL=$URL
SERVICE=${H6AI_SERVICE:-h6ai}
BIG=/big/big-7g.bin
LOAD="node test-integration/bench-load.mjs"
OPTS=docker/options.local.json

hr() { printf '\n## %s\n' "$1"; }
mib() { awk -v b="$1" -v t="$2" 'BEGIN { printf "%.0f MiB/s", b / t / 1048576 }'; }

# curl one URL to /dev/null; prints throughput, TTFB, total time, bytes
fetch() { # fetch <label> <curl args...>
    label=$1; shift
    out=$(curl -s -o /dev/null -w '%{http_code} %{size_download} %{time_starttransfer} %{time_total}' "$@")
    set -- $out
    printf '%-38s HTTP %s  %s  ttfb %.3fs  total %.2fs  %s bytes\n' "$label" "$1" "$(mib "$2" "$4")" "$3" "$4" "$2"
}

hr "environment"
echo "date:     $(date -u +%FT%TZ)"
echo "target:   $URL"
echo "cpu:      $(nproc) x $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ *//')"
echo "memory:   $(free -g | awk '/^Mem:/ {print $2 " GiB total, " $7 " GiB available"}')"
src=$(df -P webroot | awk 'NR == 2 {print $1}')
echo "webroot:  $src ($(df -hP webroot | awk 'NR == 2 {print $4}') free)"
for d in $(lsblk -s -n -o NAME,TYPE "$src" 2>/dev/null | awk '$2 == "disk" {print $1}' | sed 's/^[^a-z]*//'); do
    echo "disk:     $d rota=$(cat /sys/block/$d/queue/rotational 2>/dev/null) model=$(cat /sys/block/$d/device/model 2>/dev/null | sed 's/ *$//')"
done
echo "php:      $(docker compose exec -T "$SERVICE" php -r 'echo PHP_VERSION;')"
echo "nginx:    $(docker compose exec -T "$SERVICE" nginx -v 2>&1 | cut -d/ -f2)"
size=$(stat -c %s webroot$BIG)
echo "big file: $BIG $size bytes"

hr "single full download of the 7 GiB file (nginx: sendfile/directio + aio threads)"
fetch "via published port ($URL)" "$URL$BIG"
fetch "again (warm)" "$URL$BIG"
out=$(docker compose exec -T "$SERVICE" curl -s -o /dev/null -w '%{http_code} %{size_download} %{time_starttransfer} %{time_total}' "http://127.0.0.1$BIG")
set -- $out
printf '%-38s HTTP %s  %s  ttfb %.3fs  total %.2fs\n' "inside the container (loopback)" "$1" "$(mib "$2" "$4")" "$3" "$4"

hr "4 parallel full downloads"
start=$(date +%s.%N)
for i in 1 2 3 4; do curl -s -o /dev/null "$URL$BIG" & done
wait
end=$(date +%s.%N)
t=$(awk -v a="$start" -v b="$end" 'BEGIN { print b - a }')
printf '4 x %s bytes in %.2fs: aggregate %s\n' "$size" "$t" "$(mib $((size * 4)) "$t")"

hr "Range read of 256 MiB from the middle"
mid=$((size / 2))
fetch "bytes=$mid-$((mid + 268435455))" -H "Range: bytes=$mid-$((mid + 268435455))" "$URL$BIG"

hr "archive downloads of /big/ streamed through PHP (~$((size / 1073741824 + 1)) GiB)"
fetch "php-tar" -X POST -H "Origin: $URL" --data-urlencode action=download --data-urlencode as=big.tar \
    --data-urlencode type=php-tar --data-urlencode baseHref=/big/ --data-urlencode hrefs= "$URL/big/"
# options.local.json is a single-file bind mount: rewrite it in place (same inode), never mv/sed -i
cp "$OPTS" "$OPTS.bench-bak"
trap 'cat "$OPTS.bench-bak" > "$OPTS"; rm -f "$OPTS.bench-bak"' EXIT INT TERM
sed 's/"type": "php-tar"/"type": "shell-tar"/' "$OPTS.bench-bak" > "$OPTS"
sleep 1
fetch "shell-tar (GNU tar via proc_open)" -X POST -H "Origin: $URL" --data-urlencode action=download --data-urlencode as=big.tar \
    --data-urlencode type=shell-tar --data-urlencode baseHref=/big/ --data-urlencode hrefs= "$URL/big/"
cat "$OPTS.bench-bak" > "$OPTS"
rm -f "$OPTS.bench-bak"
trap - EXIT INT TERM

hr "listing API latency (POST items, 50 sequential requests, keep-alive)"
printf '%-12s %s\n' "/big/" "$($LOAD latency /big/ 50)"
printf '%-12s %s\n' "/many/" "$($LOAD latency /many/ 50)"
printf '%-12s %s\n' "/" "$($LOAD latency / 50)"

hr "file gate overhead (10 s, 16 concurrent keep-alive clients, small file)"
docker compose exec -T "$SERVICE" sh -c 'rm -f /srv/www/_h6ai/private/cache/ratelimit-*'
printf '%-44s %s\n' "static asset, no gate (/_h6ai/public/...)" "$($LOAD rps /_h6ai/public/images/favicon/favicon.svg 10 16)"
printf '%-44s %s\n' "/docs/notes.txt, gate, no rules" "$($LOAD rps /docs/notes.txt 10 16)"
$LOAD rule add >/dev/null
printf '%-44s %s\n' "/docs/notes.txt, gate, rules configured" "$($LOAD rps /docs/notes.txt 10 16)"
printf '%-44s %s\n' "/private/secret.txt, gate denies (401)" "$($LOAD rps /private/secret.txt 10 16)"
$LOAD rule del >/dev/null
