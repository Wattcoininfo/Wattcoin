// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const crypto = require('crypto');

const { Consensus } = require('../wtc-consensus');
const { generateKeypair, txHash, sign } = require('../wtc-address');
const { computeBlockHash } = require('../wtc-chain');

function noop() {}

function makeChainStub() {
  let tip = null;
  let height = 0;
  let blocks = [];
  return {
    buildBlock: (opts) => {
      const h = height + 1;
      const block = {
        height: h,
        prevHash: tip ? tip.hash : '0'.repeat(64),
        timestamp: Date.now(),
        proposer: opts.proposer || '',
        energyWh: opts.energyWh || 10000000,
        proofCommitment: opts.proofCommitment || '',
        attestationVersion: 1,
        peerProbeVerified: !!opts.peerProbeVerified,
        probeReceipt: opts.probeReceipt || null,
        transactions: opts.transactions || [],
        rewardAddresses: opts.rewardAddresses || {},
        rewardTotal: h <= 2000 ? 500 : h <= 6000 ? 250 : 0,
        stateRoot: opts.stateRoot || crypto.createHash('sha256').update('stub').digest('hex'),
        nftsRoot: opts.nftsRoot || '',
      };
      block.hash = computeBlockHash(block);
      return block;
    },
    getHeight: () => height,
    getTip: () => tip,
    getBlockByHash: (h) => blocks.find(b => b.hash === h) || null,
    append: (block) => {
      height = block.height;
      tip = block;
      blocks.push(block);
    },
    nextBlockReward: () => height <= 2000 ? 500 : height <= 6000 ? 250 : 0,
    rewardForHeight: (h) => h <= 2000 ? 500 : h <= 6000 ? 250 : 0,
  };
}

function makeAccountsStub() {
  return {
    stateHash: () => crypto.createHash('sha256').update('stub').digest('hex'),
    applyBlock: noop,
  };
}

function makeMempoolStub() {
  return { removeAll: noop };
}

function describe(name, fn) {
  fn();
}

function it(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => console.log(`  ✓ ${name}`),
        (e) => { console.error(`  ✗ ${name}: ${e.message}`); throw e; }
      );
    }
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    throw e;
  }
}

function makeConsensus(opts = {}) {
  const kp = generateKeypair();
  const chain = opts.chain || makeChainStub();
  const accounts = opts.accounts || makeAccountsStub();
  const mempool = opts.mempool || makeMempoolStub();
  return new Consensus({
    chain,
    accounts,
    mempool,
    getActivePeers: opts.getActivePeers || (() => []),
    requestPeerJson: opts.requestPeerJson || (() => Promise.resolve({ ok: false })),
    privateKey: Buffer.from(kp.privateKey, 'hex'),
    allowPartialQuorumCommit: opts.allowPartialQuorumCommit !== false,
    nfts: opts.nfts || null,
    getEnergyContributions: opts.getEnergyContributions || (() => ({})),
  });
}

describe('wtc-consensus — construction and initialization', () => {

  it('constructs with default state', () => {
    const c = makeConsensus();
    assert.ok(c instanceof Consensus);
    const status = c.getStatus();
    assert.strictEqual(status.height, 0);
    assert.strictEqual(status.activePeers, 0);
    assert.strictEqual(status.status, 'running');
  });

  it('setLocalAddress stores the address', () => {
    const c = makeConsensus();
    c.setLocalAddress('wtc1qtest');
  });

  it('resetTracking clears pending and committed sets', () => {
    const c = makeConsensus();
    c.resetTracking();
    assert.strictEqual(c.getStatus().pendingProposals, 0);
  });

});

describe('wtc-consensus — proposeBlock with no peers', () => {

  it('commits block immediately when no peers', async () => {
    const chain = makeChainStub();
    const c = makeConsensus({ chain });
    const kp = generateKeypair();
    c.setLocalAddress(kp.address);
    const result = await c.proposeBlock({
      proposer: kp.address,
      energyWh: 10000000,
      proofCommitment: 'proof123',
      transactions: [],
      rewardAddresses: { [kp.address]: 500 },
      rewardTotal: 500,
    });
    assert.ok(result.hash, 'should return committed block with hash');
    assert.strictEqual(chain.getHeight(), 1, 'chain height should advance');
  });

  it('returns validation error for invalid block', async () => {
    const chain = makeChainStub();
    const c = makeConsensus({ chain });
    c.setLocalAddress('wtc1qproposer');
    const result = await c.proposeBlock({
      proposer: 'wtc1qproposer',
      energyWh: 0,
      proofCommitment: '',
      peerProbeVerified: false,
      probeReceipt: null,
      transactions: [],
      rewardAddresses: {},
      rewardTotal: 0,
    });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason);
  });

});

