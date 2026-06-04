// SPDX-License-Identifier: MIT
'use strict';
/**
 * wtc-consensus.js — Proof-of-Energy BFT consensus
 *
 * Protocol summary:
 *
 *  1. PROPOSE:  The local miner calls proposeBlock() after accumulating
 *               sufficient energy.  This node signs the proposed block
 *               (self-vote) and broadcasts it to all connected peers via
 *               HTTP POST /api/v1/chain/propose.
 *
 *  2. VOTE:     Each peer that receives a proposal validates the block
 *               structure and returns a signed vote.  Votes are keyed by
 *               voter address so duplicate votes are deduplicated.
 *
 *  3. COMMIT:   Once the quorum threshold is reached the block is finalized:
 *               chain.append() → accounts.applyBlock() → mempool.removeAll()
 *
 *  Quorum rule:
 *    Solo miner (0 known peers):   1 vote  (immediate finality)
 *    1 known peer:                 1 vote  (proposer self-vote suffices)
 *    N >= 2 known peers:           ceil((N+1) × 2/3) votes
 *
 *    Fallback: if VOTE_TIMEOUT_MS elapses without quorum, the block is
 *    committed with whatever votes were collected to avoid stalling.
 *    This is safe because energy proofs cannot be pre-computed.
 *
 *  Peer integration:
 *    Requires two injected helpers from electron-main:
 *      getActivePeers()               → string[] of peer base URLs
 *      requestPeerJson(url, method, path, body)  → Promise<object>
 *    These use the existing port-39310 HTTP peer network.
 */

const { computeBlockHash, energyForHeight } = require('./wtc-chain');
const { validateBlockProbeAttestation } = require('./probe-attestation');
const { sign: wtcSign, verifySignature: wtcVerify, isValidAddress, txHash } = require('./wtc-address');

const VOTE_TIMEOUT_MS = 2500; // how long to wait for peer votes
const QUORUM_FRACTION = 2 / 3; // BFT majority fraction
const DEDUP_CACHE_LIMIT = 1000; // max committed hashes to remember

class Consensus {
  /**
   * @param {{
   *   chain:          import('./wtc-chain').Chain,
   *   accounts:       import('./wtc-accounts').Accounts,
   *   mempool:        import('./wtc-mempool').Mempool,
   *   getActivePeers: () => string[],
   *   requestPeerJson: (baseUrl: string, method: string, path: string, body?: any) => Promise<any>,
   *   privateKey:     Buffer,
   *   allowPartialQuorumCommit?: boolean,
   *   getEnergyContributions?: () => { [address: string]: number },
   * }} opts
   */
  constructor({
    chain,
    accounts,
    mempool,
    getActivePeers,
    requestPeerJson,
    privateKey,
    allowPartialQuorumCommit = false,
    nfts = null,
    governance = null,
    getEnergyContributions,
  }) {
    this._chain = chain;
    this._accounts = accounts;
    this._mempool = mempool;
    this._nfts = nfts;
    this._governance = governance;
    this._peers = getActivePeers;
    this._rpc = requestPeerJson;
    this._privKey = privateKey; // Buffer — secp256k1 private key
    this._allowPartialQuorumCommit = !!allowPartialQuorumCommit;
    this._getEnergyContributions = typeof getEnergyContributions === 'function' ? getEnergyContributions : () => ({});

    this._localAddr = ''; // set by setLocalAddress()
    this._pending = new Map(); // blockHash → { block, votes: Map(addr → sigHex), voteWeight: Number }
    this._committed = new Set(); // committed block hashes (dedup guard)
  }

  /** Tell consensus which wallet address this node is mining from. */
  setLocalAddress(addr) {
    this._localAddr = addr;
  }

  // ─── Entry points (called by WtcNode) ────────────────────────────────────

