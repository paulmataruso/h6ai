#!/bin/sh
# Creates <dir>/big-<N>g.bin with N GiB of random data (real disk reads, unlike sparse files).
# Skips if the file already has the right size. Written to a hidden temp name first, so the
# listing never shows a half written file.
set -eu

DIR=$1
GIB=$2
case "$GIB" in ''|*[!0-9]*) echo "[big] invalid size '$GIB', skipping"; exit 0 ;; esac
FILE="$DIR/big-${GIB}g.bin"
TMP="$DIR/.big-${GIB}g.bin.partial"
WANT=$((GIB * 1024 * 1024 * 1024))

mkdir -p "$DIR"
if [ -f "$FILE" ] && [ "$(stat -c %s "$FILE")" = "$WANT" ]; then
    echo "[big] $FILE present ($GIB GiB)"
    exit 0
fi

free=$(df -Pk "$DIR" | awk 'NR == 2 {print $4}')
if [ "$free" -lt $(( (WANT / 1024) + 1048576 )) ]; then
    echo "[big] not enough free space for $GIB GiB in $DIR, skipping"
    exit 0
fi

echo "[big] writing $GIB GiB of random data to $FILE in the background ..."
started=$(date +%s)
rm -f "$TMP"
i=1
while [ "$i" -le "$GIB" ]; do
    # 64 x 16 MiB = 1 GiB per step
    dd if=/dev/urandom bs=16M count=64 iflag=fullblock status=none >> "$TMP"
    echo "[big] $i/$GIB GiB"
    i=$((i + 1))
done
chmod 0644 "$TMP"
owner=$(stat -c %u:%g "$(dirname "$DIR")")
chown "$owner" "$TMP" 2>/dev/null || true
mv "$TMP" "$FILE"
echo "[big] done: $FILE ($(stat -c %s "$FILE") bytes) in $(( $(date +%s) - started ))s"
