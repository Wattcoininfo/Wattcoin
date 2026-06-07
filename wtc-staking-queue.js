/**
 * wtc-staking-queue.js
 *
 * Manages the WTC staking queue and reward distribution.
 *
 * APY formula:
 *   apy = floor(totalCurrentlyQueuedWTC / 10_000)   (percent per year)
 *   Examples: 100 000 WTC staked → 10% APY
 *             110 000 WTC staked → 11% APY
 *             200 000 WTC staked → 20% APY
 *   Minimum meaningful stake to earn ANY APY: 10 000 WTC (→ 1%).
 *
 * Flow:
 *   1. User calls stakeWtc({ fromAddress, wtcAmount })
 *      → entry saved to disk (status: 'pending'), returns { entryId }
 *   2. When totalPendingWTC >= FLUSH_THRESHOLD_WTC (10 000 WTC):
 *      flushStakingQueue() fires automatically (OR after every mined block).
 *   3. On flush:
 *      a) Compute current APY from the total pending pool.
 *      b) For each pending entry: reward = stakedAmount × apy / 100
 *      c) Reward is paid FROM STAKING_POOL_ADDRESS TO the staker's fromAddress
 *         via wtcNode.send().
 *      d) Staking entries are cleared (status → 'rewarded').
 *   4. "Coins left to earn" = confirmed balance of STAKING_POOL_ADDRESS.
 *
 *   If mining is active, flushStakingQueue() is called after each block —
 *   staking rewards trickle into every mined block automatically.
 */

// SPDX-License-Identifier: MIT
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ─── Config ──────────────────────────────────────────────────────────────────

// Tier-0 pre-mine staking rewards pool address.
// Rewards are paid OUT from this address to stakers.
const { STAKING_POOL_ADDRESS } = require('./protocol-constants');

// Trigger a block flush when this many WTC are pending in the queue.
const FLUSH_THRESHOLD_WTC = 10_000;

// Minimum staking entry size (anything smaller is not worth the tx fee).
const MIN_STAKE_WTC = 100;

// Maximum APY payout cap to protect the pool from edge cases.
const MAX_APY_PCT = 100;

// Expose for use in electron-main.js.
module.exports.STAKING_POOL_ADDRESS = STAKING_POOL_ADDRESS;
module.exports.FLUSH_THRESHOLD_WTC = FLUSH_THRESHOLD_WTC;
module.exports.MIN_STAKE_WTC = MIN_STAKE_WTC;

// ─── State ───────────────────────────────────────────────────────────────────

let _dataDir = null;
let _wtcNode = null;
let _entries = []; // in-memory, persisted to disk

// ─── Init / shutdown ─────────────────────────────────────────────────────────

function init(dataDir, wtcNode) {
  _dataDir = dataDir;
  _wtcNode = wtcNode;
  _queueSecret = null; // reset so the correct per-dir secret is loaded
  _loadEntries();
  console.log('[StakingQueue] init - loaded', _entries.length, 'entries');
}
module.exports.init = init;

function setWtcNode(wtcNode) {
  _wtcNode = wtcNode;
}
module.exports.setWtcNode = setWtcNode;

// ─── File I/O ────────────────────────────────────────────────────────────────

function _entriesPath() {
  return path.join(_dataDir, 'staking-entries.json');
}

