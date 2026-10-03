<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Storage\StorageManager;
use App\Support\PathGuard;
use RuntimeException;

/**
 * Per-user favorites (bookmarks) and recent-files history.
 */
final class FavoritesService
{
    public static function addFavorite(AuthContext $user, string $mount, string $path, string $label = ''): array
    {
        $mount = \App\Support\Validator::mountName($mount);
        $path = PathGuard::normalize($path);
        // Must be a mount the user can actually see.
        StorageManager::mountFor($user, $mount);
        $label = mb_substr(trim($label), 0, 120);
        Database::i()->run(
            'INSERT INTO favorites (user_id, mount, path, label) VALUES (:u,:m,:p,:l)
             ON CONFLICT(user_id, mount, path) DO UPDATE SET label = excluded.label',
            [':u' => $user->id, ':m' => $mount, ':p' => $path, ':l' => $label]
        );
        return ['mount' => $mount, 'path' => $path, 'label' => $label];
    }

    public static function removeFavorite(AuthContext $user, string $mount, string $path): void
    {
        Database::i()->run(
            'DELETE FROM favorites WHERE user_id = :u AND mount = :m AND path = :p',
            [':u' => $user->id, ':m' => $mount, ':p' => PathGuard::normalize($path)]
        );
    }

    /** @return array<int, array<string,mixed>> */
    public static function favorites(AuthContext $user): array
    {
        return Database::i()->all(
            'SELECT mount, path, label, created_at FROM favorites WHERE user_id = :u ORDER BY created_at DESC',
            [':u' => $user->id]
        );
    }

    /** Actions that appear in the Recent list. */
    public const RECENT_ACTIONS = ['open', 'download', 'preview', 'upload', 'create'];

    /**
     * Record (or refresh) a recent entry.
     *
     * Upserted per (user, mount, path) rather than appended: revisiting a file
     * should move it to the top, not fill the list with duplicates of the same
     * path. `modified_at`/`size`/`type` are carried so the Recent view can show
     * useful metadata without re-statting every row.
     */
    public static function recordRecent(
        AuthContext $user,
        string $mount,
        string $path,
        string $name,
        string $action = 'open',
        string $type = 'file',
        int $modifiedAt = 0,
        int $size = 0
    ): void {
        if (!in_array($action, self::RECENT_ACTIONS, true)) {
            return;
        }
        $mount = \App\Support\Validator::mountName($mount);
        // Never let an unreadable mount poison the list.
        StorageManager::mountFor($user, $mount);

        $db = Database::i();
        $db->run(
            'INSERT INTO recent_files (user_id, mount, path, name, action, type, modified_at, size, at)
             VALUES (:u,:m,:p,:n,:a,:t,:mod,:sz, datetime(\'now\'))
             ON CONFLICT(user_id, mount, path) DO UPDATE SET
                name = excluded.name,
                action = excluded.action,
                type = excluded.type,
                modified_at = excluded.modified_at,
                size = excluded.size,
                at = datetime(\'now\')',
            [
                ':u' => $user->id,
                ':m' => $mount,
                ':p' => PathGuard::normalize($path),
                ':n' => mb_substr($name, 0, 255),
                ':a' => $action,
                ':t' => $type === 'dir' ? 'dir' : 'file',
                ':mod' => max(0, $modifiedAt),
                ':sz' => max(0, $size),
            ]
        );
        // Keep the rolling window bounded (latest 200 rows per user).
        $db->run(
            'DELETE FROM recent_files WHERE user_id = :u AND id NOT IN (
                SELECT id FROM recent_files WHERE user_id = :u ORDER BY at DESC, id DESC LIMIT 200)',
            [':u' => $user->id]
        );
    }

    /** @return array<int, array<string,mixed>> */
    public static function recent(AuthContext $user, int $limit = 30): array
    {
        return Database::i()->all(
            'SELECT mount, path, name, action, type, modified_at, size, at FROM recent_files
             WHERE user_id = :u ORDER BY at DESC, id DESC LIMIT ' . max(1, min(100, $limit)),
            [':u' => $user->id]
        );
    }

    /** Drop one entry, or the whole list when `$path` is null. */
    public static function clearRecent(AuthContext $user, ?string $mount = null, ?string $path = null): int
    {
        $db = Database::i();
        if ($mount === null || $path === null) {
            $stmt = $db->run('DELETE FROM recent_files WHERE user_id = :u', [':u' => $user->id]);
            return $stmt->rowCount();
        }
        $stmt = $db->run(
            'DELETE FROM recent_files WHERE user_id = :u AND mount = :m AND path = :p',
            [':u' => $user->id, ':m' => $mount, ':p' => PathGuard::normalize($path)]
        );
        return $stmt->rowCount();
    }
}
