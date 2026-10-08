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

    /**
     * A mount's contents changed: flag its cached usage as stale and queue a
     * re-scan so the figure self-corrects.
     *
     * Usage is a *snapshot* cached in `settings` (written by scan() through the
     * `du` job). Nothing used to invalidate it, so after a delete or upload the
     * sidebar kept reporting the old size indefinitely — the number only ever
     * changed if the user manually re-scanned.
     *
     * The cached figure is kept (so the sidebar does not flash to "Not
     * scanned"); it is only flagged, and the re-scan replaces it.
     */
    public static function invalidate(string $mountName, int $userId = 0): void
    {
        if ($mountName === '') {
            return;
        }
        $db = Database::i();
        $raw = $db->scalar('SELECT v FROM settings WHERE k = :k', [':k' => 'usage:' . $mountName]);

        // Never measured: nothing to invalidate. The first browse kicks off a
        // scan (see ensureDriveUsage in main.js); we do not want every mutation
        // on an unmeasured mount to spawn a full remote listing.
        if ($raw === null) {
            return;
        }
        $data = json_decode((string) $raw, true);
        if (is_array($data) && empty($data['stale'])) {
            $data['stale'] = true;
            $db->run(
                'UPDATE settings SET v = :v, updated_at = datetime(\'now\') WHERE k = :k',
                [':k' => 'usage:' . $mountName, ':v' => json_encode($data, JSON_UNESCAPED_UNICODE) ?: '{}']
            );
        }
        self::requestRescan($mountName, $userId, false);
    }

    /**
     * Queue a `du` re-scan for one mount.
     *
     * Deduplicated (a queued/running scan for the same mount already covers us)
     * and throttled, because one batch operation emits many fs.changed events
     * and a full remote listing is not free.
     *
     * @param bool $force skip the throttle (an explicit user-triggered rescan)
     * @return string|null the queued job id, or null when one was already pending
     */
    public static function requestRescan(string $mountName, int $userId = 0, bool $force = false): ?string
    {
        if ($mountName === '') {
            return null;
        }
        $db = Database::i();

        // Dedup: match on the mount name inside the stored params JSON. Mount
        // names are [A-Za-z0-9_-] (validated at creation), so this LIKE is safe.
        $pending = (int) $db->scalar(
            "SELECT COUNT(*) FROM jobs
              WHERE type = 'du' AND status IN ('queued','running') AND params LIKE :p",
            [':p' => '%"mount":"' . $mountName . '"%']
        );
        if ($pending > 0) {
            return null;
        }

        $key = 'usage_req:' . $mountName;
        $window = \App\Config\Config::i()->getInt('USAGE_RESCAN_DEBOUNCE', 30);
        if (!$force && $window > 0) {
            $last = (int) $db->scalar('SELECT v FROM settings WHERE k = :k', [':k' => $key]);
            if ($last > 0 && (time() - $last) < $window) {
                return null;
            }
        }

        try {
            $jobId = JobService::enqueue($userId, 'du', ['mount' => $mountName, 'userId' => $userId]);
        } catch (Throwable $e) {
            error_log('[ansnew] usage rescan enqueue failed: ' . $e->getMessage());
            return null;
        }
        $db->run(
            'INSERT INTO settings (k, v, updated_at) VALUES (:k, :v, datetime(\'now\'))
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime(\'now\')',
            [':k' => $key, ':v' => (string) time()]
        );
        return $jobId;
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
