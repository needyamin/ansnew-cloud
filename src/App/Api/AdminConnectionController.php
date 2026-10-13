<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Support\Crypto;
use App\Support\SsrfGuard;
use App\Support\Validator;
use RuntimeException;

/**
 * Admin: saved S3-compatible remote connections (AWS S3, Cloudflare R2,
 * MinIO, Wasabi, B2, …). Secrets are encrypted at rest (AES-256-GCM)
 * and never returned to the browser.
 */
final class AdminConnectionController
{
    public static function list(Request $req, SessionManager $session): Response
    {
        Guard::requireAdmin($session);
        $rows = Database::i()->all(
            'SELECT id, name, protocol, host, port, username, auth_type, remote_base,
                    extra, verify_tls, created_at
             FROM connections ORDER BY name'
        );
        foreach ($rows as &$r) {
            $extra = json_decode((string) ($r['extra'] ?? '{}'), true);
            $r['bucket'] = is_array($extra) ? (string) ($extra['bucket'] ?? '') : '';
            $r['region'] = is_array($extra) ? (string) ($extra['region'] ?? '') : '';
            $r['path_style'] = is_array($extra) ? (bool) ($extra['path_style'] ?? false) : false;
            unset($r['extra']);
        }
        unset($r);
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
        $protocol = Validator::protocol((string) ($body['protocol'] ?? 's3'));

        // Accept a full endpoint URL (https://acct.r2.cloudflarestorage.com,
        // http://minio:9000) or a bare host + port.
        $endpoint = trim((string) ($body['endpoint'] ?? $body['host'] ?? ''));
        if ($endpoint === '') {
            throw new RuntimeException('Endpoint required');
        }
        $host = $endpoint;
        $port = 0;
        if (preg_match('~^https?://~i', $endpoint) === 1) {
            $parts = parse_url($endpoint);
            $host = (string) ($parts['host'] ?? '');
            $port = isset($parts['port']) ? (int) $parts['port'] : (strtolower((string) ($parts['scheme'] ?? 'https')) === 'https' ? 443 : 80);
        } else {
            $port = Validator::int($body['port'] ?? 443, 1, 65535, 'port');
        }
        $host = Validator::host($host);

        // SSRF guard runs at save time: refuse obviously dangerous targets.
        SsrfGuard::validateHost($host);

        $accessKey = mb_substr(trim((string) ($body['accessKeyId'] ?? $body['username'] ?? '')), 0, 190);
        $secret = (string) ($body['secretAccessKey'] ?? $body['secret'] ?? '');
        if ($accessKey === '' || $secret === '') {
            throw new RuntimeException('Access key id and secret access key are required');
        }

        $db = Database::i();
        if ($db->one('SELECT id FROM connections WHERE name = :n', [':n' => $name]) !== null) {
            throw new RuntimeException('Connection name already exists');
        }

        $extra = [
            'bucket' => mb_substr(trim((string) ($body['bucket'] ?? '')), 0, 190),
            'region' => mb_substr(trim((string) ($body['region'] ?? '')) ?: 'us-east-1', 0, 64),
            'path_style' => Validator::bool($body['pathStyle'] ?? false),
        ];
        if ($extra['bucket'] === '') {
            throw new RuntimeException('Bucket required');
        }

        $db->run(
            'INSERT INTO connections (name, protocol, host, port, username, auth_type, secret_enc, passphrase_enc,
                                      remote_base, extra, verify_tls, created_by)
             VALUES (:n,:p,:h,:po,:u,:a,:s,:pp,:rb,:ex,:vt,:cb)',
            [
                ':n' => $name, ':p' => $protocol, ':h' => $host, ':po' => $port, ':u' => $accessKey,
                ':a' => 'password',
                ':s' => Crypto::encrypt($secret),
                ':pp' => null,
                ':rb' => (string) ($body['remoteBase'] ?? '/'),
                ':ex' => json_encode($extra, JSON_UNESCAPED_UNICODE) ?: '{}',
                ':vt' => Validator::bool($body['verifyTls'] ?? true) ? 1 : 0,
                ':cb' => $admin->id,
            ]
        );
        $id = (int) $db->scalar('SELECT id FROM connections WHERE name = :n', [':n' => $name]);
        return Response::ok(['id' => $id]);
    }

    /** Connectivity probe: a real authenticated bucket listing. Never echoes secrets. */
    public static function test(Request $req, SessionManager $session, int $id): Response
    {
        Guard::requireAdmin($session);
        $row = Database::i()->one('SELECT * FROM connections WHERE id = :id', [':id' => $id]);
        if ($row === null) {
            throw new RuntimeException('Connection not found', 404);
        }
        try {
            $cfg = \App\Storage\ConnectionService::decryptForAdapter(new \App\Storage\Mount(
                0, 'tmp', 'tmp', (string) $row['protocol'], null, $id, '/', 0, false, false, false
            ));
            if ((string) $row['protocol'] !== 's3') {
                throw new RuntimeException('Probe not implemented for this protocol');
            }
            // An authenticated ListObjectsV2: proves endpoint, credentials and
            // bucket in one round trip.
            \App\Storage\Adapters\S3Adapter::probe($cfg);
            return Response::ok(['reachable' => true]);
        } catch (\Throwable $e) {
            return Response::ok(['reachable' => false, 'error' => substr($e->getMessage(), 0, 200)]);
        }
    }

    public static function delete(Request $req, SessionManager $session, int $id): Response
    {
        // Removes stored remote credentials and can break every drive built on them.
        $admin = Guard::requireAdmin($session);
        $db = Database::i();
        $row = $db->one('SELECT name FROM connections WHERE id = :id', [':id' => $id]);
        if ($row === null) {
            throw new RuntimeException('Connection not found', 404);
        }
        $db->run('DELETE FROM connections WHERE id = :id', [':id' => $id]);
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