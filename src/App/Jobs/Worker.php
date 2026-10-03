<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Jobs\JobHandler;
use App\Services\JobService;
use App\Services\NotifyService;

/**
 * CLI worker: claims queued jobs and executes them.
 * Runs inside its own container (compose service `worker`).
 */
final class Worker
{
    private int $jobsProcessed = 0;

    public function loop(): never
    {
        error_log('[ansnew] worker started (pid ' . getmypid() . ')');
        while (true) {
            $job = JobService::claimNext();
            if ($job === null) {
                usleep(500_000);
                continue;
            }
            $this->execute($job);
            $this->jobsProcessed++;
            // Recycle the process periodically to release memory.
            if ($this->jobsProcessed >= 200) {
                error_log('[ansnew] worker recycling after 200 jobs');
                exit(0);
            }
        }
    }

    /** @param array<string,mixed> $job */
    private function execute(array $job): void
    {
        $id = (string) $job['id'];
        $type = (string) $job['type'];
        $params = json_decode((string) $job['params'], true);
        if (!is_array($params)) {
            $params = [];
        }

        error_log('[ansnew] job start ' . $type . ' ' . $id);
        try {
            $result = JobHandler::run($type, $params, $id);
            JobService::finish($id, $result);
            error_log('[ansnew] job done ' . $type . ' ' . $id);
            // Terminal state (success or failure) is the moment the directory
            // listing actually changed — tell open panes to revalidate.
            $this->notifyChange($job, $type, $params);
        } catch (\Throwable $e) {
            $msg = $e->getMessage();
            if ($msg === 'Job canceled') {
                error_log('[ansnew] job canceled ' . $id);
                // status already set by cancel()
            } else {
                JobService::fail($id, $msg);
                error_log('[ansnew] job error ' . $id . ': ' . $msg);
            }
            // A canceled or failed job may still have changed things part-way.
            $this->notifyChange($job, $type, $params);
        }
    }

    /** @param array<string,mixed> $job @param array<string,mixed> $params */
    private function notifyChange(array $job, string $type, array $params): void
    {
        try {
            JobService::notifyFsChange((int) $job['user_id'], $type, $params);
        } catch (\Throwable $e) {
            // Never let a notification problem fail an otherwise good job.
        }
    }
}
