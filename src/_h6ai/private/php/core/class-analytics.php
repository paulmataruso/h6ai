<?php
declare(strict_types=1);

// Server side Google Analytics 4 events (Measurement Protocol). Used for downloads, which often
// bypass the browser UI (direct links, wget, download managers) and would be invisible otherwise.
// Calls are made after the response was handed to nginx (fastcgi_finish_request), so they never
// slow down a download.
final class Analytics {
    private const ENDPOINT = 'https://www.google-analytics.com/mp/collect';
    private const TIMEOUT = 3;

    public function __construct(private readonly Context $context) {}

    // Stable pseudonymous user id, or the plain user name if the admin allowed that.
    public function user_id(): ?string {
        $user = $this->context->get_user();
        if ($user === null) {
            return null;
        }
        if ($this->context->get_settings()->get('google.sendUserNames') === true) {
            return $user['name'];
        }
        return 'u-' . substr(hash_hmac('sha256', 'ga-user|' . $user['name'], $this->context->get_secret()), 0, 20);
    }

    // GA client id from the _ga cookie ("GA1.1.<id>.<ts>"), else a stable hash of IP + agent.
    private function client_id(): string {
        $ga = $_COOKIE['_ga'] ?? '';
        if (is_string($ga) && preg_match('/^GA\d\.\d\.(\d+\.\d+)$/', $ga, $m)) {
            return $m[1];
        }
        $request = $this->context->get_request();
        $hash = hash_hmac('sha256', $request->client_ip() . '|' . ($request->header('User-Agent') ?? ''), $this->context->get_secret());
        return hexdec(substr($hash, 0, 8)) . '.' . hexdec(substr($hash, 8, 8));
    }

    public function send(string $name, array $params): void {
        $settings = $this->context->get_settings();
        if (!$settings->is_server_side_tracking()) {
            return;
        }
        $payload = [
            'client_id' => $this->client_id(),
            'non_personalized_ads' => true,
            'events' => [['name' => $name, 'params' => array_merge(['engagement_time_msec' => 1], $params)]]
        ];
        $user_id = $this->user_id();
        if ($user_id !== null) {
            $payload['user_id'] = $user_id;
        }
        $url = Analytics::ENDPOINT . '?' . http_build_query([
            'measurement_id' => $settings->get('google.measurementId'),
            'api_secret' => $settings->get('google.apiSecret')
        ]);
        $context = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\n",
            'content' => json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE),
            'timeout' => Analytics::TIMEOUT,
            'ignore_errors' => true
        ]]);
        if (@file_get_contents($url, false, $context) === false) {
            Logger::log('analytics: measurement protocol request failed');
        }
    }

    public function download(string $kind, string $href, string $base_url): void {
        $name = basename(rtrim($href, '/'));
        $this->send('file_download', [
            'file_name' => rawurldecode($name),
            'file_extension' => strtolower(pathinfo(rawurldecode($name), PATHINFO_EXTENSION)),
            'link_url' => $base_url . $href,
            'download_kind' => $kind
        ]);
    }
}
