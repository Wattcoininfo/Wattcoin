const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWtcNode } = require('../electron-main/wtc-node');
const { generateKeypair } = require('../electron-main/wtc-address');

const ENERGY_WH_PER_BLOCK = 10_000_000;

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

  disconnectBidirectional(a, b) {
    if (this.links.has(a)) this.links.get(a).delete(b);
    if (this.links.has(b)) this.links.get(b).delete(a);
  }

  isolate(id) {
    for (const other of this.nodes.keys()) {
      if (other === id) continue;
      this.disconnectBidirectional(id, other);
    }
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

function createNode(id, dataDir, net, opts = {}) {
  const node = createWtcNode({
    dataDir,
    signingSecret: `secret-${id}`,
    allowPartialQuorumCommit: false,
    verifyCpuSpeedProof: () => Promise.resolve(true),
    verifyMemProof: () => Promise.resolve(true),
    getActivePeers: () => net.getActivePeers(id),
    getTrustedPeerTargets: typeof opts.getTrustedPeerTargets === 'function' ? opts.getTrustedPeerTargets : undefined,
    requestPeerJson: (peerUrl, method, routePath, payload, query) => {
      if (typeof opts.requestPeerJson === 'function') {
        return opts.requestPeerJson(peerUrl, method, routePath, payload, query, () =>
          net.request(id, peerUrl, method, routePath, payload, query),
        );
      }
      return net.request(id, peerUrl, method, routePath, payload, query);
    },
  });
  net.addNode(id, node);
  return node;
}

async function mineN(node, n) {
  const addr = node.getPrimaryAddress();
  let mined = 0;
  let attempts = 0;
  const maxAttempts = Math.max(n * 20, 20);
  while (mined < n) {
    attempts += 1;
    if (attempts > maxAttempts) {
      throw new Error(`unable to mine ${n} blocks after ${attempts} attempts`);
    }
    try {
      await node.mineBlock(addr, {
        energyWh: ENERGY_WH_PER_BLOCK,
        proofCommitment: `test-${Date.now()}-${mined}`,
        cpuSpeedInitialSeed: 1,
        cpuSpeedProof: 'abc123',
        memProof: 'def456',
        memProofSeed: 0,
      });
      mined += 1;
    } catch (err) {
      const msg = err && err.message ? String(err.message) : '';
      if (msg.includes('quorum not reached')) {
        await node.syncWithPeers();
        continue;
      }
      throw err;
    }
  }
}

async function mineNWithFallback(nodes, n) {
  let mined = 0;
  let attempts = 0;
  const maxAttempts = Math.max(n * 30, 30);
  while (mined < n) {
    attempts += 1;
    if (attempts > maxAttempts) {
      throw new Error(`unable to mine ${n} fallback blocks after ${attempts} attempts`);
    }
    let committed = false;
    for (const node of nodes) {
      const addr = node.getPrimaryAddress();
      try {
        await node.mineBlock(addr, {
          energyWh: ENERGY_WH_PER_BLOCK,
          proofCommitment: `fallback-${Date.now()}-${mined}`,
          cpuSpeedInitialSeed: 1,
          cpuSpeedProof: 'abc123',
          memProof: 'def456',
          memProofSeed: 0,
        });
        committed = true;
        mined += 1;
        break;
      } catch (err) {
        const msg = err && err.message ? String(err.message) : '';
        if (!msg.includes('quorum not reached')) {
          throw err;
        }
      }
    }
    await converge(nodes, 1);
    if (!committed) {
      continue;
    }
  }
}

async function converge(nodes, rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    for (const n of nodes) {
      await n.syncWithPeers();
    }
  }
}

function tipHash(node) {
  const tip = node.getTip();
  return tip ? tip.hash : '';
}

