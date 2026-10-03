<?php

declare(strict_types=1);

/**
 * ANSNEW CLOUD worker entry point (compose service `worker`).
 */

use App\Config\Config;
use App\Jobs\Worker;
use App\Services\ThumbnailService;
use App\Services\TrashService;

require dirname(__DIR__) . '/vendor/autoload.php';

Config::i();

// Occasional housekeeping thread via tick-like scheduling on the polling loop.
$lastSweep = 0;

$worker = new Worker();

// Wrap the loop: run trash retention sweep every ~6h inside the same process.
// (Worker::loop() never returns, so we install a periodic tick via pcntl_alarm
// when available; otherwise the sweep piggybacks on the worker recycle.)
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
        pcntl_alarm(21600); // 6 hours
    });
    pcntl_alarm(21600);
}

$worker->loop();
