<?php

declare(strict_types=1);

namespace App\Auth;

use App\Auth\AuthContext;
use App\Auth\SessionManager;
use RuntimeException;

/**
 * Resolves the authenticated user for API controllers.
 * Centralizes the "who is calling" decision so no controller forgets it.
 */
final class Guard
{
    public static function requireUser(SessionManager $session): AuthContext
    {
        $user = AuthContext::fromSession($session);
        if ($user === null) {
            throw new RuntimeException('Authentication required', 401);
        }
        return $user;
    }

    public static function requireAdmin(SessionManager $session): AuthContext
    {
        $user = self::requireUser($session);
        if (!$user->isAdmin()) {
            throw new RuntimeException('Administrator privileges required', 403);
        }
        return $user;
    }
}
