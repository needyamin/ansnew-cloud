<?php

declare(strict_types=1);

namespace App\Storage\Adapters;

use App\Storage\ConnectionConfig;
use App\Storage\StorageAdapter;
use App\Support\PathGuard;
use RuntimeException;

/**
 * SMB/CIFS adapter via the `smbclient` binary.
 *
 * Command-injection defense:
 *  - every argument is passed through escapeshellarg();
 *  - the command is executed with proc_open() using an ARGUMENT ARRAY-ish
 *    structure: we build the command string with escapeshellarg for each token,
 *    so no user-controlled value can ever break out of its argument;
 *  - credentials are never placed on the command line: smbclient reads them
 *    from an authentication file passed with --authentication-file, created
 *    with a restrictive mode and deleted immediately.
 *
 * Note: paths are still normalized with PathGuard before use, and remote
 * traversal is blocked. smbclient does not allow escaping the share root.
 */
final class SmbAdapter implements StorageAdapter
{
    private ?string $authFile = null;
    private string $base;

    public function __construct(private readonly ConnectionConfig $cfg, private readonly bool $readOnly = false)
    {
        $this->base = rtrim($cfg->remoteBase !== '' ? $cfg->remoteBase : '/', '/');
        if ($this->base === '') {
            $this->base = '/';
        }
    }

    public function __destruct()
    {
        $this->cleanup();
    }

    private function cleanup(): void
    {
        if ($this->authFile !== null && is_file($this->authFile)) {
            $content = (string) @file_get_contents($this->authFile);
            if ($content !== '') {
                // Best-effort scrub before unlink.
                @file_put_contents($this->authFile, str_repeat('0', strlen($content)));
            }
            @unlink($this->authFile);
        }
        $this->authFile = null;
    }

    /** Writes the credentials file (mode 0600) used by --authentication-file. */
    private function authFile(): string
    {
        if ($this->authFile !== null && is_file($this->authFile)) {
            return $this->authFile;
        }
        $dir = sys_get_temp_dir();
        $path = tempnam($dir, 'ansnew_smb_');
        if ($path === false) {
            throw new RuntimeException('Cannot create temporary credentials file');
        }
        $domain = (string) ($this->cfg->extra['domain'] ?? '');
        $lines = [
            'username = ' . $this->sanitizeCredLine($this->cfg->username),
            'password = ' . $this->sanitizeCredLine($this->cfg->secret),
        ];
        if ($domain !== '') {
            $lines[] = 'domain = ' . $this->sanitizeCredLine($domain);
        }
        @chmod($path, 0600);
        if (file_put_contents($path, implode("\n", $lines) . "\n") === false) {
            throw new RuntimeException('Cannot write credentials file');
        }
        @chmod($path, 0600);
        return $this->authFile = $path;
    }

    /** Strip characters that could terminate a credentials-file line. */
    private function sanitizeCredLine(string $value): string
    {
        return str_replace(["\n", "\r", "\0"], '', $value);
    }

    /** Virtual path → SMB path using backslashes (smbclient convention). */
    private function remote(string $virtualPath): string
    {
        $v = PathGuard::normalize($virtualPath);
        $full = $v === '/' ? $this->base : rtrim($this->base, '/') . $v;
        return str_replace('/', '\\', $full === '' ? '\\' : $full);
    }

    private function assertWritable(): void
    {
        if ($this->readOnly) {
            throw new RuntimeException('Mount is read-only', 403);
        }
    }

