<?php

declare(strict_types=1);

namespace App\Support;

use DeflateContext;
use RuntimeException;

/**
 * Streaming ZIP writer.
 *
 * Why this exists: `ZipArchive::addFile()` only registers a path — the bytes are
 * read when the archive is finally closed. That forces a whole folder to be
 * staged on disk first (the previous implementation did exactly that: copy every
 * file into a temp tree, then zip the tree — 2x the data written, plus a second
 * full read pass). `addFromString()` is the other extreme: it holds an entire
 * file in memory.
 *
 * This writer emits the archive entry by entry straight to the output stream:
 *   - contents are read in 256 KB chunks and deflated incrementally, so memory
 *     stays flat no matter how large the file is;
 *   - CRC-32 and both sizes are computed while streaming and written in a data
 *     descriptor after each entry (general purpose bit 3), so nothing has to be
 *     known in advance;
 *   - ZIP64 extra fields, data descriptors and the ZIP64 end-of-central-
 *     directory record are emitted when a file or an offset crosses the 4 GiB
 *     line, so archives larger than 4 GB stay valid.
 *
 * Directory entries are supported, and duplicate names are de-duplicated so a
 * selection containing two files with the same name survives the round trip.
 */
final class ZipStreamWriter
{
    private const SIG_LOCAL = 0x04034b50;
    private const SIG_DESCRIPTOR = 0x08074b50;
    private const SIG_CENTRAL = 0x02014b50;
    private const SIG_EOCD = 0x06054b50;
    private const SIG_ZIP64_EOCD = 0x06064b50;
    private const SIG_ZIP64_LOCATOR = 0x07064b50;

    private const CHUNK = 262144;

    private const UNIX_FILE = 0o100644;
    private const UNIX_DIR = 0o40755;

    /** @var resource */
    private $out;

    private int $offset = 0;

    /** @var array<int, array<string,mixed>> */
    private array $central = [];

    private int $entryCount = 0;

    /** @var array<string,int> archive name -> times used */
    private array $usedNames = [];

    /**
     * @param resource $out      writable stream (a temp file in practice)
     * @param bool     $compress deflate entries instead of storing them
     */
    public function __construct($out, private readonly bool $compress = true)
    {
        if (!is_resource($out)) {
            throw new RuntimeException('ZipStreamWriter needs a stream');
        }
        $this->out = $out;
    }

    /**
     * Write one file entry, streaming bytes from `$read` to the archive.
     *
     * @param string   $name  archive path (forward slashes)
     * @param resource $read  readable stream, positioned at the start
     * @param int      $size  uncompressed size when known, -1 otherwise
     * @param int      $mtime modification time (unix seconds)
     */
    public function addFile(string $name, $read, int $size = -1, int $mtime = 0): void
    {
        $name = $this->uniqueName($name);
        $localOffset = $this->offset;
        // ZIP64 is decided from the declared size: the local header has to be
        // written before a single byte has been read.
        $zip64 = $size >= 0xFFFFFFFF;

        $deflate = null;
        if ($this->compress && function_exists('deflate_init')) {
            $ctx = @deflate_init(ZLIB_ENCODING_RAW, ['level' => 6]);
            if ($ctx instanceof DeflateContext) {
                $deflate = $ctx;
            }
        }
        $method = $deflate !== null ? 8 : 0;
        $crcCtx = hash_init('crc32b');

        $extra = '';
        if ($zip64) {
            // 0x0001 ZIP64 extended information: uncompressed + compressed size.
            $extra = pack('vvJJ', 0x0001, 16, $size, 0);
        }

        // Local file header. Bit 3 says the CRC/sizes follow the data.
        $this->write(pack(
            'VvvvvvVVVvv',
            self::SIG_LOCAL,
            45,
            0x0008,
            $method,
            self::dosTime($mtime),
            self::dosDate($mtime),
            0,                                   // crc32 -> data descriptor
            $zip64 ? 0xFFFFFFFF : 0,             // compressed size
            $zip64 ? 0xFFFFFFFF : 0,             // uncompressed size
            strlen($name),
            strlen($extra)
        ));
        $this->write($name);
        if ($extra !== '') {
            $this->write($extra);
        }

        $uncompressed = 0;
        $compressed = 0;
        while (!feof($read)) {
            $chunk = fread($read, self::CHUNK);
            if ($chunk === false || $chunk === '') {
                break;
            }
            $uncompressed += strlen($chunk);
            hash_update($crcCtx, $chunk);
            if ($deflate !== null) {
                $encoded = @deflate_add($deflate, $chunk, ZLIB_NO_FLUSH);
                $encoded = is_string($encoded) ? $encoded : '';
            } else {
                $encoded = $chunk;
            }
            if ($encoded !== '') {
                $compressed += strlen($encoded);
                $this->write($encoded);
            }
        }
        if ($deflate !== null) {
            $tail = @deflate_add($deflate, '', ZLIB_FINISH);
            if (is_string($tail) && $tail !== '') {
                $compressed += strlen($tail);
                $this->write($tail);
            }
        }

        $crc = (int) hexdec((string) hash_final($crcCtx));
        // A file can cross 4 GiB even if its declared size said otherwise.
        $zip64 = $zip64 || $uncompressed >= 0xFFFFFFFF || $compressed >= 0xFFFFFFFF;

        if ($zip64) {
            $this->write(pack('VVJJ', self::SIG_DESCRIPTOR, $crc, $compressed, $uncompressed));
        } else {
            $this->write(pack('VVVV', self::SIG_DESCRIPTOR, $crc, $compressed, $uncompressed));
        }

        $this->central[] = [
            'name' => $name,
            'method' => $method,
            'mtime' => $mtime,
            'crc' => $crc,
            'csize' => $compressed,
            'usize' => $uncompressed,
            'offset' => $localOffset,
            'zip64' => $zip64 || $localOffset >= 0xFFFFFFFF,
        ];
        $this->entryCount++;
    }

