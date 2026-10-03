<?php

declare(strict_types=1);

namespace App\Storage\Adapters;

use App\Storage\StorageAdapter;
use App\Support\PathGuard;
use RuntimeException;

/**
 * Hardened local filesystem adapter.
 *
 * Defense in depth:
 *  1. Virtual paths are normalized by PathGuard before they arrive.
 *  2. Each resolved path is re-checked with realpath() containment so that
 *     symlinks pointing outside the mount root are rejected.
 *  3. The root itself is canonicalized once and stored as the containment base.
 *  4. write operations refuse when the mount is read-only.
 */
final class LocalAdapter implements StorageAdapter
{
    private string $root;

    public function __construct(
        string $root,
        private readonly bool $readOnly = false,
        private readonly bool $sniffMime = true,
    ) {
        $real = realpath($root);
        if ($real === false || !is_dir($real)) {
            throw new RuntimeException('Storage root unavailable');
        }
        $this->root = rtrim($real, DIRECTORY_SEPARATOR);
    }

    /** Translate a virtual path into a verified absolute path. */
    public function toAbsolute(string $virtualPath, bool $mustExist = true): string
    {
        $v = PathGuard::normalize($virtualPath);
        $candidate = $this->root . str_replace('/', DIRECTORY_SEPARATOR, $v);
        // Normalize trailing separators without dropping a root "/".
        $candidate = rtrim($candidate, DIRECTORY_SEPARATOR);
        if ($candidate === '') {
            $candidate = $this->root;
        }

        if ($mustExist) {
            $real = realpath($candidate);
            if ($real === false) {
                throw new RuntimeException('Path not found', 404);
            }
            $this->assertInside($real);
            return $real;
        }

        // For creates: verify the closest existing ancestor is inside root,
        // then return the composed path (never following a symlink escape).
        $existing = $candidate;
        while (!file_exists($existing)) {
            $parent = dirname($existing);
            if ($parent === $existing) {
                break;
            }
            $existing = $parent;
        }
        $realExisting = realpath($existing);
        if ($realExisting === false) {
            throw new RuntimeException('Path not found', 404);
        }
        $this->assertInside($realExisting);

        // If the composed path itself exists (e.g. rename target), verify it too.
        $realTarget = realpath($candidate);
        if ($realTarget !== false) {
            $this->assertInside($realTarget);
            return $realTarget;
        }

        return $candidate;
    }

    private function assertInside(string $absPath): void
    {
        $rootWithSep = $this->root . DIRECTORY_SEPARATOR;
        if ($absPath !== $this->root && !str_starts_with($absPath, $rootWithSep)) {
            // Fallback comparison for case-insensitive filesystems.
            $norm = static fn (string $p): string => rtrim(str_replace('\\', '/', $p), '/');
            $a = $norm($absPath);
            $r = $norm($this->root);
            if ($a !== $r && !str_starts_with($a, $r . '/')) {
                throw new RuntimeException('Access denied: path escapes mount root', 403);
            }
        }
    }

    public function rootPath(): string
    {
        return $this->root;
    }

    private function assertWritable(): void
    {
        if ($this->readOnly) {
            throw new RuntimeException('Mount is read-only', 403);
        }
    }

    public function list(string $path): array
    {
        $abs = $this->toAbsolute($path);
        if (!is_dir($abs)) {
            throw new RuntimeException('Not a directory');
        }
        $entries = [];
        $dh = @opendir($abs);
        if ($dh === false) {
            throw new RuntimeException('Cannot read directory');
        }
        while (($name = readdir($dh)) !== false) {
            if ($name === '.' || $name === '..') {
                continue;
            }
            $childAbs = $abs . DIRECTORY_SEPARATOR . $name;
            $entry = $this->describe($childAbs, $name, PathGuard::join($path, $name));
            if ($entry !== null) {
                $entries[] = $entry;
            }
        }
        closedir($dh);

        usort($entries, static function (array $a, array $b): int {
            if ($a['type'] !== $b['type']) {
                return $a['type'] === 'dir' ? -1 : 1;
            }
            return strcasecmp((string) $a['name'], (string) $b['name']);
        });

        return $entries;
    }

