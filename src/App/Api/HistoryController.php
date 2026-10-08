<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\HistoryService;
use RuntimeException;

/**
 * Undo / Redo over file operations.
 *
 * The client records each completed operation here, then asks for it to be
 * reversed or repeated. Keeping the stack on the server means history survives
 * a reload and behaves the same in every tab.
 */
final class HistoryController
{
    public static function index(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $limit = (int) $req->query('limit', '40');
        return Response::ok(HistoryService::list($user, $limit));
    }

    /**
     * POST /api/history
     * {op: move|copy|rename|delete|mkdir, mount, summary, payload:{...}}
     */
    public static function record(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $op = (string) ($body['op'] ?? '');
        $payload = is_array($body['payload'] ?? null) ? $body['payload'] : [];
        $id = HistoryService::record(
            $user,
            $op,
            (string) ($body['mount'] ?? ''),
            (string) ($body['summary'] ?? ''),
            $payload
        );
        return Response::ok(['id' => $id, 'recorded' => $id > 0]);
    }

    /** POST /api/history/undo  {id?} — defaults to the newest step. */
    public static function undo(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        try {
            $r = HistoryService::undo($user, self::stepId($body));
        } catch (RuntimeException $e) {
            return Response::error($e->getMessage(), $e->getCode() === 404 ? 404 : 409, 'undo_failed');
        }
        return Response::ok($r);
    }

    /** POST /api/history/redo  {id?} */
    public static function redo(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        try {
            $r = HistoryService::redo($user, self::stepId($body));
        } catch (RuntimeException $e) {
            return Response::error($e->getMessage(), $e->getCode() === 404 ? 404 : 409, 'redo_failed');
        }
        return Response::ok($r);
    }

    public static function clear(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        HistoryService::clear($user);
        return Response::ok(['cleared' => true]);
    }

    /** @param array<string,mixed> $body */
    private static function stepId(array $body): ?int
    {
        $id = $body['id'] ?? null;
        return is_numeric($id) ? (int) $id : null;
    }
}
