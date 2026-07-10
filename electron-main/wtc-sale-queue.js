// SPDX-License-Identifier: MIT
const os = require('os');
/**
 * wtc-sale-queue.js
 *
 * Manages the WTC sale order queue and Etherscan USDC payment watcher.
 *
 * Flow:
 *   1. Buyer calls placeSaleOrder({ wtcAddress, wtcAmount, usdcRequired })
 *      -> order is created on server first, then mirrored to local disk
 *         (status: 'pending_payment'), returns { orderId, usdcRequired }
 *   2. Etherscan poller (every hour) fetches USDC transfers to
 *      SELLER_USDC_ADDRESS and matches them to pending orders.
 *   3. When a payment is matched -> order status: 'queued', queuedWTC added.
 *   4. flushSaleQueue() is called either:
 *        a) after each block is mined (mineBlock success hook)
 *        b) when queuedWTC >= FLUSH_THRESHOLD_WTC (10,101 WTC)
 *      -> sends WTC to each queued buyer from SALE_WTC_ADDRESS via wtcNode.send()
 *         then clears the flush batch.
 */

('use strict');

const _ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────

const { SELLER_USDC_ADDRESS, SALE_WTC_ADDRESS, MINTER_ADDRESS, USDC_CONTRACT } = require('./protocol-constants');
const _REWARD_WTC_ADDRESS = MINTER_ADDRESS;

const FLUSH_THRESHOLD_WTC = 10_101; // flush when queued >= 10101 WTC
const POLL_INTERVAL_MS = 10 * 60 * 1000; // check Etherscan every 10 minutes
const PAYMENT_EXPIRY_MS = 24 * 60 * 60 * 1000; // orders expire after 24 h if unpaid
const MATCH_TX_GRACE_MS = 5 * 60 * 1000; // allow small chain index / clock skew
const MIN_BUY_WTC = 1;
const ETHERSCAN_BASE = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_API_KEY = (() => {
  // Priority 1: Dedicated user-provided key via secrets file
  try {
    const v = fs.readFileSync(path.join(os.homedir(), '.secrets', 'etherscan-api-key'), 'utf8').trim();
    if (v) return v;
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
  }
  // Priority 2: Environment variable
  if (process.env.ETHERSCAN_API_KEY) return process.env.ETHERSCAN_API_KEY;
  // Priority 3: Built-in shared free-tier key (rate-limited).
  // This is a PUBLIC Etherscan API key — it is intentionally shipped in the
  // source code so the sale payment watcher works out-of-the-box without
  // requiring every user to register their own key.  For production deployments
  // with high transaction volume, operators SHOULD configure a dedicated key
  // via ~/.secrets/etherscan-api-key or ETHERSCAN_API_KEY to avoid rate limits.
  console.warn(
    `[${_ts()}] [SaleQueue] Using built-in shared Etherscan API key (rate-limited). For production, set a dedicated key via ~/.secrets/etherscan-api-key or ETHERSCAN_API_KEY`,
  );
  return Buffer.from('SEhWMUNVRlVJRUgxRjMyVjlEQlNYMlEzQVVKRkRDQVJTWg==', 'base64').toString();
})();
const ETHERSCAN_REQUEST_RETRIES = 2;
const ETHERSCAN_RETRY_DELAY_MS = 1_500;

// Tiered pricing: cost per WTC in kWh units (20 kWh/WTC for tier 1 mining)
// Price in USD = electricityPrice ($/kWh) * 20 kWh * tierFraction
// We store wtcAmount + usdcRequired in the order - caller computes the USD.
const SALE_TOTAL = 333_333;
const SALE_TIER_SIZE = 111_111;
const SALE_TIERS = [
  { fraction: 1 / 3, start: 0, end: 111_111 },
  { fraction: 2 / 3, start: 111_111, end: 222_222 },
  { fraction: 3 / 3, start: 222_222, end: 333_333 },
];

// ─── State ───────────────────────────────────────────────────────────────────

let _dataDir = null; // set via init()
let _wtcNode = null; // set via init()
let _pollTimer = null;
let _initialPollTimer = null;
let _orders = []; // in-memory array, persisted to disk
let _seenTxHashes = new Set(); // USDC tx hashes already processed
let _unmatchedTxs = []; // [{hash, usdcValue, fromEthAddr, receivedAtMs}] — unmatched payments awaiting an order
let _electricityPrice = null; // $/kWh, set via setElectricityPrice() from electron-main.js
let _serverApiUrl = 'https://wattcoin.ee/api'; // default — GET /orders works without auth
let _serverApiKey = null; // for POST /update-order — read from WattcoinMinerUserData/sale-api-key.txt
let _serverSoldWtc = null; // last authoritative sold total computed from server orders
let _serverBackfillAttempted = false; // one-time per process, avoids spamming server on every sync
let _serverSyncPromise = null; // in-flight sync dedupe
let _lastServerSyncAt = 0; // throttle repeated sync requests
const SERVER_SYNC_MIN_INTERVAL_MS = 20_000;
let _publicSaleStatusPromise = null;
let _lastPublicSaleStatusAt = 0;
const PUBLIC_SALE_STATUS_MIN_INTERVAL_MS = 10_000;
let _loggedOrdersUnauthorized = false;
let _lastPollAt = null; // Date.now() of last Etherscan poll attempt
let _lastPollResult = null; // 'ok' | 'notok:<msg>' | 'error:<msg>' | 'timeout'
let _printedQueuedSnapshot = false;
let _knownQueuedOrderIds = new Set();

function _queueSummary(order) {
  return `order ${order.id} wtc=${order.wtcAmount} usdc=${order.usdcRequired} eth=${order.buyerEthAddress || '(none)'}`;
}

function _logQueuedSnapshotOnce(serverOrders) {
  if (_printedQueuedSnapshot) return;
  const queued = (serverOrders || []).filter(
    (o) => o && o.id && (o.status === 'queued' || o.status === 'delivery_pending'),
  );
  const queuedWtc = queued.reduce((sum, o) => sum + Math.max(0, Number(o.wtcAmount) || 0), 0);
  console.log(`[${_ts()}] [SaleQueue] queued buys at startup: ${queued.length} (${queuedWtc} WTC)`);
  for (const o of queued) {
    _knownQueuedOrderIds.add(o.id);
    console.log(`  queued ${_queueSummary(o)}`);
  }
  _printedQueuedSnapshot = true;
}

function _logLocalQueuedSnapshotOnce() {
  _logQueuedSnapshotOnce(_orders);
}

function _logNewQueuedOrders(serverOrders) {
  for (const o of serverOrders || []) {
    if (!o || !o.id) continue;
    if (o.status === 'queued' || o.status === 'delivery_pending') {
      if (!_knownQueuedOrderIds.has(o.id)) {
        _knownQueuedOrderIds.add(o.id);
        console.log(`[${_ts()}] [SaleQueue] queued buy added: ${_queueSummary(o)}`);
      }
    } else {
      _knownQueuedOrderIds.delete(o.id);
    }
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

function init(dataDir, wtcNode) {
  _dataDir = dataDir;
  _wtcNode = wtcNode;
  _loadOrders();
  _loadSeenHashes();
  _loadUnmatchedTxs();
  _startPoller();
  console.log(`[${_ts()}] [SaleQueue] init - loaded`, _orders.length, 'orders,', _unmatchedTxs.length, 'unmatched txs');
  _logLocalQueuedSnapshotOnce();
}

function shutdown() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_initialPollTimer) {
    clearTimeout(_initialPollTimer);
    _initialPollTimer = null;
  }
  if (_reconcileTimer) {
    clearInterval(_reconcileTimer);
    _reconcileTimer = null;
  }
}

// ─── File paths ──────────────────────────────────────────────────────────────

