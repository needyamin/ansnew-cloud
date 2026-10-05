<?php

declare(strict_types=1);

namespace App\Support;

use InvalidArgumentException;
use RuntimeException;

/**
 * RFC 6238 time-based one-time passwords (the "authenticator app" standard).
 *
 * Implemented directly rather than pulling in a composer package: the algorithm
 * is ~40 lines, it is the same on every server, and an authentication primitive
 * is easier to audit when it is small and local.
 *
 * Parameters are the ones every authenticator app defaults to — SHA-1 HMAC,
 * 30-second period, 6 digits — so scanning or typing the secret into Google
 * Authenticator, Authy, 1Password or Aegis just works.
 */
final class Totp
{
    /** RFC 4648 base32 alphabet (the one TOTP secrets use). */
    private const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

    public const DIGITS = 6;
    public const PERIOD = 30;

    /** How many steps of clock drift to tolerate, in either direction. */
    public const WINDOW = 1;

    public static function generateSecret(int $bytes = 20): string
    {
        if ($bytes < 16) {
            throw new InvalidArgumentException('TOTP secret must be at least 16 bytes of entropy');
        }
        return self::base32Encode(random_bytes($bytes));
    }

    public static function base32Encode(string $bytes): string
    {
        if ($bytes === '') {
            return '';
        }
        $bits = '';
        foreach (str_split($bytes) as $byte) {
            $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= self::ALPHABET[bindec(str_pad($chunk, 5, '0'))];
        }
        return $out;
    }

    public static function base32Decode(string $secret): string
    {
        // Tolerate the spacing and casing apps show the user, then decode strictly.
        $clean = strtoupper(preg_replace('/[^A-Za-z2-7]/', '', $secret) ?? '');
        if ($clean === '') {
            return '';
        }
        $bits = '';
        foreach (str_split($clean) as $char) {
            $value = strpos(self::ALPHABET, $char);
            if ($value === false) {
                throw new InvalidArgumentException('Invalid base32 character in TOTP secret');
            }
            $bits .= str_pad(decbin($value), 5, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 8) as $byte) {
            if (strlen($byte) === 8) {
                $out .= chr((int) bindec($byte));
            }
        }
        return $out;
    }

    /** The HOTP value for one counter step (RFC 4226). */
    public static function code(string $secret, int $counter, int $digits = self::DIGITS): string
    {
        $key = self::base32Decode($secret);
        if ($key === '') {
            throw new RuntimeException('TOTP secret is empty');
        }
        // 8-byte big-endian counter.
        $binCounter = pack('N2', ($counter >> 32) & 0xFFFFFFFF, $counter & 0xFFFFFFFF);
        $hash = hash_hmac('sha1', $binCounter, $key, true);

        // Dynamic truncation: the low nibble of the last byte picks the offset.
        $offset = ord(substr($hash, -1)) & 0x0F;
        $value = ((ord($hash[$offset]) & 0x7F) << 24)
            | ((ord($hash[$offset + 1]) & 0xFF) << 16)
            | ((ord($hash[$offset + 2]) & 0xFF) << 8)
            | (ord($hash[$offset + 3]) & 0xFF);

        return str_pad((string) ($value % (10 ** $digits)), $digits, '0', STR_PAD_LEFT);
    }

    /**
     * Check a code, allowing `window` steps of drift on either side.
     * Comparison is constant-time so the check does not leak how close a guess was.
     */
    public static function verify(string $secret, string $code, int $window = self::WINDOW, int $period = self::PERIOD, int $digits = self::DIGITS): bool
    {
        $code = trim($code);
        if (!preg_match('/^\d{' . $digits . '}$/', $code)) {
            return false;
        }
        $counter = intdiv(time(), $period);
        for ($i = -$window; $i <= $window; $i++) {
            if (hash_equals(self::code($secret, $counter + $i, $digits), $code)) {
                return true;
            }
        }
        return false;
    }

    /** The URI an authenticator app scans (or accepts as manual entry). */
    public static function provisioningUri(string $accountName, string $secret, string $issuer = 'ANSNEW Cloud'): string
    {
        return 'otpauth://totp/' . rawurlencode($issuer . ':' . $accountName)
            . '?secret=' . $secret
            . '&issuer=' . rawurlencode($issuer)
            . '&algorithm=SHA1&digits=' . self::DIGITS . '&period=' . self::PERIOD;
    }
}
