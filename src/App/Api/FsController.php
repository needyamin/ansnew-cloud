<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\JobService;
use App\Services\AuditService;
use App\Services\NotifyService;
use App\Services\DownloadService;
use App\Services\FavoritesService;
use App\Services\FileService;
use App\Services\ThumbnailService;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use App\Support\Validator;
use RuntimeException;

/**
 * Filesystem endpoints. Mount resolution + path validation + RBAC all happen
 * in StorageManager::resolve(); this controller stays a thin shell.
 */
final class FsController
{
    /**
     * Directory listing with conditional-GET support.
     *
     * The SPA re-lists a folder after every mutation, so an unchanged folder
     * must cost a 304 rather than a re-walk of the directory (which, with
     * encryption on, is an fopen + 2 freads per file).
     */
    public static function list(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $path = (string) $req->query('path', '/');
        $data = FileService::list($user, Validator::mountName($mount), $path);

        $etag = '"' . (string) ($data['etag'] ?? '') . '"';
        // 'no-cache' (not 'no-store'): the response may be stored but must be
        // revalidated, which is what lets the browser keep and resend the ETag.
        $resp = Response::ok($data)
            ->withHeader('ETag', $etag)
            ->withHeader('Cache-Control', 'private, no-cache');

        $inm = trim((string) ($req->header('if-none-match') ?? ''));
        if ($inm !== '' && hash_equals($etag, $inm)) {
            $notModified = new Response(304, '');
            $notModified->withHeader('ETag', $etag);
            $notModified->withHeader('Cache-Control', 'private, no-cache');
            return $notModified;
        }
        return $resp;
    }

    public static function mkdir(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $r = FileService::mkdir($user, $mount, (string) ($body['path'] ?? '/'), (string) ($body['name'] ?? ''));
        AuditService::log($user, 'fs.mkdir', $mount, $r['path'], null, 'ok', '', $req->ip(), $req->userAgent());
        NotifyService::fsChanged($user->id, [$mount => [PathGuard::dirname($r['path'])]], 'mkdir');
        return Response::ok($r);
    }

    public static function createFile(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $r = FileService::createFile($user, $mount, (string) ($body['path'] ?? '/'), (string) ($body['name'] ?? ''));
        AuditService::log($user, 'fs.create', $mount, $r['path'], null, 'ok', '', $req->ip(), $req->userAgent());
        NotifyService::fsChanged($user->id, [$mount => [PathGuard::dirname($r['path'])]], 'create');
        return Response::ok($r);
    }

    public static function rename(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $r = FileService::rename($user, $mount, (string) ($body['path'] ?? ''), (string) ($body['name'] ?? ''));
        AuditService::log($user, 'fs.rename', $mount, (string) ($body['path'] ?? ''), $r['path'], 'ok', '', $req->ip(), $req->userAgent());
        // Renaming a directory also changes the identity of everything inside it,
        // so the old path is announced too and its subtree gets invalidated.
        NotifyService::fsChanged($user->id, [
            $mount => array_values(array_unique([PathGuard::dirname($r['path']), (string) ($body['path'] ?? '')])),
        ], 'rename');
        return Response::ok($r);
    }

    /** Copy: small single entries inline, folders/big files as a background job. */
    public static function copy(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $path = (string) ($body['path'] ?? '');
        $destDir = (string) ($body['destDir'] ?? '/');
        $destMount = (string) ($body['destMount'] ?? $mount);
        $conflict = in_array($body['conflict'] ?? 'rename', ['overwrite', 'skip', 'rename'], true)
            ? (string) ($body['conflict'] ?? 'rename') : 'rename';

        [$m, $adapter, $norm] = StorageManager::resolve($user, $mount, $path);
        $stat = $adapter->stat($norm);
        $isDir = ($stat['type'] ?? '') === 'dir';
        $big = ((int) ($stat['size'] ?? 0) > 32 * 1024 * 1024) || $isDir;

        if ($big || $destMount !== $mount) {
            $jobId = JobService::enqueue($user->id, 'copy', [
                'mount' => $mount, 'path' => $path,
                'destMount' => $destMount, 'destDir' => $destDir, 'conflict' => $conflict,
            ]);
            AuditService::log($user, 'fs.copy.job', $mount, $path, $destMount . ':' . $destDir, 'ok', 'job ' . $jobId, $req->ip(), $req->userAgent());
            return Response::ok(['job' => $jobId, 'async' => true]);
        }

        $r = FileService::copyInline($user, $mount, $path, $destDir, $conflict);
        AuditService::log($user, 'fs.copy', $mount, $path, null, 'ok', '', $req->ip(), $req->userAgent());
        NotifyService::fsChanged($user->id, self::dirMap([
            [$mount, PathGuard::dirname($path)],
            [$destMount, $destDir],
        ]), 'copy');
        return Response::ok($r + ['async' => false]);
    }

