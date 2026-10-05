<?php

declare(strict_types=1);

/**
 * Test helper: clear two-factor state for a user.
 *
 * ONLY for local development and test runs — it exists so the automated 2FA
 * test can recover from being interrupted mid-flow, which would otherwise leave
 * the account locked behind a secret nobody holds. It is not shipped in the
 * image and is never referenced by the application.
 *
 * Usage: php tools/reset-2fa.php [username]
 */

$dbFile = getenv('ANSNEW_DB') ?: '/var/www/data/ansnew.sqlite';
$db = new PDO('sqlite:' . $dbFile);
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

$username = $argv[1] ?? 'admin';
// Double-quoted on purpose: recovery_codes is NOT NULL, so it must be set to an
// empty SQL string, not NULL.
$stmt = $db->prepare("UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes = '' WHERE username = :u");
$stmt->execute([':u' => $username]);

// Also clear the brute-force counters. Suites that deliberately test wrong
// passwords would otherwise leave the IP locked out for the next suite — the
// guard is doing its job, but a test run is not an attacker.
$db->exec('DELETE FROM login_attempts');

foreach ($db->query('SELECT username, totp_enabled FROM users', PDO::FETCH_ASSOC) as $row) {
    echo $row['username'], '  2fa=', $row['totp_enabled'], PHP_EOL;
}
echo "2FA state cleared for '{$username}'\n";
