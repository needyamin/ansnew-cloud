#!/usr/bin/env bash
# Generate the self-signed TLS certificate used by the nginx HTTPS listener.
#
# Writes into CERTS_HOST_PATH — taken from the environment, or read from .env if
# unset, which is the value docker-compose will actually mount. Kept OUTSIDE the
# project on purpose so the private key is never committed or cloud-synced.
#
#   ./scripts/make-cert.sh && docker compose restart nginx
#
# Filenames are fixed (tls.crt / tls.key) because nginx reads exactly those.
# For a trusted padlock on a real domain use ./scripts/init-letsencrypt.sh
# instead — it writes the same two files from the Let's Encrypt certificate.
#
# nginx no longer *requires* a certificate to start: it generates a placeholder
# if none is mounted (docker/nginx/40-ansnew-tls.sh). This script is how you
# replace that placeholder with a stable, long-lived one.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# Fall back to .env, so `sudo ./scripts/make-cert.sh` does the right thing
# without exporting anything first.
if [ -z "${CERTS_HOST_PATH:-}" ] && [ -f "$ROOT/.env" ]; then
    CERTS_HOST_PATH="$(sed -n 's/^CERTS_HOST_PATH=//p' "$ROOT/.env" | tail -1 | tr -d '"' | tr -d "'" | tr -d '\r')"
fi
DIR="${CERTS_HOST_PATH:-/etc/ansnew/tls}"

# Never silently overwrite a certificate that is already there: on a production
# box that would replace a working Let's Encrypt certificate with a self-signed
# one and break every browser.
if [ "$FORCE" -eq 0 ] && [ -s "$DIR/tls.crt" ] && [ -s "$DIR/tls.key" ]; then
    echo "A certificate already exists in $DIR — leaving it alone."
    openssl x509 -in "$DIR/tls.crt" -noout -subject -enddate 2>/dev/null | sed 's/^/  /' || true
    echo "Re-run with --force to replace it with a self-signed one."
    exit 0
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required but not installed." >&2
    exit 1
fi

mkdir -p "$DIR"

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$DIR/tls.key" \
  -out "$DIR/tls.crt" \
  -subj "/CN=${CERT_CN:-ansnew-cloud}" \
  -addext "subjectAltName=DNS:localhost,DNS:ansnew-cloud,IP:127.0.0.1"

chmod 600 "$DIR/tls.key" 2>/dev/null || true
chmod 644 "$DIR/tls.crt" 2>/dev/null || true
echo "wrote $DIR/tls.crt and $DIR/tls.key"
echo "now run: docker compose restart nginx"
