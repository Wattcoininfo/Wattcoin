<?php
/**
 * Wattcoin electricity price proxy
 *
 * GET /elec-price-api/
 *
 * Returns the current global average electricity price (USD/kWh) sourced from
 * globalpetrolprices.com, cached server-side for 24 hours.
 *
 * Response: { "ok": true, "price": 0.165, "source": "live|cache|fallback" }
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: https://wattcoin.ee');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Cache-Control: public, max-age=3600');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

const FALLBACK_PRICE  = 0.174;
const CACHE_TTL_SECS  = 86400; // 24 hours
const FETCH_URL       = 'https://www.globalpetrolprices.com/electricity_prices/';
const FETCH_TIMEOUT   = 10;
const MAX_BYTES       = 3 * 1024 * 1024;

// ── Cache directory (outside htdocs so it is never web-accessible) ────────────
$cacheDir  = dirname($_SERVER['DOCUMENT_ROOT']) . '/elec-price-cache';
$cacheFile = $cacheDir . '/price.json';

if (!is_dir($cacheDir)) {
    @mkdir($cacheDir, 0700, true);
}

// ── Try cached value first ────────────────────────────────────────────────────
if (file_exists($cacheFile)) {
    $raw = @file_get_contents($cacheFile);
    if ($raw !== false) {
        $cached = json_decode($raw, true);
        if (
            is_array($cached) &&
            isset($cached['price'], $cached['cachedAt']) &&
            is_numeric($cached['price']) &&
            (time() - (int)$cached['cachedAt']) < CACHE_TTL_SECS
        ) {
            echo json_encode(['ok' => true, 'price' => (float)$cached['price'], 'source' => 'cache']);
            exit;
        }
    }
}

// ── Live fetch via cURL ───────────────────────────────────────────────────────
$price  = null;
$source = 'fallback';

if (function_exists('curl_init')) {
    $ch = curl_init(FETCH_URL);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS      => 3,
        CURLOPT_TIMEOUT        => FETCH_TIMEOUT,
        CURLOPT_USERAGENT      => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER     => ['Accept: text/html,application/xhtml+xml,*/*', 'Accept-Language: en-US,en;q=0.9'],
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_BUFFERSIZE     => 65536,
    ]);

    // Abort after MAX_BYTES to avoid buffering multi-MB responses
    $bytesRead = 0;
    $html      = '';
    curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $data) use (&$bytesRead, &$html) {
        $bytesRead += strlen($data);
        if ($bytesRead > MAX_BYTES) return -1; // abort
        $html .= $data;
        return strlen($data);
    });

    $ok = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($ok !== false && $httpCode >= 200 && $httpCode < 300 && strlen($html) > 0) {
        // Try several patterns in order of reliability (same logic as electron-main.js)
        $patterns = [
            // prose text in article body (raw HTML)
            '/electricity price in the world is USD ([0-9]+\.[0-9]+)/i',
            // JS data array formats
            '/"World"\s*,\s*"[^"]*"\s*,\s*"([0-9]+\.[0-9]+)"/i',
            '/\'World\'\s*,\s*([0-9]+\.[0-9]+)/i',
            '/"World"\s*,\s*([0-9]+\.[0-9]+)/i',
            '/arrData\.push\(\["World"[^\]]*?,([\d.]+)/',
            // HTML table cell after World
            '/World[^<]{0,120}<\/td>\s*<td[^>]*>\s*([0-9]+\.[0-9]+)/i',
        ];
        foreach ($patterns as $re) {
            if (preg_match($re, $html, $m)) {
                $p = (float)$m[1];
                if ($p > 0.01 && $p < 5.0) {
                    $price  = $p;
                    $source = 'live';
                    break;
                }
            }
        }
    }
}

// ── Persist to cache ──────────────────────────────────────────────────────────
if ($price !== null) {
    $tmp = $cacheFile . '.tmp';
    @file_put_contents($tmp, json_encode(['price' => $price, 'cachedAt' => time()]));
    @rename($tmp, $cacheFile);
} else {
    // Use last cached price even if stale before falling back to constant
    if (file_exists($cacheFile)) {
        $raw = @file_get_contents($cacheFile);
        if ($raw !== false) {
            $stale = json_decode($raw, true);
            if (is_array($stale) && isset($stale['price']) && is_numeric($stale['price'])) {
                $price = (float)$stale['price'];
                $source = 'stale-cache';
            }
        }
    }
    if ($price === null) {
        $price = FALLBACK_PRICE;
    }
}

echo json_encode(['ok' => true, 'price' => $price, 'source' => $source]);