    /** @return array<string,mixed>|null null when the entry is outside the root (symlink escape) */
    private function describe(string $absPath, string $name, string $virtual): ?array
    {
        $isLink = is_link($absPath);
        $stat = @lstat($absPath);
        if ($stat === false) {
            return null;
        }

        $type = 'file';
        if (is_dir($absPath)) {
            $type = 'dir';
        } elseif (!$isLink && !is_file($absPath)) {
            $type = 'other'; // fifo, socket, block device
        }

        // Reject entries whose real path escapes the mount root.
        $real = realpath($absPath);
        if ($real !== false) {
            try {
                $this->assertInside($real);
            } catch (RuntimeException) {
                return null;
            }
        } elseif ($isLink) {
            return null; // broken/escaping link
        }

        $size = $type === 'dir' ? 0 : (int) ($stat['size'] ?? 0);
        $mtime = (int) ($stat['mtime'] ?? 0);
        $perms = substr(sprintf('%o', $stat['mode'] & 0777), -4);
        $owner = function_exists('posix_getpwuid') ? (posix_getpwuid($stat['uid'])['name'] ?? (string) $stat['uid']) : (string) $stat['uid'];
        $group = function_exists('posix_getgrgid') ? (posix_getgrgid($stat['gid'])['name'] ?? (string) $stat['gid']) : (string) $stat['gid'];

        return [
            'name' => $name,
            'path' => $virtual,
            'type' => $type,
            'size' => $size,
            'mtime' => $mtime,
            'mode' => $perms,
            'writable' => is_writable($absPath),
            'owner' => (string) $owner,
            'group' => (string) $group,
            'isLink' => $isLink,
            'mime' => $type === 'file' ? $this->mimeOf($absPath) : '',
            'extension' => $type === 'file' ? strtolower((string) pathinfo($name, PATHINFO_EXTENSION)) : '',
        ];
    }

    private function mimeOf(string $absPath): string
    {
        // When this adapter is wrapped by EncryptedAdapter the real MIME comes
        // from the encryption header, and sniffing ciphertext would produce
        // garbage — so the wrapper switches this off rather than paying for both.
        if (!$this->sniffMime || !function_exists('finfo_open')) {
            return '';
        }
        $fi = finfo_open(FILEINFO_MIME_TYPE);
        if ($fi === false) {
            return '';
        }
        $mime = finfo_file($fi, $absPath);
        finfo_close($fi);
        return is_string($mime) ? $mime : '';
    }

    public function stat(string $path): array
    {
        $abs = $this->toAbsolute($path);
        $name = PathGuard::basename($path);
        $info = $this->describe($abs, $name, PathGuard::normalize($path));
        if ($info === null) {
            throw new RuntimeException('Path not found', 404);
        }
        return $info;
    }

    public function exists(string $path): bool
    {
        try {
            $abs = $this->toAbsolute($path);
        } catch (RuntimeException) {
            return false;
        }
        return file_exists($abs);
    }

    public function isDir(string $path): bool
    {
        try {
            $abs = $this->toAbsolute($path);
        } catch (RuntimeException) {
            return false;
        }
        return is_dir($abs);
    }

    public function mkdir(string $path, bool $recursive = true): void
    {
        $this->assertWritable();
        $abs = $this->toAbsolute($path, false);
        if (file_exists($abs)) {
            throw new RuntimeException('Already exists');
        }
        if (!@mkdir($abs, 0770, $recursive)) {
            throw new RuntimeException('Failed to create directory');
        }
    }

    public function delete(string $path, bool $recursive = false): void
    {
        $this->assertWritable();
        if (PathGuard::normalize($path) === '/') {
            throw new RuntimeException('Refusing to delete the mount root');
        }
        $abs = $this->toAbsolute($path);
        if (is_link($abs) || is_file($abs)) {
            if (!@unlink($abs)) {
                throw new RuntimeException('Failed to delete file');
            }
            return;
        }
        if (!is_dir($abs)) {
            throw new RuntimeException('Path not found', 404);
        }
        // Only delete when empty unless recursive was explicitly requested.
        $items = @scandir($abs) ?: [];
        $items = array_diff($items, ['.', '..']);
        if ($items !== [] && !$recursive) {
            throw new RuntimeException('Directory is not empty');
        }
        $this->deleteTree($abs);
    }

