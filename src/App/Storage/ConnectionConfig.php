<?php

declare(strict_types=1);

namespace App\Storage;

use App\Support\Crypto;

/**
 * Credential envelope handed to adapters. Secrets exist only inside the PHP
 * process for the duration of a request/job — never in logs, API responses,
 * or the browser.
 */
final class ConnectionConfig
{
    /**
     * Connection row id (for host-key TOFU pinning). Populated by fromRow().
     */
    public ?int $pinConnectionId = null;

    public function __construct(
        public readonly string $protocol,
        public readonly string $host,
        public readonly int $port,
        public readonly string $username,
        public readonly string $authType,       // password|key|none
        public readonly string $secret,         // password or private key PEM
        public readonly string $passphrase,     // key passphrase
        public readonly string $remoteBase,
        public readonly ?string $hostFingerprint,
        public readonly bool $verifyTls,
        /** @var array<string,mixed> */
        public readonly array $extra = [],
    ) {
    }

    /** @param array<string,mixed> $row */
    public static function fromRow(array $row): self
    {
        $extra = json_decode((string) ($row['extra'] ?? '{}'), true);
        $cfg = new self(
            (string) $row['protocol'],
            (string) $row['host'],
            (int) $row['port'],
            (string) ($row['username'] ?? ''),
            (string) ($row['auth_type'] ?? 'password'),
            isset($row['secret_enc']) && $row['secret_enc'] !== ''
                ? Crypto::decrypt((string) $row['secret_enc'])
                : '',
            isset($row['passphrase_enc']) && $row['passphrase_enc'] !== ''
                ? Crypto::decrypt((string) $row['passphrase_enc'])
                : '',
            (string) ($row['remote_base'] ?? '/'),
            isset($row['host_fingerprint']) && $row['host_fingerprint'] !== null
                ? (string) $row['host_fingerprint']
                : null,
            (bool) ($row['verify_tls'] ?? true),
            is_array($extra) ? $extra : [],
        );
        $cfg->pinConnectionId = isset($row['id']) ? (int) $row['id'] : null;
        return $cfg;
    }
}
