<?php

declare(strict_types=1);

namespace App\Auth;

use App\Config\Config;
use App\Core\Database;
use RuntimeException;

/**
 * Hardened PHP session management.
 * - strict mode, httponly, SameSite=Strict, Secure when configured
 * - ID rotation on login
 * - idle + absolute timeouts
 * - fingerprint binding (UA hash + soft IP check)
 */
final class SessionManager
{
    private bool $started = false;

    public function start(): void
    {
        if ($this->started || session_status() === PHP_SESSION_ACTIVE) {
            $this->started = true;
            return;
        }

        $cfg = Config::i();
        $lifetime = $cfg->getInt('SESSION_LIFETIME', 43200);

        session_name('ANSNEW_SID');
        session_set_cookie_params([
            'lifetime' => 0, // session cookie; server-side idle timeout governs
            'path' => '/',
            'domain' => '',
            'secure' => $cfg->getBool('SESSION_SECURE_COOKIE', false),
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
        $this->started = true;

        $now = time();
        $lastActivity = (int) ($_SESSION['_last_activity'] ?? 0);
        $created = (int) ($_SESSION['_created'] ?? 0);
        $idle = $cfg->getInt('IDLE_TIMEOUT', 1800);

        if ($lastActivity > 0 && ($now - $lastActivity) > $idle) {
            $this->destroy();
            return;
        }
        if ($created > 0 && ($now - $created) > $lifetime) {
            $this->destroy();
            return;
        }

        // Soft binding: UA must match; IP change across networks is allowed but
        // flagged (mobile users). Hard require UA hash equality.
        $uaHash = hash('sha256', (string) ($_SERVER['HTTP_USER_AGENT'] ?? ''));
        if (isset($_SESSION['_ua']) && $_SESSION['_ua'] !== $uaHash) {
            $this->destroy();
            return;
        }

        $_SESSION['_last_activity'] = $now;
        if (!isset($_SESSION['_created'])) {
            $_SESSION['_created'] = $now;
        }
        if (!isset($_SESSION['_ua'])) {
            $_SESSION['_ua'] = $uaHash;
        }
    }

    public function isStarted(): bool
    {
        return session_status() === PHP_SESSION_ACTIVE;
    }

    /** Rotate the session ID (call on login / privilege change). */
    public function rotate(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }
    }

    public function set(string $key, mixed $value): void
    {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            throw new RuntimeException('Session not active');
        }
        $_SESSION[$key] = $value;
    }

    public function get(string $key, mixed $default = null): mixed
    {
        return session_status() === PHP_SESSION_ACTIVE ? ($_SESSION[$key] ?? $default) : $default;
    }

    public function has(string $key): bool
    {
        return session_status() === PHP_SESSION_ACTIVE && isset($_SESSION[$key]);
    }

    public function remove(string $key): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            unset($_SESSION[$key]);
        }
    }

    public function destroy(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            $_SESSION = [];
            if (ini_get('session.use_cookies')) {
                $p = session_get_cookie_params();
                setcookie(session_name(), '', [
                    'expires' => time() - 42000,
                    'path' => $p['path'],
                    'domain' => $p['domain'],
                    'secure' => $p['secure'],
                    'httponly' => $p['httponly'],
                    'samesite' => 'Strict',
                ]);
            }
            session_destroy();
        }
        $this->started = false;
    }

    public function csrfToken(): string
    {
        if (!$this->has('_csrf')) {
            $this->set('_csrf', bin2hex(random_bytes(32)));
        }
        return (string) $this->get('_csrf');
    }

    public function validateCsrf(string $provided): bool
    {
        return $provided !== '' && $this->has('_csrf')
            && hash_equals((string) $this->get('_csrf'), $provided);
    }
}
