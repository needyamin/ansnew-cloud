#!/usr/bin/env bash
# Renew the Let's Encrypt certificate and activate it in nginx.
#
# Install as a cron entry or systemd timer, e.g.:
#   0 3 * * *  /srv/ansnew-cloud/scripts/renew-cert.sh >> /var/log/ansnew-cert.log 2>&1
#
# `certbot renew` is a no-op until the certificate is within 30 days of expiry,
# so running it daily is cheap and safe.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
if [ -f .env ]; then set -a; . ./.env; set +a; fi

CERTS="${CERTS_HOST_PATH:-/etc/ansnew/tls}"
PROJECT_DIR="$(pwd)"

# --deploy-hook runs only when a certificate was actually renewed, so nginx is
# touched at most once every couple of months.
#
# It RESTARTS rather than reloads. nginx cannot change ssl_certificate at
# runtime, so a container whose config points at the generated placeholder
# (docker/nginx/40-ansnew-tls.sh) would keep serving that placeholder after a
# reload — a silent failure. Restarting re-runs the startup script, which picks
# the correct certificate either way. ~1 second, once every ~60 days.
certbot renew --quiet --deploy-hook "
  install -m 0644 \"\$RENEWED_LINEAGE/fullchain.pem\" '${CERTS}/tls.crt' &&
  install -m 0600 \"\$RENEWED_LINEAGE/privkey.pem\"   '${CERTS}/tls.key' &&
  docker compose -f '${PROJECT_DIR}/docker-compose.yml' restart nginx
"

echo "[ansnew] certificate renewal check complete"