  /**
   * Propose, vote-gather, and commit a new block.
   * Blocks the call for up to VOTE_TIMEOUT_MS waiting for peer votes.
   *
   * @returns {Promise<object>} the committed block
   */
  async proposeBlock({
    proposer,
    energyWh,
    proofCommitment,
    peerProbeVerified = false,
    probeReceipt = null,
    probesAnswered = 0,
    transactions,
    rewardAddresses,
    nftsRoot = '',
  }) {
    const stateRoot = this._accounts.stateHash();
    const block = this._chain.buildBlock({
      proposer,
      energyWh,
      proofCommitment,
      peerProbeVerified,
      probeReceipt,
      probesAnswered,
      transactions,
      rewardAddresses,
      stateRoot,
      nftsRoot,
    });

    const validationError = this._validateBlock(block);
    if (validationError) {
      return {
        ok: false,
        code: 'INVALID_BLOCK_PROPOSAL',
        reason: validationError,
        height: block.height,
        hash: block.hash,
      };
    }

    // Self-vote
    const selfSig = this._signBlock(block);
    const votes = new Map([[proposer, selfSig]]);
    const voteWeight = this._voteWeight(proposer);
    this._pending.set(block.hash, { block, votes, voteWeight });

    // Broadcast to peers and collect votes in parallel
    const peers = this._peers();
    if (peers.length > 0) {
      await this._broadcastAndCollect(block, votes, peers);
    }

    // Compute total weight from all collected votes (proposer + peers)
    const totalWeight = Array.from(votes.keys()).reduce((w, addr) => w + this._voteWeight(addr), 0);
    const entry = this._pending.get(block.hash);
    if (entry) entry.voteWeight = totalWeight;

    // Commit (with or without full energy quorum)
    const quorumWeight = this._quorumWeight();
    if (totalWeight < quorumWeight) {
      if (!this._allowPartialQuorumCommit) {
        return {
          ok: false,
          code: 'QUORUM_NOT_REACHED',
          reason: `quorum not reached: weight ${totalWeight}/${quorumWeight}`,
          collectedVotes: votes.size,
          requiredWeight: quorumWeight,
          height: block.height,
          hash: block.hash,
        };
      }
      console.warn(
        `[Consensus] Committing block ${block.height} with weight ${totalWeight}/${quorumWeight} (partial quorum, ${votes.size} votes)`,
      );
    }

    return this._commit(block, votes);
  }

  /**
   * Called when a peer sends us a block proposal over HTTP.
   * Validates the block and returns our signed vote (or rejection reason).
   *
   * @param {object} block    — the proposed block JSON
   * @param {string} fromPeer — base URL of the proposing peer (for logging)
   * @returns {{ ok: boolean, signer?: string, sig?: string, reason?: string }}
   */
  receiveProposal(block, _fromPeer) {
    // Deduplicate already-committed blocks
    if (this._committed.has(block && block.hash)) {
      return { ok: false, reason: 'already committed' };
    }
    if (this._chain.getBlockByHash(block && block.hash)) {
      return { ok: false, reason: 'already on chain' };
    }

    const err = this._validateBlock(block);
    if (err) return { ok: false, reason: err };

    // If we're already tracking this proposal, just re-issue our vote
    if (this._pending.has(block.hash)) {
      const sig = this._pending.get(block.hash).votes.get(this._localAddr);
      return { ok: true, signer: this._localAddr, sig: sig || this._signBlock(block) };
    }

    // New (valid) proposal — cast our vote and track it
    const sig = this._signBlock(block);
    this._pending.set(block.hash, {
      block,
      votes: new Map([[this._localAddr, sig]]),
      voteWeight: this._voteWeight(this._localAddr),
    });
    return { ok: true, signer: this._localAddr, sig };
  }

  /**
   * Called when a peer sends us a vote for a pending proposal.
   * If quorum is reached this node commits the block itself.
   *
   * @returns {{ ok: boolean, votes?: number, reason?: string }}
   */
  receiveVote({ blockHash, voter, sig }) {
    const entry = this._pending.get(blockHash);
    if (!entry) return { ok: false, reason: 'no pending proposal for this hash' };
    if (this._committed.has(blockHash)) return { ok: true, votes: entry.votes.size };

    if (!this._verifyVote(blockHash, sig, voter)) {
      return { ok: false, reason: 'invalid vote signature' };
    }

    entry.votes.set(voter, sig);
    entry.voteWeight = (entry.voteWeight || 0) + this._voteWeight(voter);

    const quorumWeight = this._quorumWeight();
    if (entry.voteWeight >= quorumWeight) {
      // Commit asynchronously to avoid blocking the HTTP response
      setImmediate(() => {
        this._commit(entry.block, entry.votes).catch(() => {});
      });
    }

    return { ok: true, votes: entry.votes.size, voteWeight: entry.voteWeight };
  }

