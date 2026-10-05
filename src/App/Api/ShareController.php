<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\AuditService;
use App\Services\ShareService;
use App\Support\PathGuard;
use App\Support\Validator;
use RuntimeException;

/**
 * Share links.
 *
 * /api/shares*       — the owner's CRUD, requires a session.
 * /s/{token}[…]      — PUBLIC. No session, no CSRF (GET only), no auth header.
 *                      This is the whole point of a share link.
 */
final class ShareController
{
    /* ------------------------------------------------------- owner endpoints */

    public static function index(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        return Response::ok(['shares' => ShareService::listFor($user->id)]);
    }

    public static function create(Request $req, SessionManager $session): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $r = ShareService::create(
            $user,
            Validator::mountName((string) ($body['mount'] ?? '')),
            PathGuard::normalize((string) ($body['path'] ?? '/')),
            [
                'password' => (string) ($body['password'] ?? ''),
                'expiresDays' => (int) ($body['expiresDays'] ?? 0),
                'allowDownload' => (bool) ($body['allowDownload'] ?? true),
            ]
        );
        return Response::ok($r);
    }

    public static function revoke(Request $req, SessionManager $session, int $id): Response
    {
        $user = Guard::requireUser($session);
        ShareService::revoke($user, $id);
        return Response::ok(['revoked' => true]);
    }

    /**
     * Remove every share link the user owns at once.
     *
     * Gated behind a password re-entry (SensitiveGate scope `shares.clear`) because
     * it is a bulk, irreversible teardown of access the user granted one link at a
     * time — the same reasoning as clearing all favourites. There is no per-link undo.
     */
    public static function clearAll(Request $req, SessionManager $session): Response
    {
        $gated = \App\Auth\SensitiveGate::guard($session, 'shares.clear');
        if ($gated !== null) {
            return $gated;
        }
        $user = Guard::requireUser($session);
        $removed = ShareService::clearAll($user);
        AuditService::log($user, 'share.revoke_all', null, null, null, 'ok', (string) $removed, '', '');
        return Response::ok(['removed' => $removed]);
    }

    public static function rotate(Request $req, SessionManager $session, int $id): Response
    {
        $user = Guard::requireUser($session);
        return Response::ok(ShareService::rotate($user, $id));
    }

    /* --------------------------------------------------------- public routes */

    /**
     * The public page for a share. Rendered server-side on purpose: it must work
     * for someone with no account, no cookies and no JavaScript session.
     */
    public static function publicView(Request $req, SessionManager $session, string $token): Response
    {
        $share = ShareService::resolve($token);
        if ($share === null) {
            return self::html('Link not available',
                'This share link is invalid, expired, or was revoked by its owner.', 404);
        }

        $password = $_POST['password'] ?? ($req->query('password', '') ?? '');
        if (ShareService::passwordRequired($share, is_string($password) ? $password : null)) {
            return self::passwordPage($token);
        }

        ShareService::recordAccess((int) $share['id']);
        $sub = (string) ($req->query('path', '') ?? '');
        $subPath = $sub !== '' ? PathGuard::normalize($sub) : '';

        try {
            [$adapter, $target, $name] = ShareService::scopeFor($share, $subPath);
        } catch (RuntimeException $e) {
            return self::html('Not available', $e->getMessage(), (int) ($e->getCode() ?: 404));
        }

        $stat = $adapter->stat($target);
        if (($stat['type'] ?? '') === 'dir') {
            return self::folderPage($token, $adapter, $target, $name, (string) $password);
        }
        return self::filePage($token, $stat, (string) $share['allow_download']);
    }

    /** Download one file inside a shared folder (or the shared file itself). */
    public static function publicDownload(Request $req, SessionManager $session, string $token): Response
    {
        $share = ShareService::resolve($token);
        if ($share === null) {
            return Response::error('Link not available', 404, 'not_found');
        }
        if (!(bool) $share['allow_download']) {
            return Response::error('Downloads are disabled for this link', 403, 'denied');
        }
        $password = (string) ($req->query('password', '') ?? '');
        if (ShareService::passwordRequired($share, $password !== '' ? $password : null)) {
            return Response::error('This link is password protected', 401, 'password_required');
        }

        $sub = (string) ($req->query('path', '') ?? '');
        $subPath = $sub !== '' ? PathGuard::normalize($sub) : '';
        [$adapter, $target] = ShareService::scopeFor($share, $subPath);
        $stat = $adapter->stat($target);
        if (($stat['type'] ?? '') === 'dir') {
            return Response::error('That is a folder — open it instead', 400, 'bad_request');
        }

        ShareService::recordAccess((int) $share['id']);

        // Same streaming approach as FsController::download — the body never
        // buffers in memory.
        $stream = $adapter->getStream($target);
        $resp = new Response(200, '');
        $resp->withHeader('Content-Type', 'application/octet-stream');
        $resp->withHeader('Content-Length', (string) $stat['size']);
        $resp->withHeader('Content-Disposition', 'attachment; filename="' . self::asciiFallback((string) $stat['name']) . '"; filename*=UTF-8\'\'' . rawurlencode((string) $stat['name']));
        $resp->withHeader('X-Content-Type-Options', 'nosniff');
        $resp->withHeader('Cache-Control', 'no-store');
        return $resp->withStream($stream, (int) $stat['size']);
    }

    private static function asciiFallback(string $name): string
    {
        return preg_replace('/[^A-Za-z0-9._-]/', '_', $name) ?: 'download';
    }

    /* ----------------------------------------------------------- html helpers */

    private static function html(string $title, string $inner, int $status = 200): Response
    {
        $esc = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
        $html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
            . '<meta name="viewport" content="width=device-width, initial-scale=1">'
            . '<meta name="robots" content="noindex, nofollow">'
            . '<title>' . $esc($title) . '</title>'
            . '<style>'
            . 'body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;'
            . 'background:#0f1115;color:#e6e8ec;display:flex;min-height:100vh;align-items:center;justify-content:center}'
            . '.card{background:#171a21;border:1px solid #262b36;border-radius:12px;padding:28px;max-width:680px;width:92%}'
            . 'h1{font-size:19px;margin:0 0 12px}.muted{color:#9aa3b2;font-size:14px;line-height:1.5}'
            . 'table{width:100%;border-collapse:collapse;margin-top:14px;font-size:14px}'
            . 'td{padding:8px 6px;border-bottom:1px solid #232834}a{color:#7aa2ff;text-decoration:none}'
            . 'a:hover{text-decoration:underline}.size{color:#9aa3b2;text-align:right;white-space:nowrap}'
            . 'input{background:#0f1115;border:1px solid #2a3040;color:#e6e8ec;border-radius:8px;'
            . 'padding:9px 10px;width:100%;font-size:14px;margin:10px 0}'
            . 'button{background:#3b6ef5;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:14px;cursor:pointer}'
            . '.crumbs{font-size:13px;margin-bottom:8px;color:#9aa3b2}'
            . '</style></head><body><div class="card">' . $inner . '</div></body></html>';

        // Note the argument order: Response takes (status, body).
        $resp = new Response($status, $html);
        $resp->withHeader('Content-Type', 'text/html; charset=utf-8');
        $resp->withHeader('X-Robots-Tag', 'noindex, nofollow');
        return $resp;
    }

    private static function passwordPage(string $token): Response
    {
        $t = htmlspecialchars($token, ENT_QUOTES, 'UTF-8');
        $inner = '<h1>This link is protected</h1>'
            . '<p class="muted">Enter the password the owner gave you.</p>'
            . '<form method="get" action="/s/' . $t . '">'
            . '<input type="password" name="password" placeholder="Password" autocomplete="off" required>'
            . '<button type="submit">Open</button></form>';
        return self::html('Protected share', $inner, 401);
    }

    private static function folderPage(string $token, object $adapter, string $path, string $name, string $password): Response
    {
        $esc = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
        $enc = static fn (string $s): string => rawurlencode($s);

        $rows = '';
        foreach ($adapter->list($path) as $entry) {
            $sub = $entry['path'];
            $subParam = $enc(ltrim(substr($sub, strlen(rtrim($path, '/'))), '/'));
            $base = '/s/' . $enc($token) . '?path=' . $subParam
                . ($password !== '' ? '&password=' . $enc($password) : '');
            if ($entry['type'] === 'dir') {
                $rows .= '<tr><td>📁 <a href="' . $esc($base) . '">' . $esc($entry['name']) . '</a></td>'
                    . '<td class="size">—</td></tr>';
            } else {
                $dl = '/s/' . $enc($token) . '/download?path=' . $subParam
                    . ($password !== '' ? '&password=' . $enc($password) : '');
                $rows .= '<tr><td>📄 <a href="' . $esc($dl) . '">' . $esc($entry['name']) . '</a></td>'
                    . '<td class="size">' . $esc(self::humanSize((int) $entry['size'])) . '</td></tr>';
            }
        }
        if ($rows === '') {
            $rows = '<tr><td colspan="2" class="muted">This folder is empty.</td></tr>';
        }

        $inner = '<h1>Shared folder: ' . $esc($name) . '</h1>'
            . '<p class="muted">Read-only. Files are provided by the owner and are not modified by viewing them.</p>'
            . '<div class="crumbs">' . $esc($path) . '</div>'
            . '<table><thead><tr><td><strong>Name</strong></td><td class="size"><strong>Size</strong></td></tr></thead>'
            . '<tbody>' . $rows . '</tbody></table>';
        return self::html('Shared folder', $inner);
    }

    private static function filePage(string $token, array $stat, string $allowDownload): Response
    {
        $esc = static fn (string $s): string => htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
        $enc = static fn (string $s): string => rawurlencode($s);
        $name = (string) $stat['name'];
        $inner = '<h1>Shared file</h1>'
            . '<p class="muted">' . $esc($name) . ' · ' . $esc(self::humanSize((int) $stat['size'])) . '</p>'
            . ($allowDownload === '1'
                ? '<p><a class="btn" href="/s/' . $enc($token) . '/download"><button type="button">Download</button></a></p>'
                : '<p class="muted">Downloads are disabled for this link.</p>');
        return self::html('Shared file', $inner);
    }

    private static function humanSize(int $bytes): string
    {
        if ($bytes < 1024) {
            return $bytes . ' B';
        }
        foreach (['KiB', 'MiB', 'GiB', 'TiB'] as $unit) {
            $bytes /= 1024;
            if ($bytes < 1024) {
                return round($bytes, 1) . ' ' . $unit;
            }
        }
        return round($bytes, 1) . ' PiB';
    }
}
