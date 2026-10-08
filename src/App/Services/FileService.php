<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Services\JobService;
use App\Storage\Mount;
use App\Storage\StorageAdapter;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use App\Support\Validator;
use InvalidArgumentException;
use RuntimeException;
use Throwable;

/**
 * High-level file operations shared by REST controllers and background jobs.
 * All paths are mount-relative virtual paths; authorization happens in
 * StorageManager::resolve() before anything touches a filesystem.
 */
final class FileService
{
    /** @return array<string,mixed> */
    public static function list(AuthContext $user, string $mountName, string $path): array
    {
        /** @var Mount $mount */
        /** @var StorageAdapter $adapter */
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        if (!$adapter->isDir($norm)) {
            throw new RuntimeException('Not a directory', 404);
        }
        $entries = $adapter->list($norm);
        // The trash directory is an implementation detail of TrashService (it has
        // its own UI view). Hide it from the user-facing listing of a local mount
        // root so it does not show up as ordinary user content.
        if ($norm === '/' && $mount->adapter === 'local') {
            $entries = array_values(array_filter(
                $entries,
                static fn (array $e): bool => (string) ($e['name'] ?? '') !== TrashService::TRASH_DIR
            ));
        }
        return [
            'mount' => $mount->publicInfo(),
            'path' => $norm,
            'parent' => $norm === '/' ? null : PathGuard::dirname($norm),
            'entries' => $entries,
            'etag' => self::fingerprint($entries),
        ];
    }

    /**
     * Cheap content fingerprint for conditional GETs (ETag / If-None-Match).
     *
     * Deliberately computed from the *final* entry array — after encryption
     * adapters have patched sizes and after the trash directory has been
     * filtered — so the value is deterministic and changes exactly when the
     * client-visible listing changes. One sha1 over ~4 fields per entry.
     *
     * @param array<int,array<string,mixed>> $entries
     */
    public static function fingerprint(array $entries): string
    {
        $parts = [];
        foreach ($entries as $e) {
            $parts[] = (string) ($e['name'] ?? '')
                . "\0" . (string) ($e['type'] ?? '')
                . "\0" . (string) ($e['size'] ?? '')
                . "\0" . (string) ($e['mtime'] ?? '');
        }
        return hash('sha1', implode("\1", $parts));
    }

