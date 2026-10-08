<?php

declare(strict_types=1);

namespace App\Storage\Adapters;

use App\Storage\ConnectionConfig;
use App\Storage\StorageAdapter;
use App\Support\PathGuard;
use App\Support\SsrfGuard;
use RuntimeException;

/**
 * S3 / S3-compatible object storage.
 *
 * Deliberately implemented directly against the S3 REST API with AWS Signature
 * Version 4 rather than pulling in aws/aws-sdk-php: it keeps the image free of a
 * large dependency, matches how the other remote adapters here work (cURL), and
 * covers every S3-compatible provider — Amazon S3, Cloudflare R2, MinIO,
 * Backblaze B2, Wasabi, Ceph, DigitalOcean Spaces — by pointing at a different
 * endpoint.
 *
 * Object stores have no real directories. "Folders" are therefore represented by
 * a zero-byte marker object ending in "/", which is what the S3 console and every
 * other client does. A listing asks for a single delimiter-separated level, so
 * deep prefixes cost one request rather than a full recursive walk.
 */
final class S3Adapter implements StorageAdapter
{
    private const ALGO = 'AWS4-HMAC-SHA256';
    private const SERVICE = 's3';

    private string $endpoint;
    private string $region;
    private string $bucket;
    private string $accessKey;
    private string $secretKey;
    private bool $pathStyle;

    public function __construct(ConnectionConfig $cfg, private readonly bool $readOnly = false)
    {
        $host = trim($cfg->host);
        if ($host === '') {
            throw new RuntimeException('S3 connection is missing an endpoint');
        }
        // Accept either a bare host or a full URL.
        if (preg_match('~^https?://~i', $host) === 1) {
            $parts = parse_url($host);
            $scheme = strtolower((string) ($parts['scheme'] ?? 'https'));
            $host = (string) ($parts['host'] ?? '');
            $port = isset($parts['port']) ? (int) $parts['port'] : null;
        } else {
            $scheme = 'https';
            $port = $cfg->port > 0 ? $cfg->port : null;
        }
        // Never carry a scheme's DEFAULT port into the endpoint. curl omits the
        // default port (443 for https, 80 for http) from the Host header it
        // actually sends, so if we sign `host:443` the request R2/S3 receives
        // canonicalises to `host` and the signature can never match
        // (SignatureDoesNotMatch). The DB always stores port=443 for S3, so this
        // broke every S3-compatible mount, not just R2.
        if (($scheme === 'https' && $port === 443) || ($scheme === 'http' && $port === 80)) {
            $port = null;
        }
        SsrfGuard::validateHost($host);

        $extra = is_array($cfg->extra) ? $cfg->extra : [];
        $this->bucket = trim((string) ($extra['bucket'] ?? ''));
        if ($this->bucket === '') {
            throw new RuntimeException('S3 connection is missing a bucket');
        }
        $this->region = trim((string) ($extra['region'] ?? '')) ?: 'us-east-1';
        // R2 and MinIO need path-style; virtual-host is the AWS default.
        $this->pathStyle = (bool) ($extra['path_style'] ?? false);

        $this->accessKey = $cfg->username;
        $this->secretKey = (string) $cfg->secret;
        if ($this->accessKey === '' || $this->secretKey === '') {
            throw new RuntimeException('S3 connection is missing credentials');
        }

        $this->endpoint = $scheme . '://' . $host . ($port !== null ? ':' . $port : '');
    }

    /* ------------------------------------------------------------ interface */

