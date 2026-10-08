<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\BackupService;
use App\Services\JobService;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use RuntimeException;
use Throwable;

/**
 * backup-verify: check that a finished backup really contains everything the
 * manifest says it should.
 *
 * Default pass compares existence and size (fast, works on every adapter).
 * `deep` additionally hashes both sides with SHA-1, streaming, so a large
 * verification still runs in constant memory.
 *
 * params: {backupId, userId, deep}
 */
final class BackupVerifyHandler extends AbstractHandler
{
    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $id = (string) ($params['backupId'] ?? '');
        $row = BackupService::row($id);
        if ($row === null) {
            throw new RuntimeException('Backup not found');
        }
        $deep = !empty($params['deep']);

        try {
            $report = self::verifyNow($id, $jobId, $deep);
            BackupService::setStatus(
                $id,
                $report['ok'] ? 'verified' : 'verify-failed',
                $report['ok'] ? 'verified' : 'verify-failed',
                $report['ok'] ? null : ($report['missing'] . ' file(s) did not match the backup manifest')
            );
            JobService::progress($jobId, 100, $report['ok'] ? 'Verification passed' : 'Verification failed');
            return ['backupId' => $id] + $report;
        } catch (Throwable $e) {
            if (!JobService::isCanceled($jobId)) {
                BackupService::setStatus($id, 'verify-failed', 'verify-failed', $e->getMessage());
            }
            throw $e;
        }
    }

    /**
     * Run the comparison. Also called inline by BackupHandler when a backup was
     * started with verification switched on.
     *
     * @return array<string,mixed>
     */
    public static function verifyNow(string $backupId, string $jobId, bool $deep): array
    {
        $row = BackupService::row($backupId);
        if ($row === null) {
            throw new RuntimeException('Backup not found');
        }
        $user = self::userById((int) $row['user_id']);
        [, $srcAdapter, $srcNorm] = StorageManager::resolve($user, (string) $row['source_mount'], (string) $row['source_path']);
        [, $destAdapter, $destRoot] = StorageManager::resolve($user, (string) $row['dest_mount'], (string) $row['dest_path']);

        $fh = BackupService::openManifest($backupId, 'rb');
        if ($fh === null) {
            throw new RuntimeException('Backup manifest is missing — the backup cannot be verified');
        }

        $checked = 0;
        $missing = [];
        $mismatch = [];
        $dirs = 0;
        $started = microtime(true);

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
                if ($checked % 100 === 0) {
                    self::checkCancel($jobId);
                }
                $rel = (string) $item['p'];
                $srcPath = PathGuard::join($srcNorm, $rel);
                $destPath = PathGuard::join($destRoot, $rel);

                if (!empty($item['d'])) {
                    if (!$destAdapter->isDir($destPath)) {
                        $missing[] = $rel;
                    } else {
                        $dirs++;
                    }
                    continue;
                }

                $expected = (int) ($item['s'] ?? 0);
                if (!$destAdapter->exists($destPath)) {
                    $missing[] = $rel;
                } else {
                    $stat = $destAdapter->stat($destPath);
                    if (($stat['type'] ?? '') !== 'file' || (int) ($stat['size'] ?? -1) !== $expected) {
                        $mismatch[] = $rel;
                    } elseif ($deep && !self::sameHash($srcAdapter, $srcPath, $destAdapter, $destPath)) {
                        $mismatch[] = $rel;
                    }
                }
                $checked++;
                if ($checked % 250 === 0) {
                    $pct = (int) min(99, 5 + 90 * $checked / max(1, $checked + 1));
                    self::progress($jobId, $pct, 'Verifying — ' . number_format($checked) . ' files', [
                        'phase' => 'verify',
                        'backupId' => $backupId,
                        'filesDone' => $checked,
                    ]);
                }
            }
        } finally {
            fclose($fh);
        }

        $report = [
            'ok' => $missing === [] && $mismatch === [],
            'checked' => $checked,
            'dirs' => $dirs,
            'missing' => count($missing),
            'mismatch' => count($mismatch),
            'missingSample' => array_slice($missing, 0, 20),
            'mismatchSample' => array_slice($mismatch, 0, 20),
            'deep' => $deep,
            'seconds' => (int) max(1, microtime(true) - $started),
        ];
        self::progress($jobId, 99, 'Verifying', [
            'phase' => 'verify',
            'backupId' => $backupId,
            'filesDone' => $checked,
        ] + $report);
        return $report;
    }

    /** Streaming SHA-1 comparison — constant memory regardless of file size. */
    private static function sameHash($src, string $srcPath, $dest, string $destPath): bool
    {
        $a = self::hashOf($src, $srcPath);
        $b = self::hashOf($dest, $destPath);
        return $a !== null && $b !== null && hash_equals($a, $b);
    }

    private static function hashOf($adapter, string $path): ?string
    {
        $stream = null;
        try {
            $stream = $adapter->getStream($path);
            $ctx = hash_init('sha1');
            while (!feof($stream)) {
                $chunk = fread($stream, 262144);
                if ($chunk === false || $chunk === '') {
                    break;
                }
                hash_update($ctx, $chunk);
            }
            return hash_final($ctx);
        } catch (Throwable) {
            return null;
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
        }
    }
}
