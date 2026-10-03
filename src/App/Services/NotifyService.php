<?php

declare(strict_types=1);

namespace App\Services;

use App\Config\Config;
use App\Core\Database;
use Throwable;

/**
 * Best-effort push to the Node WebSocket server (internal shared secret).
 *
 * This is the single outbound path for realtime events. It was extracted from
 * JobService so that filesystem change notifications could reuse the same
 * transport instead of duplicating the curl/timeout handling.
 *
 * Every call is fire-and-forget: the WS server being slow or down must never
 * affect the request or job that triggered the notification. The UI degrades to
 * its own polling in that case.
 */
final class NotifyService
{
    /** Longest we are willing to wait for the WS server. */
    private const TIMEOUT_MS = 600;

    /**
     * @param int[]                 $userIds
     * @param array<string,mixed>   $data
     */
    public static function push(array $userIds, string $event, array $data): void
    {
        $userIds = array_values(array_unique(array_map('intval', $userIds)));
        if ($userIds === []) {
            return;
        }
        try {
            $payload = json_encode([
                'userIds' => $userIds,
                'event' => $event,
                'data' => $data,
            ], JSON_UNESCAPED_UNICODE);
            if ($payload === false) {
                return;
            }

            $url = Config::i()->get('WS_INTERNAL_URL', 'http://ws:3001') . '/internal/notify';
            $ch = curl_init($url);
            if ($ch === false) {
                return;
            }
            curl_setopt_array($ch, [
                CURLOPT_POST => true,
                CURLOPT_POSTFIELDS => $payload,
                CURLOPT_HTTPHEADER => [
                    'Content-Type: application/json',
                    'X-Internal-Secret: ' . Config::i()->wsSecret(),
                ],
                // CRITICAL: without RETURNTRANSFER, curl_exec() writes the
                // response straight into the output buffer. Because this runs
                // inside HTTP request handlers, that injected the WS server's
                // {"ok":true} into the caller's own response body and corrupted
                // every mutating API reply. Harmless while this code only ran in
                // the CLI worker; fatal once it ran on the request path.
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT_MS => self::TIMEOUT_MS,
                CURLOPT_CONNECTTIMEOUT_MS => 300,
                CURLOPT_NOSIGNAL => true,
            ]);
            curl_exec($ch);
            curl_close($ch);
        } catch (Throwable $e) {
            // Non-fatal by design: the UI also polls /api/jobs.
        }
    }

    /**
     * Announce that one or more directories changed, so every open pane showing
     * one of them can revalidate instead of waiting for a manual refresh.
     *
     * @param array<string,string[]> $dirsByMount mount name => list of directories.
     *                                           A '/' entry means "the whole mount".
     */
    public static function fsChanged(int $userId, array $dirsByMount, string $reason): void
    {
        $dirsByMount = array_filter($dirsByMount, static fn ($dirs) => is_array($dirs) && $dirs !== []);
        if ($dirsByMount === []) {
            return;
        }
        self::push([$userId], 'fs.changed', [
            'mounts' => $dirsByMount,
            'reason' => $reason,
            'ts' => time(),
        ]);
    }
}
