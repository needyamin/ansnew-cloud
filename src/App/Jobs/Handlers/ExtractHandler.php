<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\ArchiveService;
use App\Support\PathGuard;
use RuntimeException;

/**
 * extract: unpack an archive into a destination directory.
 * params: {mount, path, destDir}
 */
final class ExtractHandler extends AbstractHandler
{
    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $mount = (string) ($params['mount'] ?? '');
        $path = (string) ($params['path'] ?? '');
        $destDir = (string) ($params['destDir'] ?? '');
        if ($mount === '' || $path === '' || $destDir === '') {
            throw new RuntimeException('Missing extract parameters');
        }

        self::progress($jobId, 2, 'Opening archive');

        $result = ArchiveService::extract(
            $mount, $path, $destDir,
            function (int $done, int $total, string $current) use ($jobId): void {
                self::checkCancel($jobId);
                $pct = $total > 0 ? (int) (5 + 90 * $done / $total) : 50;
                self::progress($jobId, $pct, 'Extracting ' . $current);
            },
            $jobId
        );

        self::progress($jobId, 100, 'Extraction complete');
        return $result;
    }
}
