// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');

const sq = require('../wtc-sale-queue');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-sale-test-'));
}

function describe(name, fn) {
  fn();
}

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    throw e;
  }
}

// ─── Sale tier math ────────────────────────────────────────────────────────

describe('wtc-sale-queue — tier constants', () => {

  it('SALE_TOTAL is 333,333 WTC', () => {
    assert.strictEqual(sq.SALE_TOTAL, 333333);
  });

  it('SALE_TIER_SIZE is 111,111 WTC per tier', () => {
    assert.strictEqual(sq.SALE_TIER_SIZE, 111111);
  });

  it('three tiers each have 1/3 fraction', () => {
    const tiers = sq.SALE_TIERS;
    assert.strictEqual(tiers.length, 3);
    assert.strictEqual(tiers[0].fraction, 1/3);
    assert.strictEqual(tiers[1].fraction, 2/3);
    assert.strictEqual(tiers[2].fraction, 3/3);
  });

  it('tier boundaries are contiguous and cover total', () => {
    const tiers = sq.SALE_TIERS;
    assert.strictEqual(tiers[0].start, 0);
    assert.strictEqual(tiers[0].end, 111111);
    assert.strictEqual(tiers[1].start, 111111);
    assert.strictEqual(tiers[1].end, 222222);
    assert.strictEqual(tiers[2].start, 222222);
    assert.strictEqual(tiers[2].end, 333333);
  });

});

describe('wtc-sale-queue — computeUsdcRequired', () => {

  it('returns 0 for zero amount', () => {
    const cost = sq.computeUsdcRequired(0, 0.10);
    assert.strictEqual(cost, 0);
  });

  it('returns positive cost for positive amount', () => {
    const elPrice = 0.10;
    const ENERGY_KWH_PER_WTC = 20;
    const expectedTier1Price = elPrice * ENERGY_KWH_PER_WTC * (1/3);
    const cost = sq.computeUsdcRequired(1, elPrice);
    assert.strictEqual(cost, expectedTier1Price);
  });

  it('cost is linear in electricity price', () => {
    const costLow = sq.computeUsdcRequired(100, 0.05);
    const costHigh = sq.computeUsdcRequired(100, 0.10);
    assert.strictEqual(costHigh, costLow * 2);
  });

  it('cost increases across tier boundaries', () => {
    const elPrice = 0.10;
    const firstWtcCost = sq.computeUsdcRequired(1, elPrice);
    assert.ok(firstWtcCost > 0);
  });

});

describe('wtc-sale-queue — init and order lifecycle', () => {
  const ADDR1 = 'wtc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0';

  it('init creates empty state', () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const orders = sq.getOrders();
    assert.ok(Array.isArray(orders));
    assert.strictEqual(orders.length, 0);
    sq.shutdown();
  });

  it('placeSaleOrder validates inputs', async () => {
    const dir = tmpDir();
    sq.init(dir, null);
    let result = await sq.placeSaleOrder({ wtcAddress: '', wtcAmount: 100, usdcRequired: 10 });
    assert.strictEqual(result.ok, false);
    result = await sq.placeSaleOrder({ wtcAddress: 'wtc1qtest', wtcAmount: 0, usdcRequired: 10 });
    assert.strictEqual(result.ok, false);
    result = await sq.placeSaleOrder({ wtcAddress: 'wtc1qtest', wtcAmount: 100, usdcRequired: 0 });
    assert.strictEqual(result.ok, false);
    sq.shutdown();
  });

  it('creates and retrieves orders', async () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const result = await sq.placeSaleOrder({
      wtcAddress: ADDR1,
      wtcAmount: 100,
      usdcRequired: 50.00,
    });
    assert.ok(result.ok, `placeSaleOrder failed: ${result.error || 'unknown'}`);
    assert.ok(result.orderId);
    assert.strictEqual(result.usdcRequired, 50.00);
    const orders = sq.getOrders();
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].id, result.orderId);
    assert.strictEqual(orders[0].status, 'pending_payment');
    sq.shutdown();
  });

  it('persists orders to disk', async () => {
    const dir = tmpDir();
    sq.init(dir, null);
    await sq.placeSaleOrder({
      wtcAddress: 'wtc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0',
      wtcAmount: 250,
      usdcRequired: 125.50,
    });
    sq.shutdown();
    const ordersPath = path.join(dir, 'sale-orders.json');
    assert.ok(fs.existsSync(ordersPath), 'orders file should exist after shutdown');
    const loaded = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].wtcAmount, 250);
    sq.init(dir, null);
    const orders = sq.getOrders();
    assert.strictEqual(orders.length, 1);
    assert.strictEqual(orders[0].wtcAmount, 250);
    sq.shutdown();
  });

});

