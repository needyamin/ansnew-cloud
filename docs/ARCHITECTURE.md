# ANSNEW CLOUD — Architecture

ANSNEW CLOUD is a self-hosted, desktop-style web file manager. PHP 8.2 backend, dependency-free
ES-module frontend, WebSocket layer on Node.js, fully Dockerized.

## 1. High-level topology

```
                ┌────────────────────────────────────────────────┐
                │                  docker network                 │
                │                                                │
 browser ───────┤  nginx (unprivileged, :8080)                   │
  (SPA)         │   ├─ /            → static SPA (public/)       │
                │   ├─ /api/*       → php-fpm:9000 (FastCGI)     │
                │   ├─ /ws          → ws:3001 (upgrade)          │
                │   └─ /healthz     → static 200                 │
                │                                                │
                │  php-fpm (app)      worker (job runner, CLI)   │
                │  ws (Node, ws+ssh2) mariadb (optional profile) │
                └────────────────────────────────────────────────┘
                        │                        │
                 volumes: ansnew_data      local/remote FS
                 (sqlite, sessions,        via StorageAdapters:
                  trash, logs, app key)    local, FTP, FTPS, SFTP,
                                           SMB, HTTP/WebDAV
```

- **nginx** (nginxinc/nginx-unprivileged:alpine) serves the SPA and proxies to PHP and WS.
- **php-fpm** runs the REST API. Sessions are PHP-native files on a persistent volume.
- **worker** is the same PHP image running `bin/worker.php`: a polling job runner for
  long-running operations (archive, extract, bulk copy/move/delete, folder download prep,
  usage scans). Progress is written to the `jobs` table and pushed to the WS server.
- **ws** (Node 20, `ws` + `ssh2`) handles browser WebSockets: authentication via
  short-lived signed tickets, job progress fan-out, notifications, and the optional SSH
  web terminal.
- **nas** (optional, `--profile nas`) is a small Samba server (Alpine + `samba`) that
  exposes `<STORAGE_HOST_PATH>/_inbox` as a writable SMB share on TCP 445, so Windows
  "Map Network Drive" and mobile SMB apps can drop files into the file manager. Files
  land in the same host bind mount the `local` mount reads, so they appear immediately.
- **nas-watch** (optional, `--profile nas`) reuses the php image and runs
  `bin/nas-watch.php`: it polls `_inbox`, and for each stable (fully-copied) file
  encrypts it in place when `ANSNEW_ENCRYPT_LOCAL=1`, then records it in `nas_inbox`
  and audits it. Aggregate import throughput is capped at `NAS_INGEST_MBPS` (default 50
  MB/s) so a bulk drop can't saturate disk.
- **mariadb** is optional (`--profile mysql`); default database is SQLite (WAL mode) to
  keep self-hosting one-command simple.

## 2. Repository layout

```
ansnew/
├── docker-compose.yml          # nginx + php + worker + ws (+ optional mariadb)
├── .env.example                # all configuration via environment variables
├── composer.json               # only runtime dep: phpseclib/phpseclib (SFTP/SSH)
├── docker/
│   ├── php/Dockerfile          # php:8.2-fpm-alpine + ext + composer + non-root
│   ├── php/php.ini             # hardened production PHP settings
│   ├── php/entrypoint.sh       # key gen, migrations, admin bootstrap
│   ├── nginx/Dockerfile        # nginx-unprivileged + site config
│   ├── nginx/default.conf
│   └── ws/Dockerfile           # node:20-alpine, non-root, ws + ssh2
├── public/                     # web root (nginx root)
│   ├── index.php               # sole PHP entry point (front controller)
│   ├── healthz                 # static health file
│   └── assets/
│       ├── css/app.css         # design system + themes (dark/light)
│       ├── js/                 # ES-module SPA, no build step
│       └── icons.svg           # inline sprite
├── src/App/                    # PSR-4: App\
│   ├── Core/                   # Kernel, Router, Request, Response, Container-ish registry
│   ├── Http/Middleware/        # Auth, Csrf, RateLimit, Rbac
│   ├── Auth/                   # SessionManager, Passwords, BruteForceGuard, Tickets
│   ├── Config/                 # Env config loader
│   ├── Storage/                # StorageManager, MountResolver, adapters/*
│   ├── Services/               # FileService, ArchiveService, JobService, SearchService,
│   │                           # TrashService, AuditService, UsageService, UserService,
│   │                           # ConnectionService, MountService, UploadService
│   ├── Jobs/                   # job handlers (archive, extract, copy, move, delete, usage)
│   ├── Support/                # Crypto (AES-256-GCM), PathGuard, Validator, Fs helper
│   └── Api/                    # thin controllers per resource
├── ws-server/                  # Node WS server (auth tickets, fan-out, SSH terminal)
├── database/schema.sql         # portable DDL (SQLite + MariaDB)
├── bin/worker.php              # CLI job runner
├── data/                       # runtime volume (never served): db, sessions, trash, logs, keys
└── docs/                       # ARCHITECTURE.md, API.md, SECURITY.md
```

