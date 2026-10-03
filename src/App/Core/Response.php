<?php

declare(strict_types=1);

namespace App\Core;

/**
 * Minimal response builder + JSON/error helpers.
 */
class Response
{
    /** @var resource|null streaming body (download responses) */
    private $stream = null;

    private int $streamLength = -1;
    /** @var array<string,string> */
    private array $headers = [];

    private int $status = 200;

    private string $body = '';

    public function __construct(int $status = 200, string $body = '')
    {
        $this->status = $status;
        $this->body = $body;
    }

    public static function json(mixed $data, int $status = 200): self
    {
        $r = new self($status, json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?: '{}');
        $r->headers['content-type'] = 'application/json; charset=utf-8';
        return $r;
    }

    public static function error(string $message, int $status = 400, string $code = 'error', array $extra = []): self
    {
        return self::json(array_merge([
            'ok' => false,
            'error' => ['code' => $code, 'message' => $message],
        ], $extra), $status);
    }

    public static function ok(mixed $data = null, array $extra = []): self
    {
        return self::json(array_merge(['ok' => true, 'data' => $data], $extra));
    }

    public static function noContent(): self
    {
        return new self(204, '');
    }

    public static function text(string $body, int $status = 200, string $contentType = 'text/plain; charset=utf-8'): self
    {
        $r = new self($status, $body);
        $r->headers['content-type'] = $contentType;
        return $r;
    }

    public function withHeader(string $name, string $value): self
    {
        $this->headers[strtolower($name)] = $value;
        return $this;
    }

    public function status(): int
    {
        return $this->status;
    }

    /** @return array<string,string> */
    public function headers(): array
    {
        return $this->headers;
    }

    public function body(): string
    {
        return $this->body;
    }

    public function withStream($stream, int $length = -1): self
    {
        $this->stream = $stream;
        $this->streamLength = $length;
        return $this;
    }

    public function send(): void
    {
        http_response_code($this->status);
        foreach ($this->headers as $k => $v) {
            header($k . ': ' . $v, true);
        }
        if ($this->stream !== null) {
            $out = fopen('php://output', 'wb');
            if ($out !== false) {
                while (!feof($this->stream)) {
                    $chunk = fread($this->stream, 262144);
                    if ($chunk === false || $chunk === '') {
                        break;
                    }
                    fwrite($out, $chunk);
                }
                fclose($out);
            }
            fclose($this->stream);
            return;
        }
        echo $this->body;
    }
}
