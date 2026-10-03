<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\DownloadService;
use App\Support\PathGuard;
use RuntimeException;

/**
 * download-folder: pack a folder server-side and expose it as a one-shot
 * download token (zip streaming handled by DownloadService).
 * params: {mount, path}
 */
final class DownloadFolderHandler extends AbstractHandler
{
    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $mount = (string) ($params['mount'] ?? '');
        $path = (string) ($params['path'] ?? '');
        if ($mount === '' || $path === '') {
            throw new RuntimeException('Missing download parameters');
        }
        if (PathGuard::normalize($path) === '/') {
            throw new RuntimeException('Refusing to pack the whole mount root — select subfolders instead');
        }

        self::progress($jobId, 2, 'Packing folder');

        $result = DownloadService::packFolder($mount, $path,
            function (int $done, int $total, string $current) use ($jobId): void {
                self::checkCancel($jobId);
                $pct = $total > 0 ? (int) (5 + 90 * $done / $total) : 50;
                self::progress($jobId, $pct, 'Packing ' . $current);
            },
            $jobId
        );

        self::progress($jobId, 100, 'Ready to download');
        return $result;
    }
}