## 3. Database schema (summary — full DDL in `database/schema.sql`)

| table | purpose |
|---|---|
| `users` | id, username (unique), password_hash, role (`admin`\|`user`), display_name, theme, home_mount_id, is_active, created_at, last_login_at |
| `login_attempts` | per-username+IP failure tracking for brute-force lockout |
| `mounts` | id, name (unique), adapter (`local`\|`ftp`\|`ftps`\|`sftp`\|`smb`\|`http`), local_root (for local), connection_id (remote), remote_path, quota_bytes, is_readonly, is_visible_all, created_by |
| `mount_grants` | per-user grants when `is_visible_all = 0` |
| `connections` | saved remote connections: protocol, host, port, username, auth_type (`password`\|`key`), `secret_enc` (AES-256-GCM), fingerprint, created_by. Plaintext secrets never stored |
| `jobs` | id (uuid), user_id, type, status (`queued`\|`running`\|`done`\|`error`\|`canceled`), params (json), progress 0–100, message, result (json), attempts, max_attempts, lease_expires_at, next_attempt_at, timestamps |
| `favorites` | user bookmarks: mount + path + label |
| `recent_files` | rolling per-user history of opened/downloaded entries |
| `audit_log` | id, user_id, action, mount, path, target, detail (json), ip, created_at |
| `trash_items` | original mount/path, trash location, deleted_at, deleted_by (local-adapter trash) |
| `ws_tickets` | one-time WS auth tickets, expiring |

## 4. Authentication & authorization flow

1. `GET /api/bootstrap` — establishes session, returns CSRF token, login state, i18n-ish labels, theme.
2. `POST /api/auth/login` — validates CSRF, checks `login_attempts` lockout (5 fails → exponential backoff), verifies `password_verify`, rotates session ID, regenerates CSRF token, writes audit + `last_login_at`.
3. **Sensitive-action re-authentication (`SensitiveGate`).** A logged-in session proves identity, not intent. Destructive operations — drive disconnect, connection delete, permanent or trash delete (`fs.delete`), trash empty, clearing all favourites (`favorites.clear`), and revoking all share links (`shares.clear`) — require the account password again. The client calls `POST /api/auth/confirm` with the scope; the server verifies the password (and 2FA if enabled), runs it through the brute-force guard, and mints a short-lived grant (default 60 s, configurable `SENSITIVE_GRANT_TTL`) stored **in the PHP session**, not the browser. Each gated controller calls `SensitiveGate::guard($session, $scope, $permanent)` first; on a missing/expired grant it returns `403 sensitive_required` (a distinct code, so the client can prompt for the password rather than treating it as a denial). Because the grant lives server-side it cannot be forged or skipped by the client. `fs.delete` is conditionally gated by the `security.gate.delete_trash` setting (default on); permanent deletes are always gated. An admin toggle (`POST /api/admin/security/gate`) flips that setting; the effective posture is published in `GET /api/bootstrap` under `sensitive`.
3. Every API call: `AuthMiddleware` (active session, active user) → `RateLimitMiddleware` (token bucket per user+IP in sqlite) → `RbacMiddleware` (route-declared role) → `CsrfMiddleware` (`X-CSRF-Token` header must match session token for every non-GET).
4. Session hardening: `session.cookie_httponly=1`, `SameSite=Strict`, `Secure` when HTTPS detected, strict client-side entropy acceptance, idle timeout 30 min, absolute lifetime 12 h, ID rotation on privilege change.
5. Logout destroys session + regenerates all tokens.
6. WebSocket: `POST /api/ws/ticket` mints a one-time, 60 s, HMAC-signed ticket bound to user id; Node verifies signature + ticket table, then binds the socket to the user. All pushes are addressed by user id.
7. SSH terminal: browser opens `ws://…/ws?channel=terminal&conn=<id>&ticket=<ticket>`; Node calls PHP's internal endpoint (shared secret, internal network only) to confirm the user may use that connection and to fetch decrypted credentials. Credentials cross only the internal Docker network, never the browser.

