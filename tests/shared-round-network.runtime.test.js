'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWtcNode } = require('../wtc-node');
const { createRoundLedger } = require('../round-ledger');
const { energyForHeight } = require('../wtc-chain');
const { generateKeypair } = require('../wtc-address');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    // Best effort cleanup.
  }
}

function writeCanonicalGenesis(dirPath, teamAddress) {
  const genesisPath = path.join(dirPath, 'wtc-genesis.json');
  const genesis = {
    timestamp: 1710000000000,
    teamWallets: [{ address: teamAddress, amount: 1_000_000 }],
  };
  fs.writeFileSync(genesisPath, JSON.stringify(genesis, null, 2), 'utf8');
}

function almostEqual(a, b, epsilon = 1e-8) {
  return Math.abs(Number(a) - Number(b)) <= epsilon;
}

class SimulatedPeerNetwork {
  constructor() {
    this.nodes = new Map();
    this.links = new Map();
  }

  addNode(id, node) {
    this.nodes.set(id, node);
    if (!this.links.has(id)) this.links.set(id, new Set());
  }

  connectBidirectional(a, b) {
    if (!this.links.has(a)) this.links.set(a, new Set());
    if (!this.links.has(b)) this.links.set(b, new Set());
    this.links.get(a).add(b);
    this.links.get(b).add(a);
  }

  fullyConnect(ids) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        this.connectBidirectional(ids[i], ids[j]);
      }
    }
  }

  getActivePeers(id) {
    return Array.from(this.links.get(id) || []);
  }

  request(fromId, peerId, method, routePath, payload, query = {}) {
    const reachable = this.links.has(fromId) && this.links.get(fromId).has(peerId);
    if (!reachable) throw new Error(`network partition: ${fromId} -> ${peerId} blocked`);
    const target = this.nodes.get(peerId);
    if (!target) throw new Error(`unknown peer ${peerId}`);

    if (method === 'GET' && routePath === '/api/v1/chain/tip') {
      return target.handleGetTip();
    }
    if (method === 'GET' && routePath === '/api/v1/chain/headers') {
      return target.handleGetHeaders(query.fromHeight, query.limit);
    }
    if (method === 'GET' && routePath === '/api/v1/chain/blocks') {
      return target.handleGetBlocks(query.fromHeight, query.limit);
    }
    if (method === 'GET' && routePath.startsWith('/api/v1/chain/block/')) {
      const hash = routePath.slice('/api/v1/chain/block/'.length);
      return target.handleGetBlockByHash(hash);
    }
    if (method === 'POST' && routePath === '/api/v1/chain/propose') {
      return target.handleProposal(payload, fromId);
    }
    if (method === 'POST' && routePath === '/api/v1/chain/vote') {
      return target.handleVote(payload);
    }

    throw new Error(`unsupported route ${method} ${routePath}`);
  }
}

function createNode(id, dataDir, net) {
  const node = createWtcNode({
    dataDir,
    signingSecret: `shared-round-${id}`,
    allowPartialQuorumCommit: false,
    verifyCpuSpeedProof: () => Promise.resolve(true),
    verifyMemProof: () => Promise.resolve(true),
    getActivePeers: () => net.getActivePeers(id),
    requestPeerJson: (peerUrl, method, routePath, payload, query) =>
      net.request(id, peerUrl, method, routePath, payload, query),
  });
  net.addNode(id, node);
  return node;
}

function buildRewardMap(contributionsWh, rewardTotal) {
  const entries = Object.entries(contributionsWh)
    .map(([address, value]) => [String(address || '').trim(), Math.max(0, Number(value) || 0)])
    .filter(([address, value]) => address && value > 0);
  const totalWh = entries.reduce((sum, [, value]) => sum + value, 0);
  const rewardMap = {};
  let allocated = 0;
  entries.forEach(([address, value], index) => {
    const isLast = index === entries.length - 1;
    const share = isLast
      ? Number((rewardTotal - allocated).toFixed(8))
      : Number(((rewardTotal * value) / totalWh).toFixed(8));
    allocated = Number((allocated + share).toFixed(8));
    rewardMap[address] = share;
  });
  return rewardMap;
}

