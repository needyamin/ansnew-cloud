<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\BackupService;
use App\Services\JobService;
use App\Storage\StorageAdapter;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use RuntimeException;
use Throwable;

/**
 * backup: copy a whole drive (or a subtree of it) to another drive.
 * params: {backupId, userId, verify}
 *
 * The run is resumable: the file list lives in a JSONL manifest on disk and
 * progress is persisted per file, so a paused, canceled or crashed run simply
 * starts again and skips what is already there.
 */
final class BackupHandler extends AbstractHandler
{
    /** Throttle: at most one DB progress write per this many bytes. */
    private const PUSH_BYTES = 8 * 1024 * 1024;

    /** Last published percentage, so a "Paused" tick does not reset the bar. */
    private static array $lastPct = [];

    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $id = (string) ($params['backupId'] ?? '');
        $row = BackupService::row($id);
        if ($row === null) {
            throw new RuntimeException('Backup not found');
        }

        try {
            return self::perform($row, $jobId, !empty($params['verify']));
        } catch (Throwable $e) {
            // A pause and a stop are not failures: record them as such instead
            // of letting the worker paint the run as an error.
            if (JobService::isCanceled($jobId)) {
                $paused = BackupService::isPaused($id);
                BackupService::setStatus($id, $paused ? 'paused' : 'canceled', 'stopped');
            } else {
                BackupService::setStatus($id, 'error', 'error', $e->getMessage());
            }
            throw $e;
        }
    }

    /** @param array<string,mixed> $row */
    private static function perform(array $row, string $jobId, bool $verify): array
    {
        $id = (string) $row['id'];
        $user = self::userById((int) $row['user_id']);
        BackupService::begin($id, $jobId);

        [, $srcAdapter, $srcNorm] = StorageManager::resolve($user, (string) $row['source_mount'], (string) $row['source_path']);
        [, $destAdapter, $destRoot] = StorageManager::resolve($user, (string) $row['dest_mount'], (string) $row['dest_path']);
        if (!$destAdapter->exists($destRoot)) {
            $destAdapter->mkdir($destRoot, true);
        }

        // ---- pass 1: enumerate (skipped when resuming an existing manifest) ----
        $manifestPath = BackupService::manifestPath($id);
        $resuming = is_file($manifestPath) && (int) $row['files_total'] > 0;
        if ($resuming) {
            self::progress($jobId, 2, 'Resuming backup', ['phase' => 'copy', 'backupId' => $id]);
        } else {
            self::scan($srcAdapter, $srcNorm, $manifestPath, $jobId, $id);
        }

        $filesTotal = max(0, (int) $row['files_total']);
        $bytesTotal = max(0, (int) $row['bytes_total']);
        BackupService::setProgress($id, 0, 0, 'copying');

        // ---- pass 2: copy ----
        $fh = BackupService::openManifest($id, 'rb');
        if ($fh === null) {
            throw new RuntimeException('Backup manifest is missing — start the backup again');
        }

        $filesDone = 0;
        $bytesDone = 0;
        $copied = 0;
        $skipped = 0;
        $failed = 0;
        $madeDirs = [];
        $started = microtime(true);
        $lastPush = 0;

        try {
            while (($line = fgets($fh)) !== false) {
                $line = trim($line);
                if ($line === '') {
                    continue;
                }
                $item = json_decode($line, true);
                if (!is_array($item) || !isset($item['p'])) {
                    continue;
                }
                self::checkCancel($jobId);
                if (BackupService::isPaused($id)) {
                    // Stay alive and wait: the run keeps its place in the
                    // manifest, so resuming continues from exactly here.
                    if (!self::waitForResume($id, $jobId)) {
                        throw new RuntimeException('Job canceled');
                    }
                }

                $rel = (string) $item['p'];
                $dest = PathGuard::join($destRoot, $rel);

                if (!empty($item['d'])) {
                    if (!isset($madeDirs[$dest]) && !$destAdapter->isDir($dest)) {
                        $destAdapter->mkdir($dest, true);
                    }
                    $madeDirs[$dest] = true;
                    continue;
                }

                $size = (int) ($item['s'] ?? 0);
                $mtime = (int) ($item['m'] ?? 0);

                // Already there and complete: a resumed run must not recopy it.
                if (self::alreadyCopied($destAdapter, $dest, $size, $mtime)) {
                    $skipped++;
                } else {
                    $ok = self::copyOne($srcAdapter, $destAdapter, PathGuard::join($srcNorm, $rel), $dest, $madeDirs);
                    if ($ok) {
                        $copied++;
                    } else {
                        $failed++;
                    }
                }

                $filesDone++;
                $bytesDone += $size;

                if ($bytesDone - $lastPush >= self::PUSH_BYTES || $filesDone % 250 === 0) {
                    $lastPush = $bytesDone;
                    self::push($id, $jobId, $filesDone, $filesTotal, $bytesDone, $bytesTotal, $started, (string) $item['p']);
                }
            }
        } finally {
            fclose($fh);
        }

        self::push($id, $jobId, $filesDone, $filesTotal, $bytesDone, $bytesTotal, $started, 'finishing');
        BackupService::setTotals($id, $filesTotal, $bytesTotal);

        // ---- pass 3: optional verification ----
        if ($verify) {
            $report = BackupVerifyHandler::verifyNow($id, $jobId, false);
            $status = $report['ok'] ? 'verified' : 'verify-failed';
            BackupService::setStatus($id, $status, $status, $report['ok'] ? null : 'Verification found differences');
            JobService::progress($jobId, 100, $report['ok'] ? 'Backup verified' : 'Verification failed');
            return [
                'backupId' => $id,
                'files' => $filesDone,
                'bytes' => $bytesDone,
                'copied' => $copied,
                'skipped' => $skipped,
                'failed' => $failed,
                'verified' => $report['ok'],
                'verifyReport' => $report,
            ];
        }

        BackupService::setStatus($id, 'done', 'done');
        JobService::progress($jobId, 100, 'Backup complete');
        return [
            'backupId' => $id,
            'files' => $filesDone,
            'bytes' => $bytesDone,
            'copied' => $copied,
            'skipped' => $skipped,
            'failed' => $failed,
        ];
    }

    /* ------------------------------------------------------------- scanning */

    private static function scan(StorageAdapter $adapter, string $root, string $manifestPath, string $jobId, string $backupId): void
    {
        $tmp = $manifestPath . '.tmp';
        $fh = @fopen($tmp, 'wb');
        if ($fh === false) {
            throw new RuntimeException('Cannot write the backup manifest');
        }
        $files = 0;
        $bytes = 0;
        $dirs = 0;
        $pushed = 0;
        try {
            self::scanInto($adapter, $root, '', $fh, $files, $bytes, $dirs, $jobId, $pushed);
        } finally {
            fclose($fh);
        }
        // Atomic publish: a crash mid-scan leaves no half manifest behind.
        if (!@rename($tmp, $manifestPath)) {
            @unlink($tmp);
            throw new RuntimeException('Cannot publish the backup manifest');
        }
        BackupService::setTotals($backupId, $files, $bytes);
        self::progress($jobId, 5, 'Found ' . number_format($files) . ' files', [
            'phase' => 'scan',
            'backupId' => $backupId,
            'filesTotal' => $files,
            'bytesTotal' => $bytes,
        ]);
    }

    private static function scanInto(
        StorageAdapter $adapter,
        string $dir,
        string $rel,
        $fh,
        int &$files,
        int &$bytes,
        int &$dirs,
        string $jobId,
        int &$pushed
    ): void {
        self::checkCancel($jobId);
        if ($rel !== '') {
            fwrite($fh, json_encode(['p' => $rel, 'd' => 1], JSON_UNESCAPED_UNICODE) . "\n");
            $dirs++;
        }
        foreach ($adapter->list($dir) as $e) {
            self::checkCancel($jobId);
            $childRel = $rel === '' ? (string) $e['name'] : $rel . '/' . (string) $e['name'];
            if (($e['type'] ?? '') === 'dir') {
                self::scanInto($adapter, (string) $e['path'], $childRel, $fh, $files, $bytes, $dirs, $jobId, $pushed);
                continue;
            }
            if (($e['type'] ?? '') !== 'file') {
                continue;
            }
            $size = (int) ($e['size'] ?? 0);
            fwrite($fh, json_encode([
                'p' => $childRel,
                's' => $size,
                'm' => (int) ($e['mtime'] ?? 0),
            ], JSON_UNESCAPED_UNICODE) . "\n");
            $files++;
            $bytes += $size;
            if ($bytes - $pushed >= 64 * 1024 * 1024) {
                $pushed = $bytes;
                self::progress($jobId, 4, 'Scanning — ' . number_format($files) . ' files', [
                    'phase' => 'scan',
                    'filesTotal' => $files,
                    'bytesTotal' => $bytes,
                ]);
            }
        }
    }

    /* ---------------------------------------------------------------- copying */

    private static function alreadyCopied(StorageAdapter $dest, string $path, int $size, int $mtime): bool
    {
        if (!$dest->exists($path)) {
            return false;
        }
        try {
            $stat = $dest->stat($path);
        } catch (Throwable) {
            return false;
        }
        if (($stat['type'] ?? '') !== 'file') {
            return false;
        }
        if ((int) ($stat['size'] ?? -1) !== $size) {
            return false;
        }
        // Same size and not older than the source: good enough to skip. mtime
        // alone is unreliable across adapters (some round to the minute).
        $destMtime = (int) ($stat['mtime'] ?? 0);
        return $mtime <= 0 || $destMtime >= $mtime - 2;
    }

    /**
     * Copy one file through the adapters, via a temporary name.
     *
     * The temp name is what makes an interrupted backup safe: a half-written
     * file never sits at its final path pretending to be complete.
     *
     * @param array<string,bool> $madeDirs
     */
    private static function copyOne(
        StorageAdapter $src,
        StorageAdapter $dest,
        string $srcPath,
        string $destPath,
        array &$madeDirs
    ): bool {
        $parent = PathGuard::dirname($destPath);
        if (!isset($madeDirs[$parent])) {
            if (!$dest->isDir($parent)) {
                $dest->mkdir($parent, true);
            }
            $madeDirs[$parent] = true;
        }
        $tmp = $destPath . '.ansnew-part';
        $in = null;
        try {
            $in = $src->getStream($srcPath);
            $dest->putStream($tmp, $in);
        } catch (Throwable $e) {
            error_log('[ansnew] backup: failed to copy ' . $srcPath . ': ' . $e->getMessage());
            return false;
        } finally {
            if (is_resource($in)) {
                fclose($in);
            }
        }
        try {
            if ($dest->exists($destPath)) {
                $dest->delete($destPath);
            }
            $dest->rename($tmp, $destPath);
        } catch (Throwable $e) {
            error_log('[ansnew] backup: failed to finalise ' . $destPath . ': ' . $e->getMessage());
            return false;
        }
        return true;
    }

    /* --------------------------------------------------------------- waiting */

    /**
     * Block while the run is paused. Returns false if it was canceled instead,
     * true once the pause is lifted.
     */
    private static function waitForResume(string $backupId, string $jobId): bool
    {
        BackupService::setStatus($backupId, 'paused', 'paused');
        $deadline = time() + BackupService::maxPauseSeconds();
        while (BackupService::isPaused($backupId)) {
            if (JobService::isCanceled($jobId)) {
                return false;
            }
            if (time() > $deadline) {
                // Still paused hours later: release the worker. Resume() will
                // queue a fresh job that continues from the manifest.
                return false;
            }
            self::progress($jobId, self::$lastPct[$jobId] ?? 5, 'Paused — resume when ready', [
                'phase' => 'paused',
                'backupId' => $backupId,
            ]);
            sleep(2);
        }
        BackupService::setStatus($backupId, 'running', 'copying');
        return true;
    }

    /* -------------------------------------------------------------- progress */

    private static function push(
        string $backupId,
        string $jobId,
        int $filesDone,
        int $filesTotal,
        int $bytesDone,
        int $bytesTotal,
        float $started,
        string $current
    ): void {
        BackupService::setProgress($backupId, $filesDone, $bytesDone, 'copying');
        $elapsed = max(0.001, microtime(true) - $started);
        $speed = (int) ($bytesDone / $elapsed);
        $pct = $bytesTotal > 0 ? (int) (5 + 90 * $bytesDone / max(1, $bytesTotal)) : ($filesTotal > 0 ? (int) (5 + 90 * $filesDone / $filesTotal) : 50);
        self::$lastPct[$jobId] = $pct;
        self::progress($jobId, $pct, 'Backing up ' . PathGuard::basename('/' . $current), [
            'phase' => 'copy',
            'backupId' => $backupId,
            'filesDone' => $filesDone,
            'filesTotal' => $filesTotal,
            'bytesDone' => $bytesDone,
            'bytesTotal' => $bytesTotal,
            'speed' => $speed,
            'etaSeconds' => $speed > 0 && $bytesTotal > $bytesDone ? (int) (($bytesTotal - $bytesDone) / $speed) : null,
        ]);
    }
}