    public static function move(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $path = (string) ($body['path'] ?? '');
        $destDir = (string) ($body['destDir'] ?? '/');
        $destMount = (string) ($body['destMount'] ?? $mount);
        $conflict = in_array($body['conflict'] ?? 'rename', ['overwrite', 'skip', 'rename'], true)
            ? (string) ($body['conflict'] ?? 'rename') : 'rename';

        [$m, $adapter, $norm] = StorageManager::resolve($user, $mount, $path);
        $stat = $adapter->stat($norm);
        $isDir = ($stat['type'] ?? '') === 'dir';
        $big = ((int) ($stat['size'] ?? 0) > 32 * 1024 * 1024) || $isDir;

        if ($big || $destMount !== $mount) {
            $jobId = JobService::enqueue($user->id, 'move', [
                'mount' => $mount, 'path' => $path,
                'destMount' => $destMount, 'destDir' => $destDir, 'conflict' => $conflict,
            ]);
            AuditService::log($user, 'fs.move.job', $mount, $path, $destMount . ':' . $destDir, 'ok', 'job ' . $jobId, $req->ip(), $req->userAgent());
            return Response::ok(['job' => $jobId, 'async' => true]);
        }

        $r = FileService::moveInline($user, $mount, $path, $destDir, $conflict);
        AuditService::log($user, 'fs.move', $mount, $path, $r['path'] ?? null, 'ok', '', $req->ip(), $req->userAgent());
        NotifyService::fsChanged($user->id, self::dirMap([
            [$mount, PathGuard::dirname($path)],
            [$destMount, $destDir],
        ]), 'move');
        return Response::ok($r + ['async' => false]);
    }

    /** Delete: trash when available, permanent when requested or forced. */
    public static function delete(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $path = (string) ($body['path'] ?? '');
        $permanent = Validator::bool($body['permanent'] ?? false);

        $gated = \App\Auth\SensitiveGate::guard($session, 'fs.delete', $permanent);
        if ($gated !== null) {
            return $gated;
        }

        // Folders can be big -> background job; files inline.
        [$m, $adapter, $norm] = StorageManager::resolve($user, $mount, $path);
        // Gated HERE, not only in the worker: a read-only account must not be
        // able to enqueue a delete job, and this used to have no check at all.
        \App\Auth\Policy::assertCan(null, $m->canWrite, $user->isAdmin(), 'delete');
        $stat = $adapter->stat($norm);

        if (($stat['type'] ?? '') === 'dir') {
            $jobId = JobService::enqueue($user->id, 'delete', ['mount' => $mount, 'path' => $path, 'permanent' => $permanent, 'userId' => $user->id]);
            AuditService::log($user, 'fs.delete.job', $mount, $path, null, 'ok', 'job ' . $jobId, $req->ip(), $req->userAgent());
            return Response::ok(['job' => $jobId, 'async' => true]);
        }

        $r = \App\Services\TrashService::deletePath($mount, $path, $permanent, null, $user->id);
        AuditService::log($user, 'fs.delete', $mount, $path, null, 'ok', $r['trashed'] ? 'trashed' : 'permanent', $req->ip(), $req->userAgent());
        NotifyService::fsChanged($user->id, [$mount => [PathGuard::dirname($path)]], 'delete');
        return Response::ok($r + ['async' => false]);
    }

    /* ------------------------------------------------------------------ *
     * Batch operations
     *
     * The SPA used to loop one request per selected item, so deleting 100
     * files meant 100 round trips (each paying session + RBAC + rate limit)
     * and 100 toasts on failure. These take the whole selection at once and
     * report per-item outcomes, so one bad path can't abort the rest.
     * ------------------------------------------------------------------ */

    /** Hard cap so a hostile or buggy client can't enqueue unbounded work. */
    private const BATCH_LIMIT = 500;

