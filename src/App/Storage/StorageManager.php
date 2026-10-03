<?php

declare(strict_types=1);

namespace App\Storage;

use App\Auth\AuthContext;
use App\Config\Config;
use App\Core\Database;
use App\Storage\Adapters\FtpAdapter;
use App\Storage\Adapters\HttpAdapter;
use App\Storage\Adapters\LocalAdapter;
use App\Storage\Adapters\SftpAdapter;
use App\Storage\Adapters\SmbAdapter;
use App\Support\PathGuard;
use RuntimeException;

/**
 * Resolves mounts for users and builds adapters.
 * This is the single place where user→mount authorization is decided.
 */
final class StorageManager
{
    /** @return array<int, Mount> mounts visible to this user */
    public static function mountsFor(AuthContext $user): array
    {
        $db = Database::i();
        $rows = $db->all(
            'SELECT m.*, g.can_write AS grant_write
             FROM mounts m
             LEFT JOIN mount_grants g ON g.mount_id = m.id AND g.user_id = :uid
             WHERE m.is_visible_all = 1 OR g.user_id IS NOT NULL
             ORDER BY m.name',
            [':uid' => $user->id]
        );

        $mounts = [];
        foreach ($rows as $row) {
            $grant = $row['grant_write'] !== null
                ? ['can_write' => (bool) $row['grant_write']]
                : ['can_write' => true];
            $mounts[] = Mount::fromRow($row, $grant);
        }
        return $mounts;
    }

    public static function mountFor(AuthContext $user, string $mountName): Mount
    {
        $db = Database::i();
        $row = $db->one(
            'SELECT m.*, g.can_write AS grant_write
             FROM mounts m
             LEFT JOIN mount_grants g ON g.mount_id = m.id AND g.user_id = :uid
             WHERE m.name = :name AND (m.is_visible_all = 1 OR g.user_id IS NOT NULL)',
            [':uid' => $user->id, ':name' => $mountName]
        );
        if ($row === null) {
            throw new RuntimeException('Mount not found or access denied', 404);
        }
        $grant = $row['grant_write'] !== null
            ? ['can_write' => (bool) $row['grant_write']]
            : ['can_write' => true];
        return Mount::fromRow($row, $grant);
    }

    public static function adapterFor(Mount $mount): StorageAdapter
    {
        return match ($mount->adapter) {
            'local' => self::localAdapter($mount),
            'ftp', 'ftps' => new FtpAdapter(ConnectionService::decryptForAdapter($mount), $mount->readOnly),
            'sftp' => new SftpAdapter(ConnectionService::decryptForAdapter($mount), $mount->readOnly),
            'smb' => new SmbAdapter(ConnectionService::decryptForAdapter($mount), $mount->readOnly),
            'http' => new HttpAdapter(ConnectionService::decryptForAdapter($mount), $mount->readOnly),
            default => throw new RuntimeException('Unknown adapter: ' . $mount->adapter),
        };
    }

    private static function localAdapter(Mount $mount): StorageAdapter
    {
        $root = $mount->localRoot;
        if ($root === null || $root === '') {
            // default mount root layout: <storageRoot>/<mountName>
            $root = Config::i()->storageRoot() . '/' . $mount->name;
        }
        if (!is_dir($root)) {
            @mkdir($root, 0770, true);
        }
        $real = realpath($root);
        if ($real === false) {
            throw new RuntimeException('Local mount root missing: ' . $mount->name);
        }

        // Wrap local mounts so file contents are encrypted at rest. When MIME
        // sniffing is disabled here the wrapper supplies it from the encryption
        // header (ciphertext sniffs as garbage).
        if (Config::i()->encryptLocalEnabled()) {
            return new EncryptedAdapter(new LocalAdapter($real, $mount->readOnly, false));
        }
        return new LocalAdapter($real, $mount->readOnly);
    }

    /**
     * Combined guard used by FileService:
     * resolve mount + validate path + produce [mount, adapter, normalizedPath].
     * @return array{0: Mount, 1: StorageAdapter, 2: string}
     */
    public static function resolve(AuthContext $user, string $mountName, string $path): array
    {
        $mount = self::mountFor($user, $mountName);
        $normalized = PathGuard::normalize($path);
        return [$mount, self::adapterFor($mount), $normalized];
    }
}
