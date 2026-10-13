# ANSNEW CLOUD — Architecture

ANSNEW CLOUD is a self-hosted, desktop-style web file manager with encryption at rest.
PHP 8.2 backend with **zero package dependencies** (its own PSR-4 autoloader), dependency-free
ES-module frontend, fully Dockerized. Local storage (encrypted at rest) plus optional
S3-compatible remote drives; SQLite only.

## 1. High-level topology

```
                ┌────────────────────────────────────────────────┐
                │                  docker network                 │
 browser ───────┤  nginx (unprivileged, :8080)                   │
  (SPA)         │   ├─ /            → static SPA (public/)       │
                │   ├─ /api/*       → php-fpm:9000 (FastCGI)     │
                │   ├─ /s/{token}   → php-fpm (public shares)   │
                │   └─ /healthz     → static 200                 │
                │                                                │
                │  php-fpm (app)      worker (job runner, CLI)   │
                └────────────────────────────────────────────────┘
                        │                        │
                 volumes: ansnew_data      local filesystem
                 (sqlite, sessions,        (AES-256-GCM
                  trash, logs, keys)        encrypted at rest)
```

- **nginx** serves the SPA and proxies `/api` and `/s/` to php-fpm. Three listeners: the app
  port (published for local use), public HTTP (ACME + redirect), public HTTPS (TLS).
- **php-fpm** runs the REST API. Sessions are PHP-native files on a persistent volume.
- **worker** is the same PHP image running `bin/worker.php`: a polling job runner for
  long-running operations (archive, extract, bulk copy/move/delete, download-selection ZIP
  packing, usage scans) plus hourly sweeps of plaintext temp data. Progress lives in the
  `jobs` table; the SPA polls it.

## 2. Repository layout

```
ansnew/
├── docker-compose.yml          # nginx + php + worker
├── .env.example                # all configuration via environment variables
├── docker/
│   ├── php/Dockerfile          # php:8.2-fpm-alpine + extensions, non-root, no composer
│   ├── php/php.ini             # hardened production PHP settings
│   ├── php/entrypoint.sh       # key gen, migrations, admin bootstrap
│   └── nginx/                  # nginx-unprivileged + site config
├── public/                     # web root (nginx root)
│   ├── index.php               # sole PHP entry point + built-in autoloader
│   ├── healthz                 # static health file
│   └── assets/
│       ├── css/app.css         # design system (single light theme)
│       ├── js/                 # ES-module SPA, no build step
│       └── icons.svg           # inline sprite
├── src/App/                    # PSR-4: App\
│   ├── Core/                   # Kernel, Router, Request, Response, Database, RateLimiter
│   ├── Auth/                   # SessionManager, Guard, Policy, BruteForceGuard, Tickets
│   ├── Config/                 # env whitelist loader
│   ├── Storage/                # StorageManager, Mount, LocalAdapter, Encryption/*
│   ├── Services/               # FileService, UploadService, JobService, ArchiveService,
│   │                           # DownloadService, ShareService, TrashService, UsageService,
│   │                           # UserService, FavoritesService, EncryptionMigrationService
│   ├── Jobs/                   # worker + handlers (archive, extract, copy, move, delete,
│   │                           # du, download-selection)
│   ├── Support/                # Crypto (AES-256-GCM), PathGuard, Validator, HttpRange,
│   │                           # ZipStreamWriter
│   └── Api/                    # thin controllers + the route table
├── database/schema.sqlite.sql  # the only schema
├── bin/                        # console.php (CLI) + worker.php (job runner)
├── data/                       # runtime volume (never served): db, sessions, trash, logs, keys
├── tools/                      # static checks + API smoke tests
└── docs/                       # ARCHITECTURE.md, DEPLOY.md
```

## 3. Database schema (summary — full DDL in `database/schema.sqlite.sql`)

| table | purpose |
|---|---|
| `users` | username (unique), password_hash (bcrypt cost 12), role (`admin`/`user`), is_active, must_change_pw |
| `login_attempts` | per-username+IP (and per-username) failure tracking for brute-force lockout |
| `mounts` | name (unique), label, adapter (`local`\|`s3`), local_root, connection_id (remote), remote_path, quota_bytes, is_readonly, is_visible_all, trash_enabled, owner_user_id |
| `connections` | saved S3-compatible endpoints: host, port, access-key id, `secret_enc` (AES-256-GCM), `extra` (bucket/region/path-style) |
| `mount_grants` | per-user grants when `is_visible_all = 0` |
| `jobs` | id (uuid), user_id, type, status, params (json), progress 0–100, message, result (json), attempts, max_attempts, lease_expires_at, next_attempt_at |
| `favorites` | user bookmarks: mount + path + label |
| `recent_files` | rolling per-user history of opened/downloaded entries |
| `shares` | token_hash (sha256), token_enc (AES-GCM), password_hash, expires_at, allow_download, revoked_at, access_count |
| `trash_items` | original mount/path, trash location, deleted_at, deleted_by |
| `rate_limits` | token-bucket state per user-or-IP |
| `settings` | KV: encrypted one-shot download tokens, share access grants |
| `schema_migrations` | applied migration versions |