    /**
     * Build a mount => directories map for a change notification, merging
     * repeats and dropping empty entries.
     *
     * @param array<int,array{0:string,1:string}> $pairs [mount, directory] tuples
     * @return array<string,string[]>
     */
    private static function dirMap(array $pairs): array
    {
        $map = [];
        foreach ($pairs as [$m, $dir]) {
            if ($m === '' || $dir === '') {
                continue;
            }
            $map[$m] = array_merge($map[$m] ?? [], [$dir]);
        }
        foreach ($map as $m => $dirs) {
            $map[$m] = array_values(array_unique($dirs));
        }
        return $map;
    }

    /**
     * @param mixed $raw
     * @return array<int,array<string,mixed>>
     */
    private static function batchItems($raw): array
    {
        if (!is_array($raw)) {
            return [];
        }
        $out = [];
        foreach (array_values($raw) as $it) {
            if (is_array($it)) {
                $out[] = $it;
            } elseif (is_string($it) && $it !== '') {
                $out[] = ['path' => $it];
            }
        }
        return $out;
    }

    /**
     * POST /api/fs/{mount}/delete-batch
     * {"items":[{"path":"/a/b.txt"}], "permanent":false}
     * -> {"done":[{"path":...}], "async":[{"path":...,"job":...}], "failed":[{"path":...,"error":...}]}
     */
    public static function deleteBatch(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $items = self::batchItems($body['items'] ?? null);
        if (!$items) {
            return Response::error('No items given', 400, 'bad_request');
        }
        if (count($items) > self::BATCH_LIMIT) {
            return Response::error('Too many items (max ' . self::BATCH_LIMIT . ')', 400, 'too_many');
        }
        $permanent = Validator::bool($body['permanent'] ?? false);

        // Whole-selection deletes are the easiest thing to trigger by accident
        // (Ctrl+A, Delete), so the password is asked once for the batch rather
        // than per item.
        $gated = \App\Auth\SensitiveGate::guard($session, 'fs.delete', $permanent);
        if ($gated !== null) {
            return $gated;
        }

        // Resolve the destination mount once and gate the whole batch on it.
        // Deletion had no permission check at all before, so a read-only grant
        // did not prevent deleting. mountFor() is the per-user view: it folds
        // the grant, so a canWrite=false grant is honoured here.
        try {
            $m = StorageManager::mountFor($user, $mount);
        } catch (\Throwable $e) {
            return Response::error('Mount not found or access denied', 404, 'not_found');
        }
        \App\Auth\Policy::assertCan(null, $m->canWrite, $user->isAdmin(), 'delete');

        $done = [];
        $async = [];
        $failed = [];
        foreach ($items as $it) {
            $path = (string) ($it['path'] ?? '');
            if ($path === '') {
                continue;
            }
            try {
                [, $adapter, $norm] = StorageManager::resolve($user, $mount, $path);
                $stat = $adapter->stat($norm);
                if (($stat['type'] ?? '') === 'dir') {
                    $jobId = JobService::enqueue($user->id, 'delete', [
                        'mount' => $mount, 'path' => $norm, 'permanent' => $permanent, 'userId' => $user->id,
                    ]);
                    AuditService::log($user, 'fs.delete.job', $mount, $norm, null, 'ok', 'job ' . $jobId, $req->ip(), $req->userAgent());
                    $async[] = ['path' => $norm, 'job' => $jobId];
                    continue;
                }
                $r = \App\Services\TrashService::deletePath($mount, $norm, $permanent, null, $user->id);
                AuditService::log($user, 'fs.delete', $mount, $norm, null, 'ok', $r['trashed'] ? 'trashed' : 'permanent', $req->ip(), $req->userAgent());
                $done[] = ['path' => $norm] + $r;
            } catch (\Throwable $e) {
                $failed[] = ['path' => $path, 'error' => $e->getMessage()];
            }
        }
        // One notification for the whole batch, not one per item.
        $touched = array_merge(array_column($done, 'path'), array_column($async, 'path'));
        NotifyService::fsChanged($user->id, self::dirMap(array_map(
            static fn (string $p): array => [$mount, PathGuard::dirname($p)],
            $touched
        )), 'delete-batch');

        return Response::ok(['done' => $done, 'async' => $async, 'failed' => $failed]);
    }

