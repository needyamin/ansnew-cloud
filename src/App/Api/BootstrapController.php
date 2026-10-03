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
        $user = AuthContext::fromSession($session);
        return Response::ok([
            'authenticated' => $user !== null,
            'user' => $user?->publicInfo(),
            'csrf' => $session->csrfToken(),
            'version' => '1.0.0',
        ]);
    }
}
