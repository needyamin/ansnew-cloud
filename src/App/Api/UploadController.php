<?php

declare(strict_types=1);

namespace App\Api;

use App\Auth\Guard;
use App\Auth\SessionManager;
use App\Core\Request;
use App\Core\Response;
use App\Services\UploadService;

/**
 * Upload endpoints: direct single-file upload + chunked uploads for large files.
 */
final class UploadController
{
    public static function upload(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $path = (string) $req->input('path', '/');
        $conflict = (string) $req->input('conflict', 'rename');
        // Folder uploads send a JSON array of paths relative to the picked
        // folder, index-aligned with the files, so nested structure survives.
        $relPaths = [];
        $raw = (string) $req->input('relPaths', '');
        if ($raw !== '') {
            $decoded = json_decode($raw, true);
            if (is_array($decoded)) {
                $relPaths = array_values(array_map('strval', $decoded));
            }
        }
        $results = UploadService::handleUploadedFiles($user, $mount, $path, $req->files(), $conflict, $relPaths);
        return Response::ok(['files' => $results]);
    }

    public static function chunk(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->isMultipart() ? $_POST : $req->json();
        $r = UploadService::storeChunk($user, $mount, $body, $req->files());
        return Response::ok($r);
    }

    public static function complete(Request $req, SessionManager $session, string $mount): Response
    {
        $user = Guard::requireUser($session);
        $body = $req->json();
        $r = UploadService::complete($user, $mount, $body);
        return Response::ok($r);
    }
}