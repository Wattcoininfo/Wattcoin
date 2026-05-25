// SPDX-License-Identifier: MIT
'use strict';
/**
 * wtc-mempool.js — Pending transaction pool
 *
 * In-memory only.  Transactions are removed when a block that includes them
 * is committed to the chain.
 *
 * Transaction structure:
 *   id        — SHA-256 of (from, to, amount, fee, nonce, timestamp)
 *   from      — sender wtc1... address
 *   to        — recipient wtc1... address
 *   amount    — WTC to send (> 0)
 *   fee       — WTC miner tip (>= 0, optional)
 *   nonce     — sender's next expected nonce (prevents replay)
 *   timestamp — Unix ms when tx was built
 *   sig       — { r, s, v } ECDSA signature over tx hash (set after signing)
 *   addedAt   — Unix ms when added to pool (not signed, internal bookkeeping)
 */

const crypto = require('crypto');

const MEMPOOL_MAX_SIZE = 5000;
const MEMPOOL_NFT_MAX_SLOTS = 4000; // reserve 20% of slots for coin txs
const MAX_FUTURE_DRIFT_MS = 2 * 60_000;
const MIN_RELAY_FEE = 0.01;
const MIN_RELAY_AMOUNT = 0.0001;
class Mempool {
  constructor() {
    this._txs = new Map(); // id → tx
  }

  /** Count how many NFT transactions are currently in the pool. */
  _nftCount() {
    let count = 0;
    for (const tx of this._txs.values()) {
      if (tx.type === 'nft_mint' || tx.type === 'nft_transfer') count++;
    }
    return count;
  }

  // ─── Write operations ─────────────────────────────────────────────────────

  /**
   * Add a transaction to the pool.
   * Returns { ok: true } on success, { ok: false, code, message } on failure.
   */
  add(tx) {
    if (!tx || typeof tx !== 'object') {
      return { ok: false, code: 'INVALID', message: 'transaction must be an object' };
    }
    if (!tx.id) {
      return { ok: false, code: 'MISSING_ID', message: 'transaction id required' };
    }
    if (this._txs.has(tx.id)) {
      return { ok: false, code: 'DUPLICATE', message: `tx ${tx.id.slice(0, 12)} already in pool` };
    }

    // ── NFT transactions bypass coin amount/fee validation ────────────────
    if (tx.type === 'nft_mint' || tx.type === 'nft_transfer') {
      if (this._nftCount() >= MEMPOOL_NFT_MAX_SLOTS) {
        return { ok: false, code: 'NFT_POOL_FULL', message: `NFT slot limit reached (${MEMPOOL_NFT_MAX_SLOTS})` };
      }
      if (!tx.nftId || typeof tx.nftId !== 'string') {
        return { ok: false, code: 'INVALID_NFT', message: 'nftId required for NFT transactions' };
      }
      if (!tx.from || typeof tx.from !== 'string') {
        return { ok: false, code: 'MISSING_FROM', message: 'from address required' };
      }
      if (!tx.to || typeof tx.to !== 'string') {
        return { ok: false, code: 'MISSING_TO', message: 'to address required' };
      }
      if (!tx.sig || typeof tx.sig !== 'object') {
        return { ok: false, code: 'MISSING_SIG', message: 'signature required' };
      }
      if (typeof tx.nonce !== 'number' || !Number.isInteger(tx.nonce) || tx.nonce < 0) {
        return { ok: false, code: 'INVALID_NONCE', message: 'nonce must be a non-negative integer' };
      }
      if (typeof tx.timestamp !== 'number' || !Number.isFinite(tx.timestamp)) {
        return { ok: false, code: 'INVALID_TIME', message: 'timestamp required' };
      }
      if (this._txs.size >= MEMPOOL_MAX_SIZE) {
        if (!this._evictLowestFee(tx.fee || 0)) {
          return { ok: false, code: 'POOL_FULL', message: 'mempool is full, fee too low' };
        }
      }
      this._txs.set(tx.id, { ...tx, addedAt: Date.now() });
      return { ok: true };
    }

    if (!tx.from || typeof tx.from !== 'string') {
      return { ok: false, code: 'MISSING_FROM', message: 'from address required' };
    }
    if (!tx.to || typeof tx.to !== 'string') {
      return { ok: false, code: 'MISSING_TO', message: 'to address required' };
    }
    if (typeof tx.amount !== 'number' || tx.amount <= 0) {
      return { ok: false, code: 'INVALID_AMOUNT', message: 'amount must be a positive number' };
    }
    if (tx.amount < MIN_RELAY_AMOUNT) {
      return { ok: false, code: 'DUST', message: `amount below relay minimum (${MIN_RELAY_AMOUNT} WTC)` };
    }
    if (typeof tx.fee !== 'number' || tx.fee < MIN_RELAY_FEE) {
      return { ok: false, code: 'FEE_TOO_LOW', message: `fee must be >= ${MIN_RELAY_FEE} WTC` };
    }
    if (typeof tx.nonce !== 'number' || tx.nonce < 0) {
      return { ok: false, code: 'INVALID_NONCE', message: 'nonce must be a non-negative integer' };
    }
    if (!Number.isInteger(tx.nonce)) {
      return { ok: false, code: 'INVALID_NONCE', message: 'nonce must be an integer' };
    }
    if (typeof tx.timestamp !== 'number' || !Number.isFinite(tx.timestamp)) {
      return { ok: false, code: 'INVALID_TIME', message: 'timestamp required' };
    }
    const now = Date.now();
    if (tx.timestamp > now + MAX_FUTURE_DRIFT_MS) {
      return { ok: false, code: 'TIME_IN_FUTURE', message: 'timestamp too far in the future' };
    }
    if (!tx.sig || typeof tx.sig !== 'object') {
      return { ok: false, code: 'MISSING_SIG', message: 'signature object required' };
    }
    if (typeof tx.from === 'string' && typeof tx.nonce === 'number') {
      for (const existing of this._txs.values()) {
        if (existing.from === tx.from && existing.nonce === tx.nonce) {
          return { ok: false, code: 'NONCE_IN_USE', message: `nonce ${tx.nonce} already pending for this sender` };
        }
      }
    }

    if (this._txs.size >= MEMPOOL_MAX_SIZE) {
      if (!this._evictLowestFee(tx.fee)) {
        return { ok: false, code: 'POOL_FULL', message: 'mempool is full, fee too low' };
      }
    }

    this._txs.set(tx.id, { ...tx, addedAt: Date.now() });
    return { ok: true };
  }

