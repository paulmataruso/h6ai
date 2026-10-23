#!/bin/sh
# The native installer on a server whose nginx already has a site for the name (Debian 12):
#   1. --server-name with a name another site answers for: refused, nginx left as it was
#   2. --no-site: h6ai, PHP-FPM and nginx's http-level part only; the existing server block then
#      includes h6ai/server.conf, and the integration suite runs against it
#   3. an upgrade keeps --no-site; --uninstall points at the server block that still includes h6ai
#
#   test-native/own-site.sh       logs: test-native/logs/own-site*.log
#   KEEP=1 keeps the container (h6ai-native-own-site)
# shellcheck disable=SC2016 # single-quoted commands are expanded inside the container
set -eu
cd "$(dirname "$0")/.."

c=h6ai-native-own-site
log=test-native/logs/own-site.log
mkdir -p test-native/logs
: > "$log"
status=0
fail() { status=1; echo "[own-site] FAIL $1" | tee -a "$log"; }
ok() { echo "[own-site]   ok $1"; }
x() { docker exec "$c" sh -c "$1" >> "$log" 2>&1; }
q() { docker exec "$c" sh -c "$1" 2>&1; }

PASSHASH='$2y$10$3oSPC0TARrMhHAVbLgW5O.IDVLaWCC4eOwApT63oHr.wQ3BCanofi'
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"; [ "${KEEP:-0}" = 1 ] || docker rm -f "$c" >/dev/null 2>&1 || true' EXIT
VERSION=$(node -p 'require("./package.json").version')
[ "${SKIP_BUILD:-0}" = 1 ] && [ -f "build/h6ai-$VERSION.tar.gz" ] || npm run -s release >/dev/null
tar -xzf "build/h6ai-$VERSION.tar.gz" -C "$WORK"
node -e 'const o = JSON.parse(require("fs").readFileSync("docker/options.local.json", "utf8")); o.passhash = process.argv[1]; console.log(JSON.stringify(o, null, 2));' \
    "$PASSHASH" > "$WORK/options.local.json"

docker rm -f "$c" >/dev/null 2>&1 || true
docker run -d --name "$c" -v "$WORK/h6ai-$VERSION:/opt/h6ai-bundle:ro" -v "$PWD/docker:/opt/seed:ro" \
    -v "$WORK/options.local.json:/opt/options.local.json:ro" debian:12 sleep infinity >/dev/null

echo "[own-site] Debian 12 with nginx and a site for files.example.com"
x 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends nginx curl >/dev/null
rm -f /etc/nginx/sites-enabled/default
cat > /etc/nginx/sites-available/files <<"EOF"
server {
    listen 80;
    server_name files.example.com;
    location / {
        return 200 "the other site\n";
    }
}
EOF
ln -s /etc/nginx/sites-available/files /etc/nginx/sites-enabled/files
/etc/init.d/nginx start' || fail "setup"

echo "[own-site] 1. a name another site answers for"
out=$(q '/opt/h6ai-bundle/install.sh --yes --root /srv/www --no-admin --no-firewall --server-name files.example.com; echo "exit=$?"')
echo "$out" >> "$log"
case $out in
    *"another nginx site already answers for files.example.com on port 80 (/etc/nginx/sites-enabled/files)"*"exit=1") ok "refused, naming the other site" ;;
    *) fail "install over another site's name: $(echo "$out" | tail -n 3 | tr '\n' ' ')" ;;
esac
x '! [ -e /etc/nginx/sites-available/h6ai.conf ] && ! [ -e /etc/nginx/sites-enabled/h6ai.conf ] && nginx -t && nginx -s reload' \
    || fail "the refused site is still there"
if [ "$(q 'curl -s -H "Host: files.example.com" http://127.0.0.1/')" = "the other site" ]; then
    ok "nginx and the other site as they were"
else
    fail "the other site changed"
fi

