<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Tickets;
use App\Config\Config;
use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Core\Router;
use App\Storage\StorageManager;
use App\Storage\ConnectionService;
use RuntimeException;

/**
 * Internal endpoints for the WebSocket service (compose network only).
 * Every call must carry X-Internal-Secret matching WS_SECRET; the Kernel
 * skips CSRF/origin checks only when that header is valid.
 */
final class InternalController
{
    private static function assertSecret(Request $req): void
    {
        $given = (string) ($req->header('x-internal-secret') ?? '');
        if ($given === '' || !hash_equals(Config::i()->wsSecret(), $given)) {
            throw new RuntimeException('Internal authentication failed', 403);
        }
    }

    /** Consume a WS ticket: returns the bound user id + channel, or 404. */
    public static function consumeTicket(Request $req): Response
    {
        self::assertSecret($req);
        $body = $req->json();
        $info = Tickets::consume((string) ($body['ticket'] ?? ''), (string) ($body['channel'] ?? 'events'));
        if ($info === null) {
            return Response::error('Ticket invalid or expired', 404, 'not_found');
        }
        return Response::ok($info);
    }

    /**
     * Terminal authorization + credential handoff (server-to-server only).
     * Confirms the user may open an SSH terminal on the given connection and
     * hands the decrypted secret to the WS process over the internal network.
     */
    public static function terminalAuth(Request $req): Response
    {
        self::assertSecret($req);
        $body = $req->json();
        $userId = (int) ($body['userId'] ?? 0);
        $connectionId = (int) ($body['connectionId'] ?? 0);

        $db = Database::i();
        $row = $db->one('SELECT id, username, role FROM users WHERE id = :id AND is_active = 1', [':id' => $userId]);
        if ($row === null) {
            return Response::error('User not found', 404, 'not_found');
        }

        // Only admins may open terminals (conservative default).
        if ((string) $row['role'] !== 'admin') {
            return Response::error('Terminal access denied', 403, 'denied');
        }

        $conn = $db->one('SELECT id, protocol, host, port FROM connections WHERE id = :id', [':id' => $connectionId]);
        if ($conn === null || (string) $conn['protocol'] !== 'sftp') {
            return Response::error('Connection not found or not SSH', 404, 'not_found');
        }

        $cfg = ConnectionService::decryptForAdapter(new \App\Storage\Mount(
            0, 'tmp', 'tmp', 'sftp', null, $connectionId, '/', 0, false, false, false
        ));

        return Response::ok([
            'host' => $cfg->host,
            'port' => $cfg->port,
            'username' => $cfg->username,
            'authType' => $cfg->authType,
            'secret' => $cfg->secret,
            'passphrase' => $cfg->passphrase,
        ]);
    }

    /**
     * Fan-out helper used by the PHP worker to push job progress.
     * The Node WS server POSTs here? No - the worker POSTs to the WS server.
     * This endpoint is the reverse direction: WS -> PHP for ticket checks only.
     * Kept for symmetry / future internal events.
     */
    public static function notify(Request $req): Response
    {
        self::assertSecret($req);
        return Response::ok(['received' => true]);
    }
}