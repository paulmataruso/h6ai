#!/bin/sh
# Native installer test. Per distribution, in a clean container:
#   1. install.sh from the release bundle (as a user would run it)
#   2. the HTTP integration suite (test-integration/) against that install
#   3. the h6ai-user command, an upgrade (re-run), an uninstall, a re-install and a purge
#
#   test-native/run.sh                     all distributions
#   test-native/run.sh debian12 alpine322  some of them
#
# Containers have no init system. Debian and Ubuntu start their daemons through /etc/init.d,
# elsewhere the installer reports "no service manager" and this script starts them itself.
# Logs: test-native/logs/<distro>.log. KEEP=1 keeps the containers (h6ai-native-<distro>),
# SKIP_BUILD=1 reuses build/h6ai-<version>.tar.gz (for parallel runs).
# shellcheck disable=SC2016 # single-quoted commands are expanded inside the container
set -eu
cd "$(dirname "$0")/.."

ALL="debian12 debian13 ubuntu2204 ubuntu2404 ubuntu2604 rocky9 fedora44 alpine322"
image_of() {
    case $1 in
        debian12) echo debian:12 ;; debian13) echo debian:13 ;;
        ubuntu2204) echo ubuntu:22.04 ;; ubuntu2404) echo ubuntu:24.04 ;; ubuntu2604) echo ubuntu:26.04 ;;
        rocky9) echo rockylinux:9 ;; fedora44) echo fedora:44 ;; alpine322) echo alpine:3.22 ;;
        *) return 1 ;;
    esac
}
# bootstrap login admin/admin-test and the options the suite expects (see compose.dev.yaml)
PASSHASH='$2y$10$3oSPC0TARrMhHAVbLgW5O.IDVLaWCC4eOwApT63oHr.wQ3BCanofi'

DISTROS=${*:-$ALL}
for d in $DISTROS; do image_of "$d" >/dev/null || { echo "unknown distribution: $d (known: $ALL)" >&2; exit 2; }; done

mkdir -p test-native/logs
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
VERSION=$(node -p 'require("./package.json").version')
if [ "${SKIP_BUILD:-0}" != 1 ] || [ ! -f "build/h6ai-$VERSION.tar.gz" ]; then
    echo "[native] building the release bundle"
    npm run -s release >/dev/null
fi
tar -xzf "build/h6ai-$VERSION.tar.gz" -C "$WORK"
BUNDLE=$WORK/h6ai-$VERSION
node -e 'const o = JSON.parse(require("fs").readFileSync("docker/options.local.json", "utf8")); o.passhash = process.argv[1]; console.log(JSON.stringify(o, null, 2));' \
    "$PASSHASH" > "$WORK/options.local.json"

