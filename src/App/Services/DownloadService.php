<?php

declare(strict_types=1);

namespace App\Services;

use App\Core\Database;
use App\Storage\StorageManager;
use App\Support\Crypto;
use App\Support\PathGuard;
use RuntimeException;

/**
 * One-shot download tokens (folder downloads prepared by background jobs,
 * and any future "generate a link" feature). Tokens live in the settings
 * table encrypted, expire, and are consumed on first use.
 */
final class DownloadService
{
    private const TOKEN_TTL = 900; // 15 minutes

    /**
     * Pack a folder into a zip stored in the data tmp dir; returns a token.
     * @param callable(int,int,string):void $progress
     * @return array<string,mixed>
     */
    public static function packFolder(string $mountName, string $path, callable $progress, string $jobId): array
    {
        $job = JobService::get($jobId);
        if ($job === null) {
            throw new RuntimeException('Job context missing');
        }
        $user = \App\Jobs\Handlers\AbstractHandler::userById((int) $job['user_id']);

        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        if (!$adapter->isDir($norm)) {
            throw new RuntimeException('Not a folder');
        }

        $tmpDir = \App\Config\Config::i()->dataDir() . '/tmp';
        if (!is_dir($tmpDir)) {
            @mkdir($tmpDir, 0770, true);
        }
        $zipPath = $tmpDir . '/dl-' . $jobId . '.zip';

        // Build a local temp mirror of the folder tree, then zip it with ext-zip
        // (works identically for every adapter since it reads via getStream).
        $stageDir = $tmpDir . '/stage-' . $jobId;
        if (!is_dir($stageDir) && !@mkdir($stageDir, 0770, true)) {
            throw new RuntimeException('Cannot create staging directory');
        }
        self::stage($adapter, $norm, $stageDir, $stageDir, $progress, $jobId);

        $progress(70, 100, 'Compressing');
        $zip = new \ZipArchive();
        if ($zip->open($zipPath, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
            throw new RuntimeException('Cannot create zip archive');
        }
        $files = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($stageDir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::LEAVES_ONLY
        );
        foreach ($files as $f) {
            /** @var \SplFileInfo $f */
            if (!$f->isFile()) {
                continue;
            }
            $local = substr($f->getPathname(), strlen($stageDir) + 1);
            $zip->addFile($f->getPathname(), str_replace(DIRECTORY_SEPARATOR, '/', $local));
        }
        $zip->close();

        // Remove staged copy.
        self::rrmdir($stageDir);

        $token = bin2hex(random_bytes(24));
        $payload = json_encode([
            'file' => $zipPath,
            'name' => PathGuard::basename($norm) . '.zip',
            'size' => (int) (filesize($zipPath) ?: 0),
            'user' => $user->id,
        ], JSON_UNESCAPED_UNICODE);
        Database::i()->run(
            'INSERT INTO settings (k, v, updated_at) VALUES (:k, :v, datetime(\'now\'))
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime(\'now\')',
            [':k' => 'dltoken:' . $token, ':v' => Crypto::encrypt((string) $payload)]
        );

        $progress(100, 100, 'Ready');
        return ['token' => $token, 'name' => PathGuard::basename($norm) . '.zip', 'size' => (int) (filesize($zipPath) ?: 0)];
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
        } catch (\Throwable) {
            return null;
        }
        if (!is_array($payload) || (int) ($payload['user'] ?? -1) !== $userId) {
            return null;
        }
        $file = (string) ($payload['file'] ?? '');
        // Token must be fresh.
        if (!is_file($file) || (time() - (int) filemtime($file)) > self::TOKEN_TTL * 8) {
            @unlink($file);
            return null;
        }
        return [
            'file' => $file,
            'name' => (string) ($payload['name'] ?? 'download.zip'),
            'size' => (int) ($payload['size'] ?? 0),
        ];
    }

    /** @param callable(int,int,string):void $progress */
    private static function stage(\App\Storage\StorageAdapter $adapter, string $virt, string $stageRoot, string $stageDir, callable $progress, string $jobId): void
    {
        $entries = $adapter->list($virt);
        $total = max(1, count($entries));
        $i = 0;
        foreach ($entries as $e) {
            if (JobService::isCanceled($jobId)) {
                self::rrmdir($stageRoot);
                throw new RuntimeException('Job canceled');
            }
            $rel = self::relInside($virt, (string) $e['path']);
            $dest = $stageDir . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel);
            if (($e['type'] ?? '') === 'dir') {
                if (!is_dir($dest) && !@mkdir($dest, 0770, true)) {
                    throw new RuntimeException('Cannot stage directory');
                }
                self::stage($adapter, (string) $e['path'], $stageRoot, $dest, $progress, $jobId);
            } elseif (($e['type'] ?? '') === 'file') {
                $in = $adapter->getStream((string) $e['path']);
                $out = @fopen($dest, 'wb');
                if ($out === false) {
                    fclose($in);
                    throw new RuntimeException('Cannot stage file: ' . $e['name']);
                }
                stream_copy_to_stream($in, $out);
                fclose($out);
                fclose($in);
            }
            $i++;
            $progress($i, max(1, $total), (string) $e['name']);
        }
    }

    private static function relInside(string $base, string $child): string
    {
        if ($child === $base) {
            return '';
        }
        return substr($child, strlen($base) + 1);
    }

    private static function rrmdir(string $dir): void
    {
        if (!is_dir($dir)) {
            return;
        }
        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            if ($item->isDir()) {
                @rmdir($item->getPathname());
            } else {
                @unlink($item->getPathname());
            }
        }
        @rmdir($dir);
    }
}