    /**
     * POST /api/fs/{mount}/rename-batch
     * {"items":[{"path":"/a/x.txt","name":"y.txt"}]}
     * -> {"done":[{"path":...,"newPath":...,"name":...}], "failed":[...], "skipped":[...]}
     *
     * Names are computed by the client (find/replace, prefix, numbering…) but
     * every one is re-validated server-side, so a hostile client cannot smuggle
     * a path traversal or a forbidden extension through a rename.
     */
    public static function renameBatch(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $items = self::batchItems($body['items'] ?? null);
        if (!$items) {
            return Response::error('No items given', 400, 'bad_request');
        }
        if (count($items) > self::BATCH_LIMIT) {
            return Response::error('Too many items (max ' . self::BATCH_LIMIT . ')', 400, 'too_many');
        }

        try {
            $m = StorageManager::mountFor($user, $mount);
        } catch (\Throwable $e) {
            return Response::error('Mount not found or access denied', 404, 'not_found');
        }
        \App\Auth\Policy::assertCan(null, $m->canWrite, $user->isAdmin(), 'rename');

        $r = FileService::renameBatch($user, $mount, $items);

        $touched = array_merge(array_column($r['done'], 'path'), array_column($r['done'], 'newPath'));
        if ($touched) {
            NotifyService::fsChanged($user->id, self::dirMap(array_map(
                static fn (string $p): array => [$mount, PathGuard::dirname($p)],
                $touched
            )), 'rename-batch');
        }
        return Response::ok($r);
    }

    /**
     * POST /api/fs/{mount}/move-batch  (and copy-batch, same shape)
     * {"items":[{"path":"/a/x"}], "destDir":"/b", "destMount":"local", "conflict":"rename"}
     * -> {"done":[{"path":...,"dest":...}], "async":[...], "failed":[...], "skipped":[...]}
     */
    public static function moveBatch(Request $req, SessionManager $session, string $mount): Response
    {
        return self::transferBatch($req, $session, $mount, 'move');
    }

    public static function copyBatch(Request $req, SessionManager $session, string $mount): Response
    {
        return self::transferBatch($req, $session, $mount, 'copy');
    }

    private static function transferBatch(Request $req, SessionManager $session, string $mount, string $op): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $items = self::batchItems($body['items'] ?? null);
        if (!$items) {
            return Response::error('No items given', 400, 'bad_request');
        }
        if (count($items) > self::BATCH_LIMIT) {
            return Response::error('Too many items (max ' . self::BATCH_LIMIT . ')', 400, 'too_many');
        }
        $destDir = (string) ($body['destDir'] ?? '/');
        $destMount = (string) ($body['destMount'] ?? $mount);
        $conflict = in_array($body['conflict'] ?? 'rename', ['overwrite', 'skip', 'rename'], true)
            ? (string) ($body['conflict'] ?? 'rename') : 'rename';

        // Resolve (and authorise) the destination once, not per item.
        try {
            [, , $destNorm] = StorageManager::resolve($user, $destMount, $destDir);
        } catch (\Throwable $e) {
            return Response::error('Invalid destination: ' . $e->getMessage(), 400, 'bad_request');
        }
        // The destination must accept writes. The inline path checks this inside
        // moveInline/copyInline, but the job-backed path runs without a user, so
        // without this a read-only grant could be bypassed by moving a folder.
        try {
            $destMountRow = StorageManager::mountFor($user, $destMount);
        } catch (\Throwable $e) {
            return Response::error('Destination mount not found or access denied', 404, 'not_found');
        }
        \App\Auth\Policy::assertCan(null, $destMountRow->canWrite, $user->isAdmin(), 'moveInto');

