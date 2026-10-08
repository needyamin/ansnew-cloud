<?php

declare(strict_types=1);

/**
 * ANSNEW CLOUD worker entry point (compose service `worker`).
 */

use App\Config\Config;
use App\Jobs\Worker;
use App\Services\DownloadService;
use App\Services\ThumbnailService;
use App\Services\TrashService;
use App\Services\UploadService;

require dirname(__DIR__) . '/vendor/autoload.php';

Config::i();

// Occasional housekeeping thread via tick-like scheduling on the polling loop.
$lastSweep = 0;

$worker = new Worker();

// Wrap the loop: run trash retention sweep every ~6h inside the same process.
// (Worker::loop() never returns, so we install a periodic tick via pcntl_alarm
// when available; otherwise the sweep piggybacks on the worker recycle.)
//
// NOTE: job-lease renewal deliberately does NOT happen here. A signal handler
// runs between arbitrary opcodes, so a DB write from it could land inside a
// job's own transaction. Leases are renewed by JobService::progress() and by
// AbstractHandler::checkCancel() instead, which is sufficient: the reaper only
// runs while the worker is idle, and there is a single worker container, so a
// running job is never reclaimed out from under itself.
if (function_exists('pcntl_async_signals') && function_exists('pcntl_alarm')) {
    pcntl_async_signals(true);
    pcntl_signal(SIGALRM, static function () use (&$lastSweep): void {
        try {
            $n = TrashService::sweepRetention();
            if ($n > 0) {
                error_log("[ansnew] trash retention swept {$n} items");
            }
        } catch (\Throwable $e) {
            error_log('[ansnew] trash sweep failed: ' . $e->getMessage());
        }
        try {
            $t = ThumbnailService::prune(14);
            if ($t > 0) {
                error_log("[ansnew] thumbnail cache pruned {$t} files");
            }
        } catch (\Throwable $e) {
            error_log('[ansnew] thumbnail prune failed: ' . $e->getMessage());
        }
        // Both of these hold PLAINTEXT copies of user data (decrypted download
        // archives, and upload chunks staged before assembly), so they must not
        // be allowed to accumulate. sweepTmp() was defined but never called, so
        // abandoned archives previously lived on disk forever.
        try {
            $d = DownloadService::sweepTmp(21600);
            if ($d > 0) {
                error_log("[ansnew] temp download archives swept {$d}");
            }
        } catch (\Throwable $e) {
            error_log('[ansnew] temp archive sweep failed: ' . $e->getMessage());
        }
        try {
            $u = UploadService::sweepStaging(21600);
            if ($u > 0) {
                error_log("[ansnew] upload staging swept {$u}");
            }
        } catch (\Throwable $e) {
            error_log('[ansnew] upload staging sweep failed: ' . $e->getMessage());
        }
        pcntl_alarm(21600); // 6 hours
    });
    pcntl_alarm(21600);
}

$worker->loop();