async function converge(nodes, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    for (const node of nodes) {
      await node.syncWithPeers();
    }
  }
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-shared-round-network-'));
  try {
    const network = new SimulatedPeerNetwork();
    const teamAddress = generateKeypair().address;
    const aDir = path.join(baseDir, 'A');
    const bDir = path.join(baseDir, 'B');
    const cDir = path.join(baseDir, 'C');
    ensureDir(aDir);
    ensureDir(bDir);
    ensureDir(cDir);
    writeCanonicalGenesis(aDir, teamAddress);
    writeCanonicalGenesis(bDir, teamAddress);
    writeCanonicalGenesis(cDir, teamAddress);

    const A = createNode('A', aDir, network);
    const B = createNode('B', bDir, network);
    const C = createNode('C', cDir, network);
    network.fullyConnect(['A', 'B', 'C']);

    const ledgerA = createRoundLedger({ baseDir: path.join(aDir, 'ledger') });
    const ledgerB = createRoundLedger({ baseDir: path.join(bDir, 'ledger') });
    const ledgerC = createRoundLedger({ baseDir: path.join(cDir, 'ledger') });
    const ledgers = [ledgerA, ledgerB, ledgerC];

    const addrA = A.getPrimaryAddress();
    const addrB = B.getPrimaryAddress();
    const addrC = C.getPrimaryAddress();
    const roundId = 1;
    const tier1ThresholdWh = energyForHeight(1);

    const belowThreshold = {
      [addrA]: 2_000_000,
      [addrB]: 3_000_000,
      [addrC]: 4_999_999,
    };
    for (const ledger of ledgers) {
      ledger.beginRound(roundId, Date.now());
      ledger.setRoundContribution(addrA, belowThreshold[addrA]);
      ledger.setRoundContribution(addrB, belowThreshold[addrB]);
      ledger.setRoundContribution(addrC, belowThreshold[addrC]);
    }

    const belowTotalWh = Object.values(belowThreshold).reduce((sum, value) => sum + value, 0);
    await assert.rejects(
      () =>
        A.mineBlock(
          addrA,
          {
            energyWh: belowTotalWh,
            proofCommitment: 'shared-round-below-threshold',
            cpuSpeedInitialSeed: 1,
            cpuSpeedProof: 'abc123',
            memProof: 'def456',
            memProofSeed: 0,
          },
          buildRewardMap(belowThreshold, 500),
        ),
      /insufficient energyWh: required 10000000, got 9999999/,
      'pooled round below threshold should not mine a block',
    );
    assert.strictEqual(A.getHeight(), 0, 'below-threshold attempt must leave chain at genesis');

    const exactThreshold = {
      [addrA]: 2_000_000,
      [addrB]: 3_000_000,
      [addrC]: 5_000_000,
    };
    for (const ledger of ledgers) {
      ledger.beginRound(roundId, Date.now());
      ledger.setRoundContribution(addrA, exactThreshold[addrA]);
      ledger.setRoundContribution(addrB, exactThreshold[addrB]);
      ledger.setRoundContribution(addrC, exactThreshold[addrC]);
    }

    const exactTotalWh = Object.values(exactThreshold).reduce((sum, value) => sum + value, 0);
    assert.strictEqual(exactTotalWh, tier1ThresholdWh, 'shared round total should hit exact Tier1 threshold');

    const mined = await A.mineBlock(
      addrA,
      {
        energyWh: exactTotalWh,
        proofCommitment: 'shared-round-threshold-hit',
        cpuSpeedInitialSeed: 1,
        cpuSpeedProof: 'abc123',
        memProof: 'def456',
        memProofSeed: 0,
      },
      buildRewardMap(exactThreshold, 500),
    );

    assert.strictEqual(mined.height, 1, 'threshold hit should commit the first mined block');
    await converge([A, B, C], 4);
    assert.strictEqual(B.getHeight(), 1, 'peer B should sync the mined block');
    assert.strictEqual(C.getHeight(), 1, 'peer C should sync the mined block');
    assert.strictEqual(B.getTip().hash, A.getTip().hash, 'peer B tip should converge to proposer tip');
    assert.strictEqual(C.getTip().hash, A.getTip().hash, 'peer C tip should converge to proposer tip');

    const block = A.getTip();
    assert.ok(block, 'mined block should exist at the tip');
    assert.strictEqual(block.rewardTotal, 500, 'Tier1 block reward should remain 500 WTC');
    assert.ok(almostEqual(block.energyWh, tier1ThresholdWh), 'block energy should reflect the shared threshold total');
    assert.ok(almostEqual(block.rewardAddresses[addrA], 100), 'address A should receive 20% of block reward');
    assert.ok(almostEqual(block.rewardAddresses[addrB], 150), 'address B should receive 30% of block reward');
    assert.ok(almostEqual(block.rewardAddresses[addrC], 250), 'address C should receive 50% of block reward');

    for (const ledger of ledgers) {
      const settled = ledger.settleCurrentRound({
        blockHash: block.hash,
        minedAddress: addrA,
        blockHeight: block.height,
        rewardCoins: block.rewardTotal,
        contributionsWh: exactThreshold,
      });
      assert.ok(almostEqual(settled.totalWh, tier1ThresholdWh), 'settled round should keep the shared total');
      assert.ok(almostEqual(settled.sharesByAddress[addrA], 100), 'ledger share for A should match block reward split');
      assert.ok(almostEqual(settled.sharesByAddress[addrB], 150), 'ledger share for B should match block reward split');
      assert.ok(almostEqual(settled.sharesByAddress[addrC], 250), 'ledger share for C should match block reward split');
      assert.strictEqual(ledger.getRoundContribution(addrA), 0, 'new round should reset A contribution to 0');
      assert.strictEqual(ledger.getRoundContribution(addrB), 0, 'new round should reset B contribution to 0');
      assert.strictEqual(ledger.getRoundContribution(addrC), 0, 'new round should reset C contribution to 0');
      assert.strictEqual(
        ledger.getCurrentRoundSnapshot().id,
        2,
        'settlement should advance each ledger to the next round',
      );
    }

    console.log('shared round network runtime test passed');
  } finally {
    rmrf(baseDir);
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
