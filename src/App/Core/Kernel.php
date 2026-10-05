<?php

declare(strict_types=1);

namespace App\Core;

use App\Auth\SessionManager;
use App\Config\Config;
use App\Core\Database;
use App\Support\PathGuard;
use Closure;

/**
 * HTTP kernel: global middleware (sessions, security headers, CSRF, rate limit,
 * origin check) + route dispatch.
 */
final class Kernel
{
    public function __construct(
        private readonly Router $router,
        private readonly SessionManager $session,
    ) {
    }

    public function handle(Request $request): Response
    {
        try {
            $cfg = Config::i();

            // ---- security headers on every response ----
            $commonHeaders = [
                'X-Content-Type-Options' => 'nosniff',
                'X-Frame-Options' => 'DENY',
                'Referrer-Policy' => 'strict-origin-when-cross-origin',
                'Cache-Control' => 'no-store',
                // Nothing here needs those capabilities; advertising them as
                // unavailable removes an attack surface for nothing in return.
                'Permissions-Policy' => 'geolocation=(), microphone=(), camera=()',
                // Hardens against tab-nabbing and against other origins reading
                // these responses, which matters for a file manager.
                'Cross-Origin-Opener-Policy' => 'same-origin',
                'Cross-Origin-Resource-Policy' => 'same-origin',
                // A file manager has no reason to be indexed.
                'X-Robots-Tag' => 'noindex, nofollow',
            ];

            try {
                // ---- session ----
                if (!$this->session->isStarted()) {
                    $this->session->start();
                }

                // ---- same-origin enforcement for unsafe methods ----
                // Exception: internal service-to-service calls authenticated
                // by the shared PHP<->WS secret (never exposed to browsers).
                $isInternal = str_starts_with($request->path, '/api/internal/')
                    && hash_equals($cfg->wsSecret(), (string) ($request->header('x-internal-secret') ?? ''));
                if (!in_array($request->method, ['GET', 'HEAD', 'OPTIONS'], true) && !$isInternal) {
                    if (!$request->originIsTrusted($cfg->get('APP_URL', 'http://localhost:8080'))) {
                        return $this->finish(Response::error('Cross-origin request rejected', 403, 'csrf'), $commonHeaders);
                    }
                    $token = (string) ($request->header('x-csrf-token') ?? '');
                    if (!$this->session->validateCsrf($token)) {
                        return $this->finish(Response::error('CSRF token missing or invalid', 403, 'csrf'), $commonHeaders);
                    }
                }

                // ---- rate limit (per user-or-IP) ----
                // Thumbnails are numerous but cheap. They used to share one
                // bucket with everything else, so opening a folder of a few
                // hundred images would trip the limiter and then degrade every
                // other operation for a minute. They get a separate, larger
                // bucket: asset loading can't starve real operations, and
                // hammering assets can't buy extra quota for real operations.
                $bucketId = $this->session->get('user_id') ? (string) $this->session->get('user_id') : $request->ip();
                $isAsset = str_starts_with($request->path, '/api/fs/')
                    && str_ends_with($request->path, '/thumb');
                $bucketKey = 'rl:' . $bucketId . ($isAsset ? ':asset' : '');
                $maxRequests = $isAsset
                    ? $cfg->getInt('RATE_LIMIT_ASSET_REQUESTS', 1200)
                    : $cfg->getInt('RATE_LIMIT_REQUESTS', 600);
                if (!RateLimiter::allow($bucketKey, $maxRequests, $cfg->getInt('RATE_LIMIT_WINDOW', 60))) {
                    return $this->finish(Response::error('Too many requests', 429, 'rate_limited'), $commonHeaders);
                }

                // ---- dispatch ----
                $match = $this->router->match($request->method, $request->path);
                if ($match === null) {
                    return $this->finish(Response::error('Not found', 404, 'not_found'), $commonHeaders);
                }

                $response = ($match['handler'])($request, ...array_values($match['params']));
                if (!$response instanceof Response) {
                    $response = Response::ok($response);
                }
                return $this->finish($response, $commonHeaders);
            } catch (\InvalidArgumentException $e) {
                return $this->finish(Response::error($e->getMessage(), 400, 'bad_request'), $commonHeaders);
            } catch (\RuntimeException $e) {
                $msg = $e->getMessage();
                // Services already annotate their exceptions with the intended
                // HTTP status (403 for permission, 404 for missing). Honour it
                // instead of sniffing the message text — a 403 that reads
                // "this drive is read-only for you" contains neither "denied"
                // nor "forbidden", so the sniffing turned it into a 500 and the
                // client could not tell a permission problem from a crash.
                $status = 500;
                $code = (int) $e->getCode();
                if ($code >= 400 && $code <= 599) {
                    $status = $code;
                } elseif (str_contains(strtolower($msg), 'not found')) {
                    $status = 404;
                } elseif (str_contains(strtolower($msg), 'denied') || str_contains(strtolower($msg), 'forbidden')) {
                    $status = 403;
                } elseif (str_contains(strtolower($msg), 'exists')) {
                    $status = 409;
                }
                error_log('[ansnew] ' . $msg);
                return $this->finish(Response::error('Operation failed: ' . $msg, $status), $commonHeaders);
            } catch (\Throwable $e) {
                error_log('[ansnew] uncaught: ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
                return $this->finish(Response::error('Internal error', 500), $commonHeaders);
            }
        } catch (\Throwable $fatal) {
            error_log('[ansnew] fatal: ' . $fatal->getMessage());
            return Response::error('Internal error', 500);
        }
    }

    /**
     * Apply the common security headers *without* clobbering anything a
     * controller set deliberately. Previously this overwrote Cache-Control
     * unconditionally, which silently killed the cache headers on thumbnails,
     * previews and (now) the conditional-GET ETag on directory listings.
     *
     * @param array<string,string> $headers
     */
    private function finish(Response $response, array $headers): Response
    {
        $existing = $response->headers();
        foreach ($headers as $k => $v) {
            if (!array_key_exists(strtolower($k), $existing)) {
                $response->withHeader($k, $v);
            }
        }
        return $response;
    }
}
