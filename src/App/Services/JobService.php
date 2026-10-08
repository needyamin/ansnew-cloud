<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\Tickets;
use App\Core\Database;
use App\Jobs\JobHandler;
use App\Support\PathGuard;
use RuntimeException;
use Throwable;

/**
 * Background job queue. Jobs are claimed transactionally by bin/worker.php;
 * progress is persisted and fanned out through the WS server.
 */
final class JobService
{
    public static function enqueue(int $userId, string $type, array $params): string
    {
        if (!isset(JobHandler::TYPES[$type])) {
            throw new RuntimeException('Unknown job type');
        }
        $id = Tickets::uuid4();
        Database::i()->run(
            'INSERT INTO jobs (id, user_id, type, params, max_attempts) VALUES (:id, :u, :t, :p, :ma)',
            [
                ':id' => $id,
                ':u' => $userId,
                ':t' => $type,
                ':p' => json_encode($params, JSON_UNESCAPED_UNICODE) ?: '{}',
                ':ma' => self::maxAttempts(),
            ]
        );
        return $id;
    }

    /** @return array<string,mixed>|null full job row (ownership-checked by callers) */
    public static function get(string $jobId): ?array
    {
        return Database::i()->one('SELECT * FROM jobs WHERE id = :id', [':id' => $jobId]);
    }

    /**
     * Claim the next runnable job.
     *
     * Skips jobs that have exhausted their retry budget or are still serving a
     * backoff (next_attempt_at in the future), and takes a lease on the one it
     * claims so a crashed worker's job can be reclaimed later.
     *
     * @return array<string,mixed>|null
     */
    public static function claimNext(): ?array
    {
        $db = Database::i();
        $now = time();
        $db->run('BEGIN IMMEDIATE');
        try {
            $row = $db->one(
                "SELECT id, user_id, type, params FROM jobs
                 WHERE status = 'queued'
                   AND attempts < max_attempts
                   AND (next_attempt_at IS NULL OR next_attempt_at <= :now)
                 ORDER BY created_at LIMIT 1",
                [':now' => $now]
            );
            if ($row === null) {
                $db->run('COMMIT');
                return null;
            }
            $db->run(
                "UPDATE jobs SET status = 'running', started_at = datetime('now'),
                        attempts = attempts + 1, lease_expires_at = :lease, next_attempt_at = NULL
                 WHERE id = :id",
                [':lease' => $now + self::leaseSeconds(), ':id' => $row['id']]
            );
            $db->run('COMMIT');
            return $row;
        } catch (Throwable $e) {
            $db->run('ROLLBACK');
            error_log('[ansnew] job claim failed: ' . $e->getMessage());
            return null;
        }
    }

    // -------------------------------------------------------- crash recovery

    /** Seconds a running job may go without a heartbeat before it is reclaimed. */
    private static function leaseSeconds(): int
    {
        $v = \App\Config\Config::i()->getInt('JOB_LEASE_SECONDS', 900);
        return $v >= 30 ? $v : 900;
    }

    private static function maxAttempts(): int
    {
        $v = \App\Config\Config::i()->getInt('JOB_MAX_ATTEMPTS', 3);
        return ($v >= 1 && $v <= 20) ? $v : 3;
    }

    /**
     * Renew a running job's lease. Called on every progress update and between
     * chunks, so a legitimately long job is never mistaken for a dead one.
     */
    public static function heartbeat(string $jobId, ?int $now = null): void
    {
        try {
            Database::i()->run(
                "UPDATE jobs SET lease_expires_at = :lease WHERE id = :id AND status = 'running'",
                [':lease' => ($now ?? time()) + self::leaseSeconds(), ':id' => $jobId]
            );
        } catch (Throwable $e) {
            error_log('[ansnew] job heartbeat failed: ' . $e->getMessage());
        }
    }

