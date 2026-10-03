<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Services\AuditService;
use App\Support\PathGuard;
use App\Support\Validator;
use RuntimeException;

/**
 * Admin: mount management (local + remote mounts, per-user grants).
 */
final class AdminMountController
{
    public static function list(Request $req, SessionManager $session): Response
    {
        Guard::requireAdmin($session);
        $db = Database::i();
        $mounts = $db->all('SELECT * FROM mounts ORDER BY name');
        $grants = $db->all('SELECT g.id, g.mount_id, g.user_id, g.can_write, u.username
                            FROM mount_grants g LEFT JOIN users u ON u.id = g.user_id');
        return Response::ok(['mounts' => $mounts, 'grants' => $grants]);
    }

    public static function create(Request $req, SessionManager $session): Response
    {
        $admin = Guard::requireAdmin($session);
        $body = $req->json();
        $name = Validator::mountName((string) ($body['name'] ?? ''));
        $label = mb_substr(trim((string) ($body['label'] ?? $name)), 0, 120);
        $adapter = Validator::adapter((string) ($body['adapter'] ?? 'local'));
        $db = Database::i();

        if ($db->one('SELECT id FROM mounts WHERE name = :n', [':n' => $name]) !== null) {
            throw new RuntimeException('Mount name already exists');
        }

        $localRoot = null;
        $connectionId = null;
        if ($adapter === 'local') {
            // Local roots are constrained to the storage root volume.
            $root = trim((string) ($body['localRoot'] ?? ''), '/');
            $localRoot = '/srv/storage/local' . ($root !== '' ? '/' . $root : '');
        } else {
            $connectionId = Validator::int($body['connectionId'] ?? 0, 1, PHP_INT_MAX, 'connectionId');
            if ($db->one('SELECT id FROM connections WHERE id = :id', [':id' => $connectionId]) === null) {
                throw new RuntimeException('Connection not found', 404);
            }
        }

        $db->run(
            'INSERT INTO mounts (name, label, adapter, local_root, connection_id, remote_path, quota_bytes,
                                is_readonly, is_visible_all, trash_enabled, created_by)
             VALUES (:n,:l,:a,:lr,:ci,:rp,:qb,:ro,:va,:tr,:cb)',
            [
                ':n' => $name, ':l' => $label, ':a' => $adapter, ':lr' => $localRoot,
                ':ci' => $connectionId, ':rp' => (string) ($body['remotePath'] ?? '/'),
                ':qb' => (int) ($body['quotaBytes'] ?? 0),
                ':ro' => Validator::bool($body['readOnly'] ?? false) ? 1 : 0,
                ':va' => Validator::bool($body['visibleAll'] ?? true) ? 1 : 0,
                ':tr' => Validator::bool($body['trashEnabled'] ?? true) ? 1 : 0,
                ':cb' => $admin->id,
            ]
        );
        $id = (int) $db->scalar('SELECT id FROM mounts WHERE name = :n', [':n' => $name]);
        AuditService::log($admin, 'admin.mount_create', $name, null, null, 'ok', $adapter, $req->ip(), $req->userAgent());
        return Response::ok(['id' => $id]);
    }

    public static function update(Request $req, SessionManager $session, int $id): Response
    {
        $admin = Guard::requireAdmin($session);
        $body = $req->json();
        $db = Database::i();
        if ($db->one('SELECT id FROM mounts WHERE id = :id', [':id' => $id]) === null) {
            throw new RuntimeException('Mount not found', 404);
        }
        $action = (string) ($body['action'] ?? '');

        switch ($action) {
            case 'set-flags':
                $db->run(
                    'UPDATE mounts SET is_readonly = :ro, is_visible_all = :va, trash_enabled = :tr WHERE id = :id',
                    [
                        ':ro' => Validator::bool($body['readOnly'] ?? false) ? 1 : 0,
                        ':va' => Validator::bool($body['visibleAll'] ?? false) ? 1 : 0,
                        ':tr' => Validator::bool($body['trashEnabled'] ?? true) ? 1 : 0,
                        ':id' => $id,
                    ]
                );
                break;
            case 'set-grants':
                // Replace the per-user grant list. {grants: [{userId, canWrite}]}
                $grants = is_array($body['grants'] ?? null) ? $body['grants'] : [];
                $db->run('BEGIN IMMEDIATE');
                try {
                    $db->run('DELETE FROM mount_grants WHERE mount_id = :id', [':id' => $id]);
                    foreach ($grants as $g) {
                        if (!is_array($g)) { continue; }
                        $db->run(
                            'INSERT INTO mount_grants (mount_id, user_id, can_write) VALUES (:m,:u,:w)',
                            [':m' => $id, ':u' => Validator::int($g['userId'] ?? 0, 1, PHP_INT_MAX, 'userId'),
                             ':w' => Validator::bool($g['canWrite'] ?? true) ? 1 : 0]
                        );
                    }
                    $db->run('COMMIT');
                } catch (\Throwable $e) {
                    $db->run('ROLLBACK');
                    throw $e;
                }
                break;
            case 'set-quota':
                $db->run('UPDATE mounts SET quota_bytes = :q WHERE id = :id',
                    [':q' => max(0, (int) ($body['quotaBytes'] ?? 0)), ':id' => $id]);
                break;
            case 'set-label':
                $db->run('UPDATE mounts SET label = :l WHERE id = :id',
                    [':l' => mb_substr(trim((string) ($body['label'] ?? '')), 0, 120), ':id' => $id]);
                break;
            default:
                return Response::error('Unknown action', 400, 'bad_request');
        }
        AuditService::log($admin, 'admin.mount_update', null, null, (string) $id, 'ok', $action, $req->ip(), $req->userAgent());
        return Response::ok(['updated' => true]);
    }

    public static function delete(Request $req, SessionManager $session, int $id): Response
    {
        $admin = Guard::requireAdmin($session);
        $db = Database::i();
        $db->run('DELETE FROM mounts WHERE id = :id', [':id' => $id]);
        AuditService::log($admin, 'admin.mount_delete', null, null, (string) $id, 'ok', '', $req->ip(), $req->userAgent());
        return Response::ok(['deleted' => true]);
    }
}