function _ordersPath() {
  return path.join(_dataDir, 'sale-orders.json');
}
function _seenHashesPath() {
  return path.join(_dataDir, 'sale-seen-hashes.json');
}
function _unmatchedTxsPath() {
  return path.join(_dataDir, 'sale-unmatched-txs.json');
}

function _readJson(filePath) {
  // Strip UTF-8 BOM if present (written by PowerShell Set-Content -Encoding UTF8)
  let text = fs.readFileSync(filePath, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function _loadOrders() {
  try {
    if (fs.existsSync(_ordersPath())) {
      const raw = _readJson(_ordersPath());
      _orders = Array.isArray(raw) ? raw : [];
    }
  } catch (_) {
    _orders = [];
  }
}

function _saveOrders() {
  try {
    const dest = _ordersPath();
    const tmp = dest + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_orders, null, 2), 'utf8');
    fs.renameSync(tmp, dest);
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
  }
}

function _loadSeenHashes() {
  try {
    if (fs.existsSync(_seenHashesPath())) {
      const raw = _readJson(_seenHashesPath());
      _seenTxHashes = new Set(Array.isArray(raw) ? raw : []);
    }
  } catch (_) {
    _seenTxHashes = new Set();
  }
}

function _saveSeenHashes() {
  try {
    fs.writeFileSync(_seenHashesPath(), JSON.stringify([..._seenTxHashes]), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
  }
}

function _loadUnmatchedTxs() {
  try {
    if (fs.existsSync(_unmatchedTxsPath())) {
      const raw = _readJson(_unmatchedTxsPath());
      _unmatchedTxs = Array.isArray(raw) ? raw : [];
    }
  } catch (_) {
    _unmatchedTxs = [];
  }
}

function _saveUnmatchedTxs() {
  try {
    fs.writeFileSync(_unmatchedTxsPath(), JSON.stringify(_unmatchedTxs, null, 2), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
  }
}

// ─── Order CRUD ──────────────────────────────────────────────────────────────

/**
 * Place a new sale order.
 * @param {{ wtcAddress: string, wtcAmount: number, usdcRequired: number }} opts
 * @returns {Promise<{ ok: boolean, orderId?: string, usdcRequired?: number, error?: string }>}
 */
async function placeSaleOrder({ wtcAddress, wtcAmount, usdcRequired, buyerEthAddress }) {
  if (!wtcAddress || typeof wtcAddress !== 'string') return { ok: false, error: 'Missing WTC address' };
  if (!Number.isFinite(wtcAmount) || wtcAmount < MIN_BUY_WTC) {
    return { ok: false, error: `Minimum purchase is ${MIN_BUY_WTC} WTC` };
  }
  if (!Number.isFinite(usdcRequired) || usdcRequired <= 0) {
    return { ok: false, error: 'Invalid USDC amount' };
  }

  // Block a new order only if there's an unpaid pending_payment order for this address.
  // Queued orders are already paid and run in background — new purchases are allowed.
  const existing = _orders.find((o) => o.wtcAddress === wtcAddress && o.status === 'pending_payment');
  if (existing) {
    return {
      ok: true,
      orderId: existing.id,
      usdcRequired: existing.usdcRequired,
      wtcAmount: existing.wtcAmount,
      existingStatus: existing.status,
      alreadyExists: true,
      ownerProof: existing.ownerProof || null,
    };
  }

  // For production, create the order on the authoritative server first so all
  // clients see the same queue/order IDs via GET /orders.
  if (_serverApiUrl) {
    const created = await _postServerPlaceOrder({
      wtcAddress,
      wtcAmount: Math.floor(wtcAmount),
      buyerEthAddress: buyerEthAddress ? buyerEthAddress.toLowerCase() : null,
    });

    if (!created.ok) {
      return { ok: false, error: created.error || 'Failed to create server order' };
    }

    const existingLocal = _orders.find((o) => o.id === created.orderId);
    if (existingLocal) {
      return {
        ok: true,
        orderId: existingLocal.id,
        usdcRequired: existingLocal.usdcRequired,
        wtcAmount: existingLocal.wtcAmount,
        existingStatus: existingLocal.status,
        alreadyExists: true,
        ownerProof: existingLocal.ownerProof || created.ownerProof || null,
      };
    }

    const mirroredOrder = {
      id: created.orderId,
      wtcAddress,
      wtcAmount: Math.floor(wtcAmount),
      usdcRequired: Math.round((Number(created.usdcRequired) || usdcRequired) * 1e6) / 1e6,
      buyerEthAddress: buyerEthAddress ? buyerEthAddress.toLowerCase() : null,
      status: 'pending_payment',
      createdAtMs: Date.now(),
      matchedTxHash: null,
      fulfilledTxId: null,
      fulfilledAtMs: null,
      _fromServer: true,
      ownerProof: created.ownerProof || null,
    };

    _orders.push(mirroredOrder);
    _saveOrders();
    console.log(
      `[${_ts()}] [SaleQueue] mirrored server order ${mirroredOrder.id} created - ${mirroredOrder.wtcAmount} WTC for $${mirroredOrder.usdcRequired} USDC -> ${mirroredOrder.wtcAddress}`,
    );
    _retryUnmatched();
    return {
      ok: true,
      orderId: mirroredOrder.id,
      usdcRequired: mirroredOrder.usdcRequired,
      ownerProof: mirroredOrder.ownerProof || null,
    };
  }

  const orderId = crypto.randomBytes(12).toString('hex');
  const order = {
    id: orderId,
    wtcAddress,
    wtcAmount: Math.floor(wtcAmount),
    usdcRequired: Math.round(usdcRequired * 1e6) / 1e6, // 6 dp precision
    buyerEthAddress: buyerEthAddress ? buyerEthAddress.toLowerCase() : null,
    status: 'pending_payment', // pending_payment | queued | fulfilled | expired | failed
    createdAtMs: Date.now(),
    matchedTxHash: null,
    fulfilledTxId: null,
    fulfilledAtMs: null,
    ownerProof: null,
  };

  _orders.push(order);
  _saveOrders();
  console.log(
    `[${_ts()}] [SaleQueue] order ${orderId} created - ${wtcAmount} WTC for $${usdcRequired} USDC -> ${wtcAddress}`,
  );
  // Immediately try to match any unmatched USDC payments against this new order
  _retryUnmatched();
  return { ok: true, orderId, usdcRequired, ownerProof: null };
}

function _postServerPlaceOrder({ wtcAddress, wtcAmount, buyerEthAddress }) {
  if (!_serverApiUrl) return Promise.resolve({ ok: false, error: 'Server API not configured' });

  const payloadObj = { wtcAddress, wtcAmount };
  if (buyerEthAddress) payloadObj.buyerEthAddress = buyerEthAddress;
  const payload = JSON.stringify(payloadObj);

  const urlObj = new URL(`${_serverApiUrl}/place-order`);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    timeout: 10_000,
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || !body || !body.ok || !body.orderId) {
            const err = body && body.error ? String(body.error) : `HTTP ${res.statusCode}`;
            return resolve({ ok: false, error: err });
          }
          resolve({
            ok: true,
            orderId: String(body.orderId),
            usdcRequired: Number(body.usdcRequired) || 0,
            ownerProof: body && typeof body.ownerProof === 'string' ? body.ownerProof : null,
          });
        } catch (_) {
          resolve({ ok: false, error: `HTTP ${res.statusCode}` });
        }
      });
    });
    req.on('error', (e) => {
      console.warn(`[${_ts()}] [SaleQueue] server place-order error:`, e && e.message);
      resolve({ ok: false, error: e && e.message ? e.message : 'request error' });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timeout' });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Get all orders (for display / admin).
 */
function getOrders() {
  return _orders.map((o) => ({ ...o }));
}

/**
 * Get a single order by id.
 */
function getOrder(orderId) {
  const o = _orders.find((o) => o.id === orderId);
  return o ? { ...o } : null;
}

/**
 * Get active orders (pending_payment or queued) for a given WTC delivery address.
 */
function getOrdersForAddress(addr) {
  if (!addr || typeof addr !== 'string') return [];
  return _orders
    .filter(
      (o) =>
        o.wtcAddress === addr &&
        (o.status === 'pending_payment' ||
          o.status === 'payment_submitted' ||
          o.status === 'queued' ||
          o.status === 'delivery_pending'),
    )
    .map((o) => ({ ...o }));
}

/**
 * Sum the WTC amount across all confirmed/in-flight orders for a given address.
 * Counts: fulfilled + queued + delivery_pending + payment_submitted
 * Excludes: pending_payment (no payment yet), cancelled, failed, expired
 */
function getPurchaseTotalForAddress(addr) {
  if (!addr || typeof addr !== 'string') return 0;
  const COUNTED = new Set(['fulfilled', 'queued', 'delivery_pending', 'payment_submitted']);
  return _orders
    .filter((o) => o.wtcAddress === addr && COUNTED.has(o.status))
    .reduce((sum, o) => sum + (typeof o.wtcAmount === 'number' ? o.wtcAmount : 0), 0);
}

/**
 * Cancel a pending_payment order (before payment arrives).
 */
async function cancelOrder(orderId) {
  const o = _orders.find((o) => o.id === orderId);
  if (!o) return { ok: false, error: 'Order not found' };
  const cancellable = ['pending_payment', 'payment_submitted', 'queued'];
  if (!cancellable.includes(o.status)) return { ok: false, error: `Cannot cancel order in status '${o.status}'` };
  o.status = 'cancelled';
  _saveOrders();
  // Notify server so _syncServerOrders won't re-sync it back as queued.
  if (_serverApiUrl) {
    try {
      await _postServerCancelOrder(orderId, o.ownerProof || null);
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
    }
  }
  return { ok: true };
}

function _postServerCancelOrder(orderId, ownerProof = null) {
  if (!_serverApiUrl) return Promise.resolve();
  const payloadObj = { orderId };
  if (typeof ownerProof === 'string' && ownerProof.trim()) payloadObj.ownerProof = ownerProof.trim();
  const payload = JSON.stringify(payloadObj);
  const urlObj = new URL(`${_serverApiUrl}/cancel-order`);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(_serverApiKey ? { 'X-Api-Key': _serverApiKey } : {}),
    },
    timeout: 10_000,
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', (e) => {
      console.warn(`[${_ts()}] [SaleQueue] server cancel error:`, e && e.message);
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Record the on-chain tx hash submitted by the user via in-app wallet connect.
 * Moves status pending_payment -> payment_submitted.
 * Etherscan polling will then match by exact tx hash instead of amount proximity.
 */
function setOrderTxHash(orderId, txHash) {
  const o = _orders.find((o) => o.id === orderId && o.status === 'pending_payment');
  if (!o) return { ok: false, error: 'Order not found or not in pending_payment state' };
  o.knownTxHash = typeof txHash === 'string' ? txHash.trim() : '';
  o.status = 'payment_submitted';
  _saveOrders();
  console.log(`[${_ts()}] [SaleQueue] order ${orderId} tx=${txHash} - marked as payment_submitted`);
  return { ok: true };
}

// ─── Electricity price ────────────────────────────────────────────────────────

function setElectricityPrice(pricePerKwh) {
  if (Number.isFinite(pricePerKwh) && pricePerKwh > 0) _electricityPrice = pricePerKwh;
}

/**
 * Given a USDC amount, compute WTC it buys starting from `startPosition` sold.
 * Uses tier pricing: pricePerWtc = elPrice * 20kWh * tierFraction
 */
function _computeWtcFromUsdc(usdcAmount, elPrice, startPosition) {
  const ENERGY_KWH_PER_WTC = 20;
  let budget = usdcAmount;
  let wtcTotal = 0;
  let position = startPosition || 0;
  for (const tier of SALE_TIERS) {
    if (budget <= 0) break;
    if (position >= tier.end) continue;
    const available = tier.end - Math.max(tier.start, position);
    const pricePerWtc = elPrice * ENERGY_KWH_PER_WTC * tier.fraction;
    const wtcFromTier = Math.min(budget / pricePerWtc, available);
    wtcTotal += wtcFromTier;
    budget -= wtcFromTier * pricePerWtc;
    position += wtcFromTier;
  }
  return Math.round(wtcTotal * 1e6) / 1e6;
}

// ─── WTC sold calculation ─────────────────────────────────────────────────────

/**
 * How many WTC have been sold:
 * 1. On-chain: WTC that already left the sale wallet (node balance)
 * 2. Queued/submitted: orders matched to USDC, WTC reserved but not yet sent
 *
 * Unmatched USDC payments are NOT counted here — they have no confirmed order
 * and therefore no agreed wtcAmount. They will appear here within 10 minutes
 * once _retryUnmatched() links them to a proper order.
 */
function getSoldWTC() {
  // Prefer server-authoritative sold totals when available.
  // This avoids per-client divergence caused by local node/wallet state.
  if (Number.isFinite(_serverSoldWtc)) {
    return Math.max(0, Math.min(SALE_TOTAL, Number(_serverSoldWtc) || 0));
  }

  // 1. On-chain delivered
  let onChainSold = 0;
  if (_wtcNode) {
    try {
      const bal = _wtcNode.getBalance(SALE_WTC_ADDRESS);
      const remaining = (bal.confirmed || 0) + (bal.unmatured || 0);
      onChainSold = Math.max(0, SALE_TOTAL - Math.min(SALE_TOTAL, remaining));
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
    }
  }
  // 2. Matched orders — only count orders where USDC receipt is confirmed on-chain.
  // 'payment_submitted' is unconfirmed (buyer self-reported) and must NOT count as sold.
  const queuedWtc = _orders
    .filter((o) => o.status === 'queued' || o.status === 'delivery_pending')
    .reduce((s, o) => s + o.wtcAmount, 0);
  return Math.max(0, Math.min(SALE_TOTAL, onChainSold + queuedWtc));
}

/**
 * Current active tier index based on coins sold.
 */
function activeTierIdx() {
  const sold = getSoldWTC();
  if (sold === null) return 0;
  if (sold < SALE_TIER_SIZE) return 0;
  if (sold < 2 * SALE_TIER_SIZE) return 1;
  return 2;
}

// ─── Pricing ────────────────────────────────────────────────────────────────

/**
 * Given electricity price ($/kWh) and desired WTC amount, compute USDC required.
 * Respects current tier pricing. If the buy spans a tier boundary it blends the price.
 */
function computeUsdcRequired(wtcAmount, electricityPricePerKwh) {
  const ENERGY_KWH_PER_WTC = 20; // TIER1_ENERGY / 1000 = 20_000 / 1000
  const sold = getSoldWTC() || 0;

  let remaining = wtcAmount;
  let totalUsd = 0;
  let position = sold;

  for (const tier of SALE_TIERS) {
    if (remaining <= 0) break;
    if (position >= tier.end) continue;

    const availableInTier = tier.end - Math.max(tier.start, position);
    const usedFromTier = Math.min(remaining, availableInTier);
    const pricePerWtc = electricityPricePerKwh * ENERGY_KWH_PER_WTC * tier.fraction;

    totalUsd += usedFromTier * pricePerWtc;
    remaining -= usedFromTier;
    position += usedFromTier;
  }

  return totalUsd;
}

// ─── Server API sync ────────────────────────────────────────────────────────

/**
 * Set the URL and optional API key for the server-side PHP sale API.
 * Read-only order sync works without a key; write/update calls require a key.
 */
function setServerApi(url, key) {
  _serverApiUrl = typeof url === 'string' && url ? url.replace(/\/$/, '') : null;
  _serverApiKey = typeof key === 'string' && key ? key : null;
  _serverBackfillAttempted = false;
  if (_serverApiUrl) console.log(`[${_ts()}] [SaleQueue] server API set: ${_serverApiUrl}`);
}

/**
 * Fetch orders from the server PHP API and mirror any new ones into local _orders.
 * This is how web-wallet orders (placed via wattcoin.ee/api) become visible to
 * the Electron USDC poller so their payments get matched and WTC delivered.
 */
function _syncServerOrders() {
  if (!_serverApiUrl) return;

  if (_serverSyncPromise) return _serverSyncPromise;

  const now = Date.now();
  if (now - _lastServerSyncAt < SERVER_SYNC_MIN_INTERVAL_MS) {
    return;
  }

  _serverSyncPromise = new Promise((resolve) => {
    const _finish = () => {
      _lastServerSyncAt = Date.now();
      _serverSyncPromise = null;
      resolve();
    };

    const url = `${_serverApiUrl}/orders`;
    const _reqHeaders = { 'User-Agent': 'wattcoin-miner/1.0' };
    if (_serverApiKey) _reqHeaders['X-Api-Key'] = _serverApiKey;
    const _doGet = (getUrl, redirectsLeft) => {
      const req = https.get(getUrl, { timeout: 10_000, headers: _reqHeaders }, (res) => {
        // Follow redirects (301/302/307/308)
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume(); // drain response
          const next = new URL(res.headers.location, getUrl).href;
          console.log(`[${_ts()}] [SaleQueue] server sync redirect ${res.statusCode} -> ${next}`);
          return _doGet(next, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          if (res.statusCode === 401 && !_serverApiKey) {
            if (!_loggedOrdersUnauthorized) {
              console.log(
                `[${_ts()}] [SaleQueue] server /orders requires API key - queued server orders will not appear in this terminal on this client`,
              );
              _loggedOrdersUnauthorized = true;
            }
          } else {
            console.warn(`[${_ts()}] [SaleQueue] server sync HTTP ${res.statusCode} from ${getUrl}`);
          }
          return _finish();
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!body.ok || !Array.isArray(body.orders)) {
              console.warn(
                `[${_ts()}] [SaleQueue] server sync: unexpected response`,
                JSON.stringify(body).slice(0, 200),
              );
              return _finish();
            }

            // Global sold status must include BOTH:
            // 1) paid/delivered server orders (web wallet), and
            // 2) paid/delivered local app orders that are not present on server.
            // This prevents under-counting when app-originated orders haven't been
            // mirrored into the server order list yet.
            const serverOrderIds = new Set(body.orders.filter((o) => o && o.id).map((o) => o.id));

            // One-time reconciliation for legacy local-only app orders.
            // Newer app versions write-through to server on creation, but this migrates
            // older queued/fulfilled app orders that predate that fix.
            if (!_serverBackfillAttempted && _serverApiKey) {
              _serverBackfillAttempted = true;
              try {
                const pushed = await _backfillLocalOrdersToServer(serverOrderIds);
                if (pushed > 0) {
                  console.log(`[${_ts()}] [SaleQueue] server backfill pushed ${pushed} local-only order(s)`);
                }
              } catch (e) {
                console.warn(`[${_ts()}] [SaleQueue] server backfill error:`, e && e.message);
              }
            }

            const serverSold = body.orders
              .filter(
                (o) => o && (o.status === 'queued' || o.status === 'delivery_pending' || o.status === 'fulfilled'),
              )
              .reduce((sum, o) => sum + Math.max(0, Number(o.wtcAmount) || 0), 0);

            const localOnlySold = _orders
              .filter((o) => {
                if (!o || !o.id) return false;
                if (serverOrderIds.has(o.id)) return false;
                return o.status === 'queued' || o.status === 'delivery_pending' || o.status === 'fulfilled';
              })
              .reduce((sum, o) => sum + Math.max(0, Number(o.wtcAmount) || 0), 0);

            _serverSoldWtc = Math.max(0, Math.min(SALE_TOTAL, serverSold + localOnlySold));

            _logQueuedSnapshotOnce(body.orders);
            _logNewQueuedOrders(body.orders);
            let changed = false;
            for (const so of body.orders) {
              if (!so.id) continue;
              const local = _orders.find((o) => o.id === so.id);

              // ── Handle terminal server statuses when we have an unmatched tx ────────
              // fulfilled → WTC already delivered via another path; just clear the orphaned tx.
              // expired   → payment arrived late; rescue the order so WTC can be delivered.
              const _unmatchedForOrder = () =>
                _unmatchedTxs.find(
                  (utx) =>
                    (so.buyerEthAddress &&
                      utx.fromEthAddr &&
                      so.buyerEthAddress.toLowerCase() === utx.fromEthAddr.toLowerCase()) ||
                    (so.usdcRequired > 0 && Math.abs(so.usdcRequired - utx.usdcValue) / so.usdcRequired <= 0.2),
                );

              if (so.status === 'fulfilled') {
                const matchingUtx = _unmatchedForOrder();
                if (matchingUtx) {
                  console.log(
                    `[${_ts()}] [SaleQueue] order ${so.id} already fulfilled — clearing orphaned unmatched tx ${matchingUtx.hash}`,
                  );
                  _unmatchedTxs = _unmatchedTxs.filter((u) => u.hash !== matchingUtx.hash);
                  _saveUnmatchedTxs();
                }
                // Still mirror/update local record so balance reads are accurate
              } else if (so.status === 'expired') {
                const matchingUtx = _unmatchedForOrder();
                if (matchingUtx) {
                  const rescuedStatus = 'pending_payment';
                  if (local) {
                    if (local.status !== 'queued' && local.status !== 'fulfilled') {
                      console.log(
                        `[${_ts()}] [SaleQueue] rescuing expired order ${so.id} (local: ${local.status}) — unmatched tx found`,
                      );
                      local.status = rescuedStatus;
                      local._fromServer = true;
                      changed = true;
                    }
                  } else {
                    console.log(
                      `[${_ts()}] [SaleQueue] rescuing expired server order ${so.id} — unmatched tx found, mirroring as ${rescuedStatus}`,
                    );
                    _orders.push({ ...so, status: rescuedStatus, _fromServer: true });
                    changed = true;
                  }
                  continue;
                }
              }

              if (local) {
                // Active status rank (forward progression only for these)
                const activeRank = {
                  pending_payment: 0,
                  payment_submitted: 1,
                  queued: 2,
                  delivery_pending: 3,
                  fulfilled: 4,
                };
                const serverRank = activeRank[so.status] ?? -1;
                const localRank = activeRank[local.status] ?? -1;

                // Server is authoritative: if local is expired/failed/cancelled but server still
                // has an active status, reset local back so payment matching can proceed.
                // Also allow server to roll back fulfilled→queued (e.g. after correcting a bad flush).
                const localIsTerminal =
                  local.status === 'expired' || local.status === 'failed' || local.status === 'cancelled';
                const serverRollback = local.status === 'fulfilled' && so.status === 'queued';
                if ((localIsTerminal || serverRollback) && serverRank >= 0) {
                  console.log(
                    `[${_ts()}] [SaleQueue] server sync: resetting ${so.id} from local ${local.status} back to server ${so.status}`,
                  );
                  local.status = so.status;
                  // Clear any stale fulfillment data on rollback
                  if (serverRollback) {
                    delete local.fulfilledTxId;
                    delete local.fulfilledAtMs;
                  }
                  changed = true;
                } else if (
                  local.status !== so.status &&
                  (so.status === 'cancelled' || so.status === 'expired' || so.status === 'failed')
                ) {
                  console.log(`[${_ts()}] [SaleQueue] server sync: updating ${so.id} ${local.status} -> ${so.status}`);
                  local.status = so.status;
                  changed = true;
                } else if (serverRank > localRank) {
                  console.log(`[${_ts()}] [SaleQueue] server sync: updating ${so.id} ${local.status} -> ${so.status}`);
                  local.status = so.status;
                  changed = true;
                }
                if (so.matchedTxHash && !local.matchedTxHash) {
                  local.matchedTxHash = so.matchedTxHash;
                  changed = true;
                }
                if (so.knownTxHash && !local.knownTxHash) {
                  local.knownTxHash = so.knownTxHash;
                  changed = true;
                }
                if (so.matchedAtMs && !local.matchedAtMs) {
                  local.matchedAtMs = so.matchedAtMs;
                  changed = true;
                }
                if (so.fulfilledTxId && !local.fulfilledTxId) {
                  local.fulfilledTxId = so.fulfilledTxId;
                  changed = true;
                }
                if (so.fulfilledAtMs && !local.fulfilledAtMs) {
                  local.fulfilledAtMs = so.fulfilledAtMs;
                  changed = true;
                }
                // Always ensure _fromServer flag is set on mirrored orders
                if (!local._fromServer) {
                  local._fromServer = true;
                  changed = true;
                }
                continue;
              }
              // Not present locally — mirror it if it's an active order
              if (
                so.status === 'pending_payment' ||
                so.status === 'payment_submitted' ||
                so.status === 'queued' ||
                so.status === 'delivery_pending'
              ) {
                _orders.push({ ...so, _fromServer: true });
                changed = true;
                console.log(
                  `[${_ts()}] [SaleQueue] mirrored server order ${so.id} (${so.wtcAmount} WTC, ${so.status}) -> ${so.wtcAddress}`,
                );
              }
            }
            if (changed) _saveOrders();
          } catch (e) {
            console.warn(`[${_ts()}] [SaleQueue] server sync parse error:`, e && e.message);
          }
          _finish();
        });
      });
      req.on('error', (e) => {
        console.warn(`[${_ts()}] [SaleQueue] server sync request error:`, e && e.message);
        _finish();
      });
      req.on('timeout', () => {
        req.destroy();
        console.warn(`[${_ts()}] [SaleQueue] server sync timeout for ${getUrl}`);
        _finish();
      });
    };
    _doGet(url, 3);
  });

  return _serverSyncPromise;
}

