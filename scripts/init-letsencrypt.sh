#!/usr/bin/env bash
# Issue a real Let's Encrypt certificate for the domain and install it for the
# bundled nginx TLS listener.
#
#   ./scripts/init-letsencrypt.sh cloud.example.com admin@example.com
#
# Zero-downtime: the HTTP-01 challenge is answered by the already-running nginx
# from ACME_WEBROOT_HOST_PATH, so nothing is stopped — nginx is only reloaded.
#
# Prerequisites:
#   - the domain's A/AAAA record already points at this host
#   - ports 80 and 443 are open (see docs/DEPLOY.md)
#   - the stack is up: docker compose up -d
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
if [ -z "$DOMAIN" ]; then
  echo "Usage: $0 <domain> [email]" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
if [ -f .env ]; then set -a; . ./.env; set +a; fi

WEBROOT="${ACME_WEBROOT_HOST_PATH:-./acme-webroot}"
CERTS="${CERTS_HOST_PATH:-/etc/ansnew/tls}"
mkdir -p "$WEBROOT" "$CERTS"

if ! command -v certbot >/dev/null 2>&1; then
  echo "[ansnew] installing certbot..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq certbot
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y -q certbot
  else
    echo "[ansnew] install certbot manually, then re-run this script" >&2
    exit 1
  fi
fi

ARGS=(--webroot -w "$WEBROOT" -d "$DOMAIN" --non-interactive --agree-tos)
if [ -n "$EMAIL" ]; then
  ARGS+=(--email "$EMAIL" --no-eff-email)
else
  ARGS+=(--register-unsafely-without-email)
fi

certbot certonly "${ARGS[@]}"

# Deploy into the exact filenames the nginx config reads.
LIVE="/etc/letsencrypt/live/${DOMAIN}"
install -m 0644 "$LIVE/fullchain.pem" "$CERTS/tls.crt"
install -m 0600 "$LIVE/privkey.pem"   "$CERTS/tls.key"

# RESTART, not reload. nginx cannot change ssl_certificate at runtime, and a
# container that booted without a certificate has a config pointing at the
# generated placeholder (docker/nginx/40-ansnew-tls.sh) — reloading would keep
# serving that placeholder forever. Restarting re-runs the startup script, which
# now finds the real certificate and switches to it. Costs about a second, once.
docker compose restart nginx

echo "[ansnew] certificate installed for ${DOMAIN} and nginx restarted"
echo "[ansnew] add the nightly renewal job (cron or systemd timer):"
echo "          0 3 * * *  $(pwd)/scripts/renew-cert.sh >> /var/log/ansnew-cert.log 2>&1"
