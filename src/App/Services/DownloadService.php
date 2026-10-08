<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Jobs\Handlers\AbstractHandler;
use App\Storage\StorageAdapter;
use App\Storage\StorageManager;
use App\Support\Crypto;
use App\Support\PathGuard;
use App\Support\ZipStreamWriter;
use RuntimeException;
use Throwable;

/**
 * Server-side download packaging.
 *
 * A browser cannot zip a folder: it never sees the bytes until they arrive. So
 * folders (and multi-item selections) are packed here and handed to the client
 * as a one-shot token, which `GET /api/download/{token}` streams back.
 *
 * The archive is produced by `ZipStreamWriter`, which writes entries straight
 * to disk in 256 KB chunks — no staging tree, no whole-file buffering, so a
 * 40 GB folder costs the same memory as a 4 KB one.
 *
 * Tokens are single-use, expire, and are bound to the user who asked for them.
 */
final class DownloadService
{
    /** How long a prepared archive stays downloadable. */
    private const TOKEN_TTL = 900; // 15 minutes

    /** Nothing is streamed faster than this through the progress callback. */
    private const PROGRESS_CHUNK = 4 * 1024 * 1024;

    /**
     * Pack a set of entries (files and/or folders) into one zip.
     *
     * @param array<int,string>                                        $paths
     * @param callable(int,int,string,array<string,mixed>):void        $progress
     * @return array<string,mixed>
     */
    public static function packSelection(string $mountName, array $paths, string $archiveName, callable $progress, string $jobId): array
    {
        $job = JobService::get($jobId);
        if ($job === null) {
            throw new RuntimeException('Job context missing');
        }
        $user = AbstractHandler::userById((int) $job['user_id']);
        [$mount, $adapter] = StorageManager::resolve($user, $mountName, '/');

        $paths = array_values(array_filter(array_map(
            static fn ($p): string => PathGuard::normalize((string) $p),
            $paths
        ), static fn (string $p): bool => $p !== ''));
        if (!$paths) {
            throw new RuntimeException('Nothing selected to download');
        }

        $tmpDir = self::tmpDir();
        $zipPath = $tmpDir . '/dl-' . $jobId . '.zip';

        // Pass 1: enumerate, so progress can be expressed in bytes rather than
        // in "3 of 200 files" (which crawls on a folder of a few large files).
        $progress(0, 1, 'Scanning selection', ['phase' => 'scan']);
        $plan = [];
        $totalBytes = 0;
        foreach ($paths as $p) {
            $norm = PathGuard::normalize($p);
            $stat = $adapter->stat($norm);
            if (($stat['type'] ?? '') === 'dir') {
                self::enumerate($adapter, $norm, PathGuard::basename($norm), $plan, $totalBytes, $jobId);
            } elseif (($stat['type'] ?? '') === 'file') {
                $plan[] = ['path' => $norm, 'arc' => PathGuard::basename($norm), 'size' => (int) ($stat['size'] ?? 0), 'mtime' => (int) ($stat['mtime'] ?? 0)];
                $totalBytes += (int) ($stat['size'] ?? 0);
            }
        }
        if (!$plan) {
            throw new RuntimeException('The selection contains no files');
        }

        $out = @fopen($zipPath, 'wb');
        if ($out === false) {
            throw new RuntimeException('Cannot create the archive file');
        }
        $zip = new ZipStreamWriter($out, true);

        try {
            $doneBytes = 0;
            $started = microtime(true);
            $lastPush = 0;
            $count = count($plan);
            foreach ($plan as $i => $item) {
                if (JobService::isCanceled($jobId)) {
                    throw new RuntimeException('Job canceled');
                }
                if (!empty($item['dir'])) {
                    // Empty folders would otherwise vanish from the archive.
                    $zip->addDirectory($item['arc'], (int) $item['mtime']);
                } else {
                    $stream = $adapter->getStream($item['path']);
                    try {
                        $zip->addFile($item['arc'], $stream, (int) $item['size'], (int) $item['mtime']);
                    } catch (Throwable $e) {
                        // One unreadable file must not kill the whole archive.
                        error_log('[ansnew] download: skipping ' . $item['path'] . ': ' . $e->getMessage());
                    } finally {
                        if (is_resource($stream)) {
                            fclose($stream);
                        }
                    }
                }
                $doneBytes += (int) $item['size'];

                if ($doneBytes - $lastPush >= self::PROGRESS_CHUNK || $i === $count - 1) {
                    $lastPush = $doneBytes;
                    $elapsed = max(0.001, microtime(true) - $started);
                    $speed = (int) ($doneBytes / $elapsed);
                    $eta = $speed > 0 ? (int) (($totalBytes - $doneBytes) / $speed) : null;
                    $progress($i + 1, $count, PathGuard::basename($item['path']), [
                        'phase' => 'pack',
                        'bytesDone' => $doneBytes,
                        'bytesTotal' => $totalBytes,
                        'speed' => $speed,
                        'etaSeconds' => $eta,
                    ]);
                }
            }
            $summary = $zip->finish();
        } finally {
            fclose($out);
        }

        return self::register($user, $zipPath, self::safeName($archiveName, 'download.zip'), $summary['bytes']);
    }

