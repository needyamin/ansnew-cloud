<?php

declare(strict_types=1);

namespace App\Services;

use App\Auth\AuthContext;
use App\Core\Database;
use RuntimeException;

/**
 * Audit trail for every mutating / security-relevant action.
 * Never logs secrets or file content.
 */
final class AuditService
{
    public static function log(
        ?AuthContext $user,
        string $action,
        ?string $mount = null,
        ?string $path = null,
        ?string $target = null,
        string $status = 'ok',
        string $detail = '',
        ?string $ip = null,
        string $userAgent = '',
    ): void {
        try {
            Database::i()->run(
                'INSERT INTO audit_log (user_id, username, action, mount, path, target, status, detail, ip, user_agent)
                 VALUES (:uid, :uname, :action, :mount, :path, :target, :status, :detail, :ip, :ua)',
                [
                    ':uid' => $user?->id,
                    ':uname' => $user?->username ?? 'anonymous',
                    ':action' => $action,
                    ':mount' => $mount,
                    ':path' => $path,
                    ':target' => $target,
                    ':status' => $status,
                    ':detail' => substr($detail, 0, 2000),
                    ':ip' => $ip ?? '0.0.0.0',
                    ':ua' => substr($userAgent, 0, 255),
                ]
            );
        } catch (\Throwable $e) {
            error_log('[ansnew] audit write failed: ' . $e->getMessage());
        }
    }

    /** @return array<int, array<string,mixed>> */
    public static function tail(int $limit = 100, int $offset = 0, ?int $userId = null, ?string $action = null): array
    {
        $limit = max(1, min(500, $limit));
        $sql = 'SELECT a.id, a.user_id, a.username, a.action, a.mount, a.path, a.target, a.status,
                       a.detail, a.ip, a.created_at
                FROM audit_log a WHERE 1=1';
        $params = [];
        if ($userId !== null) {
            $sql .= ' AND a.user_id = :uid';
            $params[':uid'] = $userId;
        }
        if ($action !== null && $action !== '') {
            $sql .= ' AND a.action = :action';
            $params[':action'] = $action;
        }
        $sql .= ' ORDER BY a.id DESC LIMIT ' . $limit . ' OFFSET ' . $offset;
        return Database::i()->all($sql, $params);
    }
}
