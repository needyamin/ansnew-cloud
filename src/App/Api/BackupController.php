<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\BackupService;
use RuntimeException;
use Throwable;

/**
 * Full-drive backup: start, watch, pause/resume, cancel, verify.
 *
 * All the heavy lifting runs on the worker; these endpoints only create and
 * steer runs, so a request never blocks on the data itself.
 */
final class BackupController
{
    public static function index(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $limit = (int) $req->query('limit', '50');
        return Response::ok(['backups' => BackupService::listFor($user, $limit)]);
    }

    public static function show(Request $req, SessionManager $session, string $id): Response
    {
        $user = Guard::requireUser($session);
        try {
            return Response::ok(['backup' => BackupService::get($user, $id)]);
        } catch (Throwable $e) {
            return Response::error($e->getMessage(), $e->getCode() === 404 ? 404 : 400, 'backup_not_found');
        }
    }

    /**
     * POST /api/backups
     * {sourceMount, sourcePath, destMount, destPath, label?, verify?}
     */
    public static function start(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        try {
            $backup = BackupService::start($user, $req->json());
        } catch (RuntimeException $e) {
            $code = $e->getCode();
            return Response::error($e->getMessage(), $code === 404 ? 404 : ($code === 409 ? 409 : 400), 'backup_start_failed');
        } catch (Throwable $e) {
            return Response::error($e->getMessage(), 400, 'backup_start_failed');
        }
        return Response::ok(['backup' => $backup]);
    }

    public static function pause(Request $req, SessionManager $session, string $id): Response
    {
        $user = Guard::requireUser($session);
        return self::act($user, $id, 'pause');
    }

    public static function resume(Request $req, SessionManager $session, string $id): Response
    {
        $user = Guard::requireUser($session);
        return self::act($user, $id, 'resume');
    }

    public static function cancel(Request $req, SessionManager $session, string $id): Response
    {
        $user = Guard::requireUser($session);
        return self::act($user, $id, 'cancel');
    }

    /** Queue a verification pass. Body: {deep: bool}. */
    public static function verify(Request $req, SessionManager $session, string $id): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        try {
            $backup = BackupService::verify($user, $id, !empty($body['deep']));
        } catch (RuntimeException $e) {
            $code = $e->getCode();
            return Response::error($e->getMessage(), $code === 404 ? 404 : ($code === 409 ? 409 : 400), 'backup_verify_failed');
        }
        return Response::ok(['backup' => $backup]);
    }

    /**
     * Forget a backup record. The copied files are never touched — this only
     * removes the entry from the list, which is why it needs no password.
     */
    public static function forget(Request $req, SessionManager $session, string $id): Response
    {
        $user = Guard::requireUser($session);
        try {
            $row = BackupService::assertOwned($user, $id);
        } catch (Throwable $e) {
            return Response::error('Backup not found', 404, 'not_found');
        }
        $manifest = BackupService::manifestPath($id);
        if (is_file($manifest)) {
            @unlink($manifest);
        }
        \App\Core\Database::i()->run('DELETE FROM backups WHERE id = :id AND user_id = :u', [':id' => $id, ':u' => $user->id]);
        \App\Services\AuditService::log($user, 'backup.forget', (string) $row['source_mount'], (string) $row['source_path'], null, 'ok', 'record only', '', '');
        return Response::ok(['forgotten' => true, 'dataKept' => true]);
    }

    /**
     * @param \App\Auth\AuthContext $user
     */
    private static function act($user, string $id, string $action): Response
    {
        try {
            $backup = match ($action) {
                'pause' => BackupService::pause($user, $id),
                'resume' => BackupService::resume($user, $id),
                default => BackupService::cancel($user, $id),
            };
        } catch (RuntimeException $e) {
            $code = $e->getCode();
            return Response::error($e->getMessage(), $code === 404 ? 404 : ($code === 409 ? 409 : 400), 'backup_' . $action . '_failed');
        }
        return Response::ok(['backup' => $backup]);
    }
}
