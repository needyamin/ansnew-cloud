<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\TrashService;
use App\Support\PathGuard;
use RuntimeException;

/**
 * delete: background recursive delete (to trash when available, else permanent).
 * params: {mount, path, permanent: bool}
 */
final class DeleteHandler extends AbstractHandler
{
    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $mount = (string) ($params['mount'] ?? '');
        $path = (string) ($params['path'] ?? '');
        $permanent = (bool) ($params['permanent'] ?? false);
        $userId = (int) ($params['userId'] ?? 0);

        if ($mount === '' || $path === '') {
            throw new RuntimeException('Missing delete parameters');
        }

        self::progress($jobId, 1, 'Deleting ' . PathGuard::basename($path));

        $result = TrashService::deletePath($mount, $path, $permanent,
            function (int $done, int $total, string $current) use ($jobId): void {
                self::checkCancel($jobId);
                $pct = $total > 0 ? (int) (5 + 90 * $done / $total) : 50;
                self::progress($jobId, $pct, 'Deleting ' . $current);
            },
            $userId
        );

        self::progress($jobId, 100, 'Delete complete');
        return $result;
    }
}