  /**
   * Returns current consensus / chain-tip status for the API.
   */
  getStatus() {
    const height = this._chain.getHeight();
    const tip = this._chain.getTip();
    const peers = this._peers();
    return {
      height,
      tipHash: tip ? tip.hash : null,
      tipTimestamp: tip ? tip.timestamp : null,
      nextReward: this._chain.nextBlockReward(),
      activePeers: peers.length,
      pendingProposals: this._pending.size,
      status: 'running',
    };
  }

  /** Public accessor used by node-level sync logic. */
  getActivePeers() {
    return this._peers();
  }

  /** Public RPC wrapper used by node-level sync logic. */
  requestPeerJson(peerUrl, method, routePath, payload, query, options) {
    return this._rpc(peerUrl, method, routePath, payload, query, options);
  }

  /** Clear pending/dedup tracking after a chain sync replacement. */
  resetTracking() {
    this._pending.clear();
    this._committed.clear();
  }

  // ─── Internal helpers ─────────────────────────────────────────────────────

  /**
   * Vote weight for a given address, based on its contributed energy in the
   * current round.  Falls back to weight=1 (count-based) when no energy
   * tracking is available.
   */
  _voteWeight(address) {
    const contributions = this._getEnergyContributions();
    const keys = Object.keys(contributions);
    if (keys.length === 0) return 1;
    return Number(contributions[address]) || 0;
  }

  /**
   * Quorum weight threshold — sum of all participants' contributed energy
   * × 2/3.  Falls back to a count-based quorum when no energy tracking
   * data is available.
   */
  _quorumWeight() {
    const contributions = this._getEnergyContributions();
    const entries = Object.entries(contributions);
    if (entries.length === 0) {
      return this._countQuorum(this._peers().length);
    }
    const totalWh = entries.reduce((s, [, v]) => s + (Number(v) || 0), 0);
    return Math.max(1, Math.ceil(totalWh * QUORUM_FRACTION));
  }

  /**
   * Legacy count-based quorum (used as fallback when energy data absent):
   *   0-1 known peers → 1 vote (self-sufficient)
   *   N >= 2 peers    → ceil((N+1) × 2/3)
   */
  _countQuorum(knownPeers) {
    if (knownPeers <= 1) return 1;
    return Math.ceil((knownPeers + 1) * QUORUM_FRACTION);
  }

  /**
   * Sign the block hash with our private key.
   * Returns a 130-char hex string: r(64) + s(64) + v(2).
   */
  _signBlock(block) {
    if (!this._privKey || this._privKey.length === 0) return '';
    try {
      const h = txHash(block.hash);
      const sig = wtcSign(h, this._privKey);
      return `${sig.r}${sig.s}${String(sig.v).padStart(2, '0')}`;
    } catch (_) {
      return '';
    }
  }

  /**
   * Verify that a vote signature is valid for the given blockHash and voter address.
   * A missing, short, or unverifiable signature is always rejected.
   */
  _verifyVote(blockHash, sigHex, voterAddress) {
    if (!sigHex || sigHex.length < 130) return false; // missing or malformed sig
    try {
      const r = sigHex.slice(0, 64);
      const s = sigHex.slice(64, 128);
      const v = parseInt(sigHex.slice(128), 10);
      const h = txHash(blockHash);
      return wtcVerify(h, { r, s, v }, voterAddress);
    } catch (_) {
      return false; // any verification error is a rejection
    }
  }

