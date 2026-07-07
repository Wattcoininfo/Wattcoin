'use strict';
/**
 * wtc-contribution.test.js
 *
 * Tests energy contribution validation logic for inflation resistance.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRoundLedger } = require('../round-ledger');
const { generateKeypair } = require('../wtc-address');

const TEST_SECRET = 'test-contribution-hmac';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-contrib-test-'));
}

function silenceLogs(fn) {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

let passed = 0,
  failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

async function run() {
  await test('setRoundContribution accepts and retrieves a contribution', () => {
    const dir = tmpDir();
    try {
      const ledger = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      const kp = generateKeypair();
      const r = ledger.setRoundContribution(kp.address, 12.5, 1000);
      assert.ok(r.ok, 'setRoundContribution must succeed');
      assert.strictEqual(r.addressRoundWh, 12.5);
      assert.strictEqual(ledger.getRoundContribution(kp.address), 12.5);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await test('setRoundContribution rejects stale (older timestamp)', () => {
    const dir = tmpDir();
    try {
      const ledger = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      const kp = generateKeypair();
      ledger.setRoundContribution(kp.address, 100, Date.now());
      const r = ledger.setRoundContribution(kp.address, 200, 1);
      assert.strictEqual(r.ok, false, 'stale timestamp must be rejected');
      assert.strictEqual(r.code, 'STALE_CONTRIBUTION');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await test('setRoundContribution rejects reduction (Wh decreased)', () => {
    const dir = tmpDir();
    try {
      const ledger = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      const kp = generateKeypair();
      ledger.setRoundContribution(kp.address, 100, 1000);
      const r = ledger.setRoundContribution(kp.address, 50, 2000);
      assert.strictEqual(r.ok, false, 'Wh reduction must be rejected');
      assert.strictEqual(r.code, 'REDUCTION_NOT_ALLOWED');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await test('Round ledger persists and reloads', () => {
    const dir = tmpDir();
    try {
      const kp = generateKeypair();
      const l1 = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      l1.setRoundContribution(kp.address, 42, 5000);
      const l2 = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      l2.load();
      assert.strictEqual(l2.getRoundContribution(kp.address), 42, 'contribution survives reload');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await test('HMAC tamper detection resets state', () => {
    const dir = tmpDir();
    try {
      const kp = generateKeypair();
      const l1 = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      l1.setRoundContribution(kp.address, 99, 1000);

      // Tamper directly with the file
      const filePath = path.join(dir, 'round-ledger.json');
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      raw.currentRound.contributionsWh[kp.address] = 999999;
      fs.writeFileSync(filePath, JSON.stringify(raw), 'utf8');

      // Reload: HMAC mismatch should discard state
      const l2 = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      l2.load();
      assert.notStrictEqual(l2.getRoundContribution(kp.address), 999999, 'tampered contribution must be rejected');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await test('getCurrentRoundSnapshot returns round structure', () => {
    const dir = tmpDir();
    try {
      const ledger = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      // After fresh create, there should be a round 1 with no contributions
      const snap = ledger.getCurrentRoundSnapshot();
      assert.ok(snap, 'snapshot must exist');
      assert.strictEqual(typeof snap.id, 'number', 'round id must be a number');
      assert.ok(snap.id >= 1, 'round id must be >= 1');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await test('settleCurrentRound advances round', () => {
    const dir = tmpDir();
    try {
      const kp = generateKeypair();
      const ledger = createRoundLedger({ baseDir: dir, signingSecret: TEST_SECRET });
      const snap1 = ledger.getCurrentRoundSnapshot();
      silenceLogs(() => {
        ledger.settleCurrentRound({
          blockHash: '0'.repeat(64),
          minedAddress: kp.address,
          blockHeight: 1,
          rewardCoins: 500,
          contributionsWh: null,
        });
      });
      const snap2 = ledger.getCurrentRoundSnapshot();
      assert.ok(snap2.id > snap1.id, 'round id must increase after settle');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  console.log('');
  console.log(`  Contribution: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
