<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use App\Support\Validator;
use InvalidArgumentException;
use RuntimeException;

/**
 * User administration (admin-only operations plus self-service profile).
 */
final class UserService
{
    /** @return array<int, array<string,mixed>> */
    public static function all(): array
    {
        return Database::i()->all(
            'SELECT id, username, email, role, display_name, theme, is_active, must_change_pw,
                    created_at, last_login_at
             FROM users ORDER BY username'
        );
    }

    public static function find(int $id): ?array
    {
        return Database::i()->one(
            'SELECT id, username, email, role, display_name, theme, is_active, must_change_pw,
                    created_at, last_login_at
             FROM users WHERE id = :id',
            [':id' => $id]
        );
    }

    public static function create(string $username, string $password, string $role, string $displayName = '', string $email = ''): int
    {
        $username = Validator::username($username);
        Validator::password($password);
        if (!in_array($role, ['admin', 'user'], true)) {
            throw new InvalidArgumentException('Invalid role');
        }
        $db = Database::i();
        $exists = $db->one('SELECT id FROM users WHERE username = :u', [':u' => $username]);
        if ($exists !== null) {
            throw new RuntimeException('Username already exists');
        }
        $hash = password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
        $db->run(
            'INSERT INTO users (username, password_hash, role, display_name, email) VALUES (:u,:p,:r,:d,:e)',
            [':u' => $username, ':p' => $hash, ':r' => $role, ':d' => $displayName, ':e' => $email]
        );
        return (int) $db->scalar('SELECT id FROM users WHERE username = :u', [':u' => $username]);
    }

    public static function updatePassword(int $userId, string $newPassword): void
    {
        Validator::password($newPassword);
        $hash = password_hash($newPassword, PASSWORD_BCRYPT, ['cost' => 12]);
        Database::i()->run(
            'UPDATE users SET password_hash = :p, must_change_pw = 0 WHERE id = :id',
            [':p' => $hash, ':id' => $userId]
        );
    }

    public static function updateProfile(int $userId, array $fields): void
    {
        $allowed = ['display_name', 'theme', 'email', 'locale'];
        $sets = [];
        $params = [':id' => $userId];
        foreach ($allowed as $col) {
            $key = lcfirst(str_replace('_', '', ucwords($col, '_')));
            if (array_key_exists($key, $fields)) {
                $v = (string) $fields[$key];
                if ($col === 'theme') {
                    $v = in_array($v, ['dark', 'light'], true) ? $v : 'dark';
                }
                if (mb_strlen($v) > 190) {
                    throw new InvalidArgumentException('Field too long');
                }
                $sets[] = "$col = :$col";
                $params[":$col"] = $v;
            }
        }
        if ($sets === []) {
            return;
        }
        Database::i()->run('UPDATE users SET ' . implode(', ', $sets) . ' WHERE id = :id', $params);
    }

    public static function setActive(int $userId, bool $active): void
    {
        Database::i()->run('UPDATE users SET is_active = :a WHERE id = :id', [':a' => $active ? 1 : 0, ':id' => $userId]);
    }

    public static function setRole(int $userId, string $role): void
    {
        if (!in_array($role, ['admin', 'user'], true)) {
            throw new InvalidArgumentException('Invalid role');
        }
        Database::i()->run('UPDATE users SET role = :r WHERE id = :id', [':r' => $role, ':id' => $userId]);
    }

    public static function delete(int $actorId, int $userId): void
    {
        if ($actorId === $userId) {
            throw new RuntimeException('Refusing to delete your own account');
        }
        Database::i()->run('DELETE FROM users WHERE id = :id', [':id' => $userId]);
    }

    public static function verify(string $username, string $password): ?AuthContext
    {
        $db = Database::i();
        $row = $db->one('SELECT * FROM users WHERE username = :u', [':u' => strtolower(trim($username))]);
        if ($row === null) {
            // Constant-time-ish: still hash to equalize timing.
            password_verify($password, '$2y$12$0000000000000000000000000000000000000000000000000000');
            return null;
        }
        if ((int) $row['is_active'] !== 1) {
            return null;
        }
        if (!password_verify($password, (string) $row['password_hash'])) {
            return null;
        }
        // Transparent rehash on cost change.
        if (password_needs_rehash((string) $row['password_hash'], PASSWORD_BCRYPT, ['cost' => 12])) {
            $db->run('UPDATE users SET password_hash = :p WHERE id = :id', [
                ':p' => password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]),
                ':id' => (int) $row['id'],
            ]);
        }
        $db->run('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = :id', [':id' => (int) $row['id']]);
        return new AuthContext(
            (int) $row['id'],
            (string) $row['username'],
            (string) $row['role'],
            (string) $row['display_name'],
            (string) $row['theme'],
            (bool) $row['must_change_pw']
        );
    }
}