    /**
     * Backwards-compatible single-folder entry point.
     *
     * @param callable(int,int,string,array<string,mixed>):void $progress
     * @return array<string,mixed>
     */
    public static function packFolder(string $mountName, string $path, callable $progress, string $jobId): array
    {
        $norm = PathGuard::normalize($path);
        $name = PathGuard::basename($norm);
        return self::packSelection($mountName, [$norm], $name . '.zip', $progress, $jobId);
    }

    /**
     * Walk a folder into the plan. Directories become explicit entries so empty
     * folders survive the round trip.
     *
     * @param array<int,array<string,mixed>> $plan
     */
    private static function enumerate(
        StorageAdapter $adapter,
        string $dir,
        string $arcBase,
        array &$plan,
        int &$totalBytes,
        string $jobId
    ): void {
        if (JobService::isCanceled($jobId)) {
            throw new RuntimeException('Job canceled');
        }
        $plan[] = ['path' => $dir, 'arc' => rtrim($arcBase, '/') . '/', 'size' => 0, 'mtime' => 0, 'dir' => true];
        $entries = $adapter->list($dir);
        foreach ($entries as $e) {
            if (JobService::isCanceled($jobId)) {
                throw new RuntimeException('Job canceled');
            }
            $p = (string) $e['path'];
            $arc = $arcBase . '/' . (string) $e['name'];
            if (($e['type'] ?? '') === 'dir') {
                self::enumerate($adapter, $p, $arc, $plan, $totalBytes, $jobId);
            } elseif (($e['type'] ?? '') === 'file') {
                $plan[] = [
                    'path' => $p,
                    'arc' => $arc,
                    'size' => (int) ($e['size'] ?? 0),
                    'mtime' => (int) ($e['mtime'] ?? 0),
                ];
                $totalBytes += (int) ($e['size'] ?? 0);
            }
        }
    }

    /**
     * Store a download token for the finished archive.
     * @return array<string,mixed>
     */
    private static function register(AuthContext $user, string $file, string $name, int $size): array
    {
        $token = bin2hex(random_bytes(24));
        $payload = json_encode([
            'file' => $file,
            'name' => $name,
            'size' => $size,
            'user' => $user->id,
            'created' => time(),
        ], JSON_UNESCAPED_UNICODE);
        Database::i()->run(
            'INSERT INTO settings (k, v, updated_at) VALUES (:k, :v, datetime(\'now\'))
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime(\'now\')',
            [':k' => 'dltoken:' . $token, ':v' => Crypto::encrypt((string) $payload)]
        );
        return ['token' => $token, 'name' => $name, 'size' => $size];
    }

    /** Consume a token → file metadata (single use). Caller streams the file. */
    public static function consumeToken(int $userId, string $token): ?array
    {
        if (!preg_match('/^[0-9a-f]{48}$/', $token)) {
            return null;
        }
        $db = Database::i();
        $enc = $db->scalar('SELECT v FROM settings WHERE k = :k', [':k' => 'dltoken:' . $token]);
        if (!is_string($enc) || $enc === '') {
            return null;
        }
        // Single use: delete first, then decode.
        $db->run('DELETE FROM settings WHERE k = :k', [':k' => 'dltoken:' . $token]);
        try {
            $payload = json_decode(Crypto::decrypt($enc), true);
        } catch (Throwable) {
            return null;
        }
        if (!is_array($payload) || (int) ($payload['user'] ?? -1) !== $userId) {
            return null;
        }
        $file = (string) ($payload['file'] ?? '');
        $created = (int) ($payload['created'] ?? 0);
        if (!is_file($file) || $created <= 0 || (time() - $created) > self::TOKEN_TTL * 8) {
            @unlink($file);
            return null;
        }
        return [
            'file' => $file,
            'name' => (string) ($payload['name'] ?? 'download.zip'),
            'size' => (int) ($payload['size'] ?? 0),
        ];
    }

    /** Delete archives that were never redeemed (called from the worker sweep). */
    public static function sweepTmp(int $maxAgeSeconds = 86400): int
    {
        $dir = self::tmpDir();
        $removed = 0;
        foreach (glob($dir . '/dl-*.zip') ?: [] as $file) {
            if (is_file($file) && (time() - (int) filemtime($file)) > $maxAgeSeconds) {
                @unlink($file);
                $removed++;
            }
        }
        return $removed;
    }

    private static function tmpDir(): string
    {
        $dir = \App\Config\Config::i()->dataDir() . '/tmp';
        if (!is_dir($dir)) {
            @mkdir($dir, 0770, true);
        }
        return $dir;
    }

    /** Keep the download name filesystem- and header-safe. */
    private static function safeName(string $name, string $fallback): string
    {
        $name = PathGuard::basename(str_replace('\\', '/', trim($name)));
        $name = preg_replace('/[\x00-\x1F\x7F]/', '', $name) ?? '';
        if ($name === '' || $name === '.' || $name === '..') {
            return $fallback;
        }
        if (!str_ends_with(strtolower($name), '.zip')) {
            $name .= '.zip';
        }
        return mb_substr($name, 0, 180);
    }
}
