<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\UserService;
use App\Support\Validator;
use RuntimeException;

/**
 * Admin: user management (admin role enforced here).
 */
final class AdminUserController
{
    public static function list(Request $req, SessionManager $session): Response
    {
        Guard::requireAdmin($session);
        return Response::ok(['users' => UserService::all()]);
    }

    public static function create(Request $req, SessionManager $session): Response
    {
        $admin = Guard::requireAdmin($session);
        $body = $req->json();
        $id = UserService::create(
            (string) ($body['username'] ?? ''),
            (string) ($body['password'] ?? ''),
            (string) ($body['role'] ?? 'user'),
            (string) ($body['displayName'] ?? ''),
            (string) ($body['email'] ?? '')
        );
        return Response::ok(['id' => $id]);
    }

    public static function update(Request $req, SessionManager $session, int $id): Response
    {
        $admin = Guard::requireAdmin($session);
        $body = $req->json();
        $action = (string) ($body['action'] ?? '');

        switch ($action) {
            case 'set-active':
                UserService::setActive($id, Validator::bool($body['active'] ?? true));
                break;
            case 'set-role':
                UserService::setRole($id, (string) ($body['role'] ?? 'user'));
                break;
            case 'set-password':
                if (isset($body['password'])) {
                    UserService::updatePassword($id, (string) $body['password']);
                }
                break;
            case 'update-profile':
                UserService::updateProfile($id, $body);
                break;
            default:
                return Response::error('Unknown action', 400, 'bad_request');
        }
        return Response::ok(['updated' => true]);
    }

    public static function delete(Request $req, SessionManager $session, int $id): Response
    {
        $admin = Guard::requireAdmin($session);
        UserService::delete($admin->id, $id);
        return Response::ok(['deleted' => true]);
    }
}