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

# The deploy hook must restart whichever stack is running: both compose files
# share the project name, so `docker compose ps` lists the split deployment's
# nginx service or the all-in-one stack's single ansnew service. Resolved at
# script-run time and baked into the hook string (which certbot evaluates later,
# only when a certificate was actually renewed).
COMPOSE_FILE="docker-compose.yml"; SERVICE="nginx"
if docker compose ps --format '{{.Service}}' 2>/dev/null | grep -qx ansnew; then
  COMPOSE_FILE="docker-compose.allinone.yml"; SERVICE="ansnew"
fi

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
  install -o root -g 101 -m 0640 \"\$RENEWED_LINEAGE/privkey.pem\"   '${CERTS}/tls.key' &&
  docker compose -f '${PROJECT_DIR}/${COMPOSE_FILE}' restart ${SERVICE}
"

echo "[ansnew] certificate renewal check complete"
