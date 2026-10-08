<?php

declare(strict_types=1);

namespace App\Core;

/**
 * Immutable-ish HTTP request wrapper.
 */
final class Request
{
    /** @var array<string,string> */
    private array $headers = [];

    /** @var array<string,mixed> */
    private array $query;

    /** @var array<string,mixed> */
    private array $body = [];

    private ?string $rawBody = null;

    /** @var array<string,mixed> */
    private array $files;

    /** @var array<string,mixed>|null */
    private ?array $jsonCache = null;

    public function __construct(
        public readonly string $method,
        public readonly string $path,
        array $query = [],
        array $files = [],
    ) {
        $this->query = $query;
        $this->files = self::flattenFiles($files);

        foreach ($_SERVER as $k => $v) {
            if (str_starts_with($k, 'HTTP_')) {
                $name = strtolower(str_replace('_', '-', substr($k, 5)));
                $this->headers[$name] = (string) $v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) {
            $this->headers['content-type'] = (string) $_SERVER['CONTENT_TYPE'];
        }
        if (isset($_SERVER['CONTENT_LENGTH'])) {
            $this->headers['content-length'] = (string) $_SERVER['CONTENT_LENGTH'];
        }
    }

    public static function fromGlobals(): self
    {
        $uri = (string) ($_SERVER['REQUEST_URI'] ?? '/');
        $path = parse_url($uri, PHP_URL_PATH) ?: '/';
        // nginx/FastCGI passes the front-controller path; SCRIPT_NAME is /index.php
        $method = strtoupper((string) ($_SERVER['REQUEST_METHOD'] ?? 'GET'));
        return new self($method, $path, $_GET, $_FILES);
    }

    public function header(string $name): ?string
    {
        return $this->headers[strtolower($name)] ?? null;
    }

    public function isJson(): bool
    {
        $ct = $this->header('content-type') ?? '';
        return str_contains(strtolower($ct), 'application/json');
    }

    public function isMultipart(): bool
    {
        $ct = $this->header('content-type') ?? '';
        return str_contains(strtolower($ct), 'multipart/form-data');
    }

    /** @return array<string,mixed> */
    public function json(): array
    {
        if ($this->jsonCache !== null) {
            return $this->jsonCache;
        }
        $raw = $this->rawBody();
        if ($raw === '') {
            return $this->jsonCache = [];
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new \InvalidArgumentException('Malformed JSON body');
        }
        return $this->jsonCache = $data;
    }

    public function rawBody(): string
    {
        if ($this->rawBody === null) {
            $this->rawBody = (string) file_get_contents('php://input');
        }
        return $this->rawBody;
    }

    public function rawStream()
    {
        return fopen('php://input', 'rb');
    }

    public function contentLength(): int
    {
        return (int) ($this->header('content-length') ?? 0);
    }

    /** @return array<string,mixed> */
    public function all(): array
    {
        $body = $this->isJson() ? $this->json() : ($_POST ?: []);
        $body = array_merge($body, $this->body);
        return array_merge($body, $this->query);
    }

    public function input(string $key, mixed $default = null): mixed
    {
        $all = $this->all();
        return $all[$key] ?? $default;
    }

    public function query(string $key, mixed $default = null): mixed
    {
        return $this->query[$key] ?? $default;
    }

    /** @return array<string,mixed> */
    public function queryAll(): array
    {
        return $this->query;
    }

    /** @return array<string,mixed> */
    /** @return array<int, array<string,mixed>> one descriptor per uploaded file */
    public function files(): array
    {
        return $this->files;
    }

    /**
     * Normalise PHP's two possible $_FILES shapes into a flat list.
     *
     * A single `<input name="files">` arrives as one associative descriptor, but
     * a repeated field (`files[]`, which is what a multi-select or a folder
     * upload produces) arrives as *parallel arrays*: `name[0], name[1], …`,
     * `tmp_name[0], tmp_name[1], …`. Iterating that as if it were one file made
     * `is_uploaded_file()` receive an array, so every file after the first was
     * silently dropped — a multi-file upload appeared to "work" while only one
     * file ever landed.
     *
     * @param array<string,mixed> $files
     * @return array<int, array<string,mixed>>
     */
    private static function flattenFiles(array $files): array
    {
        $out = [];
        foreach ($files as $field) {
            if (!is_array($field) || !array_key_exists('name', $field)) {
                continue;
            }
            if (!is_array($field['name'])) {
                $out[] = $field;
                continue;
            }
            foreach (array_keys($field['name']) as $i) {
                $out[] = [
                    'name' => (string) ($field['name'][$i] ?? ''),
                    'full_path' => (string) ($field['full_path'][$i] ?? ''),
                    'type' => (string) ($field['type'][$i] ?? ''),
                    'tmp_name' => (string) ($field['tmp_name'][$i] ?? ''),
                    'error' => (int) ($field['error'][$i] ?? UPLOAD_ERR_NO_FILE),
                    'size' => (int) ($field['size'][$i] ?? 0),
                ];
            }
        }
        return $out;
    }

    /**
     * Client IP used for rate limiting, login lockout and the audit log.
     *
     * X-Forwarded-For is honoured ONLY when the operator opted in
     * (TRUST_PROXY=true) AND the immediate peer is a private/loopback address —
     * i.e. a proxy we control really is in front. Otherwise the header is just
     * client-supplied text, and trusting it lets anyone forge the IP that
     * lockouts and rate limits key on.
     *
     * The LAST hop is taken, not the first: our edge overwrites the header, so
     * the last entry is the address it actually observed, while a
     * client-injected prefix is ignored.
     */
    public function ip(): string
    {
        $remote = (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');

        if (!\App\Config\Config::i()->getBool('TRUST_PROXY', false) || !self::isProxyPeer($remote)) {
            return $remote;
        }

        $xff = $this->header('x-forwarded-for');
        if ($xff !== null && $xff !== '') {
            $parts = array_values(array_filter(
                array_map('trim', explode(',', $xff)),
                static fn (string $p): bool => $p !== ''
            ));
            for ($i = count($parts) - 1; $i >= 0; $i--) {
                if (filter_var($parts[$i], FILTER_VALIDATE_IP) !== false) {
                    return $parts[$i];
                }
            }
        }

        // Some proxies only set X-Real-IP.
        $real = $this->header('x-real-ip');
        if ($real !== null && filter_var(trim($real), FILTER_VALIDATE_IP) !== false) {
            return trim($real);
        }

        return $remote;
    }

    /** True when the peer is loopback/private/reserved — i.e. a proxy we control. */
    private static function isProxyPeer(string $ip): bool
    {
        return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
    }

    public function userAgent(): string
    {
        return substr((string) ($this->header('user-agent') ?? ''), 0, 255);
    }

    public function origin(): ?string
    {
        return $this->header('origin');
    }

    public function referer(): ?string
    {
        return $this->header('referer');
    }

    /**
     * Frontend SPA never runs outside the same origin, so any Origin/Referer
     * that is present must match the configured APP_URL authority or the
     * request's own Host (true same-origin, e.g. localhost vs 127.0.0.1).
     */
    public function originIsTrusted(string $appUrl): bool
    {
        $appHost = parse_url($appUrl, PHP_URL_HOST);
        $reqHost = $this->header('host');
        $reqHost = $reqHost !== null ? (string) parse_url('http://' . $reqHost, PHP_URL_HOST) : null;
        foreach ([$this->origin(), $this->referer()] as $candidate) {
            if ($candidate === null || $candidate === '') {
                continue;
            }
            $host = parse_url($candidate, PHP_URL_HOST);
            if ($host === false || $host === null) {
                return false;
            }
            if ($reqHost !== null && strcasecmp($host, (string) $reqHost) === 0) {
                continue;
            }
            if ($appHost !== null && strcasecmp($host, (string) $appHost) !== 0) {
                return false;
            }
        }
        return true;
    }
}