## 4. Authentication & authorization flow

1. `GET /api/bootstrap` — establishes session, returns CSRF token, login state, published policy.
2. `POST /api/auth/login` — CSRF + same-origin checked by the Kernel, lockout checked
   (5 failures → exponential backoff; also an account-level ceiling across IPs),
   `password_verify`, session ID rotation, fresh CSRF token.
3. First-boot admins created from `ADMIN_PASSWORD` are forced through a password change
   (`must_change_pw`); the bootstrap command enforces the password policy unless `--force`
   is passed explicitly.
4. Every API call: session (active user re-queried per request) → rate limit (token bucket per
   user-or-IP) → CSRF token + Origin check on every non-GET → route dispatch → controller-level
   RBAC (`Guard::requireUser` / `requireAdmin`, `Policy::assertCan` for mount capabilities).
5. Session hardening: `cookie_httponly`, `SameSite=Strict`, `Secure` when HTTPS, strict mode,
   idle timeout 30 min, absolute lifetime 12 h, user-agent binding, rotation on login and on
   password change.
6. Logout destroys the session; the SPA clears its caches and returns to the login screen.

### RBAC

- `admin`: user management, mount management, everything else.
- `user`: only mounts explicitly granted (or flagged `is_visible_all`), own
  favorites/recent/jobs/shares, operations allowed by mount flags (`is_readonly`, quota).
- Per-operation capability checks live in `FileService` / `Policy`; read-only grants reject
  writes, including through the job-backed paths (checked at enqueue time).

## 5. Storage & encryption

```php
interface StorageAdapter {
    list/stat/mkdir/rm/rename/copy/exists/du/search
    getStream(path, from, len)   // ranged reads for download/preview
    putStream(path, stream)      // upload / server-side chunk sink
}
```

- **LocalAdapter** — hardened: canonicalized root; every resolved path must remain inside the
  root (lexical `..` rejection plus `realpath` containment, so symlink escapes are refused);
  honours `is_readonly`; trash is a hidden directory filtered from listings.
- **S3Adapter** — hand-rolled SigV4 over ext-curl for S3-compatible stores (AWS S3, Cloudflare
  R2, MinIO, Wasabi, B2). Virtual-host or path-style addressing, bucket + region + path-style
  held in the connection's encrypted `extra` JSON, and an SSRF guard on the endpoint at save
  time. Credentials are decrypted server-side per request and never reach the browser.
- **EncryptedAdapter + FileCipher** — every write becomes a self-describing `ANSNEWC1`
  container: 56-byte header (mime, extension, plaintext size, file id, key id), 1 MiB chunks,
  each AES-256-GCM with a per-file random nonce base + chunk index and AAD binding
  (magic, version, keyId, fileId, index) — reordering, truncation and splicing are detected.
  The per-file data key is wrapped under the master key (`data/keys/file.key`), so key rotation
  is cheap. MIME sniffing reads the header, since ciphertext sniffs as garbage. Writes publish
  atomically via a temp file + rename.
- Master keys: `APP_KEY` (stored secrets, share-grant HMAC) and `ANSNEW_FILE_KEY` (file
  contents) — separate so losing one does not doom the other. Both are 64-hex, auto-generated
  into `data/keys/` (mode 0660) on first boot.

Files are addressed as `mount:/some/path`; every path is re-validated server-side and no user
can cross mount boundaries.

## 6. Background jobs

- Long operations (archive, extract, recursive copy/move/delete, download-selection ZIP
  packing, usage scan) enqueue a `jobs` row and return a job id immediately.
- `bin/worker.php` claims jobs transactionally, runs the handler, updates progress 0–100.
- **Crash recovery.** A claim takes a *lease* (`jobs.lease_expires_at`) and increments
  `jobs.attempts`. The lease is renewed by every progress update and by
  `AbstractHandler::checkCancel()`. On start the worker calls `JobService::recoverOrphans()`
  (anything still `running` was orphaned by a crash — there is a single worker container);
  while idle it runs `JobService::reapStale()`, which requeues expired jobs with exponential
  backoff until `jobs.max_attempts`, then fails them. Retries are at-least-once.
- The frontend polls `GET /api/jobs` every 3 s while the drawer is open and something is in
  flight — that poll is the only progress channel (there is no WebSocket in this build).
- Hourly worker sweeps: trash retention, prepared download archives, and staged upload chunks
  (both plaintext on disk by nature, so retention is deliberately short).
- Small operations (mkdir, rename, single-file delete, small copy) execute inline and return
  synchronously.

## 7. Frontend SPA

Vanilla ES modules, no build step, no CDN at runtime, single light theme (CSS custom properties).

- **Views**: login, Files (main desktop), Trash, Recent, Favourites, Shared links, Settings,
  Admin → Users, Mounts, S3/R2 Connections.
- **Files view**: windowed listing (bounded DOM for 10k+ entries), tabs, split pane, drag &
  drop (intra-pane, inter-pane, and external upload), grid/list/details view modes, sort,
  filter, search, breadcrumb, selection (click/ctrl/shift/rubber band), context menus,
  details pane, keyboard navigation.
