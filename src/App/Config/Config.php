<?php

declare(strict_types=1);

namespace App\Config;

/**
 * Environment-first configuration with data-dir fallbacks for generated secrets.
 */
final class Config
{
    private static ?Config $instance = null;

    /** @var array<string,string> */
    private array $values;

    private string $dataDir;

    /** Per-process key caches — these are read on hot paths (every chunk). */
    private ?string $appKeyCache = null;
    private ?string $fileKeyCache = null;

    private function __construct()
    {
        $this->dataDir = getenv('ANSNEW_DATA_DIR') ?: '/var/www/data';
        $this->values = [];

        // Load optional .env file (docker compose already injects env vars;
        // this supports bare-metal runs).
        $envFile = dirname(__DIR__, 3) . '/.env';
        if (is_readable($envFile)) {
            foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $line = trim($line);
                if ($line === '' || str_starts_with($line, '#')) {
                    continue;
                }
                $eq = strpos($line, '=');
                if ($eq === false) {
                    continue;
                }
                $k = trim(substr($line, 0, $eq));
                $v = trim(substr($line, $eq + 1));
                $v = trim($v, "\"'");
                if ($k !== '' && getenv($k) === false) {
                    putenv("$k=$v");
                }
            }
        }

        foreach ([
            'APP_URL', 'APP_ENV', 'DB_DRIVER', 'DB_DATABASE', 'DB_HOST', 'DB_PORT',
            'DB_USER', 'DB_PASSWORD', 'DB_NAME', 'SESSION_LIFETIME', 'IDLE_TIMEOUT',
            'UPLOAD_MAX_BYTES', 'CHUNK_SIZE', 'UPLOAD_TMP_DIR', 'RATE_LIMIT_REQUESTS',
            'RATE_LIMIT_WINDOW', 'LOGIN_MAX_ATTEMPTS', 'LOGIN_LOCKOUT_BASE',
            'LOGIN_LOCKOUT_MAX', 'TRASH_ENABLED', 'TRASH_RETENTION_DAYS',
            'SSRF_ALLOW_PRIVATE', 'SSRF_ALLOWLIST', 'WS_INTERNAL_URL', 'SESSION_SECURE_COOKIE',
        ] as $key) {
            $val = getenv($key);
            if ($val !== false) {
                $this->values[$key] = $val;
            }
        }
    }

    public static function i(): Config
    {
        return self::$instance ??= new self();
    }

    public function get(string $key, string $default = ''): string
    {
        return $this->values[$key] ?? $default;
    }

    public function getInt(string $key, int $default): int
    {
        $v = $this->values[$key] ?? null;
        return $v !== null && $v !== '' ? (int) $v : $default;
    }

    public function getBool(string $key, bool $default): bool
    {
        $v = $this->values[$key] ?? null;
        if ($v === null || $v === '') {
            return $default;
        }
        return in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
    }

    public function dataDir(): string
    {
        return $this->dataDir;
    }

    public function storageRoot(): string
    {
        return getenv('ANSNEW_STORAGE_ROOT') ?: '/srv/storage';
    }

    /**
     * Master AES key for stored secrets (hex, 64 chars).
     * Reads data/keys/app.key, creating it on first use. Cached per process —
     * this used to re-read and re-validate the file on every single call.
     */
    public function appKey(): string
    {
        if ($this->appKeyCache !== null) {
            return $this->appKeyCache;
        }
        return $this->appKeyCache = $this->loadOrCreateKey(
            $this->dataDir . '/keys/app.key',
            'APP_KEY',
            0660
        );
    }

    /**
     * Master AES key for file-content encryption (hex, 64 chars).
     *
     * Deliberately separate from APP_KEY: that one protects remote-connection
     * secrets and has a different rotation/escrow lifecycle. Separation limits
     * the blast radius of losing either key.
     */
    public function fileKey(): string
    {
        if ($this->fileKeyCache !== null) {
            return $this->fileKeyCache;
        }
        return $this->fileKeyCache = $this->loadOrCreateKey(
            $this->dataDir . '/keys/file.key',
            'ANSNEW_FILE_KEY',
            0660
        );
    }

    /** Identifies which master key wrapped a file's data key (rotation hook). */
    public function fileKeyId(): int
    {
        $id = $this->getInt('ANSNEW_FILE_KEY_ID', 1);
        return $id > 0 && $id < 65536 ? $id : 1;
    }

    /** True when at-rest file encryption is enabled for local mounts. */
    public function encryptLocalEnabled(): bool
    {
        return $this->getBool('ANSNEW_ENCRYPT_LOCAL', true);
    }

    /** Drop cached keys (key rotation / CLI tooling). */
    public function forgetKeys(): void
    {
        $this->appKeyCache = null;
        $this->fileKeyCache = null;
    }

    private function loadOrCreateKey(string $file, string $envName, int $mode): string
    {
        $env = $this->get($envName);
        if ($env !== '' && preg_match('/^[0-9a-f]{64}$/', $env) === 1) {
            return $env;
        }
        if (is_readable($file)) {
            $key = trim((string) file_get_contents($file));
            if (preg_match('/^[0-9a-f]{64}$/', $key) === 1) {
                return $key;
            }
        }
        if (!is_dir(dirname($file))) {
            @mkdir(dirname($file), 0770, true);
        }
        $key = bin2hex(random_bytes(32));
        file_put_contents($file, $key . "\n");
        @chmod($file, $mode);
        return $key;
    }

    public function wsSecret(): string
    {
        $env = $this->get('WS_SECRET');
        if ($env !== '') {
            return $env;
        }
        $file = $this->dataDir . '/keys/ws.secret';
        if (is_readable($file)) {
            $s = trim((string) file_get_contents($file));
            if ($s !== '') {
                return $s;
            }
        }
        if (!is_dir(dirname($file))) {
            @mkdir(dirname($file), 0770, true);
        }
        $s = bin2hex(random_bytes(32));
        file_put_contents($file, $s . "\n");
        // 0644: the ws container (node, UID 82) mounts this data volume
        // read-only and must read this secret; the volume never leaves the
        // trusted app containers (nginx blocks /data/).
        @chmod($file, 0644);
        return $s;
    }
}
