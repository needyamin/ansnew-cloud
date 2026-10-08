<?php

declare(strict_types=1);

namespace App\Jobs;

/**
 * Job handler registry. Each handler is a static method on a class named
 * after the job type: App\Jobs\Handlers\<Type>Handler::run(array $params, string $jobId)
 */
final class JobHandler
{
    public const TYPES = [
        'archive' => 1,
        'extract' => 1,
        'copy' => 1,
        'move' => 1,
        'delete' => 1,
        'du' => 1,
        'download-folder' => 1,
        'download-selection' => 1,
        'backup' => 1,
        'backup-verify' => 1,
    ];

    public static function run(string $type, array $params, string $jobId): array
    {
        $map = [
            'archive' => 'ArchiveHandler',
            'extract' => 'ExtractHandler',
            'copy' => 'CopyHandler',
            'move' => 'MoveHandler',
            'delete' => 'DeleteHandler',
            'du' => 'DuHandler',
            'download-folder' => 'DownloadFolderHandler',
            'download-selection' => 'DownloadSelectionHandler',
            'backup' => 'BackupHandler',
            'backup-verify' => 'BackupVerifyHandler',
        ];
        $class = __NAMESPACE__ . '\\Handlers\\' . $map[$type];
        if (!class_exists($class)) {
            throw new \RuntimeException('Handler missing for job type: ' . $type);
        }
        return $class::run($params, $jobId);
    }
}
