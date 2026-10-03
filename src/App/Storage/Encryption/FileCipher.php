<?php

declare(strict_types=1);

namespace App\Storage\Encryption;

use App\Config\Config;
use RuntimeException;

/**
 * Streaming AES-256-GCM file encryption.
 *
 * Everything here works in fixed-size chunks so a multi-gigabyte file never has
 * to be held in memory (memory_limit is 512M). The master key is cached in the
 * process — Config::fileKey() re-reads the key file on every call, which would
 * otherwise cost a filesystem read per chunk.
 */
final class FileCipher
{
    private const CIPHER = 'aes-256-gcm';
    private const MIME_SNIFF_BYTES = 4096;

    /** Cached raw master key (32 bytes). */
    private static ?string $masterKey = null;

    /** Raw 32-byte master key from Config, cached per process. */
    public static function masterKey(): string
    {
        if (self::$masterKey === null) {
            $hex = Config::i()->fileKey();
            $raw = @hex2bin($hex);
            if ($raw === false || strlen($raw) !== 32) {
                throw new RuntimeException('Invalid file encryption key (expected 64 hex chars)');
            }
            self::$masterKey = $raw;
        }
        return self::$masterKey;
    }

    /** Drop the cached key (used by key rotation / CLI tooling). */
    public static function forgetKey(): void
    {
        self::$masterKey = null;
    }

    // ------------------------------------------------------------- inspection

    /** Cheap check: does this file start with our magic? */
    public static function isEncrypted(string $absPath): bool
    {
        $fh = @fopen($absPath, 'rb');
        if ($fh === false) {
            return false;
        }
        try {
            $magic = fread($fh, 8);
            return $magic !== false && $magic === EncryptedFormat::MAGIC;
        } finally {
            fclose($fh);
        }
    }

    /** Parse the header, or return null when the file is plaintext. */
    public static function readHeader(string $absPath): ?EncryptedFormat
    {
        $fh = @fopen($absPath, 'rb');
        if ($fh === false) {
            return null;
        }
        try {
            $fixed = (string) fread($fh, EncryptedFormat::FIXED_HEADER_LEN);
            if (!EncryptedFormat::looksEncrypted($fixed)) {
                return null;
            }
            if (strlen($fixed) < EncryptedFormat::FIXED_HEADER_LEN) {
                throw new RuntimeException('Encrypted header truncated');
            }
            $mimeLen = unpack('v', substr($fixed, 48, 2))[1];
            $extLen = unpack('v', substr($fixed, 50, 2))[1];
            $keyLen = unpack('v', substr($fixed, 52, 2))[1];
            $need = $mimeLen + $extLen + $keyLen;
            $tail = $need > 0 ? (string) fread($fh, $need) : '';
            return EncryptedFormat::parse($fixed . $tail);
        } finally {
            fclose($fh);
        }
    }

    // ------------------------------------------------------------------ write