    public function list(string $path): array
    {
        $prefix = $this->prefixFor($path);
        $entries = [];

        $result = $this->request('GET', '', [
            'list-type' => '2',
            'delimiter' => '/',
            'prefix' => $prefix,
            'max-keys' => '1000',
        ]);
        $xml = $this->parseXml($result['body']);

        // Common prefixes => sub-directories.
        foreach ($xml->CommonPrefixes ?? [] as $cp) {
            $full = (string) $cp->Prefix;
            $name = rtrim(substr($full, strlen($prefix)), '/');
            if ($name === '') {
                continue;
            }
            $entries[] = $this->entry($name, PathGuard::join($path, $name), 'dir', 0, 0);
        }

        foreach ($xml->Contents ?? [] as $obj) {
            $key = (string) $obj->Key;
            if ($key === $prefix) {
                continue;   // the directory marker itself
            }
            $name = substr($key, strlen($prefix));
            if ($name === '' || str_ends_with($name, '/')) {
                continue;
            }
            $entries[] = $this->entry(
                $name,
                PathGuard::join($path, $name),
                'file',
                (int) $obj->Size,
                (int) strtotime((string) $obj->LastModified)
            );
        }

        usort($entries, static function (array $a, array $b): int {
            if ($a['type'] !== $b['type']) {
                return $a['type'] === 'dir' ? -1 : 1;
            }
            return strcasecmp($a['name'], $b['name']);
        });
        return $entries;
    }

    public function stat(string $path): array
    {
        $key = $this->keyFor($path);
        if ($key === '') {
            return $this->entry('', '/', 'dir', 0, 0);
        }
        try {
            $r = $this->request('HEAD', $key);
        } catch (RuntimeException $e) {
            // Not an object — it may still be a "directory" prefix.
            if ($this->isDir($path)) {
                return $this->entry(basename($key), $path, 'dir', 0, 0);
            }
            throw $e;
        }
        return $this->entry(
            basename($key),
            $path,
            'file',
            (int) ($r['headers']['content-length'] ?? 0),
            (int) strtotime((string) ($r['headers']['last-modified'] ?? 'now'))
        );
    }

    public function exists(string $path): bool
    {
        $key = $this->keyFor($path);
        if ($key === '') {
            return true;
        }
        try {
            $this->request('HEAD', $key);
            return true;
        } catch (RuntimeException $e) {
            return $this->isDir($path);
        }
    }

    public function isDir(string $path): bool
    {
        $prefix = $this->prefixFor($path);
        // The bucket root is ALWAYS a directory, even when the bucket is empty.
        // Probing it by prefix would report "not a directory" for an empty bucket
        // (no keys, no common prefixes) and make the whole drive unlistable —
        // which is exactly what happens to a freshly-added S3 bucket.
        if ($prefix === '') {
            return true;
        }
        $result = $this->request('GET', '', [
            'list-type' => '2',
            'delimiter' => '/',
            'prefix' => $prefix,
            'max-keys' => '1',
        ]);
        $xml = $this->parseXml($result['body']);
        return ((int) ($xml->KeyCount ?? 0)) > 0 || isset($xml->CommonPrefixes);
    }

    /** Object stores have no mkdir: a trailing-slash marker stands in for one. */
    public function mkdir(string $path, bool $recursive = true): void
    {
        $this->assertWritable();
        $key = $this->prefixFor($path);
        if ($key === '') {
            return;
        }
        $this->request('PUT', $key, [], [], '');
    }

    public function delete(string $path, bool $recursive = false): void
    {
        $this->assertWritable();
        $key = $this->keyFor($path);

        // Descend by prefix ONLY when the path really is a directory. A plain
        // object passed with $recursive=true (which the permanent-delete path
        // does for every entry) must delete the object itself: prefixFor()
        // appends "/", which matches no keys, so the file was silently left
        // behind while the API still reported success.
        if ($this->isDir($path)) {
            $prefix = $this->prefixFor($path);
            foreach ($this->allKeys($prefix) as $k) {
                $this->request('DELETE', $k);
            }
            return;
        }
        $this->request('DELETE', $key);
    }

    public function rename(string $from, string $to): void
    {
        $this->assertWritable();
        if ($this->isDir($from)) {
            $fromPrefix = $this->prefixFor($from);
            $toPrefix = $this->prefixFor($to);
            $keys = $this->allKeys($fromPrefix);
            foreach ($keys as $k) {
                $target = $toPrefix . substr($k, strlen($fromPrefix));
                $this->copyKey($k, $target);
            }
            foreach ($keys as $k) {
                $this->request('DELETE', $k);
            }
            return;
        }
        $this->copyKey($this->keyFor($from), $this->keyFor($to));
        $this->request('DELETE', $this->keyFor($from));
    }

