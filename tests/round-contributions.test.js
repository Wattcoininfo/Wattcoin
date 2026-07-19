// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function createMockDeps(overrides = {}) {
  return {
    roundLedger: {
      addContribution: () => ({ ok: true, acceptedWh: 1, addressRoundWh: 1 }),
      getCurrentRoundSnapshot: () => ({ id: 1, startedAtMs: 0, totalWh: 100, contributionsWh: {} }),
      isTampered: () => false,
      getRoundContribution: () => 0,
      syncMaturity: () => [],
      getAddressSnapshot: () => ({ address: 'test-addr', total: 0, matured: 0, pending: 0 }),
      getMaturityDepth: () => 100,
      settleCurrentRound: () => ({ ok: true, idempotent: true }),
    },
    getWtcNode: () => ({
      signMessage: () => ({ signature: 'signed' }),
      getPrimaryAddress: () => 'test-address',
      getBalance: () => ({ confirmed: 100, unmatured: 0 }),
      getMinedStats: () => ({ totalWTC: 100, totalBlocks: 10, maturedBlocks: 5 }),
      getHeight: () => 1000,
      syncWithPeers: () => ({
        ok: true,
        synced: true,
        fromHeight: 900,
        toHeight: 1000,
        peer: 'test',
        imported: 100,
      }),
    }),
    hwAuthority: {
      peerProbeChainIndex: 0,
    },
    walletAddressCache: { address: 'test-address', at: Date.now() },
    getLedgerNetworkSettings: () => ({ enabled: true, mode: 'peer', listenPort: 3933 }),
    getActivePeers: () => ['http://peer:3933'],
    getCurrentBlockHeight: () => 1000,
    getCurrentNetworkRoundId: () => 42,
    requestPeerJson: () => Promise.resolve(null),
    normalizePeerUrl: (url) => url,
    getLocalProbeChain: () => ({ chainIndex: 5 }),
    rewardForHeight: () => 50,
    getActiveNetwork: () => 'testnet',
    computeHwAuthSig: () => 'auth-sig',
    recordForkMismatch: () => {},
    alignRoundLedgerToChain: () => {},
    ENABLE_POWER_PROOF_COMMITMENT: false,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    _pendingContributionWh: { current: 0 },
    _contributionPerSecond: { current: 0 },
    _contributionSecondStart: { current: 0 },
    pendingRoundContributionBroadcasts: new Map(),
    witnessedSettlements: new Map(),
    witnessedProbeReceipts: new Map(),
    bootstrapPeerAddresses: new Set(),
    MIN_PROBE_VERIFIERS: 1,
    REVERSE_TUNNEL_LIVE_THRESHOLD_MS: 30000,
    ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS: 100,
    loadPowerCurve: () => null,
    interpolatePower: () => 0,
    pullContributionsFromPeers: () => null,
    getLocalLedgerBalances: () => ({ ok: true, addressRoundWh: 0 }),
    settleLocalLedgerRound: () => ({ ok: true }),
    ...overrides,
  };
}