    /**
     * Reclaim jobs whose worker died: requeue while retry budget remains, then
     * fail them. Without this a job stayed 'running' forever and its owner saw
     * a progress bar that never moved again.
     *
     * @return int rows touched
     */
    public static function reapStale(?int $now = null): int
    {
        $now ??= time();
        $db = Database::i();
        $touched = 0;

        // Out of retries → fail so the UI stops showing it as running.
        $touched += $db->run(
            "UPDATE jobs SET status = 'error', lease_expires_at = NULL, finished_at = datetime('now'),
                    message = CASE WHEN message = '' THEN 'Worker stopped unexpectedly' ELSE message END
             WHERE status = 'running' AND cancel_flag = 0
               AND lease_expires_at IS NOT NULL AND lease_expires_at < :now
               AND attempts >= max_attempts",
            [':now' => $now]
        )->rowCount();

        // Retry budget left → back to the queue after an exponential backoff.
        $rows = $db->all(
            "SELECT id, attempts FROM jobs
             WHERE status = 'running' AND cancel_flag = 0
               AND lease_expires_at IS NOT NULL AND lease_expires_at < :now
               AND attempts < max_attempts",
            [':now' => $now]
        );
        foreach ($rows as $r) {
            $attempts = max(1, (int) $r['attempts']);
            $delay = min(300, 15 * (2 ** ($attempts - 1)));   // 15s, 30s, 60s, … capped at 5m
            $touched += $db->run(
                "UPDATE jobs SET status = 'queued', lease_expires_at = NULL, next_attempt_at = :next
                 WHERE id = :id AND status = 'running'",
                [':next' => $now + $delay, ':id' => $r['id']]
            )->rowCount();
        }

        if ($touched > 0) {
            error_log("[ansnew] reaped {$touched} stale job(s)");
        }
        return $touched;
    }

    /**
     * Requeue everything still marked 'running'. Called once when the worker
     * starts: there is a single worker container, so any such row was orphaned
     * by a previous crash.
     *
     * @return int rows requeued
     */
    public static function recoverOrphans(): int
    {
        $db = Database::i();
        try {
            $db->run(
                "UPDATE jobs SET status = 'error', lease_expires_at = NULL, finished_at = datetime('now'),
                        message = 'Worker stopped unexpectedly'
                 WHERE status = 'running' AND attempts >= max_attempts"
            );
            $requeued = $db->run(
                "UPDATE jobs SET status = 'queued', lease_expires_at = NULL, next_attempt_at = NULL,
                        message = 'Requeued after worker restart'
                 WHERE status = 'running' AND attempts < max_attempts"
            )->rowCount();
            if ($requeued > 0) {
                error_log("[ansnew] requeued {$requeued} orphaned job(s) after worker start");
            }
            return $requeued;
        } catch (Throwable $e) {
            error_log('[ansnew] orphan recovery failed: ' . $e->getMessage());
            return 0;
        }
    }

    /**
     * Per-job progress throttle state: jobId => [lastWriteMs, lastPercent].
     *
     * Without this, every entry in an archive/extract/copy/delete job costs an
     * UPDATE plus a blocking HTTP round-trip to the WS server. On a 10k-file
     * transfer that is 10k updates and 10k curls — by far the dominant cost of
     * a large job, and the thing that would make adding encryption look slow.
     * The UI polls /api/jobs every 5s anyway, so dropped frames are invisible.
     */
    private static array $progressState = [];

    private const PROGRESS_MIN_INTERVAL_MS = 500;

    /**
     * @param array<string,mixed> $meta live transfer stats (bytesDone, bytesTotal,
     *                                  speed, etaSeconds, phase) that the UI needs
     *                                  to show a real download/backup progress bar.
     */
    public static function progress(string $jobId, int $percent, string $message = '', array $meta = []): void
    {
        $percent = max(0, min(100, $percent));
        $nowMs = (int) (microtime(true) * 1000);
        $last = self::$progressState[$jobId] ?? null;

        if ($last !== null && $percent < 100 && ($nowMs - $last[0]) < self::PROGRESS_MIN_INTERVAL_MS) {
            return;   // too soon; the terminal update always gets through
        }
        self::$progressState[$jobId] = [$nowMs, $percent];

        // `result` doubles as the live stats channel: it is already shipped with
        // every push and is overwritten by finish() with the final payload.
        // Every progress write doubles as a lease renewal.
        $sql = 'UPDATE jobs SET progress = :p, message = :m, lease_expires_at = :lease'
            . ($meta !== [] ? ', result = :r' : '') . ' WHERE id = :id';
        $params = [
            ':p' => $percent,
            ':m' => substr($message, 0, 500),
            ':id' => $jobId,
            ':lease' => time() + self::leaseSeconds(),
        ];
        if ($meta !== []) {
            $params[':r'] = json_encode($meta, JSON_UNESCAPED_UNICODE) ?: '{}';
        }
        Database::i()->run($sql, $params);
        self::pushProgress($jobId);
    }

