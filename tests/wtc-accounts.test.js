// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { Accounts, MATURITY_DEPTH } = require('../wtc-accounts');

const ALICE = 'wtc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0';
const BOB = 'wtc1q3t8y4q7g0q5c5txsp9arysrx4k6zdkfs4nce4xj0';

const _tmpDirs = [];

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {}
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-accounts-test-'));
  _tmpDirs.push(d);
  return d;
}

function makeAccounts(dataDir) {
  return new Accounts({ dataDir, signingSecret: 'test-secret-123' });
}

function makeBlock(overrides = {}) {
  return {
    height: overrides.height !== undefined ? overrides.height : 1,
    hash: crypto.randomBytes(32).toString('hex'),
    prevHash: overrides.prevHash || crypto.randomBytes(32).toString('hex'),
    proposer: ALICE,
    timestamp: Date.now(),
    transactions: overrides.transactions || [],
    rewardAddresses: overrides.rewardAddresses || {},
    rewardTotal: overrides.rewardTotal || 0,
    energyWh: 10000000,
    stateRoot: overrides.stateRoot || '',
  };
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

describe('wtc-accounts — construction and initial state', () => {
  it('constructs with empty state', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    const bal = accts.getBalance(ALICE);
    assert.strictEqual(bal.confirmed, 0);
    assert.strictEqual(bal.unmatured, 0);
    assert.strictEqual(bal.total, 0);
    assert.strictEqual(bal.nonce, 0);
  });

  it('persists and loads state correctly', () => {
    const dir = tmpDir();
    const accts1 = makeAccounts(dir);
    accts1.credit(ALICE, 1000, { mature: true });
    assert.strictEqual(accts1.getBalance(ALICE).confirmed, 1000);
    const accts2 = makeAccounts(dir);
    assert.strictEqual(accts2.getBalance(ALICE).confirmed, 1000);
  });

  it('starts fresh on HMAC tamper', () => {
    const dir = tmpDir();
    const accts1 = makeAccounts(dir);
    accts1.credit(ALICE, 5000, { mature: true });
    const filePath = path.join(dir, 'wtc-accounts.json');
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    raw.balances[ALICE].confirmed = 999999;
    fs.writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    const accts2 = makeAccounts(dir);
    assert.strictEqual(accts2.getBalance(ALICE).confirmed, 0);
  });
});

describe('wtc-accounts — credit', () => {
  it('credits mature balance directly', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 500, { mature: true });
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 500);
    assert.strictEqual(accts.getBalance(ALICE).unmatured, 0);
  });

  it('credits unmatured balance by default', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 300, { mature: false, atHeight: 5 });
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 0);
    assert.strictEqual(accts.getBalance(ALICE).unmatured, 300);
  });

  it('ignores non-positive amounts', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 0, { mature: true });
    accts.credit(ALICE, -1, { mature: true });
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 0);
  });

  it('matures unmatured rewards at correct height', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 100, { mature: false, atHeight: 10 });
    assert.strictEqual(accts.getBalance(ALICE).unmatured, 100);
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 0);
    accts.applyMaturity(10 + MATURITY_DEPTH);
    assert.strictEqual(accts.getBalance(ALICE).unmatured, 0);
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 100);
  });

  it('does not mature before maturity depth', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 100, { mature: false, atHeight: 10 });
    accts.applyMaturity(10 + MATURITY_DEPTH - 1);
    assert.strictEqual(accts.getBalance(ALICE).unmatured, 100);
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 0);
  });
});

describe('wtc-accounts — transfer', () => {
  it('transfers confirmed balance between addresses', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 1000, { mature: true });
    accts.transfer(ALICE, BOB, 300, 10);
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 690);
    assert.strictEqual(accts.getBalance(BOB).confirmed, 300);
  });

  it('increments sender nonce on transfer', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 1000, { mature: true });
    assert.strictEqual(accts.getBalance(ALICE).nonce, 0);
    accts.transfer(ALICE, BOB, 100);
    assert.strictEqual(accts.getBalance(ALICE).nonce, 1);
    accts.transfer(ALICE, BOB, 100);
    assert.strictEqual(accts.getBalance(ALICE).nonce, 2);
  });

  it('throws on insufficient balance', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 50, { mature: true });
    assert.throws(() => accts.transfer(ALICE, BOB, 100), /Insufficient/);
  });

  it('returns fee amount', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 1000, { mature: true });
    const fee = accts.transfer(ALICE, BOB, 500, 15);
    assert.strictEqual(fee, 15);
  });

  it('handles zero-fee transfers', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 100, { mature: true });
    const fee = accts.transfer(ALICE, BOB, 100, 0);
    assert.strictEqual(fee, 0);
    assert.strictEqual(accts.getBalance(BOB).confirmed, 100);
  });
});

