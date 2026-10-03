<?php

declare(strict_types=1);

namespace App\Storage;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Support\Crypto;
use App\Support\SsrfGuard;
use App\Support\Validator;
use RuntimeException;

/**
 * DB access to saved connections — decrypt-on-demand.
 *
 * Also owns creation and probing so the admin surface and the user-facing
 * surface behave identically: one place decides how a protocol is described,
 * what a probe does, and — importantly — how secrets are stored.
 */
final class ConnectionService
{
    /**
     * Build a decrypted ConnectionConfig for a mount.
     * Local mounts never come through here.
     */
    public static function decryptForAdapter(Mount $mount): ConnectionConfig
    {
        if ($mount->connectionId === null) {
            throw new RuntimeException('Mount has no remote connection configured');
        }
        $row = Database::i()->one(
            'SELECT * FROM connections WHERE id = :id',
            [':id' => $mount->connectionId]
        );
        if ($row === null) {
            throw new RuntimeException('Connection not found', 404);
        }
        return ConnectionConfig::fromRow($row);
    }

    public static function defaultPort(string $protocol): int
    {
        return match ($protocol) {
            'ftp' => 21,
            'ftps' => 21,
            'sftp' => 22,
            'smb' => 445,
            'http' => 80,
            's3' => 443,
            default => 0,
        };
    }

