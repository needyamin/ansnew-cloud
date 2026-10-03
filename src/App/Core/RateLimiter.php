<?php

declare(strict_types=1);

namespace App\Core;

use App\Core\Database;

/**
 * Token-bucket rate limiter persisted in the DB (works across fpm workers).
 */
final class RateLimiter
{
    public static function allow(string $key, int $maxRequests, int $windowSeconds): bool
    {
        $db = Database::i();
        $now = time();
        $refillPerSec = $maxRequests / max(1, $windowSeconds);

        $db->run('BEGIN IMMEDIATE');
        try {
            $row = $db->one('SELECT tokens, updated_at FROM rate_limits WHERE k = :k', [':k' => $key]);
            if ($row === null) {
                $tokens = $maxRequests - 1;
                $db->run(
                    'INSERT INTO rate_limits (k, tokens, updated_at) VALUES (:k, :t, :u)',
                    [':k' => $key, ':t' => $tokens, ':u' => $now]
                );
            } else {
                $elapsed = max(0, $now - (int) $row['updated_at']);
                $tokens = min((float) $maxRequests, (float) $row['tokens'] + $elapsed * $refillPerSec);
                if ($tokens < 1) {
                    $db->run('UPDATE rate_limits SET tokens = :t, updated_at = :u WHERE k = :k',
                        [':t' => $tokens, ':u' => $now, ':k' => $key]);
                    $db->run('COMMIT');
                    return false;
                }
                $tokens -= 1;
                $db->run('UPDATE rate_limits SET tokens = :t, updated_at = :u WHERE k = :k',
                    [':t' => $tokens, ':u' => $now, ':k' => $key]);
            }
            $db->run('COMMIT');
            return true;
        } catch (\Throwable $e) {
            $db->run('ROLLBACK');
            // Fail open on lock contention but log; DoS-hardening must not brick the app.
            error_log('[ansnew] rate limiter: ' . $e->getMessage());
            return true;
        }
    }
}