  /**
   * Validate block structure and chain linkage.
   * Returns null on success, or an error string on failure.
   */
  _validateBlock(block) {
    if (!block || typeof block !== 'object') return 'block must be an object';
    if (typeof block.height !== 'number') return 'missing height';
    if (typeof block.prevHash !== 'string') return 'missing prevHash';
    if (typeof block.proposer !== 'string') return 'missing proposer';
    if (block.hash !== computeBlockHash(block)) return 'block hash mismatch';

    if (block.height === 0) return null; // genesis is valid by hash alone

    const expectedHeight = this._chain.getHeight() + 1;
    if (block.height !== expectedHeight) {
      return `expected height ${expectedHeight}, got ${block.height}`;
    }

    const tip = this._chain.getTip();
    if (tip && block.prevHash !== tip.hash) return 'prevHash mismatch';

    const expectedReward = this._chain.rewardForHeight(block.height);
    if (Math.abs(block.rewardTotal - expectedReward) > 0.001) {
      return `reward mismatch: expected ${expectedReward}, got ${block.rewardTotal}`;
    }

    const minEnergyWh = energyForHeight(block.height);
    if (minEnergyWh > 0 && (typeof block.energyWh !== 'number' || block.energyWh < minEnergyWh)) {
      return `insufficient energyWh: required ${minEnergyWh}, got ${block.energyWh || 0}`;
    }

    const contribs = this._getEnergyContributions();

    // Validate rewardAddresses: every entry must be a valid address with a
    // non-negative amount, and the sum must exactly equal rewardTotal.
    // Without this check a malicious peer could credit an arbitrary amount
    // to any address while keeping rewardTotal within schedule bounds.
    let rewardSum = 0;
    for (const [addr, amount] of Object.entries(block.rewardAddresses || {})) {
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
        return `invalid reward amount for address ${addr}`;
      }
      if (!isValidAddress(addr)) {
        return `invalid reward address: ${addr}`;
      }
      rewardSum += amount;
    }
    if (Math.abs(rewardSum - block.rewardTotal) > 0.001) {
      return `rewardAddresses sum (${rewardSum}) does not match rewardTotal (${block.rewardTotal})`;
    }

    // Cross-check rewardAddresses against witnessed round contributions.
    // Every address credited in the block must have contributed energy in
    // this round according to the local round ledger.  This prevents a
    // malicious proposer from crediting fake addresses that never mined.
    // If the peer has no contribution data yet (e.g. just joined), the
    // check is skipped so valid blocks are not spuriously rejected.
    const contribKeys = Object.keys(contribs);
    if (contribKeys.length > 0) {
      for (const addr of Object.keys(block.rewardAddresses || {})) {
        const wh = Number(contribs[addr]) || 0;
        if (wh <= 0) {
          return `reward address ${addr} has no witnessed round contribution (${wh} Wh)`;
        }
      }

      // Reward proportion validation: for every address where we have
      // witnessed contribution data, verify the reward is proportional.
      // This prevents a proposer from skewing the distribution to give
      // themselves an outsized share at the expense of others.
      // Uses the same proportional algorithm as buildRewardMapFromRoundSnapshot.
      const rewardTotal = block.rewardTotal;
      const eligible = Object.entries(contribs)
        .map(([addr, wh]) => [addr, Math.max(0, Number(wh) || 0)])
        .filter(([, wh]) => wh > 0);
      if (eligible.length > 0 && rewardTotal > 0) {
        const totalWh = eligible.reduce((s, [, wh]) => s + wh, 0);
        if (totalWh > 0) {
          let allocated = 0;
          const expected = {};
          eligible.forEach(([addr, wh], index) => {
            const isLast = index === eligible.length - 1;
            let share = isLast
              ? Number((rewardTotal - allocated).toFixed(8))
              : Number(((rewardTotal * wh) / totalWh).toFixed(8));
            if (share < 0) share = 0;
            allocated = Number((allocated + share).toFixed(8));
            expected[addr] = Number(((expected[addr] || 0) + share).toFixed(8));
          });
          for (const [addr, expectedAmt] of Object.entries(expected)) {
            const actualAmt = Number((block.rewardAddresses || {})[addr]) || 0;
            // Allow small rounding differences (0.001 tokens) and a 10%
            // tolerance for in-flight contributions the peer may have missed.
            const tolerance = Math.max(0.001, expectedAmt * 0.1);
            if (actualAmt < expectedAmt - tolerance) {
              return `reward for ${addr}: got ${actualAmt}, expected ~${expectedAmt} based on witnessed contributions`;
            }
          }
        }
      }
    }

    // ProbesAnswered must not exceed what the round duration allows.
    // Each probe requires at least PROBE_INTERVAL_MS (5 min) of real work.
    // This prevents a proposer from claiming an impossible number of probes
    // for the time elapsed since the previous block.  The +1 tolerance
    // accounts for the probe that triggered the block proposal itself.
    const PROBE_INTERVAL_MS = 5 * 60 * 1000;
    const probesAnswered = Math.max(0, Math.floor(Number(block.probesAnswered) || 0));
    if (probesAnswered > 0 && tip && tip.timestamp) {
      const elapsedMs = Math.max(0, block.timestamp - tip.timestamp);
      const maxPlausibleProbes = Math.ceil(elapsedMs / PROBE_INTERVAL_MS) + 1;
      if (probesAnswered > maxPlausibleProbes) {
        return `probesAnswered (${probesAnswered}) exceeds plausible max (${maxPlausibleProbes}) for round duration ${elapsedMs}ms`;
      }
    }

