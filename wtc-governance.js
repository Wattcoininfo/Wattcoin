// SPDX-License-Identifier: MIT
'use strict';
/**
 * wtc-governance.js — Wattcoin on-chain governance for Vortex NFT holders
 *
 * Tracks proposals (PIPs) and votes with the same HMAC-signed JSON persistence
 * pattern as wtc-nfts.js / wtc-accounts.js.
 *
 * Proposals are distributed via P2P gossip (HTTP fan-out to peers).
 * When a proposal passes quorum, a governance_result transaction is created
 * and mined into a block, making the outcome immutable.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { txHash, verifySignature } = require('./wtc-address');

const VOTE_WEIGHTS = { gold: 5, silver: 3, bronze: 1 };
const TIER_RANK = { gold: 3, silver: 2, bronze: 1 };

const PASS_THRESHOLD = 71; // Simple majority of 140 total voting power
const MAX_VOTE_DURATION_MS = 10 * 7 * 24 * 60 * 60 * 1000; // 10 weeks — used as default for on-chain rebuild

function _sortedJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

class GovernanceStore {
  /**
   * @param {{ dataDir: string, signingSecret: string }} opts
   */
  constructor({ dataDir, signingSecret }) {
    this._file = path.join(dataDir, 'wtc-governance.json');
    this._secret = signingSecret;
    this._proposals = {}; // pipId → proposal
    this._nonces = {}; // address → number (for governance_result tx nonces)
    this._load();
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  _save() {
    const raw = _sortedJson({ proposals: this._proposals, nonces: this._nonces });
    const hmac = crypto.createHmac('sha256', this._secret).update(raw).digest('hex');
    fs.writeFileSync(this._file, JSON.stringify({ data: raw, hmac }), 'utf8');
  }

  _load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      if (stored && stored.data && stored.hmac) {
        const expected = crypto.createHmac('sha256', this._secret).update(stored.data).digest('hex');
        if (expected !== stored.hmac) {
          console.warn('[GovernanceStore] HMAC mismatch — ignoring stored file');
          return;
        }
        const parsed = JSON.parse(stored.data);
        this._proposals = parsed.proposals || {};
        this._nonces = parsed.nonces || {};
      }
    } catch (_) {
      void _;
    }
  }

  // ─── Nonce ───────────────────────────────────────────────────────────────

  getNonce(address) {
    return this._nonces[address] || 0;
  }

  _bumpNonce(address) {
    this._nonces[address] = (this._nonces[address] || 0) + 1;
  }

  // ─── Queries ─────────────────────────────────────────────────────────────

  getProposals() {
    return Object.values(this._proposals).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  getProposal(pipId) {
    return this._proposals[pipId] || null;
  }

  getActiveProposals() {
    return this.getProposals().filter((p) => p.status === 'active');
  }

  getVoteTallies(pipId) {
    const p = this._proposals[pipId];
    if (!p) return { for: 0, against: 0, totalPower: 0 };
    return { ...p.voteTallies, totalPower: p.voteTallies.for + p.voteTallies.against };
  }

  getVoterVote(pipId, address) {
    const p = this._proposals[pipId];
    if (!p || !address || !p.votes[address]) return null;
    return p.votes[address];
  }

  hasActiveProposalByAddress(address) {
    return Object.values(this._proposals).some((p) => p.status === 'active' && p.creator === address);
  }

  // ─── Proposal management ─────────────────────────────────────────────────

  /**
   * Add a proposal received from the local user or from a peer.
   * Returns { ok, pipId, isNew }
   */
  addProposal({ pipId, title, description, creator, createdAt, creatorNftId, creatorTier, votingDurationWeeks }) {
    if (this._proposals[pipId]) return { ok: true, pipId, isNew: false };

    if (!pipId || !title || !creator || !createdAt) {
      return { ok: false, error: 'Missing required proposal fields' };
    }

    const weeks = Math.max(2, Math.min(10, Math.floor(Number(votingDurationWeeks) || 10)));
    const durationMs = weeks * 7 * 24 * 60 * 60 * 1000;

    this._proposals[pipId] = {
      pipId,
      title,
      description: description || '',
      creator,
      createdAt,
      creatorNftId: creatorNftId || '',
      creatorTier: creatorTier || 'bronze',
      status: 'active',
      votes: {},
      voteTallies: { for: 0, against: 0 },
      votingDurationWeeks: weeks,
      votingEndsAt: createdAt + durationMs,
    };

    this._save();
    return { ok: true, pipId, isNew: true };
  }

  /**
   * Generate the next pipId.
   * Format: pip-{height}-{index} where height is the current chain height
   * at creation time and index ensures uniqueness.
   */
  static generatePipId(chainHeight) {
    const ts = Date.now();
    const rand = crypto.randomBytes(2).toString('hex');
    return `pip-${chainHeight}-${ts}-${rand}`;
  }

  /**
   * Check whether a proposal has reached passing quorum.
   * Requires ≥PASS_THRESHOLD (71) weighted votes in favor — a simple
   * majority of 140 total possible voting power.
   */
  checkQuorum(pipId) {
    const p = this._proposals[pipId];
    if (!p || p.status !== 'active') return { ok: false, reason: 'not active' };

    if (p.voteTallies.for >= PASS_THRESHOLD) {
      return { ok: true, outcome: 'passed' };
    }

    return { ok: false, reason: `for (${p.voteTallies.for}) < ${PASS_THRESHOLD} needed` };
  }

  /**
   * Mark any active proposal whose voting period has expired.
   * Passed if ≥PASS_THRESHOLD, otherwise rejected.
   * Returns an array of { pipId, outcome, voteTallies, title } for callers
   * that need to submit governance_result transactions.
   */
  closeExpiredProposals() {
    const now = Date.now();
    const expired = [];

    for (const p of Object.values(this._proposals)) {
      if (p.status !== 'active') continue;
      if (now < p.votingEndsAt) continue;

      const outcome = p.voteTallies.for >= PASS_THRESHOLD ? 'passed' : 'rejected';
      p.status = outcome;
      expired.push({
        pipId: p.pipId,
        outcome,
        voteTallies: { for: p.voteTallies.for, against: p.voteTallies.against },
        title: p.title,
      });
    }

    if (expired.length > 0) this._save();
    return expired;
  }

  // ─── Voting ──────────────────────────────────────────────────────────────

  /**
   * Record a vote received locally or from a peer.
   * Allows vote changes (previous power is subtracted, new power added).
   */
  addVote(pipId, { voter, power, nftTier, vote, signature, timestamp: voteTimestamp }) {
    const p = this._proposals[pipId];
    if (!p) return { ok: false, error: 'Proposal not found' };
    if (p.status !== 'active') return { ok: false, error: 'Proposal is not active' };
    if (!voter || !vote || !power) return { ok: false, error: 'Missing vote fields' };
    if (vote !== 'for' && vote !== 'against') return { ok: false, error: 'Invalid vote value' };

    const existing = p.votes[voter];
    const prevVote = existing ? existing.vote : null;
    const prevPower = existing ? existing.power : 0;

    if (existing) {
      p.voteTallies[prevVote] -= prevPower;
    }

    p.votes[voter] = {
      voter,
      power,
      nftTier,
      vote,
      timestamp: voteTimestamp || Date.now(),
      signature: signature || '',
    };
    p.voteTallies[vote] += power;

    this._save();
    return { ok: true, isNew: !existing, changed: existing && existing.vote !== vote };
  }

  // ─── Blockchain integration ──────────────────────────────────────────────

  /**
   * Build an unsigned governance_result transaction.
   * Caller must set tx.sig after signing.
   */
  static buildGovernanceResultTx({ pipId, outcome, from, nonce, voteTallies, title }) {
    const timestamp = Date.now();
    const govData = { pipId, outcome, title: title || '', voteTallies, timestamp };
    const id = crypto
      .createHash('sha256')
      .update(_sortedJson({ type: 'governance_result', from, nonce, governanceData: govData }))
      .digest('hex');

    return {
      id,
      type: 'governance_result',
      from,
      to: from,
      amount: 0,
      fee: 0,
      nonce,
      governanceData: govData,
      sig: null,
    };
  }

  /**
   * Called during consensus._commit() — processes governance_result transactions
   * in a committed block and marks proposals as recorded on-chain.
   */
  applyBlock(block) {
    let changed = false;

    for (const tx of block.transactions || []) {
      if (!tx || tx.type !== 'governance_result') continue;
      if (!tx.governanceData) continue;

      const { pipId, outcome, voteTallies } = tx.governanceData;
      const p = this._proposals[pipId];
      if (!p) {
        console.warn(`[GovernanceStore] block recorded unknown proposal ${pipId} — creating record`);
        this._proposals[pipId] = {
          pipId,
          title: tx.governanceData.title || '',
          description: '',
          creator: tx.from || '',
          createdAt: tx.governanceData.timestamp || block.timestamp,
          status: outcome === 'passed' ? 'passed' : 'rejected',
          votes: {},
          voteTallies: voteTallies || { for: 0, against: 0 },
          recordedAtHeight: block.height,
          recordedAtHash: block.hash,
          votingDurationWeeks: 10,
          votingEndsAt: (tx.governanceData.timestamp || block.timestamp) + MAX_VOTE_DURATION_MS,
        };
        this._bumpNonce(tx.from);
        changed = true;
        continue;
      }

      if (p.status === 'active') {
        p.status = outcome === 'passed' ? 'passed' : 'rejected';
        p.recordedAtHeight = block.height;
        p.recordedAtHash = block.hash;
        this._bumpNonce(tx.from);
        changed = true;
        console.log(`[GovernanceStore] Proposal ${pipId} recorded on-chain at height ${block.height} as ${outcome}`);
      }
    }

    if (changed) this._save();
  }

  /**
   * Full deterministic rebuild from a sequence of blocks.
   * Used after chain sync/rollback.
   */
  rebuildFromBlocks(blocks) {
    this._proposals = {};
    this._nonces = {};
    for (const block of blocks || []) {
      this.applyBlock(block);
    }
    this._save();
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  /**
   * Validate a governance_result transaction for mempool inclusion.
   */
  validateTx(tx) {
    if (!tx || tx.type !== 'governance_result') return false;
    if (!tx.from || !tx.to || !tx.sig) return false;
    if (!tx.governanceData || !tx.governanceData.pipId || !tx.governanceData.outcome) return false;

    const sigInput = _sortedJson({
      id: tx.id,
      type: tx.type,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      fee: tx.fee,
      nonce: tx.nonce,
      governanceData: tx.governanceData,
    });

    try {
      const hash = txHash(sigInput);
      return verifySignature(hash, tx.sig, tx.from);
    } catch (_) {
      return false;
    }
  }
}

module.exports = { GovernanceStore, VOTE_WEIGHTS, TIER_RANK };
