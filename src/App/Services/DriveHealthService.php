<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Config\Config;
use App\Core\Database;
use App\Storage\Mount;
use App\Storage\StorageManager;
use Throwable;

/**
 * Real drive / storage information: capacity, type and disk health.
 *
 * Everything here is best-effort and honest by design. The browser is not the
 * operating system: a web app cannot read SMART data by itself, and inside a
 * container it usually cannot read it at all (no `smartctl`, no device node,
 * no CAP_SYS_ADMIN). When a figure cannot be obtained the field is `null` and
 * `health.notes` says why — the UI then shows "Information unavailable"
 * instead of inventing a number.
 *
 * What IS reliably available:
 *   - filesystem capacity (total/free/used) for local mounts, via PHP's
 *     disk_total_space()/disk_free_space() on the resolved mount root;
 *   - the backing device, mount point and filesystem type, from /proc/mounts;
 *   - mount-scoped usage (bytes and file count) from the cached `du` scan.
 *
 * What is opportunistic:
 *   - SMART status, temperature, wear and error counters, by shelling out to
 *     `smartctl` if (and only if) that binary exists in the image. The command
 *     is built as an argv array and run through proc_open, so no shell is
 *     involved and there is no injection surface.
 */
final class DriveHealthService
{
    /** How long a health probe result is reused (seconds). smartctl is slow. */
    private const CACHE_TTL = 120;

    /** Hard ceiling on one smartctl invocation. */
    private const SMART_TIMEOUT = 6;

    /** Windows-style drive letters, assigned in mount order (C:, D:, …). */
    private const LETTERS = 'CDEFGHIJKLMNOPQRSTUVWXYZ';

    /**
     * Per-drive report for every drive the user can see.
     *
     * @return array<int, array<string,mixed>>
     */
    public static function forUser(AuthContext $user, bool $refresh = false): array
    {
        $mounts = StorageManager::mountsFor($user);
        $out = [];
        $i = 0;
        foreach ($mounts as $mount) {
            $letter = self::LETTERS[$i] ?? null;
            $out[] = self::forMount($user, $mount, $letter !== null ? $letter . ':' : null, $refresh);
            $i++;
        }
        return $out;
    }

