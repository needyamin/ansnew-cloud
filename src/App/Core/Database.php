<?php

declare(strict_types=1);

namespace App\Core;

use App\Config\Config;
use PDO;
use PDOException;
use RuntimeException;

/**
 * PDO singleton. SQLite (WAL) by default; MySQL/MariaDB when DB_DRIVER=mysql.
 */
final class Database
{
    private static ?Database $instance = null;
    private PDO $pdo;
    private string $driver;

    private function __construct()
    {
        $cfg = Config::i();
        $this->driver = $cfg->get('DB_DRIVER', 'sqlite') === 'mysql' ? 'mysql' : 'sqlite';

        try {
            if ($this->driver === 'sqlite') {
                $path = $cfg->get('DB_DATABASE', Config::i()->dataDir() . '/db/ansnew.sqlite');
                $dir = dirname($path);
                if (!is_dir($dir)) {
                    @mkdir($dir, 0770, true);
                }
                $this->pdo = new PDO('sqlite:' . $path, null, null, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                ]);
                $this->pdo->exec('PRAGMA journal_mode = WAL');
                $this->pdo->exec('PRAGMA foreign_keys = ON');
                $this->pdo->exec('PRAGMA busy_timeout = 5000');
                $this->pdo->exec('PRAGMA synchronous = NORMAL');
            } else {
                $dsn = sprintf(
                    'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
                    $cfg->get('DB_HOST', 'db'),
                    $cfg->get('DB_PORT', '3306'),
                    $cfg->get('DB_NAME', 'ansnew')
                );
                $this->pdo = new PDO($dsn, $cfg->get('DB_USER'), $cfg->get('DB_PASSWORD'), [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false,
                ]);
            }
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
        return $this->driver;
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
     * Apply the dialect schema. Idempotent (IF NOT EXISTS everywhere).
     */
    public function migrate(): void
    {
        $file = $this->driver === 'mysql'
            ? dirname(__DIR__, 3) . '/database/schema.mysql.sql'
            : dirname(__DIR__, 3) . '/database/schema.sqlite.sql';

        $sql = file_get_contents($file);
        if ($sql === false) {
            throw new RuntimeException('Schema file missing: ' . $file);
        }

        if ($this->driver === 'mysql') {
            // Run statement-by-statement (PDO mysql doesn't allow multi by default).
            foreach (array_filter(array_map('trim', explode(';', $sql))) as $stmt) {
                if ($stmt !== '') {
                    $this->pdo->exec($stmt);
                }
            }
        } else {
            $this->pdo->exec($sql);
        }

        $this->run(
            'INSERT OR IGNORE INTO schema_migrations (version) VALUES (:v)',
            [':v' => '1.0.0-base']
        );

        $this->applyAdditiveMigrations();
    }

    /**
     * Additive migrations for databases that already exist.
     *
     * The schema files only ever run `CREATE TABLE IF NOT EXISTS`, which is a
     * no-op on a table that is already there — so a new *column* silently never
     * appears on an existing install. This is the step that closes that gap.
     *
     * Every entry must be safe to run repeatedly and must never destroy data.
     * New tables do NOT belong here: adding them to the schema file is enough,
     * because CREATE TABLE IF NOT EXISTS does create missing tables.
     */
    private function applyAdditiveMigrations(): void
    {
        // table, column, sqlite definition, mysql definition
        $columns = [
            // Who owns a drive. NULL = admin-managed / shared with everyone.
            ['mounts', 'owner_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL', 'BIGINT UNSIGNED NULL'],
            // Owner of a remote connection. NULL = admin-managed/shared, so the
            // existing admin-created connections keep working unchanged.
            ['connections', 'owner_user_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL', 'BIGINT UNSIGNED NULL'],
            // Recent entries carry enough metadata to render a useful list.
            ['recent_files', 'type', "TEXT NOT NULL DEFAULT 'file'", "VARCHAR(8) NOT NULL DEFAULT 'file'"],
            ['recent_files', 'modified_at', 'INTEGER NOT NULL DEFAULT 0', 'BIGINT NOT NULL DEFAULT 0'],
            ['recent_files', 'size', 'INTEGER NOT NULL DEFAULT 0', 'BIGINT NOT NULL DEFAULT 0'],
            // Two-factor authentication. The secret is encrypted at rest and
            // recovery codes are stored as password hashes, never plaintext.
            ['users', 'totp_secret_enc', 'TEXT', 'TEXT NULL'],
            ['users', 'totp_enabled', 'INTEGER NOT NULL DEFAULT 0', 'TINYINT(1) NOT NULL DEFAULT 0'],
            ['users', 'recovery_codes', "TEXT NOT NULL DEFAULT ''", "TEXT NOT NULL DEFAULT ''"],
            // Folder or file — decides what clicking a favourite does.
            ['favorites', 'type', "TEXT NOT NULL DEFAULT 'file'", "VARCHAR(8) NOT NULL DEFAULT 'file'"],
        ];
        foreach ($columns as [$table, $column, $sqliteDef, $mysqlDef]) {
            if ($this->hasColumn($table, $column)) {
                continue;
            }
            $def = $this->driver === 'mysql' ? $mysqlDef : $sqliteDef;
            $this->pdo->exec("ALTER TABLE {$table} ADD COLUMN {$column} {$def}");
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
            if ($this->driver === 'mysql') {
                $this->pdo->exec('CREATE UNIQUE INDEX uq_recent_user_path ON recent_files (user_id, mount, path(191))');
            } else {
                $this->pdo->exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_recent_user_path ON recent_files (user_id, mount, path)');
            }
        }

        // Adapter/protocol lists gained 's3'. Existing databases carry a CHECK
        // constraint that would reject it, so widen those in place.
        $this->widenEnum('mounts', 'adapter', ['local', 'ftp', 'ftps', 'sftp', 'smb', 'http', 's3']);
        $this->widenEnum('connections', 'protocol', ['ftp', 'ftps', 'sftp', 'smb', 'http', 's3']);

        $indexes = [
            ['idx_mounts_owner', 'CREATE INDEX idx_mounts_owner ON mounts (owner_user_id)', 'CREATE INDEX idx_mounts_owner ON mounts (owner_user_id)'],
            ['idx_shares_user', 'CREATE INDEX idx_shares_user ON shares (user_id)', 'CREATE INDEX idx_shares_user ON shares (user_id)'],
            ['idx_shares_lookup', 'CREATE INDEX idx_shares_lookup ON shares (token_hash)', 'CREATE INDEX idx_shares_lookup ON shares (token_hash)'],
        ];
        foreach ($indexes as [$name, $sqliteSql, $mysqlSql]) {
            if ($this->hasIndex($name)) {
                continue;
            }
            try {
                $this->pdo->exec($this->driver === 'mysql' ? $mysqlSql : $sqliteSql);
            } catch (PDOException $e) {
                // A missing table here just means the schema run above didn't
                // create it yet; the next migrate() call will pick it up.
                error_log('[ansnew] index ' . $name . ' deferred: ' . $e->getMessage());
            }
        }
    }

    /**
     * Widen a CHECK / ENUM constraint so it accepts new values.
     *
     * SQLite cannot alter a CHECK constraint in place, so the table is rebuilt
     * with SQLite's documented procedure (create-new → copy → drop → rename)
     * with foreign keys temporarily disabled. MySQL can MODIFY the ENUM directly.
     *
     * @param string[] $values the complete, final list of allowed values
     */
    private function widenEnum(string $table, string $column, array $values): void
    {
        if ($this->driver === 'mysql') {
            $list = implode(',', array_map(static fn (string $v): string => "'" . $v . "'", $values));
            try {
                $this->pdo->exec("ALTER TABLE {$table} MODIFY COLUMN {$column} ENUM({$list}) NOT NULL");
            } catch (PDOException $e) {
                error_log('[ansnew] enum widen failed for ' . $table . '.' . $column . ': ' . $e->getMessage());
            }
            return;
        }

        $sql = (string) $this->scalar(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = :t",
            [':t' => $table]
        );
        if ($sql === '') {
            return;
        }
        // The pattern must swallow the CHECK's own closing paren as well as the
        // IN(...) one, otherwise the replacement leaves an extra ")" behind and
        // the rebuilt table fails to parse.
        $checkRe = '/CHECK\s*\(\s*' . preg_quote($column, '/') . '\s+IN\s*\(([^)]*)\)\s*\)/i';
        if (preg_match($checkRe, $sql, $m) !== 1) {
            return;   // no CHECK on this column — nothing to widen
        }
        foreach ($values as $v) {
            if (!str_contains($m[1], "'" . $v . "'")) {
                // At least one value is missing, so a rebuild is needed.
                $list = implode(',', array_map(static fn (string $x): string => "'" . $x . "'", $values));
                $rebuilt = preg_replace($checkRe, "CHECK ({$column} IN ({$list}))", $sql, 1) ?? $sql;
                $rebuilt = preg_replace(
                    '/^(\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)' . preg_quote($table, '/') . '\b/i',
                    '$1' . $table . '__new',
                    $rebuilt,
                    1
                ) ?? $rebuilt;

                $indexes = $this->all(
                    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = :t AND sql IS NOT NULL",
                    [':t' => $table]
                );

                // PRAGMA foreign_keys is a no-op inside a transaction, so it has
                // to be toggled outside. With it off, the later RENAME leaves
                // other tables' REFERENCES clauses pointing at `$table`.
                $this->pdo->exec('PRAGMA foreign_keys = OFF');
                try {
                    $this->pdo->exec('DROP TABLE IF EXISTS ' . $table . '__new');
                    $this->pdo->exec('BEGIN');
                    $this->pdo->exec($rebuilt);
                    $this->pdo->exec("INSERT INTO {$table}__new SELECT * FROM {$table}");
                    $this->pdo->exec("DROP TABLE {$table}");
                    $this->pdo->exec("ALTER TABLE {$table}__new RENAME TO {$table}");
                    foreach ($indexes as $idx) {
                        try {
                            $this->pdo->exec((string) $idx['sql']);
                        } catch (PDOException $e) {
                            // Auto-indexes cannot be recreated by hand; skip them.
                        }
                    }
                    $this->pdo->exec('COMMIT');
                } catch (\Throwable $e) {
                    $this->pdo->exec('ROLLBACK');
                    $this->pdo->exec('PRAGMA foreign_keys = ON');
                    error_log('[ansnew] table rebuild failed for ' . $table . ': ' . $e->getMessage());
                    throw $e;
                }
                $this->pdo->exec('PRAGMA foreign_keys = ON');
                return;
            }
        }
    }

    private function hasColumn(string $table, string $column): bool
    {
        if ($this->driver === 'mysql') {
            return (int) $this->scalar(
                'SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_schema = DATABASE() AND table_name = :t AND column_name = :c',
                [':t' => $table, ':c' => $column]
            ) > 0;
        }
        foreach ($this->all('PRAGMA table_info(' . $table . ')') as $row) {
            if (($row['name'] ?? '') === $column) {
                return true;
            }
        }
        return false;
    }

    private function hasIndex(string $name): bool
    {
        if ($this->driver === 'mysql') {
            return (int) $this->scalar(
                'SELECT COUNT(*) FROM information_schema.statistics
                 WHERE table_schema = DATABASE() AND index_name = :n',
                [':n' => $name]
            ) > 0;
        }
        return (int) $this->scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = :n",
            [':n' => $name]
        ) > 0;
    }
}
