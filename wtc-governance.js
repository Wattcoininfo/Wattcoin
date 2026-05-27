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
const { GOVERNANCE_WALLET_ADDRESS } = require('./protocol-constants');

const VOTE_WEIGHTS = { gold: 5, silver: 3, bronze: 1 };
const TIER_RANK = { gold: 3, silver: 2, bronze: 1 };

const FALLBACK_PASS_THRESHOLD = 71;
const TOTAL_POSSIBLE_WEIGHT = 140;
const MAX_VOTE_DURATION_MS = 10 * 7 * 24 * 60 * 60 * 1000;
const VOTE_DURATION_DEFAULT_WEEKS = 2;
const VOTE_DURATION_MIN_WEEKS = 2;
const VOTE_DURATION_MAX_WEEKS = 10;

const COMMENT_PERIOD_DEFAULT_WEEKS = 2;
const COMMENT_PERIOD_MIN_WEEKS = 1;
const COMMENT_PERIOD_MAX_WEEKS = 4;

const STATUS_COMMENT = 'in_comment';
const STATUS_ACTIVE = 'active';
const STATUS_PASSED = 'passed';
const STATUS_REJECTED = 'rejected';

// Governance treasury minimum reserve — protects against governance capturing
// the full treasury in a single proposal.  Can be overridden by a subsequent vote.
const GOVERNANCE_MIN_RESERVE = 10000;
const GOVERNANCE_MAX_TRANSFER = 50000;

const IMMUTABLE_PRINCIPLES = [
  {
    id: 'hard_cap',
    label: 'Hard Cap (21,000,000 WTC)',
    keywords: [
      '21,000,000',
      '21 million',
      '21000000',
      'hard cap',
      'total supply',
      'increase supply',
      'dilution',
      'inflate supply',
      'raise the cap',
      'remove the cap',
      'uncap',
      'mint more',
      'additional supply',
      'print wtc',
      'supply increase',
    ],
    description: 'The 21,000,000 WTC hard cap is inviolable. No governance process can modify it.',
    matchMode: 'blocking',
  },
  {
    id: 'energy_law',
    label: 'Energy Law (20 kWh/coin floor, halving schedule, 10 MWh/block)',
    keywords: [
      '20 kwh',
      'energy per coin',
      'tier 1 energy',
      'halving schedule',
      'block reward',
      'energy floor',
      'change the energy',
      'modify tier',
      'remove tier',
      '10 mwh',
      'per-block energy',
      'block energy',
      'energy constant',
      'reduce the energy',
    ],
    description: 'The 20 kWh/coin Tier 1 floor, the halving schedule, and the 10 MWh/block constant are protected.',
    matchMode: 'blocking',
  },
  {
    id: 'tier_structure',
    label: 'Tier Structure (21 tiers, 1M coins each)',
    keywords: [
      '21 tiers',
      'remove a tier',
      'add a tier',
      'merge tiers',
      'change tier count',
      '1,000,000 per tier',
      'coins per tier',
      'restructure tiers',
      'eliminate a tier',
      'extra tier',
    ],
    description: 'The 21-tier structure with 1,000,000 coins per tier is a protocol constant.',
    matchMode: 'blocking',
  },
  {
    id: 'genesis_allocation',
    label: 'Genesis Allocation',
    keywords: [
      'genesis allocation',
      'genesis wallet',
      'reallocate genesis',
      'modify genesis',
      'clawback genesis',
      'seize genesis',
      'redistribute genesis',
      'confiscate genesis',
      'cancel genesis',
    ],
    description: 'Genesis wallet allocations are on-chain and auditable. Post-genesis reallocation is not permitted.',
    matchMode: 'blocking',
  },
  {
    id: 'consensus_mechanism',
    label: 'Proof-of-Energy Consensus',
    keywords: [
      'proof of stake',
      'switch to pos',
      'abandon poe',
      'proof of work',
      'replace consensus',
      'change consensus',
      'remove energy verification',
      'abandon energy',
      'no longer require energy',
      'eliminate energy verification',
    ],
    description:
      'Proof-of-Energy is the fundamental consensus mechanism. The protocol cannot switch to PoS, PoW, or any other mechanism.',
    matchMode: 'blocking',
  },
  {
    id: 'proportional_rewards',
    label: 'Proportional Block Rewards',
    keywords: [
      'lottery rewards',
      'winner takes all',
      'replace proportional',
      'remove proportional',
      'mining pool',
      'pool required',
      'luck-based reward',
    ],
    description:
      'Block rewards must remain proportional to verified energy contribution. No lottery or winner-takes-all model.',
    matchMode: 'blocking',
  },
  {
    id: 'nft_collection_size',
    label: 'NFT Collection (60 NFTs, 140 profit shares)',
    keywords: [
      'additional nft',
      'mint more nft',
      'extra nft',
      'more than 60',
      'increase nft count',
      'dilute nft',
      'additional profit share',
      'reduce profit share',
      'remove profit share',
      'change profit share count',
      'add nft tier',
    ],
    description:
      'The 60-NFT collection is sealed at genesis. No additional minting. 140 total profit shares are fixed.',
    matchMode: 'blocking',
  },
  {
    id: 'nft_voting_weights',
    label: 'NFT Voting Weights (Gold=5, Silver=3, Bronze=1)',
    keywords: [
      'change voting weight',
      'gold vote',
      'silver vote',
      'bronze vote',
      'remove gold voting',
      'remove silver voting',
      'remove bronze voting',
      'equalize voting',
      'change nft voting',
      'voting power change',
      'remove weighted voting',
    ],
    description: 'NFT voting weights are tied to profit-share tiers: Gold=5, Silver=3, Bronze=1. These are immutable.',
    matchMode: 'blocking',
  },
  {
    id: 'governance_threshold',
    label: 'Governance Pass Threshold (simple majority of distributed votes)',
    keywords: [
      'change pass threshold',
      'lower threshold',
      'raise threshold',
      'remove threshold',
      'change quorum',
      'reduce quorum',
      'increase quorum',
      'remove pass threshold',
      'bypass quorum',
    ],
    description: 'The simple-majority-of-distributed-votes pass threshold (floor(N/2)+1) is a protocol constant.',
    matchMode: 'blocking',
  },
  {
    id: 'governance_treasury',
    label: 'Governance Treasury Minimum Reserve (10,000 WTC)',
    keywords: [
      'drain treasury',
      'empty governance',
      'remove reserve',
      'governance minimum',
      'below 10000',
      'drain governance',
      'take all',
      'zero reserve',
      'eliminate reserve',
      'remove minimum reserve',
    ],
    description:
      'Governance treasury transfers must leave at least 10,000 WTC in the governance wallet to ensure continued operations.',
    matchMode: 'blocking',
  },
];

