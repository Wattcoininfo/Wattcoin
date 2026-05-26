'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWtcNode } = require('../wtc-node');
const { energyForHeight } = require('../wtc-chain');
const { generateKeypair } = require('../wtc-address');

const TIER1_ENERGY_WH = 10_000_000;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeCanonicalGenesis(dirPath, teamAddress) {
  const genesisPath = path.join(dirPath, 'wtc-genesis.json');
  const genesis = {
    timestamp: 1710000000000,
    teamWallets: [{ address: teamAddress, amount: 1_000_000 }],
  };
  fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2), 'utf8');
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    // Best effort cleanup.
  }
}

function createStandaloneNode(id, dataDir) {
  return createWtcNode({
    dataDir,
    signingSecret: `tier1-threshold-${id}`,
    allowPartialQuorumCommit: false,
    getActivePeers: () => [],
    requestPeerJson: () => {
      throw new Error('unexpected peer RPC in standalone test');
    },
  });
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-tier1-threshold-'));
  try {
    const teamAddress = generateKeypair().address;
    const exactDir = path.join(baseDir, 'exact-threshold');
    const belowDir = path.join(baseDir, 'below-threshold');
    const aboveDir = path.join(baseDir, 'above-threshold');
    ensureDir(exactDir);
    ensureDir(belowDir);
    ensureDir(aboveDir);
    writeCanonicalGenesis(exactDir, teamAddress);
    writeCanonicalGenesis(belowDir, teamAddress);
    writeCanonicalGenesis(aboveDir, teamAddress);

    assert.strictEqual(
      energyForHeight(1),
      TIER1_ENERGY_WH,
      'height-1 energy threshold should be exactly 10,000,000 Wh',
    );

    const exactNode = createStandaloneNode('exact', exactDir);
    const exactAddr = exactNode.getPrimaryAddress();
    const exactBlock = await exactNode.mineBlock(exactAddr, {
      energyWh: TIER1_ENERGY_WH,
      proofCommitment: 'tier1-exact-threshold',
    });
    assert.strictEqual(exactBlock.height, 1, 'exact-threshold block should mine at height 1');
    assert.strictEqual(exactNode.getHeight(), 1, 'exact-threshold node should advance to height 1');

    const belowNode = createStandaloneNode('below', belowDir);
    const belowAddr = belowNode.getPrimaryAddress();
    await assert.rejects(
      () =>
        belowNode.mineBlock(belowAddr, {
          energyWh: TIER1_ENERGY_WH - 1,
          proofCommitment: 'tier1-below-threshold',
        }),
      /insufficient energyWh: required 10000000, got 9999999/,
      'sub-threshold Tier1 block should be rejected',
    );
    assert.strictEqual(belowNode.getHeight(), 0, 'rejected sub-threshold block should leave chain at genesis only');

    const aboveNode = createStandaloneNode('above', aboveDir);
    const aboveAddr = aboveNode.getPrimaryAddress();
    const aboveBlock = await aboveNode.mineBlock(aboveAddr, {
      energyWh: TIER1_ENERGY_WH + 1,
      proofCommitment: 'tier1-above-threshold',
    });
    assert.strictEqual(aboveBlock.height, 1, 'above-threshold block should mine at height 1');
    assert.strictEqual(aboveNode.getHeight(), 1, 'above-threshold node should advance to height 1');

    console.log('wtc tier1 energy threshold tests passed');
  } finally {
    rmrf(baseDir);
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