function _refreshPublicSaleStatus() {
  if (!_serverApiUrl) return;
  if (_publicSaleStatusPromise) return _publicSaleStatusPromise;

  const now = Date.now();
  if (now - _lastPublicSaleStatusAt < PUBLIC_SALE_STATUS_MIN_INTERVAL_MS) {
    return;
  }

  _publicSaleStatusPromise = new Promise((resolve) => {
    const finish = () => {
      _lastPublicSaleStatusAt = Date.now();
      _publicSaleStatusPromise = null;
      resolve();
    };

    const urlObj = new URL(`${_serverApiUrl}/sale-status`);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname,
      method: 'GET',
      headers: { 'User-Agent': 'wattcoin-miner/1.0' },
      timeout: 10_000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode === 200 && body && body.ok) {
            _serverSoldWtc = Math.max(0, Math.min(SALE_TOTAL, Number(body.sold) || 0));
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
        }
        finish();
      });
    });

    req.on('error', () => finish());
    req.on('timeout', () => {
      req.destroy();
      finish();
    });
    req.end();
  });

  return _publicSaleStatusPromise;
}

async function _backfillLocalOrdersToServer(serverOrderIds) {
  if (!_serverApiUrl || !_serverApiKey) return 0;
  if (!(serverOrderIds instanceof Set)) return 0;

  const migratableStatuses = new Set([
    'pending_payment',
    'payment_submitted',
    'queued',
    'delivery_pending',
    'fulfilled',
    'failed',
  ]);
  const localOnly = _orders.filter((o) => o && o.id && !serverOrderIds.has(o.id) && migratableStatuses.has(o.status));
  if (localOnly.length === 0) return 0;

  let pushed = 0;
  for (const o of localOnly) {
    const res = await _upsertServerOrder(o);
    if (res && res.ok) {
      if (res.orderId && res.orderId !== o.id) {
        // Fallback path can create a fresh server ID when /upsert-order is unavailable.
        // Keep local and server in sync by adopting the server order ID.
        o.id = res.orderId;
      }
      o._fromServer = true;
      pushed += 1;
    }
  }
  if (pushed > 0) _saveOrders();
  return pushed;
}

