# ---------- stage 1: composer dependencies ----------
FROM composer:2 AS vendor
WORKDIR /app
# No composer.lock is committed, so copy composer.json alone. (A `composer.lock*`
# glob would make the build fail on a fresh clone, where no lock file exists.)
COPY composer.json ./
# Install runtime deps only; phpseclib is required for the SFTP/SSH adapters.
# The optimised autoloader is deliberately NOT generated here: this stage has
# no application sources, so the classmap would be built empty.  It is
# generated in the runtime stage once src/ has been copied in.
RUN composer install --no-dev --no-interaction --no-progress --no-scripts --no-autoloader

# ---------- stage 2: runtime ----------
FROM php:8.2-fpm-alpine AS runtime

# Runtime extensions needed by ANSNEW CLOUD.
#   * openssl-dev is required so ext-ftp can be compiled *with* TLS support.
#   * ext/ftp's config.m4 only defines HAVE_FTP_SSL (i.e. ftp_ssl_connect) when
#     it is configured with an explicit --with-openssl-dir, so ftp is
#     configured on its own before the bulk install.  A plain
#     `docker-php-ext-install ftp` silently produces an FTPS-less build.
#   * gd (with jpeg/webp) backs the server-side thumbnail endpoint.
RUN set -eux; \
    apk add --no-cache \
        libzip-dev zip unzip icu-dev oniguruma-dev libxml2-dev sqlite-dev \
        openssl-dev \
        libjpeg-turbo-dev libpng-dev libwebp-dev freetype-dev \
        openssh-client samba-client curl ca-certificates tzdata \
        shadow; \
    docker-php-ext-configure ftp --with-openssl-dir=/usr; \
    docker-php-ext-configure gd --with-freetype --with-jpeg --with-webp; \
    docker-php-ext-install -j$(nproc) pdo pdo_sqlite pdo_mysql zip intl mbstring bcmath pcntl posix opcache fileinfo ftp gd; \
    apk del libzip-dev icu-dev oniguruma-dev libxml2-dev sqlite-dev openssl-dev \
        libjpeg-turbo-dev libpng-dev libwebp-dev freetype-dev; \
    apk add --no-cache libzip libjpeg-turbo libpng libwebp freetype; \
    php -r 'foreach (["ftp","posix","zip","intl","mbstring","bcmath","pcntl","fileinfo","pdo_sqlite","pdo_mysql","openssl","json","session","phar","gd"] as $e) { if (!extension_loaded($e)) { fwrite(STDERR, "ansnew: missing PHP extension: $e\n"); exit(1); } } if (!function_exists("ftp_ssl_connect")) { fwrite(STDERR, "ansnew: ext-ftp built without TLS (ftp_ssl_connect missing)\n"); exit(1); } if (!function_exists("imagecreatetruecolor") || !function_exists("imagewebp")) { fwrite(STDERR, "ansnew: gd missing jpeg/webp support\n"); exit(1); } echo "ansnew: PHP extensions OK\n";'

# Copy application source into the image at the canonical path used by
# nginx (SCRIPT_FILENAME) and the entrypoint.
COPY --chown=www-data:www-data src /var/www/app/src
COPY --chown=www-data:www-data bin /var/www/app/bin
COPY --chown=www-data:www-data database /var/www/app/database
COPY --chown=www-data:www-data public /var/www/app/public
COPY --from=vendor --chown=www-data:www-data /app/vendor /var/www/app/vendor
COPY --from=vendor --chown=www-data:www-data /app/composer.json /var/www/app/composer.json
COPY --from=vendor /usr/bin/composer /usr/local/bin/composer

# Regenerate the optimised autoloader now that src/ is present so the classmap
# covers every declared class.  Then assert the classes the API and the worker
# rely on actually resolve — this catches namespace/PSR-4 regressions at build
# time instead of as a 500 at runtime.
RUN set -eux; \
    COMPOSER_ALLOW_SUPERUSER=1 COMPOSER_HOME=/tmp/composer \
        composer dump-autoload --optimize --no-dev --no-interaction --no-scripts \
            --working-dir=/var/www/app; \
    chown -R www-data:www-data /var/www/app/vendor; \
    rm -rf /tmp/composer; \
    php -r 'require "/var/www/app/vendor/autoload.php"; foreach (["App\\Storage\\ConnectionConfig","App\\Storage\\ConnectionService","App\\Storage\\Mount","App\\Services\\JobService","App\\Jobs\\Worker","App\\Jobs\\JobHandler","App\\Jobs\\Handlers\\ArchiveHandler","App\\Support\\Crypto"] as $c) { if (!class_exists($c)) { fwrite(STDERR, "ansnew: autoload failed for $c\n"); exit(1); } } echo "ansnew: autoload OK\n";'

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
