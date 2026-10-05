<?php

declare(strict_types=1);

/**
 * NAS inbox watcher.
 *
 * Files dropped into the SMB share land in <DEFAULT_MOUNT_PATH>/_inbox and appear
 * in the file manager immediately (it is the same host bind mount the app lists as
 * the `local` mount). This loop imports them in a serialized, rate-limited queue:
 *   * when at-rest encryption is enabled it encrypts each new file in place
 *     (reusing App\Storage\Encryption\FileCipher),
 *   * the aggregate throughput is capped at NAS_INGEST_MBPS (default 50) so a big
 *     batch can't saturate disk/CPU,
 *   * each import is recorded in nas_inbox (imported exactly once) and audited.
 *
 * Stability: a file is only imported once its size is unchanged between two
 * consecutive scan passes, so a file still being copied over SMB is never
 * half-imported. Run as the `nas-watch` container (reuses the php image).
 */

use App\Config\Config;
use App\Core\Database;
use App\Storage\Encryption\FileCipher;

require dirname(__DIR__) . '/vendor/autoload.php';

Config::i();
$config = Config::i();

$inbox   = rtrim((string) $config->get('DEFAULT_MOUNT_PATH', '/srv/storage/local'), '/') . '/_inbox';
$mbps    = (float) $config->getInt('NAS_INGEST_MBPS', 50);
$bps     = max(1.0, $mbps * 1_000_000.0);
$encrypt = $config->encryptLocalEnabled();

if (!is_dir($inbox)) {
    @mkdir($inbox, 0775, true);
}

echo sprintf(
    "[nas-watch] inbox=%s encrypt=%s cap=%.0f MB/s poll=2s\n",
    $inbox,
    $encrypt ? 'on' : 'off',
    $mbps
);

$seen            = [];   // path => last-seen size (stability buffer)
$processedBytes  = 0;    // bytes accounted for by the rate limiter
$windowStart     = microtime(true);

while (true) {
    try {
        scan($inbox, $seen, $encrypt, $bps, $processedBytes, $windowStart);
    } catch (\Throwable $e) {
        fwrite(STDERR, '[nas-watch] scan error: ' . $e->getMessage() . "\n");
    }
    sleep(2);
}

/**
 * @param array<string,int> $seen
 */
function scan(string $dir, array &$seen, bool $encrypt, float $bps, int &$pb, float &$ws): void
{
    $rii = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::SELF_FIRST
    );

    $current = [];
    foreach ($rii as $item) {
        if ($item->isLink() || !$item->isFile()) {
            continue;
        }
        $path = $item->getPathname();
        $size = (int) $item->getSize();
        $current[$path] = $size;

        if (alreadyImported($path)) {
            unset($seen[$path]);
            continue;
        }

        // Wait until the file size is stable across two passes (still copying).
        if (!isset($seen[$path]) || $seen[$path] !== $size) {
            $seen[$path] = $size;
            continue;
        }

        importFile($path, $size, $encrypt, $bps, $pb, $ws);
        unset($seen[$path]);
    }

    // Drop vanished entries from the stability buffer.
    foreach (array_keys($seen) as $p) {
        if (!isset($current[$p])) {
            unset($seen[$p]);
        }
    }
}

function alreadyImported(string $path): bool
{
    $row = Database::i()->one(
        "SELECT 1 FROM nas_inbox WHERE path = :p AND status IN ('done','error')",
        [':p' => $path]
    );
    return $row !== null;
}

/**
 * @param array<string,int> $seen
 */
function importFile(string $path, int $size, bool $encrypt, float $bps, int &$pb, float &$ws): void
{
    $status = 'done';
    $detail = '';
    $bytes  = $size;

    try {
        if ($encrypt && !FileCipher::isEncrypted($path)) {
            $plain  = FileCipher::encryptFileInPlace($path);
            $bytes  = $plain ?? $size;
            $detail = 'encrypted';
        } else {
            $detail = $encrypt ? 'already-encrypted' : 'stored-clear';
        }
    } catch (\Throwable $e) {
        $status = 'error';
        $detail = substr($e->getMessage(), 0, 200);
        fwrite(STDERR, "[nas-watch] FAILED {$path}: {$detail}\n");
    }

    $db = Database::i();
    if ($db->driver() === 'mysql') {
        $db->run(
            'INSERT INTO nas_inbox (path, size, status, imported_at) VALUES (:p, :s, :st, :t)
             ON DUPLICATE KEY UPDATE size = :s, status = :st, imported_at = :t',
            [':p' => $path, ':s' => $bytes, ':st' => $status, ':t' => time()]
        );
    } else {
        $db->run(
            'INSERT INTO nas_inbox (path, size, status, imported_at) VALUES (:p, :s, :st, :t)
             ON CONFLICT(path) DO UPDATE SET size = :s, status = :st, imported_at = :t',
            [':p' => $path, ':s' => $bytes, ':st' => $status, ':t' => time()]
        );
    }

    $db->run(
        'INSERT INTO audit_log (user_id, username, action, mount, path, target, status, detail)
         VALUES (NULL, :u, :a, :m, :p, :t, :s, :d)',
        [
            ':u' => 'nas', ':a' => 'nas.import', ':m' => 'local', ':p' => $path,
            ':t' => '', ':s' => $status, ':d' => $detail . ' ' . $bytes . 'B',
        ]
    );

    if ($status === 'done') {
        echo sprintf(
            "[nas-watch] imported %s (%d MB, %s)\n",
            $path,
            (int) ($bytes / 1_000_000),
            $detail
        );
    }

    // Rate limit: keep average throughput at or below $bps.
    $pb += $bytes;
    $elapsed = microtime(true) - $ws;
    $allowed = $pb / $bps;
    if ($elapsed < $allowed) {
        $sleep = (int) (($allowed - $elapsed) * 1_000_000);
        if ($sleep > 0) {
            usleep($sleep);
        }
    }
}