    /**
     * Create a connection.
     *
     * Secrets are encrypted with AES-256-GCM before they touch the database and
     * are never returned. `$ownerId` scopes the row: NULL makes it an
     * admin-managed connection usable by shared drives.
     *
     * @param array<string,mixed> $body
     */
    public static function create(?int $ownerId, array $body, bool $allowShared): array
    {
        $name = mb_substr(trim((string) ($body['name'] ?? '')), 0, 120);
        if ($name === '') {
            throw new RuntimeException('Connection name required');
        }
        $protocol = Validator::protocol((string) ($body['protocol'] ?? ''));

        if ($protocol === 's3') {
            return self::createS3($ownerId, $name, $body);
        }

        $host = Validator::host((string) ($body['host'] ?? ''));
        $port = Validator::int($body['port'] ?? self::defaultPort($protocol), 1, 65535, 'port');
        $username = mb_substr(trim((string) ($body['username'] ?? '')), 0, 190);
        $authType = in_array($body['authType'] ?? 'password', ['password', 'key', 'none'], true)
            ? (string) ($body['authType'] ?? 'password') : 'password';

        SsrfGuard::validateHost($host);

        $secret = (string) ($body['secret'] ?? '');
        $passphrase = (string) ($body['passphrase'] ?? '');
        if ($authType !== 'none' && $secret === '') {
            throw new RuntimeException('Secret (password or private key) required');
        }

        $db = Database::i();
        self::assertNameFree($db, $name, $ownerId, $allowShared);

        $db->run(
            'INSERT INTO connections (name, protocol, host, port, username, auth_type, secret_enc, passphrase_enc,
                                      remote_base, extra, verify_tls, created_by, owner_user_id)
             VALUES (:n,:p,:h,:po,:u,:a,:s,:pp,:rb,:ex,:vt,:cb,:ow)',
            [
                ':n' => $name, ':p' => $protocol, ':h' => $host, ':po' => $port, ':u' => $username,
                ':a' => $authType,
                ':s' => $secret !== '' ? Crypto::encrypt($secret) : null,
                ':pp' => $passphrase !== '' ? Crypto::encrypt($passphrase) : null,
                ':rb' => (string) ($body['remoteBase'] ?? '/'),
                ':ex' => json_encode([
                    'passive' => Validator::bool($body['passive'] ?? true),
                    'share' => (string) ($body['share'] ?? ''),
                    'domain' => (string) ($body['domain'] ?? ''),
                ], JSON_UNESCAPED_UNICODE) ?: '{}',
                ':vt' => Validator::bool($body['verifyTls'] ?? true) ? 1 : 0,
                ':cb' => $ownerId,
                ':ow' => $ownerId,
            ]
        );
        return ['id' => (int) $db->scalar('SELECT id FROM connections WHERE name = :n AND owner_user_id IS :ow', [':n' => $name, ':ow' => $ownerId])];
    }

    /** @param array<string,mixed> $body */
    private static function createS3(?int $ownerId, string $name, array $body): array
    {
        $endpoint = trim((string) ($body['endpoint'] ?? $body['host'] ?? ''));
        if ($endpoint === '') {
            throw new RuntimeException('Endpoint is required for S3-compatible storage');
        }
        // Accept a full URL or a bare host.
        if (preg_match('~^https?://~i', $endpoint) === 1) {
            $parts = parse_url($endpoint);
            $host = (string) ($parts['host'] ?? '');
            $scheme = strtolower((string) ($parts['scheme'] ?? 'https'));
            $port = isset($parts['port']) ? (int) $parts['port'] : ($scheme === 'http' ? 80 : 443);
        } else {
            $host = $endpoint;
            $port = self::defaultPort('s3');
        }
        $host = trim($host, '/');
        if ($host === '') {
            throw new RuntimeException('Endpoint is required for S3-compatible storage');
        }
        SsrfGuard::validateHost($host);

        $bucket = trim((string) ($body['bucket'] ?? ''));
        if ($bucket === '') {
            throw new RuntimeException('Bucket is required');
        }
        $region = trim((string) ($body['region'] ?? '')) ?: 'us-east-1';
        $accessKey = trim((string) ($body['accessKeyId'] ?? $body['username'] ?? ''));
        $secretKey = (string) ($body['secretAccessKey'] ?? $body['secret'] ?? '');
        if ($accessKey === '' || $secretKey === '') {
            throw new RuntimeException('Access key ID and secret access key are required');
        }
        // R2 and MinIO only serve path-style requests; AWS prefers virtual-host.
        $pathStyle = array_key_exists('pathStyle', $body)
            ? Validator::bool($body['pathStyle'])
            : (bool) preg_match('/\.r2\.cloudflarestorage\.com$|^localhost|^127\./i', $host);

        $db = Database::i();
        self::assertNameFree($db, $name, $ownerId, true);

        $db->run(
            'INSERT INTO connections (name, protocol, host, port, username, auth_type, secret_enc, passphrase_enc,
                                      remote_base, extra, verify_tls, created_by, owner_user_id)
             VALUES (:n,:p,:h,:po,:u,:a,:s,:pp,:rb,:ex,:vt,:cb,:ow)',
            [
                ':n' => $name,
                ':p' => 's3',
                ':h' => $host,
                ':po' => $port > 0 ? $port : 443,
                ':u' => $accessKey,
                ':a' => 'key',
                // The secret key is encrypted at rest, exactly like any other credential.
                ':s' => Crypto::encrypt($secretKey),
                ':pp' => null,
                ':rb' => '/',
                ':ex' => json_encode([
                    'bucket' => $bucket,
                    'region' => $region,
                    'path_style' => $pathStyle,
                ], JSON_UNESCAPED_UNICODE) ?: '{}',
                ':vt' => Validator::bool($body['verifyTls'] ?? true) ? 1 : 0,
                ':cb' => $ownerId,
                ':ow' => $ownerId,
            ]
        );
        return ['id' => (int) $db->scalar('SELECT id FROM connections WHERE name = :n AND owner_user_id IS :ow', [':n' => $name, ':ow' => $ownerId])];
    }

    /** Connection names are unique per owner, so two users can both have "My S3". */
    private static function assertNameFree(Database $db, string $name, ?int $ownerId, bool $allowShared): void
    {
        $sql = 'SELECT id FROM connections WHERE name = :n AND owner_user_id IS ' . ($ownerId === null ? 'NULL' : ':ow');
        $params = [':n' => $name];
        if ($ownerId !== null) {
            $params[':ow'] = $ownerId;
        }
        if ($db->one($sql, $params) !== null) {
            throw new RuntimeException('You already have a connection with that name');
        }
    }

    /** Connectivity probe. Never echoes secrets; the message is sanitised. */
    public static function probe(ConnectionConfig $cfg, string $protocol): void
    {
        switch ($protocol) {
            case 'ftp':
            case 'ftps':
                Adapters\FtpAdapter::probe($cfg);
                return;
            case 'sftp':
                Adapters\SftpAdapter::probe($cfg);
                return;
            case 's3':
                $r = Adapters\S3Adapter::probe($cfg);
                if (!($r['reachable'] ?? false)) {
                    throw new RuntimeException((string) ($r['error'] ?? 'Connection failed'));
                }
                return;
            default:
                throw new RuntimeException('Connection test is not available for this type yet');
        }
    }

    /**
     * Connections this user may use: their own, plus admin-managed (shared) ones.
     *
     * @return array<int, array<string,mixed>>
     */
    public static function listFor(AuthContext $user): array
    {
        return Database::i()->all(
            'SELECT id, name, protocol, host, port, username, auth_type, remote_base, host_fingerprint,
                    verify_tls, owner_user_id, created_at
             FROM connections
             WHERE owner_user_id = :uid OR owner_user_id IS NULL
             ORDER BY name',
            [':uid' => $user->id]
        );
    }

    /** A user may only delete a connection they own; admins may delete any. */
    public static function delete(AuthContext $user, int $id): void
    {
        $db = Database::i();
        $row = $db->one('SELECT id, owner_user_id FROM connections WHERE id = :id', [':id' => $id]);
        if ($row === null) {
            throw new RuntimeException('Connection not found', 404);
        }
        $owner = $row['owner_user_id'] !== null ? (int) $row['owner_user_id'] : null;
        if (!$user->isAdmin() && $owner !== $user->id) {
            throw new RuntimeException('You do not have permission to delete this connection', 403);
        }
        // Mounts referencing it keep working as "no connection" (SET NULL), and
        // no remote data is touched.
        $db->run('DELETE FROM connections WHERE id = :id', [':id' => $id]);
    }

    /** @return array<string,mixed> the raw row, for a permission check */
    public static function find(int $id): ?array
    {
        return Database::i()->one('SELECT * FROM connections WHERE id = :id', [':id' => $id]);
    }
}
