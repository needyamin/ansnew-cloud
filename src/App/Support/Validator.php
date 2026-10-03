<?php

declare(strict_types=1);

namespace App\Support;

use InvalidArgumentException;

/**
 * Input validation helpers. Strict, small, boring — on purpose.
 */
final class Validator
{
    /** @var array<string,string> */
    public const FORBIDDEN_UPLOAD_EXT = [
        'php','php3','php4','php5','php7','phps','phtml','phar','pht','cgi','pl','py',
        'sh','bash','zsh','ksh','htaccess','htpasswd','ini','env','exe','com','bat',
        'cmd','msi','scr','vbs','vbe','js','jse','wsf','wsh','ps1','psm1','jar','dll','so',
    ];

    public static function username(string $v): string
    {
        $v = trim($v);
        if (preg_match('/^[a-zA-Z0-9_.-]{3,64}$/', $v) !== 1) {
            throw new InvalidArgumentException('Username must be 3-64 chars: letters, digits, _ . -');
        }
        return strtolower($v);
    }

    public static function password(string $v): void
    {
        // The floor is configurable so local/dev deployments can bootstrap a
        // throwaway account (e.g. admin/admin). Unset, it stays at the safe
        // default of 10 — see PASSWORD_MIN_LENGTH in .env.example.
        $min = \App\Config\Config::i()->getInt('PASSWORD_MIN_LENGTH', 10);
        if ($min < 1 || $min > 4096) {
            $min = 10;
        }
        if (strlen($v) < $min) {
            throw new InvalidArgumentException("Password must be at least {$min} characters");
        }
        if (strlen($v) > 4096) {
            throw new InvalidArgumentException('Password too long');
        }
    }

    public static function mountName(string $v): string
    {
        $v = trim($v);
        if (preg_match('/^[a-z0-9][a-z0-9_-]{1,63}$/', $v) !== 1) {
            throw new InvalidArgumentException('Mount name must be 2-64 chars: lowercase letters, digits, - _');
        }
        return $v;
    }

    public static function adapter(string $v): string
    {
        $ok = ['local', 'ftp', 'ftps', 'sftp', 'smb', 'http'];
        if (!in_array($v, $ok, true)) {
            throw new InvalidArgumentException('Unknown adapter');
        }
        return $v;
    }

    public static function protocol(string $v): string
    {
        $ok = ['ftp', 'ftps', 'sftp', 'smb', 'http'];
        if (!in_array($v, $ok, true)) {
            throw new InvalidArgumentException('Unknown protocol');
        }
        return $v;
    }

    public static function host(string $v): string
    {
        $v = trim($v);
        if ($v === '' || strlen($v) > 253) {
            throw new InvalidArgumentException('Invalid host');
        }
        // Hostname or IP literal only (no scheme, path, or userinfo).
        if (preg_match('/^[a-zA-Z0-9._-]+$/', $v) !== 1) {
            throw new InvalidArgumentException('Invalid host');
        }
        return $v;
    }

    public static function int(mixed $v, int $min, int $max, string $what): int
    {
        if (!is_numeric($v)) {
            throw new InvalidArgumentException("$what must be a number");
        }
        $n = (int) $v;
        if ($n < $min || $n > $max) {
            throw new InvalidArgumentException("$what out of range ($min..$max)");
        }
        return $n;
    }

    public static function bool(mixed $v): bool
    {
        return is_bool($v)
            ? $v
            : in_array($v, [true, 1, '1', 'true', 'on', 'yes'], true);
    }

    /** @return array<string,mixed> */
    public static function jsonDict(mixed $v, string $what = 'payload'): array
    {
        if (is_array($v)) {
            return $v;
        }
        if (is_string($v)) {
            $d = json_decode($v, true);
            if (is_array($d)) {
                return $d;
            }
        }
        throw new InvalidArgumentException("$what must be a JSON object");
    }
}
