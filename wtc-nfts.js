'use strict';
/**
 * wtc-nfts.js — Wattcoin Vortex NFT state for the WTC native chain
 *
 * Tracks ownership of the 60-token Wattcoin Vortex NFT collection.
 * Persisted as HMAC-signed JSON at {dataDir}/wtc-nfts.json so tampering
 * is detected on load (same pattern as wtc-accounts.js).
 *
 * NFT transactions ride inside the standard block transactions[] array
 * using two new type values:
 *   nft_mint     — minted by MINTER_ADDRESS to a recipient
 *   nft_transfer — current owner transfers to a new owner
 *
 * Both use ECDSA signatures over a deterministic sigInput, exactly like
 * regular WTC transfers.  NFT nonces are tracked per-address independently
 * from WTC transfer nonces so both can proceed without conflict.
 *
 * Collection:
 *   #1–#10   Wattcoin Vortex Gold   — 5 profit shares each  (10 tokens)
 *   #11–#30  Wattcoin Vortex Silver — 3 profit shares each  (20 tokens)
 *   #31–#60  Wattcoin Vortex Bronze — 1 profit share  each  (30 tokens)
 *   Total supply: 60  |  Total shares: 140
 *
 * All 60 tokens are minted at once to MINTER_ADDRESS (Foundation Reserve)
 * and subsequently distributed manually by the team.
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { txHash, verifySignature } = require('./wtc-address');

// ─── Collection constants ─────────────────────────────────────────────────────

const MINTER_ADDRESS = 'wtc1q073k2x8qvgd6xf7jvq64zkngyh7m7qdt4vvmrn'; // Foundation Reserve

const NFT_COLLECTION = (() => {
  const tokens = [];
  for (let i = 1; i <= 10; i++) {
    tokens.push({
      nftId:  `vhpn-${i}`,
      tier:   'gold',
      shares: 5,
      name:   `Wattcoin Vortex Gold #${i}`,
      image:  'Vortex NFT Gold.jpg',
    });
  }
  for (let i = 11; i <= 30; i++) {
    tokens.push({
      nftId:  `vhpn-${i}`,
      tier:   'silver',
      shares: 3,
      name:   `Wattcoin Vortex Silver #${i}`,
      image:  'Vortex NFT Silver.jpg',
    });
  }
  for (let i = 31; i <= 60; i++) {
    tokens.push({
      nftId:  `vhpn-${i}`,
      tier:   'bronze',
      shares: 1,
      name:   `Wattcoin Vortex Bronze #${i}`,
      image:  'Vortex NFT Bronze.jpg',
    });
  }
  return tokens;
})();

// ─────────────────────────────────────────────────────────────────────────────

class NftStore {
  /**
   * @param {{ dataDir: string, signingSecret: string }} opts
   */
  constructor({ dataDir, signingSecret }) {
    this._file   = path.join(dataDir, 'wtc-nfts.json');
    this._secret = signingSecret;
    this._tokens = {};  // nftId → { owner, metadata, mintedAtHeight }
    this._nonces = {};  // address → number  (NFT-specific nonce, separate from WTC nonce)
    this._load();
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  _hmac(data) {
    return crypto.createHmac('sha256', this._secret)
      .update(JSON.stringify(data)).digest('hex');
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return;
      const raw = JSON.parse(fs.readFileSync(this._file, 'utf8'));
      const { _sig: savedSig, ...data } = raw;
      if (savedSig !== this._hmac(data)) {
        console.warn('[NftStore] HMAC mismatch — starting fresh (file may have been tampered)');
        return;
      }
      this._tokens = data.tokens || {};
      this._nonces = data.nonces || {};
    } catch (_) {
      // Corrupt or missing file — start with empty state.
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._file), { recursive: true });
      const data = { tokens: this._tokens, nonces: this._nonces };
      fs.writeFileSync(
        this._file,
        JSON.stringify({ ...data, _sig: this._hmac(data) }, null, 2),
        'utf8'
      );
    } catch (_) { /* non-fatal */ }
  }

  // ─── NFT nonces ─────────────────────────────────────────────────────────────

  /** NFT-specific nonce for an address (separate from WTC transfer nonce). */
  getNonce(addr) {
    return this._nonces[addr] || 0;
  }

  _bumpNonce(addr) {
    this._nonces[addr] = (this._nonces[addr] || 0) + 1;
  }

  // ─── Block application ──────────────────────────────────────────────────────

  /**
   * Apply all NFT transactions from a committed block.
   * Non-NFT transactions are silently ignored.
   * Invalid NFT transactions are warned and skipped.
   */
  applyBlock(block) {
    let changed = false;

    for (const tx of (block.transactions || [])) {
      if (!tx || !tx.type) continue;

      if (tx.type === 'nft_mint') {
        if (!tx.nftId || !tx.from || !tx.to) {
          console.warn(`[NftStore] nft_mint ${tx.id || '?'} skipped: missing fields`);
          continue;
        }
        if (tx.from !== MINTER_ADDRESS) {
          console.warn(`[NftStore] nft_mint ${tx.nftId} skipped: unauthorized minter ${tx.from}`);
          continue;
        }
        if (this._tokens[tx.nftId]) {
          console.warn(`[NftStore] nft_mint ${tx.nftId} skipped: already exists`);
          continue;
        }

        // Resolve canonical metadata from collection definition
        const def = NFT_COLLECTION.find(e => e.nftId === tx.nftId);
        const metadata = def
          ? { name: def.name, tier: def.tier, shares: def.shares, image: def.image, mintedAtHeight: block.height }
          : { ...(tx.metadata || {}), mintedAtHeight: block.height };

        this._tokens[tx.nftId] = { owner: tx.to, metadata, mintedAtHeight: block.height };
        this._bumpNonce(tx.from);
        changed = true;
        console.log(`[NftStore] minted ${tx.nftId} (${metadata.name || tx.nftId}) → ${tx.to.slice(0, 16)}...`);

      } else if (tx.type === 'nft_transfer') {
        if (!tx.nftId || !tx.from || !tx.to) {
          console.warn(`[NftStore] nft_transfer ${tx.id || '?'} skipped: missing fields`);
          continue;
        }
        const token = this._tokens[tx.nftId];
        if (!token) {
          console.warn(`[NftStore] nft_transfer ${tx.nftId} skipped: token not found`);
          continue;
        }
        if (token.owner !== tx.from) {
          console.warn(`[NftStore] nft_transfer ${tx.nftId} skipped: ${tx.from.slice(0, 16)}... is not the owner`);
          continue;
        }

        token.owner = tx.to;
        this._bumpNonce(tx.from);
        changed = true;
        console.log(`[NftStore] transferred ${tx.nftId} → ${tx.to.slice(0, 16)}...`);
      }
    }

    if (changed) this._save();
  }

  /**
   * Full deterministic rebuild from a sequence of blocks.
   * Used after chain sync/rollback (mirrors Accounts.rebuildFromBlocks).
   */
  rebuildFromBlocks(blocks) {
    this._tokens = {};
    this._nonces = {};
    for (const block of (blocks || [])) {
      this.applyBlock(block);
    }
    this._save();
  }

  // ─── Queries ─────────────────────────────────────────────────────────────────

  /** Returns { owner, metadata, mintedAtHeight } or null. */
  getNft(nftId) {
    return this._tokens[nftId] || null;
  }

  /** Returns all NFTs currently owned by an address. */
  getNftsForAddress(addr) {
    const result = [];
    for (const [nftId, token] of Object.entries(this._tokens)) {
      if (token.owner === addr) {
        result.push({ nftId, owner: token.owner, metadata: token.metadata, mintedAtHeight: token.mintedAtHeight });
      }
    }
    return result.sort((a, b) => a.nftId.localeCompare(b.nftId, undefined, { numeric: true }));
  }

  /** Returns the full collection state (all 60 tokens with current owner or null). */
  getAllNfts() {
    return NFT_COLLECTION.map(def => {
      const token = this._tokens[def.nftId];
      return {
        nftId:          def.nftId,
        tier:           def.tier,
        shares:         def.shares,
        name:           def.name,
        image:          def.image,
        owner:          token ? token.owner : null,
        mintedAtHeight: token ? token.mintedAtHeight : null,
        minted:         !!token,
      };
    });
  }

  /**
   * Deterministic SHA-256 of current token ownership state.
   * Included as nftsRoot in each block header.
   */
  computeStateHash() {
    const entries = Object.entries(this._tokens)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, t]) => [id, t.owner, t.mintedAtHeight]);
    return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  }

  // ─── Transaction validation ──────────────────────────────────────────────────

  /**
   * Validate an NFT transaction (mint or transfer) for mempool admission
   * or pre-block inclusion.
   * Returns true if valid, false otherwise.
   */
  validateTx(tx) {
    if (!tx || !tx.id || !tx.type || !tx.nftId || !tx.from || !tx.to || !tx.sig) return false;
    if (tx.type !== 'nft_mint' && tx.type !== 'nft_transfer') return false;

    // Nonce check against NFT-specific nonce
    const expectedNonce = this.getNonce(tx.from);
    if (typeof tx.nonce !== 'number' || tx.nonce !== expectedNonce) return false;

    if (tx.type === 'nft_mint') {
      if (tx.from !== MINTER_ADDRESS) return false;
      if (this._tokens[tx.nftId]) return false;  // already minted
    }

    if (tx.type === 'nft_transfer') {
      const token = this._tokens[tx.nftId];
      if (!token || token.owner !== tx.from) return false;
    }

    try {
      const sigInput = JSON.stringify({
        id: tx.id, type: tx.type, nftId: tx.nftId, from: tx.from, to: tx.to, nonce: tx.nonce,
      });
      return verifySignature(txHash(sigInput), tx.sig, tx.from);
    } catch (_) {
      return false;
    }
  }

  // ─── Transaction builders (static) ──────────────────────────────────────────

  /**
   * Admin-only: directly write all unminted collection tokens to `toAddress`,
   * bypassing the mempool/block-mining cycle.  Intended for the one-time
   * initial distribution to the Foundation Reserve address.
   * Already-minted tokens are skipped.
   *
   * @param {string} toAddress  — recipient (Foundation Reserve)
   * @returns {{ minted: string[], skipped: string[] }}
   */
  directMintCollection(toAddress) {
    const minted  = [];
    const skipped = [];
    for (const def of NFT_COLLECTION) {
      if (this._tokens[def.nftId]) {
        skipped.push(def.nftId);
        continue;
      }
      this._tokens[def.nftId] = {
        owner:          toAddress,
        mintedAtHeight: 0,   // 0 = direct / genesis mint
        metadata: {
          name:   def.name,
          tier:   def.tier,
          shares: def.shares,
          image:  def.image,
          mintedAtHeight: 0,
        },
      };
      minted.push(def.nftId);
    }
    if (minted.length > 0) this._save();
    console.log(`[NftStore] directMintCollection: ${minted.length} minted, ${skipped.length} already existed`);
    return { minted, skipped };
  }

  /**
   * Build an unsigned nft_mint transaction.
   * Caller must set tx.sig after signing with wtc-address.sign().
   */
  static buildMintTx({ nftId, from, to, nonce }) {
    const timestamp = Date.now();
    const id = crypto
      .createHash('sha256')
      .update(JSON.stringify({ type: 'nft_mint', nftId, from, to, nonce, timestamp }))
      .digest('hex');
    return { id, type: 'nft_mint', nftId, from, to, nonce, timestamp, sig: null };
  }

  /**
   * Build an unsigned nft_transfer transaction.
   * Caller must set tx.sig after signing with wtc-address.sign().
   */
  static buildTransferTx({ nftId, from, to, nonce }) {
    const timestamp = Date.now();
    const id = crypto
      .createHash('sha256')
      .update(JSON.stringify({ type: 'nft_transfer', nftId, from, to, nonce, timestamp }))
      .digest('hex');
    return { id, type: 'nft_transfer', nftId, from, to, nonce, timestamp, sig: null };
  }
}

module.exports = { NftStore, NFT_COLLECTION, MINTER_ADDRESS };
