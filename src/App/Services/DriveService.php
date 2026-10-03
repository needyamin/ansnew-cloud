<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Storage\Mount;
use App\Storage\StorageManager;
use App\Support\Validator;
use InvalidArgumentException;
use RuntimeException;

/**
 * User-facing drive (mount) management.
 *
 * A drive has two names on purpose:
 *   - `label` is the display name the user picks, and can be changed at any time;
 *   - `name`  is the immutable slug the API and the on-disk directory use.
 * Keeping them separate is what lets a drive be renamed without breaking a single
 * stored path, share link or recent entry.
 *
 * Ownership lives in `mounts.owner_user_id`: a non-null owner means a personal
 * drive (only that user, plus admins, can see or manage it). NULL means the
 * drive is admin-managed and shared through `is_visible_all` / `mount_grants`.
 */
final class DriveService
{
    /** Adapter types a user may create for themselves. */
    public const USER_ADAPTERS = ['local', 's3'];

    /**
     * Derive a unique, URL-safe slug from a display name.
     *
     * "Work Drive" -> "work-drive", then "work-drive-2" if that is taken. The
     * slug is what appears in /api/fs/{mount}/... so it must stay in the
     * Validator::mountName() alphabet.
     */
    public static function slugFor(string $label, ?int $ignoreId = null): string
    {
        $base = strtolower(trim($label));
        $base = preg_replace('/[^a-z0-9]+/', '-', $base) ?? '';
        $base = trim($base, '-');
        if ($base === '') {
            $base = 'drive';
        }
        $base = substr($base, 0, 48);
        if (strlen($base) < 2) {
            $base .= '-drive';
        }

        $candidate = $base;
        for ($i = 2; $i < 500; $i++) {
            if (!self::slugTaken($candidate, $ignoreId)) {
                return $candidate;
            }
            $candidate = $base . '-' . $i;
        }
        throw new RuntimeException('Could not allocate a unique drive name');
    }

    private static function slugTaken(string $slug, ?int $ignoreId): bool
    {
        $sql = 'SELECT id FROM mounts WHERE name = :n';
        $params = [':n' => $slug];
        if ($ignoreId !== null) {
            $sql .= ' AND id <> :id';
            $params[':id'] = $ignoreId;
        }
        return Database::i()->one($sql, $params) !== null;
    }

    /**
     * A user may manage a drive they own; admins may manage any drive.
     * Shared (granted) drives are usable but never manageable by the grantee.
     */
    public static function assertManageable(AuthContext $user, Mount $mount): void
    {
        if ($mount->isOwnedBy($user->id) || $user->isAdmin()) {
            return;
        }
        throw new RuntimeException('You do not have permission to manage this drive', 403);
    }

    /**
     * Drives the user can see, annotated for the management UI.
     *
     * @return array<int, array<string,mixed>>
     */
    public static function listFor(AuthContext $user): array
    {
        $out = [];
        foreach (StorageManager::mountsFor($user) as $m) {
            $info = $m->publicInfo();
            $info['owner'] = $m->isOwnedBy($user->id)
                ? 'me'
                : ($m->ownerUserId === null ? 'shared' : 'other');
            $info['manageable'] = $m->isOwnedBy($user->id) || $user->isAdmin();
            $out[] = $info;
        }
        return $out;
    }

    /**
     * Create a personal drive for this user.
     *
     * @param array<string,mixed> $body
     * @return array<string,mixed>
     */
    public static function create(AuthContext $user, array $body): array
    {
        $label = trim((string) ($body['label'] ?? ''));
        if ($label === '') {
            throw new InvalidArgumentException('A drive name is required');
        }
        $label = mb_substr($label, 0, 120);

        $adapter = (string) ($body['adapter'] ?? 'local');
        if (!in_array($adapter, self::USER_ADAPTERS, true)) {
            throw new InvalidArgumentException('Unsupported drive type: ' . $adapter);
        }

        $name = self::slugFor($label);
        $db = Database::i();

        if ($adapter === 'local') {
            $connectionId = null;
            $remotePath = '/';
            $localRoot = null;   // StorageManager resolves <storageRoot>/<name>
        } else {
            $connectionId = Validator::int($body['connectionId'] ?? 0, 1, PHP_INT_MAX, 'connectionId');
            $conn = $db->one('SELECT id, owner_user_id FROM connections WHERE id = :id', [':id' => $connectionId]);
            if ($conn === null) {
                throw new RuntimeException('Connection not found', 404);
            }
            // A user may only attach a connection they own; admins any.
            if (!$user->isAdmin() && (int) ($conn['owner_user_id'] ?? 0) !== $user->id) {
                throw new RuntimeException('You do not have permission to use this connection', 403);
            }
            $localRoot = null;
            $remotePath = (string) ($body['remotePath'] ?? '/');
            if ($remotePath === '') {
                $remotePath = '/';
            }
        }

        $db->run(
            'INSERT INTO mounts (name, label, adapter, local_root, connection_id, remote_path,
                                 quota_bytes, is_readonly, is_visible_all, trash_enabled, created_by, owner_user_id)
             VALUES (:name, :label, :adapter, :root, :conn, :remote,
                     0, 0, 0, 1, :uid, :uid)',
            [
                ':name' => $name,
                ':label' => $label,
                ':adapter' => $adapter,
                ':root' => $localRoot,
                ':conn' => $connectionId,
                ':remote' => $remotePath,
                ':uid' => $user->id,
            ]
        );

        AuditService::log($user, 'drive.create', $name, null, null, 'ok', $adapter, '', '');
        return ['name' => $name, 'label' => $label, 'adapter' => $adapter];
    }

    /** Rename a drive. Only the display name changes — the slug never does. */
    public static function rename(AuthContext $user, int $id, string $label): array
    {
        $mount = self::byId($id);
        self::assertManageable($user, $mount);

        $label = trim($label);
        if ($label === '') {
            throw new InvalidArgumentException('A drive name is required');
        }
        $label = mb_substr($label, 0, 120);

        Database::i()->run('UPDATE mounts SET label = :l WHERE id = :id', [':l' => $label, ':id' => $id]);
        AuditService::log($user, 'drive.rename', $mount->name, null, $label, 'ok', '', '', '');
        return ['id' => $id, 'name' => $mount->name, 'label' => $label];
    }

    /**
     * Disconnect a drive.
     *
     * This removes the mount row only. It never touches the underlying storage:
     * no local directory is deleted, nothing is removed from a remote bucket, and
     * any files stay exactly where they are so the drive can be re-attached.
     */
    public static function disconnect(AuthContext $user, int $id): array
    {
        $mount = self::byId($id);
        self::assertManageable($user, $mount);

        Database::i()->run('DELETE FROM mounts WHERE id = :id', [':id' => $id]);
        AuditService::log($user, 'drive.disconnect', $mount->name, null, null, 'ok', 'row removed only', '', '');
        return ['disconnected' => true, 'name' => $mount->name, 'dataKept' => true];
    }

    public static function byId(int $id): Mount
    {
        $row = Database::i()->one('SELECT * FROM mounts WHERE id = :id', [':id' => $id]);
        if ($row === null) {
            throw new RuntimeException('Drive not found', 404);
        }
        return Mount::fromRow($row, null);
    }
}