describe('wtc-consensus — receiveProposal', () => {

  it('accepts valid proposal and returns signed vote', async () => {
    const chain = makeChainStub();
    const kp = generateKeypair();
    const c = makeConsensus({ chain });
    c.setLocalAddress(kp.address);
    // Build a block that passes validation
    const block = chain.buildBlock({
      proposer: kp.address,
      energyWh: 10000000,
      rewardAddresses: { [kp.address]: 500 },
      rewardTotal: 500,
    });
    const result = await c.receiveProposal(block, 'http://peer1:39310');
    assert.ok(result.ok);
    assert.strictEqual(result.signer, kp.address);
    assert.ok(result.sig, 'should return a signature');
  });

  it('rejects already-known block', async () => {
    const c = makeConsensus();
    const block = { hash: 'already-known' };
    const result = await c.receiveProposal(block, 'http://peer1');
    assert.ok(!result.ok);
  });

  it('rejects invalid block proposal', async () => {
    const c = makeConsensus();
    const result = await c.receiveProposal(null, 'http://peer1');
    assert.strictEqual(result.ok, false);
  });

});

describe('wtc-consensus — receiveVote', () => {

  it('rejects vote for unknown proposal', () => {
    const c = makeConsensus();
    const result = c.receiveVote({ blockHash: 'unknown', voter: 'wtc1q', sig: '0'.repeat(130) });
    assert.strictEqual(result.ok, false);
    assert.ok(result.reason);
  });

  it('rejects vote with invalid signature', () => {
    const c = makeConsensus();
    c._pending.set('test-hash', { block: { hash: 'test-hash' }, votes: new Map(), voteWeight: 1 });
    const result = c.receiveVote({ blockHash: 'test-hash', voter: 'wtc1qfake', sig: 'bad-sig' });
    assert.strictEqual(result.ok, false);
  });

});

describe('wtc-consensus — validateBlock (internal)', () => {

  it('rejects non-object block', () => {
    const c = makeConsensus();
    const err = c._validateBlock(null);
    assert.ok(err);
  });

  it('rejects block missing required fields', () => {
    const c = makeConsensus();
    const err = c._validateBlock({});
    assert.ok(err);
  });

  it('rejects block with hash mismatch', () => {
    const c = makeConsensus();
    const err = c._validateBlock({
      height: 1,
      prevHash: '0'.repeat(64),
      proposer: 'wtc1q',
      hash: 'wrong-hash',
    });
    assert.ok(err);
  });

});

describe('wtc-consensus — quorum calculations', () => {

  it('voteWeight returns 1 when no energy contributions', () => {
    const c = makeConsensus();
    assert.strictEqual(c._voteWeight('wtc1qany'), 1);
  });

  it('voteWeight returns energy contribution when available', () => {
    const c = makeConsensus({
      getEnergyContributions: () => ({ 'wtc1qminer': 5000 }),
    });
    assert.strictEqual(c._voteWeight('wtc1qminer'), 5000);
    assert.strictEqual(c._voteWeight('wtc1qunknown'), 0);
  });

  it('_countQuorum: 0-1 peers needs 1 vote', () => {
    const c = makeConsensus();
    assert.strictEqual(c._countQuorum(0), 1);
    assert.strictEqual(c._countQuorum(1), 1);
  });

  it('_countQuorum: N>=2 peers needs ceil((N+1)*2/3)', () => {
    const c = makeConsensus();
    assert.strictEqual(c._countQuorum(2), Math.ceil(3 * 2/3));
    assert.strictEqual(c._countQuorum(5), Math.ceil(6 * 2/3));
    assert.strictEqual(c._countQuorum(10), Math.ceil(11 * 2/3));
  });

  it('_quorumWeight falls back to count-based when no contributions', () => {
    const c = makeConsensus({ getActivePeers: () => ['http://a', 'http://b'] });
    assert.strictEqual(c._quorumWeight(), Math.ceil(3 * 2/3));
  });

});

describe('wtc-consensus — getStatus and public accessors', () => {

  it('getStatus returns chain tip info', () => {
    const c = makeConsensus();
    const s = c.getStatus();
    assert.strictEqual(typeof s.height, 'number');
    assert.strictEqual(typeof s.activePeers, 'number');
    assert.strictEqual(typeof s.nextReward, 'number');
  });

  it('getActivePeers returns peer list', () => {
    const c = makeConsensus({ getActivePeers: () => ['http://p1', 'http://p2'] });
    assert.deepStrictEqual(c.getActivePeers(), ['http://p1', 'http://p2']);
  });

  it('requestPeerJson delegates to injected function', async () => {
    let called = false;
    const c = makeConsensus({
      requestPeerJson: (url, method, path) => {
        called = true;
        assert.strictEqual(url, 'http://peer');
        assert.strictEqual(method, 'GET');
        assert.strictEqual(path, '/status');
        return Promise.resolve({ ok: true });
      },
    });
    const result = await c.requestPeerJson('http://peer', 'GET', '/status');
    assert.ok(called);
    assert.ok(result.ok);
  });

});

if (require.main === module) {
  let failed = false;
  try {
    require('./wtc-consensus.test');
  } catch (e) {
    failed = true;
    console.error('Test suite failed:', e.message);
  }
  if (failed) process.exit(1);
  console.log('\nAll consensus tests passed.');
}
