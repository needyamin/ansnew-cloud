<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Auth\Policy;
use App\Auth\Tickets;
use App\Config\Config;
use App\Core\Database;
use App\Storage\StorageAdapter;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use RuntimeException;
use Throwable;

/**
 * Full-drive backup.
 *
 * Design rules, in order of importance:
 *
 *  1. **Never destroy existing data.** Every run writes into a brand-new,
 *     timestamped folder. An existing folder with the same name is never
 *     reused, so "overwrite the backup" is not something the UI can trigger by
 *     accident. Copies are written to a temp name and renamed on success.
 *  2. **Designed for interruption.** The file list is a JSONL manifest on disk,
 *     not an array in memory, and progress is persisted per file. A backup
 *     stopped mid-way (paused, canceled, container restarted) resumes by
 *     skipping the files already copied.
 *  3. **No browser in the data path.** The copy runs on the worker; the browser
 *     only watches a job. Nothing is buffered whole, so a 2 TB drive costs the
 *     same memory as a 2 MB one.
 *  4. **Verifiable.** `verify` re-reads the manifest and checks every file on
 *     the destination (size by default, SHA-1 when asked).
 */
final class BackupService
{
    /** Give up waiting on a pause after this long and exit cleanly. */
    private const MAX_PAUSE_SECONDS = 7200;

    /* ------------------------------------------------------------------ start */

    /**
     * Create a backup run and queue the job that performs it.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public static function start(AuthContext $user, array $body): array
    {
        $srcMountName = (string) ($body['sourceMount'] ?? '');
        $srcPath = PathGuard::normalize((string) ($body['sourcePath'] ?? '/'));
        $destMountName = (string) ($body['destMount'] ?? '');
        $destPath = PathGuard::normalize((string) ($body['destPath'] ?? '/'));
        $label = trim((string) ($body['label'] ?? ''));

        if ($srcMountName === '' || $destMountName === '') {
            throw new RuntimeException('Choose a source drive and a destination drive', 400);
        }

        // Source: only needs to be readable, but it must be a folder.
        [$srcMount, $srcAdapter, $srcNorm] = StorageManager::resolve($user, $srcMountName, $srcPath);
        if (!$srcAdapter->isDir($srcNorm)) {
            throw new RuntimeException('The source must be a folder', 400);
        }

        // Destination: must accept writes and must be a folder that exists.
        $destMountRow = StorageManager::mountFor($user, $destMountName);
        Policy::assertCan(null, $destMountRow->canWrite, $user->isAdmin(), 'create');
        [, $destAdapter, $destNorm] = StorageManager::resolve($user, $destMountName, $destPath);
        if (!$destAdapter->isDir($destNorm)) {
            throw new RuntimeException('Destination folder not found: ' . $destPath, 404);
        }

        // A backup must not write into the tree it is reading — that would
        // recurse forever and fill the drive.
        if ($destMountName === $srcMountName
            && ($destNorm === $srcNorm || str_starts_with($destNorm . '/', $srcNorm . '/'))) {
            throw new RuntimeException('The destination must be outside the folder being backed up', 400);
        }

        $base = self::folderName($label !== '' ? $label : $srcMount->label, $srcMountName);
        $root = PathGuard::join($destNorm, $base);
        $root = self::uniqueFolder($destAdapter, $destNorm, $base);

        $id = Tickets::uuid4();
        $manifest = Config::i()->backupsDir() . '/' . $id . '.jsonl';

        Database::i()->run(
            'INSERT INTO backups (id, user_id, source_mount, source_path, dest_mount, dest_path,
                                  label, status, phase, manifest, created_at)
             VALUES (:id, :u, :sm, :sp, :dm, :dp, :label, :status, :phase, :manifest, datetime(\'now\'))',
            [
                ':id' => $id,
                ':u' => $user->id,
                ':sm' => $srcMountName,
                ':sp' => $srcNorm,
                ':dm' => $destMountName,
                ':dp' => $root,
                ':label' => $label !== '' ? mb_substr($label, 0, 120) : $srcMount->label,
                ':status' => 'queued',
                ':phase' => 'queued',
                ':manifest' => $manifest,
            ]
        );

        $jobId = JobService::enqueue($user->id, 'backup', [
            'backupId' => $id,
            'userId' => $user->id,
            'verify' => !empty($body['verify']),
        ]);
        Database::i()->run('UPDATE backups SET job_id = :j WHERE id = :id', [':j' => $jobId, ':id' => $id]);

        AuditService::log($user, 'backup.start', $srcMountName, $srcNorm, $destMountName . ':' . $root, 'ok', 'job ' . $jobId, '', '');

        return self::publicRow(self::row($id));
    }

    /* ------------------------------------------------------------ lifecycle */

