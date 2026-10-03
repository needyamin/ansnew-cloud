<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Config\Config;
use App\Storage\StorageManager;
use RuntimeException;

/**
 * Server-side image thumbnails with a disk cache.
 *
 * Bytes are read through the storage adapter, so this works transparently for
 * encrypted local files. The cache lives under data/thumbs and is never
 * web-served — it is streamed back through the API so the normal session check
 * applies (nginx blocks /data/).
 */
final class ThumbnailService
{
    /** Refuse to decode anything larger than this. */
    private const MAX_SOURCE_BYTES = 20 * 1024 * 1024;   // 20 MiB
    /** Reject absurd pixel counts before allocating a GD canvas. */
    private const MAX_DIM = 8000;
    /** Allowed output widths; anything else snaps to the nearest. */
    public const SIZES = [128, 256, 512];

    private const IMAGE_MIMES = [
        'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
        'image/avif', 'image/x-ms-bmp',
    ];

    /**
     * @return array{file:string, mime:string}
     * @throws RuntimeException when the source is not a thumbnailable image
     */
    public static function generate(AuthContext $user, string $mountName, string $path, int $size): array
    {
        $size = self::snapSize($size);
        [$mount, $adapter, $norm] = StorageManager::resolve($user, $mountName, $path);

        $stat = $adapter->stat($norm);
        if (($stat['type'] ?? '') !== 'file') {
            throw new RuntimeException('Not a file', 404);
        }
        $mime = (string) ($stat['mime'] ?? '');
        if (!in_array($mime, self::IMAGE_MIMES, true)) {
            throw new RuntimeException('Not a thumbnailable image', 415);
        }
        if ((int) ($stat['size'] ?? 0) > self::MAX_SOURCE_BYTES) {
            throw new RuntimeException('Image too large to thumbnail', 413);
        }

        $mtime = (int) ($stat['mtime'] ?? 0);
        $dir = self::cacheDir($mountName);
        // Cache key includes mtime so an edit invalidates it.
        $key = sha1($mountName . '|' . $norm . '|' . $mtime . '|' . $size);
        $out = $dir . '/' . $key . '.webp';

        if (is_file($out) && filesize($out) > 0) {
            return ['file' => $out, 'mime' => 'image/webp'];
        }

        $bytes = self::readAll($adapter->getStream($norm));
        $info = @getimagesizefromstring($bytes);
        if ($info === false) {
            throw new RuntimeException('Unrecognised image data', 415);
        }
        [$w, $h] = $info;
        if ($w < 1 || $h < 1 || $w > self::MAX_DIM || $h > self::MAX_DIM) {
            throw new RuntimeException('Image dimensions out of range', 413);
        }

        $src = @imagecreatefromstring($bytes);
        if ($src === false) {
            throw new RuntimeException('Cannot decode image', 415);
        }
        try {
            $thumb = self::resize($src, $w, $h, $size);
            if (!is_dir($dir) && !@mkdir($dir, 0770, true)) {
                throw new RuntimeException('Cannot create thumbnail cache');
            }
            $tmp = $out . '.tmp-' . bin2hex(random_bytes(4));
            if (!@imagewebp($thumb, $tmp, 82)) {
                @unlink($tmp);
                throw new RuntimeException('Cannot write thumbnail');
            }
            @chmod($tmp, 0660);
            @rename($tmp, $out);   // atomic publish
            imagedestroy($thumb);
        } finally {
            imagedestroy($src);
        }

        return ['file' => $out, 'mime' => 'image/webp'];
    }

    /** Remove cached thumbnails older than $days. Used by the worker sweep. */
    public static function prune(int $days = 14): int
    {
        $root = self::cacheRoot();
        if (!is_dir($root)) {
            return 0;
        }
        $cutoff = time() - $days * 86400;
        $removed = 0;
        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            /** @var \SplFileInfo $item */
            if ($item->isFile() && $item->getMTime() < $cutoff) {
                @unlink($item->getPathname());
                $removed++;
            }
        }
        return $removed;
    }

    // ------------------------------------------------------------------ util

    private static function snapSize(int $size): int
    {
        $best = self::SIZES[1];
        $bestDelta = PHP_INT_MAX;
        foreach (self::SIZES as $s) {
            $d = abs($s - $size);
            if ($d < $bestDelta) { $bestDelta = $d; $best = $s; }
        }
        return $best;
    }

    private static function cacheRoot(): string
    {
        return Config::i()->dataDir() . '/thumbs';
    }

    private static function cacheDir(string $mountName): string
    {
        // Mount names are validated slugs, but never trust that for a path.
        return self::cacheRoot() . '/' . preg_replace('/[^a-zA-Z0-9._-]/', '_', $mountName);
    }

    /** @param resource $stream */
    private static function readAll($stream): string
    {
        if (!is_resource($stream)) {
            throw new RuntimeException('Cannot read image');
        }
        try {
            $bytes = stream_get_contents($stream, self::MAX_SOURCE_BYTES + 1);
        } finally {
            fclose($stream);
        }
        if ($bytes === false || $bytes === '') {
            throw new RuntimeException('Empty image');
        }
        if (strlen($bytes) > self::MAX_SOURCE_BYTES) {
            throw new RuntimeException('Image too large to thumbnail', 413);
        }
        return $bytes;
    }

    /** Scale preserving aspect ratio, never upscaling. */
    private static function resize(\GdImage $src, int $w, int $h, int $target): \GdImage
    {
        $scale = min($target / $w, $target / $h, 1.0);
        $nw = max(1, (int) round($w * $scale));
        $nh = max(1, (int) round($h * $scale));

        $dst = imagecreatetruecolor($nw, $nh);
        imagealphablending($dst, false);
        imagesavealpha($dst, true);
        imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
        return $dst;
    }
}
