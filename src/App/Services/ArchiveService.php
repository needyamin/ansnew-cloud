<?php

declare(strict_types=1);

namespace App\Services;

use App\Core\Database;
use App\Services\JobService;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use RuntimeException;

/**
 * Archive creation (zip / tar.gz) and extraction, implemented with PHP
 * streams + ext-zip / PharData — no shell, no command injection surface.
 * Works over every adapter because file contents flow through getStream.
 */
final class ArchiveService
{
    /** @param array<int,string> $paths @param callable(int,int,string):void $progress */
    public static function create(string $mount, array $paths, string $destDir, string $archiveName, string $format, callable $progress, string $jobId): array
    {
        $job = JobService::get($jobId);
        if ($job === null) {
            throw new RuntimeException('Job context missing');
        }
        $user = \App\Jobs\Handlers\AbstractHandler::userById((int) $job['user_id']);

        [, $adapter, $destNorm] = StorageManager::resolve($user, $mount, $destDir);
        if (!str_ends_with($archiveName, '.zip') && !str_ends_with($archiveName, '.tar.gz')) {
            $archiveName .= $format === 'zip' ? '.zip' : '.tar.gz';
        }
        $target = PathGuard::join($destNorm, $archiveName);
        if ($adapter->exists($target)) {
            $target = self::freeName($adapter, $destNorm, $archiveName);
        }

        $tmpDir = \App\Config\Config::i()->dataDir() . '/tmp';
        if (!is_dir($tmpDir)) { @mkdir($tmpDir, 0770, true); }
        $tmpFile = $tmpDir . '/arch-' . $jobId . '.' . ($format === 'zip' ? 'zip' : 'tar');

        // Stage selected entries into a temp dir (adapter-agnostic).
        $stage = $tmpDir . '/stage-' . $jobId;
        @mkdir($stage, 0770, true);
        $allFiles = [];
        $allDirs = [];
        $i = 0;
        foreach ($paths as $p) {
            $p = PathGuard::normalize($p);
            [, $a, $norm] = StorageManager::resolve($user, $mount, $p);
            $stat = $a->stat($norm);
            if (($stat['type'] ?? '') === 'dir') {
                $rootStage = $stage . '/' . PathGuard::basename($norm);
                $allDirs[] = $rootStage;
                self::stageRecursive($a, $norm, $rootStage, $allFiles, $allDirs, $progress, $jobId);
            } elseif (($stat['type'] ?? '') === 'file') {
                $dest = $stage . '/' . PathGuard::basename($norm);
                self::stageFile($a, $norm, $dest);
                // 'arc' must live under $stage so arcName() can strip the
                // staging prefix. A bare basename strips down to '' and makes
                // ZipArchive fall back to the full container path as the entry
                // name.
                $allFiles[] = ['disk' => $dest, 'arc' => $dest];
            }
            $i++;
            $progress($i, count($paths), PathGuard::basename($p));
        }

        // Compress from the staged tree.
        //
        // Note: ZipArchive/PharData write no file at all for an entry-less
        // archive, so compressing a folder that holds no files would leave
        // nothing to stream. Emitting a directory entry for every staged folder
        // that has no files beneath it both preserves empty folders in the
        // archive and guarantees at least one entry.
        $emptyDirs = [];
        foreach ($allDirs as $d) {
            if (self::hasNoFilesBeneath($d, $allFiles)) {
                $arc = self::arcName($stage, $d);
                if ($arc !== '') {
                    $emptyDirs[] = $arc;
                }
            }
        }

        if ($format === 'zip') {
            $zip = new \ZipArchive();
            if ($zip->open($tmpFile, \ZipArchive::CREATE | \ZipArchive::OVERWRITE) !== true) {
                self::rrmdir($stage);
                throw new RuntimeException('Cannot create zip');
            }
            foreach ($allFiles as $f) {
                if (JobService::isCanceled($jobId)) { $zip->unchangeAll(); $zip->close(); self::rrmdir($stage); throw new RuntimeException('Job canceled'); }
                $zip->addFile($f['disk'], self::arcName($stage, $f['arc']));
            }
            foreach ($emptyDirs as $dir) {
                $zip->addEmptyDir($dir);
            }
            $zip->close();
        } else {
            $phar = new \PharData($tmpFile . '.tar');
            foreach ($allFiles as $f) {
                if (JobService::isCanceled($jobId)) { self::rrmdir($stage); throw new RuntimeException('Job canceled'); }
                $phar->addFile($f['disk'], self::arcName($stage, $f['arc']));
            }
            foreach ($emptyDirs as $dir) {
                $phar->addEmptyDir($dir);
            }
            $phar->compress(\Phar::GZ, '.tar.gz');
            @unlink($tmpFile . '.tar');
            $tmpFile = $tmpFile . '.tar.gz';
        }
        self::rrmdir($stage);

        // Move the finished archive into the storage mount.
        $in = fopen($tmpFile, 'rb');
        if ($in === false) { throw new RuntimeException('Cannot read staged archive'); }
        try {
            $adapter->putStream($target, $in);
        } finally {
            fclose($in);
            @unlink($tmpFile);
        }

        $stat = $adapter->stat($target);
        return ['path' => $target, 'name' => (string) $stat['name'], 'size' => (int) $stat['size']];
    }