// Per-install HMAC secret so tampering with staking-entries.json
// (e.g. inflating wtcAmount or injecting fake 'rewarded' entries) is detected.
let _queueSecret = null;
function _secretPath() {
  return path.join(_dataDir, 'staking-queue-secret.json');
}
function _loadOrCreateQueueSecret() {
  if (_queueSecret) return _queueSecret;
  try {
    if (fs.existsSync(_secretPath())) {
      const raw = JSON.parse(fs.readFileSync(_secretPath(), 'utf8'));
      if (raw && typeof raw.secret === 'string' && raw.secret.length >= 32) {
        _queueSecret = raw.secret;
        return _queueSecret;
      }
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[StakingQueue] Caught:', String(_.message || _).slice(0, 80));
  }
  _queueSecret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(_dataDir, { recursive: true });
    fs.writeFileSync(_secretPath(), JSON.stringify({ secret: _queueSecret }), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[StakingQueue] Caught:', String(_.message || _).slice(0, 80));
  }
  return _queueSecret;
}
function _computeEntriesSig(entries) {
  const secret = _loadOrCreateQueueSecret();
  return crypto.createHmac('sha256', secret).update(JSON.stringify(entries)).digest('hex');
}

function _loadEntries() {
  _entries = []; // always reset so stale in-memory state never leaks across init() calls
  try {
    if (fs.existsSync(_entriesPath())) {
      const parsed = JSON.parse(fs.readFileSync(_entriesPath(), 'utf8'));
      if (!parsed || typeof parsed !== 'object') {
        _entries = [];
        return;
      }
      const { _sig, entries } = parsed;
      const arr = Array.isArray(entries) ? entries : Array.isArray(parsed) ? parsed : [];
      // If the file was written with HMAC, verify it. Legacy plain-array files are
      // accepted once and re-saved with a signature on the next write.
      if (typeof _sig === 'string') {
        const expected = _computeEntriesSig(arr);
        if (!crypto.timingSafeEqual(Buffer.from(_sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
          console.warn('[StakingQueue] Tampered staking-entries.json detected - resetting queue.');
          _entries = [];
          return;
        }
      }
      _entries = arr;
    }
  } catch (_) {
    _entries = [];
  }
}

function _saveEntries() {
  try {
    if (!_dataDir) return;
    fs.mkdirSync(_dataDir, { recursive: true });
    const dest = _entriesPath();
    const tmp = dest + '.tmp';
    const sig = _computeEntriesSig(_entries);
    fs.writeFileSync(tmp, JSON.stringify({ entries: _entries, _sig: sig }, null, 2), 'utf8');
    fs.renameSync(tmp, dest);
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[StakingQueue] Caught:', String(_.message || _).slice(0, 80));
  }
}

// ─── Web API integration (shared pool: app + website) ────────────────────────

let _webApiUrl = null; // e.g. 'https://wattcoin.ee/api'
let _webApiKey = null;
let _webPendingWtc = 0; // cached pending WTC from website staking entries
let _webSyncTimer = null;

/**
 * Configure the web API so this queue syncs with the website staking backend.
 * Call once at startup (after init). Pass null key to disable.
 */
function setWebApi(url, key) {
  _webApiUrl = url ? url.replace(/\/$/, '') : null;
  _webApiKey = key || null;
  _webPendingWtc = 0;
  if (_webSyncTimer) {
    clearInterval(_webSyncTimer);
    _webSyncTimer = null;
  }
  if (_webApiUrl && _webApiKey) {
    _syncWebPending().catch(() => {});
    _pushWebStats().catch(() => {});
    _webSyncTimer = setInterval(() => {
      _syncWebPending().catch(() => {});
      _pushWebStats().catch(() => {});
    }, 30_000);
    console.log('[StakingQueue] Web API configured:', _webApiUrl);
  }
}
module.exports.setWebApi = setWebApi;

function stopWebSync() {
  if (_webSyncTimer) {
    clearInterval(_webSyncTimer);
    _webSyncTimer = null;
  }
}
module.exports.stopWebSync = stopWebSync;

/** Minimal promise-based HTTPS/HTTP JSON helper (no external deps). */
function _httpJson(method, url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      method,
      timeout: 12_000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
    };
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (_) {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('HTTP timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/** Fetch web pending entries and cache the total pending WTC. */
async function _syncWebPending() {
  if (!_webApiUrl || !_webApiKey) return;
  try {
    const r = await _httpJson('GET', _webApiUrl + '/staking/entries', { 'X-Api-Key': _webApiKey }, null);
    if (r.status === 200 && r.body && r.body.ok && Array.isArray(r.body.entries)) {
      _webPendingWtc = r.body.entries
        .filter((e) => e.status === 'pending')
        .reduce((s, e) => s + (Number(e.wtcAmount) || 0), 0);
    }
  } catch (e) {
    console.warn('[StakingQueue] Web sync failed:', e && e.message);
  }
}

/** Push combined pool stats to website so /staking-status is accurate. */
async function _pushWebStats() {
  if (!_webApiUrl || !_webApiKey) return;
  const bal = poolBalance();
  try {
    await _httpJson(
      'POST',
      _webApiUrl + '/staking/update-pool-balance',
      { 'X-Api-Key': _webApiKey },
      {
        balance: bal !== null ? bal : undefined,
        totalStaked: totalPendingWtc(),
        currentApy: currentApy(),
      },
    );
  } catch (e) {
    console.warn('[StakingQueue] Web stats push failed:', e && e.message);
  }
}

// ─── APY computation ─────────────────────────────────────────────────────────

/**
 * Current APY percentage based on total WTC currently in pending queue.
 * apy = round(totalPendingWTC / 10 000, 2 decimal places)
 * Every 100 WTC staked = +0.01% APY.  Minimum non-zero APY: 0.01% (100 WTC).
 */
function currentApy() {
  const total = totalPendingWtc();
  return Math.min(MAX_APY_PCT, Math.round((total / 10_000) * 100) / 100);
}
module.exports.currentApy = currentApy;

/**
 * Total WTC currently in the pending queue (not yet flushed).
 * Includes both local (app) pending entries AND cached website pending entries.
 */
function totalPendingWtc() {
  const local = _entries.filter((e) => e.status === 'pending').reduce((s, e) => s + e.wtcAmount, 0);
  return local + _webPendingWtc;
}
module.exports.totalPendingWtc = totalPendingWtc;

/**
 * Remaining staking reward coins available from the pool.
 * Returns null if node not ready.
 */
function poolBalance() {
  if (!_wtcNode) return null;
  try {
    const bal = _wtcNode.getBalance(STAKING_POOL_ADDRESS);
    return (bal.confirmed || 0) + (bal.unmatured || 0);
  } catch (_) {
    return null;
  }
}
module.exports.poolBalance = poolBalance;

// ─── Entry CRUD ──────────────────────────────────────────────────────────────

/**
 * Submit a staking entry.
 * @param {{ fromAddress: string, wtcAmount: number }} opts
 */
function stakeWtc({ fromAddress, wtcAmount }) {
  if (!fromAddress || typeof fromAddress !== 'string') {
    return { ok: false, error: 'fromAddress required' };
  }
  if (!Number.isFinite(wtcAmount) || wtcAmount < MIN_STAKE_WTC) {
    return { ok: false, error: `Minimum stake is ${MIN_STAKE_WTC} WTC` };
  }

  // Prevent duplicate pending entries for the same address.
  const existing = _entries.find((e) => e.fromAddress === fromAddress && e.status === 'pending');
  if (existing) {
    return { ok: true, entryId: existing.id, alreadyExists: true };
  }

  const entryId = crypto.randomBytes(12).toString('hex');
  const entry = {
    id: entryId,
    fromAddress,
    wtcAmount: Math.floor(wtcAmount),
    status: 'pending', // pending | rewarded | cancelled | failed
    createdAtMs: Date.now(),
    rewardAtMs: null,
    rewardAmount: null,
    rewardTxId: null,
    apyAtFlush: null,
    failReason: null,
  };

  _entries.push(entry);
  _saveEntries();
  console.log(`[StakingQueue] entry ${entryId} created - ${wtcAmount} WTC staked by ${fromAddress}`);

  return { ok: true, entryId };
}
module.exports.stakeWtc = stakeWtc;

/**
 * Get a single entry by id.
 */
function getEntry(entryId) {
  const e = _entries.find((e) => e.id === entryId);
  return e ? { ...e } : null;
}
module.exports.getEntry = getEntry;

/**
 * Get pending entry for a given wallet address (if any).
 */
function getEntryForAddress(addr) {
  if (!addr) return [];
  return _entries.filter((e) => e.fromAddress === addr).map((e) => ({ ...e }));
}
module.exports.getEntryForAddress = getEntryForAddress;

/**
 * Cancel a pending staking entry before it is flushed.
 */
function cancelEntry(entryId) {
  const e = _entries.find((e) => e.id === entryId);
  if (!e) return { ok: false, error: 'Entry not found' };
  if (e.status !== 'pending') return { ok: false, error: `Cannot cancel entry in status '${e.status}'` };
  e.status = 'cancelled';
  _saveEntries();
  return { ok: true };
}
module.exports.cancelEntry = cancelEntry;

/**
 * Get all entries (admin view).
 */
function getAllEntries() {
  return _entries.map((e) => ({ ...e }));
}
module.exports.getAllEntries = getAllEntries;

// ─── Flush logic ─────────────────────────────────────────────────────────────

/**
 * Returns true when the pending queue has reached the flush threshold.
 */
function shouldFlush() {
  return totalPendingWtc() >= FLUSH_THRESHOLD_WTC;
}
module.exports.shouldFlush = shouldFlush;

/**
 * Called after every mined block AND when the threshold is reached.
 * Computes rewards for all pending entries and pays them from the staking pool.
 *
 * Reward per entry = floor(wtcAmount × currentApy / 100)  (currentApy is x.xx%)
 *
 * Entries are cleared (status → 'rewarded' or 'failed') after processing.
 */
async function flushStakingQueue() {
  if (!_wtcNode) return;

  // Fetch live web pending entries so they are processed in the same flush.
  let webBatch = [];
  if (_webApiUrl && _webApiKey) {
    try {
      const r = await _httpJson('GET', _webApiUrl + '/staking/entries', { 'X-Api-Key': _webApiKey }, null);
      if (r.status === 200 && r.body && r.body.ok && Array.isArray(r.body.entries)) {
        webBatch = r.body.entries.filter((e) => e.status === 'pending');
        // Update cached total from the live fetch
        _webPendingWtc = webBatch.reduce((s, e) => s + (Number(e.wtcAmount) || 0), 0);
      }
    } catch (e) {
      console.warn('[StakingQueue] Could not fetch web entries for flush:', e && e.message);
    }
  }

  const localBatch = _entries.filter((e) => e.status === 'pending');
  if (localBatch.length === 0 && webBatch.length === 0) return;

  // Deduplicate: if the same address has a local entry AND a web entry, drop the
  // web one — the local entry already covers that address with an on-chain balance
  // check. Without this, a user could double-stake (app + website) for double rewards.
  const localAddresses = new Set(localBatch.map((e) => e.fromAddress));
  const dedupedWebBatch = webBatch.filter((e) => !localAddresses.has(e.wtcAddress));

  // APY is computed from the combined total (local + web) via totalPendingWtc()
  const apy = currentApy();
  const totalLocal = localBatch.reduce((s, e) => s + e.wtcAmount, 0);
  const totalWeb = dedupedWebBatch.reduce((s, e) => s + (Number(e.wtcAmount) || 0), 0);
  console.log(
    `[StakingQueue] Flushing ${localBatch.length} local + ${dedupedWebBatch.length} web entries` +
      ` (${totalLocal + totalWeb} WTC combined, APY ${apy}%)` +
      (webBatch.length !== dedupedWebBatch.length
        ? ` [${webBatch.length - dedupedWebBatch.length} web entries skipped: cross-platform duplicate address]`
        : ''),
  );

  const poolAvailable = () => {
    try {
      return poolBalance();
    } catch (_) {
      return null;
    }
  };
  if (poolAvailable() !== null && poolAvailable() <= 0) {
    console.warn('[StakingQueue] Staking pool balance is 0 - skipping reward distribution');
    return;
  }

  // ── Process local (app) entries ──────────────────────────────────────────
  for (const entry of localBatch) {
    // Re-verify on-chain balance at flush time to close the relay exploit:
    // stake from addr A → move coins to addr B → stake from addr B → both rewarded.
    // If the wallet no longer holds the staked amount, skip the reward.
    try {
      const bal = _wtcNode.getBalance(entry.fromAddress);
      const available = (bal.confirmed || 0) + (bal.unmatured || 0);
      if (available < entry.wtcAmount) {
        entry.status = 'failed';
        entry.failReason = 'balance_insufficient_at_flush';
        entry.rewardAtMs = Date.now();
        entry.apyAtFlush = apy;
        console.warn(
          `[StakingQueue] Rejected entry ${entry.id}: ` +
            `balance ${available} WTC < staked ${entry.wtcAmount} WTC at flush time`,
        );
        continue;
      }
    } catch (e) {
      // Balance check failed — skip entry rather than pay a potentially fraudulent reward
      entry.status = 'failed';
      entry.failReason = 'balance_check_error_at_flush';
      entry.rewardAtMs = Date.now();
      entry.apyAtFlush = apy;
      console.warn(`[StakingQueue] Balance check error for entry ${entry.id}:`, e && e.message);
      continue;
    }

    const reward = Math.floor((entry.wtcAmount * apy) / 100);
    if (reward <= 0) {
      // Reward rounds to 0 — skip this entry so it stays pending and gets
      // re-evaluated on the next flush when APY may be higher.  Without this
      // guard the entry would be marked rewarded (consumed) with nothing paid.
      console.log(
        `[StakingQueue] Deferred entry ${entry.id}: ${entry.wtcAmount} WTC @ ${apy}% APY ` +
          `= ${reward} WTC reward — waiting for higher APY`,
      );
      continue;
    }
    const livePool = poolAvailable();
    if (livePool !== null && reward > livePool) {
      console.warn(`[StakingQueue] Pool insufficient for entry ${entry.id} reward ${reward} WTC (pool=${livePool})`);
      entry.status = 'failed';
      entry.failReason = 'pool_insufficient';
      continue;
    }
    try {
      const result = _wtcNode.send({
        fromAddress: STAKING_POOL_ADDRESS,
        toAddress: entry.fromAddress,
        amount: reward,
      });
      entry.status = 'rewarded';
      entry.rewardAtMs = Date.now();
      entry.rewardAmount = reward;
      entry.rewardTxId = result.txid;
      entry.apyAtFlush = apy;
      console.log(
        `[StakingQueue] Paid ${reward} WTC reward -> ${entry.fromAddress}` +
          ` (staked ${entry.wtcAmount} WTC @ ${apy}% APY) txid=${result.txid}`,
      );
    } catch (e) {
      entry.status = 'failed';
      entry.rewardAtMs = Date.now();
      entry.apyAtFlush = apy;
      entry.failReason = e && e.message ? e.message : 'unknown';
      console.warn(`[StakingQueue] Failed reward for entry ${entry.id}:`, entry.failReason);
    }
  }
  _saveEntries();

  // ── Process web (website) entries ────────────────────────────────────────
  // Note: web entries may include WTC that is 'queued for delivery' (not yet on-chain),
  // so no on-chain balance re-check is done here (wallet-to-wallet transfer is disabled).
  for (const entry of dedupedWebBatch) {
    const stakedAmt = Number(entry.wtcAmount) || 0;
    const update = { entryId: entry.id };
    const reward = Math.floor((stakedAmt * apy) / 100);
    if (reward <= 0) {
      console.log(
        `[StakingQueue] Deferred web entry ${entry.id}: ${stakedAmt} WTC @ ${apy}% APY ` +
          `= ${reward} WTC reward — waiting for higher APY`,
      );
      continue;
    } else {
      const livePool = poolAvailable();
      if (livePool !== null && reward > livePool) {
        console.warn(
          `[StakingQueue] Pool insufficient for web entry ${entry.id} reward ${reward} WTC (pool=${livePool})`,
        );
        update.status = 'failed';
        update.failReason = 'pool_insufficient';
      } else {
        try {
          const result = _wtcNode.send({
            fromAddress: STAKING_POOL_ADDRESS,
            toAddress: entry.wtcAddress,
            amount: reward,
          });
          update.status = 'rewarded';
          update.rewardAmount = reward;
          update.rewardTxId = result.txid;
          update.apyAtFlush = apy;
          console.log(
            `[StakingQueue] Paid ${reward} WTC reward -> ${entry.wtcAddress}` +
              ` (web entry ${entry.id}, staked ${entry.wtcAmount} WTC @ ${apy}% APY) txid=${result.txid}`,
          );
        } catch (e) {
          update.status = 'failed';
          update.failReason = e && e.message ? e.message : 'unknown';
          console.warn(`[StakingQueue] Failed web entry ${entry.id}:`, update.failReason);
        }
        try {
          await _httpJson('POST', _webApiUrl + '/staking/update-entry', { 'X-Api-Key': _webApiKey }, update);
        } catch (e) {
          console.warn(`[StakingQueue] Failed to report web entry ${entry.id}:`, e && e.message);
        }
      }
    }
  }

  // Reset cached web pending and push combined stats to website
  _webPendingWtc = 0;
  _pushWebStats().catch(() => {});
}
module.exports.flushStakingQueue = flushStakingQueue;

/**
 * Called internally after a new entry is added — flush if threshold met.
 */
async function _maybeFlushByThreshold() {
  if (shouldFlush()) {
    await flushStakingQueue();
  }
}
module.exports._maybeFlushByThreshold = _maybeFlushByThreshold;
