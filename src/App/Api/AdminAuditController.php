<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\AuditService;

final class AdminAuditController
{
    public static function tail(Request $req, SessionManager $session): Response
    {
        $admin = Guard::requireAdmin($session);
        $limit = (int) $req->query('limit', 100);
        $offset = (int) $req->query('offset', 0);
        $userId = $req->query('userId');
        $action = $req->query('action');
        $rows = AuditService::tail(
            $limit,
            $offset,
            $userId !== null && $userId !== '' ? (int) $userId : null,
            $action !== null ? (string) $action : null
        );
        return Response::ok(['entries' => $rows]);
    }
}