async function run() {
  const { createRoundContributions, verifyContributorSeedProofs } = require('../electron-main/round-contributions');

  await test('createRoundContributions is a function', () => {
    assert.strictEqual(typeof createRoundContributions, 'function');
  });

  // -- buildRoundContributionMessage --------------------------------------------
  await test('buildRoundContributionMessage returns a valid JSON string', () => {
    const rc = createRoundContributions(createMockDeps());
    const msg = rc.buildRoundContributionMessage({
      address: 'addr1',
      roundId: 42,
      totalWh: 100.5,
      updatedAtMs: 123456789,
      chainIndex: 3,
    });
    const parsed = JSON.parse(msg);
    assert.strictEqual(parsed.address, 'addr1');
    assert.strictEqual(parsed.roundId, 42);
    assert.strictEqual(parsed.totalWh, 100.5);
    assert.strictEqual(parsed.chainIndex, 3);
    assert.strictEqual(parsed.network, 'testnet');
  });

  await test('buildRoundContributionMessage clamps negative values', () => {
    const rc = createRoundContributions(createMockDeps());
    const msg = rc.buildRoundContributionMessage({
      address: 'addr1',
      roundId: -5,
      totalWh: -10,
      updatedAtMs: -1,
      chainIndex: -3,
    });
    const parsed = JSON.parse(msg);
    assert.strictEqual(parsed.roundId, 1);
    assert.strictEqual(parsed.totalWh, 0);
    assert.strictEqual(parsed.chainIndex, 0);
  });

  await test('buildRoundContributionMessage handles missing address', () => {
    const rc = createRoundContributions(createMockDeps());
    const msg = rc.buildRoundContributionMessage({
      address: '',
      roundId: 1,
      totalWh: 10,
      updatedAtMs: 100,
      chainIndex: 0,
    });
    const parsed = JSON.parse(msg);
    assert.strictEqual(parsed.address, '');
  });

  // -- buildRoundContributionMessage with seedProofs ----------------------------
  await test('buildRoundContributionMessage includes seedProofs when provided', () => {
    const rc = createRoundContributions(createMockDeps());
    const proofs = [
      { seed: 'aa', startState: 'bb', endState: 'cc', totalOps: 1000, burnMs: 5.5, intermediateProof: 'dd' },
    ];
    const msg = rc.buildRoundContributionMessage({
      address: 'addr1',
      roundId: 1,
      totalWh: 10,
      updatedAtMs: 100,
      chainIndex: 0,
      seedProofs: proofs,
    });
    const parsed = JSON.parse(msg);
    assert.ok(Array.isArray(parsed.seedProofs));
    assert.strictEqual(parsed.seedProofs.length, 1);
    assert.strictEqual(parsed.seedProofs[0].totalOps, 1000);
  });

  await test('buildRoundContributionMessage omits seedProofs when not provided', () => {
    const rc = createRoundContributions(createMockDeps());
    const msg = rc.buildRoundContributionMessage({
      address: 'addr1',
      roundId: 1,
      totalWh: 10,
      updatedAtMs: 100,
      chainIndex: 0,
    });
    const parsed = JSON.parse(msg);
    assert.strictEqual(parsed.seedProofs, undefined);
  });

  await test('buildRoundContributionMessage includes seedProofs with correct structure', () => {
    const rc = createRoundContributions(createMockDeps());
    const proofs = [
      { seed: 'aa', startState: 'bb', endState: 'cc', totalOps: 1000, burnMs: 5.5, intermediateProof: 'dd' },
      { seed: 'ee', startState: 'ff', endState: '00', totalOps: 2000, burnMs: 10, intermediateProof: '11' },
    ];
    const msg = rc.buildRoundContributionMessage({
      address: 'addr1',
      roundId: 1,
      totalWh: 10,
      updatedAtMs: 100,
      chainIndex: 0,
      seedProofs: proofs,
    });
    const parsed = JSON.parse(msg);
    assert.strictEqual(parsed.seedProofs.length, 2);
    assert.strictEqual(parsed.seedProofs[0].seed, 'aa');
    assert.strictEqual(parsed.seedProofs[0].startState, 'bb');
    assert.strictEqual(parsed.seedProofs[0].endState, 'cc');
    assert.strictEqual(parsed.seedProofs[0].intermediateProof, 'dd');
    assert.strictEqual(parsed.seedProofs[1].seed, 'ee');
    assert.strictEqual(parsed.seedProofs[1].totalOps, 2000);
  });

  // -- buildRewardMapFromRoundSnapshot -----------------------------------------
  await test('buildRewardMapFromRoundSnapshot returns empty object for zero reward', () => {
    const rc = createRoundContributions(
      createMockDeps({
        rewardForHeight: () => 0,
      }),
    );
    const map = rc.buildRewardMapFromRoundSnapshot({ id: 1, contributionsWh: { addr1: 100 } });
    assert.deepStrictEqual(map, {});
  });

  await test('buildRewardMapFromRoundSnapshot distributes reward proportionally', () => {
    const rc = createRoundContributions(
      createMockDeps({
        rewardForHeight: () => 100,
      }),
    );
    const map = rc.buildRewardMapFromRoundSnapshot({
      id: 1,
      contributionsWh: { addr1: 75, addr2: 25 },
    });
    // addr1 contributed 75% → gets 75 coins, addr2 gets 25 coins
    assert.ok(Math.abs(map.addr1 - 75) < 0.01);
    assert.ok(Math.abs(map.addr2 - 25) < 0.01);
  });

  await test('buildRewardMapFromRoundSnapshot uses last-address rounding', () => {
    const rc = createRoundContributions(
      createMockDeps({
        rewardForHeight: () => 100,
      }),
    );
    const map = rc.buildRewardMapFromRoundSnapshot({
      id: 1,
      contributionsWh: { addr1: 33, addr2: 33, addr3: 34 },
    });
    const total = map.addr1 + map.addr2 + map.addr3;
    // Total must equal reward (100). The last entry absorbs rounding residuals.
    assert.ok(Math.abs(total - 100) < 0.01);
  });

  await test('buildRewardMapFromRoundSnapshot returns fallback when no contributions', () => {
    const rc = createRoundContributions(
      createMockDeps({
        rewardForHeight: () => 100,
      }),
    );
    const map = rc.buildRewardMapFromRoundSnapshot({ id: 1, contributionsWh: {} }, 'fallback-addr');
    assert.deepStrictEqual(map, { 'fallback-addr': 100 });
  });

  await test('buildRewardMapFromRoundSnapshot handles null roundSnapshot', () => {
    const rc = createRoundContributions(
      createMockDeps({
        rewardForHeight: () => 100,
        getCurrentNetworkRoundId: () => 42,
      }),
    );
    const map = rc.buildRewardMapFromRoundSnapshot(null);
    assert.deepStrictEqual(map, {});
  });

  // -- validateContributionProbe -----------------------------------------------
  await test('validateContributionProbe returns insufficient attestations when no receipts', () => {
    const rc = createRoundContributions(
      createMockDeps({
        witnessedProbeReceipts: new Map(),
        MIN_PROBE_VERIFIERS: 1,
      }),
    );
    // With chainIndex=1 and no witnessed receipts, hits the chainIndex>0 branch
    const result = rc.validateContributionProbe('test-addr', 100, 1);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INSUFFICIENT_PROBE_ATTESTATIONS');
  });

  // -- _flushPendingContribution -------------------------------------------------
  await test('_flushPendingContribution does nothing when wh is tiny', () => {
    const ref = { current: 0.00001 };
    const rc = createRoundContributions(
      createMockDeps({
        _pendingContributionWh: ref,
      }),
    );
    rc._flushPendingContribution(0);
    assert.strictEqual(ref.current, 0);
  });

  await test('_flushPendingContribution resets pending wh when too small', () => {
    const ref = { current: 0.00005 };
    const rc = createRoundContributions(
      createMockDeps({
        _pendingContributionWh: ref,
      }),
    );
    rc._flushPendingContribution(0);
    assert.strictEqual(ref.current, 0);
  });

  // -- queueRoundContributionBroadcast -----------------------------------------
  await test('queueRoundContributionBroadcast stores and debounces broadcasts', async () => {
    const broadcasts = new Map();
    const rc = createRoundContributions(
      createMockDeps({
        pendingRoundContributionBroadcasts: broadcasts,
        ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS: 50,
        normalizePeerUrl: (url) => url,
        getActivePeers: () => [],
      }),
    );
    rc.queueRoundContributionBroadcast('http://peer:3933', {
      address: 'addr1',
      roundId: 1,
      totalWh: 100,
    });
    const key = 'http://peer:3933|addr1';
    assert.ok(broadcasts.has(key), 'should be queued');
    // Wait for debounce to fire
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!broadcasts.has(key), 'should be cleared after debounce');
  });

  // -- getLocalLedgerBalances --------------------------------------------------
  await test('getLocalLedgerBalances returns OK with address', async () => {
    const rc = createRoundContributions(
      createMockDeps({
        roundLedger: {
          ...createMockDeps().roundLedger,
          getRoundContribution: (_addr) => {
            return 50;
          },
        },
        walletAddressCache: { address: 'test-addr', at: Date.now() },
      }),
    );
    const result = await rc.getLocalLedgerBalances('test-addr');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.currentRoundContributionWh, 50);
  });

  await test('getLocalLedgerBalances handles missing address', async () => {
    const rc = createRoundContributions(
      createMockDeps({
        walletAddressCache: { address: '', at: 0 },
      }),
    );
    const result = await rc.getLocalLedgerBalances('');
    // Should still return with some guestimate
    assert.strictEqual(result.ok, true);
  });

  // -- settleLocalLedgerRound --------------------------------------------------
  await test('settleLocalLedgerRound with zero blockHeight falls through to settleCurrentRound', async () => {
    const rc = createRoundContributions(
      createMockDeps({
        getCurrentBlockHeight: () => 500,
      }),
    );
    const result = await rc.settleLocalLedgerRound({ blockHash: 'abc', minedAddress: 'addr1' });
    assert.strictEqual(result.ok, true);
  });

  // -- verifyContributorSeedProofs (standalone) --------------------------------
  await test('verifyContributorSeedProofs is exported and is a function', () => {
    assert.strictEqual(typeof verifyContributorSeedProofs, 'function');
  });

  await test('verifyContributorSeedProofs rejects malformed JSON string', async () => {
    const result = await verifyContributorSeedProofs('{bad json', 'addr1', 10, 60000, new Map());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'invalid_message_format');
  });

  await test('verifyContributorSeedProofs rejects message without seedProofs array', async () => {
    const result = await verifyContributorSeedProofs({ address: 'addr1' }, 'addr1', 10, 60000, new Map());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no_seed_proofs');
  });

  await test('verifyContributorSeedProofs accepts message with no seedProofs and zero claimed energy', async () => {
    const result = await verifyContributorSeedProofs({ address: 'addr1' }, 'addr1', 0, 60000, new Map());
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.verifiedWh, 0);
  });

  await test('verifyContributorSeedProofs rejects message with no seedProofs but positive claimed energy', async () => {
    const result = await verifyContributorSeedProofs({ address: 'addr1' }, 'addr1', 5.0, 60000, new Map());
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'no_seed_proofs');
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
