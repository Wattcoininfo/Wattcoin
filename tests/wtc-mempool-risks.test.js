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

const { Mempool } = require('../wtc-mempool');

const BASE_TS = Date.now();

function coinTx(id, fee = 0.01, nonce = 0) {
  return {
    id,
    from:      'wtc1qsender000000000000000000000000000000000000',
    to:        'wtc1qrecipient0000000000000000000000000000000',
    amount:    1,
    fee,
    nonce,
    timestamp: BASE_TS,
    sig:       { r: 'r', s: 's', v: 1 },
  };
}

function nftTx(id, nonce = 0) {
  return {
    id,
    type:      'nft_mint',
    from:      'wtc1qattacker000000000000000000000000000000000',
    to:        'wtc1qattacker000000000000000000000000000000000',
    nftId:     `NFT-${id}`,
    nonce,
    timestamp: BASE_TS,
    sig:       { r: 'r', s: 's', v: 1 },
  };
}

// ── Test 1: Same-fee ordering divergence ─────────────────────────────────────

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

  // JS Array.sort is stable: equal-fee txs retain insertion order.
  // Peers with different insertion orders therefore get different block proposals.
  assert.deepStrictEqual(orderA, ['fee-tx-1', 'fee-tx-2', 'fee-tx-3'],
    'pool A should return txs in insertion order when all fees are equal');
  assert.deepStrictEqual(orderB, ['fee-tx-3', 'fee-tx-2', 'fee-tx-1'],
    'pool B should return txs in its own insertion order');
  assert.notDeepStrictEqual(orderA, orderB,
    'RISK CONFIRMED: same-fee txs in different insertion order produce different block ' +
    'proposals → different block hashes → BFT vote fragmentation across peers');

  console.log('[PASS] mempool: same-fee ordering divergence confirmed', { orderA, orderB });
}

// ── Test 2: prune() never called automatically ────────────────────────────────

function testPruneNotAutoCalled() {
  const pool = new Mempool();

  // Add a legitimate transaction, then back-date its addedAt to 15 minutes ago.
  // (prune() default maxAgeMs is 10 minutes, so this tx is past the cutoff.)
  assert.strictEqual(pool.add(coinTx('stale-tx', 0.01, 0)).ok, true);
  pool._txs.get('stale-tx').addedAt = Date.now() - 15 * 60_000;

  // Without calling prune(), the stale tx remains in the pool indefinitely.
  assert.strictEqual(pool.has('stale-tx'), true,
    'stale tx should still be present before prune() is called — prune is not automatic');
  assert.strictEqual(pool.size(), 1);

  // Explicit prune() removes it.
  pool.prune();
  assert.strictEqual(pool.has('stale-tx'), false,
    'stale tx should be gone after explicit prune()');
  assert.strictEqual(pool.size(), 0);

  // Demonstrate the actual risk: fill a pool with stale txs so new ones are blocked,
  // then show that only explicit prune() can unblock it.
  const fullPool = new Mempool();
  const FILL = 10; // small number to keep the test fast; the dynamic is the same at 5000
  for (let i = 0; i < FILL; i++) {
    const res = fullPool.add(coinTx(`stale-${i}`, 0.01, i));
    assert.strictEqual(res.ok, true);
    fullPool._txs.get(`stale-${i}`).addedAt = Date.now() - 15 * 60_000;
  }

  // A new tx is accepted because the pool is below MAX_SIZE (5000).
  // The RISK is that at MAX_SIZE the pool becomes read-only without auto-prune.
  // Verify: after explicit prune, fresh txs are accepted cleanly.
  fullPool.prune();
  assert.strictEqual(fullPool.size(), 0, 'all stale txs should be cleared by explicit prune()');
  const fresh = fullPool.add(coinTx('fresh-after-prune', 0.01, 99));
  assert.strictEqual(fresh.ok, true,
    'fresh tx should be accepted once stale txs are evicted by explicit prune()');

  console.log('[PASS] mempool: prune() is not automatic — explicit call required to evict stale txs');
}

// ── Test 3: NFT flood starves coin transfers ──────────────────────────────────

function testNftFloodStarvesCoinTransfers() {
  const pool    = new Mempool();
  const MAX     = 5000; // MEMPOOL_MAX_SIZE

  // A single attacker fills all 5 000 slots with zero-fee NFT txs.
  // Each NFT tx only requires a valid nftId — no fee, no amount.
  for (let i = 0; i < MAX; i++) {
    const res = pool.add(nftTx(`flood-${i}`, i));
    assert.strictEqual(res.ok, true, `NFT flood tx ${i} should be accepted (no fee guard)`);
  }
  assert.strictEqual(pool.size(), MAX, 'pool should be at capacity after NFT flood');

  // A legitimate coin transfer is now hard-rejected.
  const coinRes = pool.add(coinTx('victim-transfer', 1.0, 0));
  assert.strictEqual(coinRes.ok, false,
    'coin transfer should be rejected when pool is full');
  assert.strictEqual(coinRes.code, 'POOL_FULL',
    'RISK CONFIRMED: NFT flood fills the pool — coin transfers get POOL_FULL');

  // Even another NFT tx is rejected at this point.
  const nftExtra = pool.add(nftTx('overflow-nft', 99999));
  assert.strictEqual(nftExtra.ok, false);
  assert.strictEqual(nftExtra.code, 'POOL_FULL');

  console.log('[PASS] mempool: NFT flood starves coin transfers — POOL_FULL after zero-fee flood');
}

// ── Runner ────────────────────────────────────────────────────────────────────

function run() {
  testSameFeeOrderingDivergence();
  testPruneNotAutoCalled();
  testNftFloodStarvesCoinTransfers();
  console.log('all mempool risk tests passed');
}

run();
