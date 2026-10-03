<?php

declare(strict_types=1);

namespace App\Core;

/**
 * Route collection + dispatch. Controllers are callables receiving
 * (Request, ...pathParams) and returning Response.
 */
final class Router
{
    /** @var array<int, array{method:string, regex:string, params:array<int,string>, handler:callable}> */
    private array $routes = [];

    public function get(string $pattern, callable $handler): void
    {
        $this->add('GET', $pattern, $handler);
    }

    public function post(string $pattern, callable $handler): void
    {
        $this->add('POST', $pattern, $handler);
    }

    public function put(string $pattern, callable $handler): void
    {
        $this->add('PUT', $pattern, $handler);
    }

    public function patch(string $pattern, callable $handler): void
    {
        $this->add('PATCH', $pattern, $handler);
    }

    public function delete(string $pattern, callable $handler): void
    {
        $this->add('DELETE', $pattern, $handler);
    }

    public function add(string $method, string $pattern, callable $handler): void
    {
        // Pattern like /api/fs/{mount}/list — {name} becomes a named param.
        $params = [];
        $regex = preg_replace_callback('/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/', static function ($m) use (&$params) {
            $params[] = $m[1];
            return '([^/]+)';
        }, $pattern);
        $regex = '#^' . $regex . '$#';
        $this->routes[] = ['method' => $method, 'regex' => $regex, 'params' => $params, 'handler' => $handler];
    }

    /**
     * @return array{handler:callable, params:array<string,string>, role:?string}|null
     */
    public function match(string $method, string $path): ?array
    {
        // HEAD → GET fallback.
        $try = $method === 'HEAD' ? ['HEAD', 'GET'] : [$method];
        foreach ($try as $m) {
            foreach ($this->routes as $route) {
                if ($route['method'] !== $m) {
                    continue;
                }
                if (preg_match($route['regex'], rawurldecode($path), $matches) === 1) {
                    $params = [];
                    foreach ($route['params'] as $i => $name) {
                        $params[$name] = $matches[$i + 1];
                    }
                    return ['handler' => $route['handler'], 'params' => $params, 'role' => null];
                }
            }
        }
        return null;
    }
}
