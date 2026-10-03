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
    }
}
