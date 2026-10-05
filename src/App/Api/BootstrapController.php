<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\AuthContext;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;

/**
 * First call the SPA makes: establishes the session, returns identity,
 * CSRF token and UI defaults.
 */
final class BootstrapController
{
    public static function bootstrap(Request $req, SessionManager $session): Response
    {
        $cfg = \App\Config\Config::i();
        $user = AuthContext::fromSession($session);
        return Response::ok([
            'authenticated' => $user !== null,
            'user' => $user?->publicInfo(),
            'csrf' => $session->csrfToken(),
            'version' => '1.0.0',
            // Published so the Settings page can show the real policy rather
            // than guessing. Nothing here is secret; it is all server posture.
            'idleTimeout' => $cfg->getInt('IDLE_TIMEOUT', 1800),
            'sessionLifetime' => $cfg->getInt('SESSION_LIFETIME', 43200),
            'loginMaxAttempts' => $cfg->getInt('LOGIN_MAX_ATTEMPTS', 5),
            'blockedExtensions' => \App\Support\Validator::FORBIDDEN_UPLOAD_EXT,
            // Lets the UI know which actions need a password re-entry and how
            // long a grant lasts, instead of hardcoding server policy.
            'sensitive' => \App\Auth\SensitiveGate::publicInfo(),
        ]);
    }
}
