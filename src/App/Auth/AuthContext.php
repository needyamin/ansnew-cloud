<?php

declare(strict_types=1);

namespace App\Auth;

use App\Core\Database;

/**
 * Currently authenticated user, resolved from the session.
 */
final class AuthContext
{
    public function __construct(
        public readonly int $id,
        public readonly string $username,
        public readonly string $role,
        public readonly string $displayName,
        public readonly string $theme,
        public readonly bool $mustChangePassword,
    ) {
    }

    public function isAdmin(): bool
    {
        return $this->role === 'admin';
    }

    public static function fromSession(SessionManager $session): ?self
    {
        $userId = $session->get('user_id');
        if (!is_int($userId) && !is_string($userId)) {
            return null;
        }
        $userId = (int) $userId;
        if ($userId <= 0) {
            return null;
        }
        $row = Database::i()->one(
            'SELECT id, username, role, display_name, theme, must_change_pw, is_active
             FROM users WHERE id = :id AND is_active = 1',
            [':id' => $userId]
        );
        if ($row === null) {
            return null;
        }
        return new self(
            (int) $row['id'],
            (string) $row['username'],
            (string) $row['role'],
            (string) $row['display_name'],
            (string) $row['theme'],
            (bool) $row['must_change_pw'],
        );
    }

    public function publicInfo(): array
    {
        return [
            'id' => $this->id,
            'username' => $this->username,
            'role' => $this->role,
            'displayName' => $this->displayName !== '' ? $this->displayName : $this->username,
            'theme' => $this->theme,
            'mustChangePassword' => $this->mustChangePassword,
        ];
    }
}
