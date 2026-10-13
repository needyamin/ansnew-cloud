<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\BruteForceGuard;
use App\Auth\AuthContext;
use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\UserService;
use App\Support\Validator;

/**
 * Authentication endpoints: login, logout, password change.
 */
final class AuthController
{
    public static function login(Request $req, SessionManager $session): Response
    {
        $body = $req->isJson() ? $req->json() : ($_POST ?: []);
        $username = trim((string) ($body['username'] ?? ''));
        $password = (string) ($body['password'] ?? '');

        if ($username === '' || $password === '') {
            return Response::error('Username and password required', 400, 'bad_request');
        }

        $ip = $req->ip();
        $lock = BruteForceGuard::check(strtolower($username), $ip);
        if ($lock !== null) {
            return Response::error("Too many failed attempts. Try again in {$lock} seconds.", 429, 'locked');
        }

        $user = UserService::verify($username, $password);
        if ($user === null) {
            BruteForceGuard::record(strtolower($username), $ip, false);
            return Response::error('Invalid credentials', 401, 'invalid_credentials');
        }

        BruteForceGuard::record(strtolower($username), $ip, true);

        // Session fixation defense: rotate before binding identity.
        $session->rotate();
        $session->set('user_id', $user->id);
        $session->set('_csrf', bin2hex(random_bytes(32)));

        return Response::ok([
            'user' => $user->publicInfo(),
            'csrf' => $session->csrfToken(),
        ]);
    }

    public static function logout(Request $req, SessionManager $session): Response
    {
        $session->destroy();
        return Response::ok(['loggedOut' => true]);
    }

    public static function changePassword(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $current = (string) ($body['currentPassword'] ?? '');
        $next = (string) ($body['newPassword'] ?? '');

        // Re-verify the current password before allowing a change.
        $verified = UserService::verify($user->username, $current);
        if ($verified === null) {
            return Response::error('Current password is incorrect', 403, 'denied');
        }
        Validator::password($next);
        UserService::updatePassword($user->id, $next);

        // Invalidate other sessions by rotating; the user stays logged in here.
        $session->rotate();

        return Response::ok(['changed' => true]);
    }
}
