<?php

declare(strict_types=1);

/**
 * ANSNEW CLOUD sole PHP entry point (nginx always routes here).
 *
 * Zero external dependencies: App\ classes are resolved by a small built-in
 * PSR-4 autoloader, so no composer install step is required to run the app.
 */

use App\Api\Routes;
use App\Auth\SessionManager;
use App\Config\Config;
use App\Core\Kernel;
use App\Core\Request;
use App\Core\Router;

spl_autoload_register(static function (string $class): void {
    $prefix = 'App\\';
    if (!str_starts_with($class, $prefix)) {
        return;
    }
    $rel = str_replace('\\', '/', substr($class, strlen($prefix)));
    $file = dirname(__DIR__) . '/src/App/' . $rel . '.php';
    if (is_file($file)) {
        require $file;
    }
});

Config::i();

$session = new SessionManager();
$router = new Router();
Routes::register($router, $session);

$kernel = new Kernel($router, $session);
$response = $kernel->handle(Request::fromGlobals());
$response->send();
