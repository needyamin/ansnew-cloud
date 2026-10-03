<?php

declare(strict_types=1);

namespace App\Storage;

use App\Storage\Adapters\LocalAdapter;
use App\Storage\Encryption\DecryptStreamWrapper;
use App\Storage\Encryption\FileCipher;
use App\Support\PathGuard;
use RuntimeException;

/**
 * Transparently encrypts file contents on a local mount.
 *
 * Installed by StorageManager for `adapter = local` only. Because every service
 * reaches bytes through getStream/putStream/copy, wrapping here covers uploads,
 * downloads, previews, archive/extract, cross-mount transfers and trash with no
 * changes in any caller.
 *
 * Design notes:
 *  - `copy` is deliberately delegated to the inner adapter. A byte-verbatim
 *    copy of ciphertext preserves the header, the wrapped key and every chunk,
 *    and avoids decrypting + re-encrypting the whole file for no benefit.
 *  - `rename` needs no handling: the header is self-describing, so moving or
 *    trashing a file keeps it readable.
 *  - `stat`/`list` report the PLAINTEXT size (what the user uploaded) because
 *    that value feeds Content-Length on downloads and the size column.
 *  - `du` sums plaintext sizes so the usage numbers agree with the UI.
 */
final class EncryptedAdapter implements StorageAdapter
{
    public function __construct(private readonly LocalAdapter $inner)
    {
    }

    // ------------------------------------------------------- byte movement

    /** @return resource */
    public function getStream(string $path, int $from = -1, int $to = -1)
    {
        $abs = $this->inner->toAbsolute($path);
        $fmt = FileCipher::readHeader($abs);

        if ($fmt === null) {
            return $this->inner->getStream($path, $from, $to);
        }
        $fh = DecryptStreamWrapper::open($abs, $fmt, FileCipher::unwrapKey($fmt));
        if ($from > 0 && fseek($fh, $from) !== 0) {
            fclose($fh);
            throw new RuntimeException('Cannot seek in encrypted file');
        }
        return $fh;
    }

    /** Returns the number of PLAINTEXT bytes written. */
    public function putStream(string $path, $stream): int
    {
        $abs = $this->inner->toAbsolute($path, false);
        $dir = dirname($abs);
        if (!is_dir($dir) && !@mkdir($dir, 0770, true)) {
            throw new RuntimeException('Cannot create parent directory');
        }
        $ext = strtolower(pathinfo($path, PATHINFO_EXTENSION));
        return FileCipher::encryptStreamToFile($stream, $abs, null, $ext);
    }

    /** Byte-verbatim ciphertext copy — see the class docblock. */
    public function copy(string $from, string $to): void
    {
        $this->inner->copy($from, $to);
    }

    // ------------------------------------------------------------ metadata

    public function list(string $path): array
    {
        $entries = $this->inner->list($path);
        foreach ($entries as &$e) {
            if (($e['type'] ?? '') !== 'file') {
                continue;
            }
            $this->patchFileMeta($e, PathGuard::join($path, (string) ($e['name'] ?? '')));
        }
        unset($e);
        return $entries;
    }

    public function stat(string $path): array
    {
        $s = $this->inner->stat($path);
        if (($s['type'] ?? '') === 'file') {
            $this->patchFileMeta($s, $path);
        }
        return $s;
    }

    public function du(string $path = '/'): array
    {
        $used = 0;
        $files = 0;
        $dirs = 0;
        $this->walkPlainSize($path, $used, $files, $dirs);
        return ['used' => $used, 'files' => $files, 'dirs' => $dirs];
    }

    public function search(string $path, string $needle, int $limit = 200): array
    {
        // Search matches names only, and names are stored in the clear.
        $results = $this->inner->search($path, $needle, $limit);
        foreach ($results as &$r) {
            if (($r['type'] ?? '') === 'file') {
                $this->patchFileMeta($r, (string) ($r['path'] ?? ''));
            }
        }
        unset($r);
        return $results;
    }

    // ------------------------------------------------------- pass-through

    public function exists(string $path): bool
    {
        return $this->inner->exists($path);
    }

    public function isDir(string $path): bool
    {
        return $this->inner->isDir($path);
    }

    public function mkdir(string $path, bool $recursive = true): void
    {
        $this->inner->mkdir($path, $recursive);
    }

    public function delete(string $path, bool $recursive = false): void
    {
        $this->inner->delete($path, $recursive);
    }

    public function rename(string $from, string $to): void
    {
        $this->inner->rename($from, $to);
    }

    // --------------------------------------------------------------- helpers

    /**
     * Replace ciphertext-derived metadata with the truth from the header.
     *
     * Plaintext files still exist on an encrypted mount (pre-migration data, or
     * files written directly to disk by another tool). Those need a fallback:
     * the inner adapter's content sniffing is switched off — it would sniff
     * ciphertext as garbage — so derive the MIME from the extension instead.
     */
    private function patchFileMeta(array &$meta, string $virtualPath): void
    {
        try {
            $abs = $this->inner->toAbsolute($virtualPath);
        } catch (\Throwable) {
            return;
        }

        $fmt = FileCipher::readHeader($abs);

        if ($fmt === null) {
            if (($meta['mime'] ?? '') === '' && ($meta['extension'] ?? '') !== '') {
                $m = FileCipher::mimeFromExtension((string) $meta['extension']);
                if ($m !== '') {
                    $meta['mime'] = $m;
                }
            }
            return;
        }

        $meta['size'] = $fmt->plaintextSize;
        $meta['encrypted'] = true;
        if ($fmt->mime !== '') {
            $meta['mime'] = $fmt->mime;
        } elseif ($fmt->extension !== '') {
            $fallback = FileCipher::mimeFromExtension($fmt->extension);
            if ($fallback !== '') {
                $meta['mime'] = $fallback;
            }
        }
    }

    private function walkPlainSize(string $path, int &$used, int &$files, int &$dirs): void
    {
        foreach ($this->list($path) as $e) {
            $type = $e['type'] ?? '';
            if ($type === 'dir') {
                $dirs++;
                $this->walkPlainSize(PathGuard::join($path, (string) $e['name']), $used, $files, $dirs);
            } elseif ($type === 'file') {
                $files++;
                $used += (int) ($e['size'] ?? 0);
            }
        }
    }
}
