<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\JobService;
use App\Services\NotifyService;
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
        // The original location is only known after the fact, so invalidate the
        // whole mount rather than guessing a directory.
        NotifyService::fsChanged($user->id, [$mount => ['/']], 'trash-restore');
        return Response::ok($r);
    }

    public static function purge(Request $req, SessionManager $session, string $mount): Response
    {
        // Purging is the point of no return for something already in the trash.
        $gated = \App\Auth\SensitiveGate::guard($session, 'trash.empty');
        if ($gated !== null) {
            return $gated;
        }

        $user = Guard::requireUser($session);
        $body = $req->json();
        TrashService::purge($user->id, (int) ($body['id'] ?? 0));
        NotifyService::fsChanged($user->id, [$mount => ['/']], 'trash-purge');
        return Response::ok(['purged' => true]);
    }

    public static function empty(Request $req, SessionManager $session, string $mount): Response
    {
        // Emptying the trash destroys everything the user had as a safety net.
        $gated = \App\Auth\SensitiveGate::guard($session, 'trash.empty');
        if ($gated !== null) {
            return $gated;
        }

        $user = Guard::requireUser($session);
        $count = TrashService::emptyForUser($user->id, $mount);
        NotifyService::fsChanged($user->id, [$mount => ['/']], 'trash-empty');
        return Response::ok(['purged' => $count]);
    }
}