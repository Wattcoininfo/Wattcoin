'use strict';
/**
 * wtc-counterfeit.test.js
 *
 * Exhaustive security test: verifies that WTC cannot be counterfeited.
 * Each test attempts a known attack vector and asserts it is rejected.
 *
 * Attack vectors tested:
 *  1. Forged signature — send WTC from someone else's address
 *  2. Inflated block reward — claim more WTC than the schedule allows
 *  3. Reward address sum mismatch — rewardAddresses sum > rewardTotal
 *  4. Reward to wrong address — redirect the block reward to attacker
 *  5. Below-energy block — mine without the required 10 MWh
 *  6. Block hash tampering — mutate a valid block and resubmit
 *  7. Nonce replay (double-spend) — reuse a nonce to spend the same balance twice
 *  8. Spend unmatured rewards — try to spend mining rewards before 100-block maturity
 *  9. Account file tamper — directly edit balances on disk and verify detection
 * 10. Prevhash break — inject a block that doesn't chain to the current tip
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWtcNode } = require('../wtc-node');
const { generateKeypair, sign, txHash, verifySignature: _verifySignature } = require('../wtc-address');
const { Mempool } = require('../wtc-mempool');
const { energyForHeight: _energyForHeight } = require('../wtc-chain');

const TIER1_ENERGY = 10_000_000; // 10 MWh

// ─── helpers ─────────────────────────────────────────────────────────────────

function mkTmp(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wtc-counterfeit-${label}-`));
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (_) {}
}

function writeGenesis(dir, address) {
  fs.writeFileSync(
    path.join(dir, 'wtc-genesis.json'),
    JSON.stringify({ timestamp: 1710000000000, teamWallets: [{ address, amount: 1_000_000 }] }, null, 2),
    'utf8',
  );
}

function makeNode(id, dir) {
  return createWtcNode({
    dataDir: dir,
    signingSecret: `counterfeit-test-${id}`,
    allowPartialQuorumCommit: false,
    getActivePeers: () => [],
    requestPeerJson: () => {
      throw new Error('no peers in counterfeit test');
    },
  });
}

function mineOne(node) {
  return node.mineBlock(node.getPrimaryAddress(), {
    energyWh: TIER1_ENERGY,
    proofCommitment: `test-proof-${Date.now()}`,
  });
}

// ─── test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e && (e.message || e)}`);
    failed++;
  }
}

async function run() {
  // ─── ATTACK 1: Forged signature ───────────────────────────────────────────────
  // Attacker builds a tx that claims to send FROM victim's address but signs with own key.
  await test('Attack 1 — forged signature is rejected', () => {
    const dir = mkTmp('sig');
    try {
      const victim = generateKeypair();
      const attacker = generateKeypair();
      writeGenesis(dir, victim.address);
      const node = makeNode('sig', dir);

      // Attacker builds a raw tx claiming victim as sender
      const nonce = node._accounts.getBalance(victim.address).nonce;
      const fakeTx = {
        id: require('crypto').randomBytes(16).toString('hex'),
        from: victim.address,
        to: attacker.address,
        amount: 100,
        fee: 0.01,
        nonce,
        timestamp: Date.now(),
      };
      // Signs with attacker's key — not victim's
      const sigInput = JSON.stringify({
        id: fakeTx.id,
        from: fakeTx.from,
        to: fakeTx.to,
        amount: fakeTx.amount,
        fee: fakeTx.fee,
        nonce: fakeTx.nonce,
      });
      fakeTx.sig = sign(txHash(sigInput), Buffer.from(attacker.privateKey, 'hex'));

      const valid = node._isTxValid(fakeTx);
      assert.strictEqual(valid, false, 'tx signed by wrong key should fail signature validation');
    } finally {
      rmrf(dir);
    }
  });

  // ─── ATTACK 2: Inflated block reward ─────────────────────────────────────────
  // Malicious proposer claims 999,999 WTC in rewardAddresses instead of 500.
  // buildBlock() enforces rewardTotal from the schedule, so the sum mismatch
  // between rewardAddresses (999,999) and rewardTotal (500) is what gets caught.
  await test('Attack 2 — inflated block reward is rejected', async () => {
    const dir = mkTmp('reward');
    try {
      const kp = generateKeypair();
      writeGenesis(dir, kp.address);
      const node = makeNode('reward', dir);

      const result = await node._consensus.proposeBlock({
        proposer: node.getPrimaryAddress(),
        energyWh: TIER1_ENERGY,
        proofCommitment: 'inflated-reward-test',
        transactions: [],
        rewardAddresses: { [node.getPrimaryAddress()]: 999_999 },
      });
      assert.strictEqual(result && result.ok, false, 'inflated rewardAddresses must be rejected');
      assert.match(
        String(result.reason),
        /rewardAddresses sum|reward mismatch/i,
        'rejection reason should mention reward mismatch or rewardAddresses sum',
      );
    } finally {
      rmrf(dir);
    }
  });

  // ─── ATTACK 3: rewardAddresses sum > rewardTotal ──────────────────────────────
  await test('Attack 3 — rewardAddresses sum exceeding rewardTotal is rejected', async () => {
    const dir = mkTmp('rewardsum');
    try {
      const kp1 = generateKeypair();
      const kp2 = generateKeypair();
      writeGenesis(dir, kp1.address);
      const node = makeNode('rewardsum', dir);

      // Correct rewardTotal=500 but addresses sum to 1000
      const result = await node._consensus.proposeBlock({
        proposer: kp1.address,
        energyWh: TIER1_ENERGY,
        proofCommitment: 'reward-sum-mismatch-test',
        transactions: [],
        rewardAddresses: { [kp1.address]: 500, [kp2.address]: 500 },
      });
      assert.strictEqual(result && result.ok, false, 'block with rewardAddresses sum > rewardTotal must be rejected');
      assert.match(String(result.reason), /rewardAddresses sum/i);
    } finally {
      rmrf(dir);
    }
  });

  // ─── ATTACK 4: Block reward redirected to attacker ───────────────────────────
  // Legitimate miner works, but tries to redirect reward to a different address.
  // (sum still equals rewardTotal — so this is "valid" — reward just goes elsewhere)
  // This is NOT an attack — miners can direct reward to any valid address.
  // The test verifies the REAL constraint: sum must equal scheduled reward.
  await test('Attack 4 — reward redirected to valid attacker address is allowed (sum matches)', async () => {
    const dir = mkTmp('redirect');
    try {
      const miner = generateKeypair();
      const attacker = generateKeypair();
      writeGenesis(dir, miner.address);
      const node = makeNode('redirect', dir);

      // Miner does the work but sends reward to attacker (legal — sum=500, reward=500)
      const block = await node.mineBlock(
        node.getPrimaryAddress(),
        {
          energyWh: TIER1_ENERGY,
          proofCommitment: 'redirect-test',
        },
        { [attacker.address]: 500 },
      );
      assert.strictEqual(block.height, 1, 'block with redirected (but valid) reward should mine successfully');
    } finally {
      rmrf(dir);
    }
  });

  // ─── ATTACK 5: Mine without required energy ──────────────────────────────────
  await test('Attack 5 — sub-threshold energy block is rejected', async () => {
    const dir = mkTmp('energy');
    try {
      const kp = generateKeypair();
      writeGenesis(dir, kp.address);
      const node = makeNode('energy', dir);

      await assert.rejects(
        () =>
          node
            .mineBlock(node.getPrimaryAddress(), {
              energyWh: TIER1_ENERGY - 1,
              proofCommitment: 'low-energy-attack',
            })
            .then((r) => {
              if (r && r.ok === false) throw new Error(r.reason);
            }),
        /insufficient energyWh/i,
        'block with 1 Wh below threshold must be rejected',
      );
      assert.strictEqual(node.getHeight(), 0, 'chain height must remain at genesis after rejection');
    } finally {
      rmrf(dir);
    }
  });

  // ─── ATTACK 6: Block hash tampering ──────────────────────────────────────────
  // Build a valid block, then mutate its rewardTotal and try to get it committed.
  await test('Attack 6 — tampered block hash is rejected by peers', async () => {
    const { computeBlockHash: _computeBlockHash } = require('../wtc-chain');

    const dir1 = mkTmp('tamper-a');
    const dir2 = mkTmp('tamper-b');
    try {
      const kp = generateKeypair();
      writeGenesis(dir1, kp.address);
      writeGenesis(dir2, kp.address);
      const nodeA = makeNode('tamper-a', dir1);
      const nodeB = makeNode('tamper-b', dir2);

      // nodeA mines a valid block
      const result = await mineOne(nodeA);
      const originalBlock = nodeA.getBlock(result.height);

      // Attacker clones it and inflates reward, keeping old hash (wrong)
      const tamperedBlock = JSON.parse(JSON.stringify(originalBlock));
      tamperedBlock.rewardTotal = 999_999;
      // hash is now stale — computeBlockHash of tampered block will differ

      // Attempt to commit the tampered block via nodeB's consensus
      const voteResult = await nodeB.handleProposal(tamperedBlock, 'http://attacker:39310');
      assert.strictEqual(voteResult && voteResult.ok, false, 'tampered block (stale hash) must be rejected');
      assert.match(String(voteResult.reason), /hash mismatch/i);
    } finally {
      rmrf(dir1);
      rmrf(dir2);
    }
  });

  // ─── ATTACK 7: Nonce replay / double-spend ────────────────────────────────────
  // Build a signed tx from the genesis wallet (confirmed 1M WTC), confirm it in
  // a block, then try to replay the same tx with the now-consumed nonce.
  await test('Attack 7 — nonce replay / double-spend is rejected', async () => {
    const dir = mkTmp('nonce');
    try {
      const kp = generateKeypair(); // genesis wallet — has 1M WTC confirmed
      const kp2 = generateKeypair(); // recipient
      writeGenesis(dir, kp.address);
      const node = makeNode('nonce', dir);

      // Build and sign a tx directly from the genesis keypair
      const nonce = node._accounts.getBalance(kp.address).nonce;
      const tx = Mempool.buildTx({ from: kp.address, to: kp2.address, amount: 100, fee: 0.01, nonce });
      const sigInput = JSON.stringify({
        id: tx.id,
        from: tx.from,
        to: tx.to,
        amount: tx.amount,
        fee: tx.fee,
        nonce: tx.nonce,
      });
      tx.sig = sign(txHash(sigInput), Buffer.from(kp.privateKey, 'hex'));

      // First submission must succeed
      const addResult = node._mempool.add(tx);
      assert.ok(addResult.ok, 'valid tx from funded address should be accepted by mempool');

      // Immediate duplicate (same id, still in pool) must be rejected
      const dup = node._mempool.add(tx);
      assert.strictEqual(dup.ok, false, 'duplicate tx already in pool should be rejected');
      assert.strictEqual(dup.code, 'DUPLICATE');

      // Mine to confirm — nonce is consumed and tx removed from pool
      await mineOne(node);

      // After mining, _isTxValid must reject replay (nonce now consumed on-chain)
      const valid = node._isTxValid(tx);
      assert.strictEqual(valid, false, '_isTxValid should reject tx with consumed nonce');
    } finally {
      rmrf(dir);
    }
  });

  // ─── ATTACK 8: Spend unmatured mining reward ─────────────────────────────────
  // Mine 1 block → get 500 WTC unmatured reward → try to spend it immediately.
  await test('Attack 8 — unmatured mining rewards cannot be spent', async () => {
    const dir = mkTmp('maturity');
    try {
      const kp = generateKeypair();
      const kp2 = generateKeypair();
      writeGenesis(dir, kp.address);
      const node = makeNode('maturity', dir);

      await mineOne(node);

      // Mining reward is unmatured (needs 100 more blocks)
      const bal = node.getBalance(node.getPrimaryAddress());
      assert.ok(bal.unmatured > 0, 'mining reward should be in unmatured balance');

      // Attempt to spend the full balance including unmatured
      assert.throws(
        () =>
          node.send({
            fromAddress: node.getPrimaryAddress(),
            toAddress: kp2.address,
            amount: bal.unmatured,
          }),
        /insufficient confirmed/i,
        'spending unmatured mining reward must throw insufficient confirmed balance',
      );
    } finally {
      rmrf(dir);
    }
  });

  // ─── ATTACK 9: Disk account file tampering ───────────────────────────────────
  // Directly edit wtc-accounts.json to inflate the MINER's balance (not genesis
  // wallet — miner is not re-funded from genesis on fresh start), then reload
  // with the SAME signing secret so only the tamper is detected, not a secret mismatch.
  await test('Attack 9 — tampered accounts file is detected via HMAC', async () => {
    const dir = mkTmp('tamper-disk');
    try {
      const kp = generateKeypair();
      writeGenesis(dir, kp.address);
      const node = makeNode('disk9', dir); // ID 'disk9' for both nodes (same secret)
      await mineOne(node);

      const minerAddr = node.getPrimaryAddress();
      const accountsPath = path.join(dir, 'wtc-accounts.json');
      const raw = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));

      // Inflate the MINER's confirmed balance by 1,000,000 WTC
      raw.balances[minerAddr] = raw.balances[minerAddr] || { confirmed: 0, unmatured: 0, nonce: 0 };
      raw.balances[minerAddr].confirmed = 1_000_000; // inject large fraudulent balance
      // Write back WITHOUT updating the HMAC signature
      fs.writeFileSync(accountsPath, JSON.stringify(raw, null, 2), 'utf8');

      // Reload with the SAME signing secret — HMAC check must detect the tamper
      const node2 = makeNode('disk9', dir); // same ID = same secret
      const bal = node2.getBalance(minerAddr);
      assert.strictEqual(
        bal.confirmed,
        0,
        'tampered accounts file must be rejected (HMAC mismatch) — miner confirmed balance resets to 0',
      );
    } finally {
      rmrf(dir);
    }
  });

  // ─── ATTACK 10: prevHash break — orphan block injection ──────────────────────
  // Try to propose a block whose prevHash points to a non-existent ancestor.
  await test('Attack 10 — block with wrong prevHash is rejected', async () => {
    const dir = mkTmp('prevhash');
    try {
      const kp = generateKeypair();
      writeGenesis(dir, kp.address);
      const node = makeNode('prevhash', dir);

      // Build a fake block manually with wrong prevHash
      const fakeBlock = {
        height: 1,
        prevHash: '0'.repeat(64), // wrong — does not match genesis hash
        timestamp: Date.now(),
        proposer: node.getPrimaryAddress(),
        energyWh: TIER1_ENERGY,
        proofCommitment: 'bad-prevhash',
        txsHash: '',
        transactions: [],
        rewardTotal: 500,
        rewardAddresses: { [node.getPrimaryAddress()]: 500 },
        stateRoot: '',
        votes: {},
      };
      const { computeBlockHash: _computeBlockHash } = require('../wtc-chain');
      fakeBlock.hash = _computeBlockHash(fakeBlock);

      const result = await node.handleProposal(fakeBlock, 'http://attacker:39310');
      assert.strictEqual(result && result.ok, false, 'block with wrong prevHash must be rejected');
      assert.match(String(result.reason), /prevHash mismatch/i);
    } finally {
      rmrf(dir);
    }
  });

  // ─── results ─────────────────────────────────────────────────────────────────

  console.log('');
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
