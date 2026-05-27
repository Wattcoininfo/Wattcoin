// SPDX-License-Identifier: MIT
'use strict';
/**
 * wtc-node.js — Unified WTC native-chain API
 *
 * This module composes wtc-accounts, wtc-chain, wtc-mempool, wtc-consensus,
 * and wtc-address into a single object that electron-main.js requires.
 *
 * Typical initialization in electron-main.js:
 *
 *   const { createWtcNode } = require('./wtc-node');
 *   const wtcNode = createWtcNode({
 *     dataDir:      app.getPath('userData'),
 *     signingSecret: derivedSecret,      // HMAC key for file integrity
 *     getActivePeers:  () => [...],       // from existing peer tracker
 *     requestPeerJson: (url, method, path, body) => fetch...,
 *   });
 *
 * Genesis configuration:
 *   Place a file at {dataDir}/wtc-genesis.json for the canonical mainnet genesis:
 *   {
 *     "timestamp": 1700000000000,
 *     "teamWallets": [
 *       { "address": "wtc1q...", "amount": 1000000 }
 *     ]
 *   }
 *   If this file is absent the first run premines to the local primary address
 *   (useful for development / testnet runs).
 *
 * HTTP endpoints to add to the existing ledger server (port 39310):
 *   POST /api/v1/chain/propose  → wtcNode.handleProposal(body, fromPeer)
 *   POST /api/v1/chain/vote     → wtcNode.handleVote(body)
 *   GET  /api/v1/chain/tip      → wtcNode.handleGetTip()
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Accounts } = require('./wtc-accounts');
const { Chain } = require('./wtc-chain');
const { Mempool } = require('./wtc-mempool');
const { Consensus } = require('./wtc-consensus');
const { NftStore, NFT_COLLECTION, MINTER_ADDRESS } = require('./wtc-nfts');
const { GovernanceStore, GOVERNANCE_WALLET_ADDRESS } = require('./wtc-governance');
const { generateKeypair, isValidAddress, txHash, sign, verifySignature } = require('./wtc-address');

const WALLET_FILE = 'wtc-wallet.json';
const PENDING_TXS_FILE = 'wtc-pending-txs.json';
const GENESIS_CFG_FILE = 'wtc-genesis.json';
const GENESIS_PREMINE = 1_000_000;
const CHAIN_PROTOCOL_VERSION = 1;
const PEER_CHAIN_TIP_TIMEOUT_MS = 12_000;
const PEER_CHAIN_FETCH_TIMEOUT_MS = 20_000;
const PEER_READINESS_PROBE_CONCURRENCY = 5;

// ─────────────────────────────────────────────────────────────────────────────

class WtcNode {
  static PEER_BACKOFF_DIAGNOSTIC_MS = 5 * 60_000; // log stuck-peers reminder every 5 min
  // Track consecutive failures for each peer
  static PEER_FAILURE_BACKOFF_MS = 30_000; // 30 s backoff — peers typically recover within seconds
  static PEER_FAILURE_THRESHOLD = 5; // backoff only after 5 consecutive failures
  _peerFailureCounts = new Map(); // peerUrl -> { count, lastFail }
  _lastBackoffLog = new Map(); // peerUrl -> last log timestamp

  _isPeerInFailureBackoff(peerUrl, now = Date.now()) {
    const fail = this._peerFailureCounts.get(peerUrl);
    if (!fail) return false;
    return fail.count >= WtcNode.PEER_FAILURE_THRESHOLD && now - fail.lastFail < WtcNode.PEER_FAILURE_BACKOFF_MS;
  }

  _recordPeerFailure(peerUrl, now = Date.now()) {
    const previous = this._peerFailureCounts.get(peerUrl);
    const next =
      !previous || now - previous.lastFail >= WtcNode.PEER_FAILURE_BACKOFF_MS
        ? { count: 1, lastFail: now }
        : { count: previous.count + 1, lastFail: now };
    this._peerFailureCounts.set(peerUrl, next);
    return next;
  }

  _clearPeerFailure(peerUrl) {
    this._peerFailureCounts.delete(peerUrl);
  }

  /**
   * @param {{ dataDir: string, signingSecret: string }} opts
   */
  constructor({ dataDir, signingSecret, peerIdentity = '', walletKey }) {
    this._dataDir = dataDir;
    this._secret = signingSecret || crypto.randomBytes(32).toString('hex');
    this._walletKey = Buffer.isBuffer(walletKey) && walletKey.length === 32 ? walletKey : null;
    this._peerIdentity = typeof peerIdentity === 'string' ? peerIdentity.trim() : '';
    this._isSelfPeerUrl = null;

    this._accounts = new Accounts({ dataDir, signingSecret: this._secret });
    this._chain = new Chain({ dataDir, signingSecret: this._secret });
    this._mempool = new Mempool();
    this._nfts = new NftStore({ dataDir, signingSecret: this._secret });
    this._governance = new GovernanceStore({ dataDir, signingSecret: this._secret, nftStore: this._nfts });

    this._consensus = null; // set during init()
    this._wallet = this._loadOrCreateWallet();
    this._syncInProgress = false;

    this._pendingTxs = []; // persisted pending txs that survive restart
    this._loadPendingTxs();

    // Periodic diagnostics: log peers stuck in failure backoff every 5 minutes
    this._backoffDiagTimer = setInterval(() => this._logBackoffDiagnostics(), WtcNode.PEER_BACKOFF_DIAGNOSTIC_MS);
    this._backoffDiagTimer.unref();
  }

  /** Log a periodic reminder for peers still in failure backoff. */
  _logBackoffDiagnostics() {
    const now = Date.now();
    for (const [peerUrl, fail] of this._peerFailureCounts) {
      if (fail.count < WtcNode.PEER_FAILURE_THRESHOLD) continue;
      const lastLog = this._lastBackoffLog.get(peerUrl) || 0;
      if (now - lastLog < WtcNode.PEER_BACKOFF_DIAGNOSTIC_MS) continue;
      this._lastBackoffLog.set(peerUrl, now);
      console.warn(
        `[WtcNode] Peer ${peerUrl} still in failure backoff (${fail.count} consecutive failures, last fail ${new Date(fail.lastFail).toISOString()})`,
      );
    }
  }

  _pendingTxsPath() {
    return path.join(this._dataDir, PENDING_TXS_FILE);
  }

  _loadPendingTxs() {
    try {
      const raw = fs.readFileSync(this._pendingTxsPath(), 'utf8');
      const parsed = JSON.parse(raw);
      this._pendingTxs = Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      this._pendingTxs = [];
    }
  }

  _savePendingTxs() {
    try {
      fs.mkdirSync(path.dirname(this._pendingTxsPath()), { recursive: true });
      const tmp = this._pendingTxsPath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._pendingTxs), 'utf8');
      fs.renameSync(tmp, this._pendingTxsPath());
    } catch (e) {
      console.warn('[WtcNode] Failed to save pending txs:', e.message);
    }
  }

  _addPendingTx(tx) {
    const exists = this._pendingTxs.some((t) => t.id === tx.id);
    if (exists) return;
    this._pendingTxs.push(tx);
    this._savePendingTxs();
  }

  _removePendingTx(txid) {
    const before = this._pendingTxs.length;
    this._pendingTxs = this._pendingTxs.filter((t) => t.id !== txid);
    if (this._pendingTxs.length !== before) this._savePendingTxs();
  }

  _retryPendingTxs() {
    let retried = 0;
    for (const tx of this._pendingTxs) {
      const result = this._mempool.add(tx);
      if (result.ok) {
        retried++;
      } else {
        console.warn(`[WtcNode] Pending tx ${tx.id.slice(0, 12)} dropped: ${result.message}`);
      }
    }
    if (retried > 0) {
      console.log(`[WtcNode] Re-added ${retried} pending tx(s) to mempool`);
    }
  }

  /**
   * Finish initialization with peer-network helpers.
   * Must be called once after Electron app.whenReady().
   *
   * @param {{ getActivePeers: () => string[], getPeerTargets?: () => string[], getTrustedPeerTargets?: () => string[], requestPeerJson: Function, onPeerTip?: Function, allowPartialQuorumCommit?: boolean, getConnectedPeerCount?: Function, getEnergyContributions?: () => object }} opts
   * @returns {WtcNode} this (for chaining)
   */
  init({
    getActivePeers,
    getPeerTargets,
    getTrustedPeerTargets,
    requestPeerJson,
    onPeerTip,
    allowPartialQuorumCommit = false,
    isLiveLocalTunnelPeer,
    isSelfPeerUrl,
    getConnectedPeerCount,
    getEnergyContributions,
  }) {
    const privBuf = Buffer.from(this._wallet.primaryKey.privateKey, 'hex');

    this._consensus = new Consensus({
      chain: this._chain,
      accounts: this._accounts,
      mempool: this._mempool,
      nfts: this._nfts,
      governance: this._governance,
      getActivePeers,
      requestPeerJson,
      privateKey: privBuf,
      allowPartialQuorumCommit,
      getEnergyContributions,
    });
    this._isLiveLocalTunnelPeer = typeof isLiveLocalTunnelPeer === 'function' ? isLiveLocalTunnelPeer : null;
    this._isSelfPeerUrl = typeof isSelfPeerUrl === 'function' ? isSelfPeerUrl : null;
    this._getPeerTargets = typeof getPeerTargets === 'function' ? getPeerTargets : null;
    this._getTrustedPeerTargets = typeof getTrustedPeerTargets === 'function' ? getTrustedPeerTargets : null;
    this._onPeerTip = typeof onPeerTip === 'function' ? onPeerTip : null;
    this._getConnectedPeerCount = typeof getConnectedPeerCount === 'function' ? getConnectedPeerCount : null;
    this._consensus.setLocalAddress(this._wallet.primaryKey.address);

    // Bootstrap genesis if the chain is brand-new
    if (this._chain.getHeight() < 0) {
      this._initGenesis();
    }

    // Verify genesis matches canonical config (handles pre-1.0.124 upgrades
    // where a private genesis was created before the bundled config existed).
    // Always run regardless of height so clients who mined blocks on a wrong
    // genesis are also reset (not just height-0 installs).
    this._verifyGenesisIntegrity();

    this._retryPendingTxs();

    console.log(`[WtcNode] Ready - height=${this._chain.getHeight()}` + ` address=${this._wallet.primaryKey.address}`);
    return this;
  }

  // ─── Wallet management ────────────────────────────────────────────────────

  _walletPath() {
    return path.join(this._dataDir, WALLET_FILE);
  }

  _loadOrCreateWallet() {
    const fp = this._walletPath();
    try {
      if (fs.existsSync(fp)) {
        const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
        if (raw && raw.encrypted && this._walletKey) {
          const decipher = crypto.createDecipheriv('aes-256-gcm', this._walletKey, Buffer.from(raw.iv, 'hex'));
          decipher.setAuthTag(Buffer.from(raw.tag, 'hex'));
          const decrypted = decipher.update(raw.ciphertext, 'hex', 'utf8') + decipher.final('utf8');
          const parsed = JSON.parse(decrypted);
          if (parsed && Array.isArray(parsed.keys) && parsed.keys.length > 0) {
            if (!parsed.primaryKey) parsed.primaryKey = parsed.keys[0];
            return parsed;
          }
        } else if (raw && Array.isArray(raw.keys) && raw.keys.length > 0) {
          if (!raw.primaryKey) raw.primaryKey = raw.keys[0];
          return raw;
        }
      }
    } catch (_) {
      /* corrupt file — recreate */
    }

    const kp = generateKeypair();
    const wallet = { version: 1, keys: [kp], primaryKey: kp };
    this._saveWallet(wallet);
    console.log('[WtcNode] New wallet created:', kp.address);
    return wallet;
  }

  _saveWallet(wallet) {
    try {
      fs.mkdirSync(path.dirname(this._walletPath()), { recursive: true });
      let data = JSON.stringify(wallet, null, 2);
      if (this._walletKey) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this._walletKey, iv);
        const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        data = JSON.stringify({
          encrypted: true,
          version: 1,
          iv: iv.toString('hex'),
          tag: tag.toString('hex'),
          ciphertext: encrypted.toString('hex'),
        });
      }
      fs.writeFileSync(this._walletPath(), data, 'utf8');
    } catch (e) {
      console.error('[WtcNode] Failed to save wallet:', e.message);
    }
  }

  /** Generate a new address and add it to the wallet. */
  createAddress() {
    const kp = generateKeypair();
    this._wallet.keys.push(kp);
    this._saveWallet(this._wallet);
    return { address: kp.address, publicKey: kp.publicKey };
  }

  /** All addresses held by this wallet. */
  getAddresses() {
    return this._wallet.keys.map((k) => k.address);
  }

  /** Check if an address exists in this node's wallet. */
  hasAddress(address) {
    return this._wallet.keys.some((k) => k.address === address);
  }

  /** The primary mining/receiving address. */
  getPrimaryAddress() {
    return this._wallet.primaryKey.address;
  }

  getPeerIdentity() {
    return this._peerIdentity || this._wallet.primaryKey.address;
  }

  _isPeerSelfReference(peerUrl, peerIdentity) {
    const normalizedIdentity = String(peerIdentity || '').trim();
    const localPeerIdentity = String(this.getPeerIdentity() || '').trim();
    if (!normalizedIdentity || !localPeerIdentity || normalizedIdentity !== localPeerIdentity) {
      return false;
    }
    if (typeof this._isSelfPeerUrl !== 'function') {
      return true;
    }
    try {
      return !!this._isSelfPeerUrl(peerUrl);
    } catch (_) {
      return true;
    }
  }

  /**
   * Change which address is used for mining rewards.
   * The address must already exist in the wallet.
   */
  setPrimaryAddress(address) {
    const kp = this._wallet.keys.find((k) => k.address === address);
    if (!kp) throw new Error(`Address ${address} not found in wallet`);
    this._wallet.primaryKey = kp;
    this._saveWallet(this._wallet);
    if (this._consensus) this._consensus.setLocalAddress(address);
  }

  /** Remove an address from the wallet (cannot remove the primary address). */
  deleteAddress(address) {
    if (address === this._wallet.primaryKey.address) {
      throw new Error('Cannot delete the primary address');
    }
    this._wallet.keys = this._wallet.keys.filter((k) => k.address !== address);
    this._saveWallet(this._wallet);
  }

  // ─── Genesis ──────────────────────────────────────────────────────────────

  _initGenesis() {
    const cfgPath = path.join(this._dataDir, GENESIS_CFG_FILE);
    let teamWallets = [];
    let timestamp = Date.now();

    try {
      if (fs.existsSync(cfgPath)) {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (Array.isArray(raw.teamWallets) && raw.teamWallets.length > 0) {
          teamWallets = raw.teamWallets;
          timestamp = raw.timestamp || timestamp;
        }
      }
    } catch (_) {
      /* ignore parse errors, fall through to default */
    }

    if (teamWallets.length === 0) {
      throw new Error(
        `Genesis config not found at ${cfgPath}. The file wtc-genesis.json must exist with valid teamWallets. ` +
          `Reinstall the application or restore the file from your installation resources directory.`,
      );
    }

    const genesis = this._chain.genesis({ teamWallets, timestamp });
    this._accounts.applyBlock(genesis);
    console.log(`[WtcNode] Genesis created - hash=${genesis.hash.slice(0, 16)}...`);
  }

  /**
   * Verify the stored genesis block matches the canonical genesis config.
   * Compares the actual genesis hash (covers both wrong address AND wrong
   * timestamp — both change the hash).  Resets the entire chain if mismatch
   * is detected, regardless of current height.
   */
  _verifyGenesisIntegrity() {
    const cfgPath = path.join(this._dataDir, GENESIS_CFG_FILE);
    try {
      if (!fs.existsSync(cfgPath)) return;
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (!Array.isArray(raw.teamWallets) || raw.teamWallets.length === 0) return;

      const storedGenesis = this._chain.getBlock(0);
      if (!storedGenesis) return;

      // Recompute what the canonical genesis hash should be and compare.
      // This catches both wrong-address and wrong-timestamp divergence.
      const { computeBlockHash, computeTxsHash } = require('./wtc-chain');
      const rewardAddresses = {};
      for (const { address, amount } of raw.teamWallets) {
        rewardAddresses[address] = (rewardAddresses[address] || 0) + amount;
      }
      const canonicalFields = {
        height: 0,
        prevHash: '0'.repeat(64),
        timestamp: raw.timestamp,
        proposer: 'genesis',
        energyWh: 0,
        proofCommitment: '',
        txsHash: computeTxsHash([]),
        rewardTotal: GENESIS_PREMINE,
        stateRoot: '',
      };
      const canonicalHash = computeBlockHash(canonicalFields);

      if (storedGenesis.hash !== canonicalHash) {
        console.warn(
          '[WtcNode] Genesis hash mismatch — local genesis does not match canonical config. ' +
            `Stored: ${storedGenesis.hash.slice(0, 16)}... Expected: ${canonicalHash.slice(0, 16)}...` +
            (this._chain.getHeight() > 0 ? ` (chain height ${this._chain.getHeight()} will be reset)` : ''),
        );
        console.warn('[WtcNode] Resetting chain to re-initialize with correct genesis...');
        this._chain.reset();
        this._accounts.rebuildFromBlocks([]);
        this._nfts.rebuildFromBlocks([]);
        this._initGenesis();
      }
    } catch (e) {
      console.warn('[WtcNode] Genesis integrity check error:', e && e.message);
    }
  }

  // ─── Chain queries ────────────────────────────────────────────────────────

  getHeight() {
    return this._chain.getHeight();
  }
  getTip() {
    return this._chain.getTip();
  }
  getBlock(height) {
    return this._chain.getBlock(height);
  }

  /**
   * Balance for any address.
   * @returns {{ confirmed, unmatured, total, nonce }}
   */
  getBalance(address) {
    return this._accounts.getBalance(address);
  }

  /**
   * Returns the readiness object expected by the Wattcoin UI.
   * Shape mirrors the old wattcoin-get-wallet-readiness response.
   */
  async getWalletReadiness() {
    const localHeight = this._chain.getHeight();
    const consensusStatus =
      this._consensus && typeof this._consensus.getStatus === 'function' ? this._consensus.getStatus() : null;
    const knownPeers = consensusStatus ? Math.max(0, Number(consensusStatus.activePeers) || 0) : 0;
    let connections = 0;
    const countedPeerKeys = new Set();

    let bestPeerHeight = localHeight;
    let bestPeer = '';

    if (this._consensus && typeof this._consensus.requestPeerJson === 'function') {
      const now = Date.now();
      const activePeers =
        knownPeers > 0 && typeof this._consensus.getActivePeers === 'function'
          ? this._consensus.getActivePeers() || []
          : [];
      const directoryPeers = this._getPeerTargets ? this._getPeerTargets() || [] : [];
      const peers = Array.from(new Set([...activePeers, ...directoryPeers]));
      const preferredHttpPeers = [];
      const deferredHttpPeers = [];
      const classifyPeer = (peerUrl, httpPeerList) => {
        // Fast-path: locally-served tunnel peers — WebSocket session liveness
        // avoids the HTTP round-trip through the tunnel proxy that can
        // timeout under mining load and drop reachable-peers to 0.
        if (this._isLiveLocalTunnelPeer) {
          const tunnelInfo = this._isLiveLocalTunnelPeer(peerUrl);
          if (tunnelInfo && tunnelInfo.live) {
            const peerIdentity = String(tunnelInfo.peerIdentity || '').trim();
            if (this._isPeerSelfReference(peerUrl, peerIdentity)) return;
            const peerKey = peerIdentity || String(peerUrl || '').trim();
            if (!countedPeerKeys.has(peerKey)) {
              countedPeerKeys.add(peerKey);
              connections += 1;
            }
            return;
          }
        }
        httpPeerList.push(peerUrl);
      };

      for (const peerUrl of peers) {
        if (this._isPeerInFailureBackoff(peerUrl, now)) {
          classifyPeer(peerUrl, deferredHttpPeers);
          continue;
        }
        classifyPeer(peerUrl, preferredHttpPeers);
      }

      const probePeer = async (peerUrl) => {
        try {
          const tipRes = await this._consensus.requestPeerJson(
            peerUrl,
            'GET',
            '/api/v1/chain/tip',
            undefined,
            undefined,
            {
              timeoutMs: PEER_CHAIN_TIP_TIMEOUT_MS,
              trackReachability: false,
              source: 'wallet-readiness',
            },
          );
          if (!tipRes || !tipRes.ok) {
            this._recordPeerFailure(peerUrl);
            return;
          } else {
            this._clearPeerFailure(peerUrl);
          }
          const peerIdentity = typeof tipRes.peerIdentity === 'string' ? tipRes.peerIdentity.trim() : '';
          if (this._isPeerSelfReference(peerUrl, peerIdentity)) {
            return;
          }
          const peerKey = peerIdentity || String(peerUrl || '').trim();
          if (!countedPeerKeys.has(peerKey)) {
            countedPeerKeys.add(peerKey);
            connections += 1;
          }
          const peerHeight = Number(tipRes.height);
          if (!Number.isFinite(peerHeight)) return;
          if (this._onPeerTip) {
            try {
              this._onPeerTip(peerUrl, tipRes);
            } catch (_) {
              // Best-effort discovery promotion only.
            }
          }
          if (peerHeight > bestPeerHeight) {
            bestPeerHeight = peerHeight;
            bestPeer = peerUrl;
          }
        } catch (_) {
          this._recordPeerFailure(peerUrl);
          // Ignore transient peer probe failures in readiness snapshots.
        }
      };

      const probePeers = async (peerUrls) => {
        for (let index = 0; index < peerUrls.length; index += PEER_READINESS_PROBE_CONCURRENCY) {
          const batch = peerUrls.slice(index, index + PEER_READINESS_PROBE_CONCURRENCY);
          await Promise.all(batch.map(probePeer));
        }
      };

      await probePeers(preferredHttpPeers);
      if (connections === 0 && deferredHttpPeers.length > 0) {
        await probePeers(deferredHttpPeers);
      }
    }

    const connectedPeerCount = this._getConnectedPeerCount
      ? Math.max(0, Number(this._getConnectedPeerCount()) || 0)
      : 0;
    connections = Math.max(connections, connectedPeerCount);

    const networkHeight = Math.max(localHeight, bestPeerHeight);
    const lagBlocks = Math.max(0, networkHeight - localHeight);
    const syncing = lagBlocks > 0 || this._syncInProgress;
    const reachableButNotAhead = connections > 0 && lagBlocks === 0;
    const verificationProgress =
      networkHeight < 0 ? 0 : Math.max(0, Math.min(1, (localHeight + 1) / (networkHeight + 1)));

    return {
      ok: true,
      rpcReachable: true,
      network: 'wtc-mainnet',
      blocks: networkHeight,
      headers: networkHeight,
      localBlocks: localHeight,
      bestPeerHeight,
      bestPeer,
      lagBlocks,
      connections,
      reachableButNotAhead,
      verificationProgress,
      initialBlockDownload: syncing,
      scanning: this._syncInProgress,
      spendReady: localHeight >= 0 && lagBlocks === 0 && connections > 0,
      status: syncing ? 'syncing' : 'ready',
      message: syncing ? `Syncing blocks ${localHeight} -> ${networkHeight}` : 'WTC native chain ready.',
    };
  }

  /**
   * Transactions involving an address, most-recent first.
   * Returns both transfers and mining reward credits.
   */
  listTransactions(address, count = 50) {
    return this._chain.listTransactions(address, count);
  }

  /**
   * Aggregate mining statistics for an address (block count, WTC earned).
   * Used by MiningLog and the main UI stats panel.
   */
  getMinedStats(address) {
    return this._chain.getMinedStats(address);
  }

  /** true if addr is a valid bech32m wtc1... address. */
  validateAddress(addr) {
    return isValidAddress(addr);
  }

  /** Number of transactions currently waiting in the mempool. */
  getMempoolSize() {
    return this._mempool.size();
  }

  /**
   * Check whether a transaction has been confirmed, is still pending, or is unknown.
   * @returns {{ status: 'confirmed' | 'pending' | 'unknown' }}
   */
  getTxStatus(txid) {
    if (!txid) return { status: 'unknown' };
    // Check mempool first (fast path)
    if (this._mempool.has(txid)) return { status: 'pending' };
    // Search chain blocks for confirmation
    const height = this._chain.getHeight();
    for (let h = height; h >= 0; h--) {
      const block = this._chain.getBlock(h);
      if (!block) continue;
      if ((block.transactions || []).some((tx) => tx.id === txid)) {
        return { status: 'confirmed' };
      }
    }
    return { status: 'unknown' };
  }

  // ─── Mining ───────────────────────────────────────────────────────────────

  /**
   * Propose, BFT-vote, and commit a new block.
   *
   * Replaces: runCli(['generateblock', ...]) in electron-main.js
   *
   * @param {string} proposerAddress   — wtc1... address to receive the reward
   * @param {{ energyWh?: number, proofCommitment?: string, peerProbeVerified?: boolean, probeReceipt?: object|null }} proofData
   *   energyWh:        Watt-hours accumulated this round (from backend-benchmark)
   *   proofCommitment: round proof hash (from round-ledger settleCurrentRound)
   * @param {{ [address: string]: number }} rewardMap
   *   Optional proportional reward distribution { address→WTC }.
   *   Pass the object produced by round-ledger.settleCurrentRound().contributions
   *   for accurate per-contributor payouts.  Defaults to 100% to proposerAddress.
   *
   * @returns {Promise<{ ok, height, hash, address, reward, votes }>}
   */
  async mineBlock(proposerAddress, proofData = {}, rewardMap = null) {
    if (!this._consensus) throw new Error('WtcNode not initialized — call init() first');

    // Resolve which wallet key to use
    const address = this._wallet.keys.some((k) => k.address === proposerAddress)
      ? proposerAddress
      : this._wallet.primaryKey.address;

    const energyWh = Number(proofData.energyWh) || 0;
    const proofCommitment = String(proofData.proofCommitment || '').trim();
    const peerProbeVerified = !!proofData.peerProbeVerified;
    const probeReceipt =
      proofData.probeReceipt && typeof proofData.probeReceipt === 'object'
        ? JSON.parse(JSON.stringify(proofData.probeReceipt))
        : null;

    const reward = this._chain.nextBlockReward();
    const rewardAddresses =
      rewardMap && Object.keys(rewardMap).length > 0 ? rewardMap : reward > 0 ? { [address]: reward } : {};

    // Compute nftsRoot from current NFT state (before this block is applied)
    const nftsRoot = this._nfts.computeStateHash();

    // Pull valid transactions from the mempool for this block.
    // Deduplicate by (from, nonce) — keeps only the first valid tx per sender
    // slot, preventing same-nonce double-inclusion by a malicious proposer.
    const seenNonces = new Map(); // `${from}:${nonce}` → true
    const transactions = this._mempool.getTxs(50).filter((tx) => {
      if (!this._isTxValid(tx)) return false;
      const key = `${tx.from}:${tx.nonce}`;
      if (seenNonces.has(key)) return false;
      seenNonces.set(key, true);
      return true;
    });

    const committed = await this._consensus.proposeBlock({
      proposer: address,
      energyWh,
      proofCommitment,
      peerProbeVerified,
      probeReceipt,
      transactions,
      rewardAddresses,
      nftsRoot,
    });

    if (!committed || committed.ok === false) {
      const reason = committed && committed.reason ? committed.reason : 'consensus rejected block';
      throw new Error(reason);
    }

    const committedTxIds = (committed.transactions || []).map((t) => t.id);
    for (const txid of committedTxIds) {
      this._removePendingTx(txid);
    }

    return {
      ok: true,
      height: committed.height,
      hash: committed.hash,
      address,
      reward,
      votes: Object.keys(committed.votes || {}).length,
    };
  }

  // ─── Transactions ─────────────────────────────────────────────────────────

  /**
   * Build, sign, and add a transfer transaction to the mempool.
   *
   * Replaces: runCli(['sendtoaddress', ...]) in electron-main.js
   *
   * @param {{ fromAddress, toAddress, amount, subtractFeeFromAmount? }} opts
   * @returns {{ ok, txid, from, to, amount, fee }}
   */
  send({ fromAddress, toAddress, amount, subtractFeeFromAmount = false }) {
    if (!isValidAddress(toAddress)) throw new Error(`Invalid recipient address: ${toAddress}`);
    if (!isValidAddress(fromAddress)) throw new Error(`Invalid sender address: ${fromAddress}`);

    const kp = this._wallet.keys.find((k) => k.address === fromAddress);
    if (!kp) throw new Error(`Address ${fromAddress} not found in this wallet`);

    const fee = 0.01;
    const sendAmount = subtractFeeFromAmount ? amount - fee : amount;
    if (sendAmount <= 0) throw new Error('Amount too small');

    const balance = this._accounts.getBalance(fromAddress);
    if (balance.confirmed < sendAmount + fee) {
      throw new Error(`Insufficient confirmed balance: ${balance.confirmed.toFixed(8)} WTC available`);
    }

    const nonce = balance.nonce;
    const tx = Mempool.buildTx({ from: fromAddress, to: toAddress, amount: sendAmount, fee, nonce });

    // Sign the transaction — cover id (which binds timestamp) so a peer
    // cannot reassign a different timestamp to reuse this signature.
    const privBuf = Buffer.from(kp.privateKey, 'hex');
    const sigInput = JSON.stringify({
      id: tx.id,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      fee: tx.fee,
      nonce: tx.nonce,
    });
    tx.sig = sign(txHash(sigInput), privBuf);

    const result = this._mempool.add(tx);
    if (!result.ok) throw new Error(result.message);

    return { ok: true, txid: tx.id, from: tx.from, to: tx.to, amount: tx.amount, fee: tx.fee };
  }

  // ─── Message signing ──────────────────────────────────────────────────────

  /**
   * Sign an arbitrary message with an address's private key.
   * Useful for proving address ownership in peer handshakes.
   * @returns {{ address, message, signature }}
   */
  signMessage(address, message) {
    const kp = this._wallet.keys.find((k) => k.address === address);
    if (!kp) throw new Error(`Address ${address} not in wallet`);
    const privBuf = Buffer.from(kp.privateKey, 'hex');
    const sig = sign(txHash('\x18Wattcoin Signed Message:\n' + message), privBuf);
    return { address, message, signature: `${sig.r}${sig.s}${String(sig.v).padStart(2, '0')}` };
  }

  /**
   * Verify a message signature produced by signMessage().
   * @returns {boolean}
   */
  verifyMessage(address, signature, message) {
    try {
      const r = signature.slice(0, 64);
      const s = signature.slice(64, 128);
      const v = parseInt(signature.slice(128), 10);
      return verifySignature(txHash('\x18Wattcoin Signed Message:\n' + message), { r, s, v }, address);
    } catch (_) {
      return false;
    }
  }

  // ─── Consensus HTTP handlers (wire into ledger server) ─────────────────

  /**
   * Called by the HTTP server when a peer POSTs /api/v1/chain/propose.
   * @param {object} block    parsed JSON body
   * @param {string} fromPeer peer base URL from request headers
   */
  handleProposal(block, fromPeer) {
    if (!this._consensus) return { ok: false, reason: 'node not initialized' };
    return this._consensus.receiveProposal(block, fromPeer);
  }

  /**
   * Called by the HTTP server when a peer POSTs /api/v1/chain/vote.
   * @param {{ blockHash, voter, sig }} voteData parsed JSON body
   */
  handleVote(voteData) {
    if (!this._consensus) return { ok: false, reason: 'node not initialized' };
    return this._consensus.receiveVote(voteData);
  }

  /**
   * Called by the HTTP server for GET /api/v1/chain/tip.
   * @returns {{ ok, height, tip }}
   */
  handleGetTip() {
    const tip = this._chain.getTip();
    const genesis = this._chain.getBlock(0);
    return {
      ok: true,
      height: this._chain.getHeight(),
      tip,
      peerIdentity: this.getPeerIdentity(),
      networkId: 'wtc-mainnet',
      protocolVersion: CHAIN_PROTOCOL_VERSION,
      minSupportedVersion: CHAIN_PROTOCOL_VERSION,
      genesisHash: genesis ? genesis.hash : '',
    };
  }

  /**
   * Called by peer API for GET /api/v1/chain/headers
   */
  handleGetHeaders(fromHeight = 0, limit = 200) {
    return {
      ok: true,
      fromHeight: Math.max(0, Math.floor(Number(fromHeight) || 0)),
      headers: this._chain.getHeaders(fromHeight, limit),
      tipHeight: this._chain.getHeight(),
    };
  }

  /**
   * Called by peer API for GET /api/v1/chain/blocks
   */
  handleGetBlocks(fromHeight = 0, limit = 100) {
    return {
      ok: true,
      fromHeight: Math.max(0, Math.floor(Number(fromHeight) || 0)),
      blocks: this._chain.getBlocks(fromHeight, limit),
      tipHeight: this._chain.getHeight(),
    };
  }

  /**
   * Called by peer API for GET /api/v1/chain/block/:hash
   */
  handleGetBlockByHash(hash = '') {
    const key = typeof hash === 'string' ? hash.trim() : '';
    if (!key) return { ok: false, reason: 'missing hash' };
    const block = this._chain.getBlockByHash(key);
    if (!block) return { ok: false, reason: 'not found' };
    return { ok: true, block };
  }

  /**
   * Accept a forward-only pushed chain extension from a peer that we may not be
   * able to call back directly (for example behind NAT/VPN). The extension is
   * only applied when it cleanly extends a known local ancestor and validates.
   */
  handlePushBlocks({ ancestorHeight = -1, blocks = [], peer = '' } = {}) {
    const normalizedAncestor = Math.max(-1, Math.floor(Number(ancestorHeight) || -1));
    const incomingBlocks = Array.isArray(blocks) ? blocks.map((block) => JSON.parse(JSON.stringify(block))) : [];
    if (incomingBlocks.length === 0) {
      return { ok: false, reason: 'missing pushed blocks' };
    }

    const firstBlock = incomingBlocks[0];
    const lastBlock = incomingBlocks[incomingBlocks.length - 1];
    const localHeight = this._chain.getHeight();

    if (!firstBlock || !lastBlock) {
      return { ok: false, reason: 'invalid pushed block payload' };
    }
    if (Number(firstBlock.height) !== normalizedAncestor + 1) {
      return {
        ok: false,
        reason: `pushed blocks do not start after ancestor ${normalizedAncestor}`,
      };
    }
    if ((Number(lastBlock.height) || -1) <= localHeight) {
      return {
        ok: true,
        skipped: true,
        reason: 'pushed chain not ahead of local height',
        localHeight,
      };
    }

    const prefix = normalizedAncestor >= 0 ? this._chain.getAllBlocks().slice(0, normalizedAncestor + 1) : [];
    const ancestorBlock = normalizedAncestor >= 0 ? this._chain.getBlock(normalizedAncestor) : null;

    if (normalizedAncestor >= 0 && !ancestorBlock) {
      return { ok: false, reason: `missing local ancestor at height ${normalizedAncestor}` };
    }
    if (normalizedAncestor >= 0 && firstBlock.prevHash !== ancestorBlock.hash) {
      return { ok: false, reason: 'pushed blocks do not extend local chain' };
    }

    const candidate = prefix.concat(incomingBlocks);
    const check = this._chain.validateSequence(candidate);
    if (!check.ok) {
      return { ok: false, reason: `candidate chain invalid: ${check.reason}` };
    }

    const rollbackDepth = Math.max(0, localHeight - normalizedAncestor);
    const rebuildResult = this._accounts.rebuildFromBlocks(candidate, {
      allowLegacyStateRootMismatch: true,
    });
    const legacyStateRootMismatches = Array.isArray(rebuildResult && rebuildResult.legacyStateRootMismatches)
      ? rebuildResult.legacyStateRootMismatches
      : [];
    if (legacyStateRootMismatches.length > 0) {
      console.warn(
        `[WtcNode] Accepted ${legacyStateRootMismatches.length} legacy stateRoot mismatch(es) ` +
          `during pushed chain rebuild from ${String(peer || '')}; first at height ${legacyStateRootMismatches[0].height}`,
      );
    }
    this._nfts.rebuildFromBlocks(candidate);
    this._chain.replaceWithBlocks(candidate);
    if (this._consensus && typeof this._consensus.resetTracking === 'function') {
      this._consensus.resetTracking();
    }

    return {
      ok: true,
      synced: true,
      fromHeight: localHeight,
      toHeight: this._chain.getHeight(),
      ancestor: normalizedAncestor,
      rollbackDepth,
      imported: incomingBlocks.length,
      peer: String(peer || ''),
      mode: 'push',
    };
  }

  _getTrustedBootstrapPeers() {
    if (!this._getTrustedPeerTargets) return [];
    try {
      const peers = this._getTrustedPeerTargets() || [];
      return Array.from(
        new Set((Array.isArray(peers) ? peers : []).map((peerUrl) => String(peerUrl || '').trim()).filter(Boolean)),
      );
    } catch (_) {
      return [];
    }
  }

  async _findBestPeer(peers = [], { localHeight = this._chain.getHeight(), localTipHash = '' } = {}) {
    let bestPeer = null;
    let bestHeight = localHeight;
    let bestTipHash = localTipHash || '';
    let reachableCount = 0;
    const now = Date.now();

    for (const peerUrl of peers) {
      if (this._isPeerInFailureBackoff(peerUrl, now)) continue;
      // Locally-served tunnel peers: count as reachable via WS liveness,
      // skip the HTTP round-trip which can timeout under mining load.
      if (this._isLiveLocalTunnelPeer) {
        const tunnelInfo = this._isLiveLocalTunnelPeer(peerUrl);
        // Removed TunnelDebug log to reduce terminal spam
        if (tunnelInfo && tunnelInfo.live) {
          const peerIdentity = String(tunnelInfo.peerIdentity || '').trim();
          if (this._isPeerSelfReference(peerUrl, peerIdentity)) continue;
          reachableCount += 1;
          continue;
        }
      }
      try {
        const tipRes = await this._consensus.requestPeerJson(
          peerUrl,
          'GET',
          '/api/v1/chain/tip',
          undefined,
          undefined,
          {
            timeoutMs: PEER_CHAIN_TIP_TIMEOUT_MS,
            trackReachability: false,
            source: 'sync-best-peer',
          },
        );
        if (!tipRes || !tipRes.ok) continue;
        this._clearPeerFailure(peerUrl);
        reachableCount += 1;
        const h = Number(tipRes.height);
        const tipHash = tipRes && tipRes.tip ? String(tipRes.tip.hash || '') : '';
        if (!Number.isFinite(h)) continue;
        if (h > bestHeight || (h === bestHeight && tipHash && tipHash > bestTipHash)) {
          bestHeight = h;
          bestTipHash = tipHash;
          bestPeer = peerUrl;
        }
      } catch (e) {
        const fail = this._recordPeerFailure(peerUrl);
        if (fail.count === WtcNode.PEER_FAILURE_THRESHOLD) {
          console.warn(
            `[WtcNode] Peer ${peerUrl} unreachable during tip poll (${fail.count} consecutive failures, backing off 30s):`,
            e && e.message,
          );
        }
      }
    }

    return {
      peer: bestPeer,
      height: bestHeight,
      tipHash: bestTipHash,
      reachableCount,
    };
  }

  async _findTrustedPeerAtSameHeight({ localHeight = this._chain.getHeight(), localTipHash = '' } = {}) {
    const trustedPeers = this._getTrustedBootstrapPeers();
    if (trustedPeers.length === 0) {
      return {
        peer: null,
        height: localHeight,
        tipHash: localTipHash || '',
      };
    }

    for (const peerUrl of trustedPeers) {
      if (this._isPeerInFailureBackoff(peerUrl)) continue;
      // Skip locally-served tunnel peers: same-height comparison needs
      // the peer's actual tip hash which requires HTTP, but the round-trip
      // can timeout under mining load.  Fork detection will rely on
      // non-tunnel trusted peers or subsequent sync cycles.
      if (this._isLiveLocalTunnelPeer) {
        const tunnelInfo = this._isLiveLocalTunnelPeer(peerUrl);
        if (tunnelInfo && tunnelInfo.live) continue;
      }
      try {
        const tipRes = await this._consensus.requestPeerJson(
          peerUrl,
          'GET',
          '/api/v1/chain/tip',
          undefined,
          undefined,
          {
            timeoutMs: PEER_CHAIN_TIP_TIMEOUT_MS,
            trackReachability: false,
            source: 'sync-same-height',
          },
        );
        if (!tipRes || !tipRes.ok) continue;
        this._clearPeerFailure(peerUrl);
        const peerHeight = Number(tipRes.height);
        const peerTipHash = tipRes && tipRes.tip ? String(tipRes.tip.hash || '') : '';
        if (!Number.isFinite(peerHeight) || peerHeight !== localHeight) continue;
        if (!peerTipHash || peerTipHash === localTipHash) continue;
        return {
          peer: peerUrl,
          height: peerHeight,
          tipHash: peerTipHash,
        };
      } catch (e) {
        const fail = this._recordPeerFailure(peerUrl);
        if (fail.count === WtcNode.PEER_FAILURE_THRESHOLD) {
          console.warn(
            `[WtcNode] Trusted peer ${peerUrl} unreachable during same-height poll (${fail.count} consecutive failures, backing off 30s):`,
            e && e.message,
          );
        }
      }
    }

    return {
      peer: null,
      height: localHeight,
      tipHash: localTipHash || '',
    };
  }

  async _fetchPeerBlocks(peerUrl, fromHeight, toHeightInclusive) {
    const imported = [];
    const targetHeight = Math.max(-1, Math.floor(Number(toHeightInclusive) || -1));
    let nextHeight = Math.max(0, Math.floor(Number(fromHeight) || 0));
    const BATCH = 200;

    while (nextHeight <= targetHeight) {
      const remaining = targetHeight - nextHeight + 1;
      const limit = Math.min(BATCH, remaining);
      let peerBlocksRes;
      try {
        peerBlocksRes = await this._consensus.requestPeerJson(
          peerUrl,
          'GET',
          '/api/v1/chain/blocks',
          undefined,
          {
            fromHeight: nextHeight,
            limit,
          },
          {
            timeoutMs: PEER_CHAIN_FETCH_TIMEOUT_MS,
            trackReachability: false,
            source: 'sync-block-fetch',
          },
        );
      } catch (e) {
        return { ok: false, reason: `peer block fetch failed: ${e && e.message}` };
      }
      const batch = peerBlocksRes && Array.isArray(peerBlocksRes.blocks) ? peerBlocksRes.blocks : [];
      if (batch.length === 0) {
        return { ok: false, reason: 'peer returned empty block batch' };
      }
      imported.push(...batch);
      nextHeight += batch.length;
    }

    return { ok: true, blocks: imported };
  }

  _applyCandidateChain(candidate, { localHeight, peer, ancestor, imported, mode = 'pull', recoveryReason = '' } = {}) {
    const check = this._chain.validateSequence(candidate);
    if (!check.ok) {
      return { ok: false, reason: `candidate chain invalid: ${check.reason}` };
    }

    const rollbackDepth = ancestor >= 0 ? Math.max(0, localHeight - ancestor) : Math.max(0, localHeight + 1);
    if (rollbackDepth > 0) {
      const localTip = this._chain.getTip();
      console.warn(
        `[WtcNode] Chain replacement requires rollback depth=${rollbackDepth} ` +
          `localTip=${localTip && localTip.hash ? localTip.hash.slice(0, 16) : ''}... ` +
          `peer=${String(peer || '')}`,
      );
    }

    const accountsSnapshot = this._accounts.snapshot();
    const rebuildResult = this._accounts.rebuildFromBlocks(candidate, {
      allowLegacyStateRootMismatch: true,
    });
    const legacyStateRootMismatches = Array.isArray(rebuildResult && rebuildResult.legacyStateRootMismatches)
      ? rebuildResult.legacyStateRootMismatches
      : [];
    if (legacyStateRootMismatches.length > 0) {
      console.warn(
        `[WtcNode] Accepted ${legacyStateRootMismatches.length} legacy stateRoot mismatch(es) ` +
          `during ${mode} chain rebuild from ${String(peer || '')}; first at height ${legacyStateRootMismatches[0].height}`,
      );
    }
    try {
      this._nfts.rebuildFromBlocks(candidate);
    } catch (e) {
      this._accounts.restoreSnapshot(accountsSnapshot);
      return { ok: false, reason: `NFT rebuild failed after accounts rebuild — rolled back: ${e.message}` };
    }
    this._chain.replaceWithBlocks(candidate);
    if (this._consensus && typeof this._consensus.resetTracking === 'function') {
      this._consensus.resetTracking();
    }

    return {
      ok: true,
      synced: true,
      fromHeight: localHeight,
      toHeight: this._chain.getHeight(),
      peer: String(peer || ''),
      ancestor,
      rollbackDepth,
      imported,
      mode,
      ...(recoveryReason ? { recoveryReason } : {}),
    };
  }

  _isRecoverableSyncFailure(reason = '') {
    const message = String(reason || '')
      .trim()
      .toLowerCase();
    if (!message) return false;
    return (
      message.includes('no common ancestor') ||
      message.includes('candidate chain invalid') ||
      message.includes('peer returned empty block batch')
    );
  }

  async _bootstrapFromTrustedPeer(peerUrl, peerHeight, localHeight, recoveryReason = '') {
    const fetched = await this._fetchPeerBlocks(peerUrl, 0, peerHeight);
    if (!fetched.ok) {
      return {
        ok: false,
        reason: `trusted bootstrap failed: ${fetched.reason}`,
        peer: peerUrl,
        recoveryReason,
      };
    }
    return this._applyCandidateChain(fetched.blocks, {
      localHeight,
      peer: peerUrl,
      ancestor: -1,
      imported: fetched.blocks.length,
      mode: 'trusted-bootstrap',
      recoveryReason,
    });
  }

  async _tryTrustedBootstrapFallback({
    reason = '',
    bestPeer = '',
    _bestHeight = -1,
    localHeight = -1,
    localTipHash = '',
  } = {}) {
    if (!this._isRecoverableSyncFailure(reason)) {
      return null;
    }
    const trustedPeers = this._getTrustedBootstrapPeers();
    if (trustedPeers.length === 0) {
      return null;
    }

    const trustedBest = await this._findBestPeer(Array.from(new Set([bestPeer, ...trustedPeers].filter(Boolean))), {
      localHeight,
      localTipHash,
    });
    if (!trustedBest.peer || trustedBest.height <= localHeight || !trustedPeers.includes(trustedBest.peer)) {
      return null;
    }

    console.warn(`[WtcNode] Falling back to trusted bootstrap from ${trustedBest.peer} after sync failure: ${reason}`);
    return this._bootstrapFromTrustedPeer(trustedBest.peer, trustedBest.height, localHeight, reason);
  }

  /**
   * Catch up to the best peer chain deterministically.
   * Safe to call periodically; no-op if already in sync.
   */
  async syncWithPeers() {
    if (!this._consensus) return { ok: false, reason: 'node not initialized' };
    if (this._syncInProgress) return { ok: true, skipped: true, reason: 'sync already in progress' };

    this._syncInProgress = true;
    try {
      const activePeers = (this._consensus.getActivePeers && this._consensus.getActivePeers()) || [];
      const directoryPeers = this._getPeerTargets ? this._getPeerTargets() || [] : [];
      const peers = Array.from(
        new Set([
          ...activePeers,
          // Bootstrap sync must still work on fresh nodes before any peer has been
          // promoted into the active discovered set.
          ...directoryPeers,
        ]),
      );
      if (!Array.isArray(peers) || peers.length === 0) {
        return { ok: true, skipped: true, reason: 'no peers' };
      }

      const localHeight = this._chain.getHeight();
      const localTip = this._chain.getTip();
      const localTipHash = localTip ? localTip.hash : '';

      const best = await this._findBestPeer(peers, {
        localHeight,
        localTipHash,
      });
      let bestPeer = best.peer;
      let bestHeight = best.height;
      let bestTipHash = best.tipHash;
      const reachablePeerCount = Number(best.reachableCount) || 0;
      let trustedSameHeightPeer = null;

      if (!bestPeer && localTipHash) {
        trustedSameHeightPeer = await this._findTrustedPeerAtSameHeight({
          localHeight,
          localTipHash,
        });
        if (trustedSameHeightPeer.peer) {
          bestPeer = trustedSameHeightPeer.peer;
          bestHeight = trustedSameHeightPeer.height;
          bestTipHash = trustedSameHeightPeer.tipHash;
        }
      }

      if (!bestPeer) {
        return {
          ok: true,
          skipped: true,
          reason: reachablePeerCount > 0 ? 'reachable peers online but none ahead' : 'no reachable sync peers',
          localHeight,
          reachablePeers: reachablePeerCount,
        };
      }

      const peerBeatsLocal =
        bestHeight > localHeight ||
        (bestHeight === localHeight &&
          bestTipHash &&
          (bestTipHash > localTipHash ||
            (trustedSameHeightPeer && trustedSameHeightPeer.peer && bestTipHash !== localTipHash)));
      if (!peerBeatsLocal) {
        return {
          ok: true,
          skipped: true,
          reason: 'reachable peers online but none ahead',
          localHeight,
          reachablePeers: reachablePeerCount,
          bestPeer,
          bestPeerHeight: bestHeight,
        };
      }

      // Find common ancestor by descending hash comparison.
      const maxCommon = Math.min(localHeight, bestHeight);
      let ancestor = -1;
      for (let h = maxCommon; h >= 0; h--) {
        const localBlock = this._chain.getBlock(h);
        if (!localBlock) continue;
        let peerHeaderRes;
        try {
          peerHeaderRes = await this._consensus.requestPeerJson(
            bestPeer,
            'GET',
            '/api/v1/chain/headers',
            undefined,
            { fromHeight: h, limit: 1 },
            {
              trackReachability: false,
              source: 'sync-ancestor-scan',
            },
          );
        } catch (e) {
          return { ok: false, reason: `peer header fetch failed during ancestor scan: ${e && e.message}` };
        }
        const peerHeader = peerHeaderRes && Array.isArray(peerHeaderRes.headers) ? peerHeaderRes.headers[0] : null;
        if (peerHeader && peerHeader.hash === localBlock.hash) {
          ancestor = h;
          break;
        }
      }

      if (ancestor < 0) {
        const failure = { ok: false, reason: 'no common ancestor with peer chain', peer: bestPeer };
        const fallback = await this._tryTrustedBootstrapFallback({
          reason: failure.reason,
          bestPeer,
          bestHeight,
          localHeight,
          localTipHash,
        });
        return fallback || failure;
      }

      const prefix = this._chain.getAllBlocks().slice(0, ancestor + 1);
      const fetched = await this._fetchPeerBlocks(bestPeer, ancestor + 1, bestHeight);
      if (!fetched.ok) {
        const fallback = await this._tryTrustedBootstrapFallback({
          reason: fetched.reason,
          bestPeer,
          bestHeight,
          localHeight,
          localTipHash,
        });
        return fallback || fetched;
      }

      const candidate = prefix.concat(fetched.blocks);
      const syncResult = this._applyCandidateChain(candidate, {
        localHeight,
        peer: bestPeer,
        ancestor,
        imported: fetched.blocks.length,
        mode: 'pull',
      });
      if (syncResult.ok) {
        return syncResult;
      }

      const fallback = await this._tryTrustedBootstrapFallback({
        reason: syncResult.reason,
        bestPeer,
        bestHeight,
        localHeight,
        localTipHash,
      });
      if (fallback && fallback.ok) {
        return fallback;
      }

      return syncResult;
    } finally {
      this._syncInProgress = false;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /** Lightweight mempool tx validation before block inclusion. */
  _isTxValid(tx) {
    if (!tx.from || !tx.to || !tx.sig) return false;
    // Delegate NFT transaction validation to NftStore
    if (tx.type === 'nft_mint' || tx.type === 'nft_transfer') {
      return this._nfts.validateTx(tx);
    }
    if (tx.type === 'governance_result') {
      return this._governance.validateTx(tx);
    }
    const balance = this._accounts.getBalance(tx.from);
    if (balance.confirmed < tx.amount + (tx.fee || 0)) return false;
    if (balance.nonce > tx.nonce) return false;
    try {
      const sigFields = {
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        fee: tx.fee,
        nonce: tx.nonce,
      };
      if (tx.governanceTransferRef) {
        sigFields.governanceTransferRef = tx.governanceTransferRef;
      }
      const sigInput = JSON.stringify(sigFields);
      return verifySignature(txHash(sigInput), tx.sig, tx.from);
    } catch (_) {
      return false;
    }
  }

  // ─── NFT ─────────────────────────────────────────────────────────────────────────────

  /**
   * Query NFTs owned by an address.
   * @returns {Array<{nftId, owner, metadata, mintedAtHeight}>}
   */
  getNftsForAddress(addr) {
    return this._nfts.getNftsForAddress(addr);
  }

  /** Return a single NFT by id, or null. */
  getNft(nftId) {
    return this._nfts.getNft(nftId);
  }

  /** Return the full 60-token collection with current ownership. */
  getAllNfts() {
    return this._nfts.getAllNfts();
  }

  /**
   * Build, sign, and submit an nft_transfer transaction to the mempool.
   * The fromAddress must be in this wallet and must currently own the NFT.
   *
   * @param {{ nftId: string, fromAddress: string, toAddress: string }} opts
   * @returns {{ ok, txid }}
   */
  transferNft({ nftId, fromAddress, toAddress }) {
    if (!isValidAddress(toAddress)) throw new Error(`Invalid recipient address: ${toAddress}`);
    if (!isValidAddress(fromAddress)) throw new Error(`Invalid sender address: ${fromAddress}`);

    const kp = this._wallet.keys.find((k) => k.address === fromAddress);
    if (!kp) throw new Error(`Address ${fromAddress} not found in this wallet`);

    const token = this._nfts.getNft(nftId);
    if (!token) throw new Error(`NFT ${nftId} not found`);
    if (token.owner !== fromAddress) throw new Error(`${fromAddress} does not own ${nftId}`);

    const nonce = this._nfts.getNonce(fromAddress);
    const tx = NftStore.buildTransferTx({ nftId, from: fromAddress, to: toAddress, nonce });

    const privBuf = Buffer.from(kp.privateKey, 'hex');
    const sigInput = JSON.stringify({
      id: tx.id,
      type: tx.type,
      nftId: tx.nftId,
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
    });
    tx.sig = sign(txHash(sigInput), privBuf);

    const result = this._mempool.add(tx);
    if (!result.ok) throw new Error(result.message);
    this._addPendingTx(tx);

    return { ok: true, txid: tx.id, nftId, from: fromAddress, to: toAddress };
  }

  /**
   * Build, sign, and submit a single nft_mint transaction to the mempool.
   * The MINTER_ADDRESS private key must be in this wallet.
   *
   * @param {{ nftId: string, to: string }} opts
   * @returns {{ ok, txid }}
   */
  mintNft({ nftId, to }) {
    if (!isValidAddress(to)) throw new Error(`Invalid recipient address: ${to}`);

    const kp = this._wallet.keys.find((k) => k.address === MINTER_ADDRESS);
    if (!kp) throw new Error(`Minter address ${MINTER_ADDRESS} not found in this wallet`);

    if (this._nfts.getNft(nftId)) throw new Error(`NFT ${nftId} already minted`);

    const validDef = NFT_COLLECTION.find((d) => d.nftId === nftId);
    if (!validDef) throw new Error(`Unknown NFT id: ${nftId}`);

    const nonce = this._nfts.getNonce(MINTER_ADDRESS);
    const tx = NftStore.buildMintTx({ nftId, from: MINTER_ADDRESS, to, nonce });

    const privBuf = Buffer.from(kp.privateKey, 'hex');
    const sigInput = JSON.stringify({
      id: tx.id,
      type: tx.type,
      nftId: tx.nftId,
      from: tx.from,
      to: tx.to,
      nonce: tx.nonce,
    });
    tx.sig = sign(txHash(sigInput), privBuf);

    const result = this._mempool.add(tx);
    if (!result.ok) throw new Error(result.message);
    this._addPendingTx(tx);

    return { ok: true, txid: tx.id, nftId, to };
  }

  /**
   * Mint all 60 Vortex NFTs to the Foundation Reserve address in one batch.
   * Called once after the NFT feature is deployed, before the sale ends.
   * Already-minted tokens are skipped.
   *
   * @returns {{ ok, minted: string[], skipped: string[] }}
   */
  mintNftBatch() {
    const kp = this._wallet.keys.find((k) => k.address === MINTER_ADDRESS);
    if (!kp) throw new Error(`Minter address ${MINTER_ADDRESS} not found in this wallet`);

    const minted = [];
    const skipped = [];
    const privBuf = Buffer.from(kp.privateKey, 'hex');

    for (const def of NFT_COLLECTION) {
      if (this._nfts.getNft(def.nftId)) {
        skipped.push(def.nftId);
        continue;
      }
      // Re-read nonce each time since applyBlock is not called until block commit;
      // for batch mempool submission the nonce must increment per tx in sequence.
      // We track it manually here since the store won't bump until blocks land.
      const nonce = this._nfts.getNonce(MINTER_ADDRESS) + minted.length;
      const tx = NftStore.buildMintTx({ nftId: def.nftId, from: MINTER_ADDRESS, to: MINTER_ADDRESS, nonce });

      const sigInput = JSON.stringify({
        id: tx.id,
        type: tx.type,
        nftId: tx.nftId,
        from: tx.from,
        to: tx.to,
        nonce: tx.nonce,
      });
      tx.sig = sign(txHash(sigInput), privBuf);

      const result = this._mempool.add(tx);
      if (result.ok) {
        minted.push(def.nftId);
        this._addPendingTx(tx);
      } else {
        console.warn(`[WtcNode] mintNftBatch: failed to add ${def.nftId} to mempool: ${result.message}`);
      }
    }

    console.log(`[WtcNode] mintNftBatch: ${minted.length} queued, ${skipped.length} already minted`);
    return { ok: true, minted, skipped };
  }

  /**
   * Admin/genesis: directly write all 60 Wattcoin Vortex NFTs to `toAddress`
   * without creating any mempool transactions or requiring block mining.
   * Intended for the one-time initial Foundation Reserve distribution.
   *
   * @param {string} toAddress  — destination address (defaults to MINTER_ADDRESS)
   * @returns {{ ok, minted: string[], skipped: string[] }}
   */
  initializeNftCollection(toAddress) {
    const dest = typeof toAddress === 'string' && toAddress.trim() ? toAddress.trim() : MINTER_ADDRESS;
    const result = this._nfts.directMintCollection(dest);
    return { ok: true, ...result };
  }

  // ─── Governance ──────────────────────────────────────────────────────────

  /** Return all known proposals (newest first). */
  getGovernanceProposals() {
    return this._governance.getProposals();
  }

  /** Return governance status: distributed power, pass threshold, total possible. */
  getGovernanceStatus() {
    return this._governance.getGovernanceStatus();
  }

  /** Return a single proposal. */
  getGovernanceProposal(pipId) {
    return this._governance.getProposal(pipId);
  }

  /** Get a voter's vote on a proposal. */
  getGovernanceVote(pipId, address) {
    return this._governance.getVoterVote(pipId, address);
  }

  /** Get vote tallies for a proposal. */
  getGovernanceTallies(pipId) {
    return this._governance.getVoteTallies(pipId);
  }

  /**
   * Add a proposal from the local user or a peer gossip.
   * Returns { ok, pipId, isNew }.
   */
  addGovernanceProposal({
    pipId,
    title,
    description,
    creator,
    createdAt,
    creatorNftId,
    creatorTier,
    votingDurationWeeks,
    commentPeriodWeeks,
  }) {
    return this._governance.addProposal({
      pipId,
      title,
      description,
      creator,
      createdAt,
      creatorNftId,
      creatorTier,
      votingDurationWeeks,
      commentPeriodWeeks,
    });
  }

  /**
   * Add a vote from the local user or a peer gossip.
   * Returns { ok, isNew, changed, quorum }.
   * If quorum is reached, a governance_result tx is built and submitted to the mempool.
   */
  /** Compute the highest-tier voting power for an address from the NFT store. */
  _getVotingPower(voter) {
    const nfts = this._nfts.getNftsForAddress(voter);
    if (!nfts || nfts.length === 0) return { hasNft: false, bestTier: 'bronze', bestPower: 1 };
    let bestTier = 'bronze';
    let bestPower = 1;
    const TIER_RANK = { gold: 3, silver: 2, bronze: 1 };
    const VOTE_WEIGHTS = { gold: 5, silver: 3, bronze: 1 };
    for (const nft of nfts) {
      const tier = (nft.metadata && nft.metadata.tier) || 'bronze';
      const rank = TIER_RANK[tier] || 0;
      if (rank > (TIER_RANK[bestTier] || 0)) {
        bestTier = tier;
        bestPower = VOTE_WEIGHTS[tier] || 1;
      }
    }
    return { hasNft: true, bestTier, bestPower };
  }

  addGovernanceVote(pipId, { voter, power: _power, nftTier: _nftTier, vote, signature, timestamp: voteTimestamp }) {
    // Security: always verify actual NFT holdings and compute real voting power.
    // Self-reported power/nftTier from any source (peer gossip, IPC) are NEVER trusted.
    const vp = this._getVotingPower(voter);
    if (!vp.hasNft) {
      return { ok: false, error: `${voter.slice(0, 12)}... does not own any Vortex NFTs` };
    }
    let bestTier = vp.bestTier;
    let bestPower = vp.bestPower;

    const result = this._governance.addVote(pipId, {
      voter,
      power: bestPower,
      nftTier: bestTier,
      vote,
      signature,
      timestamp: voteTimestamp,
    });
    if (!result.ok) return result;

    const quorum = this._governance.checkQuorum(pipId);
    if (quorum.ok) {
      const p = this._governance.getProposal(pipId);
      const nonce = this._accounts.getNonce(voter);
      const tx = GovernanceStore.buildGovernanceResultTx({
        pipId,
        outcome: quorum.outcome,
        from: voter,
        nonce,
        voteTallies: p.voteTallies,
        title: p.title,
        transferTo: quorum.transferTo,
        transferAmount: quorum.transferAmount,
      });

      const kp = this._wallet.keys.find((k) => k.address === voter);
      if (kp) {
        const sigInput = JSON.stringify(
          {
            id: tx.id,
            type: tx.type,
            from: tx.from,
            to: tx.to,
            amount: tx.amount,
            fee: tx.fee,
            nonce: tx.nonce,
            governanceData: tx.governanceData,
          },
          Object.keys({ id: 1, type: 1, from: 1, to: 1, amount: 1, fee: 1, nonce: 1, governanceData: 1 }).sort(),
        );
        const privBuf = Buffer.from(kp.privateKey, 'hex');
        tx.sig = sign(txHash(sigInput), privBuf);

        const mempoolResult = this._mempool.add(tx);
        if (mempoolResult.ok) {
          this._addPendingTx(tx);
          console.log(
            `[Governance] Quorum reached for ${pipId} — governance_result tx ${tx.id.slice(0, 16)}... submitted to mempool`,
          );

          // If this was a governance transfer proposal, execute the transfer now
          const transferResult = this._executeGovernanceTransfer({ ...quorum, pipId });
          return {
            ...result,
            quorum: { reached: true, outcome: quorum.outcome, txId: tx.id, transfer: transferResult },
          };
        }
      }
    }

    return { ...result, quorum: { reached: false } };
  }

  /** Get the voting power for an address based on NFT holdings. */
  getGovernanceVotingPower(voter) {
    return this._getVotingPower(voter);
  }

  /**
   * Check all active proposals and close those whose voting period has expired.
   * For expired proposals that reached PASS_THRESHOLD, submits a governance_result
   * tx. For those that didn't, submits a rejected governance_result tx.
   * Returns the list of just-closed proposals.
   */
  closeExpiredProposals() {
    const expired = this._governance.closeExpiredProposals();
    if (expired.length === 0) return expired;

    // Find an NFT-holding address in this wallet to submit the tx
    const from = this._findGovernanceSubmitter();
    if (!from) {
      console.warn('[WtcNode] No NFT-holding address found to submit expired governance_result');
      return expired;
    }

    const kp = this._wallet.keys.find((k) => k.address === from);
    if (!kp) return expired;

    for (const ep of expired) {
      const nonce = this._accounts.getNonce(from);
      const tx = GovernanceStore.buildGovernanceResultTx({
        pipId: ep.pipId,
        outcome: ep.outcome,
        from,
        nonce,
        voteTallies: ep.voteTallies,
        title: ep.title,
        transferTo: ep.transferTo,
        transferAmount: ep.transferAmount,
      });

      const sigInput = JSON.stringify(
        {
          id: tx.id,
          type: tx.type,
          from: tx.from,
          to: tx.to,
          amount: tx.amount,
          fee: tx.fee,
          nonce: tx.nonce,
          governanceData: tx.governanceData,
        },
        Object.keys({ id: 1, type: 1, from: 1, to: 1, amount: 1, fee: 1, nonce: 1, governanceData: 1 }).sort(),
      );
      const privBuf = Buffer.from(kp.privateKey, 'hex');
      tx.sig = sign(txHash(sigInput), privBuf);

      const result = this._mempool.add(tx);
      if (result.ok) {
        this._addPendingTx(tx);
        console.log(
          `[Governance] Proposal ${ep.pipId} expired — ${ep.outcome} — governance_result tx ${tx.id.slice(0, 16)}... submitted`,
        );
        // Execute governance transfer if this was a governance transfer proposal
        this._executeGovernanceTransfer({
          pipId: ep.pipId,
          transferTo: ep.transferTo,
          transferAmount: ep.transferAmount,
          outcome: ep.outcome,
        });
      } else {
        console.warn(`[Governance] Failed to submit governance_result for expired ${ep.pipId}: ${result.message}`);
      }
    }

    return expired;
  }

  /** Execute a governance treasury transfer after a passed proposal. */
  _executeGovernanceTransfer({ transferTo, transferAmount, outcome, pipId }) {
    if (outcome !== 'passed' || !transferTo || !transferAmount) return null;
    if (!pipId) {
      console.warn('[Governance] No pipId provided for treasury transfer — cannot execute');
      return null;
    }
    const govKey = this._wallet.keys.find((k) => k.address === GOVERNANCE_WALLET_ADDRESS);
    if (!govKey) {
      console.warn('[Governance] Governance wallet key not found — cannot execute treasury transfer');
      return null;
    }
    try {
      // Build the transfer tx with a governanceTransferRef so the consensus
      // layer can verify it's authorized by a passed on-chain proposal.
      // The ref is included in the signed data so it cannot be stripped.
      const fee = 0.01;
      const balance = this._accounts.getBalance(GOVERNANCE_WALLET_ADDRESS);
      if (balance.confirmed < transferAmount + fee) {
        throw new Error(`Insufficient governance balance: ${balance.confirmed.toFixed(2)} WTC`);
      }
      const nonce = balance.nonce;
      const governanceTransferRef = { pipId };
      const tx = Mempool.buildTx({
        from: GOVERNANCE_WALLET_ADDRESS,
        to: transferTo,
        amount: transferAmount,
        fee,
        nonce,
      });
      tx.governanceTransferRef = governanceTransferRef;

      // Sign — include governanceTransferRef so the signature covers it
      const privBuf = Buffer.from(govKey.privateKey, 'hex');
      const sigInput = JSON.stringify({
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        fee: tx.fee,
        nonce: tx.nonce,
        governanceTransferRef,
      });
      tx.sig = sign(txHash(sigInput), privBuf);

      const result = this._mempool.add(tx);
      if (!result.ok) throw new Error(result.message);

      this._addPendingTx(tx);
      console.log(
        `[Governance] Treasury transfer executed: ${transferAmount} WTC → ${transferTo.slice(0, 12)}... (tx ${tx.id.slice(0, 16)}..., proposal ${pipId})`,
      );
      return { ok: true, txid: tx.id };
    } catch (e) {
      console.warn(`[Governance] Treasury transfer failed: ${e && e.message}`);
      return { ok: false, error: String(e && e.message) };
    }
  }

  /** Get the governance wallet confirmed balance. */
  getGovernanceWalletBalance() {
    try {
      const balance = this._accounts.getBalance(GOVERNANCE_WALLET_ADDRESS);
      return { ok: true, confirmed: balance.confirmed, pending: balance.pending, address: GOVERNANCE_WALLET_ADDRESS };
    } catch (_) {
      return { ok: false, confirmed: 0, pending: 0, address: GOVERNANCE_WALLET_ADDRESS };
    }
  }

  _findGovernanceSubmitter() {
    for (const addr of this.getAddresses()) {
      const nfts = this._nfts.getNftsForAddress(addr);
      if (nfts && nfts.length > 0) return addr;
    }
    return null;
  }

  /**
   * Generate the next pipId based on current chain state.
   */
  generateGovernancePipId() {
    return GovernanceStore.generatePipId(this._chain.getHeight());
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create and initialize a WtcNode instance.
 * Convenience wrapper that calls new WtcNode(...).init(...).
 *
 * @param {{
 *   dataDir:         string,
 *   signingSecret:   string,
 *   getActivePeers:  () => string[],
 *   getPeerTargets?: () => string[],
 *   getTrustedPeerTargets?: () => string[],
 *   requestPeerJson: (url:string, method:string, path:string, body?:any) => Promise<any>,
 *   onPeerTip?:      (url:string, tip:any) => void,
 *   allowPartialQuorumCommit?: boolean,
 *   getConnectedPeerCount?: () => number,
 * }} opts
 * @returns {WtcNode}
 */
function createWtcNode({
  dataDir,
  signingSecret,
  peerIdentity = '',
  walletKey,
  getActivePeers,
  getPeerTargets,
  getTrustedPeerTargets,
  requestPeerJson,
  onPeerTip,
  allowPartialQuorumCommit = true,
  isLiveLocalTunnelPeer,
  isSelfPeerUrl,
  getConnectedPeerCount,
  getEnergyContributions,
}) {
  const node = new WtcNode({ dataDir, signingSecret, peerIdentity, walletKey });
  node.init({
    getActivePeers,
    getPeerTargets,
    getTrustedPeerTargets,
    requestPeerJson,
    onPeerTip,
    allowPartialQuorumCommit,
    isLiveLocalTunnelPeer,
    isSelfPeerUrl,
    getConnectedPeerCount,
    getEnergyContributions,
  });
  return node;
}

module.exports = { WtcNode, createWtcNode };
