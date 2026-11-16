<p align="center">
  <img src="https://raw.githubusercontent.com/needyamin/ansnew-cloud/main/assets/ansnew_cloud.jpg" alt="ANSNEW CLOUD logo" width="160">
</p>

# ANSNEW CLOUD

A lightweight, self-hosted, desktop-style online file manager with **encryption at rest**.
Local storage only, SQLite, zero PHP package dependencies. Published on Docker Hub as
**one image** — nginx + php-fpm + job worker + SQLite in a single container — with the
classic **three-container** Compose stack available from a checkout when you want
per-container isolation. Same code, same config files in both modes.

Browser (light-theme SPA) → nginx → php-fpm (REST API) + worker (background jobs) → SQLite + encrypted storage

## What it is

- **Desktop-style file manager**: dual panes, tabs, grid/list/details views, drag & drop, keyboard
  shortcuts, rubber-band selection, favorites, recents, search, trash, right-click menus.
- **Uploads**: drag & drop, whole-folder upload (structure preserved), resumable 8 MiB chunked
  uploads with SHA-256 verification, filename + content-sniffing hardening.
- **Downloads**: direct streaming with HTTP Range support, and server-side ZIP packing of any
  selection (background job, resumable).
- **Encryption at rest**: every file is stored as a streaming AES-256-GCM container
  (`ANSNEWC1`), with a per-file data key wrapped by a master key, authenticated associated data
  binding chunk order, and atomic publish. Protection holds even if the whole disk is stolen.
- **Share links**: optional password + expiry, revocable and rotatable, tokens stored hashed,
  public pages served with no session. Passwords are submitted by POST and remembered as an
  HttpOnly grant cookie — never in URLs, logs or history.
- **Remote drives (S3-compatible)**: admins can save an S3 connection (AWS S3, Cloudflare R2,
  MinIO, Wasabi, B2, …) with endpoint, bucket, region and credentials (encrypted at rest), test
  it, and mount it like any drive. Credentials never leave the server.
- **Built-in code editor**: text/code files open in a full-screen editor with a line-number
  gutter, Ctrl+S save, CRLF/BOM preservation, and a sha256 guard that refuses to clobber a file
  changed elsewhere (409 instead of silent overwrite).
- **Security**: bcrypt (cost 12) passwords, hardened sessions (HttpOnly/SameSite=Strict, rotation,
  idle + absolute timeouts, UA binding), CSRF + same-origin checks on every mutation, brute-force
  lockout (per username+IP *and* per account), rate limiting, security headers, strict path
  handling (traversal, symlink escape and reserved names rejected), read-only grants, quotas,
  trash with retention.
- **Background jobs**: archive (zip/tar.gz), extract, copy, move, delete, disk usage — crash-safe
  queue with lease-based recovery, retry with backoff, progress polling and cancel.

Not included (deliberately removed for a lean core): WebSocket push, NAS inbox, MySQL, other
remote protocols (FTP/SFTP/SMB/WebDAV), 2FA, audit log, undo/redo, backup subsystem,
thumbnails, duplicates finder.

## Quick start (Docker)

### One command — a single image

Everything (nginx + php-fpm + job worker + SQLite) runs in one container, so a
machine with Docker needs exactly one command — no checkout, no build, no
Compose:

```bash
docker run -d --name ansnew -p 8080:8080 \
  -v ansnew-data:/var/www/data \
  -v ansnew-storage:/srv/storage \
  needyamin/ansnew-cloud:latest
```

Open http://localhost:8080 and sign in as `admin` / `admin` — a password change
is forced at first sign-in. (Ship a preset credential with
`-e ADMIN_PASSWORD=...` instead.)

To serve the public HTTP/HTTPS listeners too (ACME challenge + redirect on 80,
TLS on 443 — both terminate inside the same container):

```bash
docker run -d --name ansnew -p 8080:8080 -p 80:8082 -p 443:8443 \
  -v ansnew-data:/var/www/data -v ansnew-storage:/srv/storage \
  -v ansnew-certs:/etc/nginx/certs -v ansnew-acme:/var/www/acme \
  needyamin/ansnew-cloud:latest
```