async function scenarioPartitionHeal(baseDir) {
  const net = new SimulatedPeerNetwork();
  const aDir = path.join(baseDir, 'partition-a');
  const bDir = path.join(baseDir, 'partition-b');
  const cDir = path.join(baseDir, 'partition-c');
  ensureDir(aDir);
  ensureDir(bDir);
  ensureDir(cDir);

  const team = generateKeypair().address;
  writeCanonicalGenesis(aDir, team);
  writeCanonicalGenesis(bDir, team);
  writeCanonicalGenesis(cDir, team);

  const A = createNode('A', aDir, net);
  const B = createNode('B', bDir, net);
  const C = createNode('C', cDir, net);

  net.fullyConnect(['A', 'B', 'C']);
  net.isolate('A');
  net.connectBidirectional('B', 'C');

  await mineN(A, 3);
  await mineN(B, 5);

  net.fullyConnect(['A', 'B', 'C']);
  await converge([A, B, C], 8);

  const hA = A.getHeight();
  const hB = B.getHeight();
  const hC = C.getHeight();
  assert.strictEqual(hA, hB, 'partition/heal: A/B heights differ after heal');
  assert.strictEqual(hB, hC, 'partition/heal: B/C heights differ after heal');
  assert.strictEqual(tipHash(A), tipHash(B), 'partition/heal: A/B tip hash differs');
  assert.strictEqual(tipHash(B), tipHash(C), 'partition/heal: B/C tip hash differs');
  return { height: hA, tip: tipHash(A) };
}

async function scenarioConflictingBranches(baseDir) {
  const net = new SimulatedPeerNetwork();
  const aDir = path.join(baseDir, 'conflict-a');
  const bDir = path.join(baseDir, 'conflict-b');
  ensureDir(aDir);
  ensureDir(bDir);

  const team = generateKeypair().address;
  writeCanonicalGenesis(aDir, team);
  writeCanonicalGenesis(bDir, team);

  const A = createNode('A2', aDir, net);
  const B = createNode('B2', bDir, net);

  // Start partitioned (no links), mine competing equal-height branches.
  await mineN(A, 2);
  await mineN(B, 2);

  net.connectBidirectional('A2', 'B2');
  await converge([A, B], 6);

  assert.strictEqual(A.getHeight(), B.getHeight(), 'conflict: heights differ after sync');
  assert.strictEqual(tipHash(A), tipHash(B), 'conflict: tip hash differs after sync');
  return { height: A.getHeight(), tip: tipHash(A) };
}

async function scenarioRestartStorm(baseDir) {
  const net = new SimulatedPeerNetwork();
  const aDir = path.join(baseDir, 'restart-a');
  const bDir = path.join(baseDir, 'restart-b');
  const cDir = path.join(baseDir, 'restart-c');
  ensureDir(aDir);
  ensureDir(bDir);
  ensureDir(cDir);

  const team = generateKeypair().address;
  writeCanonicalGenesis(aDir, team);
  writeCanonicalGenesis(bDir, team);
  writeCanonicalGenesis(cDir, team);

  const A = createNode('A3', aDir, net);
  const B = createNode('B3', bDir, net);
  let C = createNode('C3', cDir, net);
  net.fullyConnect(['A3', 'B3', 'C3']);

  await mineNWithFallback([A, B, C], 4);
  await converge([A, B, C], 4);

  // Restart storm for C while A keeps mining.
  for (let i = 0; i < 3; i++) {
    await mineNWithFallback([A, B], 2);
    net.nodes.delete('C3');
    C = createNode('C3', cDir, net);
    net.fullyConnect(['A3', 'B3', 'C3']);
    await converge([A, B, C], 5);
  }

  assert.strictEqual(A.getHeight(), B.getHeight(), 'restart: A/B heights differ');
  assert.strictEqual(B.getHeight(), C.getHeight(), 'restart: B/C heights differ');
  assert.strictEqual(tipHash(A), tipHash(B), 'restart: A/B tip hash differs');
  assert.strictEqual(tipHash(B), tipHash(C), 'restart: B/C tip hash differs');
  return { height: A.getHeight(), tip: tipHash(A) };
}