    /**
     * Execute smbclient with a strictly-escaped argv.
     *
     * @param array<int,string> $clientArgs arguments after the smbclient binary
     * @return array{code:int, stdout:string, stderr:string}
     */
    private function exec(array $clientArgs, ?string $stdinFile = null): array
    {
        $share = '//' . $this->cfg->host . '/' . ltrim((string) ($this->cfg->extra['share'] ?? ''), '/');
        if (ltrim((string) ($this->cfg->extra['share'] ?? ''), '/') === '') {
            throw new RuntimeException('SMB share is not configured for this connection');
        }

        $argv = [
            'smbclient',
            $share,
            '--authentication-file=' . $this->authFile(),
            '--option=client min protocol=SMB2',
            '--option=client max protocol=SMB3',
        ];
        if ($this->cfg->extra['encrypt'] ?? true) {
            $argv[] = '--option=client smb encrypt=required';
        }
        foreach ($clientArgs as $arg) {
            $argv[] = $arg;
        }

        // escapeshellarg() per token: no token can escape its own quoting.
        $command = implode(' ', array_map('escapeshellarg', $argv));

        $descriptors = [
            0 => $stdinFile !== null ? ['file', $stdinFile, 'rb'] : ['pipe', 'rb'],
            1 => ['pipe', 'wb'],
            2 => ['pipe', 'wb'],
        ];

        $process = proc_open($command, $descriptors, $pipes);
        if (!is_resource($process)) {
            throw new RuntimeException('Failed to start smbclient');
        }

        if ($stdinFile === null && isset($pipes[0])) {
            fclose($pipes[0]);
        }
        if ($stdinFile !== null && isset($pipes[0])) {
            fclose($pipes[0]);
        }

        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);

        $code = proc_close($process);
        $this->cleanup();

