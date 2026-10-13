# ---------- runtime ----------
FROM php:8.2-fpm-alpine AS runtime

# Runtime extensions needed by ANSNEW CLOUD. Zero composer dependencies: the
# app ships its own PSR-4 autoloader (public/index.php, bin/*.php), so there
# is no vendor stage at all.
RUN set -eux; \
    apk add --no-cache \
        libzip-dev zip oniguruma-dev libxml2-dev sqlite-dev \
        curl-dev ca-certificates tzdata \
        shadow; \
    docker-php-ext-install -j$(nproc) pdo pdo_sqlite zip mbstring pcntl posix opcache fileinfo curl; \
    apk del libzip-dev oniguruma-dev libxml2-dev sqlite-dev curl-dev; \
    apk add --no-cache libzip curl; \
    php -r 'foreach (["posix","zip","mbstring","pcntl","fileinfo","pdo_sqlite","curl","openssl","json","session","phar"] as $e) { if (!extension_loaded($e)) { fwrite(STDERR, "ansnew: missing PHP extension: $e\n"); exit(1); } } echo "ansnew: PHP extensions OK\n";'

# Copy application source into the image at the canonical path used by
# nginx (SCRIPT_FILENAME) and the entrypoint.
COPY --chown=www-data:www-data src /var/www/app/src
COPY --chown=www-data:www-data bin /var/www/app/bin
COPY --chown=www-data:www-data database /var/www/app/database
COPY --chown=www-data:www-data public /var/www/app/public

# Sanity-check the source tree is complete in the image (class-level checks run
# in CI via tools/static-check.py, which validates every App\ reference).
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

# Hardened PHP settings
COPY docker/php/php.ini /usr/local/etc/php/conf.d/99-ansnew.ini
# Loaded last (zz-) so it overrides the image's www.conf defaults, notably
# pm.max_children = 5, which a few concurrent media downloads would exhaust.
COPY docker/php/fpm-pool.conf /usr/local/etc/php-fpm.d/zz-ansnew.conf
COPY docker/php/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /var/www/data /srv/storage/local \
    && chown -R www-data:www-data /var/www/data /srv/storage

# Run from the application root. This matters beyond tidiness: `docker compose
# exec php php bin/console.php ...` then works with a RELATIVE path, which Git
# Bash on Windows does not rewrite. An absolute /var/www/app/... argument gets
# mangled into C:/Program Files/Git/var/www/app/... before Docker sees it.
WORKDIR /var/www/app

# PHP-FPM (unprivileged: www-data) listens on 9000
USER www-data
EXPOSE 9000

HEALTHCHECK --interval=15s --timeout=5s --retries=10 --start-period=40s \
    CMD php -r 'exit(file_exists("/var/www/data") ? 0 : 1);'

ENTRYPOINT ["/entrypoint.sh"]
CMD ["php-fpm"]