    public function copy(string $from, string $to): void
    {
        $this->assertWritable();
        if ($this->isDir($from)) {
            $fromPrefix = $this->prefixFor($from);
            $toPrefix = $this->prefixFor($to);
            foreach ($this->allKeys($fromPrefix) as $k) {
                $this->copyKey($k, $toPrefix . substr($k, strlen($fromPrefix)));
            }
            return;
        }
        $this->copyKey($this->keyFor($from), $this->keyFor($to));
    }

    public function getStream(string $path, int $from = -1, int $to = -1)
    {
        $key = $this->keyFor($path);
        $headers = [];
        if ($from >= 0) {
            $headers['range'] = 'bytes=' . $from . '-' . ($to >= 0 ? $to : '');
        }
        // Stream straight to a temp handle so a large object never lands in RAM.
        $tmp = tmpfile();
        if ($tmp === false) {
            throw new RuntimeException('Cannot allocate a download buffer');
        }
        $this->request('GET', $key, [], $headers, null, $tmp);
        rewind($tmp);
        return $tmp;
    }

    public function putStream(string $path, $stream): int
    {
        $this->assertWritable();
        // SigV4 needs the payload hash, so the body has to be known up front.
        // Buffer to a temp file rather than memory.
        $tmp = tmpfile();
        if ($tmp === false) {
            throw new RuntimeException('Cannot allocate an upload buffer');
        }
        $written = 0;
        while (!feof($stream)) {
            $chunk = fread($stream, 262144);
            if ($chunk === false || $chunk === '') {
                break;
            }
            fwrite($tmp, $chunk);
            $written += strlen($chunk);
        }
        rewind($tmp);

        $this->request('PUT', $this->keyFor($path), [], [], $tmp);
        fclose($tmp);
        return $written;
    }

    public function du(string $path = '/'): array
    {
        $used = 0;
        $files = 0;
        $dirs = 0;
        $seenDirs = [];
        // One paginated listing carries both the size and the key, so a second
        // pass over the whole prefix would just double the requests.
        foreach ($this->allObjects($this->prefixFor($path)) as $obj) {
            $files++;
            $used += (int) $obj['size'];
            $dir = dirname((string) $obj['key']);
            if ($dir !== '.' && !isset($seenDirs[$dir])) {
                $seenDirs[$dir] = true;
                $dirs++;
            }
        }
        return ['used' => $used, 'files' => $files, 'dirs' => $dirs];
    }

    public function search(string $path, string $needle, int $limit = 200): array
    {
        $needle = strtolower($needle);
        $prefix = $this->prefixFor($path);
        $out = [];
        foreach ($this->allObjects($prefix) as $obj) {
            $name = basename($obj['key']);
            if (str_contains(strtolower($name), $needle)) {
                $out[] = $this->entry($name, '/' . $obj['key'], 'file', (int) $obj['size'], (int) $obj['mtime']);
            }
            if (count($out) >= $limit) {
                break;
            }
        }
        return $out;
    }

    /* ------------------------------------------------------------- helpers */

    private function assertWritable(): void
    {
        if ($this->readOnly) {
            throw new RuntimeException('This mount is read-only', 403);
        }
    }

    /** Virtual path -> object key (no leading slash). */
    private function keyFor(string $path): string
    {
        $p = PathGuard::normalize($path);
        return ltrim($p, '/');
    }

    /** Virtual path -> key prefix, always ending in "/" (or empty at the root). */
    private function prefixFor(string $path): string
    {
        $key = $this->keyFor($path);
        return $key === '' ? '' : $key . '/';
    }