function _sortedJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

function _titleAndDescMatch(text, principle) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return principle.keywords.some((kw) => lower.includes(kw));
}

function _isImmutablePrincipleViolation(title, description) {
  const combined = [title, description].filter(Boolean).join(' ');
  const violations = [];
  for (const principle of IMMUTABLE_PRINCIPLES) {
    if (principle.matchMode === 'blocking' && _titleAndDescMatch(combined, principle)) {
      violations.push(principle);
    }
  }
  return violations;
}

class GovernanceStore {
  /**
   * @param {{ dataDir: string, signingSecret: string, nftStore?: object }} opts
   */
  constructor({ dataDir, signingSecret, nftStore }) {
    this._file = path.join(dataDir, 'wtc-governance.json');
    this._secret = signingSecret;
    this._proposals = {};
    this._nonces = {};
    this._nftStore = nftStore || null;
    this._load();
  }

  /** Calculate the pass threshold based on currently distributed NFT voting power. */
  _getPassThreshold() {
    if (!this._nftStore) return FALLBACK_PASS_THRESHOLD;
    const { totalPower } = this._nftStore.getDistributedVotingPower();
    if (totalPower <= 0) return FALLBACK_PASS_THRESHOLD;
    return Math.floor(totalPower / 2) + 1;
  }

  /** Return current governance status: distributed power, pass threshold, total possible. */
  getGovernanceStatus() {
    const distributed = this._nftStore
      ? this._nftStore.getDistributedVotingPower()
      : { totalPower: TOTAL_POSSIBLE_WEIGHT, distributedCount: 60, totalPossible: TOTAL_POSSIBLE_WEIGHT };
    const passThreshold = this._getPassThreshold();
    return {
      distributedPower: distributed.totalPower,
      distributedCount: distributed.distributedCount,
      totalPossible: distributed.totalPossible,
      passThreshold,
    };
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
    return this.getProposals().filter((p) => p.status === STATUS_ACTIVE);
  }

  getProposalsInCommentPeriod() {
    return this.getProposals().filter((p) => p.status === STATUS_COMMENT);
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
    return Object.values(this._proposals).some(
      (p) => (p.status === STATUS_COMMENT || p.status === STATUS_ACTIVE) && p.creator === address,
    );
  }

  // ─── Immutable Principles ─────────────────────────────────────────────────

  static getImmutablePrinciples() {
    return IMMUTABLE_PRINCIPLES;
  }

  validateProposalContent(title, description) {
    const violations = _isImmutablePrincipleViolation(title, description);
    if (violations.length > 0) {
      return {
        ok: false,
        violations: violations.map((v) => ({ id: v.id, label: v.label, description: v.description })),
        error: `Proposal violates immutable principles: ${violations.map((v) => v.label).join(', ')}`,
      };
    }
    return { ok: true, violations: [] };
  }

