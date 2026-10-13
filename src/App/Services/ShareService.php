<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Storage\StorageManager;
use App\Support\Crypto;
use App\Support\PathGuard;
use InvalidArgumentException;
use RuntimeException;

/**
 * Share links for files and folders.
 *
 * The public token is the only credential: it is long and random, and it is
 * stored **hashed** (SHA-256) so a database leak yields no usable links, and
 * **encrypted** alongside it so the owner can be shown their own link again
 * without it ever being recoverable by an attacker.
 *
 * A share points at a folder or a file. Folder shares expose that subtree
 * read-only; nothing outside the shared path is reachable, and nothing can be
 * written. Revoking deletes the row — the token stops working immediately.
 */
final class ShareService
{
    /** Token entropy in bytes → 43 base64url characters. */
    private const TOKEN_BYTES = 32;

    /** Cookie holding the post-password access grant for public share pages. */
    private const GRANT_COOKIE = 'ansnew_sg';

    /** How long a link may live, in days, regardless of what was asked for. */
    private const MAX_EXPIRY_DAYS = 365;

    /** @return array<int, array<string,mixed>> */
    public static function listFor(int $userId): array
    {
        $rows = Database::i()->all(
            'SELECT id, mount, path, name, is_dir, expires_at, allow_download, revoked_at,
                    access_count, last_access_at, created_at
             FROM shares WHERE user_id = :u ORDER BY created_at DESC',
            [':u' => $userId]
        );
        $now = time();
        foreach ($rows as &$r) {
            // Surface the effective state rather than making the UI recompute it.
            $r['is_dir'] = (bool) $r['is_dir'];
            $r['allow_download'] = (bool) $r['allow_download'];
            $r['revoked'] = $r['revoked_at'] !== null;
            $r['expired'] = $r['expires_at'] !== null && strtotime((string) $r['expires_at']) < $now;
            $r['active'] = !$r['revoked'] && !$r['expired'];
            unset($r['revoked_at']);
        }
        return $rows;
    }

