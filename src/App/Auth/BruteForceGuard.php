<?php

declare(strict_types=1);

namespace App\Auth;

use App\Core\Database;
use App\Config\Config;

/**
 * Brute-force guard: failure counting with exponential lockout.
 *
 * Two layers:
 *  - per username+IP (the classic lockout), and
 *  - per username across all IPs, so an attacker rotating source addresses
 *    cannot stretch a single password-spray campaign indefinitely.
 */
final class BruteForceGuard
{
    public static function check(string $username, string $ip): ?int
    {
        $db = Database::i();
        $cfg = Config::i();
        $max = $cfg->getInt('LOGIN_MAX_ATTEMPTS', 5);
        $base = $cfg->getInt('LOGIN_LOCKOUT_BASE', 30);
        $maxLock = $cfg->getInt('LOGIN_LOCKOUT_MAX', 3600);

        $since = gmdate('Y-m-d H:i:s', time() - 900); // 15 min window
        $row = $db->one(
            'SELECT COUNT(*) AS c FROM login_attempts
             WHERE username = :u AND ip = :ip AND success = 0 AND created_at > :since',
            [':u' => $username, ':ip' => $ip, ':since' => $since]
        );
        $fails = (int) ($row['c'] ?? 0);

        if ($fails >= $max) {
            // Exponential: base * 2^(fails - max), capped.
            $extra = $fails - $max;
            $lock = min($base * (2 ** min($extra, 10)), $maxLock);
            return $lock; // seconds remaining lockout window recommendation
        }

        // Account-level layer: same username failing from *any* address.
        // Deliberately high ceiling (3x the per-IP one) so ordinary users who
        // mistype on a phone and a laptop are unaffected; past it the account
        // is frozen for the maximum window regardless of source IP.
        $row = $db->one(
            'SELECT COUNT(*) AS c FROM login_attempts
             WHERE username = :u AND success = 0 AND created_at > :since',
            [':u' => $username, ':since' => $since]
        );
        $acctFails = (int) ($row['c'] ?? 0);
        if ($acctFails >= $max * 3) {
            return $maxLock;
        }
        return null;
    }

    public static function record(string $username, string $ip, bool $success): void
    {
        $db = Database::i();
        $db->run(
            'INSERT INTO login_attempts (username, ip, success) VALUES (:u, :ip, :s)',
            [':u' => $username, ':ip' => $ip, ':s' => $success ? 1 : 0]
        );
        // Housekeeping: keep the table bounded.
        if (random_int(1, 50) === 1) {
            $cutoff = gmdate('Y-m-d H:i:s', time() - 86400);
            $db->run('DELETE FROM login_attempts WHERE created_at < :c', [':c' => $cutoff]);
        }
    }
}