  // ─── Proposal management ─────────────────────────────────────────────────

  /**
   * Add a proposal received from the local user or from a peer.
   * Returns { ok, pipId, isNew }
   */
  addProposal({
    pipId,
    title,
    description,
    creator,
    createdAt,
    creatorNftId,
    creatorTier,
    votingDurationWeeks,
    commentPeriodWeeks,
    transferTo,
    transferAmount,
    transferPurpose,
  }) {
    if (this._proposals[pipId]) return { ok: true, pipId, isNew: false };

    if (!pipId || !title || !creator || !createdAt) {
      return { ok: false, error: 'Missing required proposal fields' };
    }

    const principleCheck = this.validateProposalContent(title, description);
    if (!principleCheck.ok) return principleCheck;

    // If this is a governance transfer proposal, validate it
    if (transferTo || transferAmount) {
      const transferCheck = this.validateGovernanceTransfer(transferTo, transferAmount);
      if (!transferCheck.ok) return transferCheck;
    }

    const cWeeks = Math.max(
      COMMENT_PERIOD_MIN_WEEKS,
      Math.min(COMMENT_PERIOD_MAX_WEEKS, Math.floor(Number(commentPeriodWeeks) || COMMENT_PERIOD_DEFAULT_WEEKS)),
    );
    const commentPeriodMs = cWeeks * 7 * 24 * 60 * 60 * 1000;

    const vWeeks = Math.max(
      VOTE_DURATION_MIN_WEEKS,
      Math.min(VOTE_DURATION_MAX_WEEKS, Math.floor(Number(votingDurationWeeks) || VOTE_DURATION_DEFAULT_WEEKS)),
    );
    const voteDurationMs = vWeeks * 7 * 24 * 60 * 60 * 1000;

    const proposal = {
      pipId,
      title,
      description: description || '',
      creator,
      createdAt,
      creatorNftId: creatorNftId || '',
      creatorTier: creatorTier || 'bronze',
      status: STATUS_COMMENT,
      votes: {},
      voteTallies: { for: 0, against: 0 },
      commentPeriodWeeks: cWeeks,
      commentPeriodEndsAt: createdAt + commentPeriodMs,
      votingDurationWeeks: vWeeks,
      votingEndsAt: createdAt + commentPeriodMs + voteDurationMs,
    };

    // Governance transfer fields
    if (transferTo && transferAmount) {
      proposal.transferTo = transferTo;
      proposal.transferAmount = transferAmount;
      proposal.transferPurpose = transferPurpose || '';
    }

    this._proposals[pipId] = proposal;
    this._save();
    return { ok: true, pipId, isNew: true };
  }

  /** Validate a governance transfer proposal parameters. */
  validateGovernanceTransfer(transferTo, transferAmount) {
    if (!transferTo) {
      return { ok: false, error: 'Transfer recipient address is required for governance treasury transfers.' };
    }
    const { isValidAddress } = require('./wtc-address');
    if (!isValidAddress(transferTo)) {
      return { ok: false, error: `Invalid recipient address: ${transferTo}` };
    }
    if (typeof transferAmount !== 'number' || transferAmount <= 0) {
      return { ok: false, error: 'Transfer amount must be a positive number.' };
    }
    if (transferAmount > GOVERNANCE_MAX_TRANSFER) {
      return {
        ok: false,
        error: `Transfer amount cannot exceed ${GOVERNANCE_MAX_TRANSFER.toLocaleString()} WTC per proposal.`,
      };
    }
    return { ok: true };
  }

  /**
   * Generate the next pipId.
   */
  static generatePipId(chainHeight) {
    const ts = Date.now();
    const rand = crypto.randomBytes(2).toString('hex');
    return `pip-${chainHeight}-${ts}-${rand}`;
  }

  /**
   * Transition in_comment proposals to active once comment period expires.
   * Returns array of pipIds that transitioned.
   */
  advanceCommentPeriods() {
    const now = Date.now();
    const advanced = [];

    for (const p of Object.values(this._proposals)) {
      if (p.status !== STATUS_COMMENT) continue;
      if (now < p.commentPeriodEndsAt) continue;

      p.status = STATUS_ACTIVE;
      advanced.push(p.pipId);
    }

    if (advanced.length > 0) this._save();
    return advanced;
  }

  /**
   * Check whether a proposal has reached passing quorum.
   * Requires ≥PASS_THRESHOLD (71) weighted votes in favor.
   */
  checkQuorum(pipId) {
    const p = this._proposals[pipId];
    if (!p || p.status !== STATUS_ACTIVE) return { ok: false, reason: 'not active' };

    const threshold = this._getPassThreshold();
    if (p.voteTallies.for >= threshold) {
      return {
        ok: true,
        outcome: 'passed',
        transferTo: p.transferTo,
        transferAmount: p.transferAmount,
      };
    }

    return { ok: false, reason: `for (${p.voteTallies.for}) < ${threshold} needed` };
  }

