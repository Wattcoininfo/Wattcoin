'use strict';
/**
 * wtc-governance.test.js
 *
 * Tests governance proposal lifecycle, voting, quorum, treasury transfer
 * validation, and the two critical bugs found in the audit:
 *   C1 — governance_result tx amount=0 rejected by mempool
 *   C2 — consensus _validateBlock sigInput format mismatch
 *   M1 — double-voting via NFT transfer
 *   M2 — no NFT ownership check for proposal creator in store API
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { GovernanceStore, GOVERNANCE_MAX_TRANSFER } = require('../wtc-governance');
const { generateKeypair, sign, txHash } = require('../wtc-address');
const { Mempool } = require('../wtc-mempool');
const { Consensus } = require('../wtc-consensus');
const { computeBlockHash } = require('../wtc-chain');

const TEST_SECRET = 'test-governance-hmac';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-gov-test-'));
}

function makeStore(dir, nftStore) {
  return new GovernanceStore({ dataDir: dir, signingSecret: TEST_SECRET, nftStore });
}

function makeNftStoreMock(holdings) {
  // holdings: { address: [ { nftId, metadata: { tier, shares } }, ... ] }
  return {
    getNftsForAddress(addr) {
      return holdings[addr] || [];
    },
    getDistributedVotingPower() {
      let totalPower = 0;
      let distributedCount = 0;
      for (const nfts of Object.values(holdings)) {
        for (const n of nfts) {
          totalPower += (n.metadata && n.metadata.shares) || 0;
          distributedCount++;
        }
      }
      return { totalPower, distributedCount, totalPossible: 140 };
    },
  };
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

// ─── Helpers: build governance_result tx as wtc-node.js signs it ────────────

function signGovernanceResultTx(tx, privateKeyHex) {
  tx.chainId = 'wtc-mainnet';
  const sigFields = {
    id: tx.id,
    type: tx.type,
    from: tx.from,
    to: tx.to,
    amount: tx.amount,
    fee: tx.fee,
    nonce: tx.nonce,
    chainId: tx.chainId,
    governanceData: tx.governanceData,
  };
  const sortedKeys = Object.keys(sigFields).sort();
  const sigInput = JSON.stringify(sigFields, sortedKeys);
  tx.sig = sign(txHash(sigInput), Buffer.from(privateKeyHex, 'hex'));
  return tx;
}

function makeGovernanceResultTx({
  pipId,
  outcome,
  from,
  nonce,
  privateKey,
  voteTallies,
  title,
  transferTo,
  transferAmount,
}) {
  const tx = GovernanceStore.buildGovernanceResultTx({
    pipId,
    outcome,
    from,
    nonce,
    voteTallies: voteTallies || { for: 0, against: 0 },
    title: title || '',
    transferTo,
    transferAmount,
  });
  return signGovernanceResultTx(tx, privateKey);
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
  // ─── C1: governance_result tx accepted by mempool (amount=0 bypassed) ────
  await test('C1 — governance_result tx with amount=0 is accepted by mempool', () => {
    const kp = generateKeypair();
    const mempool = new Mempool();
    const tx = makeGovernanceResultTx({
      pipId: 'pip-test-1',
      outcome: 'passed',
      from: kp.address,
      nonce: 0,
      privateKey: kp.privateKey,
    });
    assert.strictEqual(tx.amount, 0, 'governance_result tx amount must be 0');
    assert.strictEqual(tx.fee, 0, 'governance_result tx fee must be 0');
    const result = mempool.add(tx);
    assert.strictEqual(result.ok, true, 'mempool must accept governance_result tx with amount=0');
  });

  // ─── C2: consensus _validateBlock sigInput mismatch ──────────────────────
  await test('C2 — consensus _validateBlock uses wrong sigInput for governance_result', async () => {
    const kp = generateKeypair();
    const tx = makeGovernanceResultTx({
      pipId: 'pip-test-2',
      outcome: 'passed',
      from: kp.address,
      nonce: 0,
      privateKey: kp.privateKey,
      title: 'Test',
      voteTallies: { for: 100, against: 0 },
    });

    // Build block with all required proof fields
    const stateRoot = crypto.createHash('sha256').update('stub').digest('hex');
    const block = {
      height: 1,
      prevHash: '0'.repeat(64),
      timestamp: Date.now(),
      proposer: kp.address,
      energyWh: 10000000,
      proofCommitment: 'c2-test',
      transactions: [tx],
      rewardAddresses: { [kp.address]: 500 },
      rewardTotal: 500,
      stateRoot,
      nftsRoot: stateRoot,
      cpuSpeedInitialSeed: 1,
      cpuSpeedProof: 'abc123',
      memProof: 'def456',
      memProofSeed: 0,
      gpuProof: '',
      gpuProofSeed: 0,
      attestationVersion: 1,
      peerProbeVerified: false,
      probeReceipt: null,
    };
    block.hash = computeBlockHash(block);

    const chainStub = {
      buildBlock: () => block,
      getHeight: () => 0,
      getTip: () => null,
      getBlockByHash: () => null,
      append: () => {},
      nextBlockReward: () => 500,
      rewardForHeight: () => 500,
    };

    const consensus = new Consensus({
      chain: chainStub,
      accounts: { stateHash: () => stateRoot, applyBlock: () => {} },
      mempool: { removeAll: () => {} },
      getActivePeers: () => [],
      requestPeerJson: () => Promise.resolve({ ok: false }),
      privateKey: Buffer.from(kp.privateKey, 'hex'),
      allowPartialQuorumCommit: true,
      verifyCpuSpeedProof: () => Promise.resolve(true),
      verifyMemProof: () => Promise.resolve(true),
    });

    const err = await consensus._validateBlock(block);
    assert.strictEqual(err, null, `consensus _validateBlock must accept governance_result tx, got: ${err}`);
  });

  // ─── M1: Double-voting via NFT transfer prevented ────────────────────────
  await test('M1 — NFT-based voting prevents same NFT from voting twice', () => {
    const dir = tmpDir();
    try {
      const alice = generateKeypair();
      const bob = generateKeypair();

      const nftStore = makeNftStoreMock({
        [alice.address]: [{ nftId: 'vhpn-1', metadata: { tier: 'gold', shares: 5 } }],
        [bob.address]: [],
      });

      const store = makeStore(dir, nftStore);
      const now = Date.now();

      // Alice (NFT holder) creates proposal
      const addResult = store.addProposal({
        pipId: 'pip-test-3',
        title: 'Test',
        description: 'Test',
        creator: alice.address,
        createdAt: now,
        creatorNftId: 'vhpn-1',
        creatorTier: 'gold',
      });
      assert.strictEqual(addResult.ok, true, 'NFT-holding creator must be allowed');

      const p = store._proposals['pip-test-3'];
      p.status = 'active';
      p.commentPeriodEndsAt = now - 1;

      // Alice votes with her gold NFT (power=5)
      const vote1 = store.addVote('pip-test-3', {
        voter: alice.address,
        vote: 'for',
        power: 5,
        nftTier: 'gold',
        nftId: 'vhpn-1',
        timestamp: now,
        signature: 'sig1',
      });
      assert.strictEqual(vote1.ok, true, 'Alice must be able to vote');
      assert.strictEqual(store._proposals['pip-test-3'].voteTallies.for, 5, 'Alice for=5');

      // Bob tries to vote with same NFT — rejected (already voted)
      const vote2 = store.addVote('pip-test-3', {
        voter: bob.address,
        vote: 'for',
        power: 5,
        nftTier: 'gold',
        nftId: 'vhpn-1',
        timestamp: now + 1,
        signature: 'sig2',
      });
      assert.strictEqual(vote2.ok, false, 'Bob must be rejected — NFT already voted');
      assert.ok(vote2.error.includes('already voted'), `error: ${vote2.error}`);
      assert.strictEqual(
        store._proposals['pip-test-3'].voteTallies.for,
        5,
        'tally must still be 5 (not 10) after rejecting double vote',
      );
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // ─── M1b: Non-NFT voter rejected ─────────────────────────────────────────
  await test('M1 — non-NFT-holding voter is rejected', () => {
    const dir = tmpDir();
    try {
      const alice = generateKeypair();
      const mallory = generateKeypair();

      const nftStore = makeNftStoreMock({
        [alice.address]: [{ nftId: 'vhpn-1', metadata: { tier: 'gold', shares: 5 } }],
        [mallory.address]: [],
      });

      const store = makeStore(dir, nftStore);
      const now = Date.now();

      store.addProposal({
        pipId: 'pip-nft-vote',
        title: 'Test',
        description: '',
        creator: alice.address,
        createdAt: now,
        creatorNftId: 'vhpn-1',
        creatorTier: 'gold',
      });
      const p = store._proposals['pip-nft-vote'];
      p.status = 'active';
      p.commentPeriodEndsAt = now - 1;

      // Mallory has no NFTs — vote rejected
      const vote = store.addVote('pip-nft-vote', {
        voter: mallory.address,
        vote: 'for',
        power: 1,
        nftTier: 'bronze',
        timestamp: now,
        signature: 'sig-m',
      });
      assert.strictEqual(vote.ok, false, 'non-NFT voter must be rejected');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // ─── M2: Proposal creation requires NFT ──────────────────────────────────
  await test('M2 — GovernanceStore.addProposal rejects non-NFT-holding creator', () => {
    const dir = tmpDir();
    try {
      const kp = generateKeypair();
      const nftStore = makeNftStoreMock({});
      const store = makeStore(dir, nftStore);
      const result = store.addProposal({
        pipId: 'pip-spam-1',
        title: 'Spam',
        description: 'No NFT',
        creator: kp.address,
        createdAt: Date.now(),
      });
      assert.strictEqual(result.ok, false, 'non-NFT-holding creator must be rejected');
      assert.ok(result.error.includes('NFT'), `error must mention NFT: ${result.error}`);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  await test('M2 — GovernanceStore.addProposal accepts NFT-holding creator', () => {
    const dir = tmpDir();
    try {
      const kp = generateKeypair();
      const nftStore = makeNftStoreMock({
        [kp.address]: [{ nftId: 'vhpn-1', metadata: { tier: 'gold', shares: 5 } }],
      });
      const store = makeStore(dir, nftStore);
      const result = store.addProposal({
        pipId: 'pip-legit',
        title: 'Real',
        description: 'Has NFT',
        creator: kp.address,
        createdAt: Date.now(),
        creatorNftId: 'vhpn-1',
        creatorTier: 'gold',
      });
      assert.strictEqual(result.ok, true, 'NFT-holding creator must be allowed');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // ─── validateGovernanceTransfer ──────────────────────────────────────────
  await test('validateGovernanceTransfer rejects transfer > MAX_TRANSFER', () => {
    const store = makeStore(tmpDir());
    const validAddr = generateKeypair().address;
    const result = store.validateGovernanceTransfer(validAddr, GOVERNANCE_MAX_TRANSFER + 1);
    assert.strictEqual(result.ok, false, 'transfer above MAX_TRANSFER must be rejected');
    assert.ok(result.error, 'error message must be present');
  });

  await test('validateGovernanceTransfer accepts transfer within limits', () => {
    const store = makeStore(tmpDir());
    const validAddr = generateKeypair().address;
    const result = store.validateGovernanceTransfer(validAddr, 10000);
    assert.strictEqual(result.ok, true, 'valid transfer must be accepted');
  });

  await test('validateGovernanceTransfer rejects invalid address', () => {
    const store = makeStore(tmpDir());
    const result = store.validateGovernanceTransfer('not-a-valid-address', 1000);
    assert.strictEqual(result.ok, false, 'invalid address must be rejected');
  });

  await test('validateGovernanceTransfer rejects zero amount', () => {
    const store = makeStore(tmpDir());
    const validAddr = generateKeypair().address;
    const result = store.validateGovernanceTransfer(validAddr, 0);
    assert.strictEqual(result.ok, false, 'zero amount must be rejected');
  });

  // ─── buildGovernanceResultTx ─────────────────────────────────────────────
  await test('buildGovernanceResultTx has amount=0, fee=0, type=governance_result', () => {
    const tx = GovernanceStore.buildGovernanceResultTx({
      pipId: 'pip-shape',
      outcome: 'passed',
      from: 'wtc1qgov',
      nonce: 0,
      voteTallies: { for: 80, against: 20 },
    });
    assert.strictEqual(tx.type, 'governance_result');
    assert.strictEqual(tx.amount, 0);
    assert.strictEqual(tx.fee, 0);
    assert.ok(tx.governanceData);
    assert.strictEqual(tx.governanceData.pipId, 'pip-shape');
  });

  // ─── GovernanceStore.validateTx ──────────────────────────────────────────
  await test('GovernanceStore.validateTx accepts correctly-signed governance_result', () => {
    const dir = tmpDir();
    try {
      const kp = generateKeypair();
      const store = makeStore(
        dir,
        makeNftStoreMock({
          [kp.address]: [{ nftId: 'vhpn-vt-1', metadata: { tier: 'gold', shares: 50 } }],
        }),
      );
      const now = Date.now();
      silenceLogs(() => {
        store.addProposal({
          pipId: 'pip-validate',
          title: 'Validate',
          description: '',
          creator: kp.address,
          createdAt: now - 86400000,
          creatorNftId: 'vhpn-vt-1',
          creatorTier: 'gold',
        });
      });
      store._proposals['pip-validate'].status = 'active';
      silenceLogs(() => {
        store.addVote('pip-validate', {
          voter: kp.address,
          power: 5,
          nftTier: 'gold',
          nftId: 'vhpn-vt-1',
          vote: 'for',
          signature: 'test-sig',
          timestamp: now + 1000,
        });
      });
      const tx = makeGovernanceResultTx({
        pipId: 'pip-validate',
        outcome: 'passed',
        from: kp.address,
        nonce: 0,
        privateKey: kp.privateKey,
      });
      assert.strictEqual(store.validateTx(tx), true, 'validateTx must accept correctly-signed tx');
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  // ─── GovernanceStore.applyBlock ──────────────────────────────────────────
  await test('GovernanceStore.applyBlock updates proposal status', () => {
    const dir = tmpDir();
    try {
      const store = makeStore(dir);
      const now = Date.now();
      store.addProposal({
        pipId: 'pip-apply',
        title: 'Apply',
        description: '',
        creator: 'alice',
        createdAt: now,
        creatorNftId: 'vhpn-1',
        creatorTier: 'gold',
      });
      const block = {
        height: 10,
        hash: '0'.repeat(64),
        timestamp: now + 100000,
        transactions: [
          {
            type: 'governance_result',
            from: 'alice',
            to: 'alice',
            governanceData: {
              pipId: 'pip-apply',
              outcome: 'passed',
              title: 'Apply',
              voteTallies: { for: 100, against: 0 },
              timestamp: now + 100000,
            },
          },
        ],
      };
      silenceLogs(() => store.applyBlock(block));
      assert.strictEqual(store._proposals['pip-apply'].status, 'passed');
      assert.strictEqual(store._proposals['pip-apply'].recordedAtHeight, 10);
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_) {}
    }
  });

  console.log('');
  console.log(`  Governance: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