function _upsertServerOrder(order) {
  if (!_serverApiUrl || !_serverApiKey || !order || !order.id) return Promise.resolve({ ok: false });

  const payload = JSON.stringify({
    id: String(order.id),
    wtcAddress: String(order.wtcAddress || ''),
    wtcAmount: Math.max(0, Math.floor(Number(order.wtcAmount) || 0)),
    usdcRequired: Math.round((Number(order.usdcRequired) || 0) * 1e6) / 1e6,
    buyerEthAddress: order.buyerEthAddress || null,
    status: String(order.status || 'pending_payment'),
    createdAtMs: Number(order.createdAtMs) || Date.now(),
    knownTxHash: order.knownTxHash || null,
    matchedTxHash: order.matchedTxHash || null,
    matchedAtMs: order.matchedAtMs || null,
    fulfilledTxId: order.fulfilledTxId || null,
    fulfilledAtMs: order.fulfilledAtMs || null,
  });

  const urlObj = new URL(`${_serverApiUrl}/upsert-order`);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Api-Key': _serverApiKey,
    },
    timeout: 10_000,
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const ok = res.statusCode === 200 && !!(body && body.ok);
          if (ok) {
            return resolve({ ok: true, orderId: order.id });
          }

          if (res.statusCode === 404) {
            // Server does not have /upsert-order yet. Fall back to existing endpoints.
            const fallback = await _legacyBackfillViaPlaceAndUpdate(order);
            return resolve(fallback);
          }

          if (!ok) {
            console.warn(`[${_ts()}] [SaleQueue] server upsert-order failed for ${order.id}: HTTP ${res.statusCode}`);
          }
          resolve({ ok: false });
        } catch (_) {
          console.warn(`[${_ts()}] [SaleQueue] server upsert-order parse error for ${order.id}`);
          resolve({ ok: false });
        }
      });
    });
    req.on('error', (e) => {
      console.warn(`[${_ts()}] [SaleQueue] server upsert-order error for ${order.id}:`, e && e.message);
      resolve({ ok: false });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.write(payload);
    req.end();
  });
}