    public static function finish(string $jobId, array $result = [], string $message = 'Done'): void
    {
        unset(self::$progressState[$jobId]);
        Database::i()->run(
            "UPDATE jobs SET status = 'done', progress = 100, result = :r, message = :m,
                    lease_expires_at = NULL, finished_at = datetime('now') WHERE id = :id",
            [':r' => json_encode($result, JSON_UNESCAPED_UNICODE) ?: '{}', ':m' => $message, ':id' => $jobId]
        );
        self::pushProgress($jobId);
    }

    public static function fail(string $jobId, string $message): void
    {
        unset(self::$progressState[$jobId]);
        Database::i()->run(
            "UPDATE jobs SET status = 'error', message = :m, lease_expires_at = NULL,
                    finished_at = datetime('now') WHERE id = :id",
            [':m' => substr($message, 0, 500), ':id' => $jobId]
        );
        self::pushProgress($jobId);
    }

    public static function cancel(string $jobId, int $userId): void
    {
        $row = Database::i()->one(
            'SELECT id, status FROM jobs WHERE id = :id AND user_id = :u',
            [':id' => $jobId, ':u' => $userId]
        );
        if ($row === null) {
            throw new RuntimeException('Job not found', 404);
        }
        if (in_array($row['status'], ['done', 'error', 'canceled'], true)) {
            return;
        }
        unset(self::$progressState[$jobId]);
        Database::i()->run(
            "UPDATE jobs SET cancel_flag = 1, status = 'canceled', finished_at = datetime('now')
             WHERE id = :id",
            [':id' => $jobId]
        );
        self::pushProgress($jobId);
    }

    public static function isCanceled(string $jobId): bool
    {
        $v = Database::i()->scalar('SELECT cancel_flag FROM jobs WHERE id = :id', [':id' => $jobId]);
        return (int) $v === 1;
    }

    /** @return array<int, array<string,mixed>> */
    public static function listFor(int $userId, int $limit = 50): array
    {
        return Database::i()->all(
            'SELECT id, type, status, progress, message, result, created_at, finished_at
             FROM jobs WHERE user_id = :u ORDER BY created_at DESC LIMIT ' . max(1, min(200, $limit)),
            [':u' => $userId]
        );
    }

    /**
     * Notify the WS server about a job's state.
     *
     * `result` is included deliberately: it carries the one-shot download token
     * for download-folder jobs, which lets the client act on the push instead of
     * polling /api/jobs every 1.2 s for the lifetime of the job.
     */
    private static function pushProgress(string $jobId): void
    {
        try {
            $row = Database::i()->one(
                'SELECT id, user_id, type, status, progress, message, result FROM jobs WHERE id = :id',
                [':id' => $jobId]
            );
            if ($row === null) {
                return;
            }
            // result is a JSON column; the client expects an object.
            if (isset($row['result']) && is_string($row['result'])) {
                $decoded = json_decode($row['result'], true);
                $row['result'] = is_array($decoded) ? $decoded : null;
            }
            NotifyService::push([(int) $row['user_id']], 'job.progress', $row);
        } catch (Throwable $e) {
            // Non-fatal: polling still works.
        }
    }

    /**
     * Tell every open pane which directories a finished job touched, so it can
     * revalidate just those instead of refetching whatever happens to be open.
     *
     * @param array<string,mixed> $params the job's stored params
     */
    public static function notifyFsChange(int $userId, string $type, array $params): void
    {
        $mount = (string) ($params['mount'] ?? '');
        if ($mount === '') {
            return;
        }
        $path = (string) ($params['path'] ?? '/');
        $destDir = (string) ($params['destDir'] ?? '');
        $destMount = (string) ($params['destMount'] ?? $mount);

        $map = [];
        switch ($type) {
            case 'delete':
                $map[$mount] = [PathGuard::dirname($path), $path];
                break;
            case 'move':
            case 'copy':
                $map[$mount] = [PathGuard::dirname($path)];
                if ($destDir !== '') {
                    $map[$destMount] = array_merge($map[$destMount] ?? [], [$destDir]);
                }
                break;
            case 'archive':
            case 'extract':
                $map[$mount] = [$destDir !== '' ? $destDir : '/'];
                break;
            default:
                return;
        }
        NotifyService::fsChanged($userId, $map, 'job:' . $type);
    }
}
