<?php

declare(strict_types=1);

namespace App\Services;

use App\Core\Database;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use RuntimeException;
use Throwable;

/**
 * Trash / recycle-bin for local mounts (remote adapters delete permanently
 * because most remote protocols have no cheap rename-into-trash semantics).
 *
 * Trash layout per local mount: /__ansnew_trash__/<epoch>-<name>
 * Metadata lives in trash_items; restores move entries back.
 */
final class TrashService
{
    public const TRASH_DIR = '__ansnew_trash__';

    /**
     * Delete a path: trash when possible, else permanent.
     * @param callable(int,int,string):void|null $progress
     * @return array<string,mixed>
     */
    public static function deletePath(string $mountName, string $path, bool $permanent = false, ?callable $progress = null, int $userId = 0): array
    {
        $user = \App\Jobs\Handlers\AbstractHandler::userById($userId);
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);

        if ($norm === '/') {
            throw new RuntimeException('Refusing to delete the mount root');
        }
        if (PathGuard::isTrashPath($norm)) {
            throw new RuntimeException('Use the trash endpoints to manage trash contents');
        }
        if (!$mount->canWrite) {
            throw new RuntimeException('This mount is read-only or you lack write access', 403);
        }

        $stat = $adapter->stat($norm);
        $name = PathGuard::basename($norm);

        $canTrash = !$permanent
            && $mount->trashEnabled
            && $mount->adapter === 'local'
            && \App\Config\Config::i()->getBool('TRASH_ENABLED', true);

        if ($canTrash) {
            $trashDir = '/' . self::TRASH_DIR;
            if (!$adapter->exists($trashDir)) {
                $adapter->mkdir($trashDir, true);
            }
            $trashPath = PathGuard::join($trashDir, time() . '-' . $name);
            $adapter->rename($norm, $trashPath);

            Database::i()->run(
                'INSERT INTO trash_items (user_id, mount, original_path, trash_path, name, is_dir, size)
                 VALUES (:u,:m,:o,:t,:n,:d,:s)',
                [
                    ':u' => $userId, ':m' => $mountName,
                    ':o' => $norm, ':t' => $trashPath,
                    ':n' => $name, ':d' => $stat['type'] === 'dir' ? 1 : 0,
                    ':s' => (int) ($stat['size'] ?? 0),
                ]
            );
            return ['trashed' => true, 'trashPath' => $trashPath];
        }

        // Permanent delete (with optional progress for large trees).
        if ($progress !== null) {
            $progress(5, 100, 'Deleting ' . $name);
        }
        $adapter->delete($norm, true);
        if ($progress !== null) {
            $progress(100, 100, 'Deleted');
        }
        return ['trashed' => false];
    }

    /** @return array<int, array<string,mixed>> trash contents of one mount for one user */
    public static function listTrash(int $userId, string $mountName): array
    {
        return Database::i()->all(
            'SELECT id, mount, original_path, trash_path, name, is_dir, size, deleted_at
             FROM trash_items WHERE user_id = :u AND mount = :m ORDER BY deleted_at DESC',
            [':u' => $userId, ':m' => $mountName]
        );
    }

    public static function restore(int $userId, int $itemId): array
    {
        $db = Database::i();
        $row = $db->one('SELECT * FROM trash_items WHERE id = :id AND user_id = :u', [':id' => $itemId, ':u' => $userId]);
        if ($row === null) {
            throw new RuntimeException('Trash item not found', 404);
        }
        $user = \App\Jobs\Handlers\AbstractHandler::userById($userId);
        [$mount, $adapter, $trashNorm] = StorageManager::resolve($user, (string) $row['mount'], (string) $row['trash_path']);
        if (!$adapter->exists($trashNorm)) {
            // Already gone — drop the metadata row.
            $db->run('DELETE FROM trash_items WHERE id = :id', [':id' => $itemId]);
            throw new RuntimeException('Trashed entry no longer exists');
        }

        $original = PathGuard::normalize((string) $row['original_path']);
        $destDir = PathGuard::dirname($original);
        $name = PathGuard::basename($original);
        if (!$adapter->exists($destDir)) {
            $adapter->mkdir($destDir, true);
        }
        $target = self::freeName($adapter, $destDir, $name);
        $adapter->rename($trashNorm, $target);
        $db->run('DELETE FROM trash_items WHERE id = :id', [':id' => $itemId]);
        return ['restoredTo' => $target];
    }

    public static function purge(int $userId, int $itemId): void
    {
        $db = Database::i();
        $row = $db->one('SELECT * FROM trash_items WHERE id = :id AND user_id = :u', [':id' => $itemId, ':u' => $userId]);
        if ($row === null) {
            throw new RuntimeException('Trash item not found', 404);
        }
        try {
            $user = \App\Jobs\Handlers\AbstractHandler::userById($userId);
            [, $adapter, $trashNorm] = StorageManager::resolve($user, (string) $row['mount'], (string) $row['trash_path']);
            if ($adapter->exists($trashNorm)) {
                $adapter->delete($trashNorm, true);
            }
        } catch (Throwable) {
            // Storage may be unavailable; still drop the metadata.
        }
        $db->run('DELETE FROM trash_items WHERE id = :id', [':id' => $itemId]);
    }

    public static function emptyForUser(int $userId, string $mountName): int
    {
        $count = 0;
        foreach (self::listTrash($userId, $mountName) as $item) {
            self::purge($userId, (int) $item['id']);
            $count++;
        }
        return $count;
    }

    /** Retention sweep (called from the worker loop occasionally). */
    public static function sweepRetention(): int
    {
        $days = \App\Config\Config::i()->getInt('TRASH_RETENTION_DAYS', 30);
        if ($days <= 0) {
            return 0;
        }
        $db = Database::i();
        $rows = $db->all(
            "SELECT id, user_id FROM trash_items WHERE deleted_at < datetime('now', :d)",
            [':d' => '-' . $days . ' days']
        );
        $n = 0;
        foreach ($rows as $r) {
            try {
                self::purge((int) $r['user_id'], (int) $r['id']);
                $n++;
            } catch (Throwable) {
                // keep sweeping
            }
        }
        return $n;
    }

    private static function freeName(\App\Storage\StorageAdapter $adapter, string $dir, string $name): string
    {
        $candidate = PathGuard::join($dir, $name);
        if (!$adapter->exists($candidate)) {
            return $candidate;
        }
        $dot = strrpos($name, '.');
        $stem = $dot !== false && $dot !== 0 ? substr($name, 0, $dot) : $name;
        $ext = $dot !== false && $dot !== 0 ? substr($name, $dot) : '';
        for ($i = 2; $i < 1000; $i++) {
            $candidate = PathGuard::join($dir, $stem . ' (' . $i . ')' . $ext);
            if (!$adapter->exists($candidate)) {
                return $candidate;
            }
        }
        throw new RuntimeException('No free name to restore');
    }
}
