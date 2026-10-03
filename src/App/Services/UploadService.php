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
    /**
     * Store a batch of uploaded files.
     *
     * `$relPaths` (index-aligned with `$files`) carries each file's path
     * relative to the chosen folder, so a folder upload keeps its structure.
     * A missing entry falls back to the bare filename, which is the plain
     * multi-file upload behaviour.
     *
     * @param array<int,string> $relPaths
     */
    public static function handleUploadedFiles(
        AuthContext $user,
        string $mount,
        string $path,
        array $files,
        string $conflict = 'rename',
        array $relPaths = []
    ): array {
        $results = [];
        $dir = PathGuard::normalize($path);
        $index = 0;
        foreach ($files as $file) {
            $relPath = (string) ($relPaths[$index] ?? '');
            $index++;
            if (!is_array($file) || !isset($file['tmp_name']) || !is_uploaded_file((string) $file['tmp_name'])) {
                continue;
            }
            self::assertUploadSize((int) ($file['size'] ?? 0));

            // Prefer the explicit relPaths entry; fall back to PHP's own
            // `full_path` (populated for directory uploads) and then the name.
            if ($relPath === '') {
                $relPath = (string) ($file['full_path'] ?? '');
            }
            if ($relPath === '') {
                $relPath = (string) ($file['name'] ?? '');
            }
            $plan = self::planTarget($user, $mount, $dir, $relPath, $conflict);
            if ($plan['target'] === null) {
                $results[] = ['name' => $plan['name'], 'skipped' => true];
                continue;
            }
            $fh = fopen((string) $file['tmp_name'], 'rb');
            if ($fh === false) {
                throw new RuntimeException('Cannot read uploaded file');
            }
            try {
                $plan['adapter']->putStream($plan['target'], $fh);
            } finally {
                fclose($fh);
            }
            $stat = $plan['adapter']->stat($plan['target']);
            $results[] = ['name' => (string) $stat['name'], 'path' => $plan['target'], 'size' => (int) $stat['size']];
        }
        if ($results === []) {
            throw new InvalidArgumentException('No files received');
        }
        return $results;
    }

    /**
     * Work out where an upload should land, creating any directories its
     * relative path implies.
     *
     * @return array{adapter:\App\Storage\StorageAdapter,target:?string,name:string,dir:string}
     */
    private static function planTarget(
        AuthContext $user,
        string $mount,
        string $baseDir,
        string $relPath,
        string $conflict
    ): array {
        $segments = self::splitRelativePath($relPath);
        $name = (string) array_pop($segments);
        FileService::assertAllowedUpload($name);

        $destDir = $baseDir;
        foreach ($segments as $segment) {
            $destDir = PathGuard::join($destDir, $segment);
        }

        [$m, $adapter, $normDir] = StorageManager::resolve($user, $mount, $destDir);
        // A per-user read-only grant must block writes too; StorageManager alone
        // does not enforce canWrite.
        FileService::assertWritable($m, $adapter);

        if ($segments !== [] && !$adapter->isDir($normDir)) {
            $adapter->mkdir($normDir, true);
        }

        return [
            'adapter' => $adapter,
            'target' => self::conflictTarget($adapter, $normDir, $name, $conflict),
            'name' => $name,
            'dir' => $normDir,
        ];
    }

    /**
     * Split and validate a relative upload path.
     *
     * Every segment goes through PathGuard::validateName, so separators, control
     * characters and over-long names are rejected — and `..` is refused outright.
     * Traversal is therefore impossible even though the client controls the path.
     *
     * @return array<int,string>
     */
    private static function splitRelativePath(string $relPath): array
    {
        $rel = str_replace('\\', '/', trim($relPath));
        $parts = [];
        foreach (explode('/', $rel) as $part) {
            $part = trim($part);
            if ($part === '' || $part === '.') {
                continue;
            }
            if ($part === '..') {
                throw new InvalidArgumentException('Upload path must not contain ".."');
            }
            $parts[] = PathGuard::validateName($part);
        }
        if ($parts === []) {
            throw new InvalidArgumentException('Empty upload path');
        }
        return $parts;
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
        // Large files inside a folder upload carry a relative path too.
        $relPath = (string) ($body['relPath'] ?? '');
        $total = Validator::int($body['total'] ?? 0, 1, 1000000, 'total');
        $conflict = in_array($body['conflict'] ?? 'rename', ['overwrite', 'skip', 'rename'], true)
            ? (string) ($body['conflict'] ?? 'rename') : 'rename';

        $stage = self::stageDir($user->id, $uploadId);
        if (!is_dir($stage)) {
            throw new RuntimeException('Upload session missing', 404);
        }

        $plan = self::planTarget($user, $mount, $dir, $relPath !== '' ? $relPath : (string) ($body['name'] ?? ''), $conflict);
        $adapter = $plan['adapter'];
        $target = $plan['target'];
        $name = $plan['name'];
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