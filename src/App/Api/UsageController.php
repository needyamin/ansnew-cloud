<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
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
        // Explicitly requested, so bypass the debounce — but still dedupe
        // against a scan that is already queued or running for this mount.
        $jobId = UsageService::requestRescan($mount, $user->id, true);
        return Response::ok(['job' => $jobId, 'queued' => $jobId !== null]);
    }
}