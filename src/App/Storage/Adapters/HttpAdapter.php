<?php

declare(strict_types=1);

namespace App\Storage\Adapters;

use App\Storage\ConnectionConfig;
use App\Storage\StorageAdapter;
use App\Support\PathGuard;
use App\Support\SsrfGuard;
use RuntimeException;

/**
 * HTTP / WebDAV adapter (cURL).
 *
 * Supported verbs: PROPFIND (list/stat), GET, PUT, MKCOL, DELETE, MOVE, COPY.
 * SSRF: the target host is validated by SsrfGuard on every request, and cURL is
 * configured to never follow redirects to a different host.
 */
final class HttpAdapter implements StorageAdapter
{
    private string $baseUrl;

    public function __construct(private readonly ConnectionConfig $cfg, private readonly bool $readOnly = false)
    {
        SsrfGuard::validateHost($cfg->host);
        $scheme = ($cfg->extra['scheme'] ?? null) === 'http' ? 'http' : 'https';
        $port = $cfg->port > 0 ? ':' . $cfg->port : '';
        $base = '/' . ltrim($cfg->remoteBase !== '' ? $cfg->remoteBase : '/', '/');
        $this->baseUrl = $scheme . '://' . $cfg->host . $port . rtrim($base, '/');
    }

    /** Virtual path → absolute URL. */
    private function url(string $virtualPath): string
    {
        $v = PathGuard::normalize($virtualPath);
        $encoded = implode('/', array_map('rawurlencode', array_filter(explode('/', $v), static fn ($p) => $p !== '')));
        return $this->baseUrl . ($encoded === '' ? '/' : '/' . $encoded);
    }

    private function assertWritable(): void
    {
        if ($this->readOnly) {
            throw new RuntimeException('Mount is read-only', 403);
        }
    }

    /**
     * @param array<int,string> $extraHeaders
     * @return array{status:int, headers:array<string,string>, body:string, handle:resource}
     */
    private function request(string $method, string $url, array $extraHeaders = [], mixed $body = null, ?string $uploadFile = null): array
    {
        // Re-validate on every call: DNS could have changed (rebinding defense).
        SsrfGuard::validateHost($this->cfg->host);

        $ch = curl_init();
        if ($ch === false) {
            throw new RuntimeException('Cannot initialize HTTP client');
        }

        $headers = array_merge([
            'User-Agent: ANSNEW CLOUD/1.0',
            'Accept: */*',
        ], $extraHeaders);

        $auth = $this->authHeader();
        if ($auth !== '') {
            $headers[] = 'Authorization: ' . $auth;
        }

        curl_setopt_array($ch, [
            CURLOPT_URL => $url,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => $body === null && $uploadFile === null,
            CURLOPT_HEADER => false,
            CURLOPT_FOLLOWLOCATION => false,       // no cross-host redirect following
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => 300,
            CURLOPT_SSL_VERIFYPEER => $this->cfg->verifyTls,
            CURLOPT_SSL_VERIFYHOST => $this->cfg->verifyTls ? 2 : 0,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
            CURLOPT_HEADERFUNCTION => function ($ch2, string $line) use (&$respHeaders) {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $respHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ]);

        if ($uploadFile !== null) {
            $fh = fopen($uploadFile, 'rb');
            if ($fh === false) {
                curl_close($ch);
                throw new RuntimeException('Cannot open upload buffer');
            }
            curl_setopt($ch, CURLOPT_INFILE, $fh);
            curl_setopt($ch, CURLOPT_INFILESIZE, filesize($uploadFile));
            curl_setopt($ch, CURLOPT_UPLOAD, true);
        } elseif ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }

        $respHeaders = [];
        $response = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if (isset($fh) && is_resource($fh)) {
            fclose($fh);
        }
        if ($response === false && $status === 0) {
            throw new RuntimeException('HTTP request failed: ' . ($err !== '' ? 'network error' : 'unknown'));
        }

        return [
            'status' => $status,
            'headers' => $respHeaders,
            'body' => is_string($response) ? $response : '',
            'handle' => $ch,
        ];
    }

    private function authHeader(): string
    {
        if ($this->cfg->authType === 'none' || $this->cfg->username === '') {
            $token = (string) ($this->cfg->extra['token'] ?? '');
            return $token !== '' ? 'Bearer ' . $token : '';
        }
        $raw = $this->cfg->username . ':' . $this->cfg->secret;
        if (($this->cfg->extra['auth'] ?? '') === 'digest') {
            // Basic is the WebDAV norm; digest handled by option 'auth' => digest.
            return '';
        }
        return 'Basic ' . base64_encode($raw);
    }

    private function assertStatus(array $res, array $ok, string $what): void
    {
        if (!in_array($res['status'], $ok, true)) {
            if (in_array($res['status'], [401, 403], true)) {
                throw new RuntimeException('Remote access denied');
            }
            if ($res['status'] === 404) {
                throw new RuntimeException('Path not found', 404);
            }
            throw new RuntimeException($what . ' failed (HTTP ' . $res['status'] . ')');
        }
    }

