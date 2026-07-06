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

function testProbeChainSegmentsBasic() {
  const dir = mkTempDir();
  try {
    const ledger = createRoundLedger({ baseDir: dir });
    const addr = 'addrSegTest';

    // Single continuous chain
    ledger.addContribution(addr, 10, 50);
    let data = ledger.getProbeChainData(addr);
    assert.strictEqual(data.totalProbes, 50);
    assert.strictEqual(data.maxChainIndex, 50);
    assert.strictEqual(data.segmentCount, 1);

    // Extend the chain
    ledger.addContribution(addr, 5, 75);
    data = ledger.getProbeChainData(addr);
    assert.strictEqual(data.totalProbes, 75);
    assert.strictEqual(data.maxChainIndex, 75);
    assert.strictEqual(data.segmentCount, 1);

    // Restart: chainIndex resets, starts a new segment
    ledger.addContribution(addr, 3, 20);
    data = ledger.getProbeChainData(addr);
    assert.strictEqual(data.totalProbes, 95); // 75 + 20
    assert.strictEqual(data.maxChainIndex, 75); // highest single segment end
    assert.strictEqual(data.segmentCount, 2);
  } finally {
    cleanup(dir);
  }
}

function testProbeChainSegmentsMultipleRestarts() {
  const dir = mkTempDir();
  try {
    const ledger = createRoundLedger({ baseDir: dir });
    const addr = 'addrMultiRestart';

    // Three restarts within one round
    ledger.addContribution(addr, 10, 100); // segment 1: 1-100
    ledger.addContribution(addr, 5, 40); // segment 2: 1-40 (restart)
    ledger.addContribution(addr, 8, 60); // segment 2: extend to 1-60
    ledger.addContribution(addr, 2, 10); // segment 3: 1-10 (restart)

    const data = ledger.getProbeChainData(addr);
    assert.strictEqual(data.totalProbes, 100 + 60 + 10); // 170
    assert.strictEqual(data.maxChainIndex, 100);
    assert.strictEqual(data.segmentCount, 3);
  } finally {
    cleanup(dir);
  }
}

function testProbeChainSegmentsInSnapshot() {
  const dir = mkTempDir();
  try {
    const ledger = createRoundLedger({ baseDir: dir });
    const addr = 'addrSnapTest';

    ledger.addContribution(addr, 10, 100);
    ledger.addContribution(addr, 3, 25);

    const snap = ledger.getCurrentRoundSnapshot();
    assert.ok(snap.probeChainSegments);
    const segs = snap.probeChainSegments[addr];
    assert.ok(Array.isArray(segs));
    assert.strictEqual(segs.length, 2);
    assert.strictEqual(segs[0].startIndex, 1);
    assert.strictEqual(segs[0].endIndex, 100);
    assert.strictEqual(segs[1].startIndex, 1);
    assert.strictEqual(segs[1].endIndex, 25);
  } finally {
    cleanup(dir);
  }
}

function testProbeChainSegmentsMigratedFromV1() {
  const dir = mkTempDir();
  try {
    const ledgerPath = path.join(dir, LEDGER_FILE_NAME);
    const oldState = {
      version: 1,
      nextRoundId: 5,
      currentRound: {
        id: 5,
        startedAtMs: Date.now(),
        contributionsWh: { addrOld: 42 },
        probeChainIndex: { addrOld: 88 },
      },
      rounds: [],
      balancesByAddress: {},
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify(oldState, null, 2), 'utf8');

    const migrated = createRoundLedger({ baseDir: dir });
    const data = migrated.getProbeChainData('addrOld');
    assert.strictEqual(data.totalProbes, 88);
    assert.strictEqual(data.maxChainIndex, 88);
    assert.strictEqual(data.segmentCount, 1);
  } finally {
    cleanup(dir);
  }
}

function testProbeChainSegmentsInSettledRound() {
  const dir = mkTempDir();
  try {
    const ledger = createRoundLedger({ baseDir: dir });
    const addr = 'addrSettleSeg';

    ledger.addContribution(addr, 100, 150);
    ledger.addContribution(addr, 30, 40);

    const round = ledger.settleCurrentRound({
      blockHash: 'seg-block',
      minedAddress: addr,
      blockHeight: 30,
    });

    assert.ok(round.probeChainSegments);
    const segs = round.probeChainSegments[addr];
    assert.ok(Array.isArray(segs));
    assert.strictEqual(segs.length, 2);
    assert.strictEqual(segs[0].endIndex, 150);
    assert.strictEqual(segs[1].endIndex, 40);
  } finally {
    cleanup(dir);
  }
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
  testProbeChainSegmentsBasic();
  testProbeChainSegmentsMultipleRestarts();
  testProbeChainSegmentsInSnapshot();
  testProbeChainSegmentsMigratedFromV1();
  testProbeChainSegmentsInSettledRound();
  testProportionalSplitAndMaturity();
  testSettleIdempotencyByBlockHash();
  testTempFileRecoveryOnLoad();
  console.log('round-ledger integration tests passed');
}

run();
