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

    /**
     * Remove a favourite.
     *
     * Parameters are accepted from the query string OR the JSON body, and the
     * client sends them in the query string. A DELETE carrying a request body is
     * legal but poorly supported in the wild — proxies and CDNs are free to drop
     * it, and nginx-based ones can stall or answer an empty 400 instead. Passing
     * the values in the URL sidesteps that entirely and costs nothing.
     */
    public static function remove(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $mount = (string) ($req->query('mount', '') ?: ($body['mount'] ?? ''));
        $path = (string) ($req->query('path', '') ?: ($body['path'] ?? '/'));
        FavoritesService::removeFavorite($user, $mount, $path);
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
        $action = (string) ($body['action'] ?? 'open');
        if (!in_array($action, FavoritesService::RECENT_ACTIONS, true)) {
            $action = 'open';
        }
        FavoritesService::recordRecent(
            $user,
            (string) ($body['mount'] ?? ''),
            (string) ($body['path'] ?? ''),
            (string) ($body['name'] ?? ''),
            $action,
            (string) ($body['type'] ?? 'file'),
            (int) ($body['modifiedAt'] ?? 0),
            (int) ($body['size'] ?? 0)
        );
        return Response::ok(['recorded' => true]);
    }

    /**
     * Clear the Recent list — everything, or one entry when mount+path are given.
     * Params come from the query string for the same reason as remove().
     */
    public static function clearRecent(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $mount = (string) $req->query('mount', '');
        $path = (string) $req->query('path', '');
        $removed = ($mount !== '' && $path !== '')
            ? FavoritesService::clearRecent($user, $mount, $path)
            : FavoritesService::clearRecent($user);
        return Response::ok(['removed' => $removed]);
    }
}