async function _legacyBackfillViaPlaceAndUpdate(order) {
  try {
    const created = await _postServerPlaceOrder({
      wtcAddress: order.wtcAddress,
      wtcAmount: Math.max(1, Math.floor(Number(order.wtcAmount) || 0)),
      buyerEthAddress: order.buyerEthAddress || null,
    });

    if (!created || !created.ok || !created.orderId) {
      return { ok: false };
    }

    const newOrderId = String(created.orderId);
    const status = String(order.status || 'pending_payment');

    if (status === 'queued' || status === 'delivery_pending' || status === 'fulfilled' || status === 'failed') {
      await _updateServerOrder(newOrderId, status, {
        matchedTxHash: order.matchedTxHash || null,
        fulfilledTxId: order.fulfilledTxId || null,
        fulfilledAtMs: order.fulfilledAtMs || null,
      });
    } else if (status === 'payment_submitted' && order.knownTxHash) {
      await _postServerConfirmPayment(newOrderId, String(order.knownTxHash), order.ownerProof || null);
    }

    console.log(`[${_ts()}] [SaleQueue] legacy backfill mirrored ${order.id} -> ${newOrderId} (${status})`);
    return { ok: true, orderId: newOrderId };
  } catch (e) {
    console.warn(`[${_ts()}] [SaleQueue] legacy backfill failed for ${order && order.id}:`, e && e.message);
    return { ok: false };
  }
}

