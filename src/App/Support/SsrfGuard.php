<?php

declare(strict_types=1);

namespace App\Support;

use App\Config\Config;
use RuntimeException;

/**
 * SSRF guard for outbound remote-connection targets.
 *
 * Rules:
 *  - only http/https schemes;
 *  - hostname is resolved and EVERY resolved address must be public unless
 *    SSRF_ALLOW_PRIVATE=true or the host/CIDR is explicitly allowlisted;
 *  - loopback, link-local, multicast, reserved and unspecified ranges are
 *    always blocked, even when private ranges are allowed, unless allowlisted;
 *  - redirects are never followed automatically to a different host.
 */
final class SsrfGuard
{
    /** @return array<int,string> validated IP addresses for the host */
    public static function validateHost(string $host): array
    {
        $host = trim($host);
        if ($host === '') {
            throw new RuntimeException('Empty remote host');
        }
        if (!preg_match('/^[a-zA-Z0-9._:-]+$/', $host)) {
            throw new RuntimeException('Invalid remote host');
        }

        $allowPrivate = Config::i()->getBool('SSRF_ALLOW_PRIVATE', false);
        $allowlist = self::allowlist();

        if (self::inAllowlist($host, $allowlist)) {
            return [];
        }

        $ips = [];
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            $ips[] = $host;
        } else {
            $records = @dns_get_record($host, DNS_A | DNS_AAAA);
            if (is_array($records)) {
                foreach ($records as $r) {
                    if (isset($r['ip'])) {
                        $ips[] = (string) $r['ip'];
                    }
                    if (isset($r['ipv6'])) {
                        $ips[] = (string) $r['ipv6'];
                    }
                }
            }
            if ($ips === []) {
                $resolved = @gethostbynamel($host);
                if (is_array($resolved)) {
                    $ips = $resolved;
                }
            }
        }

        if ($ips === []) {
            throw new RuntimeException('Cannot resolve remote host');
        }

        foreach ($ips as $ip) {
            if (self::inAllowlist($ip, $allowlist)) {
                continue;
            }
            if (!self::isAllowedIp($ip, $allowPrivate)) {
                throw new RuntimeException('Remote host resolves to a blocked address');
            }
        }

        return $ips;
    }

    public static function isAllowedIp(string $ip, bool $allowPrivate): bool
    {
        if (filter_var($ip, FILTER_VALIDATE_IP) === false) {
            return false;
        }

        // Always blocked: loopback, link-local, multicast, reserved, unspecified.
        $alwaysBlocked = [
            '127.0.0.0/8', '::1/128',
            '169.254.0.0/16', 'fe80::/10',
            '224.0.0.0/4', 'ff00::/8',
            '0.0.0.0/8', '::/128',
            '240.0.0.0/4', '192.0.2.0/24', '198.18.0.0/15', '100.64.0.0/10',
        ];
        foreach ($alwaysBlocked as $cidr) {
            if (self::inCidr($ip, $cidr)) {
                return false;
            }
        }

        $private = [
            '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16',
            'fc00::/7', 'fd00::/8',
        ];
        foreach ($private as $cidr) {
            if (self::inCidr($ip, $cidr)) {
                return $allowPrivate;
            }
        }

        return true;
    }

    /** @return array<int,string> */
    private static function allowlist(): array
    {
        $raw = Config::i()->get('SSRF_ALLOWLIST', '');
        if ($raw === '') {
            return [];
        }
        return array_values(array_filter(array_map('trim', explode(',', $raw))));
    }

    /** @param array<int,string> $allowlist */
    private static function inAllowlist(string $hostOrIp, array $allowlist): bool
    {
        foreach ($allowlist as $entry) {
            if ($entry === '') {
                continue;
            }
            if (strcasecmp($entry, $hostOrIp) === 0) {
                return true;
            }
            if (str_contains($entry, '/') && self::inCidr($hostOrIp, $entry)) {
                return true;
            }
        }
        return false;
    }

    public static function inCidr(string $ip, string $cidr): bool
    {
        $parts = explode('/', $cidr);
        if (count($parts) !== 2) {
            return false;
        }
        [$subnet, $bits] = $parts;
        $bits = (int) $bits;

        $ipBin = @inet_pton($ip);
        $subnetBin = @inet_pton($subnet);
        if ($ipBin === false || $subnetBin === false || strlen($ipBin) !== strlen($subnetBin)) {
            return false;
        }
        $maxBits = strlen($ipBin) * 8;
        if ($bits < 0 || $bits > $maxBits) {
            return false;
        }

        $fullBytes = intdiv($bits, 8);
        $remaining = $bits % 8;

        if ($fullBytes > 0 && substr($ipBin, 0, $fullBytes) !== substr($subnetBin, 0, $fullBytes)) {
            return false;
        }
        if ($remaining === 0) {
            return true;
        }
        $mask = 0xFF << (8 - $remaining) & 0xFF;
        return (ord($ipBin[$fullBytes]) & $mask) === (ord($subnetBin[$fullBytes]) & $mask);
    }
}
