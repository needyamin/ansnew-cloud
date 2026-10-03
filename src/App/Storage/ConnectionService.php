<?php

declare(strict_types=1);

namespace App\Storage;

use App\Core\Database;
use RuntimeException;

/**
 * DB access to saved connections — decrypt-on-demand.
 */
final class ConnectionService
{
    /**
     * Build a decrypted ConnectionConfig for a mount.
     * Local mounts never come through here.
     */
    public static function decryptForAdapter(Mount $mount): ConnectionConfig
    {
        if ($mount->connectionId === null) {
            throw new RuntimeException('Mount has no remote connection configured');
        }
        $row = Database::i()->one(
            'SELECT * FROM connections WHERE id = :id',
            [':id' => $mount->connectionId]
        );
        if ($row === null) {
            throw new RuntimeException('Connection not found', 404);
        }
        return ConnectionConfig::fromRow($row);
    }
}
