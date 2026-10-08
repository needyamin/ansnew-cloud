#!/bin/sh
#
# Runs from /docker-entrypoint.d/ before nginx starts (the official nginx image
# executes these in filename order; this one runs last).
#
# WHY THIS EXISTS
# ---------------
# The config has three listeners, one of which terminates TLS and therefore
# requires a certificate. nginx treats a missing ssl_certificate as fatal, so
# with no certificate in the mounted directory it refused to start AT ALL — the
# container crash-looped and even the plain-HTTP listener (and the ACME
# challenge it serves) was unreachable. That made the documented first boot
# impossible: you cannot obtain a Let's Encrypt certificate until nginx is up to
# answer the challenge.
#
# So: if a real certificate is present, use it. If not, mint a self-signed one
# into a writable path and point the TLS listener at that, loudly. nginx always
# starts, and dropping real files into /etc/nginx/certs/ takes over on the next
# restart.
#
# The certs directory stays mounted READ-ONLY on purpose: the container must not
# be able to rewrite the private key on the host. That is why the fallback is
# written elsewhere and substituted into a copy of the config instead.
set -eu

# The mounted config (read-only) is the source of truth. The baked copy is the
# fallback for running the image without the bind mount.
TEMPLATE=/etc/nginx/ansnew/default.conf
TARGET=/etc/nginx/conf.d/ansnew.conf
CERTS=/etc/nginx/certs
BOOTSTRAP=/etc/nginx/certs-bootstrap

SRC="$TEMPLATE"
[ -f "$SRC" ] || SRC=/etc/nginx/conf.d/default.conf

# nginx includes every *.conf in conf.d/, so the stock default.conf has to go —
# two configs would both try to bind 8080/8082/8443. The directory is writable by
# uid 101, but the file itself is root-owned and NOT writable, so it is unlinked
# and replaced by ansnew.conf rather than edited in place. (Replacing also keeps
# the base image's 10-listen-on-ipv6-by-default.sh away from our listeners.)
rm -f /etc/nginx/conf.d/default.conf

# A real certificate wins, unchanged.
if [ -s "$CERTS/tls.crt" ] && [ -s "$CERTS/tls.key" ]; then
    cp "$SRC" "$TARGET"
    echo "[ansnew] TLS: using $CERTS/tls.crt"
    exit 0
fi

# No certificate — generate a placeholder so nginx can bind the TLS port.
mkdir -p "$BOOTSTRAP"
if [ ! -s "$BOOTSTRAP/tls.crt" ] || [ ! -s "$BOOTSTRAP/tls.key" ]; then
    if ! command -v openssl >/dev/null 2>&1; then
        echo "[ansnew] ERROR: no certificate in $CERTS and openssl is missing." >&2
        exit 1
    fi
    openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
        -keyout "$BOOTSTRAP/tls.key" \
        -out "$BOOTSTRAP/tls.crt" \
        -subj "/CN=ansnew-cloud" \
        -addext "subjectAltName=DNS:localhost,DNS:ansnew-cloud,IP:127.0.0.1" \
        >/dev/null 2>&1
fi

# Point only the TLS listener at the placeholder.
sed -e "s#/etc/nginx/certs/tls\.crt#$BOOTSTRAP/tls.crt#g" \
    -e "s#/etc/nginx/certs/tls\.key#$BOOTSTRAP/tls.key#g" \
    "$SRC" > "$TARGET"

cat >&2 <<'EOF'

  ============================================================================
  [ansnew] WARNING: no TLS certificate found in /etc/nginx/certs/

  A temporary SELF-SIGNED certificate was generated so nginx can start. Browsers
  will show a security warning until you replace it.

  Install a real one, then restart nginx:

    ./scripts/make-cert.sh                              # self-signed, 10 years
    ./scripts/init-letsencrypt.sh <domain> <email>      # trusted, Let's Encrypt

    docker compose restart nginx

  (CERTS_HOST_PATH in .env decides which host directory is mounted.)
  ============================================================================

EOF
