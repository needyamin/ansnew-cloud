<?php

declare(strict_types=1);

namespace App\Auth;

use App\Config\Config;
use App\Core\Database;
use App\Core\Request;
use App\Core\Response;

/**
 * Re-authentication gate for destructive actions.
 *
 * A logged-in session is not proof of intent: a laptop left unlocked, a
 * borrowed browser tab or a stray keyboard shortcut should not be enough to
 * disconnect a drive or wipe the trash. These operations therefore require the
 * account password again, which the server mints a short-lived grant for.
 *
 * The grant lives in the PHP session, not in the browser, so it cannot be
 * forged by a client. It is time-boxed (default 60s) rather than one-shot on
 * purpose: deleting a folder's contents means many requests in a row, and
 * asking for the password on every single one would train users to type it
 * without reading. One confirmation covers the burst.
 *
 * Only `fs.delete` is configurable (the "even to trash" toggle) because
 * trash-backed deletes are already recoverable. Everything else is always
 * gated — there is no undo for a disconnected drive or an emptied trash.
 */
final class SensitiveGate
{
    /** Every scope a controller may ask for. Anything else is rejected. */
    public const SCOPES = [
        'fs.delete',
        'drive.disconnect',
        'connection.delete',
        'favorites.clear',
        'shares.clear',
        'trash.empty',
    ];

    public const SESSION_KEY = '_sensitive';

    /** Settings-table key for the one configurable gate. */
    public const K_GATE_DELETE_TRASH = 'security.gate.delete_trash';

    public static function ttl(): int
    {
        return max(15, min(900, Config::i()->getInt('SENSITIVE_GRANT_TTL', 60)));
    }

    public static function isValidScope(string $scope): bool
    {
        return in_array($scope, self::SCOPES, true);
    }

    /**
     * Is the gate on for this action?
     *
     * @param bool $permanent For `fs.delete`: true when the delete bypasses
     *                        the trash, which is always gated regardless of
     *                        the toggle.
     */
    public static function required(string $scope, bool $permanent = false): bool
    {
        if (!self::isValidScope($scope)) {
            return false;
        }
        if ($scope === 'fs.delete') {
            return $permanent || self::deleteToTrashGated();
        }
        return true;
    }

    /**
     * The toggle's current value. Absent key means "on" — the safe default,
     * and the reason this reads a tri-state rather than a plain bool.
     */
    public static function deleteToTrashGated(): bool
    {
        try {
            $raw = Database::i()->scalar(
                'SELECT v FROM settings WHERE k = :k',
                [':k' => self::K_GATE_DELETE_TRASH]
            );
        } catch (\Throwable $e) {
            return true; // fail closed
        }
        return $raw === null ? true : $raw !== '0';
    }

    public static function setDeleteToTrashGated(bool $on): void
    {
        Database::i()->run(
            "INSERT INTO settings (k, v, updated_at) VALUES (:k, :v, datetime('now'))
             ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime('now')",
            [':k' => self::K_GATE_DELETE_TRASH, ':v' => $on ? '1' : '0']
        );
    }

    /* ------------------------------------------------------------- grants */

    /** Mint a grant. Returns the unix timestamp at which it expires. */
    public static function grant(SessionManager $session, string $scope, ?int $ttl = null): int
    {
        if (!self::isValidScope($scope)) {
            throw new \InvalidArgumentException('Unknown sensitive scope');
        }
        $expires = time() + ($ttl ?? self::ttl());
        $grants = $session->get(self::SESSION_KEY, []);
        if (!is_array($grants)) {
            $grants = [];
        }
        // Drop anything already expired while we are in here, so the array
        // can't grow without bound on a long-lived session.
        foreach ($grants as $k => $exp) {
            if (!is_int($exp) || $exp <= time()) {
                unset($grants[$k]);
            }
        }
        $grants[$scope] = $expires;
        $session->set(self::SESSION_KEY, $grants);
        return $expires;
    }

    public static function has(SessionManager $session, string $scope): bool
    {
        $grants = $session->get(self::SESSION_KEY, []);
        if (!is_array($grants) || !isset($grants[$scope])) {
            return false;
        }
        $exp = $grants[$scope];
        if (!is_int($exp) || $exp <= time()) {
            self::revoke($session, $scope);
            return false;
        }
        return true;
    }

    public static function revoke(SessionManager $session, ?string $scope = null): void
    {
        if ($scope === null) {
            $session->remove(self::SESSION_KEY);
            return;
        }
        $grants = $session->get(self::SESSION_KEY, []);
        if (is_array($grants)) {
            unset($grants[$scope]);
            $session->set(self::SESSION_KEY, $grants);
        }
    }

    /**
     * Guard a destructive controller action.
     *
     * Returns null when the caller may proceed, or a 403 Response carrying
     * code `sensitive_required` when the password must be re-entered. It
     * returns rather than throws because Kernel rewrites thrown
     * RuntimeExceptions to the generic `error` code, and the client has to be
     * able to tell "confirm your password" apart from a real denial.
     *
     * @param bool $permanent For `fs.delete`: a permanent delete is always gated.
     */
    public static function guard(SessionManager $session, string $scope, bool $permanent = false): ?Response
    {
        if (!self::required($scope, $permanent)) {
            return null;
        }
        if (self::has($session, $scope)) {
            return null;
        }
        return Response::error(
            'Enter your password to confirm this action.',
            403,
            'sensitive_required',
            ['scope' => $scope, 'ttl' => self::ttl()]
        );
    }

    /**
     * The gate's public posture, published through /api/bootstrap so the UI
     * can decide whether to prompt (and how long a grant lasts) without
     * having to hardcode server policy.
     *
     * @return array<string,mixed>
     */
    public static function publicInfo(): array
    {
        return [
            'ttl' => self::ttl(),
            'scopes' => self::SCOPES,
            'gateDeleteTrash' => self::deleteToTrashGated(),
        ];
    }

    /**
     * Read or write the one configurable gate. Admin-only; the caller is
     * expected to have run Guard::requireAdmin() first.
     */
    public static function setToggle(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireAdmin($session);
        $body = $req->json();
        if (!array_key_exists('gateDeleteTrash', $body)) {
            return Response::error('Missing gateDeleteTrash', 400, 'bad_request');
        }
        $on = (bool) ($body['gateDeleteTrash'] ?? false);
        self::setDeleteToTrashGated($on);
        \App\Services\AuditService::log(
            $user,
            'security.gate_changed',
            null,
            null,
            null,
            'ok',
            self::K_GATE_DELETE_TRASH . '=' . ($on ? '1' : '0'),
            $req->ip(),
            $req->userAgent()
        );
        return Response::ok(self::publicInfo());
    }
}
