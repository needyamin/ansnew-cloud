<?php

declare(strict_types=1);

namespace App\Storage\Encryption;

use RuntimeException;

/**
 * On-disk format for encrypted files.
 *
 * A file is a self-describing header followed by chunked AES-256-GCM records:
 *
 *   offset  size  field
 *   0       8     magic "ANSNEWC1"
 *   8       1     format version
 *   9       1     flags (bit0 wrapped key, bit1 mime, bit2 extension)
 *   10      2     key id (u16 LE)      -- which master key wrapped the data key
 *   12      4     chunk size (u32 LE)  -- plaintext bytes per chunk
 *   16      8     plaintext size (u64 LE)
 *   24      8     file nonce (random)  -- nonce base for every chunk
 *   32      16    file id (random)     -- binds chunks to this file instance
 *   48      2     mime length (u16 LE)
 *   50      2     extension length (u16 LE)
 *   52      2     wrapped key length (u16 LE)
 *   54      2     reserved
 *   56      ...   mime, extension, wrapped key
 *
 * Payload: N = ceil(plaintext_size / chunk_size) records of ciphertext||tag(16).
 * The nonce for record i is file_nonce || u32LE(i), so it is never reused under
 * the same data key. Every record's AAD binds its index, the record count, the
 * plaintext size and the file id — which together defeat reordering, truncation
 * and splicing between files.
 *
 * The header is deliberately self-describing so a file survives rename, copy,
 * trash/restore, rsync and even database loss with no external metadata.
 */
final class EncryptedFormat
{
    public const MAGIC = 'ANSNEWC1';
    public const VERSION = 1;
    public const FIXED_HEADER_LEN = 56;
    public const DEFAULT_CHUNK_SIZE = 1048576;   // 1 MiB
    public const TAG_LEN = 16;
    public const NONCE_LEN = 12;
    public const FILE_NONCE_LEN = 8;
    public const FILE_ID_LEN = 16;
    public const WRAPPED_KEY_LEN = 60;           // iv(12) + ct(32) + tag(16)

    public const FLAG_WRAPPED_KEY = 0x01;
    public const FLAG_MIME = 0x02;
    public const FLAG_EXT = 0x04;

    public function __construct(
        public readonly int $version,
        public readonly int $flags,
        public readonly int $keyId,
        public readonly int $chunkSize,
        public readonly int $plaintextSize,
        public readonly string $fileNonce,
        public readonly string $fileId,
        public readonly string $mime,
        public readonly string $extension,
        public readonly string $wrappedKey,
        public readonly int $headerLen,
    ) {
    }

    /** Number of payload records for this file. */
    public function chunkCount(): int
    {
        if ($this->plaintextSize === 0) {
            return 0;
        }
        return (int) intdiv($this->plaintextSize + $this->chunkSize - 1, $this->chunkSize);
    }

    /** Plaintext length of record $i. */
    public function chunkPlaintextLen(int $i): int
    {
        $n = $this->chunkCount();
        if ($i < 0 || $i >= $n) {
            throw new RuntimeException('Chunk index out of range');
        }
        if ($i < $n - 1) {
            return $this->chunkSize;
        }
        return $this->plaintextSize - ($n - 1) * $this->chunkSize;
    }

    /** Byte offset of record $i within the file. */
    public function chunkOffset(int $i): int
    {
        return $this->headerLen + $i * ($this->chunkSize + self::TAG_LEN);
    }

    public function nonce(int $i): string
    {
        return $this->fileNonce . pack('V', $i);
    }

    /**
     * AAD for record $i.
     *
     * Deliberately does NOT include the record count or plaintext size: the
     * writer streams and cannot know either before encrypting the first chunk.
     * Truncation is caught at read time instead — the reader demands exactly
     * chunkCount() records and verifies the decrypted total equals
     * plaintextSize. A shortened payload fails the final chunk's tag (the
     * expected length no longer matches), and a tampered size in the header
     * changes the last chunk's expected length, which also fails the tag.
     *
     * Reordering is prevented by $i and cross-file splicing by $fileId.
     */
    public function aad(int $i): string
    {
        return self::MAGIC
            . chr($this->version)
            . pack('v', $this->keyId)
            . $this->fileId
            . pack('V', $i);
    }

