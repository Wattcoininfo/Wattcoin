const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRoundLedger } = require('../round-ledger');

const LEDGER_FILE_NAME = 'round-ledger.json';

function mkTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wattcoin-ledger-test-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function almostEqual(a, b, epsilon = 1e-8) {
  return Math.abs(Number(a) - Number(b)) <= epsilon;
}

function testProportionalSplitAndMaturity() {
  const dir = mkTempDir();
  try {
    const ledger = createRoundLedger({ baseDir: dir });
    ledger.addContribution('addrA', 75);
    ledger.addContribution('addrB', 25);
    const round = ledger.settleCurrentRound({
      blockHash: 'block-1',
      minedAddress: 'addrA',
      blockHeight: 10,
    });

    assert.strictEqual(round.blockHash, 'block-1');
    assert.ok(almostEqual(round.rewardCoins, 1000));
    assert.ok(almostEqual(round.sharesByAddress.addrA, 750));
    assert.ok(almostEqual(round.sharesByAddress.addrB, 250));

    const beforeMaturityA = ledger.getAddressSnapshot('addrA');
    const beforeMaturityB = ledger.getAddressSnapshot('addrB');
    assert.ok(almostEqual(beforeMaturityA.pending, 750));
    assert.ok(almostEqual(beforeMaturityA.matured, 0));
    assert.ok(almostEqual(beforeMaturityB.pending, 250));
    assert.ok(almostEqual(beforeMaturityB.matured, 0));

    ledger.syncMaturity(109);
    const stillPending = ledger.getAddressSnapshot('addrA');
    assert.ok(almostEqual(stillPending.pending, 750));
    assert.ok(almostEqual(stillPending.matured, 0));

    ledger.syncMaturity(110);
    const maturedA = ledger.getAddressSnapshot('addrA');
    const maturedB = ledger.getAddressSnapshot('addrB');
    assert.ok(almostEqual(maturedA.pending, 0));
    assert.ok(almostEqual(maturedA.matured, 750));
    assert.ok(almostEqual(maturedB.pending, 0));
    assert.ok(almostEqual(maturedB.matured, 250));
  } finally {
    cleanup(dir);
  }
}

function testSettleIdempotencyByBlockHash() {
  const dir = mkTempDir();
  try {
    const ledger = createRoundLedger({ baseDir: dir });
    ledger.addContribution('addrX', 10);

    const first = ledger.settleCurrentRound({
      blockHash: 'same-block',
      minedAddress: 'addrX',
      blockHeight: 20,
    });
    const afterFirst = ledger.getAddressSnapshot('addrX');

    const second = ledger.settleCurrentRound({
      blockHash: 'same-block',
      minedAddress: 'addrX',
      blockHeight: 20,
    });
    const afterSecond = ledger.getAddressSnapshot('addrX');

    assert.strictEqual(first.blockHash, 'same-block');
    assert.strictEqual(second.duplicateBlock, true);
    assert.strictEqual(second.idempotent, true);
    assert.ok(almostEqual(afterFirst.total, afterSecond.total));
  } finally {
    cleanup(dir);
  }
}

function testTempFileRecoveryOnLoad() {
  const dir = mkTempDir();
  try {
    const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
    const tempPath = `${ledgerPath}.tmp`;

    const recoveryState = {
      version: 1,
      nextRoundId: 3,
      currentRound: {
        id: 3,
        startedAtMs: Date.now(),
        contributionsWh: {},
      },
      rounds: [],
      balancesByAddress: {
        addrR: {
          pending: 12.5,
          matured: 87.5,
          totalCredited: 100,
        },
      },
    };

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(recoveryState, null, 2), 'utf8');
    if (fs.existsSync(ledgerPath)) fs.rmSync(ledgerPath, { force: true });

    const recovered = createRoundLedger({ baseDir: dir });
    recovered.load();
    const snapshot = recovered.getAddressSnapshot('addrR');

    assert.strictEqual(fs.existsSync(ledgerPath), true);
    assert.strictEqual(fs.existsSync(tempPath), false);
    assert.ok(almostEqual(snapshot.pending, 12.5));
    assert.ok(almostEqual(snapshot.matured, 87.5));
    assert.ok(almostEqual(snapshot.total, 100));
  } finally {
    cleanup(dir);
  }
}

function run() {
  testProportionalSplitAndMaturity();
  testSettleIdempotencyByBlockHash();
  testTempFileRecoveryOnLoad();
  console.log('round-ledger integration tests passed');
}

run();
