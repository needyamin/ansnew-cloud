<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\Tickets;
use App\Core\Database;
use App\Jobs\JobHandler;
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
            'INSERT INTO jobs (id, user_id, type, params) VALUES (:id, :u, :t, :p)',
            [':id' => $id, ':u' => $userId, ':t' => $type, ':p' => json_encode($params, JSON_UNESCAPED_UNICODE) ?: '{}']
        );
        return $id;
    }

    /** @return array<string,mixed>|null full job row (ownership-checked by callers) */
    public static function get(string $jobId): ?array
    {
        return Database::i()->one('SELECT * FROM jobs WHERE id = :id', [':id' => $jobId]);
    }

    /** @return array<string,mixed>|null next queued job (claimed atomically) */
    public static function claimNext(): ?array
    {
        $db = Database::i();
        $db->run('BEGIN IMMEDIATE');
        try {
            $row = $db->one(
                "SELECT id, user_id, type, params FROM jobs
                 WHERE status = 'queued' ORDER BY created_at LIMIT 1"
            );
            if ($row === null) {
                $db->run('COMMIT');
                return null;
            }
            $db->run(
                "UPDATE jobs SET status = 'running', started_at = datetime('now') WHERE id = :id",
                [':id' => $row['id']]
            );
            $db->run('COMMIT');
            return $row;
        } catch (Throwable $e) {
            $db->run('ROLLBACK');
            error_log('[ansnew] job claim failed: ' . $e->getMessage());
            return null;
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

    public static function progress(string $jobId, int $percent, string $message = ''): void
    {
        $percent = max(0, min(100, $percent));
        $nowMs = (int) (microtime(true) * 1000);
        $last = self::$progressState[$jobId] ?? null;

        if ($last !== null && $percent < 100 && ($nowMs - $last[0]) < self::PROGRESS_MIN_INTERVAL_MS) {
            return;   // too soon; the terminal update always gets through
        }
        self::$progressState[$jobId] = [$nowMs, $percent];

        Database::i()->run(
            'UPDATE jobs SET progress = :p, message = :m WHERE id = :id',
            [':p' => $percent, ':m' => substr($message, 0, 500), ':id' => $jobId]
        );
        self::pushProgress($jobId);
    }

    public static function finish(string $jobId, array $result = [], string $message = 'Done'): void
    {
        unset(self::$progressState[$jobId]);
        Database::i()->run(
            "UPDATE jobs SET status = 'done', progress = 100, result = :r, message = :m,
                    finished_at = datetime('now') WHERE id = :id",
            [':r' => json_encode($result, JSON_UNESCAPED_UNICODE) ?: '{}', ':m' => $message, ':id' => $jobId]
        );
        self::pushProgress($jobId);
    }

    public static function fail(string $jobId, string $message): void
    {
        unset(self::$progressState[$jobId]);
        Database::i()->run(
            "UPDATE jobs SET status = 'error', message = :m, finished_at = datetime('now') WHERE id = :id",
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

    /** Notify the WS server (best-effort, internal shared secret). */
    private static function pushProgress(string $jobId): void
    {
        try {
            $row = Database::i()->one(
                'SELECT id, user_id, type, status, progress, message FROM jobs WHERE id = :id',
                [':id' => $jobId]
            );
            if ($row === null) {
                return;
            }
            $secret = \App\Config\Config::i()->wsSecret();
            $url = \App\Config\Config::i()->get('WS_INTERNAL_URL', 'http://ws:3001') . '/internal/notify';

            $payload = json_encode([
                'userIds' => [(int) $row['user_id']],
                'event' => 'job.progress',
                'data' => $row,
            ], JSON_UNESCAPED_UNICODE);

            $ch = curl_init($url);
            if ($ch === false) {
                return;
            }
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload ?: '{}',
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'X-Internal-Secret: ' . $secret,
                ],
                // This call sits inside the per-file byte loop, so a slow or
                // wedged WS server must not stall the job. The progress tick is
                // best-effort — the UI also polls /api/jobs.
                CURLOPT_TIMEOUT_MS => 600,
                CURLOPT_CONNECTTIMEOUT_MS => 300,
                CURLOPT_NOSIGNAL => true,
            ]);
            curl_exec($ch);
            curl_close($ch);
        } catch (Throwable $e) {
            // Non-fatal: polling still works.
        }
    }
}
