// SPDX-License-Identifier: MIT
'use strict';
/**
 * wtc-chain.js — Block structure, chain persistence, and reward schedule
 *
 * Storage: append-only NDJSON log (one block per line) at {dataDir}/wtc-chain.ndjson
 * Each block line is independently verifiable by its hash.
 *
 * Reward schedule (Proof-of-Energy halving):
 *   Max supply:    21,000,000 WTC across 21 tiers of 1,000,000 WTC each.
 *   Tier 0:        1,000,000 WTC premined to team wallets (genesis block).
 *   Tier 1 onward: Mined by energy miners, starting at 500 WTC/block,
 *                  halving with each tier until tier 20 (~0.95 WTC/block).
 *
 * Block structure:
 *   height          — chain position (0 = genesis)
 *   prevHash        — SHA-256 hash of parent block's canonical fields
 *   hash            — SHA-256 hash of this block's canonical fields
 *   timestamp       — Unix ms when block was proposed
 *   proposer        — wtc1... address of block proposer (or "genesis")
 *   energyWh        — net energy contributed this round (Watt-hours)
 *   proofCommitment — energy proof commitment hash
 *   attestationVersion — versioned peer-attestation schema flag
 *   peerProbeVerified  — whether a peer attested the miner's probe
 *   probeReceipt       — signed verifier receipt stored directly on chain
 *   txsHash         — SHA-256 of sorted transaction IDs
 *   transactions    — array of transfer transactions included in block
 *   rewardTotal     — total WTC newly issued this block
 *   rewardAddresses — { address: amount } distribution of block reward
 *   stateRoot       — SHA-256 of account state after applying this block
 *   votes           — { voterAddress: sigHex } BFT vote set
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { MATURITY_DEPTH } = require('./wtc-accounts');
const { normalizeBlockProbeAttestation, validateBlockProbeAttestation } = require('./probe-attestation');
const { txHash, verifySignature: wtcVerify } = require('./wtc-address');

const SUPPLY_PER_TIER = 1_000_000;
const MAX_TIERS = 21;
const BASE_REWARD = 1000;
const GENESIS_PREMINE = 1_000_000; // tier 0 — premined at height 0

/**
 * Block reward for a given height.
 *   height 0 → 0 (genesis, premine handled separately)
 *   height 1+ → tier 1 schedule (halving per tier, starting at 500 WTC/block)
 *
 * Blocks per tier k (k >= 1):  SUPPLY_PER_TIER / (BASE_REWARD / 2^k)
 *   tier 1:  2,000 blocks × 500 WTC  = 1,000,000 WTC
 *   tier 2:  4,000 blocks × 250 WTC  = 1,000,000 WTC
 *   ...
 *   tier 20: ~2.1M blocks × ~0.00095 WTC
 */
function rewardForHeight(height) {
  if (height <= 0) return 0;
  let remaining = height - 1; // 0-indexed counter within tier 1+
  for (let tier = 1; tier < MAX_TIERS; tier++) {
    const reward = BASE_REWARD / Math.pow(2, tier);
    const blocksThisTier = Math.round(SUPPLY_PER_TIER / reward);
    if (remaining < blocksThisTier) return reward;
    remaining -= blocksThisTier;
  }
  return 0; // supply exhausted
}

/**
 * Minimum energy (Wh) required to produce a block at the given height.
 *   height 0 → 0 (genesis, no energy required)
 *   height 1+ → energyPerCoin × reward  where energyPerCoin = 20_000 × 2^(tier-1)
 */
function energyForHeight(height) {
  if (height <= 0) return 0;
  const reward = rewardForHeight(height);
  if (reward <= 0) return 0;
  // Derive tier from reward: tier = log2(BASE_REWARD / reward)
  const tier = Math.round(Math.log2(BASE_REWARD / reward));
  const energyPerCoin = 20_000 * Math.pow(2, tier - 1);
  return energyPerCoin * reward;
}

/**
 * Canonical block hash — SHA-256 over a sorted subset of fields.
 * Votes are NOT included so the hash is stable before voting completes.
 */
