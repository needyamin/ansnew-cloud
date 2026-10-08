<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use RuntimeException;
use Throwable;

/**
 * File-operation history, backing Undo and Redo.
 *
 * Each entry stores the operation plus everything needed to run it backwards
 * (`move` records both paths, `delete` records the trash id, `mkdir` records the
 * created path). Undo flips `undone` to 1; Redo flips it back — the stack is the
 * table, so it survives a reload and is shared between tabs.
 *
 * Recording a new operation truncates the redo tail, exactly like an editor:
 * once you do something new, the "redone" branch is gone.
 *
 * Deliberate limitation: an operation that crossed drives is undone through a
 * background job rather than inline, because a cross-drive move is exactly the
 * kind of work the worker exists for. The entry is still reversible — the client
 * just gets a job id back instead of an instant result.
 */
final class HistoryService
{
    /** History depth kept per user. */
    private const KEEP = 100;

    /** Max items reversed inline in one undo/redo. */
    private const MAX_ITEMS = 200;

    private const KINDS = ['move', 'copy', 'rename', 'delete', 'mkdir'];

    /**
     * Record a completed operation.
     *
     * @param array<string,mixed> $payload
     */
    public static function record(AuthContext $user, string $kind, string $mount, string $summary, array $payload): int
    {
        if (!in_array($kind, self::KINDS, true)) {
            return 0;
        }
        $db = Database::i();
        // A new operation invalidates the redo branch.
        $db->run('DELETE FROM op_history WHERE user_id = :u AND undone = 1', [':u' => $user->id]);

        $db->run(
            'INSERT INTO op_history (user_id, op, mount, summary, payload, created_at)
             VALUES (:u, :op, :m, :s, :p, datetime(\'now\'))',
            [
                ':u' => $user->id,
                ':op' => $kind,
                ':m' => $mount,
                ':s' => mb_substr($summary, 0, 200),
                ':p' => json_encode($payload, JSON_UNESCAPED_UNICODE) ?: '{}',
            ]
        );
        $id = (int) $db->pdo()->lastInsertId();
        self::prune($user->id);

        AuditService::log($user, 'history.record', $mount, null, $kind, 'ok', $summary, '', '');
        return $id;
    }

    /** Drop everything beyond the newest KEEP entries. */
    private static function prune(int $userId): void
    {
        Database::i()->run(
            'DELETE FROM op_history WHERE user_id = :u AND id NOT IN (
                SELECT id FROM op_history WHERE user_id = :u2 ORDER BY id DESC LIMIT ' . self::KEEP . '
             )',
            [':u' => $userId, ':u2' => $userId]
        );
    }

    /**
     * The visible history: newest first, with what can still be done.
     * @return array{entries:array<int,array<string,mixed>>, canUndo:bool, canRedo:bool}
     */
    public static function list(AuthContext $user, int $limit = 40): array
    {
        $rows = Database::i()->all(
            'SELECT id, op, mount, summary, payload, undone, created_at
             FROM op_history WHERE user_id = :u ORDER BY id DESC LIMIT ' . max(1, min(100, $limit)),
            [':u' => $user->id]
        );
        $entries = [];
        $canUndo = false;
        $canRedo = false;
        foreach ($rows as $r) {
            $undone = (int) $r['undone'] === 1;
            if (!$undone) {
                $canUndo = true;
            } elseif (!$canRedo) {
                $canRedo = true;   // only the newest undone step is redoable
            }
            $payload = json_decode((string) $r['payload'], true);
            $entries[] = [
                'id' => (int) $r['id'],
                'op' => (string) $r['op'],
                'mount' => (string) $r['mount'],
                'summary' => (string) $r['summary'],
                'undone' => $undone,
                'createdAt' => (string) $r['created_at'],
                'count' => is_array($payload) ? count($payload['items'] ?? []) : 0,
            ];
        }
        return ['entries' => $entries, 'canUndo' => $canUndo, 'canRedo' => $canRedo];
    }

    /**
     * Undo the newest step (or a specific one).
     * @return array<string,mixed>
     */
    public static function undo(AuthContext $user, ?int $id = null): array
    {
        $row = self::step($user, $id, false);
        return self::apply($user, $row, 'undo');
    }

    /** @return array<string,mixed> */
    public static function redo(AuthContext $user, ?int $id = null): array
    {
        $row = self::step($user, $id, true);
        return self::apply($user, $row, 'redo');
    }

    /** Clear the whole history for a user. */
    public static function clear(AuthContext $user): void
    {
        Database::i()->run('DELETE FROM op_history WHERE user_id = :u', [':u' => $user->id]);
    }

    /* -------------------------------------------------------------- internals */

    /**
     * Pick the step to act on: an explicit id, or the newest entry in the
     * relevant half of the stack.
     *
     * @return array<string,mixed>
     */
    private static function step(AuthContext $user, ?int $id, bool $redoing): array
    {
        $db = Database::i();
        if ($id !== null) {
            $row = $db->one(
                'SELECT * FROM op_history WHERE id = :id AND user_id = :u',
                [':id' => $id, ':u' => $user->id]
            );
        } else {
            $row = $db->one(
                'SELECT * FROM op_history WHERE user_id = :u AND undone = :d ORDER BY id ' . ($redoing ? 'ASC' : 'DESC') . ' LIMIT 1',
                [':u' => $user->id, ':d' => $redoing ? 1 : 0]
            );
        }
        if ($row === null) {
            throw new RuntimeException($redoing ? 'Nothing to redo' : 'Nothing to undo', 404);
        }
        return $row;
    }

    /**
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    private static function apply(AuthContext $user, array $row, string $direction): array
    {
        $payload = json_decode((string) $row['payload'], true);
        if (!is_array($payload)) {
            throw new RuntimeException('This history entry is unreadable', 409);
        }
        $kind = (string) $row['op'];
        $mount = (string) $row['mount'];
        $items = array_slice(is_array($payload['items'] ?? null) ? $payload['items'] : [], 0, self::MAX_ITEMS);

        $result = match ($kind) {
            'move', 'rename' => self::moveStep($user, $mount, $payload, $items, $direction),
            'copy' => self::copyStep($user, $mount, $payload, $items, $direction),
            'delete' => self::deleteStep($user, $mount, $payload, $items, $direction),
            'mkdir' => self::mkdirStep($user, $mount, $payload, $items, $direction),
            default => throw new RuntimeException('This operation cannot be reversed', 409),
        };

        // Flip the stack marker: undo marks it undone, redo clears that.
        Database::i()->run(
            'UPDATE op_history SET undone = :u, undone_at = :t WHERE id = :id',
            [
                ':u' => $direction === 'undo' ? 1 : 0,
                ':t' => $direction === 'undo' ? gmdate('Y-m-d H:i:s') : null,
                ':id' => (int) $row['id'],
            ]
        );

        AuditService::log($user, 'history.' . $direction, $mount, null, $kind, 'ok', (string) $row['summary'], '', '');
        return [
            'id' => (int) $row['id'],
            'op' => $kind,
            'direction' => $direction,
        ] + $result;
    }

    /**
     * Move / rename. Undo reverses each pair, redo re-applies it.
     *
     * @param array<string,mixed> $payload
     * @param array<int,array<string,mixed>> $items
     * @return array<string,mixed>
     */
    private static function moveStep(AuthContext $user, string $recordMount, array $payload, array $items, string $direction): array
    {
        $srcMount = (string) ($payload['mount'] ?? $recordMount);
        $destMount = (string) ($payload['destMount'] ?? $srcMount);
        $done = 0;
        $failed = [];
        $jobs = [];

        foreach ($items as $it) {
            $from = (string) ($it['from'] ?? '');
            $to = (string) ($it['to'] ?? '');
            if ($from === '' || $to === '') {
                continue;
            }
            $fromDir = PathGuard::dirname($from);
            $toDir = PathGuard::dirname($to);
            try {
                if ($direction === 'undo') {
                    self::moveOne($user, $destMount, $srcMount, $to, $fromDir, $failed, $jobs);
                } else {
                    self::moveOne($user, $srcMount, $destMount, $from, $toDir, $failed, $jobs);
                }
                $done++;
            } catch (Throwable $e) {
                $failed[] = ['path' => $direction === 'undo' ? $to : $from, 'error' => $e->getMessage()];
            }
        }

        self::announce($user, $direction === 'undo' ? $destMount : $srcMount, $items, 'from');
        self::announce($user, $direction === 'undo' ? $srcMount : $destMount, $items, 'to');

        return ['done' => $done, 'failed' => count($failed), 'jobs' => $jobs, 'errors' => array_slice($failed, 0, 10)];
    }

    /** @param array<int,array<string,mixed>> $failures @param array<int,string> $jobs */
    private static function moveOne(
        AuthContext $user,
        string $fromMount,
        string $toMount,
        string $path,
        string $destDir,
        array &$failures,
        array &$jobs
    ): void {
        // A cross-drive reversal is a background job: it is the same work the
        // worker already does for a normal cross-drive move.
        if ($fromMount !== $toMount) {
            $jobs[] = JobService::enqueue($user->id, 'move', [
                'mount' => $fromMount,
                'path' => $path,
                'destMount' => $toMount,
                'destDir' => $destDir,
                'conflict' => 'rename',
            ]);
            return;
        }
        FileService::moveInline($user, $fromMount, $path, $destDir, 'rename');
    }

    /**
     * Copy. Undo deletes the copies (to trash where possible); redo copies again.
     *
     * @param array<string,mixed> $payload
     * @param array<int,array<string,mixed>> $items
     * @return array<string,mixed>
     */
    private static function copyStep(AuthContext $user, string $recordMount, array $payload, array $items, string $direction): array
    {
        $srcMount = (string) ($payload['mount'] ?? $recordMount);
        $destMount = (string) ($payload['destMount'] ?? $srcMount);
        $done = 0;
        $failed = 0;
        $jobs = [];

        foreach ($items as $it) {
            $from = (string) ($it['from'] ?? '');
            $to = (string) ($it['to'] ?? '');
            if ($from === '' || $to === '') {
                continue;
            }
            try {
                if ($direction === 'undo') {
                    self::removeCreated($user, $destMount, $to, $jobs);
                } else {
                    if ($srcMount === $destMount) {
                        FileService::copyInline($user, $srcMount, $from, PathGuard::dirname($to), 'rename');
                    } else {
                        $jobs[] = JobService::enqueue($user->id, 'copy', [
                            'mount' => $srcMount,
                            'path' => $from,
                            'destMount' => $destMount,
                            'destDir' => PathGuard::dirname($to),
                            'conflict' => 'rename',
                        ]);
                    }
                }
                $done++;
            } catch (Throwable) {
                $failed++;
            }
        }

        self::announce($user, $destMount, $items, 'to');
        return ['done' => $done, 'failed' => $failed, 'jobs' => $jobs];
    }

    /** @param array<int,string> $jobs */
    private static function removeCreated(AuthContext $user, string $mount, string $path, array &$jobs): void
    {
        [, $adapter] = StorageManager::resolve($user, $mount, $path);
        if (!$adapter->exists($path)) {
            return;   // already gone — nothing to undo
        }
        $stat = $adapter->stat($path);
        if (($stat['type'] ?? '') === 'dir') {
            // Recursive deletes belong on the worker.
            $jobs[] = JobService::enqueue($user->id, 'delete', [
                'mount' => $mount, 'path' => $path, 'permanent' => false, 'userId' => $user->id,
            ]);
            return;
        }
        TrashService::deletePath($mount, $path, false, null, $user->id);
    }

    /**
     * Delete. Undo restores from the trash; redo deletes again.
     *
     * @param array<string,mixed> $payload
     * @param array<int,array<string,mixed>> $items
     * @return array<string,mixed>
     */
    private static function deleteStep(AuthContext $user, string $recordMount, array $payload, array $items, string $direction): array
    {
        $mount = (string) ($payload['mount'] ?? $recordMount);
        $done = 0;
        $failed = 0;
        $jobs = [];

        foreach ($items as $it) {
            $path = (string) ($it['path'] ?? '');
            if ($path === '') {
                continue;
            }
            try {
                if ($direction === 'undo') {
                    $trashId = self::trashIdFor($user, $mount, $path, $it);
                    if ($trashId === null) {
                        $failed++;
                        continue;
                    }
                    TrashService::restore($user->id, $trashId);
                } else {
                    self::removeCreated($user, $mount, $path, $jobs);
                }
                $done++;
            } catch (Throwable) {
                $failed++;
            }
        }

        self::announce($user, $mount, $items, 'path');
        return ['done' => $done, 'failed' => $failed, 'jobs' => $jobs];
    }

    /**
     * The trash row for a deleted path. The id captured at delete time is
     * authoritative; falling back to the newest row for the same original path
     * covers entries recorded before the id was stored.
     *
     * @param array<string,mixed> $item
     */
    private static function trashIdFor(AuthContext $user, string $mount, string $path, array $item): ?int
    {
        if (isset($item['trashId']) && (int) $item['trashId'] > 0) {
            $row = Database::i()->one(
                'SELECT id FROM trash_items WHERE id = :id AND user_id = :u',
                [':id' => (int) $item['trashId'], ':u' => $user->id]
            );
            if ($row !== null) {
                return (int) $row['id'];
            }
        }
        $row = Database::i()->one(
            'SELECT id FROM trash_items WHERE user_id = :u AND mount = :m AND original_path = :p
             ORDER BY id DESC LIMIT 1',
            [':u' => $user->id, ':m' => $mount, ':p' => $path]
        );
        return $row !== null ? (int) $row['id'] : null;
    }

    /**
     * Create folder. Undo removes it; redo recreates it.
     *
     * @param array<string,mixed> $payload
     * @param array<int,array<string,mixed>> $items
     * @return array<string,mixed>
     */
    private static function mkdirStep(AuthContext $user, string $recordMount, array $payload, array $items, string $direction): array
    {
        $mount = (string) ($payload['mount'] ?? $recordMount);
        $done = 0;
        $failed = 0;
        $jobs = [];

        foreach ($items as $it) {
            $path = (string) ($it['path'] ?? '');
            if ($path === '') {
                continue;
            }
            try {
                if ($direction === 'undo') {
                    self::removeCreated($user, $mount, $path, $jobs);
                } else {
                    FileService::mkdir($user, $mount, PathGuard::dirname($path), PathGuard::basename($path));
                }
                $done++;
            } catch (Throwable) {
                $failed++;
            }
        }

        self::announce($user, $mount, $items, 'path');
        return ['done' => $done, 'failed' => $failed, 'jobs' => $jobs];
    }

    /**
     * Tell open panes which directories changed.
     * @param array<int,array<string,mixed>> $items
     */
    private static function announce(AuthContext $user, string $mount, array $items, string $key): void
    {
        if ($mount === '' || !$items) {
            return;
        }
        $dirs = [];
        foreach ($items as $it) {
            $p = (string) ($it[$key] ?? '');
            if ($p === '') {
                continue;
            }
            $dirs[] = PathGuard::dirname($p);
        }
        $dirs = array_values(array_unique($dirs));
        if ($dirs) {
            NotifyService::fsChanged($user->id, [$mount => $dirs], 'history');
        }
    }
}