    /** @return array<string,mixed> */
    private function entry(string $name, string $path, string $type, int $size, int $mtime): array
    {
        $dot = strrpos($name, '.');
        return [
            'name' => $name,
            'path' => $path,
            'type' => $type,
            'size' => $type === 'dir' ? 0 : $size,
            'mtime' => $mtime,
            'mode' => $type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--',
            'writable' => !$this->readOnly,
            'owner' => '',
            'group' => '',
            'isLink' => false,
            'mime' => $type === 'dir' ? '' : $this->mimeFor($name),
            'extension' => $type === 'dir' || $dot === false || $dot === 0 ? '' : strtolower(substr($name, $dot + 1)),
        ];
    }

    private function mimeFor(string $name): string
    {
        $ext = strtolower((string) pathinfo($name, PATHINFO_EXTENSION));
        return match ($ext) {
            'jpg', 'jpeg' => 'image/jpeg',
            'png' => 'image/png',
            'gif' => 'image/gif',
            'webp' => 'image/webp',
            'svg' => 'image/svg+xml',
            'pdf' => 'application/pdf',
            'json' => 'application/json',
            'txt', 'md', 'log' => 'text/plain',
            'csv' => 'text/csv',
            'zip' => 'application/zip',
            'mp4' => 'video/mp4',
            'mp3' => 'audio/mpeg',
            default => 'application/octet-stream',
        };
    }

    /** @return string[] every key under a prefix (paged) */
    private function allKeys(string $prefix): array
    {
        $keys = [];
        foreach ($this->allObjects($prefix) as $obj) {
            $keys[] = $obj['key'];
        }
        return $keys;
    }

    /** @return array<int,array{key:string,size:int,mtime:int}> */
    private function allObjects(string $prefix): array
    {
        $out = [];
        $token = null;
        do {
            $query = ['list-type' => '2', 'prefix' => $prefix, 'max-keys' => '1000'];
            if ($token !== null) {
                $query['continuation-token'] = $token;
            }
            $result = $this->request('GET', '', $query);
            $xml = $this->parseXml($result['body']);
            foreach ($xml->Contents ?? [] as $obj) {
                $key = (string) $obj->Key;
                if (str_ends_with($key, '/')) {
                    continue;   // directory marker
                }
                $out[] = [
                    'key' => $key,
                    'size' => (int) $obj->Size,
                    'mtime' => (int) strtotime((string) $obj->LastModified),
                ];
            }
            $truncated = strtolower((string) ($xml->IsTruncated ?? 'false')) === 'true';
            $token = $truncated ? (string) $xml->NextContinuationToken : null;
        } while ($token !== null && $token !== '');
        return $out;
    }

    /** Server-side copy — the bytes never travel through this process. */
    private function copyKey(string $from, string $to): void
    {
        $this->assertWritable();
        $this->request('PUT', $to, [], [
            'x-amz-copy-source' => '/' . $this->bucket . '/' . str_replace('%2F', '/', rawurlencode($from)),
        ], '');
    }

    private function parseXml(string $body): \SimpleXMLElement
    {
        $prev = libxml_use_internal_errors(true);
        $xml = simplexml_load_string($body);
        libxml_use_internal_errors($prev);
        if ($xml === false) {
            throw new RuntimeException('Unexpected response from object storage');
        }
        return $xml;
    }

    /* -------------------------------------------------------------- signing */

