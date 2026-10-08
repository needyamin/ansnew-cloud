#!/usr/bin/env bash
# =============================================================================
#  ANSNEW CLOUD — one-shot installer for a fresh Ubuntu / Debian server
# =============================================================================
#
#  Fresh server, one command:
#
#    curl -fsSL https://raw.githubusercontent.com/needyamin/ansnew-cloud/main/install.sh | sudo bash
#
#  Or from an existing checkout:
#
#    sudo ./install.sh
#
#  What it does:
#    1. installs Docker Engine + the Compose v2 plugin (if missing)
#    2. gets the source (this checkout, or clones into --dir)
#    3. writes a production-safe .env from .env.example (random admin password,
#       real APP_URL, PASSWORD_MIN_LENGTH raised from the example's throwaway 5)
#    4. builds the images and starts the stack
#    5. waits for every service to be healthy, then smoke-tests HTTP
#    6. prints the URL and the admin credentials
#
#  Re-running it is safe: an existing .env is kept unless --force-env is given.
#
#  Options:
#    --port 8081              host HTTP port (default 8080, auto-bumped if busy)
#    --dir /opt/ansnew-cloud  install directory (default: this checkout)
#    --storage /srv/ansnew    host dir for the default local mount
#    --admin-user admin       bootstrap admin username   (default: admin)
#    --admin-password 'x'     bootstrap admin password   (default: prompted,
#                             or random when non-interactive)
#    --app-url http://a.b.c:8080   canonical URL (default: http://<host-ip>:<port>)
#    --nas                    also enable the optional SMB / NAS profile (445)
#    --mysql                  use MariaDB instead of the default SQLite
#    --cn                     prefer Chinese mirrors for apt / Docker
#    --force-env              rewrite an existing .env
#    --no-start               install deps + write .env only, do not build/start
#    -h, --help
#
# =============================================================================

set -Eeuo pipefail

REPO_URL="https://github.com/needyamin/ansnew-cloud.git"
BRANCH="${BRANCH:-main}"
DEFAULT_DIR="/opt/ansnew-cloud"

# --- options -----------------------------------------------------------------
HTTP_PORT=""; APP_DIR=""; STORAGE_DIR=""
ADMIN_USER="admin"; ADMIN_PASSWORD=""; APP_URL=""; ADMIN_EMAIL="admin@example.com"
ENABLE_NAS=0; USE_MYSQL=0; CN=0; NO_START=0; FORCE_ENV=0
DOMAIN=""; USE_TLS=0; HTTPS_PORT=""

# --- output helpers ----------------------------------------------------------
if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'
else
    C_RESET=""; C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""
