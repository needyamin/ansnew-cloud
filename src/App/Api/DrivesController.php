<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Storage\StorageManager;

/**
 * Real filesystem capacity for local mounts: total / used / free, plus a
 * percentage. This is the "disk" figure the sidebar and This PC show for a
 * local drive (the whole filesystem the storage root lives on).
 *
 * A remote (S3/R2) drive has no filesystem to measure, so its capacity is
 * reported as null — the UI falls back to the cached usage scan of the drive's
 * own contents for those.
 */
final class DrivesController
{
    public static function info(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $drives = [];
        foreach (StorageManager::mountsFor($user) as $m) {
            $capacity = null;
            if ($m->adapter === 'local' && $m->localRoot !== null && @is_dir($m->localRoot)) {
                $total = @disk_total_space($m->localRoot);
                $free = @disk_free_space($m->localRoot);
                if ($total !== false && $free !== false && $total > 0) {
                    $used = max(0, (int) $total - (int) $free);
                    $capacity = [
                        'total' => (int) $total,
                        'used' => $used,
                        'free' => (int) $free,
                        // `available` marks this as a live filesystem figure so
                        // the UI prefers it over the cached scan.
                        'available' => true,
                        'percent' => (int) min(100, (int) round($used * 100 / (int) $total)),
                    ];
                }
            }
            $drives[] = [
                'mount' => $m->name,
                'adapter' => $m->adapter,
                'capacity' => $capacity,
            ];
        }
        return Response::ok(['drives' => $drives]);
    }
}
