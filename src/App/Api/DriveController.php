<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\DriveService;
use App\Services\NotifyService;

/**
 * User-facing drive management: list, create, rename, disconnect.
 *
 * Distinct from /api/admin/mounts, which is the administrator view over every
 * mount (including grants and quotas). This one is scoped to what the caller may
 * actually manage.
 */
final class DriveController
{
    public static function list(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        return Response::ok(['drives' => DriveService::listFor($user)]);
    }

    /** Adapter types the caller is allowed to create. */
    public static function types(Request $req, SessionManager $session): Response
    {
        Guard::requireUser($session);
        return Response::ok(['types' => [
            ['id' => 'local', 'label' => 'Local storage', 'needsConnection' => false],
            ['id' => 's3', 'label' => 'Amazon S3', 'needsConnection' => true],
            ['id' => 's3', 'label' => 'Cloudflare R2', 'needsConnection' => true, 'provider' => 'r2'],
            ['id' => 's3', 'label' => 'S3-compatible (MinIO, Wasabi, Backblaze…)', 'needsConnection' => true, 'provider' => 's3-compatible'],
        ]]);
    }

    public static function create(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $r = DriveService::create($user, $req->json());
        self::announce($user->id, 'drive-create');
        return Response::ok($r);
    }

    public static function rename(Request $req, SessionManager $session, int $id): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $r = DriveService::rename($user, $id, (string) ($body['label'] ?? ''));
        self::announce($user->id, 'drive-rename');
        return Response::ok($r);
    }

    /**
     * Disconnect a drive. Removes the mount registration only — the underlying
     * files (local directory or remote bucket) are deliberately left untouched.
     */
    public static function disconnect(Request $req, SessionManager $session, int $id): Response
    {
        $user = Guard::requireUser($session);
        $r = DriveService::disconnect($user, $id);
        self::announce($user->id, 'drive-disconnect');
        return Response::ok($r);
    }

    /**
     * Drive changes alter the sidebar, not any directory listing, so this is a
     * dedicated event rather than an fs.changed one.
     */
    private static function announce(int $userId, string $reason): void
    {
        NotifyService::push([$userId], 'drives.changed', ['reason' => $reason, 'ts' => time()]);
    }
}