function _postServerConfirmPayment(orderId, txHash, ownerProof = null) {
  if (!_serverApiUrl) return Promise.resolve();
  const payloadObj = { orderId, txHash };
  if (typeof ownerProof === 'string' && ownerProof.trim()) payloadObj.ownerProof = ownerProof.trim();
  const payload = JSON.stringify(payloadObj);
  const urlObj = new URL(`${_serverApiUrl}/confirm-payment`);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(_serverApiKey ? { 'X-Api-Key': _serverApiKey } : {}),
    },
    timeout: 10_000,
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve());
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Push an order status update back to the server PHP API.
 * Called after matching a payment (-> queued) or fulfilling (-> fulfilled).
 */
function _updateServerOrder(orderId, status, { matchedTxHash, fulfilledTxId, fulfilledAtMs } = {}) {
  if (!_serverApiUrl || !_serverApiKey) return Promise.resolve();
  const payload = JSON.stringify({
    orderId,
    status,
    ...(matchedTxHash != null && { matchedTxHash }),
    ...(fulfilledTxId != null && { fulfilledTxId }),
    ...(fulfilledAtMs != null && { fulfilledAtMs }),
  });
  const urlObj = new URL(`${_serverApiUrl}/update-order`);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'X-Api-Key': _serverApiKey,
    },
    timeout: 10_000,
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', (e) => {
      console.warn(`[${_ts()}] [SaleQueue] server update error:`, e && e.message);
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

// ─── Etherscan poller ────────────────────────────────────────────────────────

let _reconcileTimer = null;

function _startPoller() {
  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(_pollUsdc, POLL_INTERVAL_MS);
  // Run once shortly after startup
  if (_initialPollTimer) clearTimeout(_initialPollTimer);
  _initialPollTimer = setTimeout(_pollUsdc, 10_000);

  // Reconciliation: every 60 s, if any unmatched txs exist, force a sync + retry.
  // This guards against transient server-sync failures in the main poll cycle.
  if (_reconcileTimer) clearInterval(_reconcileTimer);
  _reconcileTimer = setInterval(async () => {
    if (_unmatchedTxs.length === 0) return;
    try {
      await _syncServerOrders();
      _retryUnmatched();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
    }
  }, 60_000);

  // NOTE: No periodic flush timer. Queued orders are flushed ONLY:
  //   1. After a real block is mined (called from electron-main.js post-mine)
  //   2. When queued WTC >= FLUSH_THRESHOLD_WTC (10,101)
}

async function _pollUsdc() {
  _lastPollAt = Date.now();
  // Retry unmatched payments FIRST — must not be blocked by server sync
  _retryUnmatched();
  // Sync any orders placed via the web wallet (server PHP API) into local store
  try {
    await _syncServerOrders();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
  }
  // Retry again after server sync in case new orders were just mirrored
  _retryUnmatched();
  _retryUnmatched();
  try {
    const transfers = await _fetchUsdcTransfers();
    if (!Array.isArray(transfers)) return;

    let changed = false;
    for (const tx of transfers) {
      const txHashNorm = String((tx && tx.hash) || '').toLowerCase();
      if (_seenTxHashes.has(tx.hash)) {
        // Recovery path: if a pending order is still waiting on this known tx hash,
        // re-run matching even though the tx was already seen earlier.
        const needsRetry = _orders.some(
          (o) =>
            o &&
            !o.matchedTxHash &&
            (o.status === 'pending_payment' || o.status === 'payment_submitted') &&
            o.knownTxHash &&
            String(o.knownTxHash).toLowerCase() === txHashNorm,
        );
        if (!needsRetry) continue;

        if (tx.to.toLowerCase() !== SELLER_USDC_ADDRESS.toLowerCase()) continue;
        const seenUsdcValue = Number(tx.value) / 1e6;
        if (seenUsdcValue <= 0) continue;
        const seenTxObservedAtMs = Number(tx.timeStamp) > 0 ? Number(tx.timeStamp) * 1000 : Date.now();
        if (_matchPayment(tx.hash, seenUsdcValue, tx.from, seenTxObservedAtMs)) {
          changed = true;
        }
        continue;
      }
      _seenTxHashes.add(tx.hash);
      changed = true;

      // tx.to must be our address
      if (tx.to.toLowerCase() !== SELLER_USDC_ADDRESS.toLowerCase()) continue;

      const usdcValue = Number(tx.value) / 1e6; // USDC has 6 decimals
      if (usdcValue <= 0) continue;

      const txObservedAtMs = Number(tx.timeStamp) > 0 ? Number(tx.timeStamp) * 1000 : Date.now();
      _matchPayment(tx.hash, usdcValue, tx.from, txObservedAtMs);
    }

    if (changed) {
      _saveSeenHashes();
      _saveOrders();
    }

    // Check if we should flush (threshold reached)
    await _maybeFlushByThreshold();
  } catch (e) {
    console.warn(`[${_ts()}] [SaleQueue] USDC poll error:`, e && e.message);
  }
}

async function _fetchUsdcTransfers() {
  // Fetch the last 100 ERC-20 transfers to our address for USDC contract
  const params = new URLSearchParams({
    chainid: '1',
    module: 'account',
    action: 'tokentx',
    contractaddress: USDC_CONTRACT,
    address: SELLER_USDC_ADDRESS,
    sort: 'desc',
    offset: '100',
    page: '1',
  });
  if (ETHERSCAN_API_KEY) params.set('apikey', ETHERSCAN_API_KEY);

  const url = `${ETHERSCAN_BASE}?${params}`;

  for (let attempt = 0; attempt <= ETHERSCAN_REQUEST_RETRIES; attempt += 1) {
    const result = await _fetchUsdcTransfersOnce(url);
    if (result.ok) {
      _lastPollResult = result.pollResult;
      return result.transfers;
    }

    const retryable = _isRetryableEtherscanError(result.pollResult);
    if (!retryable || attempt === ETHERSCAN_REQUEST_RETRIES) {
      _lastPollResult = result.pollResult;
      return null;
    }

    console.warn(
      `[${_ts()}] [SaleQueue] Etherscan transient failure (${result.pollResult}) - retry ${attempt + 1}/${ETHERSCAN_REQUEST_RETRIES}`,
    );
    await _delay(ETHERSCAN_RETRY_DELAY_MS);
  }

  _lastPollResult = 'error:request failed';
  return null;
}

function _fetchUsdcTransfersOnce(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 10_000, headers: { 'User-Agent': 'wattcoin-miner/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (body.status === '1' && Array.isArray(body.result)) {
            resolve({ ok: true, pollResult: 'ok', transfers: body.result });
          } else if (body.status === '0' && body.message === 'No transactions found') {
            resolve({ ok: true, pollResult: 'ok', transfers: [] });
          } else {
            const msg = body.message || body.status || 'NOTOK';
            const detail = typeof body.result === 'string' ? body.result : '';
            const pollResult = `notok:${msg}`;
            console.warn(`[${_ts()}] [SaleQueue] Etherscan response:`, msg, detail);
            resolve({ ok: false, pollResult, transfers: null });
          }
        } catch (e) {
          const pollResult = `error:${e && e.message ? e.message : 'parse error'}`;
          console.warn(`[${_ts()}] [SaleQueue] Etherscan parse error:`, e && e.message);
          resolve({ ok: false, pollResult, transfers: null });
        }
      });
    });
    req.on('error', (e) => {
      const pollResult = `error:${e && e.message ? e.message : 'request error'}`;
      console.warn(`[${_ts()}] [SaleQueue] Etherscan request error:`, e && e.message);
      resolve({ ok: false, pollResult, transfers: null });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, pollResult: 'timeout', transfers: null });
    });
  });
}

