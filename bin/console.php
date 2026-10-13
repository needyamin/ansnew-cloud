<?php

declare(strict_types=1);

/**
 * ANSNEW CLOUD console: migrations, admin bootstrap, crypto tooling.
 * Usage: php bin/console.php <command>
 */

use App\Config\Config;
use App\Core\Database;
use App\Services\EncryptionMigrationService;
use App\Services\UserService;

// Zero-dependency autoloader (no composer required).
spl_autoload_register(static function (string $class): void {
    $prefix = 'App\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $rel = str_replace('\\', '/', substr($class, strlen($prefix)));
    $file = dirname(__DIR__) . '/src/App/' . $rel . '.php';
    if (is_file($file)) {
        require $file;
    }
});

Config::i();

$cmd = $argv[1] ?? '';

switch ($cmd) {
    case 'ansnew:migrate':
        Database::i()->migrate();
        echo "[ansnew] migrations applied\n";
        break;

    case 'ansnew:bootstrap-admin':
        bootstrapAdmin(in_array('--force', $argv, true));
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

    case 'ansnew:db-check':
        dbCheck();
        break;

    default:
        fwrite(STDERR, "Usage: php bin/console.php <command>\n");
        fwrite(STDERR, "  ansnew:migrate\n");
        fwrite(STDERR, "  ansnew:bootstrap-admin [--force]\n");
        fwrite(STDERR, "  ansnew:seed-mounts\n");
        fwrite(STDERR, "  ansnew:reset-password [--user=NAME] [--password=VALUE] [--force]\n");
        fwrite(STDERR, "  ansnew:crypto-status [--scan]\n");
        fwrite(STDERR, "  ansnew:encrypt-existing [--mount=NAME] [--dry-run] [--limit=N]\n");
        fwrite(STDERR, "  ansnew:db-check\n");
        exit(1);
}

function dbCheck(): void
{
    $res = Database::i()->scalar('PRAGMA integrity_check');
    echo "[ansnew] integrity_check: {$res}\n";
    if ($res !== 'ok') {
        exit(1);
    }
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
    $force = false;
    foreach ($argv as $a) {
        if (str_starts_with($a, '--user=')) {
            $username = substr($a, 7);
        } elseif (str_starts_with($a, '--password=')) {
            $password = substr($a, 11);
            $explicit = true;
        } elseif ($a === '--force') {
            $force = true;
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
        UserService::updatePassword((int) $row['id'], $password, !$force);
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

/**
 * Create the first admin.
 *
 * ADMIN_PASSWORD from .env is accepted, but the password policy is enforced
 * (pass --force to override deliberately) and the account is always created
 * with must_change_pw=1, so a deployment that ships a credential forces a
 * change at first sign-in instead of running on it forever.
 */
function bootstrapAdmin(bool $force): void
{
    $db = Database::i();
    $config = Config::i();
    $username = $config->get('ADMIN_USER', 'admin');
    $row = $db->one('SELECT id FROM users WHERE username = :u', [':u' => strtolower($username)]);
    if ($row !== null) {
        echo "[ansnew] admin '{$username}' already exists\n";
        return;
    }

    // When ADMIN_PASSWORD is unset the out-of-the-box default is 'admin'.
    // An explicit ADMIN_PASSWORD from the environment is still validated
    // against the password policy (pass --force to override); the built-in
    // 'admin' default is intentionally weak, so it bypasses the check because
    // a change is forced at first sign-in and must never linger in use.
    $credential = $config->get('ADMIN_PASSWORD', '');
    $explicit = $credential !== '';
    if ($credential === '') {
        $credential = 'admin';
    }

    try {
        UserService::create($username, $credential, 'admin', 'Administrator', $config->get('ADMIN_EMAIL', ''), !$explicit);
    } catch (\InvalidArgumentException $e) {
        if (!$force) {
            fwrite(STDERR, "[ansnew] ADMIN_PASSWORD rejected by the password policy: {$e->getMessage()}\n");
            fwrite(STDERR, "[ansnew] set a stronger ADMIN_PASSWORD, or re-run with --force to accept it anyway.\n");
            exit(1);
        }
        UserService::create($username, $credential, 'admin', 'Administrator', $config->get('ADMIN_EMAIL', ''), false);
        fwrite(STDERR, "[ansnew] WARNING: weak ADMIN_PASSWORD accepted because --force was given.\n");
    }

    // A credential that arrived from the environment is not a secret the
    // operator typed interactively — force a change at first login. The built-in
    // 'admin' default likewise forces a change so it never lingers in use.
    $db->run('UPDATE users SET must_change_pw = 1 WHERE username = :u', [':u' => strtolower($username)]);

    echo "[ansnew] admin '{$username}' created\n";
    if ($explicit) {
        echo "[ansnew] note: admin was created from ADMIN_PASSWORD in the environment\n";
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
        'INSERT INTO mounts (name, label, adapter, local_root, quota_bytes,
                             is_readonly, is_visible_all, trash_enabled, created_by)
         VALUES (:n, :l, :a, :lr, 0, 0, 1, 1, :cb)',
        [
            ':n'  => 'local',
            ':l'  => (string) $config->get('DEFAULT_MOUNT_LABEL', 'Local Storage'),
            ':a'  => 'local',
            ':lr' => $root,
            ':cb' => (int) $adminId,
        ]
    );

    echo "[ansnew] default mount 'local' -> {$root} created\n";
}
