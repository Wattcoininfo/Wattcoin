'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWtcNode } = require('../wtc-node');
const { generateKeypair } = require('../wtc-address');

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    // Best effort cleanup.
  }
}

function writeGenesis(dir, teamAddress) {
  fs.writeFileSync(
    path.join(dir, 'wtc-genesis.json'),
    JSON.stringify(
      {
        timestamp: 1710000000000,
        teamWallets: [{ address: teamAddress, amount: 1_000_000 }],
      },
      null,
      2,
    ),
    'utf8',
  );
}

function createStandaloneNode(dataDir, peerIdentity) {
  return createWtcNode({
    dataDir,
    signingSecret: `peer-identity-${peerIdentity}`,
    peerIdentity,
    allowPartialQuorumCommit: false,
    getActivePeers: () => [],
    requestPeerJson: async () => {
      throw new Error('unexpected peer RPC in peer identity test');
    },
  });
}

function createPeerProbeNode(dataDir, { peerIdentity, requestPeerJson, isSelfPeerUrl }) {
  return createWtcNode({
    dataDir,
    signingSecret: `peer-probe-${peerIdentity}`,
    peerIdentity,
    allowPartialQuorumCommit: false,
    getActivePeers: () => ['http://192.168.50.20:39310'],
    getPeerTargets: () => ['http://192.168.50.20:39310'],
    requestPeerJson,
    isSelfPeerUrl,
  });
}

function createDirectoryFallbackReadinessNode(dataDir, { peerIdentity, requestPeerJson }) {
  return createWtcNode({
    dataDir,
    signingSecret: `peer-directory-${peerIdentity}`,
    peerIdentity,
    allowPartialQuorumCommit: false,
    getActivePeers: () => ['http://198.51.100.1:39310'],
    getPeerTargets: () => ['http://198.51.100.1:39310', 'http://198.51.100.2:39310'],
    requestPeerJson,
  });
}

function createTunnelOnlyReadinessNode(dataDir, { peerIdentity, connectedPeerCount }) {
  return createWtcNode({
    dataDir,
    signingSecret: `peer-tunnel-${peerIdentity}`,
    peerIdentity,
    allowPartialQuorumCommit: false,
    getActivePeers: () => [],
    getPeerTargets: () => [],
    getConnectedPeerCount: () => connectedPeerCount,
    requestPeerJson: async () => {
      throw new Error('unexpected peer RPC in tunnel-only readiness test');
    },
  });
}