function _isRetryableEtherscanError(pollResult) {
  const value = String(pollResult || '').toLowerCase();
  return (
    value === 'timeout' ||
    value.includes('socket hang up') ||
    value.includes('econnreset') ||
    value.includes('etimedout') ||
    value.includes('timeout')
  );
}

function _delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry all buffered unmatched payments against current pending orders.
 * Called on every poll and immediately after a new order is placed.
 */
function _retryUnmatched() {
  if (_unmatchedTxs.length === 0) return;
  let changed = false;
  const stillUnmatched = [];
  for (const utx of _unmatchedTxs) {
    const matched = _matchPayment(
      utx.hash,
      utx.usdcValue,
      utx.fromEthAddr,
      utx.txObservedAtMs || utx.receivedAtMs || Date.now(),
    );
    if (matched) {
      changed = true;
    } else {
      stillUnmatched.push(utx);
    }
  }
  if (changed) {
    _unmatchedTxs = stillUnmatched;
    _saveUnmatchedTxs();
    _saveOrders();
  }
}

/**
 * Try to match an incoming USDC payment to a pending order.
 * 1. Prefer exact tx hash match (reliable — user paid via confirmPayment).
 * 2. Then ETH sender address.
 * 3. Finally amount proximity.
 * Returns true if matched, false if not.
 */
function _matchPayment(txHash, usdcValue, fromEthAddr, txObservedAtMs = Date.now()) {
  const txHashNorm = String(txHash || '').toLowerCase();
  const PAYMENT_EPSILON_USDC = 0.000001; // 1 micro-USDC
  const isPaymentSufficient = (order) => {
    const required = Number(order && order.usdcRequired);
    if (!Number.isFinite(required) || required <= 0) return false;
    return Number(usdcValue) + PAYMENT_EPSILON_USDC >= required;
  };

  // A transfer hash can only fund one order. A knownTxHash on a still-pending
  // order is expected and must not block matching that same order.
  const alreadyLinked = _orders.find(
    (o) =>
      o &&
      ((o.matchedTxHash && String(o.matchedTxHash).toLowerCase() === txHashNorm) ||
        (o.knownTxHash &&
          String(o.knownTxHash).toLowerCase() === txHashNorm &&
          o.status !== 'pending_payment' &&
          o.status !== 'payment_submitted')),
  );
  if (alreadyLinked) {
    return false;
  }

  const txTimeMs = Number.isFinite(Number(txObservedAtMs)) ? Number(txObservedAtMs) : Date.now();
  const _isTxTooOldForOrder = (o) => {
    const createdAtMs = Number(o && o.createdAtMs);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return false;
    return txTimeMs < createdAtMs - MATCH_TX_GRACE_MS;
  };

  const pendingOrders = _orders.filter((o) => o.status === 'pending_payment' || o.status === 'payment_submitted');
  const eligiblePendingOrders = pendingOrders.filter((o) => !_isTxTooOldForOrder(o));

  // Fast path: no pending work means there is nothing to match.
  if (eligiblePendingOrders.length === 0) {
    return false;
  }

  // ── Step 1: Exact tx hash match (from confirmPayment call) ───────────────
  const hashMatch = eligiblePendingOrders.find((o) => o.knownTxHash && o.knownTxHash.toLowerCase() === txHashNorm);
  if (hashMatch) {
    if (!isPaymentSufficient(hashMatch)) {
      console.warn(
        `[${_ts()}] [SaleQueue] Rejecting underpaid tx for known order ${hashMatch.id}: ` +
          `paid=${Number(usdcValue).toFixed(6)} required=${Number(hashMatch.usdcRequired).toFixed(6)} tx=${txHash}`,
      );
      return false;
    }
    hashMatch.status = 'queued';
    hashMatch.matchedTxHash = txHash;
    hashMatch.matchedAtMs = Date.now();
    console.log(`[${_ts()}] [SaleQueue] queued buy added: ${_queueSummary(hashMatch)} tx=${txHash.slice(0, 14)}...`);
    _knownQueuedOrderIds.add(hashMatch.id);
    if (hashMatch._fromServer) _updateServerOrder(hashMatch.id, 'queued', { matchedTxHash: txHash });
    return true;
  }

  // ── Step 2: ETH address match against pending orders ─────────────────────
  if (fromEthAddr) {
    const ethCandidates = eligiblePendingOrders.filter(
      (o) =>
        o.buyerEthAddress && o.buyerEthAddress.toLowerCase() === fromEthAddr.toLowerCase() && isPaymentSufficient(o),
    );
    let ethMatch = null;
    let ethBestDelta = Infinity;
    for (const candidate of ethCandidates) {
      const delta = Math.abs(Number(candidate.usdcRequired) - Number(usdcValue));
      if (delta < ethBestDelta) {
        ethBestDelta = delta;
        ethMatch = candidate;
      }
    }
    if (ethMatch) {
      ethMatch.status = 'queued';
      ethMatch.matchedTxHash = txHash;
      ethMatch.matchedAtMs = Date.now();
      console.log(`[${_ts()}] [SaleQueue] queued buy added: ${_queueSummary(ethMatch)} tx=${txHash.slice(0, 14)}...`);
      _knownQueuedOrderIds.add(ethMatch.id);
      if (ethMatch._fromServer) _updateServerOrder(ethMatch.id, 'queued', { matchedTxHash: txHash });
      return true;
    }
  }

  // ── Step 3: Amount-based fallback (full amount only) ─────────────────────
  // Strict payment enforcement: a payment must fully cover usdcRequired.
  let best = null;
  let bestDelta = Infinity;
  for (const o of eligiblePendingOrders) {
    if (!isPaymentSufficient(o)) continue;
    const delta = Math.abs(o.usdcRequired - usdcValue);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = o;
    }
  }

  if (best) {
    best.status = 'queued';
    best.matchedTxHash = txHash;
    best.matchedAtMs = Date.now();
    console.log(`[${_ts()}] [SaleQueue] queued buy added: ${_queueSummary(best)} tx=${txHash.slice(0, 14)}...`);
    _knownQueuedOrderIds.add(best.id);
    if (best._fromServer) _updateServerOrder(best.id, 'queued', { matchedTxHash: txHash });
    return true;
  }

  // ── Step 4: Link tx hash to an already-queued order with no matchedTxHash ─
  // Handles the case where the order got promoted to 'queued' via another channel
  // (e.g. manual admin action, server sync) before the Etherscan payment was linked.
  const unlinkedQueued = _orders.filter(
    (o) => (o.status === 'queued' || o.status === 'payment_submitted') && !o.matchedTxHash,
  );
  const eligibleUnlinkedQueued = unlinkedQueued.filter((o) => !_isTxTooOldForOrder(o));
  if (fromEthAddr && eligibleUnlinkedQueued.length > 0) {
    const ethMatch2 = eligibleUnlinkedQueued.find(
      (o) =>
        o.buyerEthAddress && o.buyerEthAddress.toLowerCase() === fromEthAddr.toLowerCase() && isPaymentSufficient(o),
    );
    if (ethMatch2) {
      ethMatch2.matchedTxHash = txHash;
      ethMatch2.matchedAtMs = Date.now();
      if (ethMatch2._fromServer) _updateServerOrder(ethMatch2.id, 'queued', { matchedTxHash: txHash });
      return true;
    }
  }
  for (const o of eligibleUnlinkedQueued) {
    if (isPaymentSufficient(o)) {
      o.matchedTxHash = txHash;
      o.matchedAtMs = Date.now();
      if (o._fromServer) _updateServerOrder(o.id, 'queued', { matchedTxHash: txHash });
      return true;
    }
  }

  // ── Nothing matched — buffer for retry ───────────────────────────────────
  if (!_unmatchedTxs.find((u) => u.hash === txHash)) {
    _unmatchedTxs.push({ hash: txHash, usdcValue, fromEthAddr, receivedAtMs: Date.now(), txObservedAtMs: txTimeMs });
    _saveUnmatchedTxs();
    console.warn(
      `[${_ts()}] [SaleQueue] UNMATCHED $${usdcValue.toFixed(6)} from ${fromEthAddr} tx=${txHash} — buffered (${_unmatchedTxs.length} total)`,
    );
    // Schedule a fast sync+retry in 30s in case a matching order arrives soon
    setTimeout(async () => {
      try {
        await _syncServerOrders();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
      }
      _retryUnmatched();
    }, 30_000);
  }
  return false;
}

