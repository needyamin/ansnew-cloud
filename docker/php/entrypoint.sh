#!/bin/sh
# ANSNEW CLOUD php container entrypoint.
# The image runs as www-data (non-root); php-fpm's pool already operates as
# www-data, so no privilege dropping is needed here. Root-only bootstrap
# tasks (keys, migrations) are performed by writing to the writable data
# volume directly.

set -e

DATA_DIR=/var/www/data

mkdir -p "$DATA_DIR" "$DATA_DIR/sessions" "$DATA_DIR/tmp" "$DATA_DIR/trash" \
         "$DATA_DIR/logs" "$DATA_DIR/keys" "$DATA_DIR/db" /srv/storage/local 2>/dev/null || true

# First boot: generate app key if not provided by env.
if [ ! -f "$DATA_DIR/keys/app.key" ]; then
    if [ -n "$APP_KEY" ]; then
        printf '%s' "$APP_KEY" > "$DATA_DIR/keys/app.key"
    else
        php -r 'echo bin2hex(random_bytes(32));' > "$DATA_DIR/keys/app.key"
        echo "[ansnew] generated new APP_KEY at $DATA_DIR/keys/app.key"
    fi
fi

# Migrations + admin bootstrap + default mount seeding (all idempotent).
php /var/www/app/bin/console.php ansnew:migrate || echo "[ansnew] migration deferred"
php /var/www/app/bin/console.php ansnew:bootstrap-admin || echo "[ansnew] admin bootstrap deferred"
php /var/www/app/bin/console.php ansnew:seed-mounts || echo "[ansnew] mount seeding deferred"

# Exec the main process as-is (already www-data).
exec "$@"
