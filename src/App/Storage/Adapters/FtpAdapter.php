<?php

declare(strict_types=1);

namespace App\Storage\Adapters;

use App\Storage\ConnectionConfig;
use App\Storage\StorageAdapter;
use App\Support\PathGuard;
use RuntimeException;

/**
 * FTP / FTPS adapter (PHP ext-ftp).
 * FTPS uses explicit TLS (ftp_ssl_connect). Credentials come from the decrypted
 * ConnectionConfig and are never serialized anywhere.
 */
final class FtpAdapter implements StorageAdapter
{
    /** @var resource|null */
    private $conn = null;

    private string $base;

    public function __construct(private readonly ConnectionConfig $cfg, private readonly bool $readOnly = false)
    {
        $this->base = rtrim($cfg->remoteBase !== '' ? $cfg->remoteBase : '/', '/');
        if ($this->base === '') {
            $this->base = '/';
        }
    }

    private function connect()
    {
        if ($this->conn !== null) {
            return $this->conn;
        }
        if (!function_exists('ftp_connect')) {
            throw new RuntimeException('PHP ext-ftp is not available in this image');
        }

        $secure = $this->cfg->protocol === 'ftps';
        $handle = $secure
            ? @ftp_ssl_connect($this->cfg->host, $this->cfg->port, 15)
            : @ftp_connect($this->cfg->host, $this->cfg->port, 15);

        if ($handle === false) {
            throw new RuntimeException('FTP connection failed');
        }

        // Passive mode is the safe default behind NAT/firewalls.
        $passive = (bool) ($this->cfg->extra['passive'] ?? true);
        @ftp_pasv($handle, $passive);

        if ($this->cfg->username !== '') {
            $ok = @ftp_login($handle, $this->cfg->username, $this->cfg->secret);
            if ($ok === false) {
                throw new RuntimeException('FTP authentication failed');
            }
        }

        @ftp_set_option($handle, FTP_TIMEOUT_SEC, 30);
        if ($secure) {
            @ftp_set_option($handle, FTP_USEPASVADDRESS, false);
        }

        return $this->conn = $handle;
    }

    public function close(): void
    {
        if ($this->conn !== null) {
            @ftp_close($this->conn);
            $this->conn = null;
        }
    }

    public function __destruct()
    {
        $this->close();
    }

    /** Virtual path → absolute remote path. */
    private function remote(string $virtualPath): string
    {
        $v = PathGuard::normalize($virtualPath);
        if ($v === '/') {
            return $this->base;
        }
        return ($this->base === '/' ? '' : $this->base) . $v;
    }

    private function assertWritable(): void
    {
        if ($this->readOnly) {
            throw new RuntimeException('Mount is read-only', 403);
        }
    }

    public function list(string $path): array
    {
        $conn = $this->connect();
        $remote = $this->remote($path);
        $raw = @ftp_mlsd($conn, $remote);
        if ($raw === false) {
            $raw = $this->rawListFallback($conn, $remote);
        }
        $entries = [];
        foreach ($raw as $item) {
            $name = (string) ($item['name'] ?? '');
            if ($name === '' || $name === '.' || $name === '..') {
                continue;
            }
            $type = (string) ($item['type'] ?? 'file');
            $isDir = $type === 'dir' || $type === 'cdir' || $type === 'pdir';
            $entries[] = [
                'name' => $name,
                'path' => PathGuard::join($path, $name),
                'type' => $isDir ? 'dir' : 'file',
                'size' => (int) ($item['size'] ?? 0),
                'mtime' => $this->parseMtime((string) ($item['modify'] ?? '')),
                'mode' => '',
                'writable' => !$this->readOnly,
                'owner' => '',
                'group' => '',
                'isLink' => false,
                'mime' => '',
                'extension' => $isDir ? '' : strtolower((string) pathinfo($name, PATHINFO_EXTENSION)),
            ];
        }
        usort($entries, static function (array $a, array $b): int {
            if ($a['type'] !== $b['type']) {
                return $a['type'] === 'dir' ? -1 : 1;
            }
            return strcasecmp((string) $a['name'], (string) $b['name']);
        });
        return $entries;
    }