    /**
     * One drive's report.
     *
     * @return array<string,mixed>
     */
    public static function forMount(AuthContext $user, Mount $mount, ?string $letter = null, bool $refresh = false): array
    {
        $cached = $refresh ? null : self::cached($mount->name);
        if ($cached !== null) {
            $cached['letter'] = $letter;
            return $cached;
        }

        $report = self::probe($mount);
        $report['letter'] = $letter;
        $report['scannedAt'] = gmdate('c');

        try {
            Database::i()->run(
                'INSERT INTO settings (k, v, updated_at) VALUES (:k, :v, datetime(\'now\'))
                 ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = datetime(\'now\')',
                [':k' => 'health:' . $mount->name, ':v' => json_encode($report, JSON_UNESCAPED_UNICODE) ?: '{}']
            );
        } catch (Throwable) {
            // A cache write failure must never break the page.
        }
        return $report;
    }

    /** @return array<string,mixed>|null */
    private static function cached(string $mountName): ?array
    {
        try {
            $raw = Database::i()->scalar('SELECT v FROM settings WHERE k = :k', [':k' => 'health:' . $mountName]);
        } catch (Throwable) {
            return null;
        }
        if (!is_string($raw) || $raw === '') {
            return null;
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            return null;
        }
        $age = time() - (int) strtotime((string) ($data['scannedAt'] ?? ''));
        return ($age >= 0 && $age < self::CACHE_TTL) ? $data : null;
    }

    /**
     * @return array<string,mixed>
     */
    private static function probe(Mount $mount): array
    {
        $notes = [];
        $root = self::rootFor($mount);

        $capacity = self::capacity($root, $notes);
        $device = $root !== null ? self::deviceFor($root) : null;
        $health = self::health($device, $notes);

        $usage = self::usage($mount->name);

        return [
            // The mount id, so the UI can rename/disconnect straight from here.
            'id' => $mount->id,
            'mount' => $mount->name,
            'label' => $mount->label,
            'adapter' => $mount->adapter,
            'type' => self::typeLabel($mount, $device),
            'fileSystem' => $device['fsType'] ?? null,
            'device' => $device['device'] ?? null,
            'mountPoint' => $device['mountPoint'] ?? null,
            'root' => $root,
            'rotational' => $device['rotational'] ?? null,
            'readOnly' => $mount->readOnly,
            'canWrite' => $mount->canWrite,
            'quotaBytes' => $mount->quotaBytes,
            'capacity' => $capacity,
            'usage' => $usage,
            'health' => $health,
            'notes' => $notes,
        ];
    }

    /** Absolute filesystem root behind a mount, or null for remote adapters. */
    private static function rootFor(Mount $mount): ?string
    {
        if ($mount->adapter !== 'local') {
            return null;
        }
        $root = $mount->localRoot !== null && $mount->localRoot !== ''
            ? $mount->localRoot
            : Config::i()->storageRoot() . '/' . $mount->name;
        if (!is_dir($root)) {
            @mkdir($root, 0770, true);
        }
        $real = @realpath($root);
        return $real === false ? null : $real;
    }

    /**
     * Filesystem capacity behind the mount root.
     *
     * @param array<int,string> $notes
     * @return array<string,mixed>
     */
    private static function capacity(?string $root, array &$notes): array
    {
        if ($root === null) {
            $notes[] = 'Capacity is reported by the operating system for local drives only; this drive is reached over the network.';
            return self::unavailableCapacity('Remote storage — the server does not own this filesystem');
        }
        $total = @disk_total_space($root);
        $free = @disk_free_space($root);
        if (!is_float($total) && !is_int($total)) {
            $total = null;
        }
        if (!is_float($free) && !is_int($free)) {
            $free = null;
        }
        if ($total === null || $free === null || $total <= 0) {
            $notes[] = 'The PHP runtime could not stat the filesystem behind this drive.';
            return self::unavailableCapacity('Not reported by the operating system');
        }
        $used = max(0, (int) $total - (int) $free);
        return [
            'available' => true,
            'total' => (int) $total,
            'free' => (int) $free,
            'used' => $used,
            'percent' => round($used * 100 / max(1, (int) $total), 1),
            // The whole filesystem is measured, not just this mount's folder —
            // other data on the same volume counts towards "used".
            'scope' => 'filesystem',
            'reason' => null,
        ];
    }

    /** @return array<string,mixed> */
    private static function unavailableCapacity(string $reason): array
    {
        return [
            'available' => false,
            'total' => null,
            'free' => null,
            'used' => null,
            'percent' => null,
            'scope' => null,
            'reason' => $reason,
        ];
    }

    /**
     * Mount-scoped usage from the cached `du` scan (null until one is run).
     * @return array<string,mixed>
     */
    private static function usage(string $mountName): array
    {
        try {
            $raw = Database::i()->scalar('SELECT v FROM settings WHERE k = :k', [':k' => 'usage:' . $mountName]);
        } catch (Throwable) {
            $raw = null;
        }
        $data = is_string($raw) ? json_decode($raw, true) : null;
        if (!is_array($data)) {
            return ['available' => false, 'used' => null, 'files' => null, 'dirs' => null, 'scannedAt' => null];
        }
        return [
            'available' => true,
            'used' => (int) ($data['used'] ?? 0),
            'files' => (int) ($data['files'] ?? 0),
            'dirs' => (int) ($data['dirs'] ?? 0),
            'scannedAt' => $data['scannedAt'] ?? null,
        ];
    }

    /** Human label for the drive's kind, Windows "This PC" style. */
    private static function typeLabel(Mount $mount, ?array $device): string
    {
        $fs = $device['fsType'] ?? null;
        return match ($mount->adapter) {
            'local' => $fs !== null && $fs !== ''
                ? 'Local disk (' . $fs . ')'
                : 'Local disk',
            'ftp', 'ftps' => 'Network drive (FTP)',
            'sftp' => 'Network drive (SFTP)',
            'smb' => 'Network drive (SMB)',
            'http' => 'Network drive (WebDAV)',
            's3' => 'Cloud storage (S3)',
            default => 'Drive',
        };
    }

    /**
     * Resolve the backing device / mount point / filesystem for a path by
     * reading /proc/mounts (Linux). Returns null where that is not available.
     *
     * @return array{device:string,mountPoint:string,fsType:string,rotational:?bool}|null
     */
    private static function deviceFor(string $path): ?array
    {
        $mounts = @file('/proc/mounts', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (!is_array($mounts)) {
            return null;
        }
        $best = null;
        $bestLen = -1;
        foreach ($mounts as $line) {
            // Fields: device mountpoint fstype options dump pass.
            // Mount points are octal-escaped (\040 = space); unescape enough to
            // compare, since a space in a path would otherwise never match.
            $parts = preg_split('/\s+/', $line);
            if (!is_array($parts) || count($parts) < 3) {
                continue;
            }
            [$device, $mountPoint, $fsType] = $parts;
            $mountPoint = stripcslashes($mountPoint);
            if ($path !== $mountPoint && !str_starts_with($path, rtrim($mountPoint, '/') . '/')) {
                continue;
            }
            if (strlen($mountPoint) > $bestLen) {
                $bestLen = strlen($mountPoint);
                $best = ['device' => $device, 'mountPoint' => $mountPoint, 'fsType' => $fsType];
            }
        }
        if ($best === null) {
            return null;
        }
        $best['rotational'] = self::rotational($best['device']);
        return $best;
    }

    /** SSD vs HDD, from sysfs. Null when the device is virtual or unknown. */
    private static function rotational(string $device): ?bool
    {
        $base = self::blockName($device);
        if ($base === null) {
            return null;
        }
        $f = '/sys/block/' . $base . '/queue/rotational';
        if (!is_readable($f)) {
            return null;
        }
        $v = trim((string) @file_get_contents($f));
        return $v === '' ? null : ($v === '1');
    }

    /** /dev/sda1 -> sda ; /dev/nvme0n1p1 -> nvme0n1 */
    private static function blockName(string $device): ?string
    {
        if (!str_starts_with($device, '/dev/')) {
            return null;
        }
        $name = basename($device);
        $name = preg_replace('/(\d+)$/', '', $name) ?? '';           // sda1 -> sda
        $name = preg_replace('/p\d+$/', '', $name) ?? '';            // nvme0n1p3 -> nvme0n1
        return $name === '' ? null : $name;
    }

    /**
     * Disk health. Everything is null unless SMART data can actually be read.
     *
     * @param array{device:string,mountPoint:string,fsType:string,rotational:?bool}|null $device
     * @param array<int,string> $notes
     * @return array<string,mixed>
     */
    private static function health(?array $device, array &$notes): array
    {
        $empty = [
            'available' => false,
            'status' => 'unknown',
            'statusLabel' => 'Information unavailable',
            'smartPassed' => null,
            'temperatureC' => null,
            'temperatureMaxC' => null,
            'wearPercent' => null,
            'lifeRemainingPercent' => null,
            'readErrors' => null,
            'writeErrors' => null,
            'reallocatedSectors' => null,
            'powerOnHours' => null,
            'model' => null,
            'serial' => null,
            'reason' => null,
            'notes' => [],
        ];

        if (!Config::i()->getBool('ANSNEW_SMART_ENABLED', true)) {
            $empty['reason'] = 'Disk health probing is disabled by configuration (ANSNEW_SMART_ENABLED=0).';
            return $empty;
        }
        if ($device === null) {
            $empty['reason'] = 'The operating system did not expose a backing device for this path.';
            $notes[] = 'No /proc/mounts entry matched this drive, so there is nothing to query for SMART data.';
            return $empty;
        }
        $dev = $device['device'];
        if (!str_starts_with($dev, '/dev/')) {
            $empty['reason'] = 'This path is backed by "' . $dev . '", which is not a physical disk.';
            $notes[] = 'Virtual and network filesystems have no SMART data of their own.';
            return $empty;
        }
        $binary = self::which('smartctl');
        if ($binary === null) {
            $empty['reason'] = 'smartctl (smartmontools) is not installed in this container.';
            $notes[] = 'Install smartmontools in the image and give the container access to ' . $dev . ' to see health data.';
            return $empty;
        }
        if (!is_readable($dev)) {
            $empty['reason'] = 'The container cannot open ' . $dev . ' (no device access).';
            $notes[] = 'SMART needs the raw device node; pass it through to the container to enable health data.';
            return $empty;
        }

        $out = self::smartJson($binary, $dev);
        if ($out === null) {
            $empty['reason'] = 'smartctl ran but returned no usable data for ' . $dev . '.';
            $notes[] = 'Most virtualised and USB-attached disks do not answer SMART queries.';
            return $empty;
        }

        return self::parseSmart($out, $empty);
    }

    /**
     * Run smartctl and decode its JSON. Two flag spellings are tried because
     * `--json=c` (compact) only exists in newer smartmontools releases.
     *
     * @return array<string,mixed>|null
     */
    private static function smartJson(string $binary, string $device): ?array
    {
        foreach ([['-a', '--json=c', $device], ['-a', '--json', $device]] as $args) {
            array_unshift($args, $binary);
            $r = self::runCommand($args, self::SMART_TIMEOUT);
            if ($r['out'] === '') {
                continue;
            }
            // smartctl may print a warning line before the JSON object.
            $start = strpos($r['out'], '{');
            if ($start === false) {
                continue;
            }
            $decoded = json_decode(substr($r['out'], $start), true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }
        return null;
    }

    /**
     * @param array<string,mixed> $json
     * @param array<string,mixed> $empty
     * @return array<string,mixed>
     */
    private static function parseSmart(array $json, array $empty): array
    {
        $out = $empty;
        $notes = [];

        $device = is_array($json['device'] ?? null) ? $json['device'] : [];
        $info = is_array($device['info'] ?? null) ? $device['info'] : [];
        $out['model'] = isset($info['model_name']) ? (string) $info['model_name'] : null;
        $out['serial'] = isset($info['serial_number']) ? (string) $info['serial_number'] : null;

        $smart = is_array($json['smart_status'] ?? null) ? $json['smart_status'] : [];
        if (array_key_exists('passed', $smart)) {
            $out['smartPassed'] = (bool) $smart['passed'];
        }

        $temp = is_array($json['temperature'] ?? null) ? $json['temperature'] : [];
        if (isset($temp['current']) && is_numeric($temp['current'])) {
            $out['temperatureC'] = (float) $temp['current'];
        }
        if (isset($temp['drive_trip']) && is_numeric($temp['drive_trip'])) {
            $out['temperatureMaxC'] = (float) $temp['drive_trip'];
        }

        $pot = is_array($json['power_on_time'] ?? null) ? $json['power_on_time'] : [];
        if (isset($pot['hours']) && is_numeric($pot['hours'])) {
            $out['powerOnHours'] = (int) $pot['hours'];
        }

        // NVMe carries its own log with different field names.
        $nvme = is_array($json['nvme_smart_health_information_log'] ?? null)
            ? $json['nvme_smart_health_information_log'] : [];
        if ($out['temperatureC'] === null && isset($nvme['temperature']) && is_numeric($nvme['temperature'])) {
            $out['temperatureC'] = (float) $nvme['temperature'];
        }
        if (isset($nvme['percentage_used']) && is_numeric($nvme['percentage_used'])) {
            $out['wearPercent'] = (float) $nvme['percentage_used'];
            $out['lifeRemainingPercent'] = round(100 - (float) $nvme['percentage_used'], 1);
        } elseif (isset($nvme['available_spare']) && is_numeric($nvme['available_spare'])) {
            $out['lifeRemainingPercent'] = (float) $nvme['available_spare'];
            $out['wearPercent'] = round(100 - (float) $nvme['available_spare'], 1);
        }
        if (isset($nvme['media_errors']) && is_numeric($nvme['media_errors'])) {
            $out['readErrors'] = (int) $nvme['media_errors'];
        }

        // ATA/SATA attribute table.
        $attrs = [];
        $table = is_array(($json['ata_smart_attributes']['table'] ?? null)) ? $json['ata_smart_attributes']['table'] : [];
        foreach ($table as $row) {
            if (!is_array($row) || !isset($row['name'])) {
                continue;
            }
            $raw = null;
            if (is_array($row['raw'] ?? null) && isset($row['raw']['value'])) {
                $raw = is_numeric($row['raw']['value']) ? (int) $row['raw']['value'] : null;
            } elseif (isset($row['raw']) && is_numeric($row['raw'])) {
                $raw = (int) $row['raw'];
            }
            $attrs[(string) $row['name']] = $raw;
        }
        if ($attrs !== []) {
            if ($out['readErrors'] === null && isset($attrs['Reported_Uncorrect'])) {
                $out['readErrors'] = $attrs['Reported_Uncorrect'];
            }
            if (isset($attrs['Write_Error_Rate'])) {
                $out['writeErrors'] = $attrs['Write_Error_Rate'];
            }
            if (isset($attrs['Reallocated_Sector_Ct'])) {
                $out['reallocatedSectors'] = $attrs['Reallocated_Sector_Ct'];
            }
            if ($out['wearPercent'] === null) {
                // SSDs report life either as "left" or as "used"; both are common.
                if (isset($attrs['Percent_Life_Remaining'])) {
                    $out['lifeRemainingPercent'] = (float) $attrs['Percent_Life_Remaining'];
                    $out['wearPercent'] = round(100 - (float) $attrs['Percent_Life_Remaining'], 1);
                } elseif (isset($attrs['Media_Wearout_Indicator'])) {
                    $out['lifeRemainingPercent'] = (float) $attrs['Media_Wearout_Indicator'];
                    $out['wearPercent'] = round(100 - (float) $attrs['Media_Wearout_Indicator'], 1);
                } elseif (isset($attrs['SSD_Life_Left'])) {
                    $out['lifeRemainingPercent'] = (float) $attrs['SSD_Life_Left'];
                    $out['wearPercent'] = round(100 - (float) $attrs['SSD_Life_Left'], 1);
                } elseif (isset($attrs['Percent_Lifetime_Used'])) {
                    $out['wearPercent'] = (float) $attrs['Percent_Lifetime_Used'];
                    $out['lifeRemainingPercent'] = round(100 - (float) $attrs['Percent_Lifetime_Used'], 1);
                }
            }
            if ($out['powerOnHours'] === null && isset($attrs['Power_On_Hours'])) {
                $out['powerOnHours'] = $attrs['Power_On_Hours'];
            }
        }
        $out['attributes'] = $attrs;

        // A single readable figure is enough to call health reporting available.
        $hasData = $out['smartPassed'] !== null || $out['temperatureC'] !== null
            || $out['wearPercent'] !== null || $out['reallocatedSectors'] !== null;
        if ($hasData) {
            $out['available'] = true;
            $out['status'] = $out['smartPassed'] === false ? 'failed' : 'ok';
            $out['statusLabel'] = $out['smartPassed'] === false ? 'SMART: failing' : 'SMART: passing';
            if ($out['smartPassed'] === null) {
                $notes[] = 'SMART overall-health self-test was not reported by the device.';
            }
        } else {
            $out['reason'] = 'The device answered, but reported no health attributes.';
        }
        $out['notes'] = $notes;
        return $out;
    }

    /**
     * Locate a binary on PATH without a shell.
     */
    private static function which(string $name): ?string
    {
        $path = (string) (getenv('PATH') ?: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
        $candidates = [$name];
        if (DIRECTORY_SEPARATOR === '\\') {
            $candidates[] = $name . '.exe';
        }
        foreach (explode(PATH_SEPARATOR, $path) as $dir) {
            if ($dir === '') {
                continue;
            }
            foreach ($candidates as $candidate) {
                $full = rtrim($dir, '/\\') . DIRECTORY_SEPARATOR . $candidate;
                if (is_file($full) && is_executable($full)) {
                    return $full;
                }
            }
        }
        return null;
    }

    /**
     * Run a command as an argv array (no shell) with a hard timeout.
     *
     * @param array<int,string> $argv
     * @return array{out:string,err:string,code:int}
     */
    private static function runCommand(array $argv, int $timeoutSec): array
    {
        $desc = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];
        $pipes = [];
        $proc = @proc_open($argv, $desc, $pipes);
        if (!is_resource($proc)) {
            return ['out' => '', 'err' => '', 'code' => -1];
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $out = '';
        $err = '';
        $deadline = microtime(true) + max(1, $timeoutSec);
        $running = true;
        while (microtime(true) < $deadline) {
            $chunk = fread($pipes[1], 65536);
            if (is_string($chunk) && $chunk !== '') {
                $out .= $chunk;
            }
            $chunk = fread($pipes[2], 65536);
            if (is_string($chunk) && $chunk !== '') {
                $err .= $chunk;
            }
            $status = proc_get_status($proc);
            if (!$status['running']) {
                $running = false;
                break;
            }
            usleep(40000);
        }
        if ($running) {
            proc_terminate($proc, 9);
        }
        // Drain whatever is buffered after the process exits.
        $out .= (string) stream_get_contents($pipes[1]);
        $err .= (string) stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $code = proc_close($proc);
        return ['out' => $out, 'err' => $err, 'code' => is_int($code) ? $code : -1];
    }
}
