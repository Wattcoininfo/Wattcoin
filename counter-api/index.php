<?php
/**
 * Wattcoin visit / download counter API
 *
 * GET  /counter-api/?page=<name>  – return current count (no increment)
 * POST /counter-api/?page=<name>  – increment then return new count
 *
 * Allowed page names: whitepaper, wallet, download
 *
 * Counts are stored in a JSON file one level above htdocs so they survive
 * deployments and are never web-accessible.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: https://wattcoin.ee');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store, no-cache');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Validate page name ────────────────────────────────────────────────────────
const ALLOWED = ['homepage', 'whitepaper', 'wallet', 'download', 'whitepaper-pdf'];
$page = isset($_GET['page']) ? (string)$_GET['page'] : '';
if (!in_array($page, ALLOWED, true)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'invalid page']);
    exit;
}

// ── Data file (outside htdocs) ────────────────────────────────────────────────
$dataDir = dirname($_SERVER['DOCUMENT_ROOT']) . '/counter-data';
if (!is_dir($dataDir)) {
    mkdir($dataDir, 0700, true);
}
$countsFile = $dataDir . '/counts.json';
$lockFile   = $dataDir . '/counts.lock';

// ── Exclusive lock ────────────────────────────────────────────────────────────
$fp = fopen($lockFile, 'c');
if (!$fp || !flock($fp, LOCK_EX | LOCK_NB)) {
    // Another request is writing right now; return last known count without blocking.
    $counts = [];
    if (file_exists($countsFile)) {
        $raw = @file_get_contents($countsFile);
        if ($raw) $counts = json_decode($raw, true) ?: [];
    }
    http_response_code(200);
    echo json_encode(['ok' => true, 'count' => (int)($counts[$page] ?? 0)]);
    if ($fp) fclose($fp);
    exit;
}

// ── Read current counts ───────────────────────────────────────────────────────
$counts = [];
if (file_exists($countsFile)) {
    $raw = file_get_contents($countsFile);
    if ($raw !== false) {
        $parsed = json_decode($raw, true);
        if (is_array($parsed)) $counts = $parsed;
    }
}

// ── Increment on POST ─────────────────────────────────────────────────────────
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $counts[$page] = (int)($counts[$page] ?? 0) + 1;
    // Atomic write via temp file + rename
    $tmp = $countsFile . '.tmp';
    file_put_contents($tmp, json_encode($counts, JSON_PRETTY_PRINT));
    rename($tmp, $countsFile);
}

$count = (int)($counts[$page] ?? 0);

flock($fp, LOCK_UN);
fclose($fp);

echo json_encode(['ok' => true, 'count' => $count]);
