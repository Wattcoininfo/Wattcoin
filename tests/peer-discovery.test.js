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
  const discoveredPeers = overrides.discoveredPeers || new Map();
  const peerReachabilityCache = overrides.peerReachabilityCache || new Map();

  return {
    dgram: {
      createSocket: () => ({
        on: () => {},
        bind: () => {},
        close: () => {},
        send: () => {},
        setMulticastInterface: () => {},
        setMulticastTTL: () => {},
        setMulticastLoopback: () => {},
        addMembership: () => {},
      }),
    },
    normalizePeerUrl: (url) => (url && url.startsWith('http') ? url : null),
    isSelfPeerUrl: () => false,
    isPeerUrlBanned: () => false,
    getLedgerNetworkSettings: () => ({
      enabled: true,
      mode: 'peer',
      listenPort: 3933,
      peers: [],
      seedPeers: [],
      configuredPeers: [],
    }),
    rememberDiscoveredPeer: () => {},
    requestPeerJson: async () => null,
    getConfiguredAdvertisedPeerUrls: () => [],
    getPrimaryAdvertisedPeerUrl: () => '',
    getLocalPeerHosts: () => new Set(['127.0.0.1', '::1']),
    getLocalPeerIpv4Interfaces: () => ['127.0.0.1'],
    getLocalPeerIpv4InterfaceEntries: () => [],
    getLocalSubnetProbeCandidates: () => [],
    sortPeerUrlsByPreference: (urls) => urls,
    filterExternalPeerUrls: (urls) => urls,
    buildPeerUrlFromSocket: () => null,
    selectDiscoveryPeerUrl: () => null,
    checkHasKnownPrivateLanPeer: () => false,
    pruneDiscoveredPeers: () => {},
    refreshPeerDirectory: async () => {},
    discoveredPeers,
    peerReachabilityCache,
    peerCountCachedResultRef: { current: null },
    ...overrides,
  };
}

