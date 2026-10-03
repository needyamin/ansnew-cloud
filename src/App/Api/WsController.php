<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Auth\Tickets;
use App\Core\Request;
use App\Core\Response;

/**
 * Mints one-time WebSocket tickets (60 s TTL) bound to the session user.
 */
final class WsController
{
    public static function ticket(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->isJson() ? $req->json() : [];
        $channel = in_array($body['channel'] ?? 'events', ['events', 'terminal'], true)
            ? (string) ($body['channel'] ?? 'events') : 'events';
        $scope = '';
        if ($channel === 'terminal') {
            // scope = connection id the user wants a terminal on; validated
            // server-side again during terminal-auth.
            $scope = (string) ($body['connectionId'] ?? '');
        }
        $ticket = Tickets::mint($user->id, $channel, $scope);
        return Response::ok(['ticket' => $ticket, 'channel' => $channel, 'ttl' => 60]);
    }
}