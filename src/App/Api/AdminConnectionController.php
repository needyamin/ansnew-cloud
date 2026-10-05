<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\AuditService;
use App\Support\Crypto;
use App\Support\SsrfGuard;
use App\Support\Validator;
use RuntimeException;

/**
 * Admin: saved remote connections (FTP/SFTP/SMB/WebDAV). Secrets are
 * encrypted at rest (AES-256-GCM) and never returned to the browser.
 */
final class AdminConnectionController
{
    public static function list(Request $req, SessionManager $session): Response
    {
        Guard::requireAdmin($session);
        $rows = Database::i()->all(
            'SELECT id, name, protocol, host, port, username, auth_type, remote_base,
                    host_fingerprint, verify_tls, created_at
             FROM connections ORDER BY name'
        );
        return Response::ok(['connections' => $rows]);
    }

    public static function create(Request $req, SessionManager $session): Response
    {
        $admin = Guard::requireAdmin($session);
        $body = $req->json();
        $name = mb_substr(trim((string) ($body['name'] ?? '')), 0, 120);
        if ($name === '') {
            throw new RuntimeException('Connection name required');
        }
        $protocol = Validator::protocol((string) ($body['protocol'] ?? ''));
        $host = Validator::host((string) ($body['host'] ?? ''));
        $port = Validator::int($body['port'] ?? self::defaultPort($protocol), 1, 65535, 'port');
        $username = mb_substr(trim((string) ($body['username'] ?? '')), 0, 190);
        $authType = in_array($body['authType'] ?? 'password', ['password', 'key', 'none'], true)
            ? (string) ($body['authType'] ?? 'password') : 'password';

        // SSRF guard runs at save time: refuse obviously dangerous targets.
        SsrfGuard::validateHost($host);

        $secret = (string) ($body['secret'] ?? '');
        $passphrase = (string) ($body['passphrase'] ?? '');
        if ($authType !== 'none' && $secret === '') {
            throw new RuntimeException('Secret (password or private key) required');
        }

        $db = Database::i();
        if ($db->one('SELECT id FROM connections WHERE name = :n', [':n' => $name]) !== null) {
            throw new RuntimeException('Connection name already exists');
        }

        $db->run(
            'INSERT INTO connections (name, protocol, host, port, username, auth_type, secret_enc, passphrase_enc,
                                      remote_base, extra, verify_tls, created_by)
             VALUES (:n,:p,:h,:po,:u,:a,:s,:pp,:rb,:ex,:vt,:cb)',
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
                ':cb' => $admin->id,
            ]
        );
        $id = (int) $db->scalar('SELECT id FROM connections WHERE name = :n', [':n' => $name]);
        AuditService::log($admin, 'admin.connection_create', null, null, $name, 'ok', $protocol . '://' . $host, $req->ip(), $req->userAgent());
        return Response::ok(['id' => $id]);
    }

    /** Connectivity probe. Never echoes secrets; reports a sanitized error. */
    public static function test(Request $req, SessionManager $session, int $id): Response
    {
        $admin = Guard::requireAdmin($session);
        $row = Database::i()->one('SELECT * FROM connections WHERE id = :id', [':id' => $id]);
        if ($row === null) {
            throw new RuntimeException('Connection not found', 404);
        }
        try {
            $cfg = \App\Storage\ConnectionService::decryptForAdapter(new \App\Storage\Mount(
                0, 'tmp', 'tmp', (string) $row['protocol'], null, $id, '/', 0, false, false, false
            ));
            switch ((string) $row['protocol']) {
                case 'ftp':
                case 'ftps':
                    \App\Storage\Adapters\FtpAdapter::probe($cfg);
                    break;
                case 'sftp':
                    \App\Storage\Adapters\SftpAdapter::probe($cfg);
                    break;
                default:
                    throw new RuntimeException('Probe not implemented for this protocol');
            }
            AuditService::log($admin, 'admin.connection_test', null, null, (string) $row['name'], 'ok', '', $req->ip(), $req->userAgent());
            return Response::ok(['reachable' => true]);
        } catch (\Throwable $e) {
            AuditService::log($admin, 'admin.connection_test', null, null, (string) $row['name'], 'error', substr($e->getMessage(), 0, 200), $req->ip(), $req->userAgent());
            return Response::ok(['reachable' => false, 'error' => substr($e->getMessage(), 0, 200)]);
        }
    }

    public static function delete(Request $req, SessionManager $session, int $id): Response
    {
        // Same rationale as ConnectionController::delete — this removes stored
        // remote credentials and can break every drive built on them.
        $gated = \App\Auth\SensitiveGate::guard($session, 'connection.delete');
        if ($gated !== null) {
            return $gated;
        }

        $admin = Guard::requireAdmin($session);
        $db = Database::i();
        $row = $db->one('SELECT name FROM connections WHERE id = :id', [':id' => $id]);
        if ($row === null) {
            throw new RuntimeException('Connection not found', 404);
        }
        $db->run('DELETE FROM connections WHERE id = :id', [':id' => $id]);
        AuditService::log($admin, 'admin.connection_delete', null, null, (string) $row['name'], 'ok', '', $req->ip(), $req->userAgent());
        return Response::ok(['deleted' => true]);
    }

    private static function defaultPort(string $protocol): int
    {
        return match ($protocol) {
            'ftp' => 21,
            'sftp' => 22,
            'smb' => 445,
            'http' => 80,
            default => 443,
        };
    }
}