    /** @return array<int, array<string,mixed>> */
    private function rawListFallback($conn, string $remote): array
    {
        $names = @ftp_nlist($conn, $remote);
        if ($names === false) {
            throw new RuntimeException('Cannot list remote directory');
        }
        $out = [];
        foreach ($names as $full) {
            $name = basename((string) $full);
            if ($name === '' || $name === '.' || $name === '..') {
                continue;
            }
            $child = rtrim($remote, '/') . '/' . $name;
            $isDir = @ftp_size($conn, $child) === -1;
            $out[] = [
                'name' => $name,
                'type' => $isDir ? 'dir' : 'file',
                'size' => $isDir ? 0 : max(0, (int) @ftp_size($conn, $child)),
                'modify' => @ftp_mdtm($conn, $child) > 0
                    ? gmdate('YmdHis', (int) @ftp_mdtm($conn, $child))
                    : '',
            ];
        }
        return $out;
    }

    private function parseMtime(string $modify): int
    {
        if ($modify === '' || strlen($modify) < 14) {
            return 0;
        }
        $ts = strtotime(substr($modify, 0, 14) . ' UTC');
        return $ts === false ? 0 : $ts;
    }

    public function stat(string $path): array
    {
        $conn = $this->connect();
        if (PathGuard::normalize($path) === '/') {
            return $this->entry('/', '/', 'dir', 0, 0);
        }
        $name = PathGuard::basename($path);
        $remote = $this->remote($path);
        $size = @ftp_size($conn, $remote);
        if ($size === -1) {
            // Directory? Try to list its parent and match the name.
            $parent = PathGuard::dirname($path);
            foreach ($this->list($parent) as $entry) {
                if ($entry['name'] === $name) {
                    return $entry;
                }
            }
            throw new RuntimeException('Path not found', 404);
        }
        $mtime = (int) @ftp_mdtm($conn, $remote);
        return $this->entry($name, PathGuard::normalize($path), 'file', max(0, $size), max(0, $mtime));
    }

    private function entry(string $name, string $path, string $type, int $size, int $mtime): array
    {
        return [
            'name' => $name,
            'path' => $path,
            'type' => $type,
            'size' => $size,
            'mtime' => $mtime,
            'mode' => '',
            'writable' => !$this->readOnly,
            'owner' => '',
            'group' => '',
            'isLink' => false,
            'mime' => '',
            'extension' => $type === 'file' ? strtolower((string) pathinfo($name, PATHINFO_EXTENSION)) : '',
        ];
    }

    public function exists(string $path): bool
    {
        try {
            $conn = $this->connect();
            if (PathGuard::normalize($path) === '/') {
                return true;
            }
            $remote = $this->remote($path);
            if (@ftp_size($conn, $remote) !== -1) {
                return true;
            }
            $parent = PathGuard::dirname($path);
            $list = @ftp_nlist($conn, $parent);
            if ($list === false) {
                return false;
            }
            $name = PathGuard::basename($path);
            foreach ($list as $full) {
                if (basename((string) $full) === $name) {
                    return true;
                }
            }
            return false;
        } catch (RuntimeException) {
            return false;
        }
    }

    public function isDir(string $path): bool
    {
        try {
            return $this->stat($path)['type'] === 'dir';
        } catch (RuntimeException) {
            return false;
        }
    }

    public function mkdir(string $path, bool $recursive = true): void
    {
        $this->assertWritable();
        $conn = $this->connect();
        $parts = array_filter(explode('/', PathGuard::normalize($path)), static fn ($p) => $p !== '');
        $current = '';
        foreach ($parts as $part) {
            $current .= '/' . $part;
            $remote = $this->remote($current);
            @ftp_mkdir($conn, $remote);
        }
    }

    public function delete(string $path, bool $recursive = false): void
    {
        $this->assertWritable();
        $conn = $this->connect();
        if (PathGuard::normalize($path) === '/') {
            throw new RuntimeException('Refusing to delete the mount root');
        }
        $remote = $this->remote($path);
        if (@ftp_size($conn, $remote) !== -1 || @ftp_delete($conn, $remote)) {
            if (!@ftp_delete($conn, $remote)) {
                throw new RuntimeException('Delete failed');
            }
            return;
        }
        $this->deleteDir($conn, $path, $recursive);
    }

    private function deleteDir($conn, string $virtualPath, bool $recursive): void
    {
        $items = $this->list($virtualPath);
        if ($items !== [] && !$recursive) {
            throw new RuntimeException('Directory is not empty');
        }
        foreach ($items as $item) {
            if ($item['type'] === 'dir') {
                $this->deleteDir($conn, (string) $item['path'], true);
            } else {
                if (!@ftp_delete($conn, $this->remote((string) $item['path']))) {
                    throw new RuntimeException('Delete failed for ' . $item['name']);
                }
            }
        }
        if (!@ftp_rmdir($conn, $this->remote($virtualPath))) {
            throw new RuntimeException('Failed to remove directory');
        }
    }