fi
log()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
ok()   { printf '  %s+%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '\n%sERROR:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
    cat <<'USAGE'
ANSNEW CLOUD — one-shot installer for a fresh Ubuntu / Debian server

  curl -fsSL https://raw.githubusercontent.com/needyamin/ansnew-cloud/main/install.sh | sudo bash
  sudo ./install.sh                 # from an existing checkout

Options
  --domain cloud.example.com  PUBLIC deployment: sets APP_URL=https://<domain>,
                          ports 80/443, SESSION_SECURE_COOKIE=true, TRUST_PROXY=true
                          and opens 80/443 in ufw. See docs/DEPLOY.md
  --tls                   after installing, also obtain a Let's Encrypt cert
                          (scripts/init-letsencrypt.sh); implies --domain
  --port 8081              host HTTP port (default 8080, auto-bumped if busy;
                          forced to 80 when --domain is used)
  --dir /opt/ansnew-cloud  install directory (default: this checkout)
  --storage /srv/ansnew    host dir for the default local mount
  --admin-user admin       bootstrap admin username
  --admin-password 'x'     bootstrap admin password (prompted, or random if non-interactive)
  --admin-email a@b.c      bootstrap admin email
  --app-url http://a.b:8080  canonical URL (default: http://<host-ip>:<port>)
  --nas                    also enable the optional SMB / NAS profile (TCP 445).
                          Do NOT use on a public host.
  --mysql                  use MariaDB instead of the default SQLite
  --cn                     prefer Chinese mirrors for apt / Docker
  --force-env              rewrite an existing .env (old one is backed up)
  --no-start               install deps + write .env only, do not build/start
  -h, --help

Re-running is safe: an existing .env is kept unless --force-env is given.

Going on the public internet? Read docs/DEPLOY.md first — it covers DNS,
firewall, real TLS + renewal, backups and the upgrade runbook.
USAGE
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)           HTTP_PORT="${2:?--port needs a value}"; shift 2 ;;
        --dir)            APP_DIR="${2:?--dir needs a value}"; shift 2 ;;
        --storage)        STORAGE_DIR="${2:?--storage needs a value}"; shift 2 ;;
        --admin-user)     ADMIN_USER="${2:?--admin-user needs a value}"; shift 2 ;;
        --admin-password) ADMIN_PASSWORD="${2:?--admin-password needs a value}"; shift 2 ;;
        --admin-email)    ADMIN_EMAIL="${2:?--admin-email needs a value}"; shift 2 ;;
        --app-url)        APP_URL="${2:?--app-url needs a value}"; shift 2 ;;
        --domain)         DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
        --tls)            USE_TLS=1; shift ;;
        --nas)            ENABLE_NAS=1; shift ;;
        --mysql)          USE_MYSQL=1; shift ;;
        --cn)             CN=1; shift ;;
        --force-env)      FORCE_ENV=1; shift ;;
        --no-start)       NO_START=1; shift ;;
        -h|--help)        usage ;;
        *)                die "unknown option: $1 (try --help)" ;;
    esac
done

[[ $USE_TLS -eq 1 && -z $DOMAIN ]] && die "--tls requires --domain <your.domain>"

# --- root --------------------------------------------------------------------
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    if [[ -f ${BASH_SOURCE[0]:-} ]] && command -v sudo >/dev/null 2>&1; then
        exec sudo -E bash "${BASH_SOURCE[0]}" "$@"
    fi
    die "must run as root: sudo bash install.sh"
fi

