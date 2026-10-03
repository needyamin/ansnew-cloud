<?php

declare(strict_types=1);

namespace App\Jobs\Handlers;

use App\Services\UsageService;

/**
 * du: storage usage scan.
 * params: {mount}
 */
final class DuHandler extends AbstractHandler
{
    /** @param array<string,mixed> $params */
    public static function run(array $params, string $jobId): array
    {
        $mount = (string) ($params['mount'] ?? '');
        if ($mount === '') {
            throw new \RuntimeException('Missing mount');
        }
        self::progress($jobId, 5, 'Scanning storage');
        $userId = (int) ($params['userId'] ?? 0);
        $result = UsageService::scan($userId, $mount,
            function (int $pct, string $msg) use ($jobId): void {
                self::checkCancel($jobId);
                self::progress($jobId, $pct, $msg);
            });
        self::progress($jobId, 100, 'Scan complete');
        return $result;
    }
}
