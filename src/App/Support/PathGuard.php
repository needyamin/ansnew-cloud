<?php

declare(strict_types=1);

namespace App\Support;

use InvalidArgumentException;

/**
 * Central path-traversal defense.
 *
 * Every user-supplied path enters through PathGuard::resolve(), which:
 *  - normalizes separators and resolves . / .. segments lexically,
 *  - rejects NUL bytes, control chars and Windows drive prefixes,
 *  - rejects absolute paths,
 *  - guarantees the result stays inside the mount-relative virtual root.
 *
 * LocalAdapter additionally enforces realpath() containment (symlink escape).
 */
final class PathGuard
{
    /** Canonical virtual root used for every mount. */
    public const ROOT = '/';

    public static function normalize(string $userPath): string
    {
        if ($userPath === '') {
            return '/';
        }

        if (str_contains($userPath, "\0")) {
            throw new InvalidArgumentException('Invalid path');
        }

        // Reject control characters (except nothing — all controls rejected).
        if (preg_match('/[\x00-\x1f\x7f]/', $userPath) === 1) {
            throw new InvalidArgumentException('Invalid path');
        }

        // Uniform separators.
        $p = str_replace('\\', '/', $userPath);

        // Reject Windows drive prefixes and UNC paths.
        if (preg_match('#^[a-zA-Z]:#', $p) === 1 || str_starts_with($p, '//')) {
            throw new InvalidArgumentException('Invalid path');
        }

        // All paths are mount-relative: force virtual absolute form.
        if (!str_starts_with($p, '/')) {
            $p = '/' . $p;
        }

        $parts = explode('/', $p);
        $stack = [];
        foreach ($parts as $seg) {
            if ($seg === '' || $seg === '.') {
                continue;
            }
            if ($seg === '..') {
                if ($stack === []) {
                    throw new InvalidArgumentException('Path escapes the mount root');
                }
                array_pop($stack);
                continue;
            }
            // Reject reserved/tricky names.
            if ($seg === '.' || str_starts_with($seg, '__ansnew_trash__') && $seg !== '__ansnew_trash__') {
                throw new InvalidArgumentException('Invalid path segment');
            }
            $stack[] = $seg;
        }

        return '/' . implode('/', $stack);
    }

    /** Join and normalize. */
    public static function join(string $base, string $rel): string
    {
        return self::normalize(rtrim($base, '/') . '/' . ltrim($rel, '/'));
    }

    /** Parent directory of a normalized path. */
    public static function dirname(string $path): string
    {
        $p = self::normalize($path);
        if ($p === '/') {
            return '/';
        }
        $idx = strrpos($p, '/');
        return $idx === 0 ? '/' : substr($p, 0, $idx);
    }

    /** Final segment. */
    public static function basename(string $path): string
    {
        $p = self::normalize($path);
        if ($p === '/') {
            return '';
        }
        return substr($p, (int) strrpos($p, '/') + 1);
    }

    /**
     * Validate a file/folder name for create/rename (no separators, not dot).
     */
    public static function validateName(string $name): string
    {
        $name = trim($name);
        if ($name === '' || $name === '.' || $name === '..') {
            throw new InvalidArgumentException('Invalid name');
        }
        if (str_contains($name, '/') || str_contains($name, '\\') || str_contains($name, "\0")) {
            throw new InvalidArgumentException('Name must not contain path separators');
        }
        if (preg_match('/[\x00-\x1f\x7f]/', $name) === 1) {
            throw new InvalidArgumentException('Invalid characters in name');
        }
        if (mb_strlen($name) > 255) {
            throw new InvalidArgumentException('Name too long');
        }
        return $name;
    }

    /** True if the path is inside (or equal to) the special trash dir of a local mount. */
    public static function isTrashPath(string $path): bool
    {
        $p = self::normalize($path);
        return $p === '/__ansnew_trash__' || str_starts_with($p, '/__ansnew_trash__/');
    }
}
