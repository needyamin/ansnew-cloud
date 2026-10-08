<?php

declare(strict_types=1);

/**
 * ANSNEW CLOUD console: migrations + admin bootstrap.
 * Usage: php bin/console.php ansnew:migrate|ansnew:bootstrap-admin
 */

use App\Config\Config;
use App\Core\Database;
use App\Services\EncryptionMigrationService;
use App\Services\UserService;
use App\Storage\Encryption\FileCipher;

require dirname(__DIR__) . '/vendor/autoload.php';

Config::i();

$cmd = $argv[1] ?? '';

switch ($cmd) {
    case 'ansnew:migrate':
        Database::i()->migrate();
        echo "[ansnew] migrations applied\n";
        break;

    case 'ansnew:bootstrap-admin':
        bootstrapAdmin();
        break;

    case 'ansnew:seed-mounts':
        seedDefaultMount();
        break;

    case 'ansnew:crypto-status':
        cryptoStatus(in_array('--scan', $argv, true));
        break;

    case 'ansnew:reset-password':
        resetPassword($argv);
        break;

    case 'ansnew:encrypt-existing':
        encryptExisting($argv);
        break;

    case 'ansnew:backup':
        backup($argv);
        break;

    case 'ansnew:db-check':
        dbCheck();
        break;

    case 'ansnew:restore':
        restore($argv);
        break;

    default:
        fwrite(STDERR, "Usage: php bin/console.php <command>\n");
        fwrite(STDERR, "  ansnew:migrate\n");
        fwrite(STDERR, "  ansnew:bootstrap-admin\n");
        fwrite(STDERR, "  ansnew:seed-mounts\n");
        fwrite(STDERR, "  ansnew:reset-password [--user=NAME] [--password=VALUE] [--random]\n");
        fwrite(STDERR, "  ansnew:crypto-status [--scan]\n");
        fwrite(STDERR, "  ansnew:encrypt-existing [--mount=NAME] [--dry-run] [--limit=N]\n");
        fwrite(STDERR, "  ansnew:backup [--out=DIR] [--no-config]\n");
        fwrite(STDERR, "  ansnew:db-check\n");
        fwrite(STDERR, "  ansnew:restore --from=DIR --yes\n");
        exit(1);
}

/**
 * Snapshot everything needed to rebuild this instance: the SQLite database, the
 * master keys, and (optionally) .env.
 *
 * The UI's "Backup" feature copies drive CONTENTS; it never captured the
 * database or the encryption keys. So losing the data volume meant losing every
 * user, share and setting — and losing file.key meant every encrypted file
 * became permanently unreadable. This is the missing half. See
 * docs/BACKUP-RESTORE.md.
 */
