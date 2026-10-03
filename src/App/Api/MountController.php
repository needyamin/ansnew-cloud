<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\UsageService;
use App\Storage\StorageManager;

final class MountController
{
    public static function listForUser(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $mounts = array_map(static fn($m) => $m->publicInfo(), StorageManager::mountsFor($user));
        $usage = UsageService::cached($user);
        $byName = [];
        foreach ($usage as $u) { $byName[$u['mount']] = $u['usage']; }
        foreach ($mounts as &$m) {
            $m['usage'] = $byName[$m['name']] ?? null;
        }
        return Response::ok(['mounts' => $mounts]);
    }
}