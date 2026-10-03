<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Jobs\Handlers\AbstractHandler;
use App\Storage\StorageManager;
use RuntimeException;
use Throwable;

/**
 * Storage usage scanning (background job) + cached usage reporting.
 */
final class UsageService
{
    /**
     * Full recursive scan of a mount, cached in the settings table.
     * @param callable(int,string):void $progress
     * @return array<string,mixed>
     */
    public static function scan(int $userId, string $mountName, callable $progress): array
    {
        $user = AbstractHandler::userById($userId);
        [, $adapter] = StorageManager::resolve($user, $mountName, '/');

        $progress(10, 'Scanning ' . $mountName);
        $du = $adapter->du('/');

        $mount = StorageManager::mountFor($user, $mountName);
        $result = [
            'mount' => $mountName,
            'used' => (int) $du['used'],
            'files' => (int) $du['files'],
            'dirs' => (int) $du['dirs'],
            'quotaBytes' => $mount->quotaBytes,
            'quotaPercent' => $mount->quotaBytes > 0 ? (int) min(100, ceil($du['used'] * 100 / $mount->quotaBytes)) : 0,
            'scannedAt' => gmdate('c'),
        ];

        Database::i()->run(
            'INSERT INTO settings (k, v, updated_at) VALUES (:k, :v, datetime(\'now\'))
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime(\'now\')',
            [':k' => 'usage:' . $mountName, ':v' => json_encode($result, JSON_UNESCAPED_UNICODE) ?: '{}']
        );

        $progress(100, 'Scan complete');
        return $result;
    }

    /** Cached usage for all mounts visible to the user (null when never scanned). */
    public static function cached(AuthContext $user): array
    {
        $db = Database::i();
        $out = [];
        foreach (StorageManager::mountsFor($user) as $mount) {
            $raw = $db->scalar('SELECT v FROM settings WHERE k = :k', [':k' => 'usage:' . $mount->name]);
            $data = $raw !== null ? json_decode((string) $raw, true) : null;
            $out[] = [
                'mount' => $mount->name,
                'label' => $mount->label,
                'adapter' => $mount->adapter,
                'quotaBytes' => $mount->quotaBytes,
                'canWrite' => $mount->canWrite,
                'usage' => is_array($data) ? $data : null,
            ];
        }
        return $out;
    }

    /** Aggregate disk usage of the app data dir (logs, trash, db, tmp). */
    public static function dataDirUsage(): int
    {
        $dir = \App\Config\Config::i()->dataDir();
        $total = 0;
        try {
            $it = new \RecursiveIteratorIterator(
                new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
                \RecursiveIteratorIterator::LEAVES_ONLY
            );
            foreach ($it as $f) {
                /** @var \SplFileInfo $f */
                if ($f->isFile()) {
                    $total += $f->getSize();
                }
            }
        } catch (Throwable) {
            // best-effort
        }
        return $total;
    }
}