### RBAC

- `admin`: user management, mount/connection management (any), audit log (all), all operations.
- `user`: only mounts explicitly granted (or all mounts flagged `is_visible_all`), own favorites/recent/jobs/audit rows, operations allowed by mount flags (`is_readonly`, quota).
- Per-operation capability checks (e.g. write ops rejected on read-only mounts) live in `FileService`.

## 5. Storage abstraction

```php
interface StorageAdapter {
    list(string $path): array;         // entries with stat metadata
    stat(string $path): array;
    mkdir(string $path, bool $recursive): void;
    rm(string $path, bool $recursive): void;         // permanent
    rename(string $from, string $to): void;
    copy(string $from, string $to): void;
    getStream(string $path, int $from=-1, int $len=-1) // for download/preview ranges
    putStream(string $path, $stream): int;           // upload / server-side chunk sink
    exists(string $path): bool;
    du(string $path): array;           // size + file count
    search(string $path, string $needle, int $limit): array;
}
```

- **LocalAdapter** — hardened: canonicalized root; every resolved path must remain inside
  the root (rejects `..` and symlink escapes by `realpath` containment on every segment
  boundary that exists); follows mounts' `is_readonly`.
- **FtpAdapter / FtpsAdapter** — `ext-ftp`, explicit TLS for FTPS, passive mode, credentials
  from `ConnectionService` (decrypted server-side, held only for the request).
- **SftpAdapter** — phpseclib3; password or private-key auth; host-key fingerprint stored on
  first use and pinned afterwards (TOFU) in `connections.fingerprint`.
- **SmbAdapter** — `smbclient` subprocess built exclusively with `escapeshellarg()` per
  argument (no shell string interpolation); credentials passed via auth file (fd), never argv.
- **HttpAdapter** — WebDAV-ish: GET/PUT/MKCOL/PROPFIND/DELETE/MOVE/COPY over cURL with a
  strict SSRF guard (deny private/link-local/loopback targets unless admin allowlisted).

`StorageManager::forUser($user)` returns the mount list the user may see;
`StorageManager::mount($name, $user)` resolves one mount into an adapter after RBAC.
The frontend addresses files as `mount:/some/path`; mounts are namespaced so no user can
cross mount boundaries, and every path is re-validated server-side.

## 6. Background jobs & real-time

- Mutating "long" operations (archive, extract, recursive copy/move/delete, folder
  download, usage scan) enqueue a `jobs` row and return a job id immediately.
- `bin/worker.php` claims jobs (transactional), runs the handler, updates progress 0–100,
  and POSTs progress to the WS internal endpoint for fan-out.