    /** @param callable(int,int,string):void $progress */
    public static function extract(string $mount, string $path, string $destDir, callable $progress, string $jobId): array
    {
        $job = JobService::get($jobId);
        if ($job === null) {
            throw new RuntimeException('Job context missing');
        }
        $user = \App\Jobs\Handlers\AbstractHandler::userById((int) $job['user_id']);

        [, $adapter, $norm] = StorageManager::resolve($user, $mount, $path);
        $stat = $adapter->stat($norm);
        if (($stat['type'] ?? '') !== 'file') {
            throw new RuntimeException('Not an archive file');
        }
        [, , $destNorm] = StorageManager::resolve($user, $mount, $destDir);

        $tmpDir = \App\Config\Config::i()->dataDir() . '/tmp';
        $ext = str_ends_with(strtolower((string) $stat['name']), '.zip') ? 'zip' : 'tar';
        $tmpFile = $tmpDir . '/ext-' . $jobId . '.' . $ext;

        // Pull the archive locally (adapter-agnostic).
        $in = $adapter->getStream($norm);
        $out = fopen($tmpFile, 'wb');
        if ($out === false) { fclose($in); throw new RuntimeException('Cannot stage archive'); }
        stream_copy_to_stream($in, $out);
        fclose($out); fclose($in);

        // Security: reject path traversal inside archives.
        $extractDir = $tmpDir . '/extout-' . $jobId;
        @mkdir($extractDir, 0770, true);

        if ($ext === 'zip') {
            $zip = new \ZipArchive();
            if ($zip->open($tmpFile) !== true) { throw new RuntimeException('Corrupt zip archive'); }
            for ($i = 0; $i < $zip->numFiles; $i++) {
                $entry = (string) $zip->getNameIndex($i);
                if (str_contains($entry, '..') || str_starts_with($entry, '/') || preg_match('/^[a-zA-Z]:/', $entry)) {
                    $zip->close();
                    self::rrmdir($extractDir); @unlink($tmpFile);
                    throw new RuntimeException('Unsafe path inside archive: ' . $entry);
                }
            }
            $zip->extractTo($extractDir);
            $zip->close();
        } else {
            $phar = new \PharData($tmpFile);
            foreach (new \RecursiveIteratorIterator($phar) as $f) {
                $rel = str_replace('\\', '/', (string) $f);
                $rel = preg_replace('#^phar://[^#]*tar(\.gz)?/#', '', $rel) ?? $rel;
                if (str_contains($rel, '..') || str_starts_with($rel, '/')) {
                    self::rrmdir($extractDir); @unlink($tmpFile);
                    throw new RuntimeException('Unsafe path inside archive');
                }
            }
            $phar->extractTo($extractDir, null, true);
        }
        @unlink($tmpFile);

        // Upload the extracted tree back through the adapter.
        $total = 0;
        $rootName = pathinfo((string) $stat['name'], PATHINFO_FILENAME);
        $destRoot = PathGuard::join($destNorm, $rootName);
        if (!$adapter->exists($destRoot)) {
            $adapter->mkdir($destRoot, true);
        }
        $it = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($extractDir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::LEAVES_ONLY
        );
        $files = [];
        foreach ($it as $f) {
            /** @var \SplFileInfo $f */
            if ($f->isFile()) { $files[] = $f; }
        }
        $total = max(1, count($files));
        $done = 0;
        foreach ($files as $f) {
            if (JobService::isCanceled($jobId)) { self::rrmdir($extractDir); throw new RuntimeException('Job canceled'); }
            $rel = substr($f->getPathname(), strlen($extractDir) + 1);
            $rel = str_replace(DIRECTORY_SEPARATOR, '/', $rel);
            $target = PathGuard::join($destRoot, $rel);
            $parent = PathGuard::dirname($target);
            if (!$adapter->exists($parent)) { $adapter->mkdir($parent, true); }
            $fh = fopen($f->getPathname(), 'rb');
            if ($fh === false) { continue; }
            try { $adapter->putStream($target, $fh); } finally { fclose($fh); }
            $done++;
            $progress($done, $total, $rel);
        }
        self::rrmdir($extractDir);

        return ['path' => $destRoot, 'files' => count($files)];
    }