Or with Compose (still pull-only, nothing to build) — put
`ANSNEW_IMAGE=needyamin/ansnew-cloud:latest` in `.env`, then:

```bash
curl -o docker-compose.allinone.yml https://raw.githubusercontent.com/needyamin/ansnew-cloud/main/docker-compose.allinone.yml
docker compose -f docker-compose.allinone.yml up -d
```

Notes:

- **On Docker Hub**: `needyamin/ansnew-cloud` carries this one image only, as
  `latest` (moving), `allinone` (alias) and `allinone-1.0.0` (pinned). The
  three-container mode's component images are not published — build them
  locally (see below).
- **Persistence**: `-v ansnew-data:/var/www/data` holds the SQLite database,
  sessions and `data/keys/` (the master keys — back them up, keep them
  off-box). Recreating the container keeps data as long as the volume stays.
- **Upgrade**: pull the new tag, then `docker stop ansnew && docker rm ansnew`
  and re-run the same `docker run` line — the volumes carry everything over.
- **Console**: `./ansnew` (from a checkout) works against the container, or
  directly: `docker exec ansnew php bin/console.php ansnew:crypto-status`.
- A TLS certificate is not required to boot: without one, a self-signed
  placeholder is minted at startup so the container always comes up. Real
  certificates (Let's Encrypt) follow the same flow as the split deployment —
  see docs/DEPLOY.md.
- The classic split deployment (below) gives per-container isolation and
  resource caps; both modes share the same config files and, when run through
  Compose, the same volume names, so data carries over when you switch.

### Fresh Ubuntu/Debian server — one-line installer

Installs Docker, gets the source, writes a production `.env`, builds and starts
the stack, waits for health and prints the admin credentials:

```bash
curl -fsSL https://raw.githubusercontent.com/needyamin/ansnew-cloud/main/install.sh | sudo bash
# public domain + real TLS:  sudo ./install.sh --domain cloud.example.com --tls
```

### Split deployment (three containers, built locally)

```bash
cp .env.example .env      # adjust APP_URL / ports if you like
docker compose up -d --build   # builds ansnew/nginx + ansnew/php locally
# open http://localhost:8080 — sign in as admin/admin, change the password
```

Useful commands:

```bash
./ansnew                              # list console commands
./ansnew crypto-status --scan         # encryption state (key fingerprint, plaintext files)
./ansnew bootstrap-admin --force      # recreate the admin despite the password policy
./ansnew reset-password --user=admin  # random new password, printed once
./ansnew migrate                      # apply schema migrations
./ansnew db-check                     # SQLite integrity check
```

Full deployment walkthrough (VPS, real TLS, firewall): [docs/DEPLOY.md](docs/DEPLOY.md).
Architecture notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security notes for operators

- `data/keys/` holds the master keys — **back it up, keep it off-box**. Losing `file.key` makes
  every encrypted file permanently unreadable; losing `app.key` breaks stored secrets.
- `data/tmp/` briefly holds plaintext upload chunks and prepared download archives; the worker
  sweeps both hourly.
- Keep `SESSION_SECURE_COOKIE=true` and a real `APP_URL` whenever the app is served over HTTPS.
- Share passwords are minimum 6 characters; share links are read-only by design.
- Files are only ever reachable through authenticated API endpoints — the storage directory is
  never served by the web server.

## Repository layout

```
public/          SPA (vanilla ES modules, no build step) + the single PHP front controller
src/App/         Api (controllers, routes), Auth, Core, Storage (local + encryption), Services, Jobs, Support
bin/             console.php (CLI) + worker.php (job runner)
database/        schema.sqlite.sql (the only schema)
docker/          allinone/ (single-image stack) + nginx/ + php/ (split images)
tools/           static checks + API smoke tests
docs/            architecture + deployment
```

## Verifying a checkout

```bash
php -l <file>                       # or: docker run --rm -v "$PWD":/a -w /a php:8.2-cli php -l public/index.php
node tools/js-import-check.mjs public/assets/js
python3 tools/static-check.py
```
