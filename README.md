# ANSNEW CLOUD

A lightweight, self-hosted, desktop-style online file manager with **encryption at rest**.
Local storage only, SQLite, three containers, zero PHP package dependencies.

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

```bash
cp .env.example .env      # adjust APP_URL / ports if you like
docker compose up -d --build
docker compose logs php | grep -i password   # first-boot admin password (random)
# open http://localhost:8080 — you will be asked to change the admin password
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
docker/          nginx + php images
tools/           static checks + API smoke tests
docs/            architecture + deployment
```

## Verifying a checkout

```bash
php -l <file>                       # or: docker run --rm -v "$PWD":/a -w /a php:8.2-cli php -l public/index.php
node tools/js-import-check.mjs public/assets/js
python3 tools/static-check.py
```
