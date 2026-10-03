<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use App\Support\Validator;
use InvalidArgumentException;
use RuntimeException;

/**
 * Upload handling: direct multipart uploads and chunked uploads for large
 * files. Chunks are staged under data/tmp and assembled via putStream.
 */
final class UploadService
{
    public static function handleUploadedFiles(AuthContext $user, string $mount, string $path, array $files, string $conflict = 'rename'): array
    {
        $results = [];
        $dir = PathGuard::normalize($path);
        foreach ($files as $file) {
            if (!is_array($file) || !isset($file['tmp_name']) || !is_uploaded_file((string) $file['tmp_name'])) {
                continue;
            }
            $name = PathGuard::validateName((string) ($file['name'] ?? ''));
            FileService::assertAllowedUpload($name);
            self::assertUploadSize((int) ($file['size'] ?? 0));

            [, $adapter, ] = StorageManager::resolve($user, $mount, $dir);
            $target = self::conflictTarget($adapter, $dir, $name, $conflict);
            if ($target === null) {
                $results[] = ['name' => $name, 'skipped' => true];
                continue;
            }
            $fh = fopen((string) $file['tmp_name'], 'rb');
            if ($fh === false) {
                throw new RuntimeException('Cannot read uploaded file');
            }
            try {
                $adapter->putStream($target, $fh);
            } finally {
                fclose($fh);
            }
            $stat = $adapter->stat($target);
            $results[] = ['name' => (string) $stat['name'], 'path' => $target, 'size' => (int) $stat['size']];
        }
        if ($results === []) {
            throw new InvalidArgumentException('No files received');
        }
        return $results;
    }

    public static function storeChunk(AuthContext $user, string $mount, array $body, array $files): array
    {
        $uploadId = preg_replace('/[^a-zA-Z0-9-]/', '', (string) ($body['uploadId'] ?? ''));
        if ($uploadId === '' || strlen($uploadId) > 64) {
            throw new InvalidArgumentException('Invalid uploadId');
        }
        $index = Validator::int($body['index'] ?? -1, 0, 1000000, 'index');
        $file = $files[0] ?? null;
        if (!is_array($file) || !isset($file['tmp_name']) || !is_uploaded_file((string) $file['tmp_name'])) {
            throw new InvalidArgumentException('Missing chunk payload');
        }

        $stage = self::stageDir($user->id, $uploadId);
        if (!is_dir($stage)) {
            @mkdir($stage, 0770, true);
        }
        $dest = $stage . '/chunk-' . sprintf('%06d', $index);
        if (!move_uploaded_file((string) $file['tmp_name'], $dest)) {
            throw new RuntimeException('Failed to store chunk');
        }
        return ['received' => true, 'index' => $index];
    }

    public static function complete(AuthContext $user, string $mount, array $body): array
    {
        $uploadId = preg_replace('/[^a-zA-Z0-9-]/', '', (string) ($body['uploadId'] ?? ''));
        if ($uploadId === '') {
            throw new InvalidArgumentException('Invalid uploadId');
        }
        $dir = PathGuard::normalize((string) ($body['path'] ?? '/'));
        $name = PathGuard::validateName((string) ($body['name'] ?? ''));
        FileService::assertAllowedUpload($name);
        $total = Validator::int($body['total'] ?? 0, 1, 1000000, 'total');
        $conflict = in_array($body['conflict'] ?? 'rename', ['overwrite', 'skip', 'rename'], true)
            ? (string) ($body['conflict'] ?? 'rename') : 'rename';

        $stage = self::stageDir($user->id, $uploadId);
        if (!is_dir($stage)) {
            throw new RuntimeException('Upload session missing', 404);
        }

        [, $adapter, ] = StorageManager::resolve($user, $mount, $dir);
        $target = self::conflictTarget($adapter, $dir, $name, $conflict);
        if ($target === null) {
            self::rrmdir($stage);
            return ['skipped' => true];
        }

        // Assemble chunk-by-chunk through putStream.
        $out = tmpfile();
        if ($out === false) {
            throw new RuntimeException('Cannot create assembly buffer');
        }
        for ($i = 0; $i < $total; $i++) {
            $chunkFile = $stage . '/chunk-' . sprintf('%06d', $i);
            if (!is_file($chunkFile)) {
                fclose($out);
                throw new RuntimeException('Missing chunk ' . $i);
            }
            $in = fopen($chunkFile, 'rb');
            if ($in === false) {
                fclose($out);
                throw new RuntimeException('Cannot read chunk ' . $i);
            }
            stream_copy_to_stream($in, $out);
            fclose($in);
        }
        rewind($out);
        try {
            $adapter->putStream($target, $out);
        } finally {
            fclose($out);
        }
        self::rrmdir($stage);

        $stat = $adapter->stat($target);
        return ['name' => (string) $stat['name'], 'path' => $target, 'size' => (int) $stat['size']];
    }

    private static function assertUploadSize(int $bytes): void
    {
        $max = \App\Config\Config::i()->getInt('UPLOAD_MAX_BYTES', 2147483648);
        if ($bytes > $max) {
            throw new InvalidArgumentException('File exceeds the maximum allowed size');
        }
    }

    private static function stageDir(int $userId, string $uploadId): string
    {
        $base = \App\Config\Config::i()->dataDir() . '/tmp/up-' . $userId . '-' . $uploadId;
        // Containment: the id was sanitized; still verify no traversal remains.
        if (str_contains($base, '..')) {
            throw new RuntimeException('Invalid upload id');
        }
        return $base;
    }

    private static function conflictTarget(\App\Storage\StorageAdapter $adapter, string $dir, string $name, string $conflict): ?string
    {
        $base = PathGuard::join($dir, $name);
        if (!$adapter->exists($base)) {
            return $base;
        }
        if ($conflict === 'overwrite') {
            $adapter->delete($base, true);
            return $base;
        }
        if ($conflict === 'skip') {
            return null;
        }
        $dot = strrpos($name, '.');
        $stem = $dot !== false && $dot !== 0 ? substr($name, 0, $dot) : $name;
        $ext = $dot !== false && $dot !== 0 ? substr($name, $dot) : '';
        for ($i = 2; $i < 1000; $i++) {
            $candidate = PathGuard::join($dir, $stem . ' (' . $i . ')' . $ext);
            if (!$adapter->exists($candidate)) {
                return $candidate;
            }
        }
        throw new RuntimeException('No free name for conflict rename');
    }

    private static function rrmdir(string $dir): void
    {
        if (!is_dir($dir)) { return; }
        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
        }
        @rmdir($dir);
    }
}