async function run() {
  const { createPeerDiscovery } = require('../electron-main/peer-discovery');

  await test('createPeerDiscovery is a function', () => {
    assert.strictEqual(typeof createPeerDiscovery, 'function');
  });

  // -- getActivePeers -----------------------------------------------------------
  await test('getActivePeers returns empty array when no peers configured', () => {
    const pd = createPeerDiscovery(createMockDeps());
    const peers = pd.getActivePeers({ enabled: true, mode: 'peer', peers: [], seedPeers: [] });
    assert.ok(Array.isArray(peers));
    assert.strictEqual(peers.length, 0);
  });

  await test('getActivePeers includes static peers from settings', () => {
    const pd = createPeerDiscovery(createMockDeps());
    const peers = pd.getActivePeers({
      enabled: true,
      mode: 'peer',
      peers: ['http://192.168.1.1:3933'],
      seedPeers: [],
    });
    assert.strictEqual(peers.length, 1);
    assert.strictEqual(peers[0], 'http://192.168.1.1:3933');
  });

  await test('getActivePeers includes seed peers from settings', () => {
    const pd = createPeerDiscovery(createMockDeps());
    const peers = pd.getActivePeers({
      enabled: true,
      mode: 'peer',
      peers: [],
      seedPeers: ['http://seed1.wattcoin.io:3933'],
    });
    assert.strictEqual(peers.length, 1);
    assert.ok(peers.includes('http://seed1.wattcoin.io:3933'));
  });

  await test('getActivePeers includes recently seen discovered peers', () => {
    const discovered = new Map();
    discovered.set('http://10.0.0.5:3933', { lastSeenMs: Date.now(), sources: ['beacon'] });
    discovered.set('http://10.0.0.6:3933', { lastSeenMs: Date.now(), sources: ['gossip'] });
    const pd = createPeerDiscovery(createMockDeps({ discoveredPeers: discovered }));
    const peers = pd.getActivePeers({ enabled: true, mode: 'peer', peers: [], seedPeers: [] });
    assert.strictEqual(peers.length, 2);
    assert.ok(peers.includes('http://10.0.0.5:3933'));
    assert.ok(peers.includes('http://10.0.0.6:3933'));
  });

  await test('getActivePeers excludes stale discovered peers', () => {
    const discovered = new Map();
    const STALE = 20 * 60 * 1000; // 20 min > 15 min threshold
    discovered.set('http://10.0.0.5:3933', { lastSeenMs: Date.now() - STALE, sources: ['beacon'] });
    const pd = createPeerDiscovery(createMockDeps({ discoveredPeers: discovered }));
    const peers = pd.getActivePeers({ enabled: true, mode: 'peer', peers: [], seedPeers: [] });
    assert.strictEqual(peers.length, 0);
  });

  // -- hasOnlinePeers -----------------------------------------------------------
  await test('hasOnlinePeers returns false when no active peers', () => {
    const pd = createPeerDiscovery(createMockDeps());
    const result = pd.hasOnlinePeers({ enabled: true, mode: 'peer', peers: [], seedPeers: [] });
    assert.strictEqual(result, false);
  });

  await test('hasOnlinePeers returns true when active peers exist and cache says online', () => {
    const peerReachabilityCache = new Map();
    peerReachabilityCache.set('http://10.0.0.5:3933', {
      ok: true,
      lastSuccessAtMs: Date.now(),
      lastAttemptAtMs: Date.now(),
    });
    const discovered = new Map();
    discovered.set('http://10.0.0.5:3933', { lastSeenMs: Date.now(), sources: ['beacon'] });
    const ref = { current: null };
    const pd = createPeerDiscovery(
      createMockDeps({
        discoveredPeers: discovered,
        peerReachabilityCache,
        peerCountCachedResultRef: ref,
      }),
    );
    ref.current = {
      expiresAtMs: Date.now() + 60000,
      value: { source: 'peer', onlineCount: 1 },
    };
    const result = pd.hasOnlinePeers({ enabled: true, mode: 'peer', peers: ['http://10.0.0.5:3933'], seedPeers: [] });
    assert.strictEqual(result, true);
  });

  // -- getPeerDirectoryTargets --------------------------------------------------
  await test('getPeerDirectoryTargets returns unique merged set', () => {
    const discovered = new Map();
    discovered.set('http://dynamic:3933', { lastSeenMs: Date.now(), sources: ['beacon'] });
    const pd = createPeerDiscovery(createMockDeps({ discoveredPeers: discovered }));
    const peers = pd.getPeerDirectoryTargets({
      enabled: true,
      mode: 'peer',
      configuredPeers: ['http://configured:3933'],
      seedPeers: ['http://seed:3933'],
      peers: [],
    });
    // configuredPeers + seedPeers + discovered
    assert.strictEqual(peers.length, 3);
    assert.ok(peers.includes('http://configured:3933'));
    assert.ok(peers.includes('http://seed:3933'));
    assert.ok(peers.includes('http://dynamic:3933'));
  });

  // -- getTrustedPeerTargets ----------------------------------------------------
  await test('getTrustedPeerTargets returns seed peers and managed-tunnel peers', () => {
    const discovered = new Map();
    discovered.set('http://tunnel:3933', {
      lastSeenMs: Date.now(),
      sources: ['managed-tunnel'],
    });
    const pd = createPeerDiscovery(createMockDeps({ discoveredPeers: discovered }));
    const peers = pd.getTrustedPeerTargets({
      enabled: true,
      mode: 'peer',
      configuredPeers: [],
      seedPeers: ['http://seed:3933'],
      peers: [],
    });
    assert.strictEqual(peers.length, 2);
    assert.ok(peers.includes('http://seed:3933'));
    assert.ok(peers.includes('http://tunnel:3933'));
  });

  await test('getTrustedPeerTargets excludes non-managed-tunnel discovered peers', () => {
    const discovered = new Map();
    discovered.set('http://beacon:3933', {
      lastSeenMs: Date.now(),
      sources: ['beacon'],
    });
    discovered.set('http://tunnel:3933', {
      lastSeenMs: Date.now(),
      sources: ['managed-tunnel'],
    });
    const pd = createPeerDiscovery(createMockDeps({ discoveredPeers: discovered }));
    const peers = pd.getTrustedPeerTargets({
      enabled: true,
      mode: 'peer',
      configuredPeers: [],
      seedPeers: [],
      peers: [],
    });
    assert.strictEqual(peers.length, 1);
    assert.ok(peers.includes('http://tunnel:3933'));
    assert.ok(!peers.includes('http://beacon:3933'));
  });

  // -- hasKnownPrivateLanPeer ---------------------------------------------------
  await test('hasKnownPrivateLanPeer delegates to checkHasKnownPrivateLanPeer', () => {
    let called = false;
    let passedPeers = null;
    const pd = createPeerDiscovery(
      createMockDeps({
        checkHasKnownPrivateLanPeer: (peers, opts) => {
          called = true;
          passedPeers = peers;
          return true;
        },
      }),
    );
    const result = pd.hasKnownPrivateLanPeer({ enabled: true, mode: 'peer', peers: [], seedPeers: [] });
    assert.strictEqual(result, true);
    assert.strictEqual(called, true);
    assert.ok(Array.isArray(passedPeers));
  });

  // -- stopPeerDiscovery -------------------------------------------------------
  await test('stopPeerDiscovery clears discoveredPeers', () => {
    const discovered = new Map();
    discovered.set('http://peer:3933', { lastSeenMs: Date.now(), sources: ['beacon'] });
    const pd = createPeerDiscovery(createMockDeps({ discoveredPeers: discovered }));
    assert.strictEqual(discovered.size, 1);
    pd.stopPeerDiscovery();
    assert.strictEqual(discovered.size, 0);
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