# fixed port per distribution, so several runs can go in parallel
port_of() { i=18800; for a in $ALL; do i=$((i + 1)); [ "$a" != "$1" ] || echo "$i"; done; }
summary=
for d in $DISTROS; do
    port=$(port_of "$d")
    c=h6ai-native-$d
    log=test-native/logs/$d.log
    : > "$log"
    result=PASS
    note=
    fail() { result=FAIL; note="$note $1;"; echo "[native] $d: FAIL $1" | tee -a "$log"; }
    x() { docker exec "$c" sh -c "$1" >> "$log" 2>&1; }

    echo "[native] $d: $(image_of "$d") on 127.0.0.1:$port"
    docker rm -f "$c" >/dev/null 2>&1 || true
    docker run -d --name "$c" -p "127.0.0.1:$port:80" \
        -v "$BUNDLE:/opt/h6ai-bundle:ro" -v "$PWD/docker:/opt/seed:ro" -v "$WORK/options.local.json:/opt/options.local.json:ro" \
        "$(image_of "$d")" sleep infinity >/dev/null

    # 1. install (Ubuntu 22.04 has PHP 8.1: needs the PHP repository)
    extra=
    [ "$d" = ubuntu2204 ] && extra=--allow-php-repo
    start=$(date +%s)
    if ! x "/opt/h6ai-bundle/install.sh --yes --root /srv/www --no-admin --no-firewall $extra"; then
        fail "install.sh"
        summary="$summary\n$d: $result$note"
        continue
    fi
    echo "[native] $d: installed in $(( $(date +%s) - start ))s"
    x '. /etc/h6ai/install.conf
       [ -S "$FPM_SOCK" ] || { mkdir -p "$(dirname "$FPM_SOCK")"; "$FPM_BIN"; }
       curl -s -o /dev/null http://127.0.0.1/ || { mkdir -p /run/nginx; nginx; }' || fail "start daemons"
    grep -E "CVE-2026-109618|warning|PHP [0-9]" "$log" | sed "s/^/[native] $d:   /" || true

    # 2. integration suite on the sample tree
    x '. /etc/h6ai/install.conf; H6AI_WEBROOT=/srv/www H6AI_OUTSIDE=/srv/outside PHP_BIN=$PHP_BIN sh /opt/seed/seed.sh
       cp /opt/options.local.json /srv/www/_h6ai/private/conf/options.local.json
       chmod 0644 /srv/www/_h6ai/private/conf/options.local.json' || fail "seed"
    x 'rm -f /srv/www/_h6ai/private/cache/ratelimit-*.json'
    if H6AI_URL="http://127.0.0.1:$port" node --test --test-concurrency=1 test-integration/ \
        > "test-native/logs/$d.suite.log" 2>&1; then
        echo "[native] $d: suite $(grep -E '^# (pass|skipped)' "test-native/logs/$d.suite.log" | tr '\n' ' ')"
        grep -E '# SKIP' "test-native/logs/$d.suite.log" | sed "s/^/[native] $d:   /" || true
    else
        fail "suite ($(grep -E '^# (pass|fail)' "test-native/logs/$d.suite.log" | tr '\n' ' '))"
        grep -E '^not ok' "test-native/logs/$d.suite.log" | sed "s/^/[native] $d:   /" || true
    fi
    exe=$(docker exec "$c" sh -c 'find /srv/www/_h6ai/public/cache -type f -perm /111' 2>/dev/null || true)
    [ -z "$exe" ] || fail "executable files in the public cache"

    # 3. user command, upgrade, uninstall, re-install, purge
    x 'rm -f /srv/www/_h6ai/private/cache/ratelimit-*.json'
    x 'echo "alice-secret-1" | h6ai-user add alice --admin --password-stdin && h6ai-user has-admin && h6ai-user list' || fail "h6ai-user add"
    x '[ "$(stat -c %U /srv/www/_h6ai/private/data/auth.json)" = h6ai ]' || fail "auth.json not owned by h6ai"
    H6AI_URL="http://127.0.0.1:$port" node -e '
        import("./test-integration/lib.mjs").then(async ({login}) => {
            const {res, json} = await login("alice", "alice-secret-1");
            if (!(json && json.asAdmin === true && json.user === "alice")) {
                console.log("login response:", res.statusCode, JSON.stringify(json));
                process.exit(1);
            }
        });' >> "$log" 2>&1 || fail "login as the h6ai-user admin"
    x 'out=$(/opt/h6ai-bundle/install.sh --yes --no-firewall) && echo "$out" && echo "$out" | grep -q "Upgrading h6ai"' \
        || fail "re-run is not an upgrade"
    x 'h6ai-user list | grep -q alice' || fail "upgrade lost users"
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/")
    [ "$code" = 200 ] || fail "index after upgrade: $code"
    x '/opt/h6ai-bundle/install.sh --uninstall' || fail "uninstall"
    x '[ -d /srv/www/_h6ai/private/data ] && [ -f /srv/www/docs/readme.md ] && ! [ -e /etc/nginx/h6ai/server.conf ] && nginx -t' \
        || fail "uninstall kept/removed the wrong things"
    x 'out=$(/opt/h6ai-bundle/install.sh --yes --root /srv/www --no-firewall) && echo "$out" && ! echo "$out" | grep -q "Creating the admin"' \
        || fail "re-install"
    x 'h6ai-user list | grep -q alice' || fail "re-install lost users"
    x '/opt/h6ai-bundle/install.sh --uninstall --purge' || fail "purge"
    x '! [ -e /srv/www/_h6ai ] && ! id h6ai && [ -f /srv/www/docs/readme.md ]' || fail "purge removed the wrong things"

    [ "${KEEP:-0}" = 1 ] || docker rm -f "$c" >/dev/null 2>&1 || true
    echo "[native] $d: $result"
    summary="$summary\n$d: $result$note"
done

printf '\n[native] summary:%b\n' "$summary"
case $summary in *FAIL*) exit 1 ;; esac
