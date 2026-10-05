-- ANSNEW CLOUD schema — MariaDB / MySQL dialect.
-- Used when DB_DRIVER=mysql (`docker compose --profile mysql up -d`).
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(64)  NOT NULL UNIQUE,
    email           VARCHAR(190) NOT NULL DEFAULT '',
    password_hash   VARCHAR(255) NOT NULL,
    role            ENUM('admin','user') NOT NULL DEFAULT 'user',
    display_name    VARCHAR(190) NOT NULL DEFAULT '',
    theme           VARCHAR(16)  NOT NULL DEFAULT 'dark',
    locale          VARCHAR(16)  NOT NULL DEFAULT 'en',
    home_mount_id   BIGINT UNSIGNED NULL,
    is_active       TINYINT(1)   NOT NULL DEFAULT 1,
    must_change_pw  TINYINT(1)   NOT NULL DEFAULT 0,
    failed_logins   INT          NOT NULL DEFAULT 0,
    locked_until    DATETIME     NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at   DATETIME     NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS login_attempts (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username    VARCHAR(64) NOT NULL,
    ip          VARCHAR(45) NOT NULL,
    success     TINYINT(1)  NOT NULL DEFAULT 0,
    created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_login_lookup (username, ip, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS connections (
    id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name         VARCHAR(64)  NOT NULL UNIQUE,
    protocol     ENUM('ftp','ftps','sftp','smb','http','s3') NOT NULL,
    host         VARCHAR(255) NOT NULL,
    port         INT          NOT NULL,
    username     VARCHAR(190) NOT NULL DEFAULT '',
    auth_type    ENUM('password','key','none') NOT NULL DEFAULT 'password',
    secret_enc   TEXT         NULL,
    passphrase_enc TEXT       NULL,
    remote_base  VARCHAR(1024) NOT NULL DEFAULT '/',
    host_fingerprint VARCHAR(190) NULL,
    extra        TEXT         NOT NULL,
    verify_tls   TINYINT(1)   NOT NULL DEFAULT 1,
    created_by   BIGINT UNSIGNED NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mounts (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name           VARCHAR(64)  NOT NULL UNIQUE,
    label          VARCHAR(190) NOT NULL,
    adapter        ENUM('local','ftp','ftps','sftp','smb','http','s3') NOT NULL,
    local_root     VARCHAR(1024) NULL,
    connection_id  BIGINT UNSIGNED NULL,
    remote_path    VARCHAR(1024) NOT NULL DEFAULT '/',
    quota_bytes    BIGINT       NOT NULL DEFAULT 0,
    is_readonly    TINYINT(1)   NOT NULL DEFAULT 0,
    is_visible_all TINYINT(1)   NOT NULL DEFAULT 0,
    trash_enabled  TINYINT(1)   NOT NULL DEFAULT 1,
    created_by     BIGINT UNSIGNED NULL,
    -- Who owns this drive. NULL = admin-managed / shared.
    owner_user_id  BIGINT UNSIGNED NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS mount_grants (
    id        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    mount_id  BIGINT UNSIGNED NOT NULL,
    user_id   BIGINT UNSIGNED NOT NULL,
    can_write TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_mount_user (mount_id, user_id),
    CONSTRAINT fk_grant_mount FOREIGN KEY (mount_id) REFERENCES mounts(id) ON DELETE CASCADE,
    CONSTRAINT fk_grant_user  FOREIGN KEY (user_id)  REFERENCES users(id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS jobs (
    id          CHAR(36) PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    type        VARCHAR(64) NOT NULL,
    status      ENUM('queued','running','done','error','canceled') NOT NULL DEFAULT 'queued',
    params      MEDIUMTEXT NOT NULL,
    progress    INT NOT NULL DEFAULT 0,
    message     VARCHAR(512) NOT NULL DEFAULT '',
    result      MEDIUMTEXT NULL,
    cancel_flag TINYINT(1) NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at  DATETIME NULL,
    finished_at DATETIME NULL,
    INDEX idx_jobs_user (user_id, created_at),
    CONSTRAINT fk_jobs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS favorites (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    mount      VARCHAR(64) NOT NULL,
    path       VARCHAR(1024) NOT NULL,
    label      VARCHAR(190) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_fav (user_id, mount, path(191)),
    CONSTRAINT fk_fav_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS recent_files (
    id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT UNSIGNED NOT NULL,
    mount       VARCHAR(64) NOT NULL,
    path        VARCHAR(1024) NOT NULL,
    name        VARCHAR(512) NOT NULL,
    action      VARCHAR(32) NOT NULL DEFAULT 'open',
    type        VARCHAR(8) NOT NULL DEFAULT 'file',
    modified_at BIGINT NOT NULL DEFAULT 0,
    size        BIGINT NOT NULL DEFAULT 0,
    at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_recent_user (user_id, at),
    CONSTRAINT fk_recent_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Share links. The public token is never stored in the clear: `token_hash` is
-- what lookups use, and `token_enc` (AES-GCM under APP_KEY) is only decrypted to
-- re-display the link to its owner.
CREATE TABLE IF NOT EXISTS shares (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    token_hash      CHAR(64) NOT NULL UNIQUE,
    token_enc       VARCHAR(255) NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    mount           VARCHAR(64) NOT NULL,
    path            VARCHAR(1024) NOT NULL,
    name            VARCHAR(512) NOT NULL,
    is_dir          TINYINT(1) NOT NULL DEFAULT 0,
    password_hash   VARCHAR(255) NULL,
    expires_at      DATETIME NULL,
    allow_download  TINYINT(1) NOT NULL DEFAULT 1,
    revoked_at      DATETIME NULL,
    access_count    BIGINT UNSIGNED NOT NULL DEFAULT 0,
    last_access_at  DATETIME NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_shares_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_log (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id    BIGINT UNSIGNED NULL,
    username   VARCHAR(64) NOT NULL DEFAULT '',
    action     VARCHAR(64) NOT NULL,
    mount      VARCHAR(64) NULL,
    path       VARCHAR(1024) NULL,
    target     VARCHAR(1024) NULL,
    status     VARCHAR(16) NOT NULL DEFAULT 'ok',
    detail     TEXT NOT NULL,
    ip         VARCHAR(45) NOT NULL DEFAULT '',
    user_agent VARCHAR(255) NOT NULL DEFAULT '',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_created (created_at),
    INDEX idx_audit_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS trash_items (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id       BIGINT UNSIGNED NULL,
    mount         VARCHAR(64) NOT NULL,
    original_path VARCHAR(1024) NOT NULL,
    trash_path    VARCHAR(1024) NOT NULL,
    name          VARCHAR(512) NOT NULL,
    is_dir        TINYINT(1) NOT NULL DEFAULT 0,
    size          BIGINT NOT NULL DEFAULT 0,
    deleted_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rate_limits (
    k          VARCHAR(191) PRIMARY KEY,
    tokens     DOUBLE NOT NULL,
    updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS ws_tickets (
    id         CHAR(36) PRIMARY KEY,
    user_id    BIGINT UNSIGNED NOT NULL,
    channel    VARCHAR(32) NOT NULL DEFAULT 'events',
    scope      VARCHAR(255) NOT NULL DEFAULT '',
    expires_at BIGINT NOT NULL,
    used       TINYINT(1) NOT NULL DEFAULT 0,
    CONSTRAINT fk_ticket_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
    k          VARCHAR(191) PRIMARY KEY,
    v          TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS schema_migrations (
    version    VARCHAR(64) PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Tracks files dropped into the NAS SMB inbox so the watcher imports each once.
CREATE TABLE IF NOT EXISTS nas_inbox (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    path        VARCHAR(1024) NOT NULL,
    size        BIGINT UNSIGNED NOT NULL DEFAULT 0,
    status      VARCHAR(16) NOT NULL DEFAULT 'done',
    imported_at BIGINT NOT NULL DEFAULT 0,
    UNIQUE KEY uq_nas_inbox_path (path(768))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_nas_inbox_status ON nas_inbox(status);
