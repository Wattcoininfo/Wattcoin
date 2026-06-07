const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Accounts } = require('../wtc-accounts');
const { computeBlockHash } = require('../wtc-chain');
const { createWtcNode } = require('../wtc-node');
const { generateKeypair } = require('../wtc-address');

const ENERGY_WH_PER_BLOCK = 10_000_000;
const LEGACY_BLOCK_ONE_STATE_ROOT = '81ec02a5243792a58f9de21b67a216b03faa25ac1cb03ce114c4d53545a36c10';

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

  getActivePeers(id) {
    return Array.from(this.links.get(id) || []);
  }

  request(fromId, peerId, method, routePath, payload, query = {}) {
    const reachable = this.links.has(fromId) && this.links.get(fromId).has(peerId);
    if (!reachable) {
      throw new Error(`network partition: ${fromId} -> ${peerId} blocked`);
    }
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

    throw new Error(`unsupported route ${method} ${routePath}`);
  }
}

function createNode(id, dataDir, net) {
  const node = createWtcNode({
    dataDir,
    signingSecret: `secret-${id}`,
    allowPartialQuorumCommit: false,
    verifyCpuSpeedProof: async () => true,
    verifyMemProof: async () => true,
    getActivePeers: () => net.getActivePeers(id),
    requestPeerJson: (peerUrl, method, routePath, payload, query) =>
      net.request(id, peerUrl, method, routePath, payload, query),
  });
  net.addNode(id, node);
  return node;
}

async function mineOneBlock(node) {
  const addr = node.getPrimaryAddress();
  await node.mineBlock(addr, { energyWh: ENERGY_WH_PER_BLOCK, proofCommitment: 'legacy-state-root-test', cpuSpeedInitialSeed: 1, cpuSpeedProof: 'abc123', memProof: 'def456', memProofSeed: 0 });
}

function injectLegacyStateRoot(node) {
  const mutated = JSON.parse(JSON.stringify(node.getBlock(1)));
  mutated.stateRoot = LEGACY_BLOCK_ONE_STATE_ROOT;
  mutated.hash = computeBlockHash(mutated);

  node._chain._blocks[1] = mutated;
  node._chain._byHash = {
    [node._chain._blocks[0].hash]: node._chain._blocks[0],
    [mutated.hash]: mutated,
  };

  return mutated;
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-state-root-sync-compat-'));
  try {
    const net = new SimulatedPeerNetwork();
    const aDir = path.join(baseDir, 'node-a');
    const bDir = path.join(baseDir, 'node-b');
    ensureDir(aDir);
    ensureDir(bDir);

    const team = generateKeypair().address;
    writeCanonicalGenesis(aDir, team);
    writeCanonicalGenesis(bDir, team);

    const peer = createNode('B', bDir, net);
    await mineOneBlock(peer);
    const mutatedBlock = injectLegacyStateRoot(peer);

    const strictReplay = new Accounts({ dataDir: path.join(baseDir, 'strict-check'), signingSecret: 'strict-check' });
    assert.throws(
      () => strictReplay.rebuildFromBlocks([peer.getBlock(0), mutatedBlock]),
      /stateRoot mismatch at height 1/,
      'strict replay should still reject the legacy stateRoot',
    );

    const fresh = createNode('A', aDir, net);
    net.connectBidirectional('A', 'B');

    const syncRes = await fresh.syncWithPeers();
    assert.strictEqual(Boolean(syncRes && syncRes.ok), true, 'sync should succeed with legacy stateRoot compatibility');
    assert.strictEqual(Boolean(syncRes && syncRes.synced), true, 'sync should import the legacy peer chain');
    assert.strictEqual(fresh.getHeight(), 1, 'fresh node should import block 1');
    assert.strictEqual(fresh.getTip().hash, mutatedBlock.hash, 'fresh node should adopt the peer tip');

    console.log('[PASS] legacy stateRoot sync compatibility', {
      importedHeight: fresh.getHeight(),
      tip: fresh.getTip().hash,
      ignoredStateRoot: mutatedBlock.stateRoot,
    });
  } finally {
    rmrf(baseDir);
  }
}

run().catch((err) => {
  console.error('[FAIL] legacy stateRoot sync compatibility:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
