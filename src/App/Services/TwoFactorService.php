<?php

declare(strict_types=1);

namespace App\Services;

use App\Core\Database;
use App\Support\Crypto;
use App\Support\Totp;
use App\Support\Validator;
use InvalidArgumentException;
use RuntimeException;

/**
 * Two-factor authentication with a TOTP authenticator app.
 *
 * The secret is stored **encrypted** (AES-256-GCM under APP_KEY) — a database
 * leak must not yield usable TOTP secrets. Recovery codes are stored as password
 * hashes, so they can be checked but not read back, and each one is single-use.
 */
final class TwoFactorService
{
    /** How long a password-only session may sit before the code step expires. */
    public const PRE_AUTH_TTL = 300;

    /** Recovery codes issued when 2FA is turned on. */
    public const RECOVERY_COUNT = 8;

    /** @return array{enabled:bool} */
    public static function status(int $userId): array
    {
        return ['enabled' => self::isEnabled($userId)];
    }

    public static function isEnabled(int $userId): bool
    {
        $row = Database::i()->one(
            'SELECT totp_enabled FROM users WHERE id = :id',
            [':id' => $userId]
        );
        return $row !== null && (int) $row['totp_enabled'] === 1;
    }

    /**
     * Begin enrolment: mint a secret, store it encrypted but leave 2FA disabled
     * until the user proves they can produce a valid code.
     *
     * @return array{secret:string, uri:string}
     */
    public static function startSetup(int $userId, string $username, string $issuer = 'ANSNEW Cloud'): array
    {
        $secret = Totp::generateSecret();
        Database::i()->run(
            'UPDATE users SET totp_secret_enc = :s, totp_enabled = 0 WHERE id = :id',
            [':s' => Crypto::encrypt($secret), ':id' => $userId]
        );
        return [
            'secret' => $secret,
            'uri' => Totp::provisioningUri($username, $secret, $issuer),
        ];
    }

    /**
     * Finish enrolment: verify one code, switch 2FA on, and hand back one-time
     * recovery codes. The codes are returned exactly once — only their hashes
     * are kept, so they cannot be displayed again.
     *
     * @return array{recoveryCodes:string[]}
     */
    public static function confirmSetup(int $userId, string $code): array
    {
        $secret = self::secretFor($userId);
        if (!Totp::verify($secret, $code)) {
            throw new InvalidArgumentException('That code is not valid yet — check the time on your device and try again.');
        }

        $codes = self::generateRecoveryCodes();
        // Hash the NORMALISED form (upper-case, no dashes) — that is exactly what
        // consumeRecovery() will compare against, so a user who drops the dashes
        // or types lower-case still gets a match.
        $hashes = array_map(
            static fn (string $c): string => password_hash(self::normaliseCode($c), PASSWORD_BCRYPT, ['cost' => 12]),
            $codes
        );

        Database::i()->run(
            'UPDATE users SET totp_enabled = 1, recovery_codes = :rc WHERE id = :id',
            [':rc' => json_encode($hashes) ?: '[]', ':id' => $userId]
        );
        AuditService::log(null, 'auth.2fa_enabled', null, null, null, 'ok', 'user #' . $userId, '', '');
        return ['recoveryCodes' => $codes];
    }

    /**
     * Turn 2FA off. Requires the current password AND a valid code, so a stolen
     * browser session alone is not enough to weaken the account.
     */
    public static function disable(int $userId, string $username, string $password, string $code): void
    {
        if (UserService::verify($username, $password) === null) {
            throw new RuntimeException('Password is incorrect', 403);
        }
        if (!self::verify($userId, $code)) {
            throw new RuntimeException('That code is not valid', 403);
        }
        Database::i()->run(
            'UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = \'\' WHERE id = :id',
            [':id' => $userId]
        );
        AuditService::log(null, 'auth.2fa_disabled', null, null, null, 'ok', 'user #' . $userId, '', '');
    }

    /**
     * Verify a second factor: a TOTP code, or one of the single-use recovery codes.
     *
     * @return string 'totp' | 'recovery' | '' (not valid)
     */
    public static function verify(int $userId, string $code): string
    {
        $code = trim($code);
        if ($code === '') {
            return '';
        }

        // Recovery codes are longer and formatted with dashes; try them first so
        // the two paths never share a code shape.
        if (preg_match('/^[A-Za-z0-9\-]{16,}$/', $code) === 1) {
            return self::consumeRecovery($userId, $code) ? 'recovery' : '';
        }

        $secret = self::secretFor($userId);
        return Totp::verify($secret, $code) ? 'totp' : '';
    }

    /** A recovery code verifies against a stored hash and can be used once. */
    private static function consumeRecovery(int $userId, string $code): bool
    {
        $db = Database::i();
        $row = $db->one('SELECT recovery_codes FROM users WHERE id = :id', [':id' => $userId]);
        if ($row === null || $row['recovery_codes'] === null || $row['recovery_codes'] === '') {
            return false;
        }
        $hashes = json_decode((string) $row['recovery_codes'], true);
        if (!is_array($hashes) || $hashes === []) {
            return false;
        }

        // Codes are compared normalised, so "ABCDE-FGHIJ-…" and "abcdefghij…" both work.
        $normalised = self::normaliseCode($code);
        $matched = null;
        foreach ($hashes as $i => $hash) {
            if (is_string($hash) && password_verify($normalised, $hash)) {
                $matched = $i;
                break;
            }
        }
        if ($matched === null) {
            return false;
        }

        // Burn it: remove the used code so it can never be replayed.
        array_splice($hashes, (int) $matched, 1);
        $db->run(
            'UPDATE users SET recovery_codes = :rc WHERE id = :id',
            [':rc' => json_encode(array_values($hashes)) ?: '[]', ':id' => $userId]
        );
        AuditService::log(null, 'auth.2fa_recovery_used', null, null, null, 'ok', 'user #' . $userId, '', '');
        return true;
    }

    /** Recovery codes are matched case-insensitively, ignoring dashes and spaces. */
    private static function normaliseCode(string $code): string
    {
        return strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $code) ?? '');
    }

    /** @return string[] plaintext codes, shown once at enrolment */
    private static function generateRecoveryCodes(): array
    {
        $codes = [];
        for ($i = 0; $i < self::RECOVERY_COUNT; $i++) {
            // 20 hex chars, grouped for readability when typed from paper.
            $hex = strtoupper(bin2hex(random_bytes(10)));
            $codes[] = implode('-', str_split($hex, 5));
        }
        return $codes;
    }

    private static function secretFor(int $userId): string
    {
        $row = Database::i()->one(
            'SELECT totp_secret_enc FROM users WHERE id = :id',
            [':id' => $userId]
        );
        if ($row === null || $row['totp_secret_enc'] === null || $row['totp_secret_enc'] === '') {
            throw new RuntimeException('Two-factor authentication is not set up');
        }
        $secret = Crypto::decrypt((string) $row['totp_secret_enc']);
        if ($secret === null || $secret === '') {
            throw new RuntimeException('Stored two-factor secret could not be read');
        }
        return $secret;
    }

    /** Password policy lives with Validator; re-exported so callers need one import. */
    public static function assertPasswordOk(string $password): void
    {
        Validator::password($password);
    }
}
