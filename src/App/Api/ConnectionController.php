<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\AuditService;
use App\Storage\ConnectionConfig;
use App\Storage\ConnectionService;

/**
 * User-facing storage connections.
 *
 * Secrets are write-only from the client's point of view: they are accepted on
 * create, encrypted at rest, and never included in any response, URL or log.
 * The list endpoint enumerates columns explicitly for the same reason.
 */
final class ConnectionController
{
    public static function list(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $rows = ConnectionService::listFor($user);
        // Never expose ciphertext or `extra` (which can carry bucket details).
        $out = array_map(static function (array $r) use ($user): array {
            $owner = $r['owner_user_id'] !== null ? (int) $r['owner_user_id'] : null;
            return [
                'id' => (int) $r['id'],
                'name' => (string) $r['name'],
                'protocol' => (string) $r['protocol'],
                'host' => (string) $r['host'],
                'port' => (int) $r['port'],
                'username' => (string) $r['username'],
                'authType' => (string) $r['auth_type'],
                'verifyTls' => (bool) $r['verify_tls'],
                'owned' => $owner === $user->id,
                'shared' => $owner === null,
                'manageable' => $owner === $user->id || $user->isAdmin(),
            ];
        }, $rows);
        return Response::ok(['connections' => $out]);
    }

    public static function create(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $r = ConnectionService::create($user->id, $req->json(), false);
        AuditService::log($user, 'connection.create', null, null, null, 'ok', 'own connection', $req->ip(), $req->userAgent());
        return Response::ok($r);
    }

    /** Probe an unsaved configuration, so the form can validate before saving. */
    public static function testDraft(Request $req, SessionManager $session): Response
    {
        Guard::requireUser($session);
        $body = $req->json();
        $protocol = (string) ($body['protocol'] ?? '');
        try {
            // Built from the draft body so the form can validate before saving.
            ConnectionService::probe(ConnectionConfig::fromDraft($body), $protocol);
            return Response::ok(['reachable' => true]);
        } catch (\Throwable $e) {
            return Response::ok(['reachable' => false, 'error' => substr($e->getMessage(), 0, 200)]);
        }
    }

    public static function test(Request $req, SessionManager $session, int $id): Response
    {
        $user = Guard::requireUser($session);
        $row = ConnectionService::find($id);
        if ($row === null) {
            throw new \RuntimeException('Connection not found', 404);
        }
        $owner = $row['owner_user_id'] !== null ? (int) $row['owner_user_id'] : null;
        if (!$user->isAdmin() && $owner !== $user->id && $owner !== null) {
            throw new \RuntimeException('You do not have permission to test this connection', 403);
        }
        try {
            ConnectionService::probe(ConnectionConfig::fromRow($row), (string) $row['protocol']);
            return Response::ok(['reachable' => true]);
        } catch (\Throwable $e) {
            // Sanitised: the message never contains the secret.
            return Response::ok(['reachable' => false, 'error' => substr($e->getMessage(), 0, 200)]);
        }
    }

    public static function delete(Request $req, SessionManager $session, int $id): Response
    {
        $user = Guard::requireUser($session);
        ConnectionService::delete($user, $id);
        return Response::ok(['deleted' => true]);
    }
}
