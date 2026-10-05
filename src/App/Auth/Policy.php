<?php

declare(strict_types=1);

namespace App\Auth;

use RuntimeException;

/**
 * The permission map: what an account may SEE and DO on a drive.
 *
 * This is deliberately the ONLY place that answers that question. Before it
 * existed, the answer was scattered across Mount::canWrite, per-service
 * assertWritable() calls and ad-hoc checks in the controllers — and delete had
 * none at all, so a read-only account could delete files.
 *
 * Two things come out of it:
 *  - `assertCan()` for the server, so every mutating route is gated up front;
 *  - the array in `Mount::publicInfo()`, so the UI can hide what is not allowed
 *    instead of showing a button that fails.
 *
 * Capabilities:
 *   list      browse the drive
 *   read      download and preview files
 *   share     create share links for things on the drive
 *   write     any mutation (umbrella, used for gating whole toolbars)
 *   create    new folder / new file / upload
 *   rename    rename an entry
 *   delete    move to trash, or delete permanently
 *   moveInto  move or copy entries INTO this drive
 */
final class Policy
{
    /** Capabilities that mean "this drive is writable for me". */
    private const WRITE_CAPS = ['create', 'rename', 'delete', 'moveInto'];

    /**
     * @param bool $canWrite the per-user write verdict already folded from
     *                       the drive's read-only flag and any mount grant
     * @param bool $isAdmin  administrators keep full access to every drive
     * @return array<string,bool>
     */
    public static function forMount(bool $canWrite, bool $isAdmin = false): array
    {
        // An administrator is never downgraded by a grant or a read-only flag.
        $write = $canWrite || $isAdmin;

        return [
            'list'    => true,
            'read'    => true,
            'share'   => true,
            'write'   => $write,
            'create'  => $write,
            'rename'  => $write,
            'delete'  => $write,
            'moveInto'=> $write,
        ];
    }

    /**
     * Reject the request unless the capability is granted.
     *
     * @param array<string,bool>|null $caps the map from Mount::publicInfo(),
     *                                      or null to derive from $canWrite
     */
    public static function assertCan(?array $caps, bool $canWrite, bool $isAdmin, string $cap): void
    {
        if (!self::allows($caps, $canWrite, $isAdmin, $cap)) {
            throw new RuntimeException(self::deniedMessage($cap), 403);
        }
    }

    /** @param array<string,bool>|null $caps */
    public static function allows(?array $caps, bool $canWrite, bool $isAdmin, string $cap): bool
    {
        if ($caps !== null && array_key_exists($cap, $caps)) {
            return (bool) $caps[$cap];
        }
        return self::forMount($canWrite, $isAdmin)[$cap] ?? false;
    }

    /** A message a user can act on, not "forbidden". */
    private static function deniedMessage(string $cap): string
    {
        switch ($cap) {
            case 'create':  return 'This drive is read-only for you — you cannot add files here';
            case 'rename':  return 'This drive is read-only for you — you cannot rename items here';
            case 'delete':  return 'This drive is read-only for you — you cannot delete items here';
            case 'moveInto':return 'This drive is read-only for you — you cannot move items into it';
            default:        return 'This drive is read-only for you';
        }
    }

    private function __construct()
    {
    }
}