    public function rename(string $from, string $to): void
    {
        $this->assertWritable();
        $conn = $this->connect();
        if (!@ftp_rename($conn, $this->remote($from), $this->remote($to))) {
            throw new RuntimeException('Rename failed');
        }
    }

    public function copy(string $from, string $to): void
    {
        $this->assertWritable();
        if ($this->isDir($from)) {
            throw new RuntimeException('Copying directories is not supported on FTP mounts');
        }
        $in = $this->getStream($from);
        try {
            $this->putStream($to, $in);
        } finally {
            if (is_resource($in)) {
                fclose($in);
            }
        }
    }

    public function getStream(string $path, int $from = -1, int $to = -1)
    {
        if ($from >= 0) {
            throw new RuntimeException('Range downloads are not supported on FTP mounts');
        }
        $tmp = tmpfile();
        if ($tmp === false) {
            throw new RuntimeException('Cannot create temporary buffer');
        }
        $conn = $this->connect();
        if (!@ftp_fget($conn, $tmp, $this->remote($path), FTP_BINARY)) {
            fclose($tmp);
            throw new RuntimeException('Download failed', 404);
        }
        rewind($tmp);
        return $tmp;
    }

    public function putStream(string $path, $stream): int
    {
        $this->assertWritable();
        $conn = $this->connect();
        $this->ensureParent($path);
        $written = @ftp_fput($conn, $this->remote($path), $stream, FTP_BINARY);
        if ($written === false) {
            throw new RuntimeException('Upload failed');
        }
        $size = @ftp_size($conn, $this->remote($path));
        return $size === -1 ? 0 : (int) $size;
    }

    private function ensureParent(string $path): void
    {
        $parent = PathGuard::dirname($path);
        if ($parent !== '/' && !$this->exists($parent)) {
            $this->mkdir($parent, true);
        }
    }

    public function du(string $path = '/'): array
    {
        $used = 0;
        $files = 0;
        $dirs = 0;
        $this->walkSize($path, $used, $files, $dirs);
        return ['used' => $used, 'files' => $files, 'dirs' => $dirs];
    }

    private function walkSize(string $path, int &$used, int &$files, int &$dirs): void
    {
        try {
            $items = $this->list($path);
        } catch (RuntimeException) {
            return;
        }
        foreach ($items as $item) {
            if ($item['type'] === 'dir') {
                $dirs++;
                $this->walkSize((string) $item['path'], $used, $files, $dirs);
            } else {
                $files++;
                $used += (int) $item['size'];
            }
        }
    }

    public function search(string $path, string $needle, int $limit = 200): array
    {
        $results = [];
        $this->walkSearch($path, mb_strtolower($needle), $results, $limit);
        return $results;
    }

    private function walkSearch(string $path, string $needle, array &$results, int $limit): void
    {
        if (count($results) >= $limit) {
            return;
        }
        try {
            $items = $this->list($path);
        } catch (RuntimeException) {
            return;
        }
        foreach ($items as $item) {
            if (count($results) >= $limit) {
                return;
            }
            if (mb_strpos(mb_strtolower((string) $item['name']), $needle) !== false) {
                $results[] = $item;
            }
            if ($item['type'] === 'dir') {
                $this->walkSearch((string) $item['path'], $needle, $results, $limit);
            }
        }
    }

    /** Connectivity probe used by the admin connection tester. */
    public static function probe(ConnectionConfig $cfg): void
    {
        $conn = self::connectStatic($cfg);
        if (is_resource($conn)) {
            @ftp_close($conn);
        }
    }

    private static function connectStatic(ConnectionConfig $cfg)
    {
        if ($cfg->protocol === 'ftps' && function_exists('ftp_ssl_connect')) {
            $conn = @ftp_ssl_connect($cfg->host, $cfg->port, 15);
        } else {
            $conn = @ftp_connect($cfg->host, $cfg->port, 15);
        }
        if ($conn === false) {
            throw new RuntimeException('Cannot reach FTP server');
        }
        if (!@ftp_login($conn, $cfg->username, $cfg->secret)) {
            throw new RuntimeException('FTP authentication failed');
        }
        if ($cfg->extra['passive'] ?? true) {
            @ftp_pasv($conn, true);
        }
        return $conn;
    }
}