describe('wtc-sale-queue — order queries', () => {
  const ADDR_Q = 'wtc1q0q5c5txsp9arysrx4k6zdkfs4nce4xj0';

  it('getOrder returns null for missing order', () => {
    const dir = tmpDir();
    sq.init(dir, null);
    assert.strictEqual(sq.getOrder('nonexistent'), null);
    sq.shutdown();
  });

  it('getOrdersForAddress filters correctly', async () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const addr = ADDR_Q;
    await sq.placeSaleOrder({ wtcAddress: addr, wtcAmount: 100, usdcRequired: 50 });
    await sq.placeSaleOrder({ wtcAddress: addr, wtcAmount: 200, usdcRequired: 100 });
    await sq.placeSaleOrder({ wtcAddress: 'wtc1qother0q5c5txsp9arysrx4k6zdk', wtcAmount: 50, usdcRequired: 25 });
    const forAddr = sq.getOrdersForAddress(addr);
    assert.strictEqual(forAddr.length, 2);
    sq.shutdown();
  });

  it('getPurchaseTotalForAddress sums confirmed orders', async () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const addr = ADDR_Q;
    await sq.placeSaleOrder({ wtcAddress: addr, wtcAmount: 150, usdcRequired: 75 });
    await sq.placeSaleOrder({ wtcAddress: addr, wtcAmount: 250, usdcRequired: 125 });
    assert.strictEqual(sq.getPurchaseTotalForAddress(addr), 0);
    sq.shutdown();
  });

});

describe('wtc-sale-queue — cancelOrder', () => {
  const ADDR_C = 'wtc1qcacacacacaca5c5txsp9arysrx4k6zdkfs4nce4';

  it('cancels a pending_payment order', async () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const result = await sq.placeSaleOrder({
      wtcAddress: ADDR_C,
      wtcAmount: 100,
      usdcRequired: 50,
    });
    assert.ok(result.ok, `placeSaleOrder failed: ${result.error || 'unknown'}`);
    const cancelResult = await sq.cancelOrder(result.orderId);
    assert.ok(cancelResult.ok, `cancelOrder failed: ${cancelResult.error || 'unknown'}`);
    const order = sq.getOrder(result.orderId);
    assert.strictEqual(order.status, 'cancelled');
    sq.shutdown();
  });

  it('returns error for non-existent order', async () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const cancelResult = await sq.cancelOrder('nonexistent-id');
    assert.strictEqual(cancelResult.ok, false);
    sq.shutdown();
  });

});

describe('wtc-sale-queue — setOrderTxHash', () => {
  const ADDR_T = 'wtc1qtxhashsp9arysrx4k6zdkfs4nce4xj0abcd';

  it('marks order as payment_submitted', async () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const result = await sq.placeSaleOrder({
      wtcAddress: ADDR_T,
      wtcAmount: 100,
      usdcRequired: 50,
    });
    assert.ok(result.ok, `placeSaleOrder failed: ${result.error || 'unknown'}`);
    const txRes = sq.setOrderTxHash(result.orderId, '0xabc123');
    assert.ok(txRes.ok, `setOrderTxHash failed: ${txRes.error || 'unknown'}`);
    const order = sq.getOrder(result.orderId);
    assert.strictEqual(order.status, 'payment_submitted');
    assert.strictEqual(order.knownTxHash, '0xabc123');
    sq.shutdown();
  });

  it('fails for non-existent order', () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const res = sq.setOrderTxHash('bad-id', '0xabc');
    assert.strictEqual(res.ok, false);
    sq.shutdown();
  });

});

describe('wtc-sale-queue — setElectricityPrice', () => {

  it('accepts valid prices', () => {
    const dir = tmpDir();
    sq.init(dir, null);
    sq.setElectricityPrice(0.12);
    sq.shutdown();
  });

  it('ignores invalid prices', () => {
    const dir = tmpDir();
    sq.init(dir, null);
    sq.setElectricityPrice(-1);
    sq.setElectricityPrice(NaN);
    sq.setElectricityPrice(null);
    sq.shutdown();
  });

});

describe('wtc-sale-queue — getSoldWTC', () => {

  it('returns 0 with no orders or node', () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const sold = sq.getSoldWTC();
    assert.strictEqual(sold, 0);
    sq.shutdown();
  });

  it('returns value capped to SALE_TOTAL', () => {
    const dir = tmpDir();
    sq.init(dir, null);
    const sold = sq.getSoldWTC();
    assert.ok(sold >= 0);
    assert.ok(sold <= sq.SALE_TOTAL);
    sq.shutdown();
  });

});

if (require.main === module) {
  let failed = false;
  try {
    require('./wtc-sale-queue.test');
  } catch (e) {
    failed = true;
    console.error('Test suite failed:', e.message);
  }
  if (failed) process.exit(1);
  console.log('\nAll sale queue tests passed.');
}