    /**
     * Sign and execute one S3 request.
     *
     * @param array<string,string> $query
     * @param array<string,string> $headers
     * @param resource|string|null $body
     * @return array{status:int,headers:array<string,string>,body:string}
     */
    private function request(
        string $method,
        string $key,
        array $query = [],
        array $headers = [],
        $body = null,
        $sink = null
    ): array {
        $uriPath = '/' . $key;
        if ($this->pathStyle) {
            $uriPath = '/' . $this->bucket . $uriPath;
        }
        // Encode each segment but keep the separators.
        $canonicalUri = implode('/', array_map(
            static fn (string $s): string => rawurlencode($s),
            explode('/', $uriPath)
        ));
        if ($canonicalUri === '') {
            $canonicalUri = '/';
        }

        // Payload + its SHA-256 (required for header-based SigV4).
        $payloadHash = hash('sha256', '');
        $bodyLength = 0;
        if (is_resource($body)) {
            $stat = fstat($body);
            $bodyLength = (int) ($stat['size'] ?? 0);
            $ctx = hash_init('sha256');
            $pos = ftell($body);
            rewind($body);
            hash_update_stream($ctx, $body);
            $payloadHash = hash_final($ctx);
            fseek($body, $pos === false ? 0 : $pos);
        } elseif (is_string($body)) {
            $bodyLength = strlen($body);
            $payloadHash = hash('sha256', $body);
        }

        ksort($query);
        $canonicalQuery = http_build_query($query, '', '&', PHP_QUERY_RFC3986);

        $host = parse_url($this->endpoint, PHP_URL_HOST);
        $port = parse_url($this->endpoint, PHP_URL_PORT);
        $hostHeader = $host . ($port !== null ? ':' . $port : '');

        $amzDate = gmdate('Ymd\THis\Z');

        $allHeaders = array_change_key_case($headers, CASE_LOWER);
        $allHeaders['host'] = $hostHeader;
        $allHeaders['x-amz-content-sha256'] = $payloadHash;
        $allHeaders['x-amz-date'] = $amzDate;
        ksort($allHeaders);

        $authorization = self::buildAuthorization(
            $method,
            $canonicalUri,
            $canonicalQuery,
            $allHeaders,
            $payloadHash,
            $amzDate,
            $this->region,
            $this->accessKey,
            $this->secretKey
        );

        $url = $this->endpoint . $canonicalUri . ($canonicalQuery !== '' ? '?' . $canonicalQuery : '');

        $curlHeaders = ['Authorization: ' . $authorization];
        foreach ($allHeaders as $k => $v) {
            if ($k === 'host') {
                continue;
            }
            $curlHeaders[] = $k . ': ' . $v;
        }

        $ch = curl_init($url);
        if ($ch === false) {
            throw new RuntimeException('Cannot initialise the object storage request');
        }
        $responseHeaders = [];
        $options = [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => $curlHeaders,
            CURLOPT_RETURNTRANSFER => $sink === null,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => 300,
            CURLOPT_NOSIGNAL => true,
            CURLOPT_HEADERFUNCTION => function ($ch, string $line) use (&$responseHeaders): int {
                $parts = explode(':', $line, 2);
                if (count($parts) === 2) {
                    $responseHeaders[strtolower(trim($parts[0]))] = trim($parts[1]);
                }
                return strlen($line);
            },
        ];
        if ($sink !== null) {
            $options[CURLOPT_FILE] = $sink;
        }
        if ($method !== 'GET' && $method !== 'HEAD') {
            $options[CURLOPT_POSTFIELDS] = is_resource($body) ? '' : (string) ($body ?? '');
            if (is_resource($body)) {
                $options[CURLOPT_UPLOAD] = true;
                $options[CURLOPT_INFILE] = $body;
                $options[CURLOPT_INFILESIZE] = $bodyLength;
                unset($options[CURLOPT_POSTFIELDS]);
            } elseif ($bodyLength > 0) {
                $curlHeaders[] = 'Content-Length: ' . $bodyLength;
                $options[CURLOPT_HTTPHEADER] = $curlHeaders;
            }
        }
        // A HEAD response carries headers but no body. Without NOBODY, curl keeps
        // waiting for the Content-Length the server advertised and the request
        // hangs until CURLOPT_TIMEOUT — which broke exists()/stat() and therefore
        // EVERY upload (the post-PUT stat() is a HEAD) and every conflict check.
        if ($method === 'HEAD') {
            $options[CURLOPT_NOBODY] = true;
        }
        curl_setopt_array($ch, $options);

        $responseBody = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err = curl_error($ch);
        curl_close($ch);

        if ($responseBody === false && $sink === null) {
            throw new RuntimeException('Object storage request failed: ' . ($err !== '' ? $err : 'unknown error'));
        }
        $text = is_string($responseBody) ? $responseBody : '';

        if ($status >= 400) {
            throw new RuntimeException($this->errorMessage($status, $text), $status === 404 ? 404 : 0);
        }
        return ['status' => $status, 'headers' => $responseHeaders, 'body' => $text];
    }

