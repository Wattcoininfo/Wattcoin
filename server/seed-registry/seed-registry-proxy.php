<?php
declare(strict_types=1);

$target = 'http://127.0.0.1:4901';
$path = $_SERVER['REQUEST_URI'];
// Strip /api prefix to match what the Node server expects
$path = preg_replace('#^/api/seed-registry#', '', $path);
if ($path === '') $path = '/';

$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL => $target . $path,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_CONNECTTIMEOUT => 5,
]);

$method = strtoupper($_SERVER['REQUEST_METHOD']);
if ($method === 'POST') {
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents('php://input'));
}

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$headerSize = curl_getinfo($ch, CURLINFO_HEADER_SIZE);
curl_close($ch);

if ($response === false) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['ok' => false, 'error' => 'Seed registry unreachable']);
    exit;
}

$body = substr($response, $headerSize);
$headers = substr($response, 0, $headerSize);

http_response_code($httpCode);
foreach (explode("\r\n", $headers) as $h) {
    $h = trim($h);
    if ($h === '' || stripos($h, 'Transfer-Encoding:') === 0 || stripos($h, 'Connection:') === 0) continue;
    header($h, false);
}
echo $body;
