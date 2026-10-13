-- ANSNEW CLOUD schema — SQLite dialect (the only one).
-- Slimmed-down local-only file storage: no remote adapters, no websockets,
-- no 2FA, no audit log, no backups/undo history, no NAS inbox.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE,
    email           TEXT    NOT NULL DEFAULT '',
    password_hash   TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    display_name    TEXT    NOT NULL DEFAULT '',
    theme           TEXT    NOT NULL DEFAULT 'light',
    locale          TEXT    NOT NULL DEFAULT 'en',
    home_mount_id   INTEGER REFERENCES mounts(id) ON DELETE SET NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    must_change_pw  INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login_at   TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL,
    ip          TEXT NOT NULL,
    success     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup ON login_attempts(username, ip, created_at);

CREATE TABLE IF NOT EXISTS connections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    protocol     TEXT NOT NULL CHECK (protocol IN ('s3')),
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL,
    username     TEXT NOT NULL DEFAULT '',
    auth_type    TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password','key','none')),
    secret_enc   TEXT,                       -- AES-256-GCM ciphertext (never plaintext)
    passphrase_enc TEXT,                     -- private-key passphrase, encrypted
    remote_base  TEXT NOT NULL DEFAULT '/',
    extra        TEXT NOT NULL DEFAULT '{}', -- json: bucket, region, path_style
    verify_tls   INTEGER NOT NULL DEFAULT 1,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,   -- slug used by the API ("local", "nas")
    label          TEXT NOT NULL,
    adapter        TEXT NOT NULL CHECK (adapter IN ('local','s3')),
    local_root     TEXT,                   -- for local adapter only
    connection_id  INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    remote_path    TEXT NOT NULL DEFAULT '/',
    quota_bytes    INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
    is_readonly    INTEGER NOT NULL DEFAULT 0,
    is_visible_all INTEGER NOT NULL DEFAULT 0,
    trash_enabled  INTEGER NOT NULL DEFAULT 1,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    -- Who owns this drive. NULL = admin-managed / shared. A non-NULL owner is a
    -- personal drive: only that user (and admins) can see, rename or remove it.
    owner_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mount_grants (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    mount_id  INTEGER NOT NULL REFERENCES mounts(id) ON DELETE CASCADE,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_write INTEGER NOT NULL DEFAULT 1,
    UNIQUE (mount_id, user_id)
);

CREATE TABLE IF NOT EXISTS jobs (
    id          TEXT PRIMARY KEY,                 -- uuid v4
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','done','error','canceled')),
    params      TEXT NOT NULL DEFAULT '{}',
    progress    INTEGER NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT '',
    result      TEXT,
    cancel_flag INTEGER NOT NULL DEFAULT 0,
    -- Crash recovery. A job whose worker dies is requeued once its lease
    -- expires, up to max_attempts, then failed (see JobService).
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    lease_expires_at INTEGER,                       -- unix epoch
    next_attempt_at  INTEGER,                       -- unix epoch (retry backoff)
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    started_at  TEXT,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS favorites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mount      TEXT NOT NULL,
    path       TEXT NOT NULL,
    label      TEXT NOT NULL DEFAULT '',
    type       TEXT NOT NULL DEFAULT 'file',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, mount, path)
);

CREATE TABLE IF NOT EXISTS recent_files (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mount       TEXT NOT NULL,
    path        TEXT NOT NULL,
    name        TEXT NOT NULL,
    action      TEXT NOT NULL DEFAULT 'open',
    type        TEXT NOT NULL DEFAULT 'file',
    modified_at INTEGER NOT NULL DEFAULT 0,
    size        INTEGER NOT NULL DEFAULT 0,
    at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recent_user ON recent_files(user_id, at DESC);

-- Share links. The public token is never stored in the clear: `token_hash` is
-- what lookups use, and `token_enc` (AES-GCM under APP_KEY) is only decrypted to
-- re-display the link to its owner. A stolen database therefore yields neither
-- a working link nor a usable credential.
CREATE TABLE IF NOT EXISTS shares (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash      TEXT NOT NULL UNIQUE,
    token_enc       TEXT NOT NULL,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mount           TEXT NOT NULL,
    path            TEXT NOT NULL,
    name            TEXT NOT NULL,
    is_dir          INTEGER NOT NULL DEFAULT 0,
    password_hash   TEXT,
    expires_at      TEXT,
    allow_download  INTEGER NOT NULL DEFAULT 1,
    revoked_at      TEXT,
    access_count    INTEGER NOT NULL DEFAULT 0,
    last_access_at  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);
CREATE INDEX IF NOT EXISTS idx_shares_lookup ON shares(token_hash);

CREATE TABLE IF NOT EXISTS trash_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    mount         TEXT NOT NULL,
    original_path TEXT NOT NULL,
    trash_path    TEXT NOT NULL,
    name          TEXT NOT NULL,
    is_dir        INTEGER NOT NULL DEFAULT 0,
    size          INTEGER NOT NULL DEFAULT 0,
    deleted_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
    k           TEXT PRIMARY KEY,
    tokens      REAL NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Key/value store. Holds short-lived download tokens (encrypted) and
-- password-less access grants for password-protected public share pages.
CREATE TABLE IF NOT EXISTS settings (
    k          TEXT PRIMARY KEY,
    v          TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
