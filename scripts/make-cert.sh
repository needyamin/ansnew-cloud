#!/usr/bin/env bash
# Generate the self-signed TLS certificate used by the nginx HTTPS listener.
#
# Writes into CERTS_HOST_PATH (see .env), which is bind-mounted into nginx and
# deliberately kept OUTSIDE the project — and outside OneDrive — so the private
# key is never cloud-synced.
#
#   ./scripts/make-cert.sh && docker compose up -d nginx
#
# Filenames are fixed (tls.crt / tls.key) because nginx reads exactly those.
# For a trusted padlock on a real domain use ./scripts/init-letsencrypt.sh
# instead — it writes the same two files from the Let's Encrypt certificate.
set -euo pipefail

DIR="${CERTS_HOST_PATH:-/etc/ansnew/tls}"
mkdir -p "$DIR"

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$DIR/tls.key" \
  -out "$DIR/tls.crt" \
  -subj "/CN=${CERT_CN:-ansnew-cloud}" \
  -addext "subjectAltName=DNS:localhost,DNS:ansnew-cloud,IP:127.0.0.1"

chmod 600 "$DIR/tls.key" 2>/dev/null || true
echo "wrote $DIR/tls.crt and $DIR/tls.key"
echo "now run: docker compose up -d nginx"
