<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\FileService;
use App\Support\PathGuard;
use RuntimeException;

/**
 * move: background recursive move (possibly across mounts; copy + delete).
 * params: {mount, path, destMount, destDir, conflict: overwrite|skip|rename}
 */
final class MoveHandler extends AbstractHandler
{
    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $mount = (string) ($params['mount'] ?? '');
        $path = (string) ($params['path'] ?? '');
        $destMount = (string) ($params['destMount'] ?? $mount);
        $destDir = (string) ($params['destDir'] ?? '/');
        $conflict = in_array($params['conflict'] ?? 'rename', ['overwrite', 'skip', 'rename'], true)
            ? (string) $params['conflict'] : 'rename';

        if ($mount === '' || $path === '') {
            throw new RuntimeException('Missing move parameters');
        }

        self::progress($jobId, 1, 'Moving ' . PathGuard::basename($path));

        $result = FileService::moveTransfer(
            $mount, $path, $destMount, $destDir, $conflict,
            function (int $done, int $total, string $current) use ($jobId): void {
                self::checkCancel($jobId);
                $pct = $total > 0 ? (int) (5 + 90 * $done / $total) : 50;
                self::progress($jobId, $pct, 'Moving ' . $current);
            },
            $jobId
        );

        self::progress($jobId, 100, 'Move complete');
        return $result;
    }
}
