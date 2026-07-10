// SPDX-License-Identifier: MIT
'use strict';
/**
 * wtc-accounts.js — Account state for the WTC native chain
 *
 * Tracks: confirmed balance, unmatured (mining reward) balance, send nonce.
 * Persisted as HMAC-signed JSON so tampering is detected on load.
 *
 * Maturity model (mirrors Bitcoin coinbase maturity):
 *   Mining rewards are credited as "unmatured" and move to "confirmed"
 *   after MATURITY_DEPTH blocks have been built on top.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MATURITY_DEPTH = 100; // blocks before mining rewards spendable

class Accounts {
  /**
   * @param {{ dataDir: string, signingSecret: string }} opts
   */
  constructor({ dataDir, signingSecret }) {
    this._file = path.join(dataDir, 'wtc-accounts.json');
    this._secret = signingSecret;
    this._bal = {}; // address → { confirmed, unmatured: [{amount, matureAtHeight}], nonce }
    this._load();
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  _hmac(data) {
    return crypto.createHmac('sha256', this._secret).update(JSON.stringify(data)).digest('hex');
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      const { _sig: savedSig, ...data } = raw;
      if (savedSig !== this._hmac(data)) {
        console.warn('[Accounts] HMAC mismatch - starting fresh (file may have been tampered)');
        return;
      }
      this._bal = data.balances || {};
    } catch (_) {
      // Corrupt or missing file — start with empty state.
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const data = { balances: this._bal };
      fs.writeFileSync(this._file, JSON.stringify({ ...data, _sig: this._hmac(data) }, null, 2), 'utf8');
    } catch (_) {
      /* non-fatal */
    }
  }

  _acc(addr) {
    if (!this._bal[addr]) this._bal[addr] = { confirmed: 0, unmatured: [], nonce: 0 };
    return this._bal[addr];
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Get balance breakdown for an address.
   * @returns {{ confirmed, unmatured, total, nonce }}
   */
  getBalance(addr) {
    const a = this._acc(addr);
    const unmaturedTotal = a.unmatured.reduce((s, u) => s + u.amount, 0);
    return {
      confirmed: a.confirmed,
      unmatured: unmaturedTotal,
      total: a.confirmed + unmaturedTotal,
      nonce: a.nonce,
    };
  }

  /**
   * Credit an amount to an address.
   * @param {string} addr
   * @param {number} amount
   * @param {{ mature?: boolean, atHeight?: number }} opts
   *   mature=true  → added directly to confirmed balance (genesis premine)
   *   mature=false → added to unmatured queue, matures at atHeight + MATURITY_DEPTH
   */
  credit(addr, amount, opts = {}) {
    if (amount <= 0) return;
    const a = this._acc(addr);
    if (opts.mature !== false) {
      a.confirmed += amount;
    } else {
      a.unmatured.push({ amount, matureAtHeight: (opts.atHeight || 0) + MATURITY_DEPTH });
    }
    this._save();
  }

  /**
   * Atomic transfer of amount+fee from sender. Fee is collected by applyBlock and
   * credited to the block proposer alongside the block reward.
   * Throws if sender has insufficient confirmed balance.
   * @returns {number} fee collected
   */
  transfer(from, to, amount, fee = 0) {
    const total = amount + fee;
    const fromAcc = this._acc(from);
    if (fromAcc.confirmed < total - 1e-9) {
      throw new Error(`Insufficient: ${fromAcc.confirmed.toFixed(8)} < ${total.toFixed(8)}`);
    }
    fromAcc.confirmed = Math.max(0, fromAcc.confirmed - total);
    fromAcc.nonce++;
    this._acc(to).confirmed += amount;
    this._save();
    return fee;
  }

  /**
   * Move unmatured credits that have reached maturity into confirmed balance.
   * Called once per block with the new tip height.
   */
  applyMaturity(height) {
    let changed = false;
    for (const a of Object.values(this._bal)) {
      const now = a.unmatured.filter((u) => height >= u.matureAtHeight);
      if (now.length > 0) {
        a.confirmed += now.reduce((s, u) => s + u.amount, 0);
        a.unmatured = a.unmatured.filter((u) => height < u.matureAtHeight);
        changed = true;
      }
    }
    if (changed) this._save();
  }

  /**
   * Apply all effects of a committed block:
   *  1. Execute transactions (transfer from→to, debit fee)
   *  2. Credit accumulated transaction fees to the block proposer (mature)
   *  3. Credit mining rewards (unmatured unless genesis height=0)
   *  4. Run maturity sweep for this block's height
   */
  applyBlock(block) {
    const proposer = block.proposer || '';
    let totalFees = 0;

    // 1. Transactions — fees are debited from senders but not yet credited
    for (const tx of block.transactions || []) {
      try {
        // Skip NFT transactions — handled by NftStore, not by Accounts
        if (tx.type && tx.type !== 'transfer') continue;
        // Strict sequential nonce check: prevents a same-nonce double-spend
        // where two txs with identical nonces both pass the pre-block balance
        // filter but are both included in a single block.
        const fromAcc = this._acc(tx.from);
        if (typeof tx.nonce === 'number' && tx.nonce !== fromAcc.nonce) {
          console.warn(`[Accounts] tx ${tx.id} skipped: nonce mismatch (expected ${fromAcc.nonce}, got ${tx.nonce})`);
          continue;
        }
        this.transfer(tx.from, tx.to, tx.amount, tx.fee || 0);
        totalFees += tx.fee || 0;
      } catch (e) {
        console.warn(`[Accounts] tx ${tx.id} skipped: ${e.message}`);
      }
    }

    // Credit accumulated transaction fees to the block proposer as mature
    // (immediately spendable — they were debited from confirmed balances).
    if (totalFees > 0 && proposer) {
      this.credit(proposer, totalFees, { mature: true });
    }

    // 2. Mining rewards
    const isMatureCredit = block.height === 0; // genesis premine is immediately mature
    for (const [addr, amount] of Object.entries(block.rewardAddresses || {})) {
      if (amount > 0) {
        this.credit(addr, amount, { mature: isMatureCredit, atHeight: block.height });
      }
    }

    // 3. Maturity sweep
    this.applyMaturity(block.height);
  }

  /**
   * Deterministic SHA-256 hash of current confirmed balances + nonces.
   * Included as stateRoot in each block header.
   */
  stateHash() {
    const entries = Object.entries(this._bal)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([addr, a]) => [addr, a.confirmed, a.unmatured.reduce((s, u) => s + u.amount, 0), a.nonce]);
    return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  }

  /**
   * Deep-copy of all account balances (for export/debug).
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this._bal));
  }

  /** Restore account state from a prior snapshot (deep copy). */
  restoreSnapshot(snap) {
    this._bal = JSON.parse(JSON.stringify(snap));
    this._save();
  }

  /**
   * Deterministically rebuild account state from a full chain sequence.
   * Throws on invalid transaction/nonce/balance mismatches.
   * Historical mainnet chains may carry legacy stateRoot values, so callers
   * can opt into tolerating stateRoot mismatches during replay.
   */
  rebuildFromBlocks(blocks, opts = {}) {
    if (!Array.isArray(blocks)) throw new Error('rebuildFromBlocks requires an array of blocks');
    const allowLegacyStateRootMismatch = !!(opts && opts.allowLegacyStateRootMismatch);

    const next = {}; // address -> { confirmed, unmatured: [{amount,matureAtHeight}], nonce }
    const legacyStateRootMismatches = [];
    const acc = (addr) => {
      if (!next[addr]) next[addr] = { confirmed: 0, unmatured: [], nonce: 0 };
      return next[addr];
    };

    const applyMaturity = (height) => {
      for (const a of Object.values(next)) {
        const matured = a.unmatured.filter((u) => height >= u.matureAtHeight);
        if (matured.length > 0) {
          a.confirmed += matured.reduce((s, u) => s + u.amount, 0);
          a.unmatured = a.unmatured.filter((u) => height < u.matureAtHeight);
        }
      }
    };

    const stateHashFor = () => {
      const entries = Object.entries(next)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([addr, a]) => [addr, a.confirmed, a.unmatured.reduce((s, u) => s + u.amount, 0), a.nonce]);
      return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
    };

    for (const block of blocks) {
      if (block.stateRoot) {
        const gotPreState = stateHashFor();
        if (gotPreState !== block.stateRoot) {
          if (!allowLegacyStateRootMismatch) {
            throw new Error(`stateRoot mismatch at height ${block.height}`);
          }
          legacyStateRootMismatches.push({
            height: block.height,
            expected: gotPreState,
            actual: block.stateRoot,
          });
        }
      }

      for (const tx of block.transactions || []) {
        if (!tx || typeof tx !== 'object') throw new Error(`Invalid tx in block ${block.height}`);
        const from = String(tx.from || '');
        const to = String(tx.to || '');
        const amount = Number(tx.amount) || 0;
        const fee = Number(tx.fee) || 0;
        const nonce = Number(tx.nonce);
        // Skip NFT transactions in account rebuild — handled by NftStore
        if (tx.type && tx.type !== 'transfer') continue;
        if (!from || !to || !Number.isFinite(amount) || amount <= 0 || !Number.isFinite(fee) || fee < 0) {
          throw new Error(`Invalid tx fields in block ${block.height}`);
        }

        const fromAcc = acc(from);
        if (!Number.isFinite(nonce) || nonce !== fromAcc.nonce) {
          throw new Error(`Nonce mismatch for tx ${tx.id || 'unknown'} in block ${block.height}`);
        }
        const total = amount + fee;
        if (fromAcc.confirmed + 1e-9 < total) {
          throw new Error(`Insufficient balance for tx ${tx.id || 'unknown'} in block ${block.height}`);
        }
        fromAcc.confirmed = Math.max(0, fromAcc.confirmed - total);
        fromAcc.nonce += 1;
        acc(to).confirmed += amount;
      }

      const isMatureCredit = block.height === 0;
      for (const [addr, amountRaw] of Object.entries(block.rewardAddresses || {})) {
        const amount = Number(amountRaw) || 0;
        if (amount <= 0) continue;
        const a = acc(addr);
        if (isMatureCredit) {
          a.confirmed += amount;
        } else {
          a.unmatured.push({ amount, matureAtHeight: block.height + MATURITY_DEPTH });
        }
      }

      applyMaturity(block.height);
    }

    this._bal = next;
    this._save();
    return { legacyStateRootMismatches };
  }
}

module.exports = { Accounts, MATURITY_DEPTH };