describe('wtc-accounts — applyBlock', () => {
  it('applies transactions in a block', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 1000, { mature: true });
    const block = makeBlock({
      transactions: [{ id: 'tx1', from: ALICE, to: BOB, amount: 200, fee: 10, nonce: 0, type: 'transfer' }],
    });
    accts.applyBlock(block);
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 800);
    assert.strictEqual(accts.getBalance(BOB).confirmed, 200);
  });

  it('credits mining rewards from block', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    const kpAlice = require('../wtc-address').generateKeypair();
    const block = makeBlock({
      rewardAddresses: { [kpAlice.address]: 500 },
      rewardTotal: 500,
    });
    accts.applyBlock(block);
    assert.strictEqual(accts.getBalance(kpAlice.address).unmatured, 500);
  });

  it('genesis block (height 0) credits mature rewards', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    const block = makeBlock({ height: 0, rewardAddresses: { [ALICE]: 1000000 }, rewardTotal: 1000000 });
    accts.applyBlock(block);
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 1000000);
  });

  it('skips NFT transactions', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 1000, { mature: true });
    const block = makeBlock({
      transactions: [{ id: 'nft1', from: ALICE, to: BOB, amount: 0, fee: 0, nonce: 0, type: 'nft_mint' }],
    });
    accts.applyBlock(block);
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 1000, 'NFT tx should not affect balances');
  });

  it('enforces sequential nonce', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 1000, { mature: true });
    const block = makeBlock({
      transactions: [
        { id: 'tx1', from: ALICE, to: BOB, amount: 100, fee: 5, nonce: 0, type: 'transfer' },
        { id: 'tx2', from: ALICE, to: BOB, amount: 100, fee: 5, nonce: 0, type: 'transfer' },
      ],
    });
    accts.applyBlock(block);
    assert.strictEqual(accts.getBalance(BOB).confirmed, 100, 'second tx with same nonce should be skipped');
  });
});

describe('wtc-accounts — stateHash', () => {
  it('produces deterministic hash for same state', () => {
    const dir = tmpDir();
    const accts1 = makeAccounts(dir);
    const accts2 = makeAccounts(tmpDir());
    accts1.credit(ALICE, 1000, { mature: true });
    accts2.credit(ALICE, 1000, { mature: true });
    assert.strictEqual(accts1.stateHash(), accts2.stateHash());
  });

  it('produces different hash for different states', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    const h1 = accts.stateHash();
    accts.credit(ALICE, 1, { mature: true });
    const h2 = accts.stateHash();
    assert.notStrictEqual(h1, h2);
  });
});

describe('wtc-accounts — rebuildFromBlocks', () => {
  it('rebuilds state from a sequence of blocks', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    const EMPTY_HASH = crypto.createHash('sha256').update(JSON.stringify([])).digest('hex');
    const genesisBlock = makeBlock({
      height: 0,
      prevHash: '0'.repeat(64),
      rewardAddresses: { [ALICE]: 1000 },
      rewardTotal: 1000,
    });
    genesisBlock.stateRoot = EMPTY_HASH;
    accts.applyBlock(genesisBlock);
    const aliceNonce = accts.getBalance(ALICE).nonce;
    const block1 = makeBlock({
      height: 1,
      prevHash: genesisBlock.hash,
      transactions: [{ id: 'tx1', from: ALICE, to: BOB, amount: 200, fee: 10, nonce: aliceNonce, type: 'transfer' }],
      rewardAddresses: { [BOB]: 500 },
      rewardTotal: 500,
    });
    block1.stateRoot = accts.stateHash();
    accts.applyBlock(block1);
    const dir2 = tmpDir();
    const accts2 = makeAccounts(dir2);
    const result = accts2.rebuildFromBlocks([genesisBlock, block1]);
    assert.strictEqual(accts2.getBalance(ALICE).confirmed, 790);
    assert.strictEqual(accts2.getBalance(BOB).confirmed, 200);
    assert.strictEqual(accts2.getBalance(BOB).unmatured, 500);
    assert.strictEqual(result.legacyStateRootMismatches.length, 0);
  });

  it('throws on stateRoot mismatch by default', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    const block1 = makeBlock({ height: 1, stateRoot: 'wrong-hash' });
    assert.throws(() => accts.rebuildFromBlocks([block1]), /stateRoot mismatch/);
  });

  it('tolerates stateRoot mismatch with flag', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    const block1 = makeBlock({ height: 1, stateRoot: 'wrong-hash' });
    const result = accts.rebuildFromBlocks([block1], { allowLegacyStateRootMismatch: true });
    assert.strictEqual(result.legacyStateRootMismatches.length, 1);
    assert.strictEqual(result.legacyStateRootMismatches[0].height, 1);
  });

  it('throws on invalid transaction data', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    const block1 = makeBlock({ height: 1, transactions: [null] });
    assert.throws(() => accts.rebuildFromBlocks([block1]), /Invalid tx/);
  });
});

describe('wtc-accounts — snapshot and restore', () => {
  it('snapshot returns deep copy', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 500, { mature: true });
    const snap = accts.snapshot();
    accts.credit(ALICE, 300, { mature: true });
    assert.notStrictEqual(accts.snapshot()[ALICE].confirmed, snap[ALICE].confirmed);
  });

  it('restoreSnapshot restores prior state', () => {
    const dir = tmpDir();
    const accts = makeAccounts(dir);
    accts.credit(ALICE, 1000, { mature: true });
    const snap = accts.snapshot();
    accts.credit(ALICE, 9999, { mature: true });
    accts.restoreSnapshot(snap);
    assert.strictEqual(accts.getBalance(ALICE).confirmed, 1000);
  });
});

function _run() {
  const labels = ['construction', 'credit', 'transfer', 'applyBlock', 'stateHash', 'rebuildFromBlocks', 'snapshot'];
  for (const _label of labels) {
    try {
      require(`./wtc-accounts.test`)._run();
    } catch (_) {}
  }
}

if (require.main === module) {
  let failed = false;
  try {
    require('./wtc-accounts.test');
  } catch (e) {
    failed = true;
    console.error('Test suite failed:', e.message);
  }
  _tmpDirs.forEach(rmrf);
  if (failed) process.exit(1);
  console.log('\nAll account tests passed.');
}
