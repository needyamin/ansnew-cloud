<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\FavoritesService;

final class FavoritesController
{
    public static function list(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        return Response::ok(['favorites' => FavoritesService::favorites($user)]);
    }

    public static function add(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $r = FavoritesService::addFavorite(
            $user,
            (string) ($body['mount'] ?? ''),
            (string) ($body['path'] ?? '/'),
            (string) ($body['label'] ?? '')
        );
        return Response::ok($r);
    }

    public static function remove(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        FavoritesService::removeFavorite($user, (string) ($body['mount'] ?? ''), (string) ($body['path'] ?? '/'));
        return Response::ok(['removed' => true]);
    }

    public static function recent(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        return Response::ok(['recent' => FavoritesService::recent($user, (int) $req->query('limit', 30))]);
    }

    public static function recordRecent(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        FavoritesService::recordRecent(
            $user,
            (string) ($body['mount'] ?? ''),
            (string) ($body['path'] ?? ''),
            (string) ($body['name'] ?? ''),
            in_array($body['action'] ?? 'open', ['open', 'download', 'preview'], true) ? (string) ($body['action'] ?? 'open') : 'open'
        );
        return Response::ok(['recorded' => true]);
    }
}