// ─── Flush logic ─────────────────────────────────────────────────────────────

let _flushBusy = false; // reentrancy guard — prevents concurrent double-flushes

/**
 * Called automatically when a block is mined (regardless of queue size).
 * Also called when queue hits FLUSH_THRESHOLD_WTC.
 */
function flushSaleQueue() {
  if (!_wtcNode) return;
  if (_flushBusy) {
    console.log(`[${_ts()}] [SaleQueue] flushSaleQueue: already in progress, skipping`);
    return;
  }

  const batch = _orders.filter((o) => o.status === 'queued');
  if (batch.length === 0) return;

  _flushBusy = true;
  console.log(
    `[${_ts()}] [SaleQueue] Flushing ${batch.length} orders (${batch.reduce((s, o) => s + o.wtcAmount, 0)} WTC)`,
  );

  try {
    for (const order of batch) {
      try {
        const result = _wtcNode.send({
          fromAddress: SALE_WTC_ADDRESS,
          toAddress: order.wtcAddress,
          amount: order.wtcAmount,
        });
        order.status = 'delivery_pending'; // mempool tx created — needs a block to confirm
        order.fulfilledTxId = result.txid;
        order.fulfilledAtMs = Date.now();
        console.log(
          `[${_ts()}] [SaleQueue] Queued send ${order.wtcAmount} WTC -> ${order.wtcAddress} txid=${result.txid} (awaiting block confirmation)`,
        );
      } catch (e) {
        order.status = 'failed';
        order.failedAtMs = Date.now();
        order.failReason = e && e.message ? e.message : 'unknown';
        console.warn(
          `[${_ts()}] [SaleQueue] Failed to send ${order.wtcAmount} WTC -> ${order.wtcAddress}:`,
          order.failReason,
        );
        if (order._fromServer) _updateServerOrder(order.id, 'failed', {});
      }
    }
    _saveOrders();
  } finally {
    _flushBusy = false;
  }

  // After txs are in mempool, orders remain 'delivery_pending' until the next
  // naturally mined block confirms them. onBlockConfirmed() promotes to 'fulfilled'.
}

/**
 * Called after a block is committed.  Promotes any 'delivery_pending' orders
 * whose fulfilledTxId appeared in the block to 'fulfilled', and retries any
 * that were dropped from the mempool (re-queues them).
 */
function onBlockConfirmed() {
  const pendingOrders = _orders.filter((o) => o.status === 'delivery_pending');
  if (pendingOrders.length === 0) return;
  let changed = false;
  for (const order of pendingOrders) {
    if (!order.fulfilledTxId) {
      // No txid recorded — re-queue so next flush retries
      order.status = 'queued';
      order.fulfilledAtMs = null;
      changed = true;
      console.warn(`[${_ts()}] [SaleQueue] delivery_pending order ${order.id} has no txid \u2014 re-queued`);
      continue;
    }
    let txStatus = 'unknown';
    try {
      txStatus = _wtcNode ? _wtcNode.getTxStatus(order.fulfilledTxId).status : 'unknown';
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
    }
    if (txStatus === 'confirmed') {
      order.status = 'fulfilled';
      changed = true;
      console.log(
        `[${_ts()}] [SaleQueue] Confirmed ${order.wtcAmount} WTC \u2192 ${order.wtcAddress} txid=${order.fulfilledTxId}`,
      );
      if (order._fromServer)
        _updateServerOrder(order.id, 'fulfilled', {
          fulfilledTxId: order.fulfilledTxId,
          fulfilledAtMs: order.fulfilledAtMs,
        });
    } else if (txStatus === 'unknown') {
      // Tx was dropped from mempool (e.g. node restart) \u2014 re-queue for next flush
      order.status = 'queued';
      order.fulfilledTxId = null;
      order.fulfilledAtMs = null;
      changed = true;
      console.warn(`[${_ts()}] [SaleQueue] delivery_pending order ${order.id} tx not found \u2014 re-queued`);
    }
    // 'pending' = still in mempool, leave as delivery_pending, next block will confirm
  }
  if (changed) _saveOrders();
}

async function _maybeFlushByThreshold() {
  const queuedWTC = _orders.filter((o) => o.status === 'queued').reduce((s, o) => s + o.wtcAmount, 0);
  if (queuedWTC >= FLUSH_THRESHOLD_WTC) {
    console.log(`[${_ts()}] [SaleQueue] Threshold reached (${queuedWTC} WTC) - triggering flush`);
    await flushSaleQueue();
  }
}

// ─── Expiry cleanup ──────────────────────────────────────────────────────────

function expireOldOrders() {
  const now = Date.now();
  let changed = false;
  for (const o of _orders) {
    if (
      (o.status === 'pending_payment' || o.status === 'payment_submitted') &&
      now - o.createdAtMs > PAYMENT_EXPIRY_MS
    ) {
      o.status = 'expired';
      o.expiredAtMs = now;
      changed = true;
      console.log(`[${_ts()}] [SaleQueue] Order ${o.id} expired (no payment within 24h)`);
    }
  }
  if (changed) _saveOrders();

  // Prune unmatched TXs older than 48 hours — they can't be matched to expired orders
  const UNMATCHED_TTL_MS = 48 * 60 * 60 * 1000;
  const before = _unmatchedTxs.length;
  _unmatchedTxs = _unmatchedTxs.filter((u) => now - (u.receivedAtMs || 0) < UNMATCHED_TTL_MS);
  if (_unmatchedTxs.length !== before) {
    _saveUnmatchedTxs();
    console.log(`[${_ts()}] [SaleQueue] Pruned ${before - _unmatchedTxs.length} stale unmatched TX(s)`);
  }
}

// Run expiry check hourly
setInterval(expireOldOrders, 60 * 60 * 1000);

// ─── Exports ─────────────────────────────────────────────────────────────────

function getLastPollStatus() {
  return { at: _lastPollAt, result: _lastPollResult };
}

function getUnmatchedTxs() {
  return _unmatchedTxs.map((t) => ({ ...t }));
}

/**
 * Sync orders from the server and then return the current sold WTC count.
 * Used by the IPC status handler so the Buy tab always reflects live server data.
 */
async function refreshSoldWTC() {
  try {
    await _refreshPublicSaleStatus();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
  }
  try {
    await _syncServerOrders();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[SaleQueue] Caught:', String(_.message || _).slice(0, 80));
  }
  return getSoldWTC();
}

module.exports = {
  init,
  shutdown,
  getLastPollStatus,
  getUnmatchedTxs,
  placeSaleOrder,
  getOrders,
  getOrder,
  getOrdersForAddress,
  getPurchaseTotalForAddress,
  cancelOrder,
  setOrderTxHash,
  computeUsdcRequired,
  getSoldWTC,
  refreshSoldWTC,
  setElectricityPrice,
  setServerApi,
  activeTierIdx,
  flushSaleQueue,
  onBlockConfirmed,
  SALE_WTC_ADDRESS,
  SELLER_USDC_ADDRESS,
  SALE_TIERS,
  SALE_TOTAL,
  SALE_TIER_SIZE,
  MIN_BUY_WTC,
};
