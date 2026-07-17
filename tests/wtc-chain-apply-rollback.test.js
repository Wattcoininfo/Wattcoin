'use strict';
/**
 * Risk: in handlePushBlocks and _applyCandidateChain, _accounts.rebuildFromBlocks
 * runs before _nfts.rebuildFromBlocks and _chain.replaceWithBlocks.  If
 * _nfts.rebuildFromBlocks throws (e.g. corrupt NFT data, unexpected token type),
 * the accounts are already in the candidate state while the chain is still at
 * the old height — with no rollback to restore accounts.
 *
 * Expected outcome: the test PASSES by confirming the inconsistency exists.
 * This is a documentation/regression test.  If a rollback is added later the
 * assertion on balanceAfter should be updated to equal balanceBefore.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWtcNode } = require('../electron-main/wtc-node');
const { generateKeypair } = require('../electron-main/wtc-address');

const ENERGY_WH_PER_BLOCK = 10_000_000;

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function rmrf(t) {
  try {
    fs.rmSync(t, { recursive: true, force: true });
  } catch (_) {}
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

function standaloneNode(id, dir) {
  return createWtcNode({
    dataDir: dir,
    signingSecret: `secret-${id}`,
    allowPartialQuorumCommit: true,
    verifyCpuSpeedProof: () => Promise.resolve(true),
    getActivePeers: () => [],
    requestPeerJson: () => {
      throw new Error('no peers in test');
    },
  });
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-chain-apply-rollback-'));
  try {
    const team = generateKeypair().address;

    // ── Node B: mine one block so we have a valid 1-block extension ──────────
    const bDir = path.join(baseDir, 'node-b');
    ensureDir(bDir);
    writeGenesis(bDir, team);
    const nodeB = standaloneNode('b', bDir);
    await nodeB.mineBlock(nodeB.getPrimaryAddress(), {
      energyWh: ENERGY_WH_PER_BLOCK,
      proofCommitment: 'rollback-risk-test',
      cpuSpeedInitialSeed: 1,
      cpuSpeedProof: 'abc123',
    });
    assert.strictEqual(nodeB.getHeight(), 1, 'node B should be at height 1 after mining');

    // ── Node A: starts at genesis, will receive node B's block ───────────────
    const aDir = path.join(baseDir, 'node-a');
    ensureDir(aDir);
    writeGenesis(aDir, team);
    const nodeA = standaloneNode('a', aDir);
    assert.strictEqual(nodeA.getHeight(), 0, 'node A starts at genesis (height 0)');

    const minerAddr = nodeB.getPrimaryAddress();
    const balanceBefore = nodeA.getBalance(minerAddr); // 0 — miner not known to node A yet

    // Build the candidate chain that _applyCandidateChain would receive after a
    // successful peer sync: genesis_A + block_1_B.  Both nodes share the same
    // genesis config so the hashes link correctly.
    const candidate = [nodeA._chain.getBlock(0), nodeB.getBlock(1)];

    // Verify the candidate is structurally valid before patching anything.
    const seqCheck = nodeA._chain.validateSequence(candidate);
    assert.strictEqual(seqCheck.ok, true, 'candidate chain should be structurally valid');

    // Patch node A's NFT store to throw after the accounts rebuild completes.
    // This simulates a corrupt NFT token type, an unknown NFT operation, or any
    // other error that makes _nfts.rebuildFromBlocks fail mid-stream.
    nodeA._nfts.rebuildFromBlocks = (_blocks) => {
      throw new Error('simulated NFT rebuild failure');
    };

    // Call _applyCandidateChain — no longer throws; returns { ok, reason } with accounts rolled back.
    let result;
    try {
      result = nodeA._applyCandidateChain(candidate, {
        localHeight: 0,
        peer: 'node-b',
        ancestor: 0,
        imported: 1,
        mode: 'push',
      });
    } catch (e) {
      assert.fail('_applyCandidateChain should not throw when NFT rebuild fails after rollback fix');
    }

    assert.strictEqual(result.ok, false, '_applyCandidateChain should return ok:false when NFT rebuild fails');
    assert.match(result.reason, /simulated NFT rebuild failure/, 'reason should mention simulated NFT rebuild failure');

    // Chain must NOT have advanced — _chain.replaceWithBlocks comes after the NFT
    // rebuild call and was never reached.
    assert.strictEqual(
      nodeA.getHeight(),
      0,
      'chain height must still be 0 because replaceWithBlocks was never reached',
    );

    // Accounts are now ROLLED BACK to their original state thanks to the snapshot
    // restoration added in the rollback fix.
    const balanceAfter = nodeA.getBalance(minerAddr);
    assert.deepStrictEqual(
      balanceAfter,
      balanceBefore,
      'accounts should be restored to pre-candidate state after NFT rebuild rollback',
    );

    console.log('[PASS] chain-apply-rollback: NFT rebuild failure correctly rolled back accounts', {
      chainHeight: nodeA.getHeight(),
      balanceBefore,
      balanceAfter,
    });
  } finally {
    rmrf(baseDir);
  }
}

run().catch((err) => {
  console.error('[FAIL] wtc-chain-apply-rollback:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
