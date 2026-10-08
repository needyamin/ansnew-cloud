# ANSNEW CLOUD

A self-hosted, desktop-style file manager. Browse, upload, preview, archive and share
files across local and remote storage from one web UI, with optional encryption at rest.

**Stack:** PHP 8.2-FPM · nginx · Node WebSocket service · PHP background worker ·
SQLite (default) or MariaDB. Everything runs in Docker Compose.

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
| `HTTP_PORT` | `8080` | Port nginx publishes on the host |
| `APP_URL` | `http://localhost:8080` | Canonical URL; used for same-origin checks |
| `STORAGE_HOST_PATH` | `./storage-root` | Host directory bind-mounted as the default local mount |
| `ADMIN_USER` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` | `admin` / *(random)* / — | Bootstrap account (see above) |
| `PASSWORD_MIN_LENGTH` | `10` | Minimum password length. Lower it only on a throwaway local box (delete the line for production) |
| `DB_DRIVER` | `sqlite` | `sqlite` or `mysql` (needs `--profile mysql`) |
| `UPLOAD_MAX_BYTES` | `2147483648` | Per-file upload cap (2 GiB) |
| `ANSNEW_ENCRYPT_LOCAL` | `1` | Encrypt file contents on local mounts |
| `TRASH_ENABLED` / `TRASH_RETENTION_DAYS` | `true` / `30` | Recoverable deletes |
| `SSRF_ALLOW_PRIVATE` | `false` | Allow remote mounts to reach private networks |

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
```

`optimistic-smoke.mjs` and `realtime-test.mjs` are the regression guards for the
"no page refreshes, immediate feedback" behaviour; `perf-smoke.mjs` asserts the
DOM node count stays bounded on a 1 500-entry folder.

> Note: some containerised environments never deliver WebSocket frames to page
> scripts, so `optimistic-smoke.mjs` probes for that and skips its realtime
> assertions rather than failing. `realtime-test.mjs` covers the same ground
> from Node and works everywhere.

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

## License

See `LICENSE` if present. `docs/ARCHITECTURE.md` describes the internals in more detail.