        return [
            'code' => $code,
            'stdout' => is_string($stdout) ? $stdout : '',
            'stderr' => is_string($stderr) ? $stderr : '',
        ];
    }

    /** Reject smbclient output that indicates auth/permission problems. */
    private function assertOk(array $result, string $what): void
    {
        $err = strtolower($result['stderr'] . $result['stdout']);
        if (str_contains($err, 'nt_status_logon_failure') || str_contains($err, 'nt_status_access_denied')) {
            throw new RuntimeException('SMB access denied');
        }
        if (str_contains($err, 'nt_status_object_name_not_found') || str_contains($err, 'nt_status_no_such_file')) {
            throw new RuntimeException('Path not found', 404);
        }
        if ($result['code'] !== 0) {
            throw new RuntimeException($what . ' failed');
        }
    }

    public function list(string $path): array
    {
        $mask = $this->remote($path);
        if (!str_ends_with($mask, '\\')) {
            $mask .= '\\';
        }
        $mask .= '*';
        $result = $this->exec(['-c', 'ls ' . $mask]);
        $this->assertOk($result, 'List');
        return $this->parseLs($result['stdout'], $path);
    }

    /** @return array<int, array<string,mixed>> */
    private function parseLs(string $output, string $basePath): array
    {
        $entries = [];
        foreach (explode("\n", $output) as $line) {
            $line = rtrim($line, "\r");
            if ($line === '') {
                continue;
            }
            // smbclient ls format: blocks, perms(char), size, date, time, name
            if (preg_match('/^\s*(\d+)\s+([A-Za-z]+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/', $line, $m) !== 1) {
                continue;
            }
            $permChar = $m[2];
            $name = trim($m[5]);
            if ($name === '.' || $name === '..' || $name === '') {
                continue;
            }
            $isDir = str_starts_with(strtoupper($permChar), 'D') || str_contains(strtoupper($permChar), 'D');
            $mtime = strtotime($m[4] . ' UTC') ?: 0;
            $entries[] = [
                'name' => $name,
                'path' => PathGuard::join($basePath, $name),
                'type' => $isDir ? 'dir' : 'file',
                'size' => $isDir ? 0 : (int) $m[3],
                'mtime' => $mtime,
                'mode' => $permChar,
                'writable' => !$this->readOnly,
                'owner' => '',
                'group' => '',
                'isLink' => false,
                'mime' => '',
                'extension' => $isDir ? '' : strtolower((string) pathinfo($name, PATHINFO_EXTENSION)),
            ];
        }
        return $entries;
    }

    public function stat(string $path): array
    {
        $name = PathGuard::basename($path);
        if ($name === '') {
            return [
                'name' => '/', 'path' => '/', 'type' => 'dir', 'size' => 0, 'mtime' => 0,
                'mode' => '', 'writable' => !$this->readOnly, 'owner' => '', 'group' => '',
                'isLink' => false, 'mime' => '', 'extension' => '',
            ];
        }
        foreach ($this->list(PathGuard::dirname($path)) as $entry) {
            if ($entry['name'] === $name) {
                return $entry;
            }
        }
        throw new RuntimeException('Path not found', 404);
    }

    public function exists(string $path): bool
    {
        try {
            $this->stat($path);
            return true;
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
        $parts = array_filter(explode('/', PathGuard::normalize($path)), static fn ($p) => $p !== '');
        $current = '';
        foreach ($parts as $part) {
            $current .= '/' . $part;
            $result = $this->exec(['-c', 'mkdir ' . $this->remote($current)]);
            // "already exists" is fine.
            if ($result['code'] !== 0 && !str_contains(strtolower($result['stderr']), 'exists')) {
                $this->assertOk($result, 'Mkdir');
            }
        }
    }

    public function delete(string $path, bool $recursive = false): void
    {
        $this->assertWritable();
        if (PathGuard::normalize($path) === '/') {
            throw new RuntimeException('Refusing to delete the mount root');
        }
        $target = $this->remote($path);
        if ($this->isDir($path)) {
            $items = $this->list($path);
            if ($items !== [] && !$recursive) {
                throw new RuntimeException('Directory is not empty');
            }
            $result = $this->exec(['-c', 'recurse ON; deltree ' . $target]);
            $this->assertOk($result, 'Delete');
            return;
        }
        $result = $this->exec(['-c', 'del ' . $target]);
        $this->assertOk($result, 'Delete');
    }

    public function rename(string $from, string $to): void
    {
        $this->assertWritable();
        // smbclient rename is file-only; fall back to copy+delete for dirs.
        if ($this->isDir($from)) {
            $this->copy($from, $to);
            $this->delete($from, true);
            return;
        }
        $result = $this->exec(['-c', 'rename ' . $this->remote($from) . ' ' . $this->remote($to)]);
        $this->assertOk($result, 'Rename');
    }

    public function copy(string $from, string $to): void
    {
        $this->assertWritable();
        if ($this->isDir($from)) {
            $this->mkdir($to, true);
            foreach ($this->list($from) as $item) {
                $this->copy((string) $item['path'], PathGuard::join($to, (string) $item['name']));
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
        $tmp = tmpfile();
        if ($tmp === false) {
            throw new RuntimeException('Cannot create temporary buffer');
        }
        $tmpPath = tempnam(sys_get_temp_dir(), 'ansnew_smb_get_');
        if ($tmpPath === false) {
            fclose($tmp);
            throw new RuntimeException('Cannot create temporary file');
        }
        $result = $this->exec(['-c', 'get ' . $this->remote($path) . ' ' . $tmpPath]);
        if ($result['code'] !== 0 || !is_file($tmpPath)) {
            @unlink($tmpPath);
            fclose($tmp);
            $this->assertOk($result, 'Download');
            throw new RuntimeException('Download failed', 404);
        }
        $in = fopen($tmpPath, 'rb');
        @unlink($tmpPath);
        if ($in === false) {
            fclose($tmp);
            throw new RuntimeException('Download failed');
        }
        fclose($tmp);
        return $in;
    }

    public function putStream(string $path, $stream): int
    {
        $this->assertWritable();
        $tmpPath = tempnam(sys_get_temp_dir(), 'ansnew_smb_put_');
        if ($tmpPath === false) {
            throw new RuntimeException('Cannot create temporary file');
        }
        $out = fopen($tmpPath, 'wb');
        if ($out === false) {
            @unlink($tmpPath);
            throw new RuntimeException('Cannot create temporary file');
        }
        $bytes = stream_copy_to_stream($stream, $out);
        fclose($out);

        $parent = PathGuard::dirname($path);
        if ($parent !== '/' && !$this->exists($parent)) {
            $this->mkdir($parent, true);
        }

        $result = $this->exec(['-c', 'put ' . $tmpPath . ' ' . $this->remote($path)]);
        @unlink($tmpPath);
        $this->assertOk($result, 'Upload');
        return is_int($bytes) ? $bytes : 0;
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
}