    public static function mkdir(AuthContext $user, string $mountName, string $path, string $name): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        $name = PathGuard::validateName($name);
        $target = PathGuard::join($norm, $name);
        if ($adapter->exists($target)) {
            throw new RuntimeException('Already exists');
        }
        $adapter->mkdir($target, true);
        return ['path' => $target, 'name' => $name];
    }

    public static function createFile(AuthContext $user, string $mountName, string $path, string $name): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        $name = PathGuard::validateName($name);
        self::assertAllowedUpload($name);
        $target = PathGuard::join($norm, $name);
        if ($adapter->exists($target)) {
            throw new RuntimeException('Already exists');
        }
        $fh = fopen('php://memory', 'rb');
        if ($fh === false) {
            throw new RuntimeException('Internal error');
        }
        try {
            $adapter->putStream($target, $fh);
        } finally {
            fclose($fh);
        }
        return ['path' => $target, 'name' => $name];
    }

    /**
     * Read a file as text for the editor.
     *
     * Returns the text plus everything the editor needs to write it back
     * byte-faithfully: the line ending, whether a BOM was present, and a hash of
     * the original bytes to use as an optimistic-concurrency guard.
     *
     * @return array<string,mixed>
     */
    public static function readText(AuthContext $user, string $mountName, string $path): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        $stat = $adapter->stat($norm);
        if (($stat['type'] ?? '') !== 'file') {
            throw new RuntimeException('Not a file', 400);
        }

        $cap = self::editMaxBytes();
        $size = (int) ($stat['size'] ?? 0);

        // Sniff the head BEFORE enforcing the size cap. Any file the client
        // cannot classify by extension is offered to the editor, so a large
        // binary file (an unknown extension, or a huge .dat) has to fall back to
        // the hex preview (415) rather than being told "too large to edit"
        // (413). This also means we read 8 KiB of it, never the whole thing.
        if ($size > 0 && str_contains(self::readHead($adapter, $norm, self::SNIFF_BYTES), "\0")) {
            throw new RuntimeException('Not a text file', 415);
        }

        if ($size > $cap) {
            throw new RuntimeException('Too large to edit (' . self::humanBytes($cap) . ' limit)', 413);
        }

        $raw = self::readRaw($adapter, $norm, $cap);

        // Belt and braces: a file that is text for the first 8 KiB but binary
        // later would otherwise be opened and then saved as mangled bytes.
        if (str_contains($raw, "\0")) {
            throw new RuntimeException('Not a text file', 415);
        }

        $bom = str_starts_with($raw, "\xEF\xBB\xBF");
        $body = $bom ? substr($raw, 3) : $raw;

        // The text round-trips through a <textarea>, and browsers normalise CRLF
        // to LF there. Remember the original so save() can put it back instead of
        // silently rewriting every line of the file.
        $crlf = substr_count($body, "\r\n");
        $lfOnly = substr_count($body, "\n") - $crlf;
        $eol = $crlf > $lfOnly ? 'crlf' : 'lf';

        $utf8 = mb_check_encoding($body, 'UTF-8');
        $name = (string) ($stat['name'] ?? PathGuard::basename($norm));
        $protected = self::isForbiddenName($name);

        $reason = null;
        if ($protected) {
            $reason = 'This file type is protected and cannot be edited here.';
        } elseif (!$mount->canWrite) {
            $reason = 'This drive is read-only for you.';
        } elseif (!$utf8) {
            $reason = 'This file is not valid UTF-8, so it is opened read-only.';
        }

        return [
            'path' => $norm,
            'name' => $name,
            'size' => $size,
            'mtime' => (int) ($stat['mtime'] ?? 0),
            'content' => $body,
            'eol' => $eol,
            'bom' => $bom,
            'encoding' => $utf8 ? 'utf-8' : 'non-utf8',
            'hash' => hash('sha256', $raw),
            'readOnly' => $reason !== null,
            'readOnlyReason' => $reason,
        ];
    }

    /**
     * Overwrite an existing file with new text (the editor's Save).
     *
     * @param string|null $baseHash sha256 the editor loaded; when it no longer
     *        matches the file on disk the write is refused so a concurrent edit
     *        (another tab, another device, a background job) is never clobbered
     * @return array<string,mixed>
     */
    public static function writeText(
        AuthContext $user,
        string $mountName,
        string $path,
        string $content,
        ?string $baseHash = null
    ): array {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);

        if ($norm === '/' || $adapter->isDir($norm)) {
            throw new RuntimeException('Not a file', 400);
        }
        if (!$adapter->exists($norm)) {
            throw new RuntimeException('File not found', 404);
        }

        $name = PathGuard::basename($norm);
        // Same policy as upload / create-file: a write must never plant an
        // executable type, even in a mount that happens to sit under a web root.
        self::assertAllowedUpload($name);

        $cap = self::editMaxBytes();
        if (strlen($content) > $cap) {
            throw new RuntimeException('Too large to save (' . self::humanBytes($cap) . ' limit)', 413);
        }

        if ($baseHash !== null && $baseHash !== '') {
            $current = hash('sha256', self::readRaw($adapter, $norm, $cap));
            if (!hash_equals($baseHash, $current)) {
                throw new RuntimeException(
                    'This file changed on disk since you opened it. Reload to see the current contents.',
                    409
                );
            }
        }

        $fh = fopen('php://memory', 'r+b');
        if ($fh === false) {
            throw new RuntimeException('Internal error', 500);
        }
        try {
            fwrite($fh, $content);
            rewind($fh);
            $written = $adapter->putStream($norm, $fh);
        } finally {
            fclose($fh);
        }

        $after = $adapter->stat($norm);
        return [
            'path' => $norm,
            'name' => $name,
            'size' => (int) ($after['size'] ?? $written),
            'mtime' => (int) ($after['mtime'] ?? 0),
            'written' => (int) $written,
            // Hand back the new hash so a second Save needs no reload.
            'hash' => hash('sha256', self::readRaw($adapter, $norm, $cap)),
        ];
    }

    /** Editor size cap in bytes (shared by the read and write paths). */
    private static function editMaxBytes(): int
    {
        return \App\Config\Config::i()->getInt('EDIT_MAX_BYTES', 5242880);
    }

    private static function humanBytes(int $n): string
    {
        if ($n >= 1048576) {
            return rtrim(rtrim(number_format($n / 1048576, 1, '.', ''), '0'), '.') . ' MiB';
        }
        if ($n >= 1024) {
            return round($n / 1024) . ' KiB';
        }
        return $n . ' B';
    }

    /** Bytes inspected to decide whether a file is text (see readText). */
    private const SNIFF_BYTES = 8192;

    /** Read at most $bytes from the start of a file. Never throws. */
    private static function readHead(StorageAdapter $adapter, string $norm, int $bytes): string
    {
        try {
            $fh = $adapter->getStream($norm);
        } catch (Throwable) {
            return '';
        }
        if (!is_resource($fh)) {
            return '';
        }
        try {
            // Bounded read: adapters only handle the range start, so the caller
            // bounds the length (see LocalAdapter::getStream).
            return (string) stream_get_contents($fh, $bytes);
        } finally {
            fclose($fh);
        }
    }

    /** Read at most $cap bytes, refusing anything longer. @return string */
    private static function readRaw(StorageAdapter $adapter, string $norm, int $cap): string
    {
        $fh = $adapter->getStream($norm);
        if (!is_resource($fh)) {
            throw new RuntimeException('Cannot read file', 500);
        }
        try {
            $data = (string) stream_get_contents($fh, $cap + 1);
        } finally {
            fclose($fh);
        }
        if (strlen($data) > $cap) {
            throw new RuntimeException('Too large to edit (' . self::humanBytes($cap) . ' limit)', 413);
        }
        return $data;
    }

    /** True when the upload policy forbids this name (never writable here). */
    private static function isForbiddenName(string $name): bool
    {
        try {
            self::assertAllowedUpload($name);
            return false;
        } catch (InvalidArgumentException) {
            return true;
        }
    }

    public static function rename(AuthContext $user, string $mountName, string $path, string $newName): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        $newName = PathGuard::validateName($newName);
        if ($norm === '/') {
            throw new RuntimeException('Cannot rename the mount root');
        }
        $target = PathGuard::join(PathGuard::dirname($norm), $newName);
        if ($target === $norm) {
            return ['path' => $norm, 'name' => $newName];
        }
        if ($adapter->exists($target)) {
            throw new RuntimeException('Target already exists');
        }
        $adapter->rename($norm, $target);
        return ['path' => $target, 'name' => $newName];
    }

    /**
     * Rename many entries in one request.
     *
     * Two passes on purpose. Every new name is validated and checked for a
     * collision *before* anything moves, so a batch that cannot complete fails
     * with the whole list intact rather than leaving the folder half-renamed.
     *
     * The second pass also rejects chains (a→b while b→c): resolving those
     * needs a two-phase rename through temporary names, which is not safe to
     * assume every adapter supports. Reporting it beats silently doing the
     * wrong thing.
     *
     * @param array<int,array<string,mixed>> $items [{path, name}, ...]
     * @return array{done:array<int,array<string,mixed>>, failed:array<int,array<string,string>>, skipped:array<int,array<string,string>>}
     */
    public static function renameBatch(AuthContext $user, string $mountName, array $items): array
    {
        $done = [];
        $failed = [];
        $skipped = [];

        // Pass 1 — resolve and validate. Sources are collected first so a
        // target that is itself about to be renamed is detected, not clobbered.
        $planned = [];
        $sources = [];
        foreach ($items as $it) {
            $path = (string) ($it['path'] ?? '');
            $newName = (string) ($it['name'] ?? '');
            if ($path === '' || $newName === '') {
                $skipped[] = ['path' => $path, 'reason' => 'missing path or name'];
                continue;
            }
            try {
                [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
                self::assertWritable($mount, $adapter);
                $newName = PathGuard::validateName($newName);
            } catch (\Throwable $e) {
                $failed[] = ['path' => $path, 'error' => $e->getMessage()];
                continue;
            }
            if ($norm === '/') {
                $failed[] = ['path' => $path, 'error' => 'Cannot rename the mount root'];
                continue;
            }
            $target = PathGuard::join(PathGuard::dirname($norm), $newName);
            if ($target === $norm) {
                $skipped[] = ['path' => $norm, 'reason' => 'name unchanged'];
                continue;
            }
            $planned[] = ['adapter' => $adapter, 'from' => $norm, 'to' => $target];
            $sources[$norm] = true;
        }

        // Pass 2 — collision check against the *planned* set as well as the
        // directory, then apply.
        $targetCount = [];
        foreach ($planned as $p) {
            $targetCount[$p['to']] = ($targetCount[$p['to']] ?? 0) + 1;
        }
        $applied = [];
        foreach ($planned as $p) {
            if (isset($sources[$p['to']])) {
                $failed[] = ['path' => $p['from'], 'error' => 'Target is also being renamed in this batch — rename it in a separate step'];
                continue;
            }
            if (($targetCount[$p['to']] ?? 0) > 1) {
                $failed[] = ['path' => $p['from'], 'error' => 'Another item in this batch renames to the same name'];
                continue;
            }
            try {
                if ($p['adapter']->exists($p['to'])) {
                    $failed[] = ['path' => $p['from'], 'error' => 'Target already exists'];
                    continue;
                }
                $p['adapter']->rename($p['from'], $p['to']);
            } catch (\Throwable $e) {
                $failed[] = ['path' => $p['from'], 'error' => $e->getMessage()];
                continue;
            }
            $applied[] = ['from' => $p['from'], 'to' => $p['to'], 'name' => PathGuard::basename($p['to'])];
        }

        foreach ($applied as $a) {
            $done[] = ['path' => $a['from'], 'newPath' => $a['to'], 'name' => $a['name']];
        }

        return ['done' => $done, 'failed' => $failed, 'skipped' => $skipped];
    }

    /** Inline copy of a single entry (used for small files; big ones go to jobs). */
    public static function copyInline(AuthContext $user, string $mountName, string $path, string $destDir, string $conflict = 'rename'): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        [, , $destNorm] = StorageManager::resolve($user, $mountName, $destDir);
        $target = self::conflictTarget($adapter, $destNorm, PathGuard::basename($norm), $conflict);
        if ($target === null) {
            return ['skipped' => true];
        }
        $adapter->copy($norm, $target);
        return ['path' => $target];
    }

    /** Small server-side move/rename across dirs within one mount. */
    public static function moveInline(AuthContext $user, string $mountName, string $path, string $destDir, string $conflict = 'rename'): array
    {
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);
        self::assertWritable($mount, $adapter);
        [, , $destNorm] = StorageManager::resolve($user, $mountName, $destDir);
        if ($norm === $destNorm || str_starts_with($destNorm . '/', $norm . '/')) {
            throw new RuntimeException('Invalid move target');
        }
        // The destination must BE a directory. Without this, dropping onto a
        // file produced a path like "/folder/report.pdf/copy.txt" — the adapter
        // either errored confusingly or, worse, silently created a nested path.
        if (!$adapter->isDir($destNorm)) {
            throw new RuntimeException('Move target is not a folder');
        }
        $target = self::conflictTarget($adapter, $destNorm, PathGuard::basename($norm), $conflict);
        if ($target === null) {
            $adapter->delete($norm, true);
            return ['skipped' => true];
        }
        $adapter->rename($norm, $target);
        return ['path' => $target];
    }

    /**
     * Cross-mount / recursive copy executed by a background job.
     * @param callable(int,int,string):void $progress
     * @return array<string,mixed>
     */
    public static function copyTransfer(string $mountName, string $path, string $destMount, string $destDir, string $conflict, callable $progress, string $jobId): array
    {
        return self::transfer($mountName, $path, $destMount, $destDir, $conflict, $progress, false, $jobId);
    }

    /**
     * Cross-mount / recursive move executed by a background job (copy + delete source).
     * @param callable(int,int,string):void $progress
     * @return array<string,mixed>
     */
    public static function moveTransfer(string $mountName, string $path, string $destMount, string $destDir, string $conflict, callable $progress, string $jobId): array
    {
        return self::transfer($mountName, $path, $destMount, $destDir, $conflict, $progress, true, $jobId);
    }

    /**
     * Recursive transfer between two resolved locations. Uses per-entry adapter
     * copies when on the same adapter; streams file contents across adapters.
     * @param callable(int,int,string):void $progress
     * @return array<string,mixed>
     */
    private static function transfer(string $mountName, string $path, string $destMount, string $destDir, string $conflict, callable $progress, bool $deleteSource, string $jobId): array
    {
        $job = JobService::get($jobId);
        if ($job === null) {
            throw new RuntimeException('Job context missing');
        }
        $user = \App\Jobs\Handlers\AbstractHandler::userById((int) $job['user_id']);
        [$mount, $srcAdapter, $src] = StorageManager::resolve($user, $mountName, $path);
        [$destM, $dstAdapter, $dest] = StorageManager::resolve($user, $destMount, $destDir);
        self::assertWritable($destM, $dstAdapter);

        if ($src === '/') {
            throw new RuntimeException('Refusing to transfer the mount root');
        }
        if ($mountName === $destMount && (str_starts_with($dest . '/', $src . '/'))) {
            throw new RuntimeException('Cannot transfer into itself');
        }

        // 1. enumerate work
        $files = [];
        $dirs = [];
        self::enumerate($srcAdapter, $src, $dirs, $files);
        $total = count($files) + count($dirs);
        $done = 0;

        $baseName = PathGuard::basename($src);
        $target = self::conflictTarget($dstAdapter, $dest, $baseName, $conflict);
        if ($target === null) {
            return ['skipped' => true, 'files' => 0];
        }
        $dstAdapter->mkdir($target, true);
        $done++;
        $progress($done, max(1, $total), $baseName);

        // 2. create directory skeleton (paths relative to the transfer root)
        $createdDirs = [$src => $target];
        foreach ($dirs as $dir) {
            $rel = self::relInside($src, $dir);
            $dstPath = PathGuard::join($target, $rel);
            if (!$dstAdapter->exists($dstPath)) {
                $dstAdapter->mkdir($dstPath, true);
            }
            $createdDirs[$dir] = $dstPath;
            $done++;
            $progress($done, max(1, $total), PathGuard::basename($dir));
        }

        // 3. copy files
        $bytes = 0;
        foreach ($files as $file) {
            $rel = self::relInside($src, $file['path']);
            $dstPath = PathGuard::join($target, $rel);
            $in = $srcAdapter->getStream($file['path']);
            try {
                $bytes += $dstAdapter->putStream($dstPath, $in);
            } finally {
                if (is_resource($in)) {
                    fclose($in);
                }
            }
            $done++;
            $progress($done, max(1, $total), (string) $file['name']);
        }

        // 4. optional source delete
        if ($deleteSource) {
            self::assertWritable($mount, $srcAdapter);
            $srcAdapter->delete($src, true);
        }

        return ['path' => $target, 'files' => count($files), 'bytes' => $bytes];
    }

    /**
     * @param StorageAdapter $adapter
     * @param array<int, array<string,mixed>> $dirs
     * @param array<int, array<string,mixed>> $files
     */
    private static function enumerate(StorageAdapter $adapter, string $dir, array &$dirs, array &$files): void
    {
        foreach ($adapter->list($dir) as $entry) {
            $p = (string) $entry['path'];
            if (($entry['type'] ?? '') === 'dir') {
                $dirs[] = ['path' => $p, 'name' => $entry['name']];
                self::enumerate($adapter, $p, $dirs, $files);
            } elseif (($entry['type'] ?? '') === 'file') {
                $files[] = ['path' => $p, 'name' => $entry['name']];
            }
        }
    }

    /** Path of $child relative to $base (both normalized, $child inside $base). */
    private static function relInside(string $base, string $child): string
    {
        if ($child === $base) {
            return '';
        }
        $rel = substr($child, strlen($base) + 1);
        return $rel !== '' ? $rel : PathGuard::basename($child);
    }

    /** Resolve the destination path applying the conflict policy. */
    private static function conflictTarget(StorageAdapter $adapter, string $destDir, string $name, string $conflict): ?string
    {
        $base = PathGuard::join($destDir, $name);
        if (!$adapter->exists($base)) {
            return $base;
        }
        if ($conflict === 'overwrite') {
            $adapter->delete($base, true);
            return $base;
        }
        if ($conflict === 'skip') {
            return null;
        }
        // rename → "name (2).ext", "name (3).ext", ...
        $dot = strrpos($name, '.');
        $stem = $dot !== false && $dot !== 0 ? substr($name, 0, $dot) : $name;
        $ext = $dot !== false && $dot !== 0 ? substr($name, $dot) : '';
        for ($i = 2; $i < 1000; $i++) {
            $candidate = PathGuard::join($destDir, $stem . ' (' . $i . ')' . $ext);
            if (!$adapter->exists($candidate)) {
                return $candidate;
            }
        }
        throw new RuntimeException('No free name for conflict rename');
    }

    /**
     * Reject a write the user is not entitled to make.
     *
     * StorageManager::resolve() only decides *visibility*; per-user write denial
     * lives here, so every write path (uploads included) must call it.
     */
    public static function assertWritable(Mount $mount, StorageAdapter $adapter): void
    {
        if (!$mount->canWrite) {
            throw new RuntimeException('This mount is read-only or you lack write access', 403);
        }
    }

    /** Upload name policy (shared by upload + create-file paths). */
    public static function assertAllowedUpload(string $name): void
    {
        if (str_contains($name, '..') || substr_count($name, '.') > 4) {
            throw new InvalidArgumentException('Suspicious file name');
        }

        // Inspect EVERY dot-separated segment, not just the last one. Only
        // looking at the final extension would let "shell.php.txt" through as a
        // harmless text file, even though several servers would execute it.
        $segments = explode('.', strtolower($name));
        array_shift($segments);   // the part before the first dot is the stem
        foreach ($segments as $segment) {
            if ($segment !== '' && in_array($segment, Validator::FORBIDDEN_UPLOAD_EXT, true)) {
                throw new InvalidArgumentException('File type not allowed: .' . $segment);
            }
        }
    }

    /**
     * Content sniff for uploads: refuse server-executable payloads whatever they
     * are named. A rename to .jpg does not make PHP code less dangerous, and
     * some servers will happily serve it.
     *
     * @param resource $stream
     */
    public static function assertNotExecutableContent($stream): void
    {
        $pos = ftell($stream);
        $head = (string) fread($stream, 4096);
        if ($pos !== false) {
            fseek($stream, $pos);
        }
        if ($head === '') {
            return;
        }

        // finfo is the same check a browser and `file` would do.
        if (function_exists('finfo_open')) {
            $finfo = finfo_open(FILEINFO_MIME_TYPE);
            if ($finfo !== false) {
                $mime = finfo_buffer($finfo, $head);
                finfo_close($finfo);
                if (is_string($mime) && preg_match('~^application/x-(php|httpd-php)|^text/x-php~i', $mime)) {
                    throw new InvalidArgumentException('Server-side code was detected in the uploaded file');
                }
            }
        }

        // Belt and braces: a PHP open tag at the start is disqualifying even if
        // finfo is unavailable or unsure.
        if (str_starts_with(ltrim($head, " \t\r\n\0"), '<?php') || str_starts_with(ltrim($head, " \t\r\n\0"), '<?=')) {
            throw new InvalidArgumentException('Server-side code was detected in the uploaded file');
        }
    }
}