- **Uploads**: drag-and-drop anywhere + pickers (files or whole folders); small files POST
  directly; large files auto-switch to resumable chunked uploads; per-file progress + cancel.
- **Downloads**: direct files stream straight through the File System Access API where
  available (real progress/ETA), otherwise the browser's own download UI; folders/multi-item
  selections are packed by the worker and then downloaded through the same tray.
- **Code editor** (`editor.js`): full-screen monospace editor with a line-number gutter,
  `Ctrl`+`S` save, Revert, a wrap toggle, a rendered Markdown preview, and a status bar.
  Backed by `GET /api/fs/{mount}/text` and `POST /api/fs/{mount}/write`
  (`FileService::readText()` / `writeText()`). Reads refuse binary content (415 — a NUL sniff
  over the first 8 KiB) and oversize files (413, `EDIT_MAX_BYTES`); writes carry a sha256 of
  the bytes that were read (`baseHash`) — a concurrent edit is refused with **409** instead of
  being clobbered. CRLF and a UTF-8 BOM are reported on read and restored on save. Protected
  extensions and read-only mounts open the file read-only, with the reason shown.
- **Previews** (sandboxed, never render user content as active): images, video/audio
  (custom player with Range streaming), PDF, hex fallback.
- **Public share pages** are server-rendered: password form POSTs, then an HttpOnly access
  grant cookie keeps the password out of every subsequent URL.

## 8. Configuration

Everything is environment-first (`.env` consumed by compose). Key variables (see
`.env.example` for the full annotated list):

| var | meaning |
|---|---|
| `APP_URL` | canonical base URL (same-origin checks) |
| `APP_KEY` / `ANSNEW_FILE_KEY` | master keys; generated into `data/keys/` when empty |
| `ADMIN_USER` / `ADMIN_PASSWORD` | bootstrap admin (default `admin` if unset; a change is forced at first sign-in) |
| `PASSWORD_MIN_LENGTH` | minimum password length (default 10) |
| `SESSION_LIFETIME`, `IDLE_TIMEOUT`, `SESSION_SECURE_COOKIE` | session policy |
| `UPLOAD_MAX_BYTES`, `CHUNK_SIZE` | upload policy |
| `EDIT_MAX_BYTES` | largest file the built-in code editor will open or save |
| `RATE_LIMIT_*`, `LOGIN_*` | API rate limiting + brute-force lockout |
| `TRUST_PROXY` | honour `X-Forwarded-For` for the client IP |
| `SSRF_ALLOW_PRIVATE`, `SSRF_ALLOWLIST` | remote-connection target policy (see `Support/SsrfGuard`) |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS` | worker crash recovery |
| `ANSNEW_ENCRYPT_LOCAL`, `ANSNEW_FILE_KEY_ID` | encryption at rest + key rotation hook |
| `TRASH_ENABLED`, `TRASH_RETENTION_DAYS` | trash policy |
| `HTTP_PORT`, `PUBLIC_HTTP_PORT`, `HTTPS_PORT`, `CERTS_HOST_PATH`, `ACME_WEBROOT_HOST_PATH` | ports + TLS material |

> `App\Config\Config` reads env vars from a **hardcoded whitelist**: a variable read by code
> but missing from that list silently falls back to its default. Add new keys there as well
> as to `.env`.

Volumes: `data_volume` (database, encryption keys, sessions, temp) and `storage_volume`
(default local mount root). The host bind `STORAGE_HOST_PATH` maps onto
`/srv/storage/local`, which is where the default mount lives.

## 9. Security model (enforced where?)

| threat | control |
|---|---|
| stolen disk / backup | every file is an AES-256-GCM container with per-file wrapped keys; keys live outside the storage root |
| path traversal / arbitrary file access | `PathGuard` canonicalization per mount + adapter containment; no client-visible absolute paths |
| symlink escape | LocalAdapter rejects targets whose realpath leaves the root |
| SQLi | PDO prepared statements only |
| XSS | SPA builds DOM with `textContent` and attribute-safe helpers; CSP `default-src 'self'`; previews never render user content as active |
| CSRF | SameSite=Strict + per-session token on every mutating verb + Origin check |
| session hijack | httponly, Secure over HTTPS, rotation on login/password change, idle + absolute timeouts, UA binding, constant-time compare |
| brute force / password spray | per username+IP and per-account counters, exponential lockout, rate limiting |
| malicious upload | extension blocklist on every dot segment, content sniffing for executables, size caps, staging outside the web root, never executed |
| share-link abuse | 256-bit tokens stored only hashed, optional bcrypt password (min 6), expiry, revoke/rotate, read-only scope, access counted |
| info leak | `data/` never web-served; 5xx responses are generic (details go to the log only); `X-Robots-Tag: noindex` |
| abandoned plaintext | temp archives and staged chunks swept hourly by the worker; download tokens are one-shot and encrypted |
| remote-credential theft | S3 secrets stored AES-256-GCM encrypted, decrypted only per request inside PHP; SSRF-guarded endpoints; read-only scope enforced by the same RBAC as local drives |
