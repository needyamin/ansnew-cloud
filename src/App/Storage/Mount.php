<?php

declare(strict_types=1);

namespace App\Storage;

/**
 * Mount definition + per-user permission snapshot.
 */
final class Mount
{
    public function __construct(
        public readonly int $id,
        public readonly string $name,
        public readonly string $label,
        public readonly string $adapter,
        public readonly ?string $localRoot,
        public readonly ?int $connectionId,
        public readonly string $remotePath,
        public readonly int $quotaBytes,
        public readonly bool $readOnly,
        public readonly bool $trashEnabled,
        public readonly bool $canWrite,
    ) {
    }

    /** @param array<string,mixed> $row @param array<string,mixed>|null $grant */
    public static function fromRow(array $row, ?array $grant): self
    {
        return new self(
            (int) $row['id'],
            (string) $row['name'],
            (string) $row['label'],
            (string) $row['adapter'],
            isset($row['local_root']) ? (string) $row['local_root'] : null,
            isset($row['connection_id']) && $row['connection_id'] !== null ? (int) $row['connection_id'] : null,
            (string) ($row['remote_path'] ?? '/'),
            (int) ($row['quota_bytes'] ?? 0),
            (bool) ($row['is_readonly'] ?? false),
            (bool) ($row['trash_enabled'] ?? true),
            !((bool) ($row['is_readonly'] ?? false)) && (bool) ($grant['can_write'] ?? true),
        );
    }

    public function publicInfo(): array
    {
        return [
            'id' => $this->id,
            'name' => $this->name,
            'label' => $this->label,
            'adapter' => $this->adapter,
            'readOnly' => $this->readOnly,
            'canWrite' => $this->canWrite,
            'quotaBytes' => $this->quotaBytes,
            'trashEnabled' => $this->trashEnabled,
        ];
    }
}
