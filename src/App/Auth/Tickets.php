<?php

declare(strict_types=1);

namespace App\Auth;

use App\Core\Database;

/**
 * One-time, short-lived WebSocket auth tickets.
 */
final class Tickets
{
    public static function mint(int $userId, string $channel = 'events', string $scope = ''): string
    {
        $db = Database::i();
        $id = self::uuid4();
        $db->run(
            'INSERT INTO ws_tickets (id, user_id, channel, scope, expires_at) VALUES (:id,:u,:c,:s,:e)',
            [
                ':id' => $id,
                ':u' => $userId,
                ':c' => $channel,
                ':s' => $scope,
                ':e' => time() + 60,
            ]
        );
        // housekeeping
        if (random_int(1, 20) === 1) {
            $db->run('DELETE FROM ws_tickets WHERE expires_at < :t', [':t' => time() - 300]);
        }
        return $id;
    }

    /**
     * Consume a ticket. Returns null when invalid/expired/used.
     * @return array{user_id:int, channel:string, scope:string}|null
     */
    public static function consume(string $id, string $channel): ?array
    {
        $db = Database::i();
        $row = $db->one(
            'SELECT user_id, channel, scope, expires_at, used FROM ws_tickets WHERE id = :id',
            [':id' => $id]
        );
        if ($row === null || (int) $row['used'] === 1) {
            return null;
        }
        if ((int) $row['expires_at'] < time() || $row['channel'] !== $channel) {
            return null;
        }
        $db->run('UPDATE ws_tickets SET used = 1 WHERE id = :id', [':id' => $id]);
        return [
            'user_id' => (int) $row['user_id'],
            'channel' => (string) $row['channel'],
            'scope' => (string) $row['scope'],
        ];
    }

    public static function uuid4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
        $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