echo "[own-site] 2. --no-site, included in the existing server block"
out=$(q '/opt/h6ai-bundle/install.sh --yes --root /srv/www --no-admin --no-firewall --no-site --port 8080; echo "exit=$?"')
case $out in *"--no-site leaves the server block to you: --port doesn't apply"*"exit=1") ok "--no-site refuses --port" ;; *) fail "--no-site with --port: $out" ;; esac
out=$(q '/opt/h6ai-bundle/install.sh --yes --root /srv/www --no-admin --no-firewall --no-site; echo "exit=$?"')
echo "$out" >> "$log"
case $out in
    *"add the rest to your server block"*"include h6ai/server.conf;"*"exit=0") ok "installed, with what to add to the server block" ;;
    *) fail "--no-site install: $(echo "$out" | tail -n 5 | tr '\n' ' ')" ;;
esac
x 'grep -q "upstream h6ai_php" /etc/nginx/sites-available/h6ai.conf && ! grep -q "server {" /etc/nginx/sites-available/h6ai.conf \
   && grep -q "^H6AI_NO_SITE=.1." /etc/h6ai/install.conf' || fail "the http-level file or the state"
x 'cat > /etc/nginx/sites-available/files <<"EOF"
server {
    listen 80;
    server_name files.example.com;
    root /srv/www;
    include h6ai/large-files.conf;
    include h6ai/server.conf;
}
EOF
. /etc/h6ai/install.conf
[ -S "$FPM_SOCK" ] || /etc/init.d/php8.2-fpm start
nginx -t && nginx -s reload
H6AI_WEBROOT=/srv/www H6AI_OUTSIDE=/srv/outside PHP_BIN=$PHP_BIN sh /opt/seed/seed.sh
cp /opt/options.local.json /srv/www/_h6ai/private/conf/options.local.json
chmod 0644 /srv/www/_h6ai/private/conf/options.local.json
rm -f /srv/www/_h6ai/private/cache/ratelimit-*' || fail "the server block with h6ai"
if docker run --rm --network "container:$c" -v "$PWD":/repo -w /repo -e H6AI_URL=http://127.0.0.1 node:22 \
    node --test --test-concurrency=1 test-integration/*.test.mjs > test-native/logs/own-site.suite.log 2>&1; then
    echo "[own-site] suite: $(grep -E '^# (pass|skipped)' test-native/logs/own-site.suite.log | tr '\n' ' ')"
else
    fail "suite: $(grep -E '^# (pass|fail)' test-native/logs/own-site.suite.log | tr '\n' ' ')"
    grep -E '^not ok' test-native/logs/own-site.suite.log | sed 's/^/[own-site]   /' || true
fi

echo "[own-site] 3. upgrade, uninstall"
out=$(q '/opt/h6ai-bundle/install.sh --yes --no-firewall; echo "exit=$?"')
echo "$out" >> "$log"
case $out in *"Upgrading h6ai"*"add the rest to your server block"*"exit=0") ok "the upgrade keeps --no-site" ;; *) fail "upgrade: $(echo "$out" | tail -n 3 | tr '\n' ' ')" ;; esac
x '! grep -q "server {" /etc/nginx/sites-available/h6ai.conf && nginx -t' || fail "upgrade wrote a server block"
[ "$(q 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1/')" = 200 ] || fail "index after the upgrade"
out=$(q '/opt/h6ai-bundle/install.sh --uninstall; echo "exit=$?"')
echo "$out" >> "$log"
case $out in *"remove the h6ai includes"*"/etc/nginx/sites-available/files"*"exit=0") ok "uninstall points at the server block that includes h6ai" ;; *) fail "uninstall: $out" ;; esac
x '! [ -e /etc/nginx/sites-available/h6ai.conf ] && ! [ -e /etc/nginx/h6ai/server.conf ]' || fail "uninstall left h6ai's nginx files"

[ "$status" = 0 ] && echo "[own-site] PASS" || echo "[own-site] see $log"
exit "$status"
