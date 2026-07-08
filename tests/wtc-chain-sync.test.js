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
    getWtcNode: () => ({
      syncWithPeers: () => ({
        ok: true,
        synced: true,
        fromHeight: 900,
        toHeight: 1000,
        peer: 'test-peer',
        imported: 100,
      }),
      getHeight: () => 1000,
      handleGetBlocks: (from, _count) => ({ blocks: [{ height: from }] }),
      getPrimaryAddress: () => 'addr',
      getBalance: () => ({ confirmed: 100, unmatured: 0 }),
      getMinedStats: () => ({ totalWTC: 100, totalBlocks: 10, maturedBlocks: 5 }),
    }),
    getLedgerNetworkSettings: () => ({
      enabled: true,
      mode: 'peer',
      listenPort: 3933,
      seedPeers: [],
      configuredPeers: [],
    }),
    getPeerDirectoryTargets: () => [],
    requestPeerJson: () => null,
    normalizePeerUrl: (url) => (url && url.startsWith('http') ? url : null),
    isSelfPeerUrl: () => false,
    isPeerUrlBanned: () => false,
    rememberDiscoveredPeer: () => {},
    peerReachabilityCache: new Map(),
    peerUtils: { pickPeerExchangeTargets: () => [] },
    stunNatInfoRef: { current: null },
    allocatePunchPort: () => 50000,
    requestPunch: () => ({ execute: () => null }),
    filterExternalPeerUrls: (urls) => urls,
    getConfiguredAdvertisedPeerUrls: () => [],
    getLocalPeerHosts: () => new Set(['127.0.0.1', '::1']),
    NAT_TYPE: { PUBLIC: 'public', TIMEOUT: 'timeout', RESTRICTED: 'restricted' },
    crypto: { randomBytes: () => Buffer.from('1234567890123456') },
    refreshWalletSyncState: async () => {},
    recordRollbackDepth: () => {},
    wtcPeerSyncTimerRef: { current: null },
    wtcPeerSyncDebounceTimerRef: { current: null },
    wtcPeerSyncPendingReasonRef: { current: '' },
    peerPunchAttemptTimestamps: new Map(),
    usedPunchPorts: new Set(),
    peerGossipSeen: new Map(),
    opsState: { lastSyncResult: null, lastSyncAttemptAt: 0 },
    PEER_PUNCH_RETRY_INTERVAL_MS: 120000,
    PEER_PUNCH_PER_CYCLE_MAX: 3,
    PEER_GOSSIP_FANOUT: 4,
    PEER_GOSSIP_TTL: 2,
    PEER_GOSSIP_SEEN_TTL_MS: 300000,
    PEER_REACHABILITY_SUCCESS_TTL_MS: 600000,
    WTC_PEER_SYNC_INTERVAL_MS: 60000,
    WTC_PEER_SYNC_DEBOUNCE_MS: 1500,
    ...overrides,
  };
}