  /**
   * Evict the lowest-fee transaction to make room for a higher-fee one.
   * Returns true if eviction succeeded, false if the new fee is too low.
   */
  _evictLowestFee(newFee) {
    let lowestId = null;
    let lowestFee = Infinity;
    for (const [id, existing] of this._txs) {
      const f = existing.fee || 0;
      if (f < lowestFee) {
        lowestFee = f;
        lowestId = id;
      }
    }
    if (newFee > lowestFee) {
      this._txs.delete(lowestId);
      return true;
    }
    return false;
  }

  /** Remove a single transaction by ID. */
  remove(id) {
    this._txs.delete(id);
  }

  /** Remove multiple transactions at once (called after block commit). */
  removeAll(ids) {
    for (const id of ids) this._txs.delete(id);
  }

  // ─── Read operations ──────────────────────────────────────────────────────

  has(id) {
    return this._txs.has(id);
  }
  get(id) {
    return this._txs.get(id) || null;
  }
  size() {
    return this._txs.size;
  }

  /**
   * Return up to maxCount transactions ordered by fee (highest first).
   * Used by the block proposer to choose which transactions to include.
   */
  getTxs(maxCount = 500) {
    return [...this._txs.values()].sort((a, b) => (b.fee || 0) - (a.fee || 0)).slice(0, maxCount);
  }

  // ─── Factory ──────────────────────────────────────────────────────────────

  /**
   * Build a transaction object ready to be signed and added to the pool.
   * The caller must set tx.sig after signing with wtc-address.sign().
   *
   * @param {{ from, to, amount, fee?, nonce }} opts
   * @returns {object} unsigned transaction with id pre-computed
   */
  static buildTx({ from, to, amount, fee = 0, nonce }) {
    const timestamp = Date.now();
    const id = crypto
      .createHash('sha256')
      .update(JSON.stringify({ from, to, amount, fee, nonce, timestamp }))
      .digest('hex');
    return { id, from, to, amount, fee, nonce, timestamp, sig: null };
  }
}

module.exports = { Mempool };
