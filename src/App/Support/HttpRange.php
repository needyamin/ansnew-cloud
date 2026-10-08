<?php

declare(strict_types=1);

namespace App\Support;

/**
 * HTTP single-range parsing for streamed media.
 *
 * Media players (video/audio) rely on 206 Partial Content to stream and to seek
 * without downloading a whole file. Without it the browser can only buffer from
 * the start, so a large clip stutters and seeking does nothing.
 *
 * Only a single "bytes=" range is supported (which is all browsers send for
 * media); multi-range requests fall back to the full body, which is always a
 * valid response.
 */
final class HttpRange
{
    /**
     * @return array{start:int,end:int,partial:bool} end < start means the range
     *         is unsatisfiable (caller should reply 416); partial=true means a
     *         206 must be sent for [start,end].
     */
    public static function parse(?string $header, int $size): array
    {
        $full = ['start' => 0, 'end' => max(0, $size - 1), 'partial' => false];

        if ($header === null || $header === '' || $size <= 0) {
            return $full;
        }
        $header = trim($header);
        if (preg_match('/^bytes=(\d*)-(\d*)$/i', $header, $m) !== 1) {
            return $full; // multi-range or malformed -> full body
        }
        $startRaw = $m[1];
        $endRaw = $m[2];
        if ($startRaw === '' && $endRaw === '') {
            return $full;
        }

        if ($startRaw === '') {
            // Suffix range: the last N bytes.
            $n = (int) $endRaw;
            if ($n <= 0) {
                return ['start' => 0, 'end' => -1, 'partial' => true]; // unsatisfiable
            }
            $start = max(0, $size - $n);
            $end = $size - 1;
        } else {
            $start = (int) $startRaw;
            $end = $endRaw === '' ? $size - 1 : (int) $endRaw;
        }

        if ($start >= $size) {
            return ['start' => 0, 'end' => -1, 'partial' => true]; // unsatisfiable
        }
        if ($end < $start) {
            return ['start' => 0, 'end' => -1, 'partial' => true];
        }
        $end = min($end, $size - 1);

        return ['start' => $start, 'end' => $end, 'partial' => true];
    }
}
