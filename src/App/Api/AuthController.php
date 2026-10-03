<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\BruteForceGuard;
use App\Auth\AuthContext;
use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\AuditService;
use App\Services\UserService;
use App\Support\Validator;
use RuntimeException;

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
            AuditService::log(null, 'auth.login_locked', null, null, null, 'locked', $username, $ip, $req->userAgent());
            return Response::error("Too many failed attempts. Try again in {$lock} seconds.", 429, 'locked');
        }

        $user = UserService::verify($username, $password);
        if ($user === null) {
            BruteForceGuard::record(strtolower($username), $ip, false);
            AuditService::log(null, 'auth.login_failed', null, null, null, 'denied', $username, $ip, $req->userAgent());
            return Response::error('Invalid credentials', 401, 'invalid_credentials');
        }

        BruteForceGuard::record(strtolower($username), $ip, true);

        // Session fixation defense: rotate before binding identity.
        $session->rotate();
        $session->set('user_id', $user->id);
        $session->set('_csrf', bin2hex(random_bytes(32)));

        AuditService::log($user, 'auth.login', null, null, null, 'ok', '', $ip, $req->userAgent());

        return Response::ok([
            'user' => $user->publicInfo(),
            'csrf' => $session->csrfToken(),
        ]);
    }

    public static function logout(Request $req, SessionManager $session): Response
    {
        $user = AuthContext::fromSession($session);
        if ($user !== null) {
            AuditService::log($user, 'auth.logout', null, null, null, 'ok', '', $req->ip(), $req->userAgent());
        }
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

        AuditService::log($user, 'auth.password_changed', null, null, null, 'ok', '', $req->ip(), $req->userAgent());

        // Invalidate other sessions by rotating; the user stays logged in here.
        $session->rotate();

        return Response::ok(['changed' => true]);
    }
}