    const attestationCheck = validateBlockProbeAttestation(block, { expectedWorkerId: block.proposer });
    if (!attestationCheck.ok) {
      return attestationCheck.reason;
    }

    // Validate every transaction signature in the block.
    // The local proposer always calls _isTxValid before including a tx, but
    // a peer-supplied proposal may contain forged transactions.  Signature
    // verification prevents inclusion of arbitrary/spoofed transfers.
    if (Array.isArray(block.transactions)) {
      for (let i = 0; i < block.transactions.length; i++) {
        const tx = block.transactions[i];
        if (!tx || typeof tx !== 'object') return `invalid tx at index ${i}`;
        // NFT transaction semantics are validated by NftStore at applyBlock time.
        // Signature verification still applies: NFT txns are signed the same way.
        if (!tx.from || !tx.to || !tx.sig) return `tx ${i} missing from/to/sig`;
        if (typeof tx.sig.r !== 'string' || typeof tx.sig.s !== 'string') return `tx ${i} invalid sig format`;
        const sigFields = {
          id: tx.id,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          fee: tx.fee,
          nonce: tx.nonce,
        };
        // Governance wallet transfers include governanceTransferRef in the
        // signed data so the authorization (passed proposal) cannot be stripped.
        if (tx.governanceTransferRef) {
          sigFields.governanceTransferRef = tx.governanceTransferRef;
        }
        const sigInput = JSON.stringify(sigFields);
        if (!wtcVerify(txHash(sigInput), tx.sig, tx.from)) return `tx ${i} signature mismatch`;
      }
    }

