<?php

declare(strict_types=1);

namespace App\Storage\Encryption;

use RuntimeException;

/**
 * Read-only stream wrapper that transparently decrypts an encrypted file.
 *
 * A wrapper (rather than a stream_filter) is used because it gives explicit
 * control over seek/eof — which is what `fstat`, `stream_copy_to_stream` and a
 * future HTTP Range implementation all need.
 *
 * Only two chunks are ever held in memory, so file size is irrelevant to the
 * 512M memory_limit.
 */
final class DecryptStreamWrapper
{
    public const SCHEME = 'ansnew';

    /** @var array<string, array<string,mixed>> */
    private static array $handles = [];
    private static int $seq = 0;
    private static bool $registered = false;

    /** @var resource|null */
    public $context;

    private ?string $id = null;

    public static function register(): void
    {
        if (self::$registered) {
            return;
        }
        stream_wrapper_register(self::SCHEME, self::class);
        self::$registered = true;
    }

    /**
     * Open a decrypting read handle for an already-parsed encrypted file.
     *
     * @return resource
     */
    public static function open(string $absPath, EncryptedFormat $fmt, string $dataKey)
    {
        self::register();
        $id = 'h' . (++self::$seq);
        self::$handles[$id] = [
            'path' => $absPath,
            'fmt' => $fmt,
            'key' => $dataKey,
            'pos' => 0,
            'cacheIdx' => -1,
            'cache' => '',
            'fh' => null,
        ];
        $fh = @fopen(self::SCHEME . '://' . $id, 'rb');
        if ($fh === false) {
            unset(self::$handles[$id]);
            throw new RuntimeException('Cannot open decrypting stream');
        }
        return $fh;
    }

    // ------------------------------------------------------- stream callbacks

    public function stream_open(string $path, string $mode, int $options, ?string &$openedPath): bool
    {
        $id = substr($path, strlen(self::SCHEME) + 3);
        if (!isset(self::$handles[$id])) {
            return false;
        }
        $fh = @fopen(self::$handles[$id]['path'], 'rb');
        if ($fh === false) {
            return false;
        }
        self::$handles[$id]['fh'] = $fh;
        $this->id = $id;
        $openedPath = self::$handles[$id]['path'];
        return true;
    }

    public function stream_read(int $count): string
    {
        if ($this->id === null || !isset(self::$handles[$this->id])) {
            return '';
        }
        $h = &self::$handles[$this->id];
        /** @var EncryptedFormat $fmt */
        $fmt = $h['fmt'];
        $out = '';

        while (strlen($out) < $count && $h['pos'] < $fmt->plaintextSize) {
            $idx = intdiv($h['pos'], $fmt->chunkSize);

            if ($h['cacheIdx'] !== $idx) {
                $len = $fmt->chunkPlaintextLen($idx);
                if (fseek($h['fh'], $fmt->chunkOffset($idx)) !== 0) {
                    throw new RuntimeException('Cannot seek in encrypted file');
                }
                $raw = (string) fread($h['fh'], $len + EncryptedFormat::TAG_LEN);
                if (strlen($raw) !== $len + EncryptedFormat::TAG_LEN) {
                    throw new RuntimeException('Encrypted file is truncated');
                }
                $h['cache'] = FileCipher::decryptChunk(
                    $fmt, $h['key'], $idx,
                    substr($raw, 0, $len),
                    substr($raw, $len)
                );
                $h['cacheIdx'] = $idx;
            }

            $within = $h['pos'] - $idx * $fmt->chunkSize;
            $take = min(
                $count - strlen($out),
                $fmt->chunkSize - $within,
                $fmt->plaintextSize - $h['pos']
            );
            if ($take <= 0) {
                break;
            }
            $out .= substr($h['cache'], $within, $take);
            $h['pos'] += $take;
        }

        return $out;
    }

    public function stream_eof(): bool
    {
        if ($this->id === null || !isset(self::$handles[$this->id])) {
            return true;
        }
        $h = self::$handles[$this->id];
        return $h['pos'] >= $h['fmt']->plaintextSize;
    }

    public function stream_tell(): int
    {
        return $this->id !== null && isset(self::$handles[$this->id]) ? (int) self::$handles[$this->id]['pos'] : 0;
    }

    public function stream_seek(int $offset, int $whence = SEEK_SET): bool
    {
        if ($this->id === null || !isset(self::$handles[$this->id])) {
            return false;
        }
        $h = &self::$handles[$this->id];
        /** @var EncryptedFormat $fmt */
        $fmt = $h['fmt'];

        $target = match ($whence) {
            SEEK_SET => $offset,
            SEEK_CUR => $h['pos'] + $offset,
            SEEK_END => $fmt->plaintextSize + $offset,
            default => -1,
        };
        if ($target < 0) {
            return false;
        }
        $h['pos'] = $target;
        return true;
    }

    /** @return array<string,int> */
    public function stream_stat(): array
    {
        $size = 0;
        if ($this->id !== null && isset(self::$handles[$this->id])) {
            $size = (int) self::$handles[$this->id]['fmt']->plaintextSize;
        }
        return [
            'size' => $size,
            'mode' => 0100644,
            'mtime' => 0,
            'atime' => 0,
            'ctime' => 0,
        ];
    }

    public function stream_close(): void
    {
        if ($this->id === null) {
            return;
        }
        if (isset(self::$handles[$this->id]['fh']) && is_resource(self::$handles[$this->id]['fh'])) {
            fclose(self::$handles[$this->id]['fh']);
        }
        unset(self::$handles[$this->id]);
        $this->id = null;
    }
}