function createRecoveredPeerReadinessNode(dataDir, { peerIdentity, requestPeerJson }) {
  const recoveredPeer = 'http://198.51.100.30:39310';
  return createWtcNode({
    dataDir,
    signingSecret: `peer-recovered-${peerIdentity}`,
    peerIdentity,
    allowPartialQuorumCommit: false,
    getActivePeers: () => [recoveredPeer],
    getPeerTargets: () => [recoveredPeer],
    requestPeerJson,
  });
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-peer-identity-'));
  const nodeADir = path.join(baseDir, 'node-a');
  const nodeBDir = path.join(baseDir, 'node-b');
  const nodeCDir = path.join(baseDir, 'node-c');
  const nodeDDir = path.join(baseDir, 'node-d');
  const nodeEDir = path.join(baseDir, 'node-e');
  const nodeFDir = path.join(baseDir, 'node-f');
  const nodeGDir = path.join(baseDir, 'node-g');
  fs.mkdirSync(nodeADir, { recursive: true });
  fs.mkdirSync(nodeBDir, { recursive: true });
  fs.mkdirSync(nodeCDir, { recursive: true });
  fs.mkdirSync(nodeDDir, { recursive: true });
  fs.mkdirSync(nodeEDir, { recursive: true });
  fs.mkdirSync(nodeFDir, { recursive: true });
  fs.mkdirSync(nodeGDir, { recursive: true });

  const teamAddress = generateKeypair().address;
  writeGenesis(nodeADir, teamAddress);
  writeGenesis(nodeBDir, teamAddress);
  writeGenesis(nodeCDir, teamAddress);
  writeGenesis(nodeDDir, teamAddress);
  writeGenesis(nodeEDir, teamAddress);
  writeGenesis(nodeFDir, teamAddress);
  writeGenesis(nodeGDir, teamAddress);

  try {
    const nodeA = createStandaloneNode(nodeADir, 'a'.repeat(64));
    const walletPathA = path.join(nodeADir, 'wtc-wallet.json');
    const walletPathB = path.join(nodeBDir, 'wtc-wallet.json');
    fs.copyFileSync(walletPathA, walletPathB);

    const nodeB = createStandaloneNode(nodeBDir, 'b'.repeat(64));

    assert.strictEqual(
      nodeA.getPrimaryAddress(),
      nodeB.getPrimaryAddress(),
      'wallet clone should keep the same mining address',
    );
    assert.notStrictEqual(
      nodeA.getPeerIdentity(),
      nodeB.getPeerIdentity(),
      'peer identities should remain per-install',
    );
    assert.strictEqual(
      nodeA.handleGetTip().peerIdentity,
      'a'.repeat(64),
      'tip response should expose node A peer identity',
    );
    assert.strictEqual(
      nodeB.handleGetTip().peerIdentity,
      'b'.repeat(64),
      'tip response should expose node B peer identity',
    );

    const duplicateIdentity = 'c'.repeat(64);
    const nonSelfCollisionNode = createPeerProbeNode(nodeCDir, {
      peerIdentity: duplicateIdentity,
      requestPeerJson: async () => ({
        ok: true,
        height: 3,
        peerIdentity: duplicateIdentity,
        tip: { hash: 'f'.repeat(64) },
      }),
      isSelfPeerUrl: () => false,
    });
    const readiness = await nonSelfCollisionNode.getWalletReadiness();
    assert.strictEqual(
      readiness.connections,
      1,
      'matching peer identity on a non-self URL should still count as a reachable peer',
    );

    const actualSelfNode = createPeerProbeNode(nodeDDir, {
      peerIdentity: duplicateIdentity,
      requestPeerJson: async () => ({
        ok: true,
        height: 3,
        peerIdentity: duplicateIdentity,
        tip: { hash: 'e'.repeat(64) },
      }),
      isSelfPeerUrl: () => true,
    });
    const selfReadiness = await actualSelfNode.getWalletReadiness();
    assert.strictEqual(
      selfReadiness.connections,
      0,
      'actual self URLs must still be skipped even when the peer identity matches',
    );

    const tunnelOnlyNode = createTunnelOnlyReadinessNode(nodeEDir, {
      peerIdentity: 'e'.repeat(64),
      connectedPeerCount: 1,
    });
    const tunnelOnlyReadiness = await tunnelOnlyNode.getWalletReadiness();
    assert.strictEqual(
      tunnelOnlyReadiness.connections,
      1,
      'live connected tunnel peers should count toward readiness even without HTTP peer targets',
    );
    assert.strictEqual(
      tunnelOnlyReadiness.spendReady,
      true,
      'a live connected tunnel peer at network height should keep wallet readiness spendable',
    );

    const directoryFallbackNode = createDirectoryFallbackReadinessNode(nodeFDir, {
      peerIdentity: 'f'.repeat(64),
      requestPeerJson: async (peerUrl) => {
        if (peerUrl === 'http://198.51.100.1:39310') {
          throw new Error('configured peer unreachable');
        }
        if (peerUrl === 'http://198.51.100.2:39310') {
          return {
            ok: true,
            height: 6,
            peerIdentity: '1'.repeat(64),
            tip: { hash: 'd'.repeat(64) },
          };
        }
        throw new Error(`unexpected peer ${peerUrl}`);
      },
    });
    const directoryFallbackReadiness = await directoryFallbackNode.getWalletReadiness();
    assert.strictEqual(
      directoryFallbackReadiness.connections,
      1,
      'reachable directory peers should count even when active peers exist',
    );
    assert.strictEqual(
      directoryFallbackReadiness.bestPeerHeight,
      6,
      'reachable directory peer height should feed readiness',
    );
    assert.strictEqual(
      directoryFallbackReadiness.spendReady,
      false,
      'higher directory peer height should still keep readiness syncing',
    );
    assert.strictEqual(
      directoryFallbackReadiness.status,
      'syncing',
      'reachable higher directory peer should surface syncing readiness',
    );

    let recoveredPeerProbeCount = 0;
    const recoveredPeerNode = createRecoveredPeerReadinessNode(nodeGDir, {
      peerIdentity: 'g'.repeat(64),
      requestPeerJson: async () => {
        recoveredPeerProbeCount += 1;
        if (recoveredPeerProbeCount <= 3) {
          throw new Error('temporary external peer timeout');
        }
        return {
          ok: true,
          height: 0,
          peerIdentity: '2'.repeat(64),
          tip: { hash: 'c'.repeat(64) },
        };
      },
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failedReadiness = await recoveredPeerNode.getWalletReadiness();
      assert.strictEqual(
        failedReadiness.connections,
        0,
        'temporarily failing peer should not count as reachable before recovery',
      );
    }
    const recoveredReadiness = await recoveredPeerNode.getWalletReadiness();
    assert.strictEqual(
      recoveredReadiness.connections,
      1,
      'readiness should retry a recovered peer even after backoff was entered',
    );
    assert.strictEqual(
      recoveredReadiness.spendReady,
      true,
      'recovered peer at local height should restore spend-ready readiness',
    );
  } finally {
    rmrf(baseDir);
  }

  console.log('wtc peer identity tests passed');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
