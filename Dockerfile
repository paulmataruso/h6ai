# syntax=docker/dockerfile:1
#
# h6ai: nginx + php-fpm in one image.
#
#   docker build -t h6ai .            # final stage "runtime"
#   docker compose up --build -d      # see compose.yaml / docker/README.md
#
# Stages: build (Node, compiles the frontend) -> base (nginx, php-fpm, tools) -> runtime (+ app).
# A release bundle already contains the built app: H6AI_SOURCE=prebuilt takes its _h6ai folder
# instead of compiling (install.sh --docker does that, no Node needed).

# PHP is pinned to a release with the fix for CVE-2026-109618 (RCE via OOM corruption, fixed in
# 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12). The base stage refuses to build an affected version.
ARG PHP_VERSION=8.3.36
ARG NODE_VERSION=22
ARG H6AI_SOURCE=build

# ---------------------------------------------------------------------------------------------
# build: compile the frontend and assemble build/_h6ai
# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && test -f build/_h6ai/public/index.php

# prebuilt: the _h6ai folder of a release bundle (only built when H6AI_SOURCE=prebuilt)
FROM scratch AS prebuilt
COPY _h6ai /app/build/_h6ai

FROM ${H6AI_SOURCE} AS app

# ---------------------------------------------------------------------------------------------
# base: php-fpm (alpine) + nginx + thumbnail/archive tools, no application yet
# ---------------------------------------------------------------------------------------------
FROM php:${PHP_VERSION}-fpm-alpine AS base

# fail the build on PHP versions affected by CVE-2026-109618
RUN php -r '$fixed = ["8.2" => "8.2.35", "8.3" => "8.3.36", "8.4" => "8.4.27", "8.5" => "8.5.12"]; \
    $branch = PHP_MAJOR_VERSION . "." . PHP_MINOR_VERSION; \
    $min = $fixed[$branch] ?? (version_compare($branch, "8.2", "<") ? null : $branch . ".0"); \
    if ($min === null || version_compare(PHP_VERSION, $min, "<")) { \
        fwrite(STDERR, "PHP " . PHP_VERSION . " is affected by CVE-2026-109618, need >= " . ($min ?? "8.2.35") . PHP_EOL); exit(1); } \
    echo "PHP ", PHP_VERSION, ": CVE-2026-109618 fixed", PHP_EOL;'

RUN set -eux; \
    apk add --no-cache \
        nginx curl coreutils tar zip unzip \
        ffmpeg ghostscript \
        imagemagick imagemagick-jpeg imagemagick-webp imagemagick-pdf imagemagick-heic \
        libjpeg-turbo libpng libwebp libavif freetype; \
    apk add --no-cache --virtual .build-deps $PHPIZE_DEPS \
        libjpeg-turbo-dev libpng-dev libwebp-dev libavif-dev freetype-dev; \
    docker-php-ext-configure gd --with-jpeg --with-webp --with-avif --with-freetype; \
    docker-php-ext-install -j"$(nproc)" gd exif; \
    docker-php-ext-enable opcache; \
    apk del --no-network .build-deps; \
    php -r 'exit(gd_info()["JPEG Support"] && gd_info()["WebP Support"] && gd_info()["AVIF Support"] ? 0 : 1);'; \
    rm -f /etc/nginx/http.d/default.conf; \
    mkdir -p /var/lib/php/sessions /etc/h6ai

# deploy/ is shared with the native installer (install.sh); docker/ holds the container parts
COPY deploy/imagemagick-policy.xml /tmp/policy.xml
RUN for d in /etc/ImageMagick-*; do cp /tmp/policy.xml "$d/policy.xml"; done; rm /tmp/policy.xml
COPY deploy/php/h6ai.ini /usr/local/etc/php/conf.d/zz-h6ai.ini
COPY docker/php/fpm-pool.conf /usr/local/etc/php-fpm.d/zz-h6ai.conf
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY deploy/nginx/http.conf deploy/nginx/server.conf deploy/nginx/large-files.conf deploy/nginx/trusted-html.map /etc/nginx/h6ai/
COPY docker/nginx/site.conf /etc/nginx/http.d/h6ai.conf

# compose.yaml sets PHP_OPCACHE_VALIDATE_TIMESTAMPS=0 (code is replaced only on container start)
ENV PHP_OPCACHE_VALIDATE_TIMESTAMPS=1 \
    PHP_OPCACHE_REVALIDATE_FREQ=2 \
    PHP_MEMORY_LIMIT=256M

# ---------------------------------------------------------------------------------------------
# runtime: base + h6ai
# ---------------------------------------------------------------------------------------------
FROM base AS runtime
# The app lives in /opt/h6ai and is (re)installed into the web root on every start, so the web
# root itself can be a host directory (compose: ./webroot) - see docker/init.sh.
COPY --from=app /app/build/_h6ai /opt/h6ai/_h6ai
COPY deploy/install-app.sh docker/init.sh docker/seed.sh docker/seed-media.php docker/bigfile.sh /usr/local/share/h6ai/
COPY deploy/h6ai-user /usr/local/bin/h6ai-user
COPY docker/entrypoint.sh /usr/local/bin/h6ai-entrypoint
RUN mkdir -p /srv/www/_h6ai/private/data; \
    php -r 'foreach (["file_uploads" => "", "max_multipart_body_parts" => "1", "post_max_size" => "1M"] as $k => $v) { \
        if ((string) ini_get($k) !== $v) { fwrite(STDERR, "ini $k=" . var_export(ini_get($k), true) . PHP_EOL); exit(1); } }'
WORKDIR /srv/www
EXPOSE 80
VOLUME ["/srv/www/_h6ai/private/data"]
# nginx (internal loopback server) -> php-fpm ping: checks both processes
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8081/fpm-ping | grep -q pong || exit 1
ENTRYPOINT ["/usr/local/bin/h6ai-entrypoint"]
CMD []
