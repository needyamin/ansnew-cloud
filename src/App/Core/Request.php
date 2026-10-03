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
        $this->files = $files;

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
    public function files(): array
    {
        return $this->files;
    }

    public function ip(): string
    {
        $xff = $this->header('x-forwarded-for');
        if ($xff !== null && $xff !== '') {
            $first = trim(explode(',', $xff)[0]);
            if (filter_var($first, FILTER_VALIDATE_IP) !== false) {
                return $first;
            }
        }
        return (string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0');
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