  /**
   * Mark any active proposal whose voting period has expired.
   * Passed if ≥PASS_THRESHOLD, otherwise rejected.
   * Also advances comment periods.
   * Returns an array of { pipId, outcome, voteTallies, title, transferTo, transferAmount }.
   */
  closeExpiredProposals() {
    this.advanceCommentPeriods();

    const now = Date.now();
    const expired = [];

    for (const p of Object.values(this._proposals)) {
      if (p.status !== STATUS_ACTIVE) continue;
      if (now < p.votingEndsAt) continue;

      const threshold = this._getPassThreshold();
      const outcome = p.voteTallies.for >= threshold ? 'passed' : 'rejected';
      p.status = outcome;
      expired.push({
        pipId: p.pipId,
        outcome,
        voteTallies: { for: p.voteTallies.for, against: p.voteTallies.against },
        title: p.title,
        transferTo: p.transferTo,
        transferAmount: p.transferAmount,
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
    if (p.status === STATUS_COMMENT) return { ok: false, error: 'Proposal is in comment period — voting not yet open' };
    if (p.status !== STATUS_ACTIVE) return { ok: false, error: 'Proposal is not active' };
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
  static buildGovernanceResultTx({ pipId, outcome, from, nonce, voteTallies, title, transferTo, transferAmount }) {
    const timestamp = Date.now();
    const govData = { pipId, outcome, title: title || '', voteTallies, timestamp };
    if (transferTo && transferAmount) {
      govData.transferTo = transferTo;
      govData.transferAmount = transferAmount;
    }
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

    // Phase 1: Process governance_result transactions (update proposal status)
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
          status: outcome === 'passed' ? STATUS_PASSED : STATUS_REJECTED,
          votes: {},
          voteTallies: voteTallies || { for: 0, against: 0 },
          recordedAtHeight: block.height,
          recordedAtHash: block.hash,
          commentPeriodWeeks: COMMENT_PERIOD_DEFAULT_WEEKS,
          commentPeriodEndsAt:
            (tx.governanceData.timestamp || block.timestamp) + COMMENT_PERIOD_DEFAULT_WEEKS * 7 * 24 * 60 * 60 * 1000,
          votingDurationWeeks: VOTE_DURATION_DEFAULT_WEEKS,
          votingEndsAt: (tx.governanceData.timestamp || block.timestamp) + MAX_VOTE_DURATION_MS,
        };
        this._bumpNonce(tx.from);
        changed = true;
        continue;
      }

      if (p.status === STATUS_COMMENT || p.status === STATUS_ACTIVE) {
        p.status = outcome === 'passed' ? STATUS_PASSED : STATUS_REJECTED;
        p.recordedAtHeight = block.height;
        p.recordedAtHash = block.hash;
        this._bumpNonce(tx.from);
        changed = true;
        console.log(`[GovernanceStore] Proposal ${pipId} recorded on-chain at height ${block.height} as ${outcome}`);
      }
    }

    // Phase 2: Detect governance treasury transfer execution in this block.
    // When a governance wallet transfer tx is mined (authorized by a passed
    // proposal), record which proposal it executed.  This marker persists
    // through chain rebuilds (rebuildFromBlocks), preventing replay attacks
    // where the same pipId is reused for a second transfer.
    //
    // The consensus._commit post-gov check relies on this field: if
    // transferExecutedAt is already set for a DIFFERENT block height, the
    // block is rejected as a replay attempt.
    //
    // We only set the marker on FIRST execution (transferExecutedAt is
    // undefined).  If it is already set (from a previous block), we leave
    // it alone — the consensus check will reject this block.
    for (const tx of block.transactions || []) {
      if (tx.type === 'transfer' && tx.from === GOVERNANCE_WALLET_ADDRESS && tx.governanceTransferRef?.pipId) {
        const p = this._proposals[tx.governanceTransferRef.pipId];
        if (p && p.status === STATUS_PASSED && p.transferExecutedAt === undefined) {
          p.transferExecutedAt = block.height;
          changed = true;
          console.log(
            `[GovernanceStore] Proposal ${tx.governanceTransferRef.pipId} transfer executed at height ${block.height}`,
          );
        }
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

module.exports = {
  GovernanceStore,
  VOTE_WEIGHTS,
  TIER_RANK,
  IMMUTABLE_PRINCIPLES,
  GOVERNANCE_WALLET_ADDRESS,
  GOVERNANCE_MIN_RESERVE,
  GOVERNANCE_MAX_TRANSFER,
  STATUS_COMMENT,
  STATUS_ACTIVE,
  STATUS_PASSED,
  STATUS_REJECTED,
};
