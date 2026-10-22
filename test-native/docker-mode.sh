#!/bin/sh
# install.sh --docker from the release bundle, inside Docker-in-Docker (so this host's Docker
# setup is not touched): first install with a generated admin password, h6ai-user through the
# container, an upgrade, an uninstall that keeps the data, a re-install and a purge.
#
#   test-native/docker-mode.sh            log: test-native/logs/docker-mode.log
# shellcheck disable=SC2016 # single-quoted commands are expanded inside the container
set -eu
cd "$(dirname "$0")/.."

PORT=18891
c=h6ai-native-dind
log=test-native/logs/docker-mode.log
mkdir -p test-native/logs
: > "$log"
status=0
fail() { status=1; echo "[docker-mode] FAIL $1" | tee -a "$log"; }
x() { docker exec "$c" sh -c "$1" >> "$log" 2>&1; }

VERSION=$(node -p 'require("./package.json").version')
[ "${SKIP_BUILD:-0}" = 1 ] && [ -f "build/h6ai-$VERSION.tar.gz" ] || npm run -s release >/dev/null
trap '[ "${KEEP:-0}" = 1 ] || docker rm -f -v "$c" >/dev/null 2>&1 || true' EXIT

docker rm -f -v "$c" >/dev/null 2>&1 || true
docker run -d --name "$c" --privileged -p "127.0.0.1:$PORT:80" docker:27-dind >/dev/null
docker exec -i "$c" sh -c 'mkdir -p /opt/bundle && tar -xzf - -C /opt/bundle' < "build/h6ai-$VERSION.tar.gz"
for _ in $(seq 60); do docker exec "$c" docker info >/dev/null 2>&1 && break; sleep 1; done

echo "[docker-mode] install.sh --docker (builds the image inside DinD)"
x "/opt/bundle/h6ai-$VERSION/install.sh --docker --yes --root /srv/files" || fail "install.sh --docker"
grep -q "container healthy" "$log" || fail "container not healthy"
password=$(sed -n 's/^  Login: *admin \/ \(.*\)$/\1/p' "$log")
[ -n "$password" ] || fail "no generated admin password in the summary"

login() {
    H6AI_URL="http://127.0.0.1:$PORT" node -e '
        import("./test-integration/lib.mjs").then(async ({login}) => {
            const {json} = await login("admin", process.argv[1]);
            process.exit(json && json.asAdmin === true ? 0 : 1);
        });' "$1"
}
code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
[ "$code" = 200 ] || fail "index: $code"
login "$password" || fail "login with the generated password"
x 'echo "bob-secret-1" | h6ai-user add bob --password-stdin && h6ai-user list | grep -q "^bob "' || fail "h6ai-user through the container"
x '[ -d /srv/files/_h6ai/public ]' || fail "_h6ai not installed into the shared folder"

echo "[docker-mode] upgrade"
x "out=\$(/opt/bundle/h6ai-$VERSION/install.sh --yes) && echo \"\$out\" && echo \"\$out\" | grep -q 'Upgrading h6ai' && ! echo \"\$out\" | grep -q 'Login:'" \
    || fail "re-run is not an upgrade"
x 'h6ai-user list | grep -q "^bob "' || fail "upgrade lost users"

echo "[docker-mode] uninstall, re-install, purge"
x "/opt/bundle/h6ai-$VERSION/install.sh --uninstall" || fail "uninstall"
x '[ -z "$(docker ps -q)" ] && docker volume ls -q | grep -q "^h6ai_h6ai-data$"' || fail "uninstall: container left or volume gone"
x "/opt/bundle/h6ai-$VERSION/install.sh --docker --yes --root /srv/files" || fail "re-install"
x 'h6ai-user list | grep -q "^bob "' || fail "re-install lost users"
x "/opt/bundle/h6ai-$VERSION/install.sh --uninstall --purge" || fail "purge"
x '! docker volume ls -q | grep -q h6ai && ! [ -e /opt/h6ai ] && ! [ -e /srv/files/_h6ai ]' || fail "purge left data behind"

[ "$status" = 0 ] && echo "[docker-mode] PASS" || echo "[docker-mode] see $log"
exit "$status"