    private function deleteTree(string $absDir): void
    {
        $items = @scandir($absDir) ?: [];
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $child = $absDir . DIRECTORY_SEPARATOR . $item;
            if (is_link($child) || is_file($child)) {
                @unlink($child);
            } elseif (is_dir($child)) {
                $this->deleteTree($child);
            }
        }
        if (!@rmdir($absDir)) {
            throw new RuntimeException('Failed to remove directory');
        }
    }

    public function rename(string $from, string $to): void
    {
        $this->assertWritable();
        $absFrom = $this->toAbsolute($from);
        $absTo = $this->toAbsolute($to, false);
        if (file_exists($absTo)) {
            throw new RuntimeException('Target already exists');
        }
        if (!@rename($absFrom, $absTo)) {
            throw new RuntimeException('Rename failed');
        }
    }

    public function copy(string $from, string $to): void
    {
        $this->assertWritable();
        $absFrom = $this->toAbsolute($from);
        $absTo = $this->toAbsolute($to, false);
        if (file_exists($absTo)) {
            throw new RuntimeException('Target already exists');
        }
        if (is_dir($absFrom)) {
            $this->copyTree($absFrom, $absTo);
            return;
        }
        $in = @fopen($absFrom, 'rb');
        if ($in === false) {
            throw new RuntimeException('Cannot open source for reading');
        }
        $out = @fopen($absTo, 'xb');
        if ($out === false) {
            fclose($in);
            throw new RuntimeException('Cannot create target');
        }
        if (stream_copy_to_stream($in, $out) === false) {
            fclose($in);
            fclose($out);
            @unlink($absTo);
            throw new RuntimeException('Copy failed');
        }
        fclose($in);
        fclose($out);
    }

    private function copyTree(string $srcDir, string $dstDir): void
    {
        if (!@mkdir($dstDir, 0770, true)) {
            throw new RuntimeException('Cannot create target directory');
        }
        $items = @scandir($srcDir) ?: [];
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $src = $srcDir . DIRECTORY_SEPARATOR . $item;
            $dst = $dstDir . DIRECTORY_SEPARATOR . $item;
            if (is_dir($src) && !is_link($src)) {
                $this->copyTree($src, $dst);
            } else {
                if (!@copy($src, $dst)) {
                    throw new RuntimeException('Copy failed for ' . $item);
                }
            }
        }
    }

    public function getStream(string $path, int $from = -1, int $to = -1)
    {
        $abs = $this->toAbsolute($path);
        if (!is_file($abs)) {
            throw new RuntimeException('Not a file', 404);
        }
        $fh = @fopen($abs, 'rb');
        if ($fh === false) {
            throw new RuntimeException('Cannot open file for reading');
        }
        return $fh;
    }

    public function putStream(string $path, $stream): int
    {
        $this->assertWritable();
        $abs = $this->toAbsolute($path, false);
        $dir = dirname($abs);
        if (!is_dir($dir) && !@mkdir($dir, 0770, true)) {
            throw new RuntimeException('Cannot create parent directory');
        }
        $out = @fopen($abs, 'wb');
        if ($out === false) {
            throw new RuntimeException('Cannot open target for writing');
        }
        $written = stream_copy_to_stream($stream, $out);
        fclose($out);
        if ($written === false) {
            throw new RuntimeException('Write failed');
        }
        return (int) $written;
    }

    public function du(string $path = '/'): array
    {
        $abs = $this->toAbsolute($path);
        $used = 0;
        $files = 0;
        $dirs = 0;
        if (is_file($abs)) {
            return ['used' => (int) filesize($abs), 'files' => 1, 'dirs' => 0];
        }
        $this->walkSize($abs, $used, $files, $dirs);
        return ['used' => $used, 'files' => $files, 'dirs' => $dirs];
    }

    private function walkSize(string $dir, int &$used, int &$files, int &$dirs): void
    {
        $items = @scandir($dir) ?: [];
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            $child = $dir . DIRECTORY_SEPARATOR . $item;
            if (is_link($child)) {
                continue; // never traverse links (escape prevention)
            }
            if (is_dir($child)) {
                $dirs++;
                $this->walkSize($child, $used, $files, $dirs);
            } elseif (is_file($child)) {
                $files++;
                $size = @filesize($child);
                $used += $size === false ? 0 : (int) $size;
            }
        }
    }

    public function search(string $path, string $needle, int $limit = 200): array
    {
        $abs = $this->toAbsolute($path);
        $needleLower = mb_strtolower($needle);
        $results = [];
        $this->walkSearch($abs, PathGuard::normalize($path), $needleLower, $results, $limit);
        return $results;
    }

    /** @param array<int, array<string,mixed>> $results */
    private function walkSearch(string $dir, string $virtual, string $needle, array &$results, int $limit): void
    {
        if (count($results) >= $limit) {
            return;
        }
        $items = @scandir($dir) ?: [];
        foreach ($items as $item) {
            if ($item === '.' || $item === '..') {
                continue;
            }
            if (count($results) >= $limit) {
                return;
            }
            $child = $dir . DIRECTORY_SEPARATOR . $item;
            if (is_link($child)) {
                continue;
            }
            // The trash is an implementation detail of TrashService and has its own
            // UI view; it must not surface in search results as user content.
            if ($item === \App\Services\TrashService::TRASH_DIR) {
                continue;
            }
            $childVirtual = PathGuard::join($virtual, $item);
            if (mb_strpos(mb_strtolower($item), $needle) !== false) {
                $described = $this->describe($child, $item, $childVirtual);
                if ($described !== null) {
                    $results[] = $described;
                }
            }
            if (is_dir($child)) {
                $this->walkSearch($child, $childVirtual, $needle, $results, $limit);
            }
        }
    }

    /** Directory size helper used by the trash service. */
    public function sizeOf(string $virtPath): int
    {
        try {
            return $this->du($virtPath)['used'];
        } catch (\Throwable) {
            return 0;
        }
    }
}
