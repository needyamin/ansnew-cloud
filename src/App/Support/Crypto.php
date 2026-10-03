<?php

declare(strict_types=1);

namespace App\Support;

use App\Config\Config;
use RuntimeException;
use SensitiveParameter;

/**
 * AES-256-GCM encryption for stored remote-connection secrets.
 * Format: v1:<iv-b64>:<ciphertext-b64>:<tag-b64>
 */
final class Crypto
{
    private const CIPHER = 'aes-256-gcm';

    public static function encrypt(#[SensitiveParameter] string $plaintext): string
    {
        if ($plaintext === '') {
            throw new RuntimeException('Nothing to encrypt');
        }
        $key = hex2bin(Config::i()->appKey());
        if ($key === false || strlen($key) !== 32) {
            throw new RuntimeException('Invalid APP_KEY');
        }
        $iv = random_bytes(12);
        $tag = '';
        $cipher = openssl_encrypt($plaintext, self::CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($cipher === false) {
            throw new RuntimeException('Encryption failed');
        }
        return 'v1:' . base64_encode($iv) . ':' . base64_encode($cipher) . ':' . base64_encode($tag);
    }

    public static function decrypt(#[SensitiveParameter] string $payload): string
    {
        $parts = explode(':', $payload);
        if (count($parts) !== 4 || $parts[0] !== 'v1') {
            throw new RuntimeException('Malformed ciphertext');
        }
        $key = hex2bin(Config::i()->appKey());
        $iv = base64_decode($parts[1], true);
        $cipher = base64_decode($parts[2], true);
        $tag = base64_decode($parts[3], true);
        if ($key === false || $iv === false || $cipher === false || $tag === false || strlen($key) !== 32) {
            throw new RuntimeException('Malformed ciphertext');
        }
        $plain = openssl_decrypt($cipher, self::CIPHER, $key, OPENSSL_RAW_DATA, $iv, $tag);
        if ($plain === false) {
            throw new RuntimeException('Decryption failed (wrong APP_KEY?)');
        }
        return $plain;
    }

    /** HMAC helper shared with the WS service (secrets never leave the server). */
    public static function hmac(string $data, string $purpose): string
    {
        return hash_hmac('sha256', $purpose . ':' . $data, Config::i()->wsSecret());
    }

    public static function constantTimeEquals(string $a, string $b): bool
    {
        return hash_equals($a, $b);
    }
}