async function scenarioTrustedBootstrapRecovery(baseDir) {
  const net = new SimulatedPeerNetwork();
  const aDir = path.join(baseDir, 'trusted-bootstrap-a');
  const bDir = path.join(baseDir, 'trusted-bootstrap-b');
  ensureDir(aDir);
  ensureDir(bDir);

  const team = generateKeypair().address;
  writeCanonicalGenesis(aDir, team);
  writeCanonicalGenesis(bDir, team);

  const B = createNode('B4', bDir, net);
  const A = createNode('A4', aDir, net, {
    getTrustedPeerTargets: () => ['B4'],
    requestPeerJson: (peerUrl, method, routePath, payload, query, fallback) => {
      if (peerUrl === 'B4' && method === 'GET' && routePath === '/api/v1/chain/headers') {
        return Promise.resolve({ ok: true, headers: [{ hash: `mismatch-${query.fromHeight}` }] });
      }
      return fallback();
    },
  });

  net.connectBidirectional('A4', 'B4');
  await mineN(B, 4);

  const syncRes = await A.syncWithPeers();
  assert.strictEqual(Boolean(syncRes && syncRes.ok), true, 'trusted bootstrap: sync should succeed');
  assert.strictEqual(syncRes.mode, 'trusted-bootstrap', 'trusted bootstrap: recovery mode not used');
  assert.strictEqual(A.getHeight(), B.getHeight(), 'trusted bootstrap: heights differ after recovery');
  assert.strictEqual(tipHash(A), tipHash(B), 'trusted bootstrap: tip hash differs after recovery');
  return { height: A.getHeight(), tip: tipHash(A), mode: syncRes.mode };
}

async function scenarioTrustedSameHeightConflict(baseDir) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const net = new SimulatedPeerNetwork();
    const aDir = path.join(baseDir, `trusted-same-height-a-${attempt}`);
    const bDir = path.join(baseDir, `trusted-same-height-b-${attempt}`);
    ensureDir(aDir);
    ensureDir(bDir);

    const team = generateKeypair().address;
    writeCanonicalGenesis(aDir, team);
    writeCanonicalGenesis(bDir, team);

    const A = createNode('A5', aDir, net, {
      getTrustedPeerTargets: () => ['B5'],
    });
    const B = createNode('B5', bDir, net);

    await mineN(A, 2);
    await mineN(B, 2);

    const aTip = tipHash(A);
    const bTip = tipHash(B);
    if (!(aTip && bTip) || !(bTip < aTip)) {
      continue;
    }

    net.connectBidirectional('A5', 'B5');
    const syncRes = await A.syncWithPeers();
    assert.strictEqual(Boolean(syncRes && syncRes.ok), true, 'trusted same-height: sync should succeed');
    assert.strictEqual(Boolean(syncRes && syncRes.synced), true, 'trusted same-height: sync should not be skipped');
    assert.strictEqual(A.getHeight(), B.getHeight(), 'trusted same-height: heights differ after sync');
    assert.strictEqual(tipHash(A), tipHash(B), 'trusted same-height: tip hash differs after sync');
    return { height: A.getHeight(), tip: tipHash(A), peer: syncRes.peer || '' };
  }

  throw new Error('trusted same-height: unable to construct lower-hash trusted peer conflict');
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-adversarial-'));
  try {
    const s1 = await scenarioPartitionHeal(baseDir);
    const s2 = await scenarioConflictingBranches(baseDir);
    const s3 = await scenarioRestartStorm(baseDir);
    const s4 = await scenarioTrustedBootstrapRecovery(baseDir);
    const s5 = await scenarioTrustedSameHeightConflict(baseDir);
    console.log('[PASS] partition/heal', s1);
    console.log('[PASS] conflicting-branches', s2);
    console.log('[PASS] restart-storm', s3);
    console.log('[PASS] trusted-bootstrap-recovery', s4);
    console.log('[PASS] trusted-same-height-conflict', s5);
  } finally {
    rmrf(baseDir);
  }
}

run().catch((err) => {
  console.error('[FAIL] adversarial runtime test:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