function backup(array $argv): void
{
    $out = Config::i()->get('ANSNEW_BACKUP_DIR', '/var/www/data/backups');
    $includeEnv = true;
    foreach ($argv as $a) {
        if (str_starts_with($a, '--out=')) {
            $out = substr($a, 6);
        } elseif ($a === '--no-config') {
            $includeEnv = false;
        }
    }

    $dir = rtrim($out, '/') . '/ansnew-backup-' . gmdate('Ymd-His');
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        fwrite(STDERR, "[ansnew] cannot create {$dir}\n");
        exit(1);
    }
    @chmod($dir, 0700);

    $db = Database::i();
    $driver = Config::i()->get('DB_DRIVER', 'sqlite');
    $dbFile = $dir . '/ansnew.sqlite';

    if ($driver === 'sqlite') {
        // VACUUM INTO is WAL-safe and needs no downtime; it also compacts.
        // The path is operator-supplied, so escape it rather than interpolating.
        try {
            $db->run("VACUUM INTO '" . str_replace("'", "''", $dbFile) . "'");
        } catch (\Throwable $e) {
            fwrite(STDERR, '[ansnew] VACUUM INTO failed (' . $e->getMessage() . "), falling back to a copy\n");
            $live = (string) Config::i()->get('DB_DATABASE', Config::i()->dataDir() . '/ansnew.sqlite');
            if (!@copy($live, $dbFile)) {
                fwrite(STDERR, "[ansnew] cannot copy the database\n");
                exit(1);
            }
        }
        // Never report success on a snapshot that is not readable.
        try {
            $check = new PDO('sqlite:' . $dbFile);
            $res = $check->query('PRAGMA integrity_check')->fetchColumn();
        } catch (\Throwable $e) {
            $res = 'error: ' . $e->getMessage();
        }
        if ($res !== 'ok') {
            fwrite(STDERR, "[ansnew] snapshot failed integrity_check: {$res}\n");
            exit(1);
        }
    } else {
        fwrite(STDERR, "[ansnew] DB_DRIVER={$driver}: dump it with mysqldump (see docs/BACKUP-RESTORE.md)\n");
    }

    // Master keys — losing file.key makes every encrypted local file unreadable.
    $keysOut = $dir . '/keys';
    @mkdir($keysOut, 0700, true);
    $keyCount = 0;
    foreach (glob(Config::i()->dataDir() . '/keys/*') ?: [] as $k) {
        if (is_file($k) && @copy($k, $keysOut . '/' . basename($k))) {
            @chmod($keysOut . '/' . basename($k), 0600);
            $keyCount++;
        }
    }

    // .env holds the deployment's secrets, so it is included but locked down.
    $envNote = 'excluded';
    if ($includeEnv) {
        $env = dirname(__DIR__) . '/.env';
        if (is_file($env) && @copy($env, $dir . '/env.txt')) {
            @chmod($dir . '/env.txt', 0600);
            $envNote = 'included (env.txt)';
        }
    }

    file_put_contents($dir . '/MANIFEST.txt', implode("\n", [
        'ANSNEW CLOUD backup',
        'created: ' . gmdate('c'),
        'database: ' . ($driver === 'sqlite' && is_file($dbFile)
            ? 'ansnew.sqlite (' . filesize($dbFile) . ' bytes)'
            : $driver . ' (dump separately)'),
        'keys: ' . $keyCount . ' file(s)',
        'config: ' . $envNote,
        '',
        'Restore: docs/BACKUP-RESTORE.md',
    ]) . "\n");

    echo "[ansnew] backup written to {$dir}\n";
    echo '  keys: ' . $keyCount . "\n";
    echo "  WARNING: this contains your master keys and .env — store it encrypted, off-box.\n";
}

function dbCheck(): void
{
    $driver = Config::i()->get('DB_DRIVER', 'sqlite');
    if ($driver !== 'sqlite') {
        echo "[ansnew] DB_DRIVER={$driver}: integrity_check is SQLite-only\n";
        return;
    }
    $res = Database::i()->scalar('PRAGMA integrity_check');
    echo "[ansnew] integrity_check: {$res}\n";
    if ($res !== 'ok') {
        exit(1);
    }
}

/**
 * Restore a database + key snapshot produced by `ansnew:backup`.
 *
 * Destructive and irreversible, so it demands --yes and refuses to run while a
 * job is in flight (the worker would be writing to the file being replaced).
 */
function restore(array $argv): void
{
    $from = '';
    $yes = false;
    foreach ($argv as $a) {
        if (str_starts_with($a, '--from=')) {
            $from = rtrim(substr($a, 7), '/');
        } elseif ($a === '--yes') {
            $yes = true;
        }
    }
    if ($from === '' || !is_dir($from)) {
        fwrite(STDERR, "Usage: ansnew:restore --from=<backup dir> --yes\n");
        exit(1);
    }
    if (!$yes) {
        fwrite(STDERR, "[ansnew] refusing to overwrite the live database without --yes\n");
        exit(1);
    }

    $dbFile = $from . '/ansnew.sqlite';
    if (!is_file($dbFile)) {
        fwrite(STDERR, "[ansnew] no ansnew.sqlite in {$from}\n");
        exit(1);
    }

    $running = (int) Database::i()->scalar("SELECT COUNT(*) FROM jobs WHERE status = 'running'");
    if ($running > 0) {
        fwrite(STDERR, "[ansnew] {$running} job(s) still running — stop the worker first\n");
        exit(1);
    }

    $target = (string) Config::i()->get('DB_DATABASE', Config::i()->dataDir() . '/ansnew.sqlite');
    if (!@copy($dbFile, $target)) {
        fwrite(STDERR, "[ansnew] cannot write {$target}\n");
        exit(1);
    }
    // Drop stale WAL/SHM so the restored file is authoritative.
    @unlink($target . '-wal');
    @unlink($target . '-shm');
    echo "[ansnew] database restored from {$dbFile}\n";

    $keysFrom = $from . '/keys';
    if (is_dir($keysFrom)) {
        $keysTo = Config::i()->dataDir() . '/keys';
        @mkdir($keysTo, 0770, true);
        $n = 0;
        foreach (glob($keysFrom . '/*') ?: [] as $k) {
            if (is_file($k) && @copy($k, $keysTo . '/' . basename($k))) {
                $n++;
            }
        }
        echo "[ansnew] {$n} master key(s) restored\n";
    }

    echo "[ansnew] now restart the stack: docker compose restart php worker\n";
}

