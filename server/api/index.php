<?php
/**
 * Wattcoin Sale API
 * Handles WTC purchase orders for the web wallet.
 * Endpoints (all under /api):
 *   GET  /sale-status
 *   POST /compute-price   { wtcAmount, electricityPricePerKwh }
 *   POST /place-order     { wtcAddress, wtcAmount, usdcRequired }
 *   POST /upsert-order    { apiKey, id, wtcAddress, wtcAmount, usdcRequired, status, ... }
 *   GET  /order/:id
 *   POST /cancel-order    { orderId }
 */

declare(strict_types=1);

// ── Headers ──────────────────────────────────────────────────────────────────
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: https://wattcoin.ee');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Api-Key, X-Order-Proof');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// ── Data storage (outside htdocs) ────────────────────────────────────────────
$homeDir  = dirname($_SERVER['DOCUMENT_ROOT']);
$dataDir  = $homeDir . '/sale-data';
if (!is_dir($dataDir)) {
    mkdir($dataDir, 0700, true);
}
$ordersFile = $dataDir . '/sale-orders.json';

// ── Secrets loader ────────────────────────────────────────────────────────────
// Reads a secret value from $homeDir/.secrets/<name>. Returns $default if the
// file does not exist so the app works with bundled defaults out-of-the-box.
// On the production server, create the file (chmod 600) to override the default.
function loadSecret(string $name, string $default = ''): string {
    $file = dirname($_SERVER['DOCUMENT_ROOT']) . '/.secrets/' . basename($name);
    if (file_exists($file) && is_readable($file)) {
        $val = trim((string)file_get_contents($file));
        return $val !== '' ? $val : $default;
    }
    return $default;
}

// ── Config ───────────────────────────────────────────────────────────────────
const SELLER_USDC_ADDRESS = '0x0ca8cc23d85e5c988828076978c4ca65aa4293e8';
const SALE_TOTAL          = 333333;
const SALE_TIER_SIZE      = 111111;
const MIN_BUY_WTC         = 1;
const PAYMENT_EXPIRY_SECS = 86400; // 24 hours

const SALE_TIERS = [
    ['fraction' => 1/3, 'start' => 0,      'end' => 111111],
    ['fraction' => 2/3, 'start' => 111111,  'end' => 222222],
    ['fraction' => 1,   'start' => 222222,  'end' => 333333],
];

define('ETHERSCAN_API_KEY', loadSecret('etherscan-api-key', base64_decode('SEhWMUNVRlVJRUgxRjMyVjlEQlNYMlEzQVVKRkRDQVJTWg==')));
const USDC_CONTRACT        = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ETHERSCAN_CACHE_SECS = 300; // re-use Etherscan response for 5 minutes
const MATCH_TX_GRACE_MS    = 5 * 60 * 1000; // allow a small index/clock skew window

