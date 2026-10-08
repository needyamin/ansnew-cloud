<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Auth\AuthContext;
use App\Auth\Tickets;
use App\Core\Database;
use App\Services\ArchiveService;
use App\Services\FileService;
use App\Services\JobService;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use RuntimeException;

/**
 * Shared plumbing for job handlers.
 */
abstract class AbstractHandler
{
    /**
     * Resolve mount+adapter for the job owner (jobs run with the owner's scope).
     * @return array{0: \App\Storage\Mount, 1: \App\Storage\StorageAdapter, 2: string}
     */
    protected static function ctx(int $userId, string $mount, string $path): array
    {
        $user = self::userById($userId);
        return StorageManager::resolve($user, $mount, $path);
    }

    public static function userById(int $id): AuthContext
    {
        $row = Database::i()->one(
            'SELECT id, username, role, display_name, theme, must_change_pw FROM users WHERE id = :id AND is_active = 1',
            [':id' => $id]
        );
        if ($row === null) {
            throw new RuntimeException('Job owner no longer exists or is inactive');
        }
        return new AuthContext(
            (int) $row['id'],
            (string) $row['username'],
            (string) $row['role'],
            (string) $row['display_name'],
            (string) $row['theme'],
            (bool) $row['must_change_pw']
        );
    }

    /** Throttle for the lease heartbeat below (unix time). */
    private static int $lastBeat = 0;

    protected static function checkCancel(string $jobId): void
    {
        // Called frequently between chunks, so renew the job lease here too —
        // a long job that reports no progress must not be reaped as stale.
        // Throttled: the lease is minutes long, so a write per chunk is waste.
        $now = time();
        if ($now - self::$lastBeat >= 30) {
            self::$lastBeat = $now;
            JobService::heartbeat($jobId, $now);
        }
        if (JobService::isCanceled($jobId)) {
            throw new RuntimeException('Job canceled');
        }
    }

    /** @param array<string,mixed> $meta live stats forwarded to the UI (bytes, speed, ETA…) */
    protected static function progress(string $jobId, int $percent, string $message = '', array $meta = []): void
    {
        JobService::progress($jobId, $percent, $message, $meta);
    }

    protected static function uuid(): string
    {
        return Tickets::uuid4();
    }
}
