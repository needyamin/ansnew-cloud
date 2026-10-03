<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\JobService;
use App\Services\UsageService;

final class UsageController
{
    public static function usage(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        return Response::ok([
            'mounts' => UsageService::cached($user),
            'dataDirBytes' => UsageService::dataDirUsage(),
        ]);
    }

    public static function scan(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $jobId = JobService::enqueue($user->id, 'du', ['mount' => $mount, 'userId' => $user->id]);
        return Response::ok(['job' => $jobId]);
    }
}