    /**
     * Create a share link.
     *
     * @param array<string,mixed> $opts password (string, optional), expiresDays (int, optional),
     *                                  allowDownload (bool, default true)
     * @return array<string,mixed> the row plus `token` and `url`, both shown once
     */
    public static function create(AuthContext $user, string $mount, string $path, array $opts = []): array
    {
        // Must be something this user can actually read, or this is a
        // privilege-escalation primitive.
        [, $adapter, $norm] = StorageManager::resolve($user, $mount, $path);
        $stat = $adapter->stat($norm);
        $isDir = $stat['type'] === 'dir';

        $expiresDays = isset($opts['expiresDays']) ? max(0, (int) $opts['expiresDays']) : 0;
        if ($expiresDays > self::MAX_EXPIRY_DAYS) {
            throw new InvalidArgumentException('A share link can last at most ' . self::MAX_EXPIRY_DAYS . ' days');
        }
        $allowDownload = array_key_exists('allowDownload', $opts)
            ? (bool) $opts['allowDownload']
            : true;

        $password = (string) ($opts['password'] ?? '');
        if ($password !== '' && strlen($password) < 6) {
            throw new InvalidArgumentException('A share password must be at least 6 characters');
        }

        $token = self::mintToken();
        $db = Database::i();
        $db->run(
            'INSERT INTO shares (token_hash, token_enc, user_id, mount, path, name, is_dir,
                                 password_hash, expires_at, allow_download)
             VALUES (:th,:te,:u,:m,:p,:n,:d,:ph,:ex,:ad)',
            [
                ':th' => self::hashToken($token),
                ':te' => Crypto::encrypt($token),
                ':u' => $user->id,
                ':m' => $mount,
                ':p' => $norm,
                ':n' => (string) $stat['name'],
                ':d' => $isDir ? 1 : 0,
                ':ph' => $password !== '' ? password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]) : null,
                ':ex' => $expiresDays > 0 ? gmdate('Y-m-d H:i:s', time() + $expiresDays * 86400) : null,
                ':ad' => $allowDownload ? 1 : 0,
            ]
        );
        $id = (int) $db->scalar('SELECT id FROM shares WHERE token_hash = :h', [':h' => self::hashToken($token)]);

        return [
            'id' => $id,
            'token' => $token,          // shown once in the response; hashed at rest
            'mount' => $mount,
            'path' => $norm,
            'name' => (string) $stat['name'],
            'isDir' => $isDir,
            'expiresAt' => $expiresDays > 0 ? gmdate('c', time() + $expiresDays * 86400) : null,
            'allowDownload' => $allowDownload,
        ];
    }

    /** Kill a link. The row goes away, so the token stops resolving immediately. */
    public static function revoke(AuthContext $user, int $id): void
    {
        $share = self::ownedShare($user, $id);
        Database::i()->run('DELETE FROM shares WHERE id = :id', [':id' => $id]);
    }

    /**
     * Remove every share link the user owns at once. Mirrors
     * FavoritesService::clearFavorites — bulk, irreversible, so the caller
     * (controller) gates it behind a password re-entry.
     */
    public static function clearAll(AuthContext $user): int
    {
        $stmt = Database::i()->run(
            'DELETE FROM shares WHERE user_id = :u',
            [':u' => $user->id]
        );
        return $stmt->rowCount();
    }

    /** Issue a fresh token for the same target, invalidating the old one. */
    public static function rotate(AuthContext $user, int $id): array
    {
        $share = self::ownedShare($user, $id);
        $token = self::mintToken();
        Database::i()->run(
            'UPDATE shares SET token_hash = :h, token_enc = :e, access_count = 0 WHERE id = :id',
            [':h' => self::hashToken($token), ':e' => Crypto::encrypt($token), ':id' => $id]
        );
        return ['id' => $id, 'token' => $token];
    }

    /**
     * Resolve a public token to an active share, or null.
     *
     * @return array<string,mixed>|null
     */
    public static function resolve(string $token): ?array
    {
        $token = trim($token);
        if ($token === '' || strlen($token) < 20 || strlen($token) > 128) {
            return null;
        }
        $row = Database::i()->one(
            'SELECT * FROM shares WHERE token_hash = :h',
            [':h' => self::hashToken($token)]
        );
        if ($row === null) {
            return null;
        }
        if ($row['revoked_at'] !== null) {
            return null;
        }
        if ($row['expires_at'] !== null && strtotime((string) $row['expires_at']) < time()) {
            return null;
        }
        return $row;
    }

    /**
     * True when the share is password-protected and the visitor has not
     * proven access — neither by submitting the password in this request
     * nor by holding a valid access grant cookie.
     */
    public static function passwordRequired(array $share, ?string $provided, ?string $grant = null): bool
    {
        if ($share['password_hash'] === null || $share['password_hash'] === '') {
            return false;
        }
        if ($grant !== null && self::grantValid($share, $grant)) {
            return false;
        }
        if ($provided === null || $provided === '') {
            return true;
        }
        return !password_verify($provided, (string) $share['password_hash']);
    }

    /**
     * Issue an access grant after a correct password entry, so the password
     * never has to appear again in a URL (logs, referrers, history). The
     * grant is an opaque random token; the DB key is its SHA-256 and the
     * row is bound to the share id + APP_KEY signature. HttpOnly cookie.
     */
    public static function issueGrant(array $share): void
    {
        $token = bin2hex(random_bytes(24));
        $payload = json_encode([
            'share' => (int) $share['id'],
            'sig' => hash_hmac('sha256', 'share-grant:' . (int) $share['id'], self::grantKey()),
            'at' => time(),
        ], JSON_THROW_ON_ERROR);
        $db = Database::i();
        $db->run(
            'INSERT INTO settings (k, v) VALUES (:k, :v)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v',
            [':k' => 'share_grant:' . hash('sha256', $token), ':v' => $payload]
        );
        // Housekeeping: drop grants older than 24h.
        $db->run("DELETE FROM settings WHERE k LIKE 'share_grant:%' AND CAST(json_extract(v, '$.at') AS INTEGER) < :c", [':c' => time() - 86400]);
        setcookie(self::GRANT_COOKIE, $token, [
            'expires' => time() + 43200,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure' => (\App\Config\Config::i()->get('SESSION_SECURE_COOKIE', 'false') === 'true'),
        ]);
    }

    private static function grantValid(array $share, string $grant): bool
    {
        if (strlen($grant) !== 48) {
            return false;
        }
        $row = Database::i()->one(
            'SELECT v FROM settings WHERE k = :k',
            [':k' => 'share_grant:' . hash('sha256', $grant)]
        );
        if ($row === null) {
            return false;
        }
        $data = json_decode((string) $row['v'], true);
        if (!is_array($data) || (int) ($data['share'] ?? 0) !== (int) $share['id']) {
            return false;
        }
        $expected = hash_hmac('sha256', 'share-grant:' . (int) $share['id'], self::grantKey());
        if (!is_string($data['sig'] ?? null) || !hash_equals($expected, (string) $data['sig'])) {
            return false;
        }
        return (int) ($data['at'] ?? 0) > time() - 43200;
    }

    private static function grantKey(): string
    {
        return (string) \App\Config\Config::i()->get('APP_KEY', 'ansnew-share-grant');
    }

    public static function recordAccess(int $id): void
    {
        Database::i()->run(
            "UPDATE shares SET access_count = access_count + 1, last_access_at = datetime('now') WHERE id = :id",
            [':id' => $id]
        );
    }

    /**
     * The adapter + path for a shared target, rejecting anything that escapes it.
     *
     * @return array{0:\App\Storage\StorageAdapter,1:string,2:string} adapter, resolved path, share name
     */
    public static function scopeFor(array $share, string $subPath = ''): array
    {
        $base = (string) $share['path'];
        $target = $subPath === '' ? $base : PathGuard::join($base, $subPath);
        // The resolved path must still sit inside the shared folder. This is what
        // stops "/s/<token>/download?path=../../etc/passwd".
        if ($target !== $base && !str_starts_with($target, rtrim($base, '/') . '/')) {
            throw new RuntimeException('Path is outside the shared folder', 403);
        }
        $mount = Database::i()->one('SELECT * FROM mounts WHERE name = :n', [':n' => (string) $share['mount']]);
        if ($mount === null) {
            throw new RuntimeException('The storage behind this link is no longer available', 404);
        }
        $adapter = StorageManager::adapterFor(\App\Storage\Mount::fromRow($mount, null));
        $resolved = $adapter->exists($target) ? $target : $target;
        return [$adapter, $resolved, (string) $share['name']];
    }

    /** @return array<string,mixed> */
    private static function ownedShare(AuthContext $user, int $id): array
    {
        $row = Database::i()->one('SELECT * FROM shares WHERE id = :id', [':id' => $id]);
        if ($row === null) {
            throw new RuntimeException('Share not found', 404);
        }
        if ((int) $row['user_id'] !== $user->id && !$user->isAdmin()) {
            throw new RuntimeException('You do not have permission to manage this share', 403);
        }
        return $row;
    }

    private static function mintToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(self::TOKEN_BYTES)), '+/', '-_'), '=');
    }

    private static function hashToken(string $token): string
    {
        return hash('sha256', $token);
    }
}
