# =============================================================================
#  ANSNEW CLOUD — ALL-IN-ONE image: nginx + php-fpm + worker in ONE container.
# =============================================================================
#
#  This is the "one command" deployment: a single image that a fresh machine
#  can pull from a registry and run with no checkout, no build and no
#  docker-compose:
#
#      docker run -d --name ansnew -p 8080:8080 \
#          -v ansnew-data:/var/www/data \
#          -v ansnew-storage:/srv/storage \
#          <registry>/ansnew-cloud:latest
#
#  The classic split deployment (separate nginx + php + worker containers,
#  per-service resource limits and isolation) stays available via
#  docker-compose.yml — same source of truth for every config file. This
#  image is the accepted tradeoff: one container = one privilege domain, but
#  the whole container still runs as www-data (uid 82), never root.
#
#  What runs inside, under supervisord (docker/allinone/supervisord.conf):
#      php-fpm   — the REST API (built exactly like docker/php/Dockerfile)
#      nginx     — SPA + FastCGI + TLS + ACME challenge (docker/nginx/default.conf)
#      worker    — background job runner (bin/worker.php)
#
#  SQLite rides inside the data volume, which is why no database container —
#  and therefore no second image — is needed.
#
# =============================================================================

FROM php:8.2-fpm-alpine

# --- runtime packages --------------------------------------------------------
# Identical extension toolchain to docker/php/Dockerfile (keep them in sync),
# plus nginx + supervisor + openssl for the merged runtime. openssl is needed
# by 40-ansnew-tls.sh to mint the placeholder certificate; curl stays for the
# healthcheck.
RUN set -eux; \
    apk add --no-cache \
        libzip-dev zip oniguruma-dev libxml2-dev sqlite-dev \
        curl-dev ca-certificates tzdata \
        shadow; \
    docker-php-ext-install -j$(nproc) pdo pdo_sqlite zip mbstring pcntl posix opcache fileinfo curl; \
    apk del libzip-dev oniguruma-dev libxml2-dev sqlite-dev curl-dev; \
    apk add --no-cache libzip curl nginx supervisor openssl; \
    php -r 'foreach (["posix","zip","mbstring","pcntl","fileinfo","pdo_sqlite","curl","openssl","json","session","phar"] as $e) { if (!extension_loaded($e)) { fwrite(STDERR, "ansnew: missing PHP extension: $e\n"); exit(1); } } echo "ansnew: PHP extensions OK\n";'

# --- application source ------------------------------------------------------
# Same tree, same ownership as the php image: nginx serves /var/www/public
# and FastCGI executes /var/www/app/public/index.php (SCRIPT_FILENAME).
COPY --chown=www-data:www-data src /var/www/app/src
COPY --chown=www-data:www-data bin /var/www/app/bin
COPY --chown=www-data:www-data database /var/www/app/database
COPY --chown=www-data:www-data public /var/www/app/public

# Sanity-check the source tree is complete (class-level checks run in CI via
# tools/static-check.py; this is the image-build safety net).
RUN set -eux; \
    for f in \
        /var/www/app/public/index.php \
        /var/www/app/bin/console.php \
        /var/www/app/bin/worker.php \
        /var/www/app/database/schema.sqlite.sql \
        /var/www/app/src/App/Core/Kernel.php \
        /var/www/app/src/App/Jobs/Worker.php \
        /var/www/app/src/App/Storage/Encryption/FileCipher.php \
    ; do test -f "$f" || { echo "ansnew: missing $f" >&2; exit 1; }; done; \
    echo "ansnew: source tree OK"

# --- PHP runtime settings (identical to the php image) -----------------------
COPY docker/php/php.ini /usr/local/etc/php/conf.d/99-ansnew.ini
# Loaded last (zz-) so it overrides the image's www.conf defaults, notably
# pm.max_children = 5, which a few concurrent media downloads would exhaust.
COPY docker/php/fpm-pool.conf /usr/local/etc/php-fpm.d/zz-ansnew.conf
# Shared bootstrap (data dirs, APP_KEY, migrations, admin, mounts) — reused as
# the ENTRYPOINT so first-boot behaviour is byte-for-byte the split image's.
COPY docker/php/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /var/www/data /srv/storage/local \
    && chown -R www-data:www-data /var/www/data /srv/storage

