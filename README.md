# ANSNEW CLOUD

A self-hosted, desktop-style file manager. Browse, upload, preview, edit, archive and
share files across local and remote storage from one web UI, with optional encryption at
rest.

**Stack:** PHP 8.2-FPM · nginx · Node WebSocket service · PHP background worker ·
SQLite (default) or MariaDB. Everything runs in Docker Compose.

---

## Features

**Files** — windowed listing (thousands of entries with a bounded DOM), Details / List /
Large-icons views, sort, type filters, search, type-ahead, full keyboard navigation,
rename, bulk rename, copy / cut / paste, drag-and-drop between panes *and* between drives,
rubber-band drag-to-select, duplicate finder, favourites and recents.

**Reading and editing** — images, video and audio (custom player with Range seeking), PDF,
and a **built-in code editor** for any text file (see
[Built-in code editor](#built-in-code-editor)). Anything genuinely binary falls back to a
hex view.

**Storage** — local (encrypted at rest) plus S3/R2, FTP/FTPS, SFTP, SMB and WebDAV. Mounts
are per-user with read/write grants and quotas. Optional SMB share so a LAN can treat it as
a NAS.

**Operations** — background jobs with progress over WebSocket and crash recovery, streaming
ZIP downloads for a whole selection, full-drive backup with pause/resume/verify, undo/redo
history, audit log, share links, TOTP two-factor, and per-drive health/capacity reporting.

---

## Quick start

```bash
cp .env.example .env          # then edit it (see Configuration below)
docker compose up -d --build
docker compose ps             # wait for all services to report "healthy"
```

Open the URL from `APP_URL` / `HTTP_PORT` (default <http://localhost:8080>).

---

## One-line install (fresh Ubuntu / Debian server)

`install.sh` turns a bare server into a running stack: it installs Docker Engine
and the Compose plugin, fetches the source, writes a production-safe `.env`
(random admin password, real `APP_URL`, `PASSWORD_MIN_LENGTH` raised from the
example's throwaway `5`), builds the images, waits for every service to go
healthy and prints the URL and credentials.

```bash
curl -fsSL https://raw.githubusercontent.com/needyamin/ansnew-cloud/main/install.sh | sudo bash
```

Already have the files on the server? `sudo ./install.sh` uses that checkout.

Useful flags (see `./install.sh --help` for all of them):

```bash
sudo ./install.sh --port 8081                 # host port (auto-bumped if busy)
sudo ./install.sh --dir /opt/ansnew-cloud     # clone target when run standalone
sudo ./install.sh --storage /srv/ansnew       # host dir for the `local` mount
sudo ./install.sh --admin-password 's3cret!'  # else: prompted, or random
sudo ./install.sh --nas                       # also enable the SMB (NAS) profile
sudo ./install.sh --mysql                     # MariaDB instead of SQLite
sudo ./install.sh --cn                        # Chinese apt/Docker mirrors
```

Re-running is safe — an existing `.env` is kept unless `--force-env` is given.
Credentials are also written to `/root/ANSNEW-CREDENTIALS.txt` (mode 600).

---

## Production deployment (public server + real domain)

For an internet-facing install — real TLS, HSTS, secure cookies, a firewall,
database/key backups and an upgrade runbook — follow
**[docs/DEPLOY.md](docs/DEPLOY.md)**. Backups (including the encryption keys) are
covered in **[docs/BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md)**.

The short version:

```bash
sudo ./install.sh --domain cloud.example.com          # writes a hardened .env
./scripts/init-letsencrypt.sh cloud.example.com you@example.com
```

Then add nightly backups and certificate renewal:

```bash
./scripts/backup.sh
# 0 3 * * * /srv/ansnew-cloud/scripts/backup.sh    >> /var/log/ansnew-backup.log 2>&1
# 0 3 * * * /srv/ansnew-cloud/scripts/renew-cert.sh >> /var/log/ansnew-cert.log 2>&1
```

> **Keep the `nas` (SMB, port 445) and `mysql` profiles OFF on a public host** —
> they are for a trusted LAN or development only.
>
> **Never run `docker compose down -v`.** It deletes the `data_volume`, which
> holds the database *and* the master encryption keys; every encrypted file in
> `storage-root/` would then be unreadable forever.

---

## First login

**Username:** `ADMIN_USER` from your `.env` (default `admin`).

The password is handled one of two ways:

### Option A — set a fixed password before the first boot (recommended)

Put it in `.env` **before** starting the stack for the first time:

```dotenv
ADMIN_USER=admin
ADMIN_PASSWORD=choose-something-long
```

The bootstrap only creates the account when it does **not** already exist, so this value is
used on a fresh install and ignored afterwards. Changing `ADMIN_PASSWORD` later does **not**
change an existing password — use the reset command below.

### Option B — let it generate one

Leave `ADMIN_PASSWORD` empty. A random password is generated and **printed exactly once**:

```bash
docker compose logs php | grep -i "admin credential"
```

> **This line is only in the logs of the container that performed the first boot.** If you
> recreate that container (`docker compose up --force-recreate`, a rebuild, or a fresh
> checkout), the message is gone for good — the account still exists in the database, but
> the password is no longer recoverable from anywhere. **Set `ADMIN_PASSWORD` or store the
> printed value immediately.**

### Forgot it? Reset from the CLI

```bash
# generate a new random password and print it
docker compose exec php php /var/www/app/bin/console.php ansnew:reset-password

# or set a specific one (min PASSWORD_MIN_LENGTH, default 10) — lands in your shell history
docker compose exec php php /var/www/app/bin/console.php ansnew:reset-password --password=my-new-password

# target a different account
docker compose exec php php /var/www/app/bin/console.php ansnew:reset-password --user=alice
```

You can also change your own password in the UI: click your avatar (top right) →
**Change password**.

## Destructive-action protection

A logged-in session proves who you are, not that you meant to wipe something. The
following actions ask for your password again before they run:

- Disconnecting a drive
- Deleting a storage connection (in Administration)
- Emptying or purging the trash
- Permanently deleting files (bypassing the trash)
- Removing **all** favourites at once
- Removing **all** shared links at once (revokes every share link you created)

The confirmation mints a short-lived grant (60 s by default) held on the server,
so the password prompt can't be skipped by the client. Deleting *to* the trash is
also gated by default; an administrator can turn that specific prompt off in
**Settings → Destructive-action protection** (`security.gate.delete_trash`), but
permanent deletes are always gated.

---

## Configuration

All settings live in `.env`. The ones that matter most:

| Variable | Default | Purpose |
|---|---|---|
| `APP_URL` | `http://localhost:8080` | Canonical URL; used for same-origin checks |
| `HTTP_PORT` | `8080` | Port nginx publishes for the app |
| `PUBLIC_HTTP_PORT` | `80` | Plain-HTTP listener: ACME challenge + redirect to HTTPS |
| `HTTPS_PORT` | `443` | TLS listener |
| `CERTS_HOST_PATH` | `/etc/ansnew/tls` | Directory holding `tls.crt` / `tls.key` (mounted read-only) |
| `SESSION_SECURE_COOKIE` | `true` | Only send the session cookie over HTTPS. Set `false` **only** while testing over plain HTTP |
| `TRUST_PROXY` | `true` | Honour `X-Forwarded-For`. Leave on when nginx/your own proxy is in front (rate limiting, lockout and the audit log key on the client IP) |
| `STORAGE_HOST_PATH` | `./storage-root` | Host directory bind-mounted as the default local mount |
| `BACKUP_HOST_PATH` | `/srv/ansnew-backups` | Host directory that `ansnew:backup` writes snapshots into |
| `ADMIN_USER` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` | `admin` / *(random)* / — | Bootstrap account (see above) |
| `PASSWORD_MIN_LENGTH` | `10` | Minimum password length. Lower it only on a throwaway local box |
| `DB_DRIVER` | `sqlite` | `sqlite` or `mysql` (needs `--profile mysql`) |
| `ANSNEW_ENCRYPT_LOCAL` | `1` | Encrypt file contents on local mounts |
| `UPLOAD_MAX_BYTES` | `2147483648` | Per-file upload cap (2 GiB) |
| `CHUNK_SIZE` | `8388608` | Chunk size for large uploads — keep it under your proxy's body limit |
| `EDIT_MAX_BYTES` | `5242880` | Largest file the built-in code editor will open or save |
| `TRASH_ENABLED` / `TRASH_RETENTION_DAYS` | `true` / `30` | Recoverable deletes |
| `JOB_LEASE_SECONDS` / `JOB_MAX_ATTEMPTS` | `900` / `3` | How long a job may run before its worker is presumed dead, and how many times it is retried before failing |
| `USAGE_RESCAN_DEBOUNCE` | `30` | Seconds between automatic storage-usage re-scans of the same mount after a change |
| `SSRF_ALLOW_PRIVATE` | `false` | Allow remote mounts to reach private networks |

The full list, with comments, is in [`.env.example`](.env.example).

> **`.env.example` is complete but the whitelist is not automatic.** `App\Config\Config`
> reads env vars from a hardcoded list — a variable read by code but missing from that list
> silently falls back to its default. Add new keys there, not just to `.env`.

### Secrets are generated for you

`APP_KEY` (protects saved remote-connection credentials), `WS_SECRET` (internal
PHP ↔ WebSocket auth) and the file-encryption key are created on first boot under
`data/keys/`. Leave the corresponding env vars empty to auto-generate, or supply your own.

### Database

SQLite is the default and needs no setup. For MariaDB:

```bash
docker compose --profile mysql up -d
```

then set `DB_DRIVER=mysql` in `.env`.

---

## Encryption at rest

Files on **local** mounts are encrypted with **streaming AES-256-GCM** before they touch
the disk. Remote mounts (FTP/SFTP/SMB/WebDAV) are *not* encrypted — the remote server is a
separate trust domain.

- Each file gets its own random data key, wrapped by the master key, so the master key can
  be rotated later without re-encrypting every byte.
- Files are self-describing (a `ANSNEWC1` header carries the plaintext size, MIME type and
  wrapped key), so they survive rename, copy, trash/restore, `rsync` and even database loss.
- The app decrypts transparently: downloads, previews, thumbnails, archive and extract all
  work exactly as before.
- Tampering, truncation and splicing are detected — a modified file fails to decrypt rather
  than silently returning wrong bytes.

> ### ⚠️ Back up `data/keys/file.key`
> This key is what makes your files readable. **Lose it and every encrypted file is
> permanently unrecoverable** — there is no backdoor and no escrow. Include
> `data/keys/` in your backups, and treat it as carefully as the data itself.

### Encrypting files that already exist

Anything written before encryption was enabled is still plaintext. Check and migrate:

```bash
# what is the current state?
docker compose exec php php /var/www/app/bin/console.php ansnew:crypto-status --scan

# stop the worker first so no job writes plaintext mid-run
docker compose stop worker

# preview, then run for real
docker compose exec php php /var/www/app/bin/console.php ansnew:encrypt-existing --dry-run
docker compose exec php php /var/www/app/bin/console.php ansnew:encrypt-existing

docker compose start worker
```

The migration is idempotent (already-encrypted files are skipped), resumable
(`--limit=N`), and crash-safe (each file is written to a temp file and atomically renamed).
Re-running it is always safe.

### Turning it off

Set `ANSNEW_ENCRYPT_LOCAL=0` to store **new** files in the clear. Files already encrypted
still read normally, so you can disable it without losing access to anything.

---

## Mounts

A fresh install seeds one mount, `local`, pointing at the bind mount
(`${STORAGE_HOST_PATH} → /srv/storage/local`). Add more under **Administration → Mounts**,
including remote ones via **Connections** (FTP, FTPS, SFTP, SMB, WebDAV). Remote
credentials are encrypted with `APP_KEY` and never sent to the browser.

Local mounts are sandboxed to `/srv/storage/local`; paths cannot escape it.

---

## Built-in code editor

Any text or code file opens in a full-screen editor instead of a read-only preview: a
monospace pane with a line-number gutter, `Ctrl`+`S` save, Revert, Download, a word-wrap
toggle, a rendered preview for Markdown, and a status bar showing `Ln`/`Col`, line and
character counts, the line ending, the BOM and the encoding.

Editing niceties: `Tab` / `Shift`+`Tab` indent and outdent (across a multi-line selection),
auto-indent on Enter, and `{|}` expands into a block with the caret inside.

**Which files open in it.** The rule is *open it unless there is a named reason not to*: a
known text extension, or a text MIME type, opens the editor; known media and binary formats
(images, video, audio, PDF, office documents, archives, executables, fonts, databases) go to
the viewer instead; and **anything unrecognised — an unknown extension, or none at all —
opens in the editor.** The server then checks the content for NUL bytes and answers `415`,
at which point the hex view takes over. So a wrong guess costs one cheap request, never a
broken editor.

**Safety rails.** Saving is refused for file types the upload policy protects (`.php`,
`.sh`, `.js`, …) — those open read-only with the reason shown. Files larger than
`EDIT_MAX_BYTES` (default 5 MiB) are refused with a download link. And the server returns a
SHA-256 of the bytes it handed you; Save sends it back, so a file changed meanwhile (another
tab, another device, a background job) is **never** silently overwritten — you get a conflict
prompt offering *Reload* or *Keep editing*.

> Saving preserves what a browser `<textarea>` would otherwise destroy: the original **CRLF**
> line endings and a **UTF-8 BOM** are recorded on load and restored on save.

---

## Large uploads (and Cloudflare Tunnel)

Uploads over `CHUNK_SIZE` (default 8 MiB) are **chunked automatically**: the browser slices
the file, posts the pieces concurrently, and the server reassembles them into one file.
Chunked uploads are **resumable** — re-selecting the same file re-uses the session and sends
only the missing chunks — and each chunk is verified by size, with the assembled file
checked against the total size and (optionally) a client-supplied SHA-256.

This matters behind a proxy with a per-request body limit. Cloudflare Tunnel on the Free
plan caps a request body at 100 MB, which cannot be raised; the default 8 MiB chunks sit
comfortably under it with no configuration:

| Variable | Default | Purpose |
|---|---|---|
| `CHUNK_SIZE` | `8388608` | Bytes per chunk. Raise it for fewer requests, but keep it well under your proxy's limit |
| `UPLOAD_MAX_BYTES` | `2147483648` | Largest single file accepted (2 GiB) |
| `UPLOAD_TMP_DIR` | `/var/www/data/tmp` | Where chunks are staged before assembly |

> Chunks are staged **unencrypted** while an upload is in flight and are purged by the
> worker's sweep if an upload is abandoned. Staging lives inside the `data_volume`, not in
> your storage root.

---

## NAS (SMB) option

Turn ANSNEW CLOUD into a LAN NAS so Windows "Map Network Drive" and mobile SMB apps
can drop files straight into the file manager. This is **opt-in** — it adds two
containers behind the `nas` compose profile and exposes a writable SMB share on
TCP 445:

```bash
# one-shot
docker compose --profile nas up -d

# or make it permanent: set in .env
COMPOSE_PROFILES=nas
docker compose up -d
```

What happens:

1. The `nas` container runs Samba and shares `<STORAGE_HOST_PATH>/_inbox` as
   `\\<host>\ansnew` (default share name `ansnew`, auth `NAS_USER` / `NAS_PASS`).
   Files written there land in the **same host directory** the app lists as the
   `local` mount, so they show up in the file manager immediately under `_inbox`.
2. The `nas-watch` container watches `_inbox` and imports each dropped file through
   a **serialized, rate-limited queue**: when at-rest encryption is on
   (`ANSNEW_ENCRYPT_LOCAL=1`) it encrypts the file in place, and aggregate
   throughput is capped at `NAS_INGEST_MBPS` (default **50 MB/s**) so a big batch
   can't saturate disk. Each import is recorded (so it runs exactly once) and
   audited under the `nas.import` action.

| Variable | Default | Purpose |
|---|---|---|
| `NAS_SHARE_NAME` | `ansnew` | SMB share name |
| `NAS_USER` / `NAS_PASS` | `ansnew` / `change-me-in-production` | SMB login (set a real password!) |
| `NAS_INGEST_MBPS` | `50` | Max import throughput, MB/s |
| `NAS_PORT` | `445` | Host port for SMB (must be free — Samba isn't running on the Linux host) |

> **Run the NAS role on a Linux Docker host.** SMB needs TCP 445; on a Windows/macOS
> dev box that port is already taken by the OS's own SMB, so the container can't bind
> it. On Linux it binds cleanly and other machines see it as a real NAS. Files written
> over SMB are owned by uid/gid 82 (matching the app containers) so the app can read
> and encrypt them.

---

## Background jobs

Long operations (archive, extract, copy, move, delete, folder download, disk usage) run on
a worker and report progress over WebSocket. Open the job drawer from the topbar to watch
or cancel them. One worker runs by default, so jobs are processed one at a time.

Jobs are **crash-safe**: a job takes a lease when a worker claims it and renews it as it
reports progress, so a worker killed mid-run does not leave the row `running` forever — the
reaper requeues it with exponential backoff, and fails it after `JOB_MAX_ATTEMPTS`.
Orphaned jobs are also recovered when the worker starts.

---

## Docker images

Four images, one per role. `php` is shared by the `php` (FastCGI), `worker` and
`mysql-migrate` services.

| Image | Contains | Notes |
|---|---|---|
| `ansnew/nginx` | nginx + the baked `public/` assets | The only service publishing host ports |
| `ansnew/php` | PHP 8.2-FPM + `src/` + `vendor/` | Also runs the worker and the CLI (`bin/console.php`) |
| `ansnew/ws` | Node WebSocket service | Realtime progress and `fs.changed` events |
| `ansnew/nas` | Samba + the `_inbox` watcher | Only used with `--profile nas` |

### Build

```bash
docker compose build            # all four
docker compose build nginx php  # just the ones you changed
```

> **`public/` is baked into the nginx *and* php images**, and the composer classmap is
> generated at build time — so a frontend edit or a new PHP class needs a rebuild, not just
> a restart. See [Development](#development).

### Publish to your own registry

`scripts/publish-images.sh` builds, tags and pushes all four in one go. Log in first:

```bash
docker login
./scripts/publish-images.sh <repository> <version>

# Docker Hub — one repository, a tag per component
./scripts/publish-images.sh needyamin/ansnew-cloud 1.0.0
#   -> needyamin/ansnew-cloud:{nginx,php,ws,nas}
#   -> needyamin/ansnew-cloud:{nginx,php,ws,nas}-1.0.0

# GitHub Container Registry (token needs write:packages)
echo "$GITHUB_TOKEN" | docker login ghcr.io -u <username> --password-stdin
./scripts/publish-images.sh ghcr.io/needyamin/ansnew-cloud 1.0.0
```

`--dry-run` prints every action without touching the registry, `--no-build` reuses the
images already on disk, and `--no-latest` pushes only the version tags. Docker Hub allows
only **one** slash in a repository path (`namespace/repository`), which is why this is one
repository with four tags rather than four nested paths.

Pushing by hand works too — set the four image references in `.env`
(`IMAGE_NGINX`, `IMAGE_PHP`, `IMAGE_WS`, `IMAGE_NAS`), then:

```bash
docker compose build
docker compose push             # pushes every service that has an `image:`
```

Prefer version tags over `latest` so you have something to roll back to. For a multi-arch
image (amd64 + arm64) build once per platform and push a manifest list:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -f docker/php/Dockerfile -t youruser/ansnew-cloud:php-1.2.0 --push .
```

### Deploy from published images (no build on the server)

On the target host, set the same four variables in `.env` and pull instead of build:

```bash
docker compose pull
docker compose up -d --no-build
```

`--no-build` matters: the services still declare a `build:` context, so without it Compose
would rebuild locally and silently ignore the images you just pulled.

---

## Development

The frontend is plain ES modules — **no build step, no framework**. Edit
`public/assets/js/*.js` or `public/assets/css/app.css` directly.

> **`public/` is baked into both the nginx and php images at build time.** After editing
> any frontend file you must rebuild, or the running container keeps serving the old copy:
> ```bash
> docker compose build nginx php && docker compose up -d nginx php worker
> ```

Backend changes likewise need `docker compose build php` (the composer classmap is
generated at image build time, so a new class must be present when the image is built).

### Verification

Run each with a clean storage root (`docker compose exec php rm -rf /srv/storage/local/*`)
— they assume an empty mount:

```bash
python tools/static-check.py .                  # unresolved class refs / PSR-4 audit
node tools/js-import-check.mjs public/assets/js # SPA imports resolve to real exports
bash tools/crypto-test.sh                       # encryption round-trip + tamper detection

ANSNEW_PW=... bash tools/job-smoke-test.sh      # all 7 job types + archive edge cases
ANSNEW_PW=... bash tools/integrity-test.sh      # upload/download/archive/trash md5 + at-rest
ANSNEW_PW=... node tools/ws-test.mjs            # WebSocket ticket + hello frame
ANSNEW_PW=... node tools/ui-test.mjs            # headless-Chrome UI smoke
ANSNEW_PW=... node tools/ui-diagnose.mjs        # layout geometry probe

# Frontend behaviour (all self-contained; they create and remove their own fixtures)
ANSNEW_PW=... node tools/perf-smoke.mjs         # list windowing, scroll, selection, no-flicker refresh
ANSNEW_PW=... node tools/optimistic-smoke.mjs   # instant rows, batch ops, rollback, uploads, no reloads
ANSNEW_PW=... node tools/realtime-test.mjs      # fs.changed events for every mutation type

# Editor and selection (see the notes below about their requirements)
node tools/marquee-test.mjs                     # drag-to-select: geometry, Ctrl, Esc, auto-scroll
bash tools/editor-text-policy-test.sh           # which files open in the editor (415 vs 413)
NODE_PATH=/path/with/jsdom node tools/editor-smoke.mjs   # editor DOM: gutter, save, CRLF/BOM
```

`optimistic-smoke.mjs` and `realtime-test.mjs` are the regression guards for the
"no page refreshes, immediate feedback" behaviour; `perf-smoke.mjs` asserts the
DOM node count stays bounded on a 1 500-entry folder.

> **Two of these need a real browser or jsdom, and it matters which.** `marquee-test.mjs`
> drives headless Chrome over the DevTools Protocol (no npm dependencies) and must, because
> the rubber band is pure geometry — **jsdom has no layout engine, so every
> `getBoundingClientRect()` there is 0×0** and a marquee test would pass vacuously.
> `editor-smoke.mjs` uses jsdom, which is the right tool for the editor because that is DOM
> construction rather than layout; it needs jsdom on `NODE_PATH`.
>
> Point Chrome at your binary if it is not at the default path:
> `node tools/marquee-test.mjs http://localhost:9090 "C:/path/to/chrome.exe"`.

> Note: some containerised environments never deliver WebSocket frames to page
> scripts, so `optimistic-smoke.mjs` probes for that and skips its realtime
> assertions rather than failing. `realtime-test.mjs` covers the same ground
> from Node and works everywhere.

### Repository hygiene

`.gitignore` deliberately covers `certs/`, `backups/` and `acme-webroot/` — Compose falls
back to those paths **inside the repo** when the matching variable is unset, and they hold
the TLS private key and the database plus `file.key` / `app.key`. Committing either is
unrecoverable. Also never commit `.env`, `data/` or `storage-root/`.

---

## Troubleshooting

**The UI is blank.** The SPA failed to boot. Check the browser console, then confirm the
entry point loads: `curl -I http://localhost:PORT/assets/js/main.js`. Remember frontend
changes need an image rebuild (see Development).

**"Cannot reach the server" on the login page.** The API is down or nginx cannot reach
php: `docker compose ps` and `docker compose logs php`.

**Forgot the admin password.** See [First login](#forgot-it-reset-from-the-cli) — use
`ansnew:reset-password`.

**Files look like garbage on disk.** That is expected — they are encrypted. To read them
outside ANSNEW CLOUD you would need to decrypt them with `data/keys/file.key`.

**A file fails to decrypt.** It was modified or truncated outside ANSNEW CLOUD, or the wrong key
is present. Restore it from a backup; the encryption is authenticated, so a failure means
the bytes genuinely changed.

**Frontend changes don't appear.** You almost certainly skipped the rebuild.

---

## Documentation

| Document | Covers |
|---|---|
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Production deployment on a Linux VPS: DNS, firewall, TLS, upgrade and rollback |
| [`docs/BACKUP-RESTORE.md`](docs/BACKUP-RESTORE.md) | What to back up (including the encryption keys), how, and how to restore |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Internals: request flow, storage adapters, job queue, schema |

---

## License

There is **no `LICENSE` file in this repository yet**, which means it is "all rights
reserved" by default — nobody may legally reuse it, including via the `install.sh`
one-liner above. Add a license before inviting outside use.
