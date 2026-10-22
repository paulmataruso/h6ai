<?php
declare(strict_types=1);

// Authorisation endpoint for nginx `auth_request`. nginx asks before serving any file below the
// web root and serves the bytes itself (sendfile, Range, ETag) if we answer 204.
//   204 allowed, 401 denied for visitors who aren't logged in, 403 denied for logged in users and,
//   in anonymous mode (no login at all), for everyone.
// The X-H6ai-Cache-Control header lets nginx mark files that aren't public as private.
//
// Allowed file requests are recorded in the activity log and, if configured, reported to Google
// Analytics, after the answer was handed back to nginx, so neither delays the download.
final class Gate {
    public function __construct(private readonly Context $context) {}

    private function respond(int $status, string $cache_control = 'private, no-cache'): never {
        http_response_code($status);
        header('X-H6ai-Cache-Control: ' . $cache_control);
        header('Content-Length: 0');
        exit;
    }

    private function allow(string $cache_control, ?string $file): never {
        http_response_code(204);
        header('X-H6ai-Cache-Control: ' . $cache_control);
        header('Content-Length: 0');
        if ($file !== null && $this->is_download_start()) {
            if (function_exists('fastcgi_finish_request')) {
                fastcgi_finish_request();
            }
            $this->record($file);
        }
        exit;
    }

    private function request_uri(): string {
        $uri = $_SERVER['H6AI_GATE_URI'] ?? null;
        if (is_string($uri) && $uri !== '') {
            return $uri; // already decoded by nginx
        }
        return rawurldecode((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH));
    }

    // One log entry per download: skip HEAD requests and Range requests that continue an earlier
    // request (video seeking, resumed or segmented downloads).
    private function is_download_start(): bool {
        $method = strtoupper((string) ($_SERVER['H6AI_GATE_METHOD'] ?? 'GET'));
        if ($method !== 'GET') {
            return false;
        }
        $range = $this->context->get_request()->header('Range');
        return $range === null || preg_match('/^\s*bytes\s*=\s*0-/i', $range) === 1;
    }

    private function record(string $file): void {
        try {
            $request = $this->context->get_request();
            $href = $this->context->to_href($file, false);
            $size = @filesize($file);
            (new ActivityLog($this->context))->log('file', rawurldecode($href), [
                'size' => $size === false ? null : $size,
                'dest' => $request->header('Sec-Fetch-Dest'),
                'range' => $request->header('Range') !== null
            ]);
            (new Analytics($this->context))->download('file', $href, (new Seo($this->context))->base_url());
        } catch (Throwable $err) {
            Logger::log('gate: recording failed: ' . $err->getMessage());
        }
    }

    public function check(): never {
        $path = $this->context->decoded_to_path($this->request_uri());
        if ($path === null) {
            $this->respond(403);
        }

        // folder URLs render the h6ai index, which applies the permissions itself
        if (is_dir($path)) {
            $this->respond(204, 'private, no-cache');
        }

        $file = is_file($path) ? $path : null;
        $acl = $this->context->get_acl();
        if (!$acl->is_enabled()) {
            $this->allow('public, no-cache', $file);
        }

        $dir = Util::normalize_path(dirname($path));
        if ($this->context->can($dir, Acl::READ)) {
            $rules = $this->context->get_auth_store()->get_effective_rules();
            $public = Acl::is_public($rules, $this->context->to_rel_path($dir));
            $this->allow($public ? 'public, no-cache' : 'private, no-cache', $file);
        }

        // 401 invites a login; in anonymous mode there is none to offer
        $this->respond($this->context->get_user() === null && !$this->context->is_anonymous_mode() ? 401 : 403);
    }
}