        $done = [];
        $async = [];
        $failed = [];
        $skipped = [];
        foreach ($items as $it) {
            $path = (string) ($it['path'] ?? '');
            if ($path === '') {
                continue;
            }
            try {
                [, $adapter, $norm] = StorageManager::resolve($user, $mount, $path);
                // Refuse moving a folder into itself or its own descendant.
                // FileService::moveInline() checks this too, but the job-backed
                // path below did not, so the guard has to happen here as well.
                if ($op === 'move' && $destMount === $mount
                    && ($norm === $destNorm || str_starts_with($destNorm . '/', $norm . '/'))) {
                    $failed[] = ['path' => $norm, 'error' => 'Invalid move target'];
                    continue;
                }
                $stat = $adapter->stat($norm);
                $isDir = ($stat['type'] ?? '') === 'dir';
                $big = ((int) ($stat['size'] ?? 0) > 32 * 1024 * 1024) || $isDir;

                if ($big || $destMount !== $mount) {
                    $jobId = JobService::enqueue($user->id, $op, [
                        'mount' => $mount, 'path' => $norm,
                        'destMount' => $destMount, 'destDir' => $destDir, 'conflict' => $conflict,
                    ]);
                    AuditService::log($user, 'fs.' . $op . '.job', $mount, $norm, $destMount . ':' . $destDir, 'ok', 'job ' . $jobId, $req->ip(), $req->userAgent());
                    $async[] = ['path' => $norm, 'job' => $jobId];
                    continue;
                }
                if ($op === 'copy') {
                    $r = FileService::copyInline($user, $mount, $norm, $destDir, $conflict);
                } else {
                    $r = FileService::moveInline($user, $mount, $norm, $destDir, $conflict);
                }
                AuditService::log($user, 'fs.' . $op, $mount, $norm, $r['path'] ?? null, 'ok', '', $req->ip(), $req->userAgent());
                if (!empty($r['skipped'])) {
                    $skipped[] = ['path' => $norm, 'reason' => 'exists'];
                    continue;
                }
                $done[] = ['path' => $norm, 'dest' => $r['path'] ?? null];
            } catch (\Throwable $e) {
                $failed[] = ['path' => $path, 'error' => $e->getMessage()];
            }
        }
        $touched = array_merge(array_column($done, 'path'), array_column($async, 'path'));
        NotifyService::fsChanged($user->id, self::dirMap(array_merge(
            array_map(static fn (string $p): array => [$mount, PathGuard::dirname($p)], $touched),
            [[$destMount, $destDir]]
        )), $op . '-batch');