# --- misc helpers ------------------------------------------------------------
# NOTE: deliberately not `tr -dc ... | head -c 20` — head exits early, tr then
# dies of SIGPIPE and, under `set -o pipefail`, the whole script aborts with 141.
gen_pass() {
    local p="" raw i
    for i in 1 2 3 4 5; do
        raw="$(openssl rand -base64 32 2>/dev/null || true)"
        [[ -z $raw ]] && raw="$(head -c 32 /dev/urandom 2>/dev/null | base64 2>/dev/null || true)"
        p="${raw//[^A-Za-z0-9]/}"
        if (( ${#p} >= 20 )); then printf '%s' "${p:0:20}"; return 0; fi
    done
    while [[ ${#p} -lt 20 ]]; do p+="${RANDOM}${RANDOM}"; done
    printf '%s' "${p:0:20}"
}

port_in_use() {
    local p="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$" && return 0
    fi
    (exec 3<>/dev/tcp/127.0.0.1/"$p") >/dev/null 2>&1 && return 0
    return 1
}

detect_ip() {
    local ip=""
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null \
        | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')"
    [[ -z $ip ]] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    [[ -z $ip ]] && ip="127.0.0.1"
    printf '%s' "$ip"
}

# Write KEY=VALUE into an env file, replacing any existing assignment.
set_env() {
    local key="$1" val="$2" file="$3" esc
    esc="$(printf '%s' "$val" | sed 's/[&|\\]/\\&/g')"
    if grep -qE "^[[:space:]]*${key}=" "$file"; then
        sed -i "s|^[[:space:]]*${key}=.*|${key}=${esc}|" "$file"
    else
        printf '\n%s=%s\n' "$key" "$val" >> "$file"
    fi
}

# --- OS ----------------------------------------------------------------------
# shellcheck disable=SC1091
[[ -r /etc/os-release ]] || die "cannot read /etc/os-release (Ubuntu/Debian only)"
. /etc/os-release
OS_ID="${ID:-ubuntu}"
CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
[[ $OS_ID == ubuntu || $OS_ID == debian || $OS_ID == linuxmint || $OS_ID == raspbian ]] \
    || die "unsupported OS '$OS_ID'; this installer targets Ubuntu/Debian"
[[ -n $CODENAME ]] || CODENAME="stable"
ARCH="$(dpkg --print-architecture 2>/dev/null || echo amd64)"

log "${C_BOLD}ANSNEW CLOUD installer${C_RESET} — ${PRETTY_NAME:-$OS_ID} ($ARCH)"

# --- apt ---------------------------------------------------------------------
export DEBIAN_FRONTEND=noninteractive

switch_apt_mirror() {
    local mirror="$1" f changed=0
    for f in /etc/apt/sources.list \
             /etc/apt/sources.list.d/ubuntu.sources \
             /etc/apt/sources.list.d/debian.sources; do
        [[ -f $f ]] || continue
        cp -n "$f" "$f.ansnew-bak" 2>/dev/null || true
        sed -i -e "s|https\?://[a-z0-9.-]*archive\.ubuntu\.com|https://${mirror}|g" \
               -e "s|https\?://security\.ubuntu\.com|https://${mirror}|g" \
               -e "s|https\?://deb\.debian\.org|https://${mirror}|g" "$f"
        changed=1
    done
    (( changed ))
}

apt_update() {
    local m
    if apt-get update -qq >/dev/null 2>&1; then return 0; fi
    for m in mirrors.tencent.com mirrors.aliyun.com; do
        warn "apt-get update failed; retrying through $m"
        switch_apt_mirror "$m" && apt-get update -qq >/dev/null 2>&1 && return 0
    done
    die "apt-get update failed — check DNS/network, then re-run (CN servers: sudo bash install.sh --cn)"
}

apt_install() {
    apt-get install -y -qq --no-install-recommends "$@" >/dev/null 2>&1 \
        || apt-get install -y --no-install-recommends "$@"
}

# --- Docker ------------------------------------------------------------------
have_docker()  { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
have_compose() { docker compose version >/dev/null 2>&1; }

install_docker() {
    if have_docker && have_compose; then
        ok "Docker already installed: $(docker --version | awk '{print $3}' | tr -d ',')"
        return 0
    fi
    step "Installing Docker Engine + Compose plugin"
    apt_update
    apt_install ca-certificates curl gnupg git openssl iproute2

    local mirrors=("https://download.docker.com/linux/${OS_ID}")
    (( CN )) && mirrors=("https://mirrors.aliyun.com/docker-ce/linux/${OS_ID}"
                         "https://mirrors.tencent.com/docker-ce/linux/${OS_ID}"
                         "${mirrors[0]}")

    local mirror="" m
    for m in "${mirrors[@]}"; do
        if curl -fsSL --max-time 25 "$m/gpg" -o /tmp/ansnew-docker.gpg 2>/dev/null; then
            mirror="$m"; break
        fi
    done
    [[ -n $mirror ]] || die "cannot reach any Docker apt repository (try: --cn)"

    install -m 0755 -d /etc/apt/keyrings
    gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg /tmp/ansnew-docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] %s %s stable\n' \
        "$ARCH" "$mirror" "$CODENAME" > /etc/apt/sources.list.d/docker.list
    ok "apt repository: $mirror $CODENAME"

    apt_update
    if ! apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
        warn "official packages unavailable; falling back to distro docker.io"
        apt_install docker.io docker-compose-v2 \
            || die "Docker installation failed"
    fi

    if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd || -d /lib/systemd ]]; then
        systemctl enable --now docker >/dev/null 2>&1 || true
        ok "docker service enabled at boot"
    fi
    ok "Docker installed"

    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
        have_docker && break
        sleep 3
    done
    have_docker || die "Docker daemon did not start (see: journalctl -u docker)"
}

# --- source ------------------------------------------------------------------
resolve_app_dir() {
    local here
    here="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd)" || here=""
    if [[ -n $here && -f "$here/docker-compose.yml" && -d "$here/src" ]]; then
        APP_DIR="$here"
        ok "using this checkout: $APP_DIR"
        return
    fi
    APP_DIR="${APP_DIR:-$DEFAULT_DIR}"
    if [[ -d "$APP_DIR/.git" ]]; then
        step "Updating $APP_DIR"
        git -C "$APP_DIR" pull --ff-only >/dev/null 2>&1 \
            || warn "git pull failed (local changes?) — using files as they are"
    else
        step "Cloning ANSNEW CLOUD into $APP_DIR"
        git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$APP_DIR" \
            || die "git clone failed — check network, or copy the project to $APP_DIR and re-run"
    fi
    ok "source ready: $APP_DIR"
}

# --- .env --------------------------------------------------------------------
setup_env() {
    local envf="$APP_DIR/.env" fresh=1

    if [[ -f $envf ]]; then
        fresh=0
        if (( FORCE_ENV )); then
            cp "$envf" "$envf.bak.$(date +%s)"
            cp "$APP_DIR/.env.example" "$envf"
            fresh=1
            warn "existing .env backed up and regenerated"
        else
            ok "keeping existing .env (use --force-env to regenerate)"
        fi
    else
        [[ -f "$APP_DIR/.env.example" ]] || die ".env.example not found in $APP_DIR"
        cp "$APP_DIR/.env.example" "$envf"
    fi

    # --- ports ----------------------------------------------------------------
    # HTTP_PORT is the APP listener (kept private in production). The public
    # ports are PUBLIC_HTTP_PORT (ACME + redirect to HTTPS) and HTTPS_PORT.
    HTTP_PORT="${HTTP_PORT:-$(grep -sE '^HTTP_PORT=' "$envf" | cut -d= -f2-)}"
    HTTP_PORT="${HTTP_PORT:-8080}"
    local tries=0
    while port_in_use "$HTTP_PORT"; do
        warn "port $HTTP_PORT is already in use"
        HTTP_PORT=$((HTTP_PORT + 1)); tries=$((tries + 1))
        (( tries > 20 )) && die "no free port found near the requested one"
    done

    if [[ -n $DOMAIN ]]; then
        # A public domain needs 80/443 specifically (ACME + redirect), so those
        # are never auto-bumped.
        PUBLIC_HTTP_PORT="${PUBLIC_HTTP_PORT:-80}"
        HTTPS_PORT="${HTTPS_PORT:-443}"
        port_in_use "$PUBLIC_HTTP_PORT" && warn "port ${PUBLIC_HTTP_PORT} is busy — stop the other web server before issuing the certificate"
    else
        # LAN install: the redirect listener is unused, so keep it out of the way.
        PUBLIC_HTTP_PORT="${PUBLIC_HTTP_PORT:-9080}"
        HTTPS_PORT="${HTTPS_PORT:-9443}"
    fi

    # --- URL / admin ----------------------------------------------------------
    if [[ -n $DOMAIN ]]; then
        # Accept "example.com", "https://example.com/" — store the bare host.
        DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%/}"
        [[ -z $APP_URL ]] && APP_URL="https://${DOMAIN}"
    fi
    if [[ -z $APP_URL ]]; then
        APP_URL="http://$(detect_ip):${HTTP_PORT}"
    fi
    APP_URL="${APP_URL%/}"

    if [[ -z $ADMIN_PASSWORD ]]; then
        if [[ -t 0 ]]; then
            local pw1 pw2
            while true; do
                read -rsp "Admin password (min 10 chars, blank = generate): " pw1; printf '\n'
                if [[ -z $pw1 ]]; then ADMIN_PASSWORD="$(gen_pass)"; break; fi
                if (( ${#pw1} < 10 )); then warn "too short"; continue; fi
                read -rsp "Repeat password: " pw2; printf '\n'
                [[ $pw1 == "$pw2" ]] || { warn "mismatch"; continue; }
                ADMIN_PASSWORD="$pw1"; break
            done
        else
            ADMIN_PASSWORD="$(gen_pass)"
        fi
    fi

    # The shipped example allows 5-char passwords so a throwaway local
    # "admin/admin" works. On a real server that is not acceptable.
    local min_len=10
    (( ${#ADMIN_PASSWORD} < min_len )) && { min_len=${#ADMIN_PASSWORD}; warn "password is shorter than 10 characters"; }

    set_env HTTP_PORT            "$HTTP_PORT"            "$envf"
    set_env PUBLIC_HTTP_PORT     "$PUBLIC_HTTP_PORT"     "$envf"
    set_env HTTPS_PORT           "$HTTPS_PORT"           "$envf"
    set_env APP_URL              "$APP_URL"              "$envf"
    set_env ADMIN_USER           "$ADMIN_USER"           "$envf"
    set_env ADMIN_EMAIL          "$ADMIN_EMAIL"          "$envf"
    set_env ADMIN_PASSWORD       "\"${ADMIN_PASSWORD}\"" "$envf"
    set_env PASSWORD_MIN_LENGTH  "$min_len"              "$envf"
    # Over HTTPS the session cookie must be Secure — and PHP may trust the
    # proxy's X-Forwarded-For for the real client IP. Over plain HTTP neither
    # applies (a Secure cookie would simply never be sent).
    if [[ -n $DOMAIN || $APP_URL == https://* ]]; then
        set_env SESSION_SECURE_COOKIE true "$envf"
        set_env TRUST_PROXY true "$envf"
    fi

    # --- storage --------------------------------------------------------------
    STORAGE_DIR="${STORAGE_DIR:-$APP_DIR/storage-root}"
    set_env STORAGE_HOST_PATH "$STORAGE_DIR" "$envf"

    # --- optional profiles ----------------------------------------------------
    local profiles=""
    if (( ENABLE_NAS )); then
        local nasp; nasp="$(gen_pass)"
        set_env NAS_PASS "\"${nasp}\"" "$envf"
        set_env NAS_USER "ansnew" "$envf"
        profiles="nas"
        port_in_use 445 && warn "port 445 is busy on this host — the SMB share may not bind"
    fi
    if (( USE_MYSQL )); then
        local dbpw; dbpw="$(gen_pass)"
        set_env DB_DRIVER   "mysql"       "$envf"
        set_env DB_PASSWORD "\"${dbpw}\"" "$envf"
        profiles="${profiles:+$profiles,}mysql"
    fi
    [[ -n $profiles ]] && set_env COMPOSE_PROFILES "$profiles" "$envf"

    chmod 600 "$envf"
    ok ".env written (mode 600)$( (( fresh )) && printf ' · admin credentials set' )"

    # --- host storage dir must be writable by the container's www-data (uid 82)
    mkdir -p "$STORAGE_DIR"
    chown -R 82:82 "$STORAGE_DIR" 2>/dev/null \
        || { chmod -R 0777 "$STORAGE_DIR"; warn "could not chown $STORAGE_DIR to uid 82 — fell back to 0777"; }
    ok "storage root: $STORAGE_DIR"

    # Defensive: a fresh clone has no files under ws-server/lib, but the ws
    # image COPYs that directory, so make sure it exists before building.
    mkdir -p "$APP_DIR/ws-server/lib"
    chmod +x "$APP_DIR/ansnew" 2>/dev/null || true
}

# --- compose -----------------------------------------------------------------
COMPOSE_ARGS=()
compose() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }

wait_healthy() {
    local deadline=$((SECONDS + 300)) out svc st need s ok_all
    while (( SECONDS < deadline )); do
        out="$(compose ps --format '{{.Service}}|{{.Status}}' 2>/dev/null || true)"
        while IFS='|' read -r svc st; do
            [[ -z $svc ]] && continue
            if [[ $st == *unhealthy* || $st == *Exit* || $st == *exited* ]]; then
                warn "$svc: $st"
                return 1
            fi
        done <<< "$out"
        ok_all=1
        for need in nginx php ws; do
            grep -qE "^${need}\|.*(healthy|Up)" <<< "$out" || ok_all=0
        done
        (( ok_all )) && return 0
        sleep 5
    done
    return 1
}

# Create a stable self-signed certificate before the first boot.
#
# nginx will happily start without one (it mints a throwaway placeholder —
# docker/nginx/40-ansnew-tls.sh), but that placeholder lives inside the container
# and is regenerated on every recreate, so the browser warning would come back
# each time. A file on the host is stable, and is what init-letsencrypt.sh
# replaces later.
ensure_cert() {
    local dir
    dir="$(sed -n 's/^CERTS_HOST_PATH=//p' "$APP_DIR/.env" | tail -1 | tr -d '"' | tr -d "'" | tr -d '\r')"
    dir="${dir:-/etc/ansnew/tls}"

    if [[ -s "$dir/tls.crt" && -s "$dir/tls.key" ]]; then
        ok "certificate already present in $dir"
        return 0
    fi
    if [[ ! -x "$APP_DIR/scripts/make-cert.sh" ]]; then
        warn "scripts/make-cert.sh not found — nginx will use a generated placeholder"
        return 0
    fi
    # Pass the path explicitly so it cannot disagree with what .env mounts.
    if CERTS_HOST_PATH="$dir" "$APP_DIR/scripts/make-cert.sh" >/dev/null 2>&1; then
        ok "self-signed certificate created in $dir"
        warn "browsers will warn until you install a real certificate (see docs/DEPLOY.md)"
    else
        warn "could not create a certificate — nginx will use a generated placeholder"
    fi
}

start_stack() {
    cd "$APP_DIR"
    (( ENABLE_NAS )) && COMPOSE_ARGS+=(--profile nas)
    (( USE_MYSQL ))  && COMPOSE_ARGS+=(--profile mysql)

    step "Validating compose configuration"
    compose config >/dev/null || die "docker compose config failed — check $APP_DIR/.env"

    step "Building images (first build compiles PHP extensions — a few minutes)"
    compose build --pull || die "image build failed (see output above)"
    ok "images built"

    step "Ensuring a TLS certificate exists"
    ensure_cert

    step "Starting the stack"
    compose up -d || die "docker compose up failed"
    ok "containers started"

    step "Waiting for nginx / php / ws to report healthy"
    if wait_healthy; then
        ok "all services healthy"
    else
        warn "not healthy yet — showing recent logs"
        compose ps
        compose logs --tail=40 || true
        die "stack did not become healthy; inspect with: cd $APP_DIR && docker compose logs -f"
    fi

    step "Smoke-testing HTTP on 127.0.0.1:${HTTP_PORT}"
    local hz
    hz="$(curl -fsS --max-time 10 "http://127.0.0.1:${HTTP_PORT}/healthz" 2>/dev/null || echo '')"
    [[ -n $hz ]] || die "/healthz did not respond (curl http://127.0.0.1:${HTTP_PORT}/healthz)"
    ok "/healthz → ${hz}"
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$APP_URL/" || echo 000)"
    ok "GET $APP_URL/ → HTTP ${code}"
    [[ $code == 200 ]] || warn "expected 200; the UI may still be warming up"
}

finish() {
    # convenience CLI + firewall + saved credentials
    if [[ -x "$APP_DIR/ansnew" && -d /usr/local/bin ]]; then
        if ln -sf "$APP_DIR/ansnew" /usr/local/bin/ansnew 2>/dev/null; then
            ok "CLI: ansnew (wrapper for $APP_DIR/ansnew)"
        fi
    fi
    if command -v ufw >/dev/null 2>&1; then
        local fwstate; fwstate="$(ufw status 2>/dev/null || true)"
        if [[ $fwstate == *"Status: active"* ]]; then
            if [[ -n $DOMAIN ]]; then
                # Public deployment: open ONLY the public ports. The app listener
                # (HTTP_PORT) stays closed to the outside world.
                ufw allow "${PUBLIC_HTTP_PORT}/tcp" >/dev/null 2>&1 && ok "ufw: allowed ${PUBLIC_HTTP_PORT}/tcp"
                ufw allow "${HTTPS_PORT}/tcp" >/dev/null 2>&1 && ok "ufw: allowed ${HTTPS_PORT}/tcp"
            else
                ufw allow "${HTTP_PORT}/tcp" >/dev/null 2>&1 && ok "ufw: allowed ${HTTP_PORT}/tcp"
            fi
        fi
    fi
    local cred="/root/ANSNEW-CREDENTIALS.txt"
    {
        printf 'ANSNEW CLOUD\n'
        printf '  URL      : %s\n' "$APP_URL"
        printf '  username : %s\n' "$ADMIN_USER"
        printf '  password : %s\n' "$ADMIN_PASSWORD"
        printf '  app dir  : %s\n' "$APP_DIR"
        printf '  storage  : %s\n' "$STORAGE_DIR"
    } > "$cred"
    chmod 600 "$cred"

    # --- TLS (opt-in) ---------------------------------------------------------
    if [[ $USE_TLS -eq 1 && -n $DOMAIN ]]; then
        step "Obtaining a Let's Encrypt certificate for ${DOMAIN}"
        if "$APP_DIR/scripts/init-letsencrypt.sh" "$DOMAIN" "$ADMIN_EMAIL"; then
            ok "TLS certificate installed"
        else
            warn "certificate step failed — run it manually once DNS/ports are ready:"
            warn "  $APP_DIR/scripts/init-letsencrypt.sh $DOMAIN $ADMIN_EMAIL"
        fi
    elif [[ -n $DOMAIN ]]; then
        warn "self-signed certificate in use — run this once DNS points here:"
        warn "  $APP_DIR/scripts/init-letsencrypt.sh $DOMAIN $ADMIN_EMAIL"
    fi
    ok "credentials also saved to $cred (mode 600)"
}

summary() {
    cat <<EOF

${C_BOLD}${C_GREEN}ANSNEW CLOUD is up${C_RESET}

  URL       ${C_BOLD}${APP_URL}${C_RESET}
  username  ${ADMIN_USER}
  password  ${ADMIN_PASSWORD}
  app dir   ${APP_DIR}
  storage   ${STORAGE_DIR}

  ${C_YELLOW}Save the password now — it is not recoverable later.${C_RESET}

  Handy commands
    cd ${APP_DIR} && docker compose logs -f      # follow logs
    cd ${APP_DIR} && docker compose ps           # service status
    ansnew                                       # CLI helper (crypto-status, reset-password, ...)
    cd ${APP_DIR} && docker compose stop         # stop everything

  ${C_YELLOW}Back up ${APP_DIR}/storage-root and the encryption key — losing
  data/keys/file.key makes every encrypted file unreadable:${C_RESET}
    cd ${APP_DIR} && docker compose exec php cat /var/www/data/keys/file.key > ./ansnew-file.key.bak

  To remove the stack: cd ${APP_DIR} && docker compose down -v
EOF
}

# --- main --------------------------------------------------------------------
# `trap - ERR` first: without it a failing command inside the handler re-enters
# the handler and the message prints several times.
trap 'rc=$?; trap - ERR
if (( rc != 0 )); then
    printf "\n%sFAILED%s (exit %s)%s\n" "$C_RED" "$C_RESET" "$rc" \
        "${APP_DIR:+ — see: cd $APP_DIR && docker compose logs --tail=80}" >&2
fi
exit "$rc"' ERR

step "Checking system"
install_docker
resolve_app_dir
setup_env
if (( NO_START )); then
    finish
    printf '\n%s--no-start:%s nothing was built or started.\n' "$C_YELLOW" "$C_RESET"
    log "  next   : cd $APP_DIR && docker compose up -d --build"
    log "  login  : ${ADMIN_USER} / ${ADMIN_PASSWORD}"
    log "  url    : ${APP_URL}"
    exit 0
fi
start_stack
finish
summary