// ── Helpers ──────────────────────────────────────────────────────────────────
function loadOrders(string $file): array {
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveOrders(string $file, array $orders): void {
    $tmp = $file . '.tmp';
    file_put_contents($tmp, json_encode(array_values($orders), JSON_PRETTY_PRINT));
    rename($tmp, $file);
}

function getSoldWtc(array $orders): int {
    $sold = 0;
    foreach ($orders as $o) {
        if (in_array($o['status'], ['queued', 'delivery_pending', 'fulfilled'], true)) {
            $sold += (int)($o['wtcAmount'] ?? 0);
        }
    }
    return $sold;
}

function computePrice(float $wtcAmount, float $elPrice, int $soldWtc): ?float {
    $remaining = $wtcAmount;
    $total     = 0.0;
    $position  = $soldWtc;
    foreach (SALE_TIERS as $tier) {
        if ($remaining <= 0) break;
        if ($position >= $tier['end']) continue;
        $availInTier  = $tier['end'] - max($tier['start'], $position);
        $usedFromTier = min($remaining, $availInTier);
        $pricePerWtc  = $elPrice * 20 * $tier['fraction'];
        $total       += $usedFromTier * $pricePerWtc;
        $remaining   -= $usedFromTier;
        $position    += $usedFromTier;
    }
    if ($remaining > 0) return null; // sold out
    return round($total * 1e6) / 1e6;
}

function expireOldOrders(array &$orders): bool {
    $changed = false;
    $now = time();
    foreach ($orders as &$o) {
        if ($o['status'] === 'pending_payment') {
            $created = isset($o['createdAtMs']) ? (int)($o['createdAtMs'] / 1000) : 0;
            if ($created > 0 && ($now - $created) > PAYMENT_EXPIRY_SECS) {
                $o['status'] = 'expired';
                $changed = true;
            }
        }
    }
    return $changed;
}

function jsonOut(array $data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function isTxTooOldForOrder(array $tx, array $order): bool {
    $createdAtMs = isset($order['createdAtMs']) ? (int)$order['createdAtMs'] : 0;
    $txTimeRaw   = isset($tx['timeStamp']) ? (int)$tx['timeStamp'] : 0;
    if ($createdAtMs <= 0 || $txTimeRaw <= 0) return false;
    $txTimeMs = $txTimeRaw * 1000;
    return $txTimeMs < ($createdAtMs - MATCH_TX_GRACE_MS);
}

function paymentIsSufficientForOrder(array $order, float $usdcValue): bool {
    $required = (float)($order['usdcRequired'] ?? 0);
    if ($required <= 0) return false;
    return ($usdcValue + 0.000001) >= $required; // 1 micro-USDC tolerance
}

function txAlreadyLinkedToAnyOrder(array $orders, string $hash, ?string $exceptOrderId = null): bool {
    $needle = strtolower(trim($hash));
    if ($needle === '') return false;

    foreach ($orders as $o) {
        $orderId = (string)($o['id'] ?? '');
        if ($exceptOrderId !== null && $orderId === $exceptOrderId) continue;

        $matched = strtolower((string)($o['matchedTxHash'] ?? ''));
        $known   = strtolower((string)($o['knownTxHash'] ?? ''));
        if ($matched === $needle || $known === $needle) {
            return true;
        }
    }

    return false;
}

function getApiKeyFromRequest(array $body): string {
    // API key is accepted from the X-Api-Key request header only.
    // Body-based fallback was removed to prevent the key appearing in access logs.
    return isset($_SERVER['HTTP_X_API_KEY']) ? trim((string)$_SERVER['HTTP_X_API_KEY']) : '';
}

function getOrderProofFromRequest(array $body): string {
    if (isset($body['ownerProof'])) {
        return trim((string)$body['ownerProof']);
    }
    if (isset($_GET['ownerProof'])) {
        return trim((string)$_GET['ownerProof']);
    }
    if (isset($_SERVER['HTTP_X_ORDER_PROOF'])) {
        return trim((string)$_SERVER['HTTP_X_ORDER_PROOF']);
    }
    return '';
}

function issueOrderProof(array &$order): string {
    $proof = bin2hex(random_bytes(24));
    $order['ownerProofHash'] = hash('sha256', $proof);
    return $proof;
}

function ensureOrderProofExists(array &$order): ?string {
    $existingHash = isset($order['ownerProofHash']) ? trim((string)$order['ownerProofHash']) : '';
    if ($existingHash !== '') return null;
    return issueOrderProof($order);
}

function orderOwnedByRequest(array $order, string $providedProof): bool {
    $storedHash = isset($order['ownerProofHash']) ? trim((string)$order['ownerProofHash']) : '';
    if ($storedHash === '' || $providedProof === '') return false;
    return hash_equals($storedHash, hash('sha256', $providedProof));
}

function sanitizeOrderForClient(array $order): array {
    unset($order['ownerProofHash']);
    return $order;
}

// ── Server-side Etherscan payment matching ────────────────────────────────────

function loadSeenHashes(string $dataDir): array {
    $f = $dataDir . '/seen-tx-hashes.json';
    if (!file_exists($f)) return [];
    $d = json_decode(file_get_contents($f), true);
    return is_array($d) ? $d : [];
}

function saveSeenHashes(string $dataDir, array $hashes): void {
    file_put_contents($dataDir . '/seen-tx-hashes.json', json_encode(array_values($hashes)));
}

/**
 * Fetch last 100 USDC transfers to our seller address from Etherscan.
 * Result is cached in a file for ETHERSCAN_CACHE_SECS to avoid hammering the API.
 */
function fetchUsdcTransfers(string $dataDir): ?array {
    $cacheFile = $dataDir . '/etherscan-cache.json';
    if (file_exists($cacheFile)) {
        $cached = json_decode(file_get_contents($cacheFile), true);
        if (is_array($cached) && isset($cached['ts']) && (time() - (int)$cached['ts']) < ETHERSCAN_CACHE_SECS) {
            return $cached['txs'];
        }
    }
    $params = http_build_query([
        'chainid'         => '1',
        'module'          => 'account',
        'action'          => 'tokentx',
        'contractaddress' => USDC_CONTRACT,
        'address'         => SELLER_USDC_ADDRESS,
        'sort'            => 'desc',
        'offset'          => '100',
        'page'            => '1',
        'apikey'          => ETHERSCAN_API_KEY,
    ]);
    $ctx = stream_context_create(['http' => [
        'timeout'        => 10,
        'user_agent'     => 'wattcoin-sale-api/1.0',
        'ignore_errors'  => true,
    ]]);
    $raw = @file_get_contents('https://api.etherscan.io/v2/api?' . $params, false, $ctx);
    if ($raw === false) return null;
    $body = json_decode($raw, true);
    if (!is_array($body)) return null;
    if ($body['status'] === '0' && ($body['message'] ?? '') === 'No transactions found') {
        file_put_contents($cacheFile, json_encode(['ts' => time(), 'txs' => []]));
        return [];
    }
    if ($body['status'] !== '1' || !is_array($body['result'] ?? null)) return null;
    file_put_contents($cacheFile, json_encode(['ts' => time(), 'txs' => $body['result']]));
    return $body['result'];
}

/**
 * Match unseen Etherscan USDC transfers to pending/submitted orders.
 * Priority: 1) exact knownTxHash  2) exact buyerEthAddress  3) amount proximity (20%).
 * Seen-hash deduplication prevents any tx being applied twice.
 * Returns true if any order was updated.
 */
function matchPendingPayments(string $dataDir, array &$orders): bool {
    $txs = fetchUsdcTransfers($dataDir);
    if (!is_array($txs) || empty($txs)) return false;

    $seenHashes  = loadSeenHashes($dataDir);
    $seenSet     = array_flip($seenHashes);
    $changed     = false;
    $newSeen     = false;

    foreach ($txs as $tx) {
        $hash  = strtolower((string)($tx['hash']  ?? ''));
        $to    = strtolower((string)($tx['to']    ?? ''));
        $from  = strtolower((string)($tx['from']  ?? ''));
        $value = (int)($tx['value'] ?? 0);

        if (!$hash || $to !== strtolower(SELLER_USDC_ADDRESS)) continue;
        if (isset($seenSet[$hash])) continue;

        $usdcValue = $value / 1e6;
        if ($usdcValue <= 0) continue;

        // If this hash is already linked to any order record, never re-link it.
        // This protects against seen-hash resets and old-tx reprocessing.
        if (txAlreadyLinkedToAnyOrder($orders, $hash)) {
            continue;
        }

        // Mark seen regardless of whether we find a match
        $seenHashes[] = $hash;
        $seenSet[$hash] = true;
        $newSeen = true;

        $matchIdx = null;

        // Pass 1: exact knownTxHash
        foreach ($orders as $i => $o) {
            if (!in_array($o['status'], ['pending_payment', 'payment_submitted'], true)) continue;
            if (isTxTooOldForOrder($tx, $o)) continue;
            if (!empty($o['knownTxHash']) && strtolower($o['knownTxHash']) === $hash && paymentIsSufficientForOrder($o, $usdcValue)) {
                $matchIdx = $i; break;
            }
        }
        // Pass 2: exact buyerEthAddress
        if ($matchIdx === null && $from !== '') {
            foreach ($orders as $i => $o) {
                if (!in_array($o['status'], ['pending_payment', 'payment_submitted'], true)) continue;
                if (isTxTooOldForOrder($tx, $o)) continue;
                if (!empty($o['buyerEthAddress']) && strtolower($o['buyerEthAddress']) === $from && paymentIsSufficientForOrder($o, $usdcValue)) {
                    $matchIdx = $i; break;
                }
            }
        }
        // Pass 3: amount-based fallback (full amount only)
        if ($matchIdx === null) {
            $bestDelta = PHP_FLOAT_MAX;
            foreach ($orders as $i => $o) {
                if (!in_array($o['status'], ['pending_payment', 'payment_submitted'], true)) continue;
                if (isTxTooOldForOrder($tx, $o)) continue;
                $required = (float)($o['usdcRequired'] ?? 0);
                if ($required <= 0) continue;
                if (!paymentIsSufficientForOrder($o, $usdcValue)) continue;
                $delta = abs($required - $usdcValue);
                if ($delta < $bestDelta) {
                    $bestDelta = $delta;
                    $matchIdx  = $i;
                }
            }
        }

        if ($matchIdx !== null) {
            // Safety: never attach the same transfer hash to more than one order.
            $alreadyLinkedElsewhere = false;
            foreach ($orders as $k => $existing) {
                if ($k === $matchIdx) continue;
                $existingHash = strtolower((string)($existing['matchedTxHash'] ?? ''));
                if ($existingHash !== '' && $existingHash === $hash) {
                    $alreadyLinkedElsewhere = true;
                    break;
                }
            }
            if ($alreadyLinkedElsewhere) {
                continue;
            }

            $orders[$matchIdx]['status']        = 'queued';
            $orders[$matchIdx]['matchedTxHash'] = $tx['hash'];
            $orders[$matchIdx]['matchedAtMs']   = (int)(microtime(true) * 1000);
            $changed = true;
        }
    }

    if ($newSeen) saveSeenHashes($dataDir, $seenHashes);
    return $changed;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
function getClientIp(): string {
    // Cloudflare sets CF-Connecting-IP to the real client IP.
    if (isset($_SERVER['HTTP_CF_CONNECTING_IP'])) {
        return (string)$_SERVER['HTTP_CF_CONNECTING_IP'];
    }
    return isset($_SERVER['REMOTE_ADDR']) ? (string)$_SERVER['REMOTE_ADDR'] : '';
}

function checkRateLimit(string $ip, string $endpoint, int $maxRequests, int $windowSecs): bool {
    if ($ip === '') return true; // no IP available — allow (shouldn't happen in practice)
    global $dataDir;
    $rlDir = $dataDir . '/rate-limits';
    if (!is_dir($rlDir)) @mkdir($rlDir, 0700, true);
    $file = $rlDir . '/' . md5($ip . ':' . $endpoint) . '.json';
    $now  = time();
    $hits = [];
    if (file_exists($file)) {
        $raw = @json_decode(@file_get_contents($file), true);
        if (is_array($raw)) {
            $hits = array_values(array_filter($raw, static fn($t) => ($now - (int)$t) < $windowSecs));
        }
    }
    if (count($hits) >= $maxRequests) return false;
    $hits[] = $now;
    @file_put_contents($file, json_encode($hits));
    return true;
}

// ── Route ─────────────────────────────────────────────────────────────────────
$uri    = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$method = strtoupper($_SERVER['REQUEST_METHOD']);

// Strip /api prefix
$path = preg_replace('#^/api#i', '', $uri);
$path = rtrim($path, '/') ?: '/';

$body = [];
if (in_array($method, ['POST', 'PUT', 'PATCH'], true)) {
    $raw = file_get_contents('php://input');
    if ($raw) $body = json_decode($raw, true) ?: [];
}

// ── POST /compute-price ───────────────────────────────────────────────────────
if ($method === 'POST' && $path === '/compute-price') {
    if (!checkRateLimit(getClientIp(), 'compute-price', 30, 60)) {
        jsonOut(['ok' => false, 'error' => 'Rate limit exceeded'], 429);
    }
    $amt     = isset($body['wtcAmount'])              ? (float)$body['wtcAmount']              : 0;
    $elPrice = isset($body['electricityPricePerKwh']) ? (float)$body['electricityPricePerKwh'] : 0;

    if ($amt < MIN_BUY_WTC) {
        jsonOut(['ok' => false, 'error' => 'Minimum ' . MIN_BUY_WTC . ' WTC']);
    }
    if ($elPrice <= 0) {
        jsonOut(['ok' => false, 'error' => 'Invalid electricity price']);
    }

    $orders  = loadOrders($ordersFile);
    $sold    = getSoldWtc($orders);
    $usdc    = computePrice($amt, $elPrice, $sold);

    if ($usdc === null) {
        jsonOut(['ok' => false, 'error' => 'Sale supply exhausted']);
    }

    jsonOut(['ok' => true, 'usdcRequired' => $usdc, 'wtcAmount' => $amt]);
}

// ── GET /sale-status - public sold/remaining totals without exposing orders ──
if ($method === 'GET' && $path === '/sale-status') {
    $orders = loadOrders($ordersFile);
    $dirty = expireOldOrders($orders);
    if (matchPendingPayments($dataDir, $orders)) $dirty = true;
    if ($dirty) saveOrders($ordersFile, $orders);

    $sold = getSoldWtc($orders);
    jsonOut([
        'ok' => true,
        'sold' => $sold,
        'remaining' => max(0, SALE_TOTAL - $sold),
        'total' => SALE_TOTAL,
        'tierSize' => SALE_TIER_SIZE,
        'tiers' => SALE_TIERS,
        'minBuy' => MIN_BUY_WTC,
    ]);
}

// ── POST /place-order ─────────────────────────────────────────────────────────
if ($method === 'POST' && $path === '/place-order') {
    if (!checkRateLimit(getClientIp(), 'place-order', 5, 60)) {
        jsonOut(['ok' => false, 'error' => 'Rate limit exceeded'], 429);
    }
    $addr    = isset($body['wtcAddress'])      ? trim((string)$body['wtcAddress'])      : '';
    $amt     = isset($body['wtcAmount'])       ? (int)$body['wtcAmount']                : 0;
    $ethAddr = isset($body['buyerEthAddress']) ? strtolower(trim((string)$body['buyerEthAddress'])) : null;
    // usdcRequired from client is intentionally ignored — price is always recomputed server-side

    if (!$addr || strpos($addr, 'wtc1q') !== 0 || strlen($addr) !== 43) {
        jsonOut(['ok' => false, 'error' => 'Invalid WTC address']);
    }
    if ($amt < MIN_BUY_WTC || $amt > SALE_TOTAL) {
        jsonOut(['ok' => false, 'error' => 'Minimum ' . MIN_BUY_WTC . ' WTC']);
    }
    // Validate Ethereum address if provided
    if ($ethAddr !== null && !preg_match('/^0x[0-9a-f]{40}$/i', $ethAddr)) {
        jsonOut(['ok' => false, 'error' => 'Invalid USDC wallet address']);
    }

    $orders = loadOrders($ordersFile);
    expireOldOrders($orders);

    // Compute price server-side — never trust client-supplied usdcRequired
    $usdc = computePrice($amt, 0.18, getSoldWtc($orders));
    if ($usdc === null) {
        jsonOut(['ok' => false, 'error' => 'Sale supply exhausted']);
    }

    // Block if there is an unpaid order already open for this address.
    // queued/delivery_pending are already paid and should not prevent new purchases.
    foreach ($orders as $o) {
        if ($o['wtcAddress'] === $addr && in_array($o['status'], ['pending_payment', 'payment_submitted'], true)) {
            if (!isset($o['ownerProofHash']) || trim((string)$o['ownerProofHash']) === '') {
                $fresh = issueOrderProof($o);
                foreach ($orders as &$existingOrder) {
                    if (($existingOrder['id'] ?? '') === ($o['id'] ?? '')) {
                        $existingOrder['ownerProofHash'] = $o['ownerProofHash'];
                        break;
                    }
                }
                unset($existingOrder);
                saveOrders($ordersFile, $orders);
                $ownerProof = $fresh;
            } else {
                $ownerProof = null;
            }
            jsonOut([
                'ok'                 => true,
                'orderId'            => $o['id'],
                'usdcRequired'       => $o['usdcRequired'],
                'sellerUsdcAddress'  => SELLER_USDC_ADDRESS,
                'alreadyExists'      => true,
                'ownerProof'         => $ownerProof,
            ]);
        }
    }

    $orderId = bin2hex(random_bytes(12));
    $ownerProof = bin2hex(random_bytes(24));
    $order   = [
        'id'               => $orderId,
        'ownerProofHash'   => hash('sha256', $ownerProof),
        'wtcAddress'       => $addr,
        'wtcAmount'        => $amt,
        'usdcRequired'     => round($usdc * 1e6) / 1e6,
        'buyerEthAddress'  => $ethAddr,   // null if not provided (legacy / Electron orders)
        'status'           => 'pending_payment',
        'createdAtMs'      => (int)(microtime(true) * 1000),
        'matchedTxHash'    => null,
        'fulfilledTxId'    => null,
        'fulfilledAtMs'    => null,
    ];

    $orders[] = $order;
    saveOrders($ordersFile, $orders);

    jsonOut([
        'ok'                => true,
        'orderId'           => $orderId,
        'ownerProof'        => $ownerProof,
        'usdcRequired'      => $order['usdcRequired'],
        'sellerUsdcAddress' => SELLER_USDC_ADDRESS,
    ]);
}

// ── GET /orders - Electron app syncs server orders for payment matching ───────
if ($method === 'GET' && $path === '/orders') {
    // Require API key — exposes the full customer order list with ETH addresses.
    // Uses X-Api-Key header (Apache reliably passes custom headers; Authorization may be stripped).
    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $provided  = isset($_SERVER['HTTP_X_API_KEY']) ? trim($_SERVER['HTTP_X_API_KEY']) : '';
    if (!$storedKey || !hash_equals($storedKey, $provided)) {
        jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
    }
    $orders = loadOrders($ordersFile);
    if (expireOldOrders($orders)) saveOrders($ordersFile, $orders);
    // Return all orders, including terminal ones, so Electron clients can
    // converge local mirrored records to cancelled/expired/failed states.
    jsonOut(['ok' => true, 'orders' => array_values($orders)]);
}

// ── POST /update-order - Electron calls after matching/fulfilling ────────────
if ($method === 'POST' && $path === '/update-order') {
    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $provided  = getApiKeyFromRequest($body);
    if (!$storedKey || !hash_equals($storedKey, $provided)) {
        jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
    }
    $orderId = isset($body['orderId']) ? trim((string)$body['orderId']) : '';
    $status  = isset($body['status'])  ? trim((string)$body['status'])  : '';
    if (!$orderId || !in_array($status, ['queued', 'delivery_pending', 'fulfilled', 'failed'], true)) {
        jsonOut(['ok' => false, 'error' => 'Invalid parameters']);
    }
    $orders = loadOrders($ordersFile);
    $found  = false;
    foreach ($orders as &$o) {
        if ($o['id'] === $orderId) {
            if (isset($body['matchedTxHash'])) {
                $newHash = strtolower(trim((string)$body['matchedTxHash']));
                if ($newHash !== '') {
                    foreach ($orders as $other) {
                        if (($other['id'] ?? '') === $orderId) continue;
                        $otherHash = strtolower((string)($other['matchedTxHash'] ?? ''));
                        if ($otherHash !== '' && $otherHash === $newHash) {
                            jsonOut(['ok' => false, 'error' => 'matchedTxHash already linked to another order'], 409);
                        }
                    }
                }
            }

            $o['status'] = $status;
            if (isset($body['matchedTxHash'])) $o['matchedTxHash'] = $body['matchedTxHash'];
            if (isset($body['fulfilledTxId'])) $o['fulfilledTxId'] = $body['fulfilledTxId'];
            if (isset($body['fulfilledAtMs']))  $o['fulfilledAtMs']  = (int)$body['fulfilledAtMs'];
            if ($status === 'queued') $o['matchedAtMs'] = (int)(microtime(true) * 1000);
            $found = true;
            break;
        }
    }
    unset($o);
    if (!$found) jsonOut(['ok' => false, 'error' => 'Order not found'], 404);
    saveOrders($ordersFile, $orders);
    jsonOut(['ok' => true]);
}

// ── POST /upsert-order - Electron legacy backfill of local-only app orders ───
if ($method === 'POST' && $path === '/upsert-order') {
    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $provided  = getApiKeyFromRequest($body);
    if (!$storedKey || !hash_equals($storedKey, $provided)) {
        jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
    }

    $orderId    = isset($body['id'])         ? trim((string)$body['id'])         : '';
    $wtcAddress = isset($body['wtcAddress']) ? trim((string)$body['wtcAddress']) : '';
    $wtcAmount  = isset($body['wtcAmount'])  ? (int)$body['wtcAmount']           : 0;
    $usdc       = isset($body['usdcRequired']) ? (float)$body['usdcRequired']    : 0;
    $status     = isset($body['status'])     ? trim((string)$body['status'])     : 'pending_payment';

    $allowedStatuses = ['pending_payment', 'payment_submitted', 'queued', 'delivery_pending', 'fulfilled', 'failed', 'expired', 'cancelled'];
    if (!preg_match('/^[a-f0-9]{24}$/', $orderId) || strpos($wtcAddress, 'wtc1q') !== 0 || strlen($wtcAddress) !== 43 || $wtcAmount < 1 || !in_array($status, $allowedStatuses, true)) {
        jsonOut(['ok' => false, 'error' => 'Invalid parameters']);
    }

    $orders = loadOrders($ordersFile);
    $found  = false;

    foreach ($orders as &$o) {
        if (($o['id'] ?? '') === $orderId) {
            // Existing server order: keep server record as authoritative.
            $found = true;
            break;
        }
    }
    unset($o);

    if ($found) {
        jsonOut(['ok' => true, 'upserted' => false, 'exists' => true, 'orderId' => $orderId]);
    }

    $order = [
        'id'               => $orderId,
        'wtcAddress'       => $wtcAddress,
        'wtcAmount'        => $wtcAmount,
        'usdcRequired'     => round($usdc * 1e6) / 1e6,
        'buyerEthAddress'  => isset($body['buyerEthAddress']) && $body['buyerEthAddress'] !== null ? strtolower(trim((string)$body['buyerEthAddress'])) : null,
        'status'           => $status,
        'createdAtMs'      => isset($body['createdAtMs']) ? (int)$body['createdAtMs'] : (int)(microtime(true) * 1000),
        'knownTxHash'      => isset($body['knownTxHash']) ? (string)$body['knownTxHash'] : null,
        'matchedTxHash'    => isset($body['matchedTxHash']) ? (string)$body['matchedTxHash'] : null,
        'matchedAtMs'      => isset($body['matchedAtMs']) ? (int)$body['matchedAtMs'] : null,
        'fulfilledTxId'    => isset($body['fulfilledTxId']) ? (string)$body['fulfilledTxId'] : null,
        'fulfilledAtMs'    => isset($body['fulfilledAtMs']) ? (int)$body['fulfilledAtMs'] : null,
    ];

    $orders[] = $order;
    saveOrders($ordersFile, $orders);
    jsonOut(['ok' => true, 'upserted' => true, 'exists' => false, 'orderId' => $orderId]);
}

// ── GET /order/:id ────────────────────────────────────────────────────────────
if ($method === 'GET' && preg_match('#^/order/([a-f0-9]{24})$#', $path, $m)) {
    $orderId = $m[1];
    $orders  = loadOrders($ordersFile);
    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $providedApiKey = getApiKeyFromRequest($body);
    $providedOwnerProof = getOrderProofFromRequest($body);

    $dirty = expireOldOrders($orders);

    // If this order is still awaiting payment, try to match it server-side
    // (covers the case where the miner app is closed during/after a purchase)
    foreach ($orders as $o) {
        if ($o['id'] === $orderId && in_array($o['status'], ['pending_payment', 'payment_submitted'], true)) {
            if (matchPendingPayments($dataDir, $orders)) $dirty = true;
            break;
        }
    }

    if ($dirty) saveOrders($ordersFile, $orders);

    foreach ($orders as &$o) {
        if ($o['id'] === $orderId) {
            $ownerProofIssued = ensureOrderProofExists($o);
            if ($ownerProofIssued !== null) {
                saveOrders($ordersFile, $orders);
                $providedOwnerProof = $ownerProofIssued;
            }

            $apiKeyOk = ($storedKey !== '' && $providedApiKey !== '' && hash_equals($storedKey, $providedApiKey));
            $ownerOk  = orderOwnedByRequest($o, $providedOwnerProof);
            if (!$apiKeyOk && !$ownerOk) {
                jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
            }

            $payload = ['ok' => true, 'order' => sanitizeOrderForClient($o)];
            if ($ownerProofIssued !== null) {
                $payload['ownerProof'] = $ownerProofIssued;
            }
            jsonOut($payload);
        }
    }
    unset($o);
    jsonOut(['ok' => false, 'error' => 'Order not found'], 404);
}

// ── POST /cancel-order ────────────────────────────────────────────────────────
if ($method === 'POST' && $path === '/cancel-order') {
    if (!checkRateLimit(getClientIp(), 'cancel-order', 10, 60)) {
        jsonOut(['ok' => false, 'error' => 'Rate limit exceeded'], 429);
    }
    $orderId = isset($body['orderId']) ? trim((string)$body['orderId']) : '';
    if (!$orderId) {
        jsonOut(['ok' => false, 'error' => 'orderId required']);
    }

    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $providedApiKey = getApiKeyFromRequest($body);
    $providedOwnerProof = getOrderProofFromRequest($body);

    $orders = loadOrders($ordersFile);
    $found  = false;

    foreach ($orders as &$o) {
        if ($o['id'] === $orderId) {
            $ownerProofIssued = ensureOrderProofExists($o);
            $apiKeyOk = ($storedKey !== '' && $providedApiKey !== '' && hash_equals($storedKey, $providedApiKey));
            $ownerOk  = orderOwnedByRequest($o, $providedOwnerProof);
            if (!$apiKeyOk && !$ownerOk) {
                jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
            }

            $cancellable = ['pending_payment', 'payment_submitted', 'queued'];
            if (!in_array($o['status'], $cancellable, true)) {
                jsonOut(['ok' => false, 'error' => "Cannot cancel order in status '{$o['status']}'"]);
            }
            $o['status'] = 'cancelled';
            $found = true;
            break;
        }
    }
    unset($o);

    if (!$found) {
        jsonOut(['ok' => false, 'error' => 'Order not found'], 404);
    }

    saveOrders($ordersFile, $orders);
    jsonOut(['ok' => true]);
}

// ── POST /confirm-payment — buyer notifies server of submitted tx hash ────────
if ($method === 'POST' && $path === '/confirm-payment') {
    $orderId = isset($body['orderId']) ? trim((string)$body['orderId']) : '';
    $txHash  = isset($body['txHash'])  ? trim((string)$body['txHash'])  : '';

    if (!$orderId || !preg_match('/^0x[0-9a-fA-F]{64}$/', $txHash)) {
        jsonOut(['ok' => false, 'error' => 'orderId and valid txHash required']);
    }

    $orders = loadOrders($ordersFile);
    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $providedApiKey = getApiKeyFromRequest($body);
    $providedOwnerProof = getOrderProofFromRequest($body);

    // A tx hash may fund exactly one order globally.
    if (txAlreadyLinkedToAnyOrder($orders, $txHash, $orderId)) {
        jsonOut(['ok' => false, 'error' => 'txHash already linked to another order'], 409);
    }

    $found  = false;
    foreach ($orders as &$o) {
        if ($o['id'] === $orderId && $o['status'] === 'pending_payment') {
            $apiKeyOk = ($storedKey !== '' && $providedApiKey !== '' && hash_equals($storedKey, $providedApiKey));
            $hasOwnerProofHash = isset($o['ownerProofHash']) && trim((string)$o['ownerProofHash']) !== '';
            $ownerOk = $hasOwnerProofHash && orderOwnedByRequest($o, $providedOwnerProof);
            if (!$apiKeyOk && !$ownerOk) {
                jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
            }
            $o['status']      = 'payment_submitted';
            $o['knownTxHash'] = $txHash;
            $found = true;
            break;
        }
    }
    unset($o);

    if (!$found) jsonOut(['ok' => false, 'error' => 'Order not found or not in pending_payment status']);
    saveOrders($ordersFile, $orders);

    // Immediately try to match — the buyer just submitted so the tx may already be on-chain
    $orders2 = loadOrders($ordersFile);
    if (matchPendingPayments($dataDir, $orders2)) saveOrders($ordersFile, $orders2);

    jsonOut(['ok' => true]);
}

// ── GET /balance/:address ─────────────────────────────────────────────────────
if ($method === 'GET' && preg_match('#^/balance/(wtc1q[a-z0-9]{38})$#', $path, $m)) {
    $addr   = $m[1];
    $orders = loadOrders($ordersFile);

    $queued     = 0;
    $delivered  = 0;
    $pending    = 0;
    $ordersList = [];

    foreach ($orders as $o) {
        if (($o['wtcAddress'] ?? '') !== $addr) continue;
        $amt = (int)($o['wtcAmount'] ?? 0);
        $status = $o['status'] ?? '';
        if ($status === 'fulfilled') {
            $delivered += $amt;
        } elseif ($status === 'queued' || $status === 'delivery_pending') {
            $queued += $amt;
        } elseif ($status === 'pending_payment' || $status === 'payment_submitted') {
            $pending += $amt;
        }
        // Include all statuses in the order list (even expired/failed) so the UI can show them
        $ordersList[] = [
            'id'             => $o['id'],
            'wtcAmount'      => $amt,
            'usdcRequired'   => $o['usdcRequired'] ?? 0,
            'status'         => $status,
            'createdAtMs'    => $o['createdAtMs'] ?? 0,
            'wtcAddress'     => $o['wtcAddress'] ?? '',
            'matchedTxHash'  => $o['matchedTxHash'] ?? null,
            'fulfilledTxId'  => $o['fulfilledTxId'] ?? null,
            // buyerEthAddress intentionally omitted — not needed for display; protects buyer privacy
        ];
    }

    jsonOut([
        'ok'        => true,
        'address'   => $addr,
        'queued'    => $queued,
        'delivered' => $delivered,
        'purchased' => $queued + $delivered,  // backwards compat
        'pending'   => $pending,
        'orders'    => $ordersList,
    ]);
}

// ── POST /self-update - Upload a new PHP or HTML file (API key protected) ────
if ($method === 'POST' && $path === '/self-update') {
    $keyFile   = $dataDir . '/.api-key';
    if (!file_exists($keyFile)) {
        jsonOut(['ok' => false, 'error' => 'Self-update not configured'], 501);
    }
    if (!checkRateLimit(getClientIp(), 'self-update', 3, 3600)) {
        jsonOut(['ok' => false, 'error' => 'Rate limit exceeded'], 429);
    }
    $storedKey = trim(file_get_contents($keyFile));
    if ($storedKey === '') {
        jsonOut(['ok' => false, 'error' => 'Self-update not configured'], 501);
    }
    $provided  = getApiKeyFromRequest($body);
    if (!hash_equals($storedKey, $provided)) {
        jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
    }
    $docRoot   = realpath(__DIR__ . '/..');
    $target    = isset($body['target']) ? (string)$body['target'] : '';
    $content   = isset($body['content']) ? (string)$body['content'] : '';
    $allowed = ['api/index.php', 'wallet.html'];
    if (!in_array($target, $allowed, true)) {
        jsonOut(['ok' => false, 'error' => 'Target not allowed']);
    }
    if ($content === '' || strlen($content) > 5_000_000) {
        jsonOut(['ok' => false, 'error' => 'Content empty or exceeds 5 MB limit']);
    }
    if ($target === 'wallet.html' && stripos($content, '<!DOCTYPE html') === false) {
        jsonOut(['ok' => false, 'error' => 'wallet.html must be valid HTML']);
    }
    if ($target === 'api/index.php' && stripos($content, '<?php') === false) {
        jsonOut(['ok' => false, 'error' => 'api/index.php must be valid PHP']);
    }
    $dest = $docRoot . '/' . $target;
    if (file_put_contents($dest, $content) === false) {
        jsonOut(['ok' => false, 'error' => 'Write failed']);
    }
    jsonOut(['ok' => true, 'bytes' => strlen($content), 'target' => $target]);
}

// ── Staking helpers ────────────────────────────────────────────────────────────

define('STAKING_POOL_ADDRESS',    'wtc1q7t624zx7px3ypd3u6zaz0hr7knpa0aun7d56gv');
define('STAKING_POOL_TOTAL',      166667);
define('STAKING_MIN_WTC',         100);
define('STAKING_FLUSH_THRESHOLD', 10000);
define('STAKING_MAX_APY',         100.0);

function loadStakingEntries(string $file): array {
    if (!file_exists($file)) return [];
    $data = json_decode(file_get_contents($file), true);
    return is_array($data) ? $data : [];
}

function saveStakingEntries(string $file, array $entries): void {
    $tmp = $file . '.tmp';
    file_put_contents($tmp, json_encode(array_values($entries), JSON_PRETTY_PRINT));
    rename($tmp, $file);
}

function stakingTotalPending(array $entries): int {
    $t = 0;
    foreach ($entries as $e) {
        if (($e['status'] ?? '') === 'pending') $t += (int)($e['wtcAmount'] ?? 0);
    }
    return $t;
}

function stakingCurrentApy(array $entries): float {
    $total = stakingTotalPending($entries);
    return min(STAKING_MAX_APY, round($total / 10000 * 100) / 100);
}

function stakingPoolRemaining(array $entries, ?int $cached): int {
    if ($cached !== null) return max(0, $cached);
    $distributed = 0;
    foreach ($entries as $e) {
        if (($e['status'] ?? '') === 'rewarded') $distributed += (int)($e['rewardAmount'] ?? 0);
    }
    return max(0, STAKING_POOL_TOTAL - $distributed);
}

function loadCachedPoolBalance(string $dir): ?array {
    $f = $dir . '/staking-pool-balance.json';
    if (!file_exists($f)) return null;
    $d = json_decode(file_get_contents($f), true);
    return is_array($d) ? $d : null;
}

// ── GET /staking-status ────────────────────────────────────────────────────────
if ($method === 'GET' && $path === '/staking-status') {
    $stakingFile = $dataDir . '/staking-entries.json';
    $entries     = loadStakingEntries($stakingFile);
    $cache       = loadCachedPoolBalance($dataDir); // may contain balance + node-pushed combined stats
    // Prefer node-pushed combined stats (include app staking) when available.
    $totalStaked = (is_array($cache) && isset($cache['totalStaked'])) ? (int)$cache['totalStaked']   : stakingTotalPending($entries);
    $currentApy  = (is_array($cache) && isset($cache['currentApy']))  ? (float)$cache['currentApy'] : stakingCurrentApy($entries);
    $cachedBal   = (is_array($cache) && isset($cache['balance']))      ? (int)$cache['balance']       : null;
    jsonOut([
        'ok'             => true,
        'poolBalance'    => stakingPoolRemaining($entries, $cachedBal),
        'totalStaked'    => $totalStaked,
        'currentApy'     => $currentApy,
        'minStake'       => STAKING_MIN_WTC,
        'flushThreshold' => STAKING_FLUSH_THRESHOLD,
        'poolAddress'    => STAKING_POOL_ADDRESS,
    ]);
}

// ── POST /staking/stake ────────────────────────────────────────────────────────
if ($method === 'POST' && $path === '/staking/stake') {
    if (!checkRateLimit(getClientIp(), 'staking-stake', 5, 60)) {
        jsonOut(['ok' => false, 'error' => 'Rate limit exceeded'], 429);
    }
    $addr = isset($body['wtcAddress']) ? trim((string)$body['wtcAddress']) : '';
    $amt  = isset($body['wtcAmount'])  ? (int)$body['wtcAmount']           : 0;

    if (!$addr || strpos($addr, 'wtc1q') !== 0 || strlen($addr) !== 43) {
        jsonOut(['ok' => false, 'error' => 'Invalid WTC address']);
    }
    if ($amt < STAKING_MIN_WTC) {
        jsonOut(['ok' => false, 'error' => 'Minimum stake is ' . STAKING_MIN_WTC . ' WTC']);
    }

    // Verify the user holds enough WTC (delivered + queued from orders) before allowing staking
    $orders = loadOrders($ordersFile);
    $userWtc = 0;
    foreach ($orders as $o) {
        if (($o['wtcAddress'] ?? '') !== $addr) continue;
        $s = $o['status'] ?? '';
        if ($s === 'fulfilled' || $s === 'queued' || $s === 'delivery_pending') {
            $userWtc += (int)($o['wtcAmount'] ?? 0);
        }
    }
    if ($userWtc === 0 || $amt > $userWtc) {
        jsonOut(['ok' => false, 'error' => 'Insufficient balance. You have ' . $userWtc . ' WTC in your wallet.']);
    }

    $stakingFile = $dataDir . '/staking-entries.json';
    $entries     = loadStakingEntries($stakingFile);

    // Prevent duplicate pending entries for the same address
    foreach ($entries as $e) {
        if (($e['wtcAddress'] ?? '') === $addr && ($e['status'] ?? '') === 'pending') {
            jsonOut(['ok' => true, 'entryId' => $e['id'], 'alreadyExists' => true, 'ownerProof' => null]);
        }
    }

    $entryId    = bin2hex(random_bytes(12));
    $ownerProof = bin2hex(random_bytes(24));
    $entry = [
        'id'             => $entryId,
        'ownerProofHash' => hash('sha256', $ownerProof),
        'wtcAddress'     => $addr,
        'wtcAmount'      => $amt,
        'status'         => 'pending',
        'createdAtMs'    => (int)(microtime(true) * 1000),
        'rewardAtMs'     => null,
        'rewardAmount'   => null,
        'rewardTxId'     => null,
        'apyAtFlush'     => null,
        'failReason'     => null,
    ];
    $entries[] = $entry;
    saveStakingEntries($stakingFile, $entries);

    jsonOut(['ok' => true, 'entryId' => $entryId, 'ownerProof' => $ownerProof, 'alreadyExists' => false]);
}

// ── GET /staking/my-entries/:address ──────────────────────────────────────────
if ($method === 'GET' && preg_match('#^/staking/my-entries/(wtc1q[a-z0-9]{38})$#', $path, $m)) {
    $addr        = $m[1];
    $stakingFile = $dataDir . '/staking-entries.json';
    $entries     = loadStakingEntries($stakingFile);
    $myEntries   = [];
    foreach ($entries as $e) {
        if (($e['wtcAddress'] ?? '') === $addr) {
            $entry = $e;
            unset($entry['ownerProofHash']);
            $myEntries[] = $entry;
        }
    }
    // Sort newest first
    usort($myEntries, static fn($a, $b) => (($b['createdAtMs'] ?? 0) <=> ($a['createdAtMs'] ?? 0)));
    jsonOut(['ok' => true, 'entries' => array_values($myEntries)]);
}

// ── POST /staking/cancel ───────────────────────────────────────────────────────
if ($method === 'POST' && $path === '/staking/cancel') {
    if (!checkRateLimit(getClientIp(), 'staking-cancel', 10, 60)) {
        jsonOut(['ok' => false, 'error' => 'Rate limit exceeded'], 429);
    }
    $entryId    = isset($body['entryId'])    ? trim((string)$body['entryId'])    : '';
    $ownerProof = isset($body['ownerProof']) ? trim((string)$body['ownerProof']) : '';

    if (!$entryId || !$ownerProof) {
        jsonOut(['ok' => false, 'error' => 'entryId and ownerProof required']);
    }

    $stakingFile = $dataDir . '/staking-entries.json';
    $entries     = loadStakingEntries($stakingFile);
    $found       = false;

    foreach ($entries as &$e) {
        if (($e['id'] ?? '') === $entryId) {
            $storedHash = $e['ownerProofHash'] ?? '';
            if (!$storedHash || !hash_equals($storedHash, hash('sha256', $ownerProof))) {
                jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
            }
            if ($e['status'] !== 'pending') {
                jsonOut(['ok' => false, 'error' => "Cannot cancel entry in status '{$e['status']}'"]);
            }
            $e['status'] = 'cancelled';
            $found = true;
            break;
        }
    }
    unset($e);

    if (!$found) jsonOut(['ok' => false, 'error' => 'Entry not found'], 404);
    saveStakingEntries($stakingFile, $entries);
    jsonOut(['ok' => true]);
}

// ── GET /staking/entries — node polls for entries to process ──────────────────
if ($method === 'GET' && $path === '/staking/entries') {
    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $provided  = isset($_SERVER['HTTP_X_API_KEY']) ? trim((string)$_SERVER['HTTP_X_API_KEY']) : '';
    if (!$storedKey || !hash_equals($storedKey, $provided)) {
        jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
    }
    $stakingFile = $dataDir . '/staking-entries.json';
    $entries     = loadStakingEntries($stakingFile);
    $safe = array_map(static function($e) { unset($e['ownerProofHash']); return $e; }, $entries);
    jsonOut(['ok' => true, 'entries' => array_values($safe)]);
}

// ── POST /staking/update-entry — node reports reward payment ──────────────────
if ($method === 'POST' && $path === '/staking/update-entry') {
    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $provided  = getApiKeyFromRequest($body);
    if (!$storedKey || !hash_equals($storedKey, $provided)) {
        jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
    }
    $entryId = isset($body['entryId']) ? trim((string)$body['entryId']) : '';
    $status  = isset($body['status'])  ? trim((string)$body['status'])  : '';
    if (!$entryId || !in_array($status, ['rewarded', 'failed', 'cancelled'], true)) {
        jsonOut(['ok' => false, 'error' => 'Invalid parameters']);
    }
    $stakingFile = $dataDir . '/staking-entries.json';
    $entries     = loadStakingEntries($stakingFile);
    $found       = false;
    foreach ($entries as &$e) {
        if (($e['id'] ?? '') === $entryId) {
            $e['status'] = $status;
            if ($status === 'rewarded') {
                if (isset($body['rewardAmount'])) $e['rewardAmount'] = (int)$body['rewardAmount'];
                if (isset($body['rewardTxId']))   $e['rewardTxId']   = (string)$body['rewardTxId'];
                if (isset($body['apyAtFlush']))    $e['apyAtFlush']   = (float)$body['apyAtFlush'];
                $e['rewardAtMs'] = (int)(microtime(true) * 1000);
            }
            if ($status === 'failed' && isset($body['failReason'])) {
                $e['failReason'] = (string)$body['failReason'];
            }
            $found = true;
            break;
        }
    }
    unset($e);
    if (!$found) jsonOut(['ok' => false, 'error' => 'Entry not found'], 404);
    saveStakingEntries($stakingFile, $entries);
    jsonOut(['ok' => true]);
}

// ── POST /staking/update-pool-balance — node reports actual blockchain balance ─
if ($method === 'POST' && $path === '/staking/update-pool-balance') {
    $keyFile   = $dataDir . '/.api-key';
    $storedKey = file_exists($keyFile) ? trim(file_get_contents($keyFile)) : '';
    $provided  = getApiKeyFromRequest($body);
    if (!$storedKey || !hash_equals($storedKey, $provided)) {
        jsonOut(['ok' => false, 'error' => 'Unauthorized'], 401);
    }
    $balance = isset($body['balance']) ? (int)$body['balance'] : -1;
    if ($balance < 0 && !isset($body['totalStaked']) && !isset($body['currentApy'])) {
        jsonOut(['ok' => false, 'error' => 'balance (non-negative integer) required']);
    }
    $f    = $dataDir . '/staking-pool-balance.json';
    $data = ['updatedAtMs' => (int)(microtime(true) * 1000)];
    if ($balance >= 0)                  $data['balance']     = $balance;
    if (isset($body['totalStaked']))    $data['totalStaked'] = (int)$body['totalStaked'];
    if (isset($body['currentApy']))     $data['currentApy']  = (float)$body['currentApy'];
    // Merge with existing file so partial updates don\'t wipe other fields
    if (file_exists($f)) {
        $existing = json_decode(file_get_contents($f), true);
        if (is_array($existing)) $data = array_merge($existing, $data);
    }
    file_put_contents($f, json_encode($data));
    jsonOut(['ok' => true]);
}

// ── 404 fallback ──────────────────────────────────────────────────────────────
jsonOut(['ok' => false, 'error' => 'Not found'], 404);
