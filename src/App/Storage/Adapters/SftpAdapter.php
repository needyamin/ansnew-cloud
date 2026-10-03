<?php

declare(strict_types=1);

namespace App\Storage\Adapters;

use App\Core\Database;
use App\Storage\ConnectionConfig;
use App\Storage\StorageAdapter;
use App\Support\PathGuard;
use phpseclib3\Crypt\PublicKeyLoader;
use phpseclib3\Net\SFTP;
use RuntimeException;

/**
 * SFTP over SSH adapter (phpseclib3).
 *
 * Host-key handling: on first successful connection the server key is recorded
 * (TOFU) on the saved connection; afterwards the presented key must match the
 * pinned fingerprint, otherwise the connection is refused (MITM protection).
 *
 * Auth: password, or a private key supplied via the encrypted connection
 * secret. Key material is never written to disk by this process.
 */
final class SftpAdapter implements StorageAdapter
{
    private ?SFTP $sftp = null;

    public function __construct(private readonly ConnectionConfig $cfg, private readonly bool $readOnly = false)
    {
    }

    private function conn(): SFTP
    {
        if ($this->sftp !== null) {
            return $this->sftp;
        }

        $timeout = 20;
        $sftp = new SFTP($this->cfg->host, $this->cfg->port, $timeout);

        // Reject everything until the host key is verified.
        if ($this->cfg->hostFingerprint !== null && $this->cfg->hostFingerprint !== '') {
            $serverKey = $sftp->getServerPublicHostKey();
            if ($serverKey === false) {
                throw new RuntimeException('Unable to read SSH host key');
            }
            $fingerprint = 'SHA256:' . rtrim(base64_encode(hash('sha256', $serverKey, true)), '=');
            if (!hash_equals($this->cfg->hostFingerprint, $fingerprint)) {
                throw new RuntimeException('SSH host key mismatch — possible man-in-the-middle. Connection refused.');
            }
        }

        $auth = match ($this->cfg->authType) {
            'key' => $this->loadPrivateKey(),
            default => $this->cfg->secret,
        };

        if (!$sftp->login($this->cfg->username, $auth)) {
            throw new RuntimeException('SFTP authentication failed');
        }

        // TOFU pinning on first use.
        if ($this->cfg->hostFingerprint === null || $this->cfg->hostFingerprint === '') {
            $serverKey = $sftp->getServerPublicHostKey();
            if (is_string($serverKey) && $serverKey !== '') {
                $fingerprint = 'SHA256:' . rtrim(base64_encode(hash('sha256', $serverKey, true)), '=');
                if ($this->cfg->pinConnectionId !== null) {
                    Database::i()->run(
                        'UPDATE connections SET host_fingerprint = :f WHERE id = :id',
                        [':f' => $fingerprint, ':id' => $this->cfg->pinConnectionId]
                    );
                }
            }
        }

        return $this->sftp = $sftp;
    }

    private function loadPrivateKey(): mixed
    {
        $keyData = $this->cfg->secret;
        if (trim($keyData) === '') {
            throw new RuntimeException('No private key configured for this connection');
        }
        try {
            return PublicKeyLoader::load(
                $keyData,
                $this->cfg->passphrase !== '' ? $this->cfg->passphrase : false
            );
        } catch (\Throwable $e) {
            throw new RuntimeException('Invalid private key or passphrase', 0, $e);
        }
    }

    public function close(): void
    {
        if ($this->sftp !== null) {
            try {
                $this->sftp->disconnect();
            } catch (\Throwable) {
                // ignore
            }
            $this->sftp = null;
        }
    }

    private function remote(string $virtualPath): string
    {
        $v = PathGuard::normalize($virtualPath);
        $base = rtrim($this->cfg->remoteBase !== '' ? $this->cfg->remoteBase : '/', '/');
        if ($v === '/') {
            return $base === '' ? '/' : $base;
        }
        return ($base === '' ? '' : $base) . $v;
    }

    private function assertWritable(): void
    {
        if ($this->readOnly) {
            throw new RuntimeException('Mount is read-only', 403);
        }
    }