    /** @return array<string,mixed>|null */
    public static function row(string $id): ?array
    {
        return Database::i()->one('SELECT * FROM backups WHERE id = :id', [':id' => $id]);
    }

    /**
     * List the user's backups, reconciling runs whose job died (a container
     * restart leaves a row stuck in "running" forever otherwise).
     *
     * @return array<int, array<string,mixed>>
     */
    public static function listFor(AuthContext $user, int $limit = 50): array
    {
        $rows = Database::i()->all(
            'SELECT * FROM backups WHERE user_id = :u ORDER BY created_at DESC LIMIT ' . max(1, min(200, $limit)),
            [':u' => $user->id]
        );
        $out = [];
        foreach ($rows as $row) {
            $out[] = self::publicRow(self::reconcile($row));
        }
        return $out;
    }

    /** @param array<string,mixed> $row */
    public static function get(AuthContext $user, string $id): array
    {
        $row = self::row($id);
        if ($row === null || (int) $row['user_id'] !== $user->id) {
            throw new RuntimeException('Backup not found', 404);
        }
        return self::publicRow(self::reconcile($row));
    }

    /**
     * A row can only be "running" while its job is. Anything else means the
     * process died (crash, `docker compose stop`, OOM) — the data is still
     * there, so the honest state is "interrupted" and it can be resumed.
     *
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private static function reconcile(array $row): array
    {
        if ($row['status'] !== 'running') {
            return $row;
        }
        $jobId = (string) ($row['job_id'] ?? '');
        if ($jobId === '') {
            return $row;
        }
        $job = JobService::get($jobId);
        if ($job === null) {
            return $row;
        }
        $status = (string) $job['status'];
        if ($status === 'running' || $status === 'queued') {
            return $row;
        }
        $next = $status === 'canceled' ? 'canceled' : 'error';
        $message = $next === 'canceled'
            ? 'Backup was interrupted before it finished'
            : 'Backup was interrupted: ' . (string) ($job['message'] ?? 'the worker stopped');
        Database::i()->run(
            'UPDATE backups SET status = :s, error = :e WHERE id = :id',
            [':s' => $next, ':e' => mb_substr($message, 0, 500), ':id' => $row['id']]
        );
        $row['status'] = $next;
        $row['error'] = $message;
        return $row;
    }

    /** @param array<string,mixed>|null $row */
    public static function publicRow(?array $row): array
    {
        if ($row === null) {
            return [];
        }
        $bytesTotal = (int) $row['bytes_total'];
        $bytesDone = (int) $row['bytes_done'];
        return [
            'id' => (string) $row['id'],
            'sourceMount' => (string) $row['source_mount'],
            'sourcePath' => (string) $row['source_path'],
            'destMount' => (string) $row['dest_mount'],
            'destPath' => (string) $row['dest_path'],
            'label' => (string) $row['label'],
            'status' => (string) $row['status'],
            'phase' => (string) $row['phase'],
            'jobId' => $row['job_id'] !== null ? (string) $row['job_id'] : null,
            'filesTotal' => (int) $row['files_total'],
            'filesDone' => (int) $row['files_done'],
            'bytesTotal' => $bytesTotal,
            'bytesDone' => $bytesDone,
            'percent' => $bytesTotal > 0 ? round($bytesDone * 100 / $bytesTotal, 1) : null,
            'error' => $row['error'] !== null ? (string) $row['error'] : null,
            'startedAt' => $row['started_at'],
            'finishedAt' => $row['finished_at'],
            'createdAt' => (string) $row['created_at'],
        ];
    }

    /* ------------------------------------------------------- pause / resume */

