<?php

declare(strict_types=1);

namespace App\Jobs;

use App\Jobs\JobHandler;
use App\Services\JobService;

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
        } catch (\Throwable $e) {
            $msg = $e->getMessage();
            if ($msg === 'Job canceled') {
                error_log('[ansnew] job canceled ' . $id);
                // status already set by cancel()
            } else {
                JobService::fail($id, $msg);
                error_log('[ansnew] job error ' . $id . ': ' . $msg);
            }
        }
    }
}