async function run() {
  const { createWtcChainSync } = require('../electron-main/wtc-chain-sync');

  await test('createWtcChainSync is a function', () => {
    assert.strictEqual(typeof createWtcChainSync, 'function');
  });

  // -- runWtcPeerSync ----------------------------------------------------------
  await test('runWtcPeerSync returns error when wtcNode is null', async () => {
    const sync = createWtcChainSync(createMockDeps({ getWtcNode: () => null }));
    const result = await sync.runWtcPeerSync('test');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'wtcNode unavailable');
  });

  await test('runWtcPeerSync returns error when syncWithPeers is missing', async () => {
    const sync = createWtcChainSync(createMockDeps({ getWtcNode: () => ({}) }));
    const result = await sync.runWtcPeerSync('test');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'syncWithPeers unavailable');
  });

  await test('runWtcPeerSync returns success when sync completes', async () => {
    const sync = createWtcChainSync(createMockDeps());
    const result = await sync.runWtcPeerSync('test');
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.synced, true);
  });

  await test('runWtcPeerSync returns failed result from syncWithPeers', async () => {
    const sync = createWtcChainSync(
      createMockDeps({
        getWtcNode: () => ({
          syncWithPeers: () => ({ ok: false, reason: 'peer unreachable' }),
        }),
      }),
    );
    const result = await sync.runWtcPeerSync('test');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'peer unreachable');
  });

  await test('runWtcPeerSync handles thrown errors', async () => {
    const sync = createWtcChainSync(
      createMockDeps({
        getWtcNode: () => ({
          syncWithPeers: () => {
            throw new Error('network error');
          },
        }),
      }),
    );
    const result = await sync.runWtcPeerSync('test');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'network error');
  });

  // -- buildPushChainPayload ---------------------------------------------------
  await test('buildPushChainPayload returns null when wtcNode is null', () => {
    const sync = createWtcChainSync(createMockDeps({ getWtcNode: () => null }));
    const result = sync.buildPushChainPayload(200);
    assert.strictEqual(result, null);
  });

  await test('buildPushChainPayload returns payload with blocks', () => {
    const sync = createWtcChainSync(createMockDeps());
    const result = sync.buildPushChainPayload(200);
    assert.ok(result !== null);
    assert.ok(Array.isArray(result.blocks));
    assert.strictEqual(result.blocks.length, 1);
  });

  await test('buildPushChainPayload returns null when no blocks', () => {
    const sync = createWtcChainSync(
      createMockDeps({
        getWtcNode: () => ({
          getHeight: () => 1000,
          handleGetBlocks: () => ({ blocks: [] }),
        }),
      }),
    );
    const result = sync.buildPushChainPayload(200);
    assert.strictEqual(result, null);
  });

  // -- handlePeerTipSignal -----------------------------------------------------
  await test('handlePeerTipSignal triggers schedule when remote height is higher', () => {
    const debounceRef = { current: null };
    const reasonRef = { current: '' };
    const sync = createWtcChainSync(
      createMockDeps({
        wtcPeerSyncDebounceTimerRef: debounceRef,
        wtcPeerSyncPendingReasonRef: reasonRef,
        getLedgerNetworkSettings: () => ({ enabled: true, mode: 'peer' }),
        getWtcNode: () => ({ getHeight: () => 500 }),
        runWtcPeerSync: async () => {},
      }),
    );
    sync.handlePeerTipSignal('http://remote-peer:3933', { height: 1000 }, 'tip-probe');
    // Should have set pending reason
    assert.ok(reasonRef.current.length > 0);
    // Clean up the timer
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
  });

  await test('handlePeerTipSignal does not schedule when local height is higher', () => {
    const debounceRef = { current: null };
    const reasonRef = { current: '' };
    const sync = createWtcChainSync(
      createMockDeps({
        wtcPeerSyncDebounceTimerRef: debounceRef,
        wtcPeerSyncPendingReasonRef: reasonRef,
        getLedgerNetworkSettings: () => ({ enabled: true, mode: 'peer' }),
        getWtcNode: () => ({ getHeight: () => 2000 }),
      }),
    );
    sync.handlePeerTipSignal('http://remote-peer:3933', { height: 1000 }, 'tip-probe');
    // Should NOT schedule because local (2000) > remote (1000)
    assert.strictEqual(reasonRef.current, '');
  });

  // -- _prunePeerGossipSeen ----------------------------------------------------
  await test('_prunePeerGossipSeen removes expired entries', () => {
    const gossipSeen = new Map();
    const now = Date.now();
    // Old entry (expired)
    gossipSeen.set('old-key', now - 400000); // > PEER_GOSSIP_SEEN_TTL_MS (300000)
    // Recent entry (still valid)
    gossipSeen.set('recent-key', now - 100000); // < 300000
    const sync = createWtcChainSync(createMockDeps({ peerGossipSeen: gossipSeen }));
    sync._prunePeerGossipSeen();
    assert.strictEqual(gossipSeen.size, 1);
    assert.ok(gossipSeen.has('recent-key'));
    assert.ok(!gossipSeen.has('old-key'));
  });

  // -- stopWtcPeerSyncLoop -----------------------------------------------------
  await test('stopWtcPeerSyncLoop clears the timer', () => {
    const timerRef = { current: setTimeout(() => {}, 100000) };
    const sync = createWtcChainSync(
      createMockDeps({
        wtcPeerSyncTimerRef: timerRef,
      }),
    );
    assert.notStrictEqual(timerRef.current, null);
    sync.stopWtcPeerSyncLoop();
    assert.strictEqual(timerRef.current, null);
  });

  await test('stopWtcPeerSyncLoop is safe when timer is null', () => {
    const timerRef = { current: null };
    const sync = createWtcChainSync(
      createMockDeps({
        wtcPeerSyncTimerRef: timerRef,
      }),
    );
    sync.stopWtcPeerSyncLoop();
    assert.strictEqual(timerRef.current, null);
  });

  // -- scheduleWtcPeerSync -----------------------------------------------------
  await test('scheduleWtcPeerSync does nothing when mode is not peer', () => {
    const debounceRef = { current: null };
    const reasonRef = { current: '' };
    const sync = createWtcChainSync(
      createMockDeps({
        getLedgerNetworkSettings: () => ({ enabled: true, mode: 'solo' }),
        wtcPeerSyncDebounceTimerRef: debounceRef,
        wtcPeerSyncPendingReasonRef: reasonRef,
      }),
    );
    sync.scheduleWtcPeerSync('test');
    assert.strictEqual(debounceRef.current, null);
    assert.strictEqual(reasonRef.current, '');
  });

  await test('scheduleWtcPeerSync debounces and accumulates reasons', () => {
    const debounceRef = { current: null };
    const reasonRef = { current: '' };
    const sync = createWtcChainSync(
      createMockDeps({
        getLedgerNetworkSettings: () => ({ enabled: true, mode: 'peer' }),
        wtcPeerSyncDebounceTimerRef: debounceRef,
        wtcPeerSyncPendingReasonRef: reasonRef,
        runWtcPeerSync: async () => {},
      }),
    );
    sync.scheduleWtcPeerSync('reason-a');
    assert.strictEqual(reasonRef.current, 'reason-a');
    // Second call while debounce timer is still pending accumulates
    sync.scheduleWtcPeerSync('reason-b');
    assert.strictEqual(reasonRef.current, 'reason-a,reason-b');
    // Clean up the timer
    clearTimeout(debounceRef.current);
    debounceRef.current = null;
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (!process.env.VITEST) process.exit(failed > 0 ? 1 : 0);
}

run();
