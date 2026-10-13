<?php

declare(strict_types=1);

namespace App\Core;

use App\Config\Config;
use PDO;
use PDOException;
use RuntimeException;

/**
 * PDO singleton. SQLite (WAL) — the single storage engine for the whole app.
 */
final class Database
{
    private static ?Database $instance = null;
    private PDO $pdo;

    private function __construct()
    {
        $cfg = Config::i();
        $path = $cfg->get('DB_DATABASE', Config::i()->dataDir() . '/db/ansnew.sqlite');
        $dir = dirname($path);
        if (!is_dir($dir)) {
            @mkdir($dir, 0770, true);
        }
        try {
            $this->pdo = new PDO('sqlite:' . $path, null, null, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            ]);
            $this->pdo->exec('PRAGMA journal_mode = WAL');
            $this->pdo->exec('PRAGMA foreign_keys = ON');
            $this->pdo->exec('PRAGMA busy_timeout = 5000');
            $this->pdo->exec('PRAGMA synchronous = NORMAL');
        } catch (PDOException $e) {
            throw new RuntimeException('Database connection failed', 0, $e);
        }
    }

    public static function i(): Database
    {
        return self::$instance ??= new self();
    }

    public function pdo(): PDO
    {
        return $this->pdo;
    }

    public function driver(): string
    {
        return 'sqlite';
    }

    /** @param array<string|int, mixed> $params */
    public function run(string $sql, array $params = []): \PDOStatement
    {
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt;
    }

    /** @param array<string|int, mixed> $params @return array<int, array<string, mixed>> */
    public function all(string $sql, array $params = []): array
    {
        return $this->run($sql, $params)->fetchAll();
    }

    /** @param array<string|int, mixed> $params @return array<string, mixed>|null */
    public function one(string $sql, array $params = []): ?array
    {
        $row = $this->run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    /** @param array<string|int, mixed> $params */
    public function scalar(string $sql, array $params = []): mixed
    {
        $v = $this->run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    /**
     * Apply the SQLite schema. Idempotent (IF NOT EXISTS everywhere).
     */
    public function migrate(): void
    {
        $file = dirname(__DIR__, 3) . '/database/schema.sqlite.sql';

        $sql = file_get_contents($file);
        if ($sql === false) {
            throw new RuntimeException('Schema file missing: ' . $file);
        }
        $this->pdo->exec($sql);

        $this->run(
            'INSERT OR IGNORE INTO schema_migrations (version) VALUES (:v)',
            [':v' => '1.0.0-base']
        );

        $this->applyAdditiveMigrations();
    }

    /**
     * Additive migrations for databases that already exist.
     *
     * The schema file only ever runs `CREATE TABLE IF NOT EXISTS`, which is a
     * no-op on a table that is already there — so a new *column* silently never
     * appears on an existing install. This is the step that closes that gap.
     *
     * Every entry must be safe to run repeatedly and must never destroy data.
     * New tables do NOT belong here: adding them to the schema file is enough,
     * because CREATE TABLE IF NOT EXISTS does create missing tables.
     */
    private function applyAdditiveMigrations(): void
    {
        // table, column, sqlite definition
        $columns = [
            // Who owns a drive. NULL = admin-managed / shared with everyone.
            ['mounts', 'owner_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL'],
            // Remote (S3-compatible) mounts hang off a saved connection.
            ['mounts', 'connection_id', 'INTEGER REFERENCES connections(id) ON DELETE SET NULL'],
            ['mounts', 'remote_path', "TEXT NOT NULL DEFAULT '/'"],
            ['connections', 'verify_tls', 'INTEGER NOT NULL DEFAULT 1'],
            // Recent entries carry enough metadata to render a useful list.
            ['recent_files', 'type', "TEXT NOT NULL DEFAULT 'file'"],
            ['recent_files', 'modified_at', 'INTEGER NOT NULL DEFAULT 0'],
            ['recent_files', 'size', 'INTEGER NOT NULL DEFAULT 0'],
            // Folder or file — decides what clicking a favourite does.
            ['favorites', 'type', "TEXT NOT NULL DEFAULT 'file'"],
            // Job crash recovery: a worker that dies mid-job used to leave the
            // row 'running' forever. These columns carry a lease + retry budget
            // so the queue can recover itself (see JobService::reapStale).
            ['jobs', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
            ['jobs', 'max_attempts', 'INTEGER NOT NULL DEFAULT 3'],
            ['jobs', 'lease_expires_at', 'INTEGER'],
            ['jobs', 'next_attempt_at', 'INTEGER'],
        ];
        foreach ($columns as [$table, $column, $sqliteDef]) {
            if ($this->hasColumn($table, $column)) {
                continue;
            }
            $this->pdo->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$sqliteDef}");
        }

        // Recent entries are de-duplicated per (user, mount, path): revisiting a
        // folder should bump it to the top, not append a duplicate row. Collapse
        // any existing duplicates before the unique index can be created.
        if (!$this->hasIndex('uq_recent_user_path')) {
            $this->pdo->exec(
                'DELETE FROM recent_files WHERE id NOT IN (
                    SELECT MAX(id) FROM recent_files GROUP BY user_id, mount, path
                )'
            );
            $this->pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_recent_user_path ON recent_files (user_id, mount, path)');
        }

        // SQLite cannot ALTER a CHECK constraint, and a slimmed-down install
        // carries `adapter IN ('local')` — which would reject every S3 mount.
        // Rebuild the table with the widened list when 's3' is missing.
        $this->widenAdapterCheck();

        $indexes = [
            ['idx_mounts_owner', 'CREATE INDEX idx_mounts_owner ON mounts (owner_user_id)'],
            ['idx_shares_user', 'CREATE INDEX idx_shares_user ON shares (user_id)'],
            ['idx_shares_lookup', 'CREATE INDEX idx_shares_lookup ON shares (token_hash)'],
        ];
        foreach ($indexes as [$name, $sql]) {
            if ($this->hasIndex($name)) {
                continue;
            }
            try {
                $this->pdo->exec($sql);
            } catch (PDOException $e) {
                // A missing table here just means the schema run above didn't
                // create it yet; the next migrate() call will pick it up.
                error_log('[ansnew] index ' . $name . ' deferred: ' . $e->getMessage());
            }
        }
    }

    /**
     * Widen the mounts adapter CHECK so it accepts 's3' alongside 'local'.
     *
     * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt
     * with SQLite's documented procedure (create-new → copy → drop → rename)
     * with foreign keys temporarily disabled. No-op once 's3' is accepted.
     */
    private function widenAdapterCheck(): void
    {
        $values = ['local', 's3'];
        $sql = (string) $this->scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mounts'"
        );
        if ($sql === '') {
            return;
        }
        if (str_contains($sql, "'s3'")) {
            return;   // already widened
        }
        $list = implode(',', array_map(static fn (string $v): string => "'" . $v . "'", $values));
        $rebuilt = preg_replace(
            '/CHECK\s*\(\s*adapter\s+IN\s*\([^)]*\)\s*\)/i',
            "CHECK (adapter IN ({$list}))",
            $sql,
            1
        );
        if ($rebuilt === null || $rebuilt === $sql) {
            return;   // no CHECK on adapter — nothing to widen
        }
        $rebuilt = preg_replace(
            '/^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)mounts\b/i',
            '$1mounts__new',
            $rebuilt,
            1
        ) ?? $rebuilt;

        $indexes = $this->all(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mounts' AND sql IS NOT NULL"
        );

        // PRAGMA foreign_keys is a no-op inside a transaction, so toggle it
        // outside one. With it off, the RENAME below leaves other tables'
        // REFERENCES clauses pointing at `mounts`.
        $this->pdo->exec('PRAGMA foreign_keys = OFF');
        try {
            $this->pdo->exec('DROP TABLE IF EXISTS mounts__new');
            $this->pdo->exec('BEGIN');
            $this->pdo->exec($rebuilt);
            $this->pdo->exec('INSERT INTO mounts__new SELECT * FROM mounts');
            $this->pdo->exec('DROP TABLE mounts');
            $this->pdo->exec('ALTER TABLE mounts__new RENAME TO mounts');
            foreach ($indexes as $idx) {
                try {
                    $this->pdo->exec((string) $idx['sql']);
                } catch (PDOException $e) {
                    // Auto-indexes cannot be recreated by hand; skip them.
                }
            }
            $this->pdo->exec('COMMIT');
            error_log('[ansnew] mounts adapter CHECK widened to local,s3');
        } catch (\Throwable $e) {
            $this->pdo->exec('ROLLBACK');
            $this->pdo->exec('PRAGMA foreign_keys = ON');
            error_log('[ansnew] mounts rebuild failed: ' . $e->getMessage());
            throw $e;
        }
        $this->pdo->exec('PRAGMA foreign_keys = ON');
    }

    private function hasColumn(string $table, string $column): bool
    {
        foreach ($this->all('PRAGMA table_info(' . $table . ')') as $row) {
            if (($row['name'] ?? '') === $column) {
                return true;
            }
        }
        return false;
    }

    private function hasIndex(string $name): bool
    {
        return (int) $this->scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = :n",
            [':n' => $name]
        ) > 0;
    }
}
