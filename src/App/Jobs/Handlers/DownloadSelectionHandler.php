<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\DownloadService;
use App\Services\JobService;
use App\Support\PathGuard;
use RuntimeException;

/**
 * download-selection: pack an arbitrary selection (files, folders, or both)
 * into one zip and expose it as a one-shot download token.
 * params: {mount, paths: [...], name}
 */
final class DownloadSelectionHandler extends AbstractHandler
{
    /** Higher than a folder pack: an empty or huge selection is common. */
    private const MAX_PATHS = 500;

    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $mount = (string) ($params['mount'] ?? '');
        $raw = $params['paths'] ?? null;
        $paths = is_array($raw) ? array_values(array_map('strval', $raw)) : [];
        if ($mount === '' || !$paths) {
            throw new RuntimeException('Missing download parameters');
        }
        if (count($paths) > self::MAX_PATHS) {
            throw new RuntimeException('Too many items in one download (max ' . self::MAX_PATHS . ')');
        }
        foreach ($paths as $p) {
            if (PathGuard::normalize($p) === '/') {
                throw new RuntimeException('Refusing to pack the whole mount root — select subfolders instead');
            }
        }

        self::progress($jobId, 2, 'Preparing download', ['phase' => 'scan']);

        $name = (string) ($params['name'] ?? '');
        $result = DownloadService::packSelection(
            $mount,
            $paths,
            $name,
            static function (int $done, int $total, string $current, array $meta = []) use ($jobId): void {
                self::checkCancel($jobId);
                $pct = $total > 0 ? (int) (2 + 95 * $done / $total) : 50;
                self::progress($jobId, $pct, 'Packing ' . $current, $meta);
            },
            $jobId
        );

        JobService::progress($jobId, 100, 'Ready to download');
        return $result;
    }
}