    public static function pause(AuthContext $user, string $id): array
    {
        $row = self::assertOwned($user, $id);
        if (!in_array($row['status'], ['queued', 'running'], true)) {
            throw new RuntimeException('Only a running backup can be paused', 409);
        }
        self::setFlag($id, '1');
        Database::i()->run(
            'UPDATE backups SET status = :s WHERE id = :id',
            [':s' => 'paused', ':id' => $id]
        );
        AuditService::log($user, 'backup.pause', (string) $row['source_mount'], (string) $row['source_path'], null, 'ok', '', '', '');
        return self::publicRow(self::row($id));
    }

    /**
     * Resume: clear the pause flag and, if no job is alive any more (the worker
     * exited while paused, or the container restarted), queue a fresh one. The
     * new run reuses the manifest and skips whatever is already copied.
     */
    public static function resume(AuthContext $user, string $id): array
    {
        $row = self::assertOwned($user, $id);
        if (!in_array($row['status'], ['paused', 'error'], true)) {
            throw new RuntimeException('Only a paused or interrupted backup can be resumed', 409);
        }
        self::setFlag($id, '0');

        $needJob = true;
        $jobId = (string) ($row['job_id'] ?? '');
        if ($jobId !== '') {
            $job = JobService::get($jobId);
            if ($job !== null && in_array((string) $job['status'], ['queued', 'running'], true)) {
                $needJob = false;   // still alive: it will pick the flag up
            }
        }
        if ($needJob) {
            $jobId = JobService::enqueue($user->id, 'backup', [
                'backupId' => $id,
                'userId' => $user->id,
                'verify' => false,
            ]);
            Database::i()->run('UPDATE backups SET job_id = :j WHERE id = :id', [':j' => $jobId, ':id' => $id]);
        }
        Database::i()->run(
            'UPDATE backups SET status = :s, error = NULL WHERE id = :id',
            [':s' => $needJob ? 'queued' : 'running', ':id' => $id]
        );
        AuditService::log($user, 'backup.resume', (string) $row['source_mount'], (string) $row['source_path'], null, 'ok', 'job ' . $jobId, '', '');
        return self::publicRow(self::row($id));
    }

    /** Stop for good. Data already copied is left in place and reported. */
    public static function cancel(AuthContext $user, string $id): array
    {
        $row = self::assertOwned($user, $id);
        if (in_array($row['status'], ['done', 'verified', 'canceled'], true)) {
            return self::publicRow($row);
        }
        self::setFlag($id, '0');
        $jobId = (string) ($row['job_id'] ?? '');
        if ($jobId !== '') {
            try {
                JobService::cancel($jobId, $user->id);
            } catch (Throwable) {
                // Already finished, or a job from an older run — ignore.
            }
        }
        Database::i()->run(
            'UPDATE backups SET status = :s WHERE id = :id',
            [':s' => 'canceled', ':id' => $id]
        );
        AuditService::log($user, 'backup.cancel', (string) $row['source_mount'], (string) $row['source_path'], null, 'ok', '', '', '');
        return self::publicRow(self::row($id));
    }

    /* --------------------------------------------------------------- verify */

    /**
     * Queue a verification pass: every file in the manifest is checked against
     * the destination (size by default, SHA-1 of both sides when $deep).
     */
    public static function verify(AuthContext $user, string $id, bool $deep = false): array
    {
        $row = self::assertOwned($user, $id);
        if (!in_array($row['status'], ['done', 'verified', 'verify-failed', 'canceled'], true)) {
            throw new RuntimeException('Wait for the backup to finish before verifying it', 409);
        }
        $jobId = JobService::enqueue($user->id, 'backup-verify', [
            'backupId' => $id,
            'userId' => $user->id,
            'deep' => $deep,
        ]);
        Database::i()->run(
            'UPDATE backups SET status = :s, phase = :p, job_id = :j WHERE id = :id',
            [':s' => 'verifying', ':p' => 'verifying', ':j' => $jobId, ':id' => $id]
        );
        AuditService::log($user, 'backup.verify', (string) $row['source_mount'], (string) $row['source_path'], null, 'ok', 'job ' . $jobId, '', '');
        return self::publicRow(self::row($id));
    }