    return null; // valid
  }

  /**
   * Finalize a block: append it to the chain, apply account changes,
   * remove its transactions from the mempool.
   */
  _commit(block, votes) {
    if (this._committed.has(block.hash)) {
      // Already committed by a parallel path — return the on-chain version.
      return this._chain.getBlockByHash(block.hash) || block;
    }
    this._committed.add(block.hash);

    // Evict old entries from the dedup set to prevent unbounded growth
    if (this._committed.size > DEDUP_CACHE_LIMIT) {
      const oldest = [...this._committed].slice(0, 100);
      for (const h of oldest) this._committed.delete(h);
    }

    // Attach vote set to the final block object
    const votesObj = {};
    for (const [voter, sig] of votes) votesObj[voter] = sig;
    const finalBlock = { ...block, votes: votesObj };

    // Persist to chain
    try {
      this._chain.append(finalBlock);
    } catch (e) {
      console.warn(`[Consensus] chain.append failed: ${e.message}`);
      return block;
    }

    // Update account state
    this._accounts.applyBlock(finalBlock);

    // Update NFT state
    if (this._nfts) this._nfts.applyBlock(finalBlock);

    // Update governance state (process governance_result transactions)
    if (this._governance) this._governance.applyBlock(finalBlock);

    // Protocol enforcement: governance wallet transfers MUST reference a
    // passed on-chain governance_transfer proposal.  Without this check,
    // anyone holding the governance wallet private key could bypass NFT
    // governance.  With this check, the key is irrelevant — only a passed
    // vote can move treasury funds.
    //
    // Checks performed for each governance wallet transfer tx:
    //   1. governanceTransferRef.pipId is present
    //   2. Referenced proposal exists in GovernanceStore
    //   3. Proposal status is 'passed'
    //   4. transferTo / transferAmount EXACTLY match the proposal
    //      (prevents a node from referencing proposal X that passed for
    //       recipient A / amount Y, but crafting a tx for recipient B / X)
    //   5. Proposal.transferExecutedAt not already set for a DIFFERENT
    //      block height (prevents replay — one passed pipId = one transfer)
    for (const tx of finalBlock.transactions || []) {
      if (tx.type === 'transfer' && tx.from === 'wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw') {
        const ref = tx.governanceTransferRef;
        if (!ref || !ref.pipId) {
          console.error(
            `[Consensus] SECURITY: governance wallet transfer ${tx.id.slice(0, 16)} lacks governanceTransferRef — rejecting block`,
          );
          this._chain.rollback();
          this._accounts.rebuildFromBlocks(this._chain.getBlocks());
          if (this._nfts) this._nfts.rebuildFromBlocks(this._chain.getBlocks());
          if (this._governance) this._governance.rebuildFromBlocks(this._chain.getBlocks());
          throw new Error(`Governance wallet transfer without governance authorization`);
        }
        if (this._governance) {
          const proposal = this._governance.getProposal(ref.pipId);
          if (!proposal) {
            console.error(
              `[Consensus] SECURITY: governance wallet transfer references unknown proposal ${ref.pipId} — rejecting block`,
            );
            this._chain.rollback();
            this._accounts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._nfts) this._nfts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._governance) this._governance.rebuildFromBlocks(this._chain.getBlocks());
            throw new Error(`Governance wallet transfer references unknown proposal ${ref.pipId}`);
          }
          if (proposal.status !== 'passed') {
            console.error(
              `[Consensus] SECURITY: governance wallet transfer references non-passed proposal ${ref.pipId} (status=${proposal.status}) — rejecting block`,
            );
            this._chain.rollback();
            this._accounts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._nfts) this._nfts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._governance) this._governance.rebuildFromBlocks(this._chain.getBlocks());
            throw new Error(`Governance wallet transfer references non-passed proposal ${ref.pipId}`);
          }
          // Check 4: transferTo / transferAmount must match the proposal
          if (tx.to !== proposal.transferTo) {
            console.error(
              `[Consensus] SECURITY: governance wallet transfer recipient ${tx.to} does not match proposal ${ref.pipId} recipient ${proposal.transferTo} — rejecting block`,
            );
            this._chain.rollback();
            this._accounts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._nfts) this._nfts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._governance) this._governance.rebuildFromBlocks(this._chain.getBlocks());
            throw new Error(`Governance wallet transfer recipient mismatch for proposal ${ref.pipId}`);
          }
          if (tx.amount !== proposal.transferAmount) {
            console.error(
              `[Consensus] SECURITY: governance wallet transfer amount ${tx.amount} does not match proposal ${ref.pipId} amount ${proposal.transferAmount} — rejecting block`,
            );
            this._chain.rollback();
            this._accounts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._nfts) this._nfts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._governance) this._governance.rebuildFromBlocks(this._chain.getBlocks());
            throw new Error(`Governance wallet transfer amount mismatch for proposal ${ref.pipId}`);
          }
          // Check 5: replay protection — this pipId must NOT have already
          // executed a transfer in a previous block.  If transferExecutedAt
          // is set and differs from the current block, the proposal was
          // already used.
          if (proposal.transferExecutedAt !== undefined && proposal.transferExecutedAt !== finalBlock.height) {
            console.error(
              `[Consensus] SECURITY: governance proposal ${ref.pipId} already executed at height ${proposal.transferExecutedAt} — rejecting replay attempt at height ${finalBlock.height}`,
            );
            this._chain.rollback();
            this._accounts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._nfts) this._nfts.rebuildFromBlocks(this._chain.getBlocks());
            if (this._governance) this._governance.rebuildFromBlocks(this._chain.getBlocks());
            throw new Error(`Governance proposal ${ref.pipId} already used for a prior transfer`);
          }
        }
      }
    }

    // Clear committed transactions from mempool
    const txIds = (finalBlock.transactions || []).map((t) => t.id);
    this._mempool.removeAll(txIds);

    // Clean up pending map
    this._pending.delete(block.hash);

    console.log(
      `[Consensus] Block ${finalBlock.height} committed` +
        ` hash=${finalBlock.hash.slice(0, 16)}...` +
        ` votes=${votes.size}` +
        ` reward=${finalBlock.rewardTotal}`,
    );

    return finalBlock;
  }

  /**
   * Broadcast a block proposal to all peers and collect their votes.
   * Vote responses are added directly into the shared votes Map.
   * Runs all peer requests in parallel (race with timeout).
   */
  async _broadcastAndCollect(block, votes, peers) {
    const requests = peers.map(async (peerUrl) => {
      try {
        const res = await Promise.race([
          this._rpc(peerUrl, 'POST', '/api/v1/chain/propose', block),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), VOTE_TIMEOUT_MS)),
        ]);
        if (res && res.ok && res.signer && res.sig) {
          votes.set(res.signer, res.sig);
        }
      } catch (_) {
        // Peer offline or timed out — not fatal; we will commit with available votes
      }
    });

    await Promise.allSettled(requests);
  }
}

module.exports = { Consensus };
