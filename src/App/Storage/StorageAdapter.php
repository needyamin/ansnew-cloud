<?php

declare(strict_types=1);

namespace App\Storage;

/**
 * Contract every storage adapter implements. All paths are mount-relative
 * virtual paths (validated by PathGuard before reaching an adapter).
 */
interface StorageAdapter
{
    /** @return array<int, array<string,mixed>> entries with name,type,size,mtime,perms,owner,group,extra */
    public function list(string $path): array;

    /** @return array<string,mixed> */
    public function stat(string $path): array;

    public function exists(string $path): bool;

    public function isDir(string $path): bool;

    public function mkdir(string $path, bool $recursive = true): void;

    public function delete(string $path, bool $recursive = false): void;

    public function rename(string $from, string $to): void;

    public function copy(string $from, string $to): void;

    /**
     * Read stream for download / preview. Caller closes the stream.
     * @return resource
     */
    public function getStream(string $path, int $from = -1, int $to = -1);

    /**
     * Write a stream to $path (upload). Returns bytes written. Caller closes input.
     */
    public function putStream(string $path, $stream): int;

    /** @return array{used:int, files:int, dirs:int} */
    public function du(string $path = '/'): array;

    /** @return array<int, array<string,mixed>> */
    public function search(string $path, string $needle, int $limit = 200): array;
}