    /**
     * Compute the SigV4 Authorization header.
     *
     * Kept separate from the transport so the signing can be checked on its own
     * against AWS's published test vectors — a signature bug otherwise only
     * shows up as a 403 against a live bucket.
     *
     * @param array<string,string> $allHeaders already lower-cased and sorted,
     *                                          and must include `host`,
     *                                          `x-amz-content-sha256`, `x-amz-date`
     */
    public static function buildAuthorization(
        string $method,
        string $canonicalUri,
        string $canonicalQuery,
        array $allHeaders,
        string $payloadHash,
        string $amzDate,
        string $region,
        string $accessKey,
        string $secretKey
    ): string {
        $canonicalHeaders = '';
        foreach ($allHeaders as $k => $v) {
            $canonicalHeaders .= $k . ':' . trim(preg_replace('/\s+/', ' ', (string) $v)) . "\n";
        }
        $signedHeaders = implode(';', array_keys($allHeaders));

        $canonicalRequest = implode("\n", [
            $method,
            $canonicalUri,
            $canonicalQuery,
            $canonicalHeaders,
            $signedHeaders,
            $payloadHash,
        ]);

        $dateStamp = substr($amzDate, 0, 8);
        $scope = $dateStamp . '/' . $region . '/' . self::SERVICE . '/aws4_request';
        $stringToSign = implode("\n", [
            self::ALGO,
            $amzDate,
            $scope,
            hash('sha256', $canonicalRequest),
        ]);

        $kDate = hash_hmac('sha256', $dateStamp, 'AWS4' . $secretKey, true);
        $kRegion = hash_hmac('sha256', $region, $kDate, true);
        $kService = hash_hmac('sha256', self::SERVICE, $kRegion, true);
        $kSigning = hash_hmac('sha256', 'aws4_request', $kService, true);
        $signature = hash_hmac('sha256', $stringToSign, $kSigning);

        // Comma with no space, exactly as the specification's worked examples
        // show it (AWS's own SDKs emit ", "; both are accepted, this form is
        // byte-identical to the published test vectors).
        return self::ALGO . ' Credential=' . $accessKey . '/' . $scope
            . ',SignedHeaders=' . $signedHeaders . ',Signature=' . $signature;
    }

    /** Turn an S3 XML error into something a user can act on. */
    private function errorMessage(int $status, string $body): string
    {
        $code = '';
        $message = '';
        if ($body !== '') {
            $prev = libxml_use_internal_errors(true);
            $xml = simplexml_load_string($body);
            libxml_use_internal_errors($prev);
            if ($xml !== false) {
                $code = (string) ($xml->Code ?? '');
                $message = (string) ($xml->Message ?? '');
            }
        }
        if ($status === 404 || $code === 'NoSuchKey' || $code === 'NoSuchBucket') {
            return 'Not found in object storage' . ($message !== '' ? ': ' . $message : '');
        }
        if ($status === 403 || $code === 'AccessDenied' || $code === 'SignatureDoesNotMatch') {
            return 'Object storage rejected the credentials'
                . ($code !== '' ? ' (' . $code . ')' : '')
                . ($message !== '' ? ': ' . $message : '');
        }
        return 'Object storage error' . ($code !== '' ? ' ' . $code : ' (HTTP ' . $status . ')')
            . ($message !== '' ? ': ' . $message : '');
    }

    /**
     * Connectivity probe for the admin/user "test connection" button.
     *
     * @return array{reachable:bool,error?:string}
     */
    public static function probe(ConnectionConfig $cfg): array
    {
        try {
            $adapter = new self($cfg);
            $adapter->request('GET', '', ['list-type' => '2', 'max-keys' => '1']);
            return ['reachable' => true];
        } catch (\Throwable $e) {
            return ['reachable' => false, 'error' => substr($e->getMessage(), 0, 200)];
        }
    }
}