# --- nginx -------------------------------------------------------------------
# Main config: pid + all temp paths under /tmp because nginx runs as www-data
# here (the compiled-in /var/lib/nginx paths are root-owned).
COPY docker/allinone/nginx.conf /etc/nginx/nginx.conf

# The SPA is served STATICALLY from /var/www/public — the same second copy the
# split deployment carries in its nginx image (the site config's
# `root /var/www/public` is kept unchanged). /var/www/app/public above is the
# FastCGI tree; only its index.php is ever executed.
COPY --chown=www-data:www-data public/ /var/www/public/

# The site config is baked ONCE, as the template at the canonical path
# 40-ansnew-tls.sh reads. It is the split deployment's docker/nginx/default.conf
# with ONE build-time difference: `fastcgi_pass php:9000` (compose service
# name) becomes `fastcgi_pass 127.0.0.1:9000` (php-fpm in this same container).
# Keeping docker/nginx/default.conf the single source of truth means routing,
# security headers and upload limits can never drift between the two modes.
COPY docker/nginx/default.conf /etc/nginx/ansnew/default.conf
# Alpine's nginx package ships its site configs in /etc/nginx/http.d/, but the
# TLS bootstrap (shared with the Debian-based split nginx image) writes its
# startup-rewritten site config to /etc/nginx/conf.d/ansnew.conf, and nginx.conf
# above includes conf.d/*.conf — so create that directory here.
RUN sed -e 's#fastcgi_pass php:9000;#fastcgi_pass 127.0.0.1:9000;#g' \
        /etc/nginx/ansnew/default.conf > /etc/nginx/ansnew/default.conf.new \
    && mv /etc/nginx/ansnew/default.conf.new /etc/nginx/ansnew/default.conf \
    && rm -f /etc/nginx/conf.d/default.conf \
    && mkdir -p /etc/nginx/conf.d /usr/share/nginx/html /var/www/acme /etc/nginx/certs-bootstrap /tmp/nginx \
    && cp /var/www/public/healthz /usr/share/nginx/html/healthz \
    && chown -R www-data:www-data /etc/nginx /usr/share/nginx/html /var/www/acme /tmp/nginx

# TLS bootstrap — the SAME script the nginx image runs from
# /docker-entrypoint.d/, relocated because there is no nginx entrypoint here.
COPY docker/nginx/40-ansnew-tls.sh /usr/local/bin/40-ansnew-tls.sh
RUN chmod +x /usr/local/bin/40-ansnew-tls.sh

# scripts/init-letsencrypt.sh deploys private keys as root:101 mode 0640
# (group 101 = the nginx group both images' tooling expects). Give the
# container's www-data supplementary membership in that group so a real key
# mounted read-only from the host is readable by nginx here too — without it,
# the TLS bootstrap would silently fall back to the self-signed placeholder.
RUN addgroup www-data nginx 2>/dev/null || true

# Cache busting: hash the frontend tree and stamp it into index.html as the
# ?v= query on asset links, so a redeployed image is never shadowed by a stale
# cached index.html (same mechanism as the nginx image build).
COPY docker/nginx/stamp-assets.sh /tmp/stamp-assets.sh
RUN chmod +x /tmp/stamp-assets.sh && /tmp/stamp-assets.sh && rm -f /tmp/stamp-assets.sh

# --- supervisor --------------------------------------------------------------
COPY docker/allinone/supervisord.conf /etc/supervisord.conf
COPY docker/allinone/start-supervisor.sh /usr/local/bin/ansnew-supervisord
RUN chmod +x /usr/local/bin/ansnew-supervisord

WORKDIR /var/www/app

# www-data end to end: supervisord, nginx, php-fpm and the worker. All three
# listeners are unprivileged ports (8080/8082/8443) — the host maps 80/443
# onto 8082/8443, exactly as the split deployment does.
USER www-data
EXPOSE 8080 8082 8443

HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=45s \
    CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

# ENTRYPOINT: shared php bootstrap (dirs, APP_KEY, migrations, admin, mounts).
# CMD: nginx TLS bootstrap, then supervisord as PID 1.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["/usr/local/bin/ansnew-supervisord"]

LABEL org.opencontainers.image.title="ANSNEW CLOUD" \
      org.opencontainers.image.description="Self-hosted encrypted file manager — all-in-one image (nginx + php-fpm + worker + SQLite)" \
      org.opencontainers.image.source="https://github.com/needyamin/ansnew-cloud"
