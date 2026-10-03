<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\ArchiveService;
use App\Support\PathGuard;
use RuntimeException;

/**
 * archive: create a zip/tar.gz from selected paths.
 * params: {mount, paths: string[], destDir, format: zip|tar.gz, name}
 */
final class ArchiveHandler extends AbstractHandler
{
    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $mount = (string) ($params['mount'] ?? '');
        $paths = $params['paths'] ?? [];
        $destDir = (string) ($params['destDir'] ?? '/');
        $format = in_array($params['format'] ?? 'zip', ['zip', 'tar.gz'], true) ? (string) $params['format'] : 'zip';
        $name = (string) ($params['name'] ?? '');

        if (!is_array($paths) || $paths === []) {
            throw new RuntimeException('No paths to archive');
        }
        $paths = array_values(array_map('strval', $paths));

        $archiveName = $name !== '' ? PathGuard::validateName($name) : 'archive-' . gmdate('Ymd-His') . '.' . ($format === 'zip' ? 'zip' : 'tar.gz');

        self::progress($jobId, 2, 'Preparing archive');

        $result = ArchiveService::create(
            $mount, $paths, $destDir, $archiveName, $format,
            function (int $done, int $total, string $current) use ($jobId): void {
                self::checkCancel($jobId);
                $pct = $total > 0 ? (int) (5 + 90 * $done / $total) : 50;
                self::progress($jobId, $pct, 'Archiving ' . $current);
            },
            $jobId
        );

        self::progress($jobId, 100, 'Archive created');
        return $result;
    }
}