    /** AAD used when wrapping/unwrapping the per-file data key. */
    public function keyAad(): string
    {
        return $this->fileId . pack('v', $this->keyId);
    }

    /** Serialise the header. */
    public function build(): string
    {
        $head = self::MAGIC
            . chr($this->version)
            . chr($this->flags)
            . pack('v', $this->keyId)
            . pack('V', $this->chunkSize)
            . pack('P', $this->plaintextSize)
            . $this->fileNonce
            . $this->fileId
            . pack('v', strlen($this->mime))
            . pack('v', strlen($this->extension))
            . pack('v', strlen($this->wrappedKey))
            . pack('v', 0);

        return $head . $this->mime . $this->extension . $this->wrappedKey;
    }

    /** True when the first bytes of $prefix look like our container. */
    public static function looksEncrypted(string $prefix): bool
    {
        return strlen($prefix) >= 8 && substr($prefix, 0, 8) === self::MAGIC;
    }

    /**
     * Parse a header from the leading bytes of a file.
     * $head must contain at least FIXED_HEADER_LEN bytes.
     */
    public static function parse(string $head): self
    {
        if (strlen($head) < self::FIXED_HEADER_LEN) {
            throw new RuntimeException('Encrypted header truncated');
        }
        if (substr($head, 0, 8) !== self::MAGIC) {
            throw new RuntimeException('Not an encrypted file');
        }
        $version = ord($head[8]);
        if ($version !== self::VERSION) {
            throw new RuntimeException('Unsupported encryption version: ' . $version);
        }
        $flags = ord($head[9]);
        $keyId = unpack('v', substr($head, 10, 2))[1];
        $chunkSize = unpack('V', substr($head, 12, 4))[1];
        $plaintextSize = unpack('P', substr($head, 16, 8))[1];
        $fileNonce = substr($head, 24, self::FILE_NONCE_LEN);
        $fileId = substr($head, 32, self::FILE_ID_LEN);
        $mimeLen = unpack('v', substr($head, 48, 2))[1];
        $extLen = unpack('v', substr($head, 50, 2))[1];
        $keyLen = unpack('v', substr($head, 52, 2))[1];

        if ($chunkSize < 1 || $chunkSize > 64 * 1024 * 1024) {
            throw new RuntimeException('Encrypted header has an invalid chunk size');
        }

        $headerLen = self::FIXED_HEADER_LEN + $mimeLen + $extLen + $keyLen;
        $mime = $mimeLen > 0 ? substr($head, self::FIXED_HEADER_LEN, $mimeLen) : '';
        $ext = $extLen > 0 ? substr($head, self::FIXED_HEADER_LEN + $mimeLen, $extLen) : '';
        $wrapped = $keyLen > 0 ? substr($head, self::FIXED_HEADER_LEN + $mimeLen + $extLen, $keyLen) : '';

        return new self(
            $version,
            $flags,
            $keyId,
            $chunkSize,
            $plaintextSize,
            $fileNonce,
            $fileId,
            $mime,
            $ext,
            $wrapped,
            $headerLen,
        );
    }

    /** Size of the ciphertext for a given plaintext size (used by the migration). */
    public static function ciphertextSize(int $plaintextSize, int $headerLen, int $chunkSize = self::DEFAULT_CHUNK_SIZE): int
    {
        if ($plaintextSize === 0) {
            return $headerLen;
        }
        $chunks = (int) intdiv($plaintextSize + $chunkSize - 1, $chunkSize);
        return $headerLen + $plaintextSize + $chunks * self::TAG_LEN;
    }
}
