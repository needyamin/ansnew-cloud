<?php

declare(strict_types=1);

/**
 * ANSNEW CLOUD sole PHP entry point (nginx always routes here).
 */

use App\Api\Routes;
use App\Auth\SessionManager;
use App\Config\Config;
use App\Core\Kernel;
use App\Core\Request;
use App\Core\Router;

require dirname(__DIR__) . '/vendor/autoload.php';

Config::i();

$session = new SessionManager();
$router = new Router();
Routes::register($router, $session);

$kernel = new Kernel($router, $session);
$response = $kernel->handle(Request::fromGlobals());
$response->send();
