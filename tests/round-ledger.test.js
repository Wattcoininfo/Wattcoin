'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRoundLedger } = require('../round-ledger');

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    // Best-effort cleanup.
  }
}

function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-round-ledger-'));

  try {
    const ledger = createRoundLedger({
      baseDir,
      signingSecret: 'round-ledger-test-secret',
    });

    const address = 'wtc1qtestroundledger000000000000000000000000000';
    const first = ledger.setRoundContribution(address, 12.5, 1_000);
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.addressRoundWh, 12.5);

    const stale = ledger.setRoundContribution(address, 4.25, 900);
    assert.strictEqual(stale.ok, false);
    assert.strictEqual(stale.code, 'STALE_CONTRIBUTION');
    assert.strictEqual(ledger.getRoundContribution(address), 12.5);

    const newer = ledger.setRoundContribution(address, 4.25, 1_100);
    assert.strictEqual(newer.ok, true);
    assert.strictEqual(newer.addressRoundWh, 4.25);
    assert.strictEqual(ledger.getRoundContribution(address), 4.25);

    console.log('round ledger tests passed');
  } finally {
    rmrf(baseDir);
  }
}

run();
