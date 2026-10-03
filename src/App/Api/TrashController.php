<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\JobService;
use App\Services\TrashService;

final class TrashController
{
    public static function list(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        return Response::ok(['items' => TrashService::listTrash($user->id, $mount)]);
    }

    public static function restore(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $r = TrashService::restore($user->id, (int) ($body['id'] ?? 0));
        return Response::ok($r);
    }

    public static function purge(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        TrashService::purge($user->id, (int) ($body['id'] ?? 0));
        return Response::ok(['purged' => true]);
    }

    public static function empty(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $count = TrashService::emptyForUser($user->id, $mount);
        return Response::ok(['purged' => $count]);
    }
}