/**
 * Set a user's password from the CLI.
 *
 * The first-boot credential is printed exactly once, so this is the recovery
 * path when it has been lost. Defaults to generating a random password so no
 * secret ends up in shell history.
 */
function resetPassword(array $argv): void
{
    $username = 'admin';
    $password = '';
    $explicit = false;
    foreach ($argv as $a) {
        if (str_starts_with($a, '--user=')) {
            $username = substr($a, 7);
        } elseif (str_starts_with($a, '--password=')) {
            $password = substr($a, 11);
            $explicit = true;
        }
    }

    $db = Database::i();
    $row = $db->one('SELECT id, username FROM users WHERE username = :u', [':u' => strtolower($username)]);
    if ($row === null) {
        fwrite(STDERR, "[ansnew] no such user: {$username}\n");
        $all = $db->all('SELECT username FROM users ORDER BY username');
        if ($all !== []) {
            fwrite(STDERR, '[ansnew] known users: ' . implode(', ', array_column($all, 'username')) . "\n");
        }
        exit(1);
    }

    if (!$explicit) {
        $password = bin2hex(random_bytes(12));
    }

    try {
        UserService::updatePassword((int) $row['id'], $password);
    } catch (\Throwable $e) {
        fwrite(STDERR, '[ansnew] ' . $e->getMessage() . "\n");
        exit(1);
    }

    echo "[ansnew] password updated for '{$row['username']}'\n";
    if (!$explicit) {
        echo "[ansnew] new password (store it now): {$password}\n";
    } else {
        echo "[ansnew] note: --password puts the secret in your shell history; prefer the random form\n";
    }
    $min = Config::i()->getInt('PASSWORD_MIN_LENGTH', 10);
    if (strlen($password) < $min) {
        echo "[ansnew] warning: password is shorter than the configured minimum ({$min} characters)\n";
    }
}

/**
 * Report the state of at-rest encryption: key presence, fingerprint and
 * (optionally) how many files are still plaintext.
 */
function cryptoStatus(bool $scan): void
{
    $config = Config::i();
    $enabled = $config->encryptLocalEnabled();

    $keyFile = $config->dataDir() . '/keys/file.key';
    $keyExists = is_readable($keyFile) || $config->get('ANSNEW_FILE_KEY') !== '';
    $key = null;
    $fp = '(none)';
    try {
        $key = $config->fileKey();
        $fp = substr(hash('sha256', $key), 0, 16);
    } catch (\Throwable $e) {
        echo "[ansnew] cannot load file key: {$e->getMessage()}\n";
    }

    printf("[ansnew] file encryption : %s\n", $enabled ? 'ENABLED' : 'disabled');
    printf("[ansnew] key file        : %s (%s)\n", $keyFile, $keyExists ? 'present' : 'MISSING');
    printf("[ansnew] key id          : %d\n", $config->fileKeyId());
    printf("[ansnew] key fingerprint : %s\n", $fp);

    if (!$scan) {
        return;
    }

    $inv = EncryptionMigrationService::inventory();
    $plaintext = 0;
    foreach ($inv as $mount => $row) {
        printf("[ansnew]   %-16s encrypted=%-6d plaintext=%-6d (%s still plaintext)\n",
            $mount, $row['encrypted'], $row['plaintext'], number_format($row['bytes']));
        $plaintext += $row['plaintext'];
    }

    // Exit non-zero when the key is unusable but encrypted data exists — a
    // cheap safety net for ops.
    $encrypted = array_sum(array_column($inv, 'encrypted'));
    if ($encrypted > 0 && $key === null) {
        fwrite(STDERR, "[ansnew] FAIL: encrypted files exist but the key cannot be loaded\n");
        exit(2);
    }
    if ($plaintext > 0) {
        echo "[ansnew] {$plaintext} file(s) are still plaintext — run ansnew:encrypt-existing\n";
    }
}

