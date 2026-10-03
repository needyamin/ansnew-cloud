<?php

declare(strict_types=1);

namespace App\Services;

use App\Config\Config;
use App\Core\Database;
use App\Storage\Encryption\EncryptedFormat;
use App\Storage\Encryption\FileCipher;
use RecursiveDirectoryIterator;
use RecursiveIteratorIterator;
use SplFileInfo;
use Throwable;

/**
 * One-shot backfill: encrypt every plaintext file under the local mount roots.
 *
 * Idempotent (files already carrying the magic are skipped) and crash-safe
 * (each file is written to a sibling temp then atomically renamed, so a failure
 * leaves the original untouched). Rerunning after an interruption resumes.
 *
 * Walks the filesystem directly rather than through the storage adapter — the
 * adapter would hand back decrypted bytes, which is the opposite of what a
 * backfill needs.
 */
final class EncryptionMigrationService
{
    /**
     * @param callable(string):void $log
     * @return array{scanned:int,encrypted:int,skipped:int,failed:int,bytes:int,stopped:bool}
     */
    public static function run(callable $log, bool $dryRun = false, ?int $limit = null, ?string $onlyMount = null): array
    {
        $stats = ['scanned' => 0, 'encrypted' => 0, 'skipped' => 0, 'failed' => 0, 'bytes' => 0, 'stopped' => false];
        $roots = self::localRoots($onlyMount);

        if ($roots === []) {
            $log('No local mounts found.');
            return $stats;
        }

        foreach ($roots as $name => $root) {
            $log("Scanning mount '{$name}' -> {$root}");
            self::cleanupStrayTemps($root, $log);

            $it = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
                RecursiveIteratorIterator::SELF_FIRST
            );

            foreach ($it as $item) {
                /** @var SplFileInfo $item */
                if ($item->isLink() || !$item->isFile()) {
                    continue;
                }
                if ($limit !== null && $stats['encrypted'] >= $limit) {
                    $stats['stopped'] = true;
                    $log("Reached --limit={$limit}; stopping (rerun to continue).");
                    return $stats;
                }

                $path = $item->getPathname();
                $stats['scanned']++;

                if (FileCipher::isEncrypted($path)) {
                    $stats['skipped']++;
                    continue;
                }

                $size = (int) ($item->getSize() ?: 0);
                if ($dryRun) {
                    $stats['encrypted']++;
                    $stats['bytes'] += $size;
                    continue;
                }

                // Peak usage is original + ciphertext while both exist.
                $est = EncryptedFormat::ciphertextSize($size, EncryptedFormat::FIXED_HEADER_LEN + 160);
                $free = @disk_free_space($root);
                if ($free !== false && $free < $est + $size + (16 * 1024 * 1024)) {
                    $stats['stopped'] = true;
                    $log(sprintf(
                        'Not enough free space to continue (need ~%s, have %s). Rerun after freeing space.',
                        number_format($est + $size), number_format((int) $free)
                    ));
                    return $stats;
                }

                try {
                    $mtime = $item->getMTime();
                    FileCipher::encryptFileInPlace($path);
                    @touch($path, $mtime);
                    $stats['encrypted']++;
                    $stats['bytes'] += $size;
                } catch (Throwable $e) {
                    $stats['failed']++;
                    $log('FAILED ' . $path . ': ' . $e->getMessage());
                }
            }
        }

        return $stats;
    }

    /**
     * Count encrypted vs plaintext files per local mount (for ansnew:crypto-status).
     *
     * @return array<string, array{encrypted:int,plaintext:int,bytes:int}>
     */
    public static function inventory(?string $onlyMount = null): array
    {
        $out = [];
        foreach (self::localRoots($onlyMount) as $name => $root) {
            $row = ['encrypted' => 0, 'plaintext' => 0, 'bytes' => 0];
            $it = new RecursiveIteratorIterator(
                new RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
                RecursiveIteratorIterator::SELF_FIRST
            );
            foreach ($it as $item) {
                /** @var SplFileInfo $item */
                if ($item->isLink() || !$item->isFile()) {
                    continue;
                }
                if (FileCipher::isEncrypted($item->getPathname())) {
                    $row['encrypted']++;
                } else {
                    $row['plaintext']++;
                    $row['bytes'] += (int) ($item->getSize() ?: 0);
                }
            }
            $out[$name] = $row;
        }
        return $out;
    }

    /** @return array<string,string> mount name => absolute root */
    private static function localRoots(?string $onlyMount): array
    {
        $roots = [];
        $rows = Database::i()->all("SELECT name, local_root FROM mounts WHERE adapter = 'local'");
        foreach ($rows as $r) {
            $name = (string) $r['name'];
            if ($onlyMount !== null && $name !== $onlyMount) {
                continue;
            }
            $root = (string) ($r['local_root'] ?? '');
            if ($root === '') {
                $root = Config::i()->storageRoot() . '/' . $name;
            }
            $real = realpath($root);
            if ($real !== false && is_dir($real)) {
                $roots[$name] = $real;
            }
        }
        return $roots;
    }

    /** Remove leftovers from an interrupted run. */
    private static function cleanupStrayTemps(string $root, callable $log): void
    {
        $it = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, \FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        $n = 0;
        foreach ($it as $item) {
            /** @var SplFileInfo $item */
            if ($item->isFile() && str_contains($item->getFilename(), '.ansnew-tmp-')) {
                @unlink($item->getPathname());
                $n++;
            }
        }
        if ($n > 0) {
            $log("Removed {$n} leftover temporary file(s) from a previous run.");
        }
    }
}