        return Response::ok(['done' => $done, 'async' => $async, 'failed' => $failed, 'skipped' => $skipped]);
    }

    public static function archive(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $jobId = JobService::enqueue($user->id, 'archive', [
            'mount' => $mount,
            'paths' => is_array($body['paths'] ?? null) ? array_values(array_map('strval', $body['paths'])) : [],
            'destDir' => (string) ($body['destDir'] ?? '/'),
            'format' => in_array($body['format'] ?? 'zip', ['zip', 'tar.gz'], true) ? $body['format'] : 'zip',
            'name' => (string) ($body['name'] ?? ''),
        ]);
        AuditService::log($user, 'fs.archive', $mount, null, null, 'ok', 'job ' . $jobId, $req->ip(), $req->userAgent());
        return Response::ok(['job' => $jobId]);
    }

    public static function extract(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $jobId = JobService::enqueue($user->id, 'extract', [
            'mount' => $mount,
            'path' => (string) ($body['path'] ?? ''),
            'destDir' => (string) ($body['destDir'] ?? ''),
        ]);
        AuditService::log($user, 'fs.extract', $mount, (string) ($body['path'] ?? ''), null, 'ok', 'job ' . $jobId, $req->ip(), $req->userAgent());
        return Response::ok(['job' => $jobId]);
    }

    public static function search(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $needle = trim((string) $req->query('q', ''));
        if ($needle === '') {
            return Response::error('Empty search query', 400, 'bad_request');
        }
        if (mb_strlen($needle) > 200) {
            $needle = mb_substr($needle, 0, 200);
        }
        $path = (string) $req->query('path', '/');
        [, $adapter, $norm] = StorageManager::resolve($user, Validator::mountName($mount), $path);
        $results = $adapter->search($norm, $needle, 200);
        return Response::ok(['results' => $results]);
    }

    /** Stream a file download (Range requests honored for local mounts). */
    public static function download(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $path = (string) $req->query('path', '');
        [, $adapter, $norm] = StorageManager::resolve($user, Validator::mountName($mount), $path);
        $stat = $adapter->stat($norm);
        if (($stat['type'] ?? '') !== 'file') {
            return Response::error('Not a file', 400, 'bad_request');
        }

        FavoritesService::recordRecent($user, $mount, $norm, (string) $stat['name'], 'download');
        AuditService::log($user, 'fs.download', $mount, $norm, null, 'ok', '', $req->ip(), $req->userAgent());

        $stream = $adapter->getStream($norm);
        $resp = new Response(200, '');
        $resp->withHeader('Content-Type', 'application/octet-stream');
        $resp->withHeader('Content-Length', (string) $stat['size']);
        $resp->withHeader('Content-Disposition', 'attachment; filename="' . self::asciiFallback((string) $stat['name']) . '"; filename*=UTF-8\'\'' . rawurlencode((string) $stat['name']));
        $resp->withHeader('X-Content-Type-Options', 'nosniff');
        $resp->withHeader('Cache-Control', 'no-store');
        return $resp->withStream($stream, (int) $stat['size']);
    }

    /** Inline preview (images/text/media) with a sandboxed content type. */
    public static function preview(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $path = (string) $req->query('path', '');
        [, $adapter, $norm] = StorageManager::resolve($user, Validator::mountName($mount), $path);
        $stat = $adapter->stat($norm);
        if (($stat['type'] ?? '') !== 'file') {
            return Response::error('Not a file', 400, 'bad_request');
        }

        $mime = (string) ($stat['mime'] ?? '');
        if ($mime === '' || str_contains($mime, 'html') || str_contains($mime, 'svg') || str_contains($mime, 'xml')) {
            $mime = 'text/plain; charset=utf-8'; // never render user content as active content
        }
        FavoritesService::recordRecent($user, $mount, $norm, (string) $stat['name'], 'preview');

        $stream = $adapter->getStream($norm);
        $resp = new Response(200, '');
        $resp->withHeader('Content-Type', $mime);
        $resp->withHeader('Content-Length', (string) $stat['size']);
        $resp->withHeader('X-Content-Type-Options', 'nosniff');
        $resp->withHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; object-src 'self' blob:");
        $resp->withHeader('Cache-Control', 'private, max-age=60');
        return $resp->withStream($stream, (int) $stat['size']);
    }

    /**
     * Server-side thumbnail for image entries. Generated through the storage
     * adapter (so encrypted files work) and cached on disk.
     */
    public static function thumb(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $path = (string) $req->query('path', '');
        $size = (int) $req->query('size', '256');

        try {
            $t = ThumbnailService::generate($user, Validator::mountName($mount), $path, $size);
        } catch (\RuntimeException $e) {
            $code = $e->getCode();
            $status = $code === 404 ? 404 : ($code === 413 ? 413 : ($code === 415 ? 415 : 500));
            return Response::error($e->getMessage(), $status, 'thumb_unavailable');
        }

        $stream = @fopen($t['file'], 'rb');
        if ($stream === false) {
            return Response::error('Thumbnail unavailable', 404, 'not_found');
        }
        $len = (int) (filesize($t['file']) ?: 0);

        $resp = new Response(200, '');
        $resp->withHeader('Content-Type', $t['mime']);
        $resp->withHeader('Content-Length', (string) $len);
        $resp->withHeader('X-Content-Type-Options', 'nosniff');
        // Private + long-lived: the URL is stable per (path, mtime, size).
        $resp->withHeader('Cache-Control', 'private, max-age=86400');
        return $resp->withStream($stream, $len);
    }

    public static function stat(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $path = (string) $req->query('path', '/');
        [, $adapter, $norm] = StorageManager::resolve($user, Validator::mountName($mount), $path);
        return Response::ok($adapter->stat($norm));
    }

    /** Kick off a folder-download background job (zip prepared server-side). */
    public static function downloadFolder(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $jobId = JobService::enqueue($user->id, 'download-folder', [
            'mount' => $mount, 'path' => (string) ($body['path'] ?? ''),
        ]);
        return Response::ok(['job' => $jobId]);
    }

    /** Consume a one-shot folder-download token. */
    public static function consumeDownload(Request $req, SessionManager $session, string $token): Response
    {
        $user = Guard::requireUser($session);
        $payload = DownloadService::consumeToken($user->id, $token);
        if ($payload === null) {
            return Response::error('Invalid or expired download token', 404, 'not_found');
        }
        $stream = fopen($payload['file'], 'rb');
        if ($stream === false) {
            return Response::error('Download artifact missing', 404, 'not_found');
        }
        $resp = new Response(200, '');
        $resp->withHeader('Content-Type', 'application/zip');
        $resp->withHeader('Content-Length', (string) $payload['size']);
        $resp->withHeader('Content-Disposition', 'attachment; filename="' . self::asciiFallback($payload['name']) . '"');
        return $resp->withStream($stream, $payload['size']);
    }

    private static function asciiFallback(string $name): string
    {
        $clean = preg_replace('/[^A-Za-z0-9._-]/', '_', $name) ?: 'download';
        return $clean !== '' ? $clean : 'download';
    }
}