- **Crash recovery.** A claim takes a *lease* (`jobs.lease_expires_at`) and increments
  `jobs.attempts`. The lease is renewed by every progress update and by
  `AbstractHandler::checkCancel()` (throttled), so a long job is never mistaken for a
  dead one. On start the worker calls `JobService::recoverOrphans()` — anything still
  `running` was orphaned by a previous crash (there is a single worker container) — and
  while idle it periodically runs `JobService::reapStale()`, which requeues expired jobs
  with exponential backoff (`jobs.next_attempt_at`) until `jobs.max_attempts` is reached,
  then fails them. Retries are at-least-once: a requeued handler may repeat side effects.
- WS events delivered to browsers: `job.progress`, `job.done`, `notify`, `terminal.data`,
  `terminal.exit`. The frontend surfaces toasts + a job drawer with cancel support
  (cancel = `jobs.status='canceled'`; handlers poll a cancellation flag between chunks).
- Small operations (mkdir, rename, single-file delete, small copy) execute inline and
  return the new listing delta synchronously.

## 7. Frontend SPA

Vanilla ES modules, no build step, no CDN at runtime.

- **Views**: login, Files (main desktop), Trash, Jobs, Favorites/Recent (sidebar), Admin →
  Users, Mounts, Connections, Audit.
- **Files view**: toolbar (new folder/file, upload, download, cut/copy/paste, rename,
  delete, archive, extract, view toggle, sort, search), tabs (multiple locations),
  optional split pane (two independent panes, drag between them), grid/list toggle,
  breadcrumb, selection (click, ctrl, shift, rubber band), context menu, details pane.
- **Uploads**: drag-and-drop anywhere + picker; small files POST directly with XHR
  progress; large files auto-switch to chunked upload (`uploadId` + chunk endpoints);
  per-file progress, pause-ish cancel (abort XHR), conflict dialog (overwrite/skip/rename).
- **Keyboard**: Del, F2, Ctrl+C/X/V/A/F, F5, F3 preview, Alt+←/→ history, Ctrl+Tab tabs,
  Enter open, Backspace up, Ctrl+1…9 jump tab, Esc close dialog/exit preview.
- **Previews** (sandboxed): images, video/audio, PDF (`<object sandbox>`), and a hex fallback
  for binary content. Text and code files do **not** use the read-only preview — they open in
  the code editor below.
- **Code editor** (`editor.js`): full-screen monospace editor with a line-number gutter,
  `Ctrl`+`S` save, Revert, Download, a wrap toggle, a rendered Markdown preview, and a
  `Ln`/`Col` + line-ending/BOM status bar. Backed by `GET /api/fs/{mount}/text` and
  `POST /api/fs/{mount}/write` (`FileService::readText()` / `writeText()`).
  Reads refuse binary content (415 — a NUL sniff over the first 8 KiB, done *before* the
  size cap so a huge binary falls back to the hex view rather than reporting "too large")
  and oversize files (413, `EDIT_MAX_BYTES`). Writes reuse the upload blocklist, so
  protected extensions open read-only, and carry a sha256 of the bytes that were read
  (`baseHash`) — a concurrent edit is refused with **409** instead of being clobbered.
  CRLF and a UTF-8 BOM are reported on read and restored on save.
  **Routing policy:** a file opens in the editor unless there is a named reason not to
  (a known binary/media extension or MIME type); an unknown or absent extension opens the
  editor, and the server's 415 is the backstop.
- **Selection**: click, Ctrl, Shift, Ctrl+A and keyboard navigation, plus a **rubber band** —
  dragging from empty space selects every row/tile the rectangle covers, with Ctrl to add,
  Esc to cancel and edge auto-scroll. Intersections are computed from the row *index* using
  the same pitch the layout uses, not by reading the DOM, so rows outside the render window
  are selected correctly and no layout is forced per pointermove.
- **Themes**: CSS custom properties; dark/light + accent; persisted per user (DB) and
  localStorage.
- **Terminal**: lightweight built-in terminal (line-buffered, ANSI-aware) over the WS
  terminal channel — no external terminal library needed.

## 8. Configuration

Everything is environment-first (`.env` consumed by compose):