    public function list(string $path): array
    {
        $body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop>'
            . '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>'
            . '</d:prop></d:propfind>';

        $res = $this->request('PROPFIND', $this->url($path), [
            'Depth: 1',
            'Content-Type: application/xml',
        ], $body);
        $this->assertStatus($res, [207, 200], 'List');

        $xml = @simplexml_load_string($res['body']);
        if ($xml === false) {
            throw new RuntimeException('Malformed WebDAV response');
        }
        $xml->registerXPathNamespace('d', 'DAV:');
        $responses = $xml->xpath('//d:response') ?: [];

        $baseHref = $this->url($path);
        $entries = [];
        foreach ($responses as $resp) {
            $resp->registerXPathNamespace('d', 'DAV:');
            $hrefNodes = $resp->xpath('d:href') ?: [];
            if ($hrefNodes === []) {
                continue;
            }
            $href = rawurldecode((string) $hrefNodes[0]);
            $isDir = ($resp->xpath('d:propstat/d:prop/d:resourcetype/d:collection') ?: []) !== [];
            $sizeNodes = $resp->xpath('d:propstat/d:prop/d:getcontentlength') ?: [];
            $mtimeNodes = $resp->xpath('d:propstat/d:prop/d:getlastmodified') ?: [];

            // Skip the collection entry itself.
            if (rtrim($href, '/') === rtrim(parse_url($baseHref, PHP_URL_PATH) ?? '', '/')) {
                continue;
            }
            $name = rawurldecode(basename(rtrim($href, '/')));
            if ($name === '' || $name === '.' || $name === '..') {
                continue;
            }
            $entries[] = [
                'name' => $name,
                'path' => PathGuard::join($path, $name),
                'type' => $isDir ? 'dir' : 'file',
                'size' => $isDir ? 0 : (int) ($sizeNodes[0] ?? 0),
                'mtime' => isset($mtimeNodes[0]) ? (int) (strtotime((string) $mtimeNodes[0]) ?: 0) : 0,
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
            $res = $this->request('HEAD', $this->url($path));
            if (in_array($res['status'], [200, 204, 301, 302], true)) {
                return true;
            }
            if ($res['status'] === 405) {
                $this->stat($path);
                return true;
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
        $parts = array_filter(explode('/', PathGuard::normalize($path)), static fn ($p) => $p !== '');
        $current = '';
        foreach ($parts as $part) {
            $current .= '/' . $part;
            $res = $this->request('MKCOL', $this->url($current));
            if (!in_array($res['status'], [201, 405], true)) {
                $this->assertStatus($res, [201, 405], 'Mkdir');
            }
        }
    }

    public function delete(string $path, bool $recursive = false): void
    {
        $this->assertWritable();
        if (PathGuard::normalize($path) === '/') {
            throw new RuntimeException('Refusing to delete the mount root');
        }
        if ($this->isDir($path)) {
            $items = $this->list($path);
            if ($items !== [] && !$recursive) {
                throw new RuntimeException('Directory is not empty');
            }
            foreach ($items as $item) {
                $this->delete((string) $item['path'], true);
            }
        }
        $res = $this->request('DELETE', $this->url($path));
        $this->assertStatus($res, [200, 204, 202], 'Delete');
    }

    public function rename(string $from, string $to): void
    {
        $this->assertWritable();
        $res = $this->request('MOVE', $this->url($from), [
            'Destination: ' . $this->url($to),
            'Overwrite: F',
        ]);
        $this->assertStatus($res, [201, 204], 'Rename');
    }

    public function copy(string $from, string $to): void
    {
        $this->assertWritable();
        $res = $this->request('COPY', $this->url($from), [
            'Destination: ' . $this->url($to),
            'Overwrite: F',
            'Depth: infinity',
        ]);
        $this->assertStatus($res, [201, 204], 'Copy');
    }

    public function getStream(string $path, int $from = -1, int $to = -1)
    {
        SsrfGuard::validateHost($this->cfg->host);
        $tmp = tmpfile();
        if ($tmp === false) {
            throw new RuntimeException('Cannot create temporary buffer');
        }

        $ch = curl_init();
        if ($ch === false) {
            fclose($tmp);
            throw new RuntimeException('Cannot initialize HTTP client');
        }

        $headers = ['User-Agent: ANSNEW CLOUD/1.0'];
        $auth = $this->authHeader();
        if ($auth !== '') {
            $headers[] = 'Authorization: ' . $auth;
        }
        if ($from >= 0) {
            $rangeEnd = $to >= 0 ? (string) $to : '';
            $headers[] = 'Range: bytes=' . $from . '-' . $rangeEnd;
        }

        curl_setopt_array($ch, [
            CURLOPT_URL => $this->url($path),
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_FILE => $tmp,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => 3600,
            CURLOPT_SSL_VERIFYPEER => $this->cfg->verifyTls,
            CURLOPT_SSL_VERIFYHOST => $this->cfg->verifyTls ? 2 : 0,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        ]);

        $ok = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);

        if ($ok === false || !in_array($status, [200, 206], true)) {
            fclose($tmp);
            if ($status === 404) {
                throw new RuntimeException('Path not found', 404);
            }
            throw new RuntimeException('Download failed (HTTP ' . $status . ')');
        }

        rewind($tmp);
        return $tmp;
    }

    public function putStream(string $path, $stream): int
    {
        $this->assertWritable();
        $tmpPath = tempnam(sys_get_temp_dir(), 'ansnew_http_put_');
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

        try {
            $res = $this->request('PUT', $this->url($path), [
                'Content-Type: application/octet-stream',
                'Content-Length: ' . filesize($tmpPath),
            ], null, $tmpPath);
            $this->assertStatus($res, [200, 201, 204], 'Upload');
        } finally {
            @unlink($tmpPath);
        }

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
