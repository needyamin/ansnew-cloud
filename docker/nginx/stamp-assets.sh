#!/bin/sh
# Rewrite the asset URLs in index.html to carry a content-hash version:
#   /assets/css/app.css  ->  /assets/css/app.css?v=<hash>
# Runs in the nginx image build (docker/nginx/Dockerfile). The hash covers the
# whole public/ tree, so ANY frontend change produces new URLs and browsers
# can never serve a stale bundle after a redeploy.
set -eu
cd /var/www/public
HASH="$(find . -type f | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -c1-12)"
sed -i "s#/assets/css/app.css#/assets/css/app.css?v=${HASH}#; s#/assets/js/main.js#/assets/js/main.js?v=${HASH}#" index.html
echo "[stamp] asset version: ${HASH}"