| var | meaning |
|---|---|
| `APP_URL` | canonical base URL (cookie scope) |
| `APP_KEY` | optional 64-hex key; if empty, generated to `data/keys/app.key` on first boot |
| `WS_SECRET` | shared secret PHP↔WS internal API (generated if empty) |
| `DB_DRIVER` | `sqlite` (default) or `mysql` |
| `DB_*` | mysql credentials when enabled |
| `ADMIN_USER` / `ADMIN_PASSWORD` | bootstrap admin (random printed if unset) |
| `SESSION_LIFETIME`, `IDLE_TIMEOUT`, `SESSION_SECURE_COOKIE` | session policy |
| `UPLOAD_MAX_BYTES`, `CHUNK_SIZE` | upload policy (chunked uploads above `CHUNK_SIZE`) |
| `EDIT_MAX_BYTES` | largest file the code editor will open or save |
| `RATE_LIMIT_*` | API rate limiting |
| `TRUST_PROXY` | honour `X-Forwarded-For` for the client IP (rate limit, lockout, audit) |
| `JOB_LEASE_SECONDS`, `JOB_MAX_ATTEMPTS` | worker crash recovery: lease length, retries before failing |
| `USAGE_RESCAN_DEBOUNCE` | seconds between automatic usage re-scans of a mount |
| `SSRF_ALLOW_PRIVATE` | admin opt-in to allow private-network remote connections |
| `TRASH_ENABLED`, `TRASH_RETENTION_DAYS` | local trash on delete |
| `HTTP_PORT`, `PUBLIC_HTTP_PORT`, `HTTPS_PORT` | published ports: app, ACME+redirect, TLS |
| `CERTS_HOST_PATH`, `ACME_WEBROOT_HOST_PATH`, `BACKUP_HOST_PATH` | host dirs for TLS material, ACME challenges, backup snapshots |
| `IMAGE_NGINX`, `IMAGE_PHP`, `IMAGE_WS`, `IMAGE_NAS` | image references — build locally or pull from a registry |

> `App\Config\Config` reads env vars from a **hardcoded whitelist**: a variable read by
> code but missing from that list silently falls back to its default. Add new keys there
> as well as to `.env`.

Volumes: `data_volume` (database, encryption keys, logs, temp), `db_volume` (MariaDB,
`mysql` profile only) and `storage_volume` (default local mount root). Host binds
(`STORAGE_HOST_PATH`, `CERTS_HOST_PATH`, `BACKUP_HOST_PATH`) are configured in `.env`.

## 9. Security model (enforced where?)

| threat | control |
|---|---|
| path traversal / arbitrary file access | `PathGuard` canonicalization per mount + adapter containment + no client-visible absolute paths |
| symlink escape | LocalAdapter resolves symlinks and rejects targets outside root |
| SQLi | PDO prepared statements only, no string-built SQL |
| XSS | all dynamic output via `textContent`/attribute-safe builders; no innerHTML with user data; sanitized markdown renderer |
| CSRF | SameSite=Strict + per-session token on all mutating verbs + Origin check |
| session hijack | httponly, Secure, rotation on login, idle/absolute timeouts, UA+IP soft binding |
| brute force | per user+IP counters, exponential lockout, audit events |
| malicious upload | extension blocklist (php/php*/phtml/htaccess/…), finfo MIME check, double-extension detection, quarantine names, size caps, uploads stored outside web root, never executed |
| RCE / command injection | no `exec` except smbclient with per-arg `escapeshellarg`; no eval; PHP files never served from storage |
| SSRF | HttpAdapter target validation, DNS-resolved IP check, admin allowlist override |
| protocol abuse | connections are admin-created and per-user granted; internal WS/PHP endpoints require shared secret |
| privilege escalation | RBAC on every route; mounts grant-scoped; secrets decryptable only server-side |
| destructive-action abuse (unattended session, stray key) | `SensitiveGate`: password/2FA re-auth required for disconnect/delete/clear, grant held server-side, 60 s TTL, `fs.delete-to-trash` toggleable |
| info leak | `data/` never web-served; JSON errors generic; audit without secrets |
