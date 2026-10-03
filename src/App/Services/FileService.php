<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Services\JobService;
use App\Storage\Mount;
use App\Storage\StorageAdapter;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use App\Support\Validator;
use InvalidArgumentException;
use RuntimeException;
use Throwable;

/**
 * High-level file operations shared by REST controllers and background jobs.
 * All paths are mount-relative virtual paths; authorization happens in
 * StorageManager::resolve() before anything touches a filesystem.
 */
final class FileService
{
    /** @return array<string,mixed> */
    public static function list(AuthContext $user, string $mountName, string $path): array
    {
        /** @var Mount $mount */
        /** @var StorageAdapter $adapter */
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        if (!$adapter->isDir($norm)) {
            throw new RuntimeException('Not a directory', 404);
        }
        $entries = $adapter->list($norm);
        // The trash directory is an implementation detail of TrashService (it has
        // its own UI view). Hide it from the user-facing listing of a local mount
        // root so it does not show up as ordinary user content.
        if ($norm === '/' && $mount->adapter === 'local') {
            $entries = array_values(array_filter(
                $entries,
                static fn (array $e): bool => (string) ($e['name'] ?? '') !== TrashService::TRASH_DIR
            ));
        }
        return [
            'mount' => $mount->publicInfo(),
            'path' => $norm,
            'parent' => $norm === '/' ? null : PathGuard::dirname($norm),
            'entries' => $entries,
            'etag' => self::fingerprint($entries),
        ];
    }

    /**
     * Cheap content fingerprint for conditional GETs (ETag / If-None-Match).
     *
     * Deliberately computed from the *final* entry array — after encryption
     * adapters have patched sizes and after the trash directory has been
     * filtered — so the value is deterministic and changes exactly when the
     * client-visible listing changes. One sha1 over ~4 fields per entry.
     *
     * @param array<int,array<string,mixed>> $entries
     */
    public static function fingerprint(array $entries): string
    {
        $parts = [];
        foreach ($entries as $e) {
            $parts[] = (string) ($e['name'] ?? '')
                . "\0" . (string) ($e['type'] ?? '')
                . "\0" . (string) ($e['size'] ?? '')
                . "\0" . (string) ($e['mtime'] ?? '');
        }
        return hash('sha1', implode("\1", $parts));
    }