    /* --------------------------------------------------- worker-facing state */

    /** @param array<string,mixed> $row */
    public static function assertOwned(AuthContext $user, string $id): array
    {
        $row = self::row($id);
        if ($row === null || (int) $row['user_id'] !== $user->id) {
            throw new RuntimeException('Backup not found', 404);
        }
        return $row;
    }

    /** Is this backup paused right now? */
    public static function isPaused(string $id): bool
    {
        try {
            $v = Database::i()->scalar('SELECT v FROM settings WHERE k = :k', [':k' => 'backuppause:' . $id]);
        } catch (Throwable) {
            return false;
        }
        return $v === '1';
    }

    private static function setFlag(string $id, string $value): void
    {
        Database::i()->run(
            'INSERT INTO settings (k, v, updated_at) VALUES (:k, :v, datetime(\'now\'))
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime(\'now\')',
            [':k' => 'backuppause:' . $id, ':v' => $value]
        );
    }

    public static function setStatus(string $id, string $status, string $phase = '', ?string $error = null): void
    {
        Database::i()->run(
            'UPDATE backups SET status = :s, phase = :p, error = :e' . ($status === 'done' || $status === 'verified' ? ', finished_at = datetime(\'now\')' : '') . ' WHERE id = :id',
            [
                ':s' => $status,
                ':p' => $phase,
                ':e' => $error !== null ? mb_substr($error, 0, 500) : null,
                ':id' => $id,
            ]
        );
    }

    public static function begin(string $id, string $jobId): void
    {
        Database::i()->run(
            'UPDATE backups SET status = :s, phase = :p, job_id = :j, started_at = datetime(\'now\') WHERE id = :id',
            [':s' => 'running', ':p' => 'scanning', ':j' => $jobId, ':id' => $id]
        );
    }

    public static function setTotals(string $id, int $files, int $bytes): void
    {
        Database::i()->run(
            'UPDATE backups SET files_total = :f, bytes_total = :b WHERE id = :id',
            [':f' => $files, ':b' => $bytes, ':id' => $id]
        );
    }

    public static function setProgress(string $id, int $filesDone, int $bytesDone, string $phase): void
    {
        Database::i()->run(
            'UPDATE backups SET files_done = :f, bytes_done = :b, phase = :p WHERE id = :id',
            [':f' => $filesDone, ':b' => $bytesDone, ':p' => $phase, ':id' => $id]
        );
    }

    public static function maxPauseSeconds(): int
    {
        return self::MAX_PAUSE_SECONDS;
    }

    /* ------------------------------------------------------------- manifest */

    /** @return resource|null */
    public static function openManifest(string $id, string $mode)
    {
        $path = Config::i()->backupsDir() . '/' . preg_replace('/[^a-zA-Z0-9_-]/', '', $id) . '.jsonl';
        $fh = @fopen($path, $mode);
        return $fh === false ? null : $fh;
    }

    public static function manifestPath(string $id): string
    {
        return Config::i()->backupsDir() . '/' . preg_replace('/[^a-zA-Z0-9_-]/', '', $id) . '.jsonl';
    }

    /* ---------------------------------------------------------------- naming */

    /** "Work Drive" -> "work-drive-20261007-224700" */
    private static function folderName(string $label, string $mountName): string
    {
        $base = strtolower(trim($label !== '' ? $label : $mountName));
        $base = preg_replace('/[^a-z0-9]+/', '-', $base) ?? '';
        $base = trim($base, '-');
        if ($base === '') {
            $base = 'backup';
        }
        return mb_substr($base, 0, 48) . '-' . gmdate('Ymd-His');
    }

    /** Never land on an existing folder: append -2, -3 … instead. */
    private static function uniqueFolder(StorageAdapter $adapter, string $parent, string $base): string
    {
        $candidate = PathGuard::join($parent, $base);
        if (!$adapter->exists($candidate)) {
            return $candidate;
        }
        for ($i = 2; $i < 500; $i++) {
            $candidate = PathGuard::join($parent, $base . '-' . $i);
            if (!$adapter->exists($candidate)) {
                return $candidate;
            }
        }
        throw new RuntimeException('Could not find a free backup folder name');
    }
}
