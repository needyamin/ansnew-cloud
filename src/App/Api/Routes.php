<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\SessionManager;
use App\Core\Router;

/**
 * Route table. Every handler receives (Request, ...pathParams).
 * Authorization is enforced inside the handlers via App\Auth\Guard.
 */
final class Routes
{
    public static function register(Router $r, SessionManager $session): void
    {
        // ---- bootstrap & auth ----
        $r->get('/api/bootstrap', fn($req) => BootstrapController::bootstrap($req, $session));
        $r->post('/api/auth/login', fn($req) => AuthController::login($req, $session));
        $r->post('/api/auth/logout', fn($req) => AuthController::logout($req, $session));
        $r->post('/api/auth/password', fn($req) => AuthController::changePassword($req, $session));

        // ---- filesystem ----
        $r->get('/api/mounts', fn($req) => MountController::listForUser($req, $session));
        $r->get('/api/fs/{mount}/list', fn($req, $m) => FsController::list($req, $session, $m));
        $r->post('/api/fs/{mount}/mkdir', fn($req, $m) => FsController::mkdir($req, $session, $m));
        $r->post('/api/fs/{mount}/file', fn($req, $m) => FsController::createFile($req, $session, $m));
        $r->post('/api/fs/{mount}/rename', fn($req, $m) => FsController::rename($req, $session, $m));
        $r->post('/api/fs/{mount}/copy', fn($req, $m) => FsController::copy($req, $session, $m));
        $r->post('/api/fs/{mount}/move', fn($req, $m) => FsController::move($req, $session, $m));
        $r->post('/api/fs/{mount}/delete', fn($req, $m) => FsController::delete($req, $session, $m));
        // Batch variants: one round trip for a whole selection instead of one per item.
        $r->post('/api/fs/{mount}/delete-batch', fn($req, $m) => FsController::deleteBatch($req, $session, $m));
        $r->post('/api/fs/{mount}/rename-batch', fn($req, $m) => FsController::renameBatch($req, $session, $m));
        $r->post('/api/fs/{mount}/move-batch', fn($req, $m) => FsController::moveBatch($req, $session, $m));
        $r->post('/api/fs/{mount}/copy-batch', fn($req, $m) => FsController::copyBatch($req, $session, $m));
        $r->post('/api/fs/{mount}/archive', fn($req, $m) => FsController::archive($req, $session, $m));
        $r->post('/api/fs/{mount}/extract', fn($req, $m) => FsController::extract($req, $session, $m));
        $r->get('/api/fs/{mount}/search', fn($req, $m) => FsController::search($req, $session, $m));
        $r->get('/api/fs/{mount}/download', fn($req, $m) => FsController::download($req, $session, $m));
        // Any mix of files and folders -> one zip, prepared by the worker.
        $r->post('/api/fs/{mount}/download-selection', fn($req, $m) => FsController::downloadSelection($req, $session, $m));
        $r->get('/api/fs/{mount}/preview', fn($req, $m) => FsController::preview($req, $session, $m));
        $r->get('/api/fs/{mount}/render', fn($req, $m) => FsController::render($req, $session, $m));
        $r->get('/api/fs/{mount}/stat', fn($req, $m) => FsController::stat($req, $session, $m));
        // Text files open in the built-in code editor: read the contents, then
        // save them back (with a hash guard against clobbering a concurrent edit).
        $r->get('/api/fs/{mount}/text', fn($req, $m) => FsController::text($req, $session, $m));
        $r->post('/api/fs/{mount}/write', fn($req, $m) => FsController::write($req, $session, $m));
        $r->get('/api/download/{token}', fn($req, $t) => FsController::consumeDownload($req, $session, $t));

        // ---- uploads ----
        $r->post('/api/upload/{mount}', fn($req, $m) => UploadController::upload($req, $session, $m));
        $r->post('/api/upload/{mount}/chunk', fn($req, $m) => UploadController::chunk($req, $session, $m));
        $r->post('/api/upload/{mount}/complete', fn($req, $m) => UploadController::complete($req, $session, $m));

        // ---- share links (owner CRUD) ----
        $r->get('/api/shares', fn($req) => ShareController::index($req, $session));
        $r->post('/api/shares', fn($req) => ShareController::create($req, $session));
        $r->delete('/api/shares/all', fn($req) => ShareController::clearAll($req, $session));
        $r->delete('/api/shares/{id}', fn($req, $id) => ShareController::revoke($req, $session, (int) $id));
        $r->post('/api/shares/{id}/rotate', fn($req, $id) => ShareController::rotate($req, $session, (int) $id));

        // ---- PUBLIC share links: no session, GET only for content ----
        $r->get('/s/{token}', fn($req, $t) => ShareController::publicView($req, $session, $t));
        $r->get('/s/{token}/download', fn($req, $t) => ShareController::publicDownload($req, $session, $t));
        // POST exists solely to submit the share password (see the Kernel's
        // /s/ exemption): the token itself is the credential.
        $r->post('/s/{token}', fn($req, $t) => ShareController::publicView($req, $session, $t));

        // ---- jobs ----
        $r->get('/api/jobs', fn($req) => JobController::list($req, $session));
        $r->post('/api/jobs/{id}/cancel', fn($req, $id) => JobController::cancel($req, $session, $id));

        // ---- favorites / recent ----
        $r->get('/api/favorites', fn($req) => FavoritesController::list($req, $session));
        $r->post('/api/favorites', fn($req) => FavoritesController::add($req, $session));
        // /all must be registered as its own pattern: route regexes are
        // anchored, so DELETE /api/favorites can never swallow it.
        $r->delete('/api/favorites/all', fn($req) => FavoritesController::clearAll($req, $session));
        $r->delete('/api/favorites', fn($req) => FavoritesController::remove($req, $session));
        $r->get('/api/recent', fn($req) => FavoritesController::recent($req, $session));
        $r->post('/api/recent', fn($req) => FavoritesController::recordRecent($req, $session));
        $r->delete('/api/recent', fn($req) => FavoritesController::clearRecent($req, $session));

        // ---- trash ----
        $r->get('/api/trash/{mount}', fn($req, $m) => TrashController::list($req, $session, $m));
        $r->post('/api/trash/{mount}/restore', fn($req, $m) => TrashController::restore($req, $session, $m));
        $r->post('/api/trash/{mount}/purge', fn($req, $m) => TrashController::purge($req, $session, $m));
        $r->post('/api/trash/{mount}/empty', fn($req, $m) => TrashController::empty($req, $session, $m));

        // ---- usage ----
        $r->get('/api/usage', fn($req) => UsageController::usage($req, $session));
        $r->post('/api/usage/{mount}/scan', fn($req, $m) => UsageController::scan($req, $session, $m));
        // Filesystem capacity (total/used/free) for local mounts.
        $r->get('/api/drives/info', fn($req) => DrivesController::info($req, $session));

        // ---- admin ----
        $r->get('/api/admin/users', fn($req) => AdminUserController::list($req, $session));
        $r->post('/api/admin/users', fn($req) => AdminUserController::create($req, $session));
        $r->post('/api/admin/users/{id}', fn($req, $id) => AdminUserController::update($req, $session, (int) $id));
        $r->delete('/api/admin/users/{id}', fn($req, $id) => AdminUserController::delete($req, $session, (int) $id));

        $r->get('/api/admin/mounts', fn($req) => AdminMountController::list($req, $session));
        $r->post('/api/admin/mounts', fn($req) => AdminMountController::create($req, $session));
        $r->post('/api/admin/mounts/{id}', fn($req, $id) => AdminMountController::update($req, $session, (int) $id));
        $r->delete('/api/admin/mounts/{id}', fn($req, $id) => AdminMountController::delete($req, $session, (int) $id));

        $r->get('/api/admin/connections', fn($req) => AdminConnectionController::list($req, $session));
        $r->post('/api/admin/connections', fn($req) => AdminConnectionController::create($req, $session));
        $r->post('/api/admin/connections/{id}/test', fn($req, $id) => AdminConnectionController::test($req, $session, (int) $id));
        $r->delete('/api/admin/connections/{id}', fn($req, $id) => AdminConnectionController::delete($req, $session, (int) $id));
    }
}
