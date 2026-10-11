#!/usr/bin/env bash
# Regression test: nginx must START with no TLS certificate mounted.
#
# This is the failure it guards against — a fresh install crashed with
#   nginx: [emerg] cannot load certificate "/etc/nginx/certs/tls.crt"
# because the config has a TLS listener and nginx treats a missing certificate as
# fatal. The whole stack was down, including the plain-HTTP listener that serves
# the ACME challenge, so a Let's Encrypt certificate could never be obtained.
#
# It runs throwaway containers on spare ports; it does not touch the running
# stack or your real certificate directory.
#
# Usage:  bash tools/nginx-tls-boot-test.sh
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
IMAGE="${IMAGE:-ansnew/nginx}"
CONF="$ROOT/docker/nginx/default.conf"
SCRATCH="$(pwd -W 2>/dev/null || pwd)/.scratch-tls-test"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); printf '  \033[32m\u2713\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m\u2717\033[0m %s  %s\n' "$1" "${2:-}"; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($3)"; else bad "$1" "expected $3, got $2"; fi; }

rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/empty-certs" "$SCRATCH/acme" "$SCRATCH/real-certs"
trap 'rm -rf "$SCRATCH"' EXIT

command -v openssl >/dev/null 2>&1 || { echo "openssl required on the host"; exit 2; }

# A "real" certificate, distinct from the generated placeholder.
openssl req -x509 -newkey rsa:2048 -nodes -days 30 \
  -keyout "$SCRATCH/real-certs/tls.key" -out "$SCRATCH/real-certs/tls.crt" \
  -subj "/CN=real.example.com" >/dev/null 2>&1

# `php` and `ws` must resolve at config load, so point them at loopback — this
# test is about nginx booting, not about the upstreams answering.
run_nginx() {  # run_nginx <name> <certs-dir> <http-port> <https-port>
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" \
    --add-host php:127.0.0.1 --add-host ws:127.0.0.1 \
    -v "$CONF:/etc/nginx/ansnew/default.conf:ro" \
    -v "$2:/etc/nginx/certs:ro" \
    -v "$SCRATCH/acme:/var/www/acme:ro" \
    -p "$3:8080" -p "$4:8443" \
    "$IMAGE" >/dev/null
  # Wait for nginx to answer, rather than probing a pid file (the unprivileged
  # image puts its pid at /tmp/nginx.pid, and the path is an implementation detail).
  for _ in $(seq 1 25); do
    sleep 1
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$3/healthz" 2>/dev/null || echo 000)
    [ "$code" = "200" ] && return 0
  done
  return 1
}

logs() { docker logs "$1" 2>&1 | tail -20; }

# Common Name of the certificate the TLS listener is actually serving. Read via
# openssl rather than parsing `curl -v`, whose output format is not stable.
cert_cn() {  # cert_cn <host:port>
  echo | openssl s_client -connect "$1" 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | sed -n 's/.*CN *= *\([^,]*\).*/\1/p' | tr -d ' '
}

echo "nginx TLS bootstrap — image: $IMAGE"

# ---------------------------------------------------------------- no certificate
echo
echo "1. No certificate mounted (the failure case)"
if run_nginx ansnew-tlstest-empty "$SCRATCH/empty-certs" 18080 18443; then
  ok "container started"
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:18080/healthz 2>/dev/null || echo 000)
  check "plain HTTP listener answers /healthz" "$code" "200"
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 https://127.0.0.1:18443/healthz 2>/dev/null || echo 000)
  check "TLS listener answers /healthz" "$code" "200"
  subj=$(cert_cn 127.0.0.1:18443)
  if [ "$subj" = "ansnew-cloud" ]; then ok "serving the generated placeholder (CN=$subj)"; else bad "serving the generated placeholder" "got CN='$subj'"; fi
  if docker logs ansnew-tlstest-empty 2>&1 | grep -q "WARNING: no TLS certificate"; then
    ok "warned loudly about the missing certificate"
  else
    bad "warned loudly about the missing certificate" "no warning in the logs"
  fi
  if docker logs ansnew-tlstest-empty 2>&1 | grep -q "cannot load certificate"; then
    bad "no 'cannot load certificate' error" "the original failure is back"
  else
    ok "no 'cannot load certificate' error"
  fi
else
  bad "container started" "did not come up — $(logs ansnew-tlstest-empty | tail -3)"
fi
docker rm -f ansnew-tlstest-empty >/dev/null 2>&1 || true

# ---------------------------------------------------------------- with a real cert
echo
echo "2. A real certificate mounted"
if run_nginx ansnew-tlstest-real "$SCRATCH/real-certs" 18081 18444; then
  ok "container started"
  subj=$(cert_cn 127.0.0.1:18444)
  if [ "$subj" = "real.example.com" ]; then ok "serving the mounted certificate (CN=$subj)"; else bad "serving the mounted certificate" "got CN='$subj'"; fi
  if docker logs ansnew-tlstest-real 2>&1 | grep -q "WARNING: no TLS certificate"; then
    bad "no placeholder warning when a certificate exists" "it warned anyway"
  else
    ok "no placeholder warning when a certificate exists"
  fi
else
  bad "container started" "did not come up — $(logs ansnew-tlstest-real | tail -3)"
fi
docker rm -f ansnew-tlstest-real >/dev/null 2>&1 || true

echo
if [ "$FAIL" -eq 0 ]; then echo "PASS — $PASS passed, 0 failed"; else echo "FAIL — $PASS passed, $FAIL failed"; fi
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