    public function list(string $path): array
    {
        $sftp = $this->conn();
        $remote = $this->remote($path);
        $raw = $sftp->rawlist($remote);
        if ($raw === false) {
            throw new RuntimeException('Cannot list remote directory');
        }
        $entries = [];
        foreach ($raw as $name => $info) {
            $name = (string) $name;
            if ($name === '.' || $name === '..' || $name === '') {
                continue;
            }
            $type = (int) ($info['type'] ?? 0);
            $isDir = ($type & 0040000) === 0040000;
            $isLink = ($type & 0120000) === 0120000;
            $perms = $type & 0777;
            $entries[] = [
                'name' => $name,
                'path' => PathGuard::join($path, $name),
                'type' => $isDir ? 'dir' : 'file',
                'size' => (int) ($info['size'] ?? 0),
                'mtime' => (int) ($info['mtime'] ?? 0),
                'mode' => substr(sprintf('%o', $perms), -4),
                'writable' => !$this->readOnly && ($perms & 0200) === 0200,
                'owner' => (string) ($info['uid'] ?? ''),
                'group' => (string) ($info['gid'] ?? ''),
                'isLink' => $isLink,
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

    public function stat(string $path): array
    {
        $sftp = $this->conn();
        $remote = $this->remote($path);
        $info = $sftp->stat($remote);
        if ($info === false) {
            throw new RuntimeException('Path not found', 404);
        }
        $type = (int) ($info['type'] ?? 0);
        $isDir = ($type & 0040000) === 0040000;
        $name = PathGuard::basename($path);
        return [
            'name' => $name !== '' ? $name : '/',
            'path' => PathGuard::normalize($path),
            'type' => $isDir ? 'dir' : 'file',
            'size' => (int) ($info['size'] ?? 0),
            'mtime' => (int) ($info['mtime'] ?? 0),
            'mode' => substr(sprintf('%o', $type & 0777), -4),
            'writable' => !$this->readOnly,
            'owner' => (string) ($info['uid'] ?? ''),
            'group' => (string) ($info['gid'] ?? ''),
            'isLink' => false,
            'mime' => '',
            'extension' => $isDir ? '' : strtolower((string) pathinfo($name, PATHINFO_EXTENSION)),
        ];
    }

    public function exists(string $path): bool
    {
        try {
            return $this->conn()->file_exists($this->remote($path));
        } catch (RuntimeException) {
            return false;
        }
    }

    public function isDir(string $path): bool
    {
        try {
            return $this->conn()->is_dir($this->remote($path));
        } catch (RuntimeException) {
            return false;
        }
    }

    public function mkdir(string $path, bool $recursive = true): void
    {
        $this->assertWritable();
        $sftp = $this->conn();
        foreach (array_filter(explode('/', PathGuard::normalize($path)), static fn ($p) => $p !== '') as $i => $part) {
            $partial = implode('/', array_slice(array_filter(explode('/', PathGuard::normalize($path)), static fn ($p) => $p !== ''), 0, $i + 1));
            $remote = $this->remote('/' . $partial);
            if (!$sftp->file_exists($remote)) {
                if (!$sftp->mkdir($remote)) {
                    throw new RuntimeException('Failed to create directory');
                }
            }
        }
    }

    public function delete(string $path, bool $recursive = false): void
    {
        $this->assertWritable();
        if (PathGuard::normalize($path) === '/') {
            throw new RuntimeException('Refusing to delete the mount root');
        }
        $sftp = $this->conn();
        $remote = $this->remote($path);
        if ($sftp->is_file($remote)) {
            if (!$sftp->delete($remote, false)) {
                throw new RuntimeException('Delete failed');
            }
            return;
        }
        $items = $this->list($path);
        if ($items !== [] && !$recursive) {
            throw new RuntimeException('Directory is not empty');
        }
        foreach ($items as $item) {
            if ($item['type'] === 'dir') {
                $this->delete((string) $item['path'], true);
            } else {
                if (!$sftp->delete($this->remote((string) $item['path']), false)) {
                    throw new RuntimeException('Delete failed for ' . $item['name']);
                }
            }
        }
        if (!$sftp->rmdir($this->remote($path))) {
            throw new RuntimeException('Failed to remove directory');
        }
    }

    public function rename(string $from, string $to): void
    {
        $this->assertWritable();
        if (!$this->conn()->rename($this->remote($from), $this->remote($to))) {
            throw new RuntimeException('Rename failed');
        }
    }

    public function copy(string $from, string $to): void
    {
        $this->assertWritable();
        if ($this->isDir($from)) {
            $items = $this->list($from);
            foreach ($items as $item) {
                $target = PathGuard::join($to, (string) $item['name']);
                if ($item['type'] === 'dir') {
                    $this->mkdir($target, true);
                    $this->copy((string) $item['path'], $target);
                } else {
                    $this->copy((string) $item['path'], $target);
                }
            }
            return;
        }
        $stream = $this->getStream($from);
        try {
            $this->putStream($to, $stream);
        } finally {
            if (is_resource($stream)) {
                fclose($stream);
            }
        }
    }

    public function getStream(string $path, int $from = -1, int $to = -1)
    {
        $sftp = $this->conn();
        $remote = $this->remote($path);
        $tmp = tmpfile();
        if ($tmp === false) {
            throw new RuntimeException('Cannot create temporary buffer');
        }
        if (!$sftp->get($remote, $tmp)) {
            fclose($tmp);
            throw new RuntimeException('Download failed', 404);
        }
        rewind($tmp);
        return $tmp;
    }

    public function putStream(string $path, $stream): int
    {
        $this->assertWritable();
        $sftp = $this->conn();
        $parent = PathGuard::dirname($path);
        if ($parent !== '/' && !$sftp->is_dir($this->remote($parent))) {
            $this->mkdir($parent, true);
        }
        $remote = $this->remote($path);
        // phpseclib3 accepts a stream resource and streams it internally.
        if (!$sftp->put($remote, $stream, SFTP::SOURCE_LOCAL_FILE)) {
            throw new RuntimeException('Upload failed');
        }
        $stat = $sftp->stat($remote);
        return (int) ($stat['size'] ?? 0);
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
        $adapter = new self($cfg, true);
        try {
            $sftp = $adapter->conn();
            $sftp->nlist_write('/');
        } finally {
            $adapter->close();
        }
    }
}