    /**
     * Encrypt the readable stream $in into $absPath.
     *
     * Writes to a sibling temp file and atomically renames, so an existing
     * target is never damaged by a mid-way failure.
     *
     * @param resource $in
     * @return int plaintext bytes consumed
     */
    public static function encryptStreamToFile($in, string $absPath, ?string $mimeHint = null, string $extension = ''): int
    {
        if (!is_resource($in)) {
            throw new RuntimeException('Not a readable stream');
        }

        $master = self::masterKey();
        $dataKey = random_bytes(32);
        $fileNonce = random_bytes(EncryptedFormat::FILE_NONCE_LEN);
        $fileId = random_bytes(EncryptedFormat::FILE_ID_LEN);
        $keyId = Config::i()->fileKeyId();
        $chunkSize = EncryptedFormat::DEFAULT_CHUNK_SIZE;

        // Sniff MIME from the head of the plaintext — ciphertext is unreadable
        // to finfo, so the header has to carry this.
        $prefix = (string) fread($in, self::MIME_SNIFF_BYTES);
        $mime = $mimeHint !== null && $mimeHint !== '' ? $mimeHint : self::sniffMime($prefix);

        // Wrap the per-file data key under the master key so a future master-key
        // rotation only has to re-wrap 32 bytes per file, not re-encrypt it.
        $wrapIv = random_bytes(EncryptedFormat::NONCE_LEN);
        $keyAad = $fileId . pack('v', $keyId);
        $wrappedCt = openssl_encrypt($dataKey, self::CIPHER, $master, OPENSSL_RAW_DATA, $wrapIv, $wrapTag, $keyAad);
        if ($wrappedCt === false) {
            throw new RuntimeException('Failed to wrap file key');
        }
        $wrappedKey = $wrapIv . $wrappedCt . $wrapTag;

        $flags = EncryptedFormat::FLAG_WRAPPED_KEY
            | ($mime !== '' ? EncryptedFormat::FLAG_MIME : 0)
            | ($extension !== '' ? EncryptedFormat::FLAG_EXT : 0);

        // Header length is known up front; only plaintextSize is back-patched.
        $headerLen = EncryptedFormat::FIXED_HEADER_LEN + strlen($mime) + strlen($extension) + strlen($wrappedKey);

        $tmp = $absPath . '.ansnew-tmp-' . bin2hex(random_bytes(6));
        $out = @fopen($tmp, 'xb');
        if ($out === false) {
            throw new RuntimeException('Cannot create temporary file for encryption');
        }

        try {
            $fmt = new EncryptedFormat(
                EncryptedFormat::VERSION, $flags, $keyId, $chunkSize, 0,
                $fileNonce, $fileId, $mime, $extension, $wrappedKey, $headerLen
            );
            if (fwrite($out, $fmt->build()) !== $headerLen) {
                throw new RuntimeException('Cannot write encryption header');
            }

            $total = 0;
            $index = 0;
            $buf = $prefix;

            while (true) {
                // Top the buffer up to exactly one chunk.
                while (strlen($buf) < $chunkSize) {
                    $more = fread($in, $chunkSize - strlen($buf));
                    if ($more === false || $more === '') {
                        break;
                    }
                    $buf .= $more;
                }
                if ($buf === '') {
                    break;
                }
                $plain = strlen($buf) > $chunkSize ? substr($buf, 0, $chunkSize) : $buf;
                $buf = strlen($buf) > $chunkSize ? substr($buf, $chunkSize) : '';

                $ct = openssl_encrypt(
                    $plain, self::CIPHER, $dataKey, OPENSSL_RAW_DATA,
                    $fmt->nonce($index), $tag, $fmt->aad($index)
                );
                if ($ct === false) {
                    throw new RuntimeException('Chunk encryption failed');
                }
                if (fwrite($out, $ct . $tag) === false) {
                    throw new RuntimeException('Cannot write encrypted chunk');
                }
                $total += strlen($plain);
                $index++;
            }

            // Back-patch the real plaintext size into the header.
            if (fseek($out, 16) !== 0) {
                throw new RuntimeException('Cannot seek to patch header');
            }
            if (fwrite($out, pack('P', $total)) !== 8) {
                throw new RuntimeException('Cannot patch header');
            }
            fflush($out);
            fclose($out);
            $out = null;

            // Preserve the target's permissions if it already existed.
            $mode = @fileperms($absPath);
            @chmod($tmp, $mode !== false ? ($mode & 0777) : 0660);
            if (!@rename($tmp, $absPath)) {
                throw new RuntimeException('Cannot publish encrypted file');
            }
            return $total;
        } catch (\Throwable $e) {
            if (is_resource($out)) {
                fclose($out);
            }
            @unlink($tmp);
            throw $e;
        }
    }

    /**
     * Encrypt a whole local file in place (used by the migration).
     * Returns the plaintext size, or null when the file was already encrypted.
     */
    public static function encryptFileInPlace(string $absPath): ?int
    {
        if (self::isEncrypted($absPath)) {
            return null;
        }
        $in = @fopen($absPath, 'rb');
        if ($in === false) {
            throw new RuntimeException('Cannot read file: ' . $absPath);
        }
        $ext = strtolower(pathinfo($absPath, PATHINFO_EXTENSION));
        try {
            return self::encryptStreamToFile($in, $absPath, null, $ext);
        } finally {
            if (is_resource($in)) {
                fclose($in);
            }
        }
    }

    // ------------------------------------------------------------------- read

