'use strict';
/**
 * Mempool risk tests — three independent risks documented and regression-tested:
 *
 *  1. Same-fee tx ordering divergence
 *     Two peers that receive the same transactions in different orders will
 *     propose blocks with different tx sequences, producing different block hashes
 *     and fragmenting the BFT vote round.
 *
 *  2. prune() is never called automatically
 *     Expired transactions accumulate indefinitely.  Without an explicit
 *     prune() call, the pool eventually reaches POOL_FULL and rejects all
 *     new transactions — including legitimate ones.
 *
 *  3. NFT transaction flood starves coin transfers
 *     NFT txs bypass fee/amount validation.  A single sender can fill all
 *     5 000 pool slots with zero-fee NFT transactions, blocking every
 *     subsequent coin transfer.
 */

const assert = require('assert');

const { Mempool } = require('../electron-main/wtc-mempool');
const { generateKeypair, sign, txHash } = require('../electron-main/wtc-address');

const senderKp = generateKeypair();

const BASE_TS = Date.now();

function coinTx(id, fee = 0.01, nonce = 0) {
  const from = senderKp.address;
  const to = 'wtc1qrecipient0000000000000000000000000000000';
  const amount = 1;
  const timestamp = BASE_TS;
  const sigInput = JSON.stringify({ id, from, to, amount, fee, nonce });
  const sig = sign(txHash(sigInput), Buffer.from(senderKp.privateKey, 'hex'));
  return { id, from, to, amount, fee, nonce, timestamp, sig };
}

function nftTx(id, nonce = 0) {
  const from = senderKp.address;
  const to = senderKp.address;
  const timestamp = BASE_TS;
  const sigInput = JSON.stringify({ id, from, to, nonce });
  const sig = sign(txHash(sigInput), Buffer.from(senderKp.privateKey, 'hex'));
  return { id, type: 'nft_mint', from, to, nftId: `NFT-${id}`, nonce, timestamp, sig };
}

// ── Test 1: Same-fee ordering is deterministic (fix for divergence) ───────────

function testSameFeeOrderingDivergence() {
  const poolA = new Mempool();
  const poolB = new Mempool();

  // Peer A: receives transactions in order 1 → 2 → 3
  assert.strictEqual(poolA.add(coinTx('fee-tx-1', 0.05, 0)).ok, true);
  assert.strictEqual(poolA.add(coinTx('fee-tx-2', 0.05, 1)).ok, true);
  assert.strictEqual(poolA.add(coinTx('fee-tx-3', 0.05, 2)).ok, true);

  // Peer B: receives the same transactions in reverse gossip order
  assert.strictEqual(poolB.add(coinTx('fee-tx-3', 0.05, 2)).ok, true);
  assert.strictEqual(poolB.add(coinTx('fee-tx-2', 0.05, 1)).ok, true);
  assert.strictEqual(poolB.add(coinTx('fee-tx-1', 0.05, 0)).ok, true);

  const orderA = poolA.getTxs().map((t) => t.id);
  const orderB = poolB.getTxs().map((t) => t.id);

  // Same-fee txs are now sorted by txid hash, so both peers produce the
  // same deterministic order regardless of insertion order.
  assert.deepStrictEqual(
    orderA,
    orderB,
    'same-fee txs must produce identical order across peers regardless of insertion order',
  );

  console.log('[PASS] mempool: same-fee ordering is deterministic across peers', { orderA, orderB });
}

// ── Test 2: txs survive indefinitely (no time-based eviction) ────────────────

function testNoTimeBasedEviction() {
  const pool = new Mempool();

  // A tx stays in the pool past the old 10-minute prune window.
  assert.strictEqual(pool.add(coinTx('survivor-tx', 0.01, 0)).ok, true);
  pool._txs.get('survivor-tx').addedAt = Date.now() - 15 * 60_000;

  // No prune() exists — tx survives until explicitly removed.
  assert.strictEqual(pool.has('survivor-tx'), true, 'tx should survive past old prune window (no time-based eviction)');
  assert.strictEqual(pool.size(), 1);

  // Only explicit remove/removeAll evicts it.
  pool.remove('survivor-tx');
  assert.strictEqual(pool.has('survivor-tx'), false, 'tx removed after explicit remove()');
  assert.strictEqual(pool.size(), 0);

  console.log('[PASS] mempool: no time-based eviction — txs survive until explicitly removed');
}

// ── Test 3: NFT slot cap protects coin transfers ──────────────────────────────

function testNftSlotCapProtectsCoinTransfers() {
  const pool = new Mempool();
  const NFT_MAX = 4000; // MEMPOOL_NFT_MAX_SLOTS

  // Attacker fills NFT slots (80% of pool).
  for (let i = 0; i < NFT_MAX; i++) {
    const res = pool.add(nftTx(`flood-${i}`, i));
    assert.strictEqual(res.ok, true, `NFT flood tx ${i} should be accepted`);
  }
  assert.strictEqual(pool.size(), NFT_MAX, 'pool should have exactly NFT_MAX txs');

  // Further NFT txs are rejected with NFT_POOL_FULL.
  const overflowNft = pool.add(nftTx('overflow-nft', NFT_MAX));
  assert.strictEqual(overflowNft.ok, false);
  assert.strictEqual(overflowNft.code, 'NFT_POOL_FULL', 'NFT beyond cap rejected with NFT_POOL_FULL');

  // Coin transfer is still accepted — 1000 reserved slots protect it.
  const coinRes = pool.add(coinTx('legitimate-transfer', 1.0, 4000));
  assert.strictEqual(coinRes.ok, true, 'coin transfer accepted even after NFT cap hit — reserved slots work');
  assert.strictEqual(pool.size(), NFT_MAX + 1);

  console.log('[PASS] mempool: NFT slot cap protects coin transfers — 1000 slots always available');
}

// ── Runner ────────────────────────────────────────────────────────────────────

function run() {
  testSameFeeOrderingDivergence();
  testNoTimeBasedEviction();
  testNftSlotCapProtectsCoinTransfers();
  console.log('all mempool risk tests passed');
}

run();