    /** Add a directory entry (trailing slash, zero-length content). */
    public function addDirectory(string $name, int $mtime = 0): void
    {
        $name = rtrim(str_replace('\\', '/', $name), '/') . '/';
        if ($name === '/' || isset($this->usedNames[$name])) {
            return;
        }
        $this->usedNames[$name] = 1;
        $localOffset = $this->offset;

        $this->write(pack(
            'VvvvvvVVVvv',
            self::SIG_LOCAL,
            20,
            0x0000,                              // empty entry: no descriptor
            0,
            self::dosTime($mtime),
            self::dosDate($mtime),
            0,
            0,
            0,
            strlen($name),
            0
        ));
        $this->write($name);

        $this->central[] = [
            'name' => $name,
            'method' => 0,
            'mtime' => $mtime,
            'crc' => 0,
            'csize' => 0,
            'usize' => 0,
            'offset' => $localOffset,
            'zip64' => $localOffset >= 0xFFFFFFFF,
            'isDir' => true,
        ];
        $this->entryCount++;
    }

    /**
     * Write the central directory and the end-of-archive records.
     * @return array{entries:int, bytes:int}
     */
    public function finish(): array
    {
        $cdOffset = $this->offset;
        $needsZip64 = false;

        foreach ($this->central as $e) {
            $extra = '';
            if ($e['zip64']) {
                // 0x0001 ZIP64 extended information: sizes then local offset.
                $extra = pack('vvJJJ', 0x0001, 24, $e['usize'], $e['csize'], $e['offset']);
                $needsZip64 = true;
            }
            $this->write(pack(
                'VvvvvvvVVVvvvvvVV',
                self::SIG_CENTRAL,
                45,                                                  // version made by
                45,                                                  // version needed
                0x0008,
                $e['method'],
                self::dosTime($e['mtime']),
                self::dosDate($e['mtime']),
                $e['crc'],
                $e['zip64'] ? 0xFFFFFFFF : $e['csize'],
                $e['zip64'] ? 0xFFFFFFFF : $e['usize'],
                strlen($e['name']),
                strlen($extra),
                0,                                                   // comment length
                0,                                                   // disk number start
                0,                                                   // internal attributes
                empty($e['isDir']) ? (self::UNIX_FILE << 16) : ((self::UNIX_DIR << 16) | 0x10),
                $e['zip64'] ? 0xFFFFFFFF : $e['offset']              // local header offset
            ));
            $this->write($e['name']);
            if ($extra !== '') {
                $this->write($extra);
            }
        }
        $cdSize = $this->offset - $cdOffset;

        $entries = $this->entryCount;
        $zip64 = $needsZip64
            || $cdOffset >= 0xFFFFFFFF
            || $cdSize >= 0xFFFFFFFF
            || $entries > 0xFFFF;

        if ($zip64) {
            $eocdOffset = $this->offset;
            $this->write(pack(
                'VJvvVVJJJJ',
                self::SIG_ZIP64_EOCD,
                44,                                                  // record size minus 12
                45,
                45,
                0,
                0,
                $entries,
                $entries,
                $cdSize,
                $cdOffset
            ));
            $this->write(pack('VVJV', self::SIG_ZIP64_LOCATOR, 0, $eocdOffset, 1));
        }

        $count = $entries > 0xFFFF ? 0xFFFF : $entries;
        $this->write(pack(
            'VvvvvVVv',
            self::SIG_EOCD,
            0,
            0,
            $count,
            $count,
            $cdSize >= 0xFFFFFFFF ? 0xFFFFFFFF : $cdSize,
            $cdOffset >= 0xFFFFFFFF ? 0xFFFFFFFF : $cdOffset,
            0
        ));

        return ['entries' => $entries, 'bytes' => $this->offset];
    }

    /* ------------------------------------------------------------- internals */

    /**
     * Two files called "report.pdf" in one selection must both survive:
     * the second becomes "report (2).pdf", the way Explorer names copies.
     */
    private function uniqueName(string $name): string
    {
        $name = ltrim(str_replace('\\', '/', $name), '/');
        if ($name === '') {
            $name = 'file';
        }
        if (!isset($this->usedNames[$name])) {
            $this->usedNames[$name] = 1;
            return $name;
        }
        $n = ++$this->usedNames[$name];
        $dot = strrpos($name, '.');
        if ($dot !== false && $dot > 0) {
            return substr($name, 0, $dot) . ' (' . $n . ')' . substr($name, $dot);
        }
        return $name . ' (' . $n . ')';
    }

    private function write(string $bytes): void
    {
        $len = strlen($bytes);
        $written = fwrite($this->out, $bytes);
        if ($written === false || $written !== $len) {
            throw new RuntimeException('Failed to write to the archive (disk full?)');
        }
        $this->offset += $len;
    }

    private static function dosTime(int $t): int
    {
        if ($t <= 0) {
            $t = time();
        }
        $d = getdate($t);
        return ($d['hours'] << 11) | ($d['minutes'] << 5) | intdiv($d['seconds'], 2);
    }

    private static function dosDate(int $t): int
    {
        if ($t <= 0) {
            $t = time();
        }
        $d = getdate($t);
        return (($d['year'] - 1980) << 9) | ($d['mon'] << 5) | $d['mday'];
    }
}
