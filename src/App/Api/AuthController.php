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
use App\Services\TwoFactorService;
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

        // Two-factor users get a *pre-auth* session only: the password alone must
        // never yield a usable session. The state expires, so an abandoned
        // half-login cannot be completed hours later from the same browser.
        if (TwoFactorService::isEnabled($user->id)) {
            $session->rotate();
            $session->set('pre_2fa_user', $user->id);
            $session->set('pre_2fa_at', time());
            AuditService::log($user, 'auth.2fa_challenge', null, null, null, 'ok', '', $ip, $req->userAgent());
            return Response::ok([
                'twoFactorRequired' => true,
                'csrf' => $session->csrfToken(),
            ]);
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

    /**
     * Second step of a two-factor login: verify the authenticator code (or a
     * single-use recovery code) and only then grant the real session.
     */
    public static function verifyTwoFactor(Request $req, SessionManager $session): Response
    {
        $body = $req->isJson() ? $req->json() : ($_POST ?: []);
        $code = trim((string) ($body['code'] ?? ''));
        if ($code === '') {
            return Response::error('Enter the code from your authenticator app', 400, 'bad_request');
        }

        $userId = $session->get('pre_2fa_user');
        $at = (int) ($session->get('pre_2fa_at') ?? 0);
        if (!is_int($userId) || $at <= 0 || (time() - $at) > TwoFactorService::PRE_AUTH_TTL) {
            // Expired or never started: make them sign in again, from scratch.
            $session->destroy();
            return Response::error('Sign-in attempt expired. Please log in again.', 401, 'preauth_expired');
        }

        $ip = $req->ip();
        $lock = BruteForceGuard::check('2fa:' . $userId, $ip);
        if ($lock !== null) {
            return Response::error("Too many failed attempts. Try again in {$lock} seconds.", 429, 'locked');
        }

        $kind = TwoFactorService::verify($userId, $code);
        if ($kind === '') {
            BruteForceGuard::record('2fa:' . $userId, $ip, false);
            AuditService::log(null, 'auth.2fa_failed', null, null, null, 'denied', 'user #' . $userId, $ip, $req->userAgent());
            return Response::error('That code is not valid', 401, 'invalid_code');
        }

        BruteForceGuard::record('2fa:' . $userId, $ip, true);
        $session->remove('pre_2fa_user');
        $session->remove('pre_2fa_at');

        // Only now is the session real — and it gets a fresh id.
        $session->rotate();
        $session->set('user_id', $userId);
        $session->set('_csrf', bin2hex(random_bytes(32)));

        $user = AuthContext::fromSession($session);
        if ($user === null) {
            return Response::error('Sign-in could not be completed', 401, 'invalid_credentials');
        }
        AuditService::log($user, 'auth.login', null, null, null, 'ok', '2fa:' . $kind, $ip, $req->userAgent());

        return Response::ok([
            'user' => $user->publicInfo(),
            'csrf' => $session->csrfToken(),
            'usedRecoveryCode' => $kind === 'recovery',
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

    /**
     * POST /api/auth/confirm — re-authenticate before a destructive action.
     *
     * Distinct from login: the caller already holds a valid session, so this
     * only proves *possession of the password right now* and then mints a
     * short-lived grant for one scope. It deliberately does not touch
     * `user_id`, rotate the session or return a new identity — it is an
     * authorisation step, not an authentication one.
     *
     * {"password":"...","scope":"fs.delete","code":"123456"}
     * -> {"ok":true,"scope":"fs.delete","expiresAt":<unix>,"ttl":60}
     */
    public static function confirmSensitive(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $scope = (string) ($body['scope'] ?? '');
        $password = (string) ($body['password'] ?? '');

        if (!\App\Auth\SensitiveGate::isValidScope($scope)) {
            return Response::error('Unknown action', 400, 'bad_request');
        }
        if ($password === '') {
            return Response::error('Enter your password', 400, 'bad_request');
        }

        // Same lockout machinery as login: without it this endpoint is a
        // cheaper place to guess a password than the login form.
        $ip = $req->ip();
        $guardKey = 'sensitive:' . $user->id;
        $lock = BruteForceGuard::check($guardKey, $ip);
        if ($lock !== null) {
            return Response::error("Too many failed attempts. Try again in {$lock} seconds.", 429, 'locked');
        }

        if (UserService::verify($user->username, $password) === null) {
            BruteForceGuard::record($guardKey, $ip, false);
            AuditService::log($user, 'auth.sensitive_denied', null, null, null, 'denied', $scope, $ip, $req->userAgent());
            return Response::error('Password is incorrect', 403, 'denied');
        }

        // A password alone is not enough for an account that has 2FA on —
        // otherwise enabling 2FA would *weaken* the strongest gate we have.
        if (TwoFactorService::isEnabled($user->id)) {
            $code = trim((string) ($body['code'] ?? ''));
            if ($code === '') {
                return Response::error('Enter the code from your authenticator app', 403, 'code_required');
            }
            if (TwoFactorService::verify($user->id, $code) === '') {
                BruteForceGuard::record($guardKey, $ip, false);
                AuditService::log($user, 'auth.sensitive_2fa_failed', null, null, null, 'denied', $scope, $ip, $req->userAgent());
                return Response::error('That code is not valid', 403, 'invalid_code');
            }
        }

        BruteForceGuard::record($guardKey, $ip, true);
        $expiresAt = \App\Auth\SensitiveGate::grant($session, $scope);
        AuditService::log($user, 'auth.sensitive_confirmed', null, null, null, 'ok', $scope, $ip, $req->userAgent());

        return Response::ok([
            'ok' => true,
            'scope' => $scope,
            'expiresAt' => $expiresAt,
            'ttl' => \App\Auth\SensitiveGate::ttl(),
        ]);
    }

    /* ------------------------------------------------ two-factor management */

    public static function twoFactorStatus(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        return Response::ok(TwoFactorService::status($user->id));
    }

    /** Begin enrolment — returns the secret and its otpauth:// URI, once. */
    public static function twoFactorSetup(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        // Re-enrolment or setup must prove possession of the password first.
        $body = $req->json();
        if (UserService::verify($user->username, (string) ($body['password'] ?? '')) === null) {
            return Response::error('Password is incorrect', 403, 'denied');
        }
        $r = TwoFactorService::startSetup($user->id, $user->username);
        return Response::ok($r);
    }

    /** Complete enrolment — verify one code, enable, and issue recovery codes. */
    public static function twoFactorConfirm(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $r = TwoFactorService::confirmSetup($user->id, (string) ($req->json()['code'] ?? ''));
        return Response::ok($r);
    }

    public static function twoFactorDisable(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        try {
            TwoFactorService::disable(
                $user->id,
                $user->username,
                (string) ($body['password'] ?? ''),
                (string) ($body['code'] ?? '')
            );
        } catch (RuntimeException $e) {
            return Response::error($e->getMessage(), 403, 'denied');
        }
        return Response::ok(['disabled' => true]);
    }
}
