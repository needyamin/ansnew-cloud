<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\JobService;
use App\Services\JobService as JobSvc;
use RuntimeException;

final class JobController
{
    public static function list(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $limit = (int) $req->query('limit', 50);
        return Response::ok(['jobs' => JobSvc::listFor($user->id, $limit)]);
    }

    public static function cancel(Request $req, SessionManager $session, string $id): Response
    {
        $user = Guard::requireUser($session);
        JobSvc::cancel($id, $user->id);
        return Response::ok(['canceled' => true]);
    }
}