    /** Unwrap a per-file data key. */
    public static function unwrapKey(EncryptedFormat $fmt): string
    {
        if ($fmt->wrappedKey === '' || strlen($fmt->wrappedKey) !== EncryptedFormat::WRAPPED_KEY_LEN) {
            throw new RuntimeException('Encrypted file has no wrapped key');
        }
        $iv = substr($fmt->wrappedKey, 0, EncryptedFormat::NONCE_LEN);
        $tag = substr($fmt->wrappedKey, -EncryptedFormat::TAG_LEN);
        $ct = substr($fmt->wrappedKey, EncryptedFormat::NONCE_LEN, -EncryptedFormat::TAG_LEN);

        $dataKey = openssl_decrypt(
            $ct, self::CIPHER, self::masterKey(), OPENSSL_RAW_DATA, $iv, $tag, $fmt->keyAad()
        );
        if ($dataKey === false || strlen($dataKey) !== 32) {
            throw new RuntimeException('Cannot unwrap file key (wrong key or tampered header)');
        }
        return $dataKey;
    }

    /** Decrypt one chunk. Returns plaintext, or throws on authentication failure. */
    public static function decryptChunk(EncryptedFormat $fmt, string $dataKey, int $index, string $ciphertext, string $tag): string
    {
        $plain = openssl_decrypt(
            $ciphertext, self::CIPHER, $dataKey, OPENSSL_RAW_DATA,
            $fmt->nonce($index), $tag, $fmt->aad($index)
        );
        if ($plain === false) {
            throw new RuntimeException('Decryption failed (file is corrupt or tampered with)');
        }
        return $plain;
    }

    /** Bytes a chunk occupies on disk (ciphertext + tag). */
    public static function chunkDiskLen(EncryptedFormat $fmt, int $index): int
    {
        return $fmt->chunkPlaintextLen($index) + EncryptedFormat::TAG_LEN;
    }

    // ------------------------------------------------------------------- mime

    /** Best-effort MIME for a plaintext head; '' when undetectable. */
    public static function sniffMime(string $head): string
    {
        if ($head === '') {
            return '';
        }
        $fi = @finfo_open(FILEINFO_MIME_TYPE);
        if ($fi === false) {
            return '';
        }
        try {
            $m = @finfo_buffer($fi, $head);
            return is_string($m) ? $m : '';
        } finally {
            finfo_close($fi);
        }
    }

    /** Fallback MIME from a filename extension, for headers without one. */
    public static function mimeFromExtension(string $ext): string
    {
        static $map = [
            'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png',
            'gif' => 'image/gif', 'webp' => 'image/webp', 'bmp' => 'image/bmp',
            'avif' => 'image/avif', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon',
            'mp4' => 'video/mp4', 'webm' => 'video/webm', 'mkv' => 'video/x-matroska',
            'mov' => 'video/quicktime', 'avi' => 'video/x-msvideo',
            'mp3' => 'audio/mpeg', 'wav' => 'audio/wav', 'ogg' => 'audio/ogg',
            'flac' => 'audio/flac', 'm4a' => 'audio/mp4',
            'pdf' => 'application/pdf', 'zip' => 'application/zip',
            'gz' => 'application/gzip', 'tar' => 'application/x-tar',
            '7z' => 'application/x-7z-compressed', 'rar' => 'application/vnd.rar',
            'json' => 'application/json', 'xml' => 'application/xml',
            'txt' => 'text/plain', 'md' => 'text/markdown', 'csv' => 'text/csv',
            'html' => 'text/html', 'htm' => 'text/html', 'css' => 'text/css',
            'js' => 'text/javascript', 'mjs' => 'text/javascript',
            'ts' => 'text/plain', 'log' => 'text/plain', 'yml' => 'text/plain',
            'yaml' => 'text/plain', 'ini' => 'text/plain', 'conf' => 'text/plain',
            'sh' => 'text/x-shellscript', 'py' => 'text/x-python',
            'go' => 'text/plain', 'rs' => 'text/plain', 'c' => 'text/plain',
            'cpp' => 'text/plain', 'h' => 'text/plain', 'java' => 'text/plain',
            'rb' => 'text/plain', 'php' => 'text/plain', 'sql' => 'text/plain',
        ];
        return $map[strtolower($ext)] ?? '';
    }
}