    public static function mkdir(AuthContext $user, string $mountName, string $path, string $name): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        $name = PathGuard::validateName($name);
        $target = PathGuard::join($norm, $name);
        if ($adapter->exists($target)) {
            throw new RuntimeException('Already exists');
        }
        $adapter->mkdir($target, true);
        return ['path' => $target, 'name' => $name];
    }

    public static function createFile(AuthContext $user, string $mountName, string $path, string $name): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        $name = PathGuard::validateName($name);
        self::assertAllowedUpload($name);
        $target = PathGuard::join($norm, $name);
        if ($adapter->exists($target)) {
            throw new RuntimeException('Already exists');
        }
        $fh = fopen('php://memory', 'rb');
        if ($fh === false) {
            throw new RuntimeException('Internal error');
        }
        try {
            $adapter->putStream($target, $fh);
        } finally {
            fclose($fh);
        }
        return ['path' => $target, 'name' => $name];
    }

    public static function rename(AuthContext $user, string $mountName, string $path, string $newName): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        $newName = PathGuard::validateName($newName);
        if ($norm === '/') {
            throw new RuntimeException('Cannot rename the mount root');
        }
        $target = PathGuard::join(PathGuard::dirname($norm), $newName);
        if ($target === $norm) {
            return ['path' => $norm, 'name' => $newName];
        }
        if ($adapter->exists($target)) {
            throw new RuntimeException('Target already exists');
        }
        $adapter->rename($norm, $target);
        return ['path' => $target, 'name' => $newName];
    }

    /** Inline copy of a single entry (used for small files; big ones go to jobs). */
    public static function copyInline(AuthContext $user, string $mountName, string $path, string $destDir, string $conflict = 'rename'): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        [, , $destNorm] = StorageManager::resolve($user, $mountName, $destDir);
        $target = self::conflictTarget($adapter, $destNorm, PathGuard::basename($norm), $conflict);
        if ($target === null) {
            return ['skipped' => true];
        }
        $adapter->copy($norm, $target);
        return ['path' => $target];
    }

    /** Small server-side move/rename across dirs within one mount. */
    public static function moveInline(AuthContext $user, string $mountName, string $path, string $destDir, string $conflict = 'rename'): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        [, , $destNorm] = StorageManager::resolve($user, $mountName, $destDir);
        if ($norm === $destNorm || str_starts_with($destNorm . '/', $norm . '/')) {
            throw new RuntimeException('Invalid move target');
        }
        $target = self::conflictTarget($adapter, $destNorm, PathGuard::basename($norm), $conflict);
        if ($target === null) {
            $adapter->delete($norm, true);
            return ['skipped' => true];
        }
        $adapter->rename($norm, $target);
        return ['path' => $target];
    }

    /**
     * Cross-mount / recursive copy executed by a background job.
     * @param callable(int,int,string):void $progress
     * @return array<string,mixed>
     */
    public static function copyTransfer(string $mountName, string $path, string $destMount, string $destDir, string $conflict, callable $progress, string $jobId): array
    {
        return self::transfer($mountName, $path, $destMount, $destDir, $conflict, $progress, false, $jobId);
    }

    /**
     * Cross-mount / recursive move executed by a background job (copy + delete source).
     * @param callable(int,int,string):void $progress
     * @return array<string,mixed>
     */
    public static function moveTransfer(string $mountName, string $path, string $destMount, string $destDir, string $conflict, callable $progress, string $jobId): array
    {
        return self::transfer($mountName, $path, $destMount, $destDir, $conflict, $progress, true, $jobId);
    }

    /**
     * Recursive transfer between two resolved locations. Uses per-entry adapter
     * copies when on the same adapter; streams file contents across adapters.
     * @param callable(int,int,string):void $progress
     * @return array<string,mixed>
     */
    private static function transfer(string $mountName, string $path, string $destMount, string $destDir, string $conflict, callable $progress, bool $deleteSource, string $jobId): array
    {
        $job = JobService::get($jobId);
        if ($job === null) {
            throw new RuntimeException('Job context missing');
        }
        $user = \App\Jobs\Handlers\AbstractHandler::userById((int) $job['user_id']);
        [$mount, $srcAdapter, $src] = StorageManager::resolve($user, $mountName, $path);
        [$destM, $dstAdapter, $dest] = StorageManager::resolve($user, $destMount, $destDir);
        self::assertWritable($destM, $dstAdapter);

        if ($src === '/') {
            throw new RuntimeException('Refusing to transfer the mount root');
        }
        if ($mountName === $destMount && (str_starts_with($dest . '/', $src . '/'))) {
            throw new RuntimeException('Cannot transfer into itself');
        }

        // 1. enumerate work
        $files = [];
        $dirs = [];
        self::enumerate($srcAdapter, $src, $dirs, $files);
        $total = count($files) + count($dirs);
        $done = 0;

        $baseName = PathGuard::basename($src);
        $target = self::conflictTarget($dstAdapter, $dest, $baseName, $conflict);
        if ($target === null) {
            return ['skipped' => true, 'files' => 0];
        }
        $dstAdapter->mkdir($target, true);
        $done++;
        $progress($done, max(1, $total), $baseName);

        // 2. create directory skeleton (paths relative to the transfer root)
        $createdDirs = [$src => $target];
        foreach ($dirs as $dir) {
            $rel = self::relInside($src, $dir);
            $dstPath = PathGuard::join($target, $rel);
            if (!$dstAdapter->exists($dstPath)) {
                $dstAdapter->mkdir($dstPath, true);
            }
            $createdDirs[$dir] = $dstPath;
            $done++;
            $progress($done, max(1, $total), PathGuard::basename($dir));
        }

        // 3. copy files
        $bytes = 0;
        foreach ($files as $file) {
            $rel = self::relInside($src, $file['path']);
            $dstPath = PathGuard::join($target, $rel);
            $in = $srcAdapter->getStream($file['path']);
            try {
                $bytes += $dstAdapter->putStream($dstPath, $in);
            } finally {
                if (is_resource($in)) {
                    fclose($in);
                }
            }
            $done++;
            $progress($done, max(1, $total), (string) $file['name']);
        }

        // 4. optional source delete
        if ($deleteSource) {
            self::assertWritable($mount, $srcAdapter);
            $srcAdapter->delete($src, true);
        }

        return ['path' => $target, 'files' => count($files), 'bytes' => $bytes];
    }

    /**
     * @param StorageAdapter $adapter
     * @param array<int, array<string,mixed>> $dirs
     * @param array<int, array<string,mixed>> $files
     */
    private static function enumerate(StorageAdapter $adapter, string $dir, array &$dirs, array &$files): void
    {
        foreach ($adapter->list($dir) as $entry) {
            $p = (string) $entry['path'];
            if (($entry['type'] ?? '') === 'dir') {
                $dirs[] = ['path' => $p, 'name' => $entry['name']];
                self::enumerate($adapter, $p, $dirs, $files);
            } elseif (($entry['type'] ?? '') === 'file') {
                $files[] = ['path' => $p, 'name' => $entry['name']];
            }
        }
    }

    /** Path of $child relative to $base (both normalized, $child inside $base). */
    private static function relInside(string $base, string $child): string
    {
        if ($child === $base) {
            return '';
        }
        $rel = substr($child, strlen($base) + 1);
        return $rel !== '' ? $rel : PathGuard::basename($child);
    }

    /** Resolve the destination path applying the conflict policy. */
    private static function conflictTarget(StorageAdapter $adapter, string $destDir, string $name, string $conflict): ?string
    {
        $base = PathGuard::join($destDir, $name);
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
        // rename → "name (2).ext", "name (3).ext", ...
        $dot = strrpos($name, '.');
        $stem = $dot !== false && $dot !== 0 ? substr($name, 0, $dot) : $name;
        $ext = $dot !== false && $dot !== 0 ? substr($name, $dot) : '';
        for ($i = 2; $i < 1000; $i++) {
            $candidate = PathGuard::join($destDir, $stem . ' (' . $i . ')' . $ext);
            if (!$adapter->exists($candidate)) {
                return $candidate;
            }
        }
        throw new RuntimeException('No free name for conflict rename');
    }

    /**
     * Reject a write the user is not entitled to make.
     *
     * StorageManager::resolve() only decides *visibility*; per-user write denial
     * lives here, so every write path (uploads included) must call it.
     */
    public static function assertWritable(Mount $mount, StorageAdapter $adapter): void
    {
        if (!$mount->canWrite) {
            throw new RuntimeException('This mount is read-only or you lack write access', 403);
        }
    }

    /** Upload name policy (shared by upload + create-file paths). */
    public static function assertAllowedUpload(string $name): void
    {
        $ext = strtolower((string) pathinfo($name, PATHINFO_EXTENSION));
        if ($ext !== '' && in_array($ext, Validator::FORBIDDEN_UPLOAD_EXT, true)) {
            throw new InvalidArgumentException('File type not allowed: ' . $ext);
        }
        if (str_contains($name, '..') || substr_count($name, '.') > 4) {
            throw new InvalidArgumentException('Suspicious file name');
        }
    }
}
