-- ANSNEW CLOUD schema — SQLite dialect (default).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    username        TEXT    NOT NULL UNIQUE,
    email           TEXT    NOT NULL DEFAULT '',
    password_hash   TEXT    NOT NULL,
    role            TEXT    NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
    display_name    TEXT    NOT NULL DEFAULT '',
    theme           TEXT    NOT NULL DEFAULT 'dark',
    locale          TEXT    NOT NULL DEFAULT 'en',
    home_mount_id   INTEGER REFERENCES mounts(id) ON DELETE SET NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    must_change_pw  INTEGER NOT NULL DEFAULT 0,
    failed_logins   INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
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
    protocol     TEXT NOT NULL CHECK (protocol IN ('ftp','ftps','sftp','smb','http')),
    host         TEXT NOT NULL,
    port         INTEGER NOT NULL,
    username     TEXT NOT NULL DEFAULT '',
    auth_type    TEXT NOT NULL DEFAULT 'password' CHECK (auth_type IN ('password','key','none')),
    secret_enc   TEXT,                       -- AES-256-GCM ciphertext (never plaintext)
    passphrase_enc TEXT,                     -- private-key passphrase, encrypted
    remote_base  TEXT NOT NULL DEFAULT '/',
    host_fingerprint TEXT,                   -- pinned SSH host key (TOFU)
    extra        TEXT NOT NULL DEFAULT '{}', -- json: passive mode, tls opts, domain, share
    verify_tls   INTEGER NOT NULL DEFAULT 1,
    created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS mounts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,   -- slug used by the API ("local", "nas")
    label          TEXT NOT NULL,
    adapter        TEXT NOT NULL CHECK (adapter IN ('local','ftp','ftps','sftp','smb','http')),
    local_root     TEXT,                   -- for local adapter only
    connection_id  INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    remote_path    TEXT NOT NULL DEFAULT '/',
    quota_bytes    INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
    is_readonly    INTEGER NOT NULL DEFAULT 0,
    is_visible_all INTEGER NOT NULL DEFAULT 0,
    trash_enabled  INTEGER NOT NULL DEFAULT 1,
    created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, mount, path)
);

CREATE TABLE IF NOT EXISTS recent_files (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mount     TEXT NOT NULL,
    path      TEXT NOT NULL,
    name      TEXT NOT NULL,
    action    TEXT NOT NULL DEFAULT 'open',
    at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recent_user ON recent_files(user_id, at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    username   TEXT NOT NULL DEFAULT '',
    action     TEXT NOT NULL,
    mount      TEXT,
    path       TEXT,
    target     TEXT,
    status     TEXT NOT NULL DEFAULT 'ok',
    detail     TEXT NOT NULL DEFAULT '',
    ip         TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at DESC);

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

CREATE TABLE IF NOT EXISTS ws_tickets (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel     TEXT NOT NULL DEFAULT 'events',
    scope       TEXT NOT NULL DEFAULT '',
    expires_at  INTEGER NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
    k          TEXT PRIMARY KEY,
    v          TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