    /** @param array<int,array{disk:string,arc:string}> $allFiles @param array<int,string> $allDirs @param callable(int,int,string):void $progress */
    private static function stageRecursive(\App\Storage\StorageAdapter $adapter, string $virt, string $stageDir, array &$allFiles, array &$allDirs, callable $progress, string $jobId): void
    {
        if (!is_dir($stageDir)) { @mkdir($stageDir, 0770, true); }
        foreach ($adapter->list($virt) as $e) {
            if (JobService::isCanceled($jobId)) { throw new RuntimeException('Job canceled'); }
            $childStage = $stageDir . '/' . PathGuard::basename((string) $e['path']);
            if (($e['type'] ?? '') === 'dir') {
                $allDirs[] = $childStage;
                self::stageRecursive($adapter, (string) $e['path'], $childStage, $allFiles, $allDirs, $progress, $jobId);
            } elseif (($e['type'] ?? '') === 'file') {
                self::stageFile($adapter, (string) $e['path'], $childStage);
                $allFiles[] = ['disk' => $childStage, 'arc' => $childStage];
            }
        }
    }

    /** True when no staged file lives inside $dir (i.e. it would vanish from the archive). */
    private static function hasNoFilesBeneath(string $dir, array $allFiles): bool
    {
        foreach ($allFiles as $f) {
            if (str_starts_with($f['disk'], $dir . '/')) {
                return false;
            }
        }
        return true;
    }

    private static function stageFile(\App\Storage\StorageAdapter $adapter, string $virt, string $dest): void
    {
        $in = $adapter->getStream($virt);
        $out = @fopen($dest, 'wb');
        if ($out === false) { fclose($in); throw new RuntimeException('Cannot stage file'); }
        stream_copy_to_stream($in, $out);
        fclose($out); fclose($in);
    }

    private static function arcName(string $stage, string $diskPath): string
    {
        return str_replace('\\', '/', substr($diskPath, strlen($stage) + 1));
    }

    private static function freeName(\App\Storage\StorageAdapter $adapter, string $dir, string $name): string
    {
        $dot = strrpos($name, '.');
        $stem = $dot !== false && $dot !== 0 ? substr($name, 0, $dot) : $name;
        $ext = $dot !== false && $dot !== 0 ? substr($name, $dot) : '';
        for ($i = 2; $i < 1000; $i++) {
            $c = PathGuard::join($dir, $stem . ' (' . $i . ')' . $ext);
            if (!$adapter->exists($c)) { return $c; }
        }
        throw new RuntimeException('No free archive name');
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