function computeBlockHash(block) {
  const attestation = normalizeBlockProbeAttestation(block);
  const canon = {
    height: block.height,
    prevHash: block.prevHash,
    timestamp: block.timestamp,
    proposer: block.proposer,
    energyWh: block.energyWh,
    proofCommitment: block.proofCommitment || '',
    txsHash: block.txsHash || '',
    rewardTotal: block.rewardTotal,
    stateRoot: block.stateRoot || '',
  };
  if (attestation.attestationVersion >= 1) {
    canon.attestationVersion = attestation.attestationVersion;
    canon.peerProbeVerified = attestation.peerProbeVerified;
    canon.probeReceipt = attestation.probeReceipt;
  }
  // Raw CPU proof included in hash so consensus re-verification is binding
  if (block.cpuSpeedInitialSeed) {
    canon.cpuSpeedInitialSeed = block.cpuSpeedInitialSeed;
  }
  if (block.cpuSpeedProof) {
    canon.cpuSpeedProof = block.cpuSpeedProof;
  }
  if (block.memProof) {
    canon.memProof = block.memProof;
  }
  if (block.memProofSeed) {
    canon.memProofSeed = block.memProofSeed;
  }
  if (block.gpuProof) {
    canon.gpuProof = block.gpuProof;
  }
  if (block.gpuProofSeed) {
    canon.gpuProofSeed = block.gpuProofSeed;
  }
  // nftsRoot only included when non-empty so old block hashes remain stable
  if (block.nftsRoot) {
    canon.nftsRoot = block.nftsRoot;
  }
  return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

/**
 * Hash of the sorted list of transaction IDs — included in block header
 * so transaction contents are committed.
 */
function computeTxsHash(txs = []) {
  const ids = (txs || []).map((t) => t.id).sort();
  return crypto.createHash('sha256').update(JSON.stringify(ids)).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────

class Chain {
  /**
   * @param {{ dataDir: string, signingSecret: string }} opts
   */
  constructor({ dataDir, signingSecret }) {
    this._file = path.join(dataDir, 'wtc-chain.ndjson');
    this._secret = signingSecret;
    this._blocks = []; // in-memory ordered list
    this._byHash = {}; // hash → block (fast lookup)
    this._load();
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  /** HMAC-SHA256 of the full block object (used as per-line tamper seal). */
  _hmac(block) {
    return crypto.createHmac('sha256', this._secret).update(JSON.stringify(block)).digest('hex');
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const lines = fs.readFileSync(this._file, 'utf8').trim().split('\n').filter(Boolean);

      let needsMigration = false;
      for (const line of lines) {
        try {
          const stored = JSON.parse(line);
          const { _sig, ...block } = stored;

          const expectedHash = computeBlockHash(block);
          if (block.hash !== expectedHash) {
            console.warn(`[Chain] Hash mismatch at height ${block.height} - chain truncated`);
            break;
          }

          if (_sig) {
            const expected = this._hmac(block);
            if (!crypto.timingSafeEqual(Buffer.from(_sig, 'hex'), Buffer.from(expected, 'hex'))) {
              console.warn(`[Chain] HMAC tamper detected at height ${block.height} - chain truncated`);
              break;
            }
          } else {
            // Legacy block without signature — accept once, rewrite below.
            needsMigration = true;
          }

          this._blocks.push(block);
          this._byHash[block.hash] = block;
        } catch (_) {
          console.warn('[Chain] Corrupt line - chain truncated');
          break;
        }
      }
      if (this._blocks.length > 0) {
        console.log(`[Chain] Loaded ${this._blocks.length} blocks, height=${this._blocks.length - 1}`);
      }
      // One-time migration: rewrite the file with HMAC signatures on every line.
      if (needsMigration && this._blocks.length > 0) {
        this._rewriteFile();
        console.log('[Chain] Migrated chain file to HMAC-signed format.');
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Chain] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  /** Rewrite the entire chain file (used for migration and tamper recovery). */
  _rewriteFile() {
    try {
      const lines = this._blocks.map((b) => JSON.stringify({ ...b, _sig: this._hmac(b) }));
      fs.writeFileSync(this._file, lines.join('\n') + '\n', 'utf8');
    } catch (e) {
      console.warn('[Chain] Failed to rewrite chain file:', e && e.message);
    }
  }

  _writeLine(block) {
    fs.mkdirSync(path.dirname(this._file), { recursive: true });
    fs.appendFileSync(this._file, JSON.stringify({ ...block, _sig: this._hmac(block) }) + '\n', 'utf8');
  }

  /** Clear all blocks and truncate the chain file. */
  reset() {
    this._blocks = [];
    this._byHash = {};
    try {
      fs.writeFileSync(this._file, '', 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Chain] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  // ─── Chain queries ────────────────────────────────────────────────────────

  /** @returns {number} Current tip height (-1 if chain is empty) */
  getHeight() {
    return this._blocks.length - 1;
  }

  /** @returns {object|null} Most recent block */
  getTip() {
    return this._blocks[this._blocks.length - 1] || null;
  }

  /** @returns {object|null} Block at a given height */
  getBlock(height) {
    return this._blocks[height] || null;
  }

  /** @returns {object|null} Block with a given hash */
  getBlockByHash(hash) {
    return this._byHash[hash] || null;
  }

  /** @returns {object[]} Deep copy of chain blocks in height order. */
  getAllBlocks() {
    return JSON.parse(JSON.stringify(this._blocks));
  }

  /**
   * Headers range for peer sync.
   * @param {number} fromHeight inclusive
   * @param {number} limit max headers
   */
  getHeaders(fromHeight = 0, limit = 200) {
    const start = Math.max(0, Math.floor(Number(fromHeight) || 0));
    const max = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 200)));
    const out = [];
    for (let h = start; h < this._blocks.length && out.length < max; h++) {
      const b = this._blocks[h];
      out.push({
        height: b.height,
        hash: b.hash,
        prevHash: b.prevHash,
        timestamp: b.timestamp,
        rewardTotal: b.rewardTotal,
        stateRoot: b.stateRoot || '',
      });
    }
    return out;
  }

  /**
   * Blocks range for peer sync.
   * @param {number} fromHeight inclusive
   * @param {number} limit max blocks
   */
  getBlocks(fromHeight = 0, limit = 100) {
    const start = Math.max(0, Math.floor(Number(fromHeight) || 0));
    const max = Math.min(500, Math.max(1, Math.floor(Number(limit) || 100)));
    const out = [];
    for (let h = start; h < this._blocks.length && out.length < max; h++) {
      out.push(JSON.parse(JSON.stringify(this._blocks[h])));
    }
    return out;
  }

  /** Block reward WTC for the given height */
  rewardForHeight(h) {
    return rewardForHeight(h);
  }

  /** Block reward WTC for the next block to be produced */
  nextBlockReward() {
    return rewardForHeight(this._blocks.length);
  }

  /** SHA-256 of canonical block fields */
  computeBlockHash(b) {
    return computeBlockHash(b);
  }

  // ─── Block production ─────────────────────────────────────────────────────

  /**
   * Create the genesis block and persist it.
   * Idempotent — returns existing genesis if the chain already has blocks.
   *
   * @param {{ teamWallets: Array<{address:string,amount:number}>, timestamp?: number }} opts
   */
  genesis({ teamWallets, timestamp = Date.now() }) {
    if (this._blocks.length > 0) return this._blocks[0];

    let total = 0;
    const rewardAddresses = {};
    for (const { address, amount } of teamWallets) {
      rewardAddresses[address] = (rewardAddresses[address] || 0) + amount;
      total += amount;
    }
    if (Math.abs(total - GENESIS_PREMINE) > 0.001) {
      throw new Error(`Genesis premine must equal ${GENESIS_PREMINE} WTC (got ${total})`);
    }

    const block = {
      height: 0,
      prevHash: '0'.repeat(64),
      timestamp,
      proposer: 'genesis',
      energyWh: 0,
      proofCommitment: '',
      txsHash: computeTxsHash([]),
      transactions: [],
      rewardTotal: GENESIS_PREMINE,
      rewardAddresses,
      stateRoot: '',
      votes: {},
      hash: '',
    };
    block.hash = computeBlockHash(block);
    this._blocks.push(block);
    this._byHash[block.hash] = block;
    this._writeLine(block);
    return block;
  }

  /**
   * Build an unsigned block proposal at the next height.
   * The returned block needs to go through BFT voting before being appended.
   *
   * @param {{ proposer, energyWh, proofCommitment, peerProbeVerified?, probeReceipt?, probesAnswered?, transactions?, rewardAddresses, stateRoot?, cpuSpeedInitialSeed?, cpuSpeedProof?, memProof?, memProofSeed?, gpuProof?, gpuProofSeed? }} opts
   */
  buildBlock({
    proposer,
    energyWh,
    proofCommitment,
    peerProbeVerified = false,
    probeReceipt = null,
    probesAnswered = 0,
    transactions = [],
    rewardAddresses,
    stateRoot = '',
    nftsRoot = '',
    cpuSpeedInitialSeed = 0,
    cpuSpeedProof = '',
    memProof = '',
    memProofSeed = 0,
    gpuProof = '',
    gpuProofSeed = 0,
  }) {
    const height = this._blocks.length;
    const tip = this.getTip();
    const prevHash = tip ? tip.hash : '0'.repeat(64);
    const reward = rewardForHeight(height);
    const txsHash = computeTxsHash(transactions);

    const block = {
      height,
      prevHash,
      timestamp: Date.now(),
      proposer,
      energyWh: energyWh || 0,
      proofCommitment: proofCommitment || '',
      attestationVersion: 1,
      peerProbeVerified: !!peerProbeVerified,
      probeReceipt: normalizeBlockProbeAttestation({
        attestationVersion: 1,
        peerProbeVerified,
        probeReceipt,
      }).probeReceipt,
      probesAnswered: Math.max(0, Math.floor(Number(probesAnswered) || 0)),
      cpuSpeedInitialSeed: Number(cpuSpeedInitialSeed) || 0,
      cpuSpeedProof: String(cpuSpeedProof || ''),
      memProof: String(memProof || ''),
      memProofSeed: Number(memProofSeed) || 0,
      gpuProof: String(gpuProof || ''),
      gpuProofSeed: Number(gpuProofSeed) || 0,
      txsHash,
      transactions,
      rewardTotal: reward,
      rewardAddresses: rewardAddresses || (reward > 0 ? { [proposer]: reward } : {}),
      stateRoot,
      nftsRoot,
      votes: {},
      hash: '',
    };
    block.hash = computeBlockHash(block);
    return block;
  }

  /**
   * Validate and append a BFT-committed block to the chain.
   * Throws on any inconsistency so the caller can decide what to do.
   *
   * @param {object} block — must already have correct hash and votes
   */
  append(block) {
    const expectedHeight = this._blocks.length;
    if (block.height !== expectedHeight) {
      throw new Error(`append: expected height ${expectedHeight}, got ${block.height}`);
    }
    const tip = this.getTip();
    if (tip && block.prevHash !== tip.hash) {
      throw new Error(`append: prevHash mismatch at height ${block.height}`);
    }
    const expectedHash = computeBlockHash(block);
    if (block.hash !== expectedHash) {
      throw new Error(`append: block hash mismatch at height ${block.height}`);
    }
    const attestationCheck = validateBlockProbeAttestation(block, {
      expectedWorkerId: block.proposer,
      expectedRoundId: block.height,
    });
    if (!attestationCheck.ok) {
      throw new Error(`append: ${attestationCheck.reason}`);
    }

    this._blocks.push(block);
    this._byHash[block.hash] = block;
    this._writeLine(block);
    return block;
  }

  /**
   * Validate a full candidate chain in-memory.
   * Returns { ok, reason? }.
   */
  validateSequence(blocks) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      return { ok: false, reason: 'candidate chain is empty' };
    }
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (!b || typeof b !== 'object') return { ok: false, reason: `invalid block at index ${i}` };
      if (b.height !== i) return { ok: false, reason: `height mismatch at index ${i}` };
      const expectedPrev = i === 0 ? '0'.repeat(64) : blocks[i - 1].hash;
      if (b.prevHash !== expectedPrev) return { ok: false, reason: `prevHash mismatch at height ${i}` };
      if (b.hash !== computeBlockHash(b)) return { ok: false, reason: `hash mismatch at height ${i}` };
      if (i > 0) {
        const attestationCheck = validateBlockProbeAttestation(b, {
          expectedWorkerId: b.proposer,
          expectedRoundId: b.height,
        });
        if (!attestationCheck.ok) {
          return { ok: false, reason: `probe attestation invalid at height ${i}: ${attestationCheck.reason}` };
        }
      }

      if (i === 0) {
        if (Math.abs((Number(b.rewardTotal) || 0) - GENESIS_PREMINE) > 0.001) {
          return { ok: false, reason: 'genesis reward mismatch' };
        }
      } else {
        const expectedReward = rewardForHeight(i);
        if (Math.abs((Number(b.rewardTotal) || 0) - expectedReward) > 0.001) {
          return { ok: false, reason: `reward mismatch at height ${i}` };
        }
      }

      let rewardSum = 0;
      for (const amount of Object.values(b.rewardAddresses || {})) {
        const n = Number(amount) || 0;
        if (n < 0) return { ok: false, reason: `negative reward in rewardAddresses at height ${i}` };
        rewardSum += n;
      }
      if (Math.abs(rewardSum - (Number(b.rewardTotal) || 0)) > 0.001) {
        return { ok: false, reason: `rewardAddresses sum mismatch at height ${i}` };
      }

      if (Array.isArray(b.transactions)) {
        for (let j = 0; j < b.transactions.length; j++) {
          const tx = b.transactions[j];
          if (!tx || typeof tx !== 'object')
            return { ok: false, reason: `invalid tx at index ${j} in block ${b.height}` };
          if (!tx.from || !tx.to || !tx.sig)
            return { ok: false, reason: `tx ${j} missing from/to/sig in block ${b.height}` };
          if (typeof tx.sig.r !== 'string' || typeof tx.sig.s !== 'string')
            return { ok: false, reason: `tx ${j} invalid sig format in block ${b.height}` };
          // Non-standard tx types (nft, governance) use their own sigInput format
          if (tx.type === 'nft_mint' || tx.type === 'nft_transfer' || tx.type === 'governance_result') continue;
          const sigFields = {
            id: tx.id,
            from: tx.from,
            to: tx.to,
            amount: tx.amount,
            fee: tx.fee,
            nonce: tx.nonce,
          };
          if (tx.chainId) {
            sigFields.chainId = tx.chainId;
          }
          const sigInput = JSON.stringify(sigFields);
          if (!wtcVerify(txHash(sigInput), tx.sig, tx.from))
            return { ok: false, reason: `tx ${j} signature mismatch in block ${b.height}` };
        }
      }
    }
    return { ok: true };
  }

  /**
   * Replace local chain with a fully-validated sequence.
   */
  replaceWithBlocks(blocks) {
    const check = this.validateSequence(blocks);
    if (!check.ok) {
      throw new Error(`replaceWithBlocks failed validation: ${check.reason}`);
    }
    this._blocks = blocks.map((b) => JSON.parse(JSON.stringify(b)));
    this._byHash = {};
    for (const b of this._blocks) this._byHash[b.hash] = b;
    this._rewriteFile();
    return this.getHeight();
  }

  // ─── History queries ──────────────────────────────────────────────────────

  /**
   * List transactions involving an address, most-recent first.
   * Also includes mining reward credits as synthetic entries.
   *
   * @param {string}  address
   * @param {number}  count   max results
   */
  listTransactions(address, count = 50) {
    const out = [];
    const tip = this._blocks.length;

    for (let h = tip - 1; h >= 0 && out.length < count; h--) {
      const b = this._blocks[h];

      for (const tx of b.transactions || []) {
        if (tx.from === address || tx.to === address) {
          out.push({
            ...tx,
            category: tx.from === address ? 'send' : 'receive',
            blockHeight: h,
            blockHash: b.hash,
            confirmations: tip - h,
          });
        }
      }

      if (b.rewardAddresses && b.rewardAddresses[address] > 0) {
        out.push({
          id: `reward-${b.hash}`,
          category: 'mine',
          to: address,
          amount: b.rewardAddresses[address],
          blockHeight: h,
          blockHash: b.hash,
          confirmations: tip - h,
          timestamp: b.timestamp,
        });
      }
    }
    return out;
  }

  /**
   * Statistics on blocks mined by an address.
   * Used by the Mining UI to show "mined N coins, M matured".
   */
  getMinedStats(address) {
    const tip = this._blocks.length;
    let totalBlocks = 0;
    let maturedBlocks = 0;
    let totalWTC = 0;
    let maturedWTC = 0;

    for (const b of this._blocks) {
      const amt = b.rewardAddresses && b.rewardAddresses[address];
      if (amt > 0) {
        totalBlocks++;
        totalWTC += amt;
        if (tip - b.height >= MATURITY_DEPTH) {
          maturedBlocks++;
          maturedWTC += amt;
        }
      }
    }

    return {
      address,
      totalBlocks,
      maturedBlocks,
      totalWTC,
      maturedWTC,
      unmaturedWTC: totalWTC - maturedWTC,
    };
  }
}

module.exports = {
  Chain,
  rewardForHeight,
  energyForHeight,
  computeBlockHash,
  computeTxsHash,
  GENESIS_PREMINE,
  SUPPLY_PER_TIER,
  MAX_TIERS,
  BASE_REWARD,
};