/** Backfill: encrypt files that predate the encryption feature. */
function encryptExisting(array $argv): void
{
    $dryRun = in_array('--dry-run', $argv, true);
    $limit = null;
    $mount = null;
    foreach ($argv as $a) {
        if (str_starts_with($a, '--limit=')) {
            $limit = max(1, (int) substr($a, 8));
        } elseif (str_starts_with($a, '--mount=')) {
            $mount = substr($a, 8);
        }
    }

    if (!Config::i()->encryptLocalEnabled()) {
        fwrite(STDERR, "[ansnew] file encryption is disabled (ANSNEW_ENCRYPT_LOCAL=0); nothing to do\n");
        exit(1);
    }

    echo $dryRun ? "[ansnew] DRY RUN — no files will be modified\n" : "[ansnew] encrypting existing files in place\n";
    echo "[ansnew] stop the worker first (docker compose stop worker) to avoid a job writing plaintext mid-run\n";

    $log = static function (string $m): void { echo '[ansnew] ' . $m . "\n"; };
    $stats = EncryptionMigrationService::run($log, $dryRun, $limit, $mount);

    printf(
        "[ansnew] scanned=%d encrypted=%d skipped=%d failed=%d (%s)\n",
        $stats['scanned'], $stats['encrypted'], $stats['skipped'], $stats['failed'],
        number_format($stats['bytes']) . ' bytes'
    );
    if ($stats['stopped']) {
        echo "[ansnew] run stopped early — rerun the command to continue\n";
    }
    if ($stats['failed'] > 0) {
        exit(1);
    }
}

function bootstrapAdmin(): void
{
    $db = Database::i();
    $config = Config::i();
    $username = $config->get('ADMIN_USER', 'admin');
    $row = $db->one('SELECT id FROM users WHERE username = :u', [':u' => strtolower($username)]);
    if ($row !== null) {
        echo "[ansnew] admin '{$username}' already exists\n";
        return;
    }

    // Taken from ADMIN_PASSWORD env; when unset a random one is generated.
    $credential = $config->get('ADMIN_PASSWORD', '');
    $generated = false;
    if ($credential === '') {
        $credential = bin2hex(random_bytes(12));
        $generated = true;
    }

    UserService::create($username, $credential, 'admin', 'Administrator', $config->get('ADMIN_EMAIL', ''));
    echo "[ansnew] admin '{$username}' created\n";
    if ($generated) {
        echo "[ansnew] random admin credential (shown once, store it now): {$credential}\n";
    }
}

/**
 * Seed the default local storage mount that mirrors the bind mount declared in
 * docker-compose.yml (${STORAGE_HOST_PATH} -> /srv/storage/local). Without it a
 * fresh install has zero mounts and the file manager has nothing to browse, so
 * the stack would come up "healthy" yet unusable.
 *
 * Idempotent: no-op once a mount named `local` exists.
 */
function seedDefaultMount(): void
{
    $db = Database::i();
    $config = Config::i();

    if ($db->one('SELECT id FROM mounts WHERE name = :n', [':n' => 'local']) !== null) {
        echo "[ansnew] default mount 'local' already exists\n";
        return;
    }

    $root = rtrim((string) $config->get('DEFAULT_MOUNT_PATH', '/srv/storage/local'), '/');
    if ($root === '') {
        $root = '/srv/storage/local';
    }

    $adminId = $db->scalar('SELECT id FROM users WHERE role = :r ORDER BY id LIMIT 1', [':r' => 'admin']);
    if ($adminId === null || $adminId === false) {
        echo "[ansnew] no admin user yet; default mount deferred\n";
        return;
    }

    $db->run(
        'INSERT INTO mounts (name, label, adapter, local_root, remote_path, quota_bytes,
                             is_readonly, is_visible_all, trash_enabled, created_by)
         VALUES (:n, :l, :a, :lr, :rp, 0, 0, 1, 1, :cb)',
        [
            ':n'  => 'local',
            ':l'  => (string) $config->get('DEFAULT_MOUNT_LABEL', 'Local Storage'),
            ':a'  => 'local',
            ':lr' => $root,
            ':rp' => '/',
            ':cb' => (int) $adminId,
        ]
    );

    echo "[ansnew] default mount 'local' -> {$root} created\n";
}