'use strict';

const assert = require('assert');

const { checkHasKnownPrivateLanPeer } = require('../local-subnet-discovery');

const STALE_MS = 5 * 60_000; // 5 min  — mirrors PEER_STALE_THRESHOLD_MS
const REACHABILITY_TTL = 10 * 60_000; // 10 min — mirrors PEER_REACHABILITY_SUCCESS_TTL_MS

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns a fresh options object with empty maps and a fixed clock. */
function makeOpts(now) {
  return {
    discoveredPeers: new Map(),
    peerReachabilityCache: new Map(),
    normalizePeerUrl: (url) => url, // identity — keys match URLs exactly
    isSelfPeerUrl: () => false,
    staleThresholdMs: STALE_MS,
    reachabilitySuccessTtlMs: REACHABILITY_TTL,
    now,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

function testFreshDiscoveredPrivatePeerSuppressesProbe() {
  const now = Date.now();
  const peerUrl = 'http://192.168.1.50:39310';
  const opts = makeOpts(now);
  opts.discoveredPeers.set(peerUrl, { lastSeenMs: now - 60_000 }); // 1 min ago — fresh

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([peerUrl], opts),
    true,
    'recently-discovered private LAN peer should suppress subnet probe',
  );
}

function testStaleDiscoveredPrivatePeerDoesNotSuppressProbe() {
  const now = Date.now();
  const peerUrl = 'http://192.168.1.50:39310';
  const opts = makeOpts(now);
  opts.discoveredPeers.set(peerUrl, { lastSeenMs: now - (STALE_MS + 1) }); // just expired

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([peerUrl], opts),
    false,
    'stale discovered peer should NOT suppress subnet probe',
  );
}

function testAtExactStaleBoundaryPeerIsStillFresh() {
  const now = Date.now();
  const peerUrl = 'http://192.168.1.50:39310';
  const opts = makeOpts(now);
  opts.discoveredPeers.set(peerUrl, { lastSeenMs: now - STALE_MS }); // exactly at threshold

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([peerUrl], opts),
    true,
    'peer seen exactly at stale threshold should still be considered fresh',
  );
}

function testRecentlyReachablePrivatePeerSuppressesProbe() {
  const now = Date.now();
  const peerUrl = 'http://192.168.1.51:39310';
  const opts = makeOpts(now);
  opts.peerReachabilityCache.set(peerUrl, { ok: true, lastSuccessAtMs: now - 60_000 });

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([peerUrl], opts),
    true,
    'recently-reachable private LAN peer should suppress subnet probe',
  );
}

function testExpiredReachabilityDoesNotSuppressProbe() {
  const now = Date.now();
  const peerUrl = 'http://192.168.1.51:39310';
  const opts = makeOpts(now);
  opts.peerReachabilityCache.set(peerUrl, { ok: true, lastSuccessAtMs: now - (REACHABILITY_TTL + 1) });

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([peerUrl], opts),
    false,
    'expired reachability entry should NOT suppress subnet probe',
  );
}

function testFailedReachabilityEntryDoesNotSuppressProbe() {
  const now = Date.now();
  const peerUrl = 'http://192.168.1.52:39310';
  const opts = makeOpts(now);
  // ok:false — previous probe failed
  opts.peerReachabilityCache.set(peerUrl, { ok: false, lastSuccessAtMs: now });

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([peerUrl], opts),
    false,
    'failed reachability (ok:false) should NOT suppress subnet probe',
  );
}

function testPublicIpPeerNeverSuppressesProbe() {
  const now = Date.now();
  const peerUrl = 'http://91.95.4.111:39310';
  const opts = makeOpts(now);
  opts.discoveredPeers.set(peerUrl, { lastSeenMs: now }); // fresh but public IP

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([peerUrl], opts),
    false,
    'public-IP peer should never suppress subnet probe regardless of freshness',
  );
}

function testSelfPeerIsFilteredOut() {
  const now = Date.now();
  const peerUrl = 'http://192.168.1.53:39310';
  const opts = makeOpts(now);
  opts.discoveredPeers.set(peerUrl, { lastSeenMs: now });
  opts.isSelfPeerUrl = (url) => url === peerUrl; // this node IS that peer

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([peerUrl], opts),
    false,
    'self peer URL should be filtered out and must not suppress probe',
  );
}

function testEmptyPeerListReturnsFalse() {
  const now = Date.now();
  assert.strictEqual(checkHasKnownPrivateLanPeer([], makeOpts(now)), false, 'empty peer list should return false');
}

function testNullOrNonArrayPeerListReturnsFalse() {
  const now = Date.now();
  assert.strictEqual(checkHasKnownPrivateLanPeer(null, makeOpts(now)), false, 'null peers → false');
  assert.strictEqual(checkHasKnownPrivateLanPeer(undefined, makeOpts(now)), false, 'undefined peers → false');
}

function testMixedPeersOnlyPrivateFreshOnesSuppress() {
  const now = Date.now();
  const publicPeer = 'http://91.95.4.111:39310';
  const staleLan = 'http://192.168.1.60:39310';
  const freshLan = 'http://192.168.1.61:39310';
  const opts = makeOpts(now);
  opts.discoveredPeers.set(publicPeer, { lastSeenMs: now });
  opts.discoveredPeers.set(staleLan, { lastSeenMs: now - (STALE_MS + 1) }); // stale
  opts.discoveredPeers.set(freshLan, { lastSeenMs: now - 30_000 }); // fresh

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([publicPeer, staleLan, freshLan], opts),
    true,
    'should return true when at least one non-stale private LAN peer exists',
  );
}

function testOnlyPublicAndStalePrivatePeersDoNotSuppress() {
  const now = Date.now();
  const publicPeer = 'http://91.95.4.111:39310';
  const staleLan = 'http://192.168.1.70:39310';
  const opts = makeOpts(now);
  opts.discoveredPeers.set(publicPeer, { lastSeenMs: now });
  opts.discoveredPeers.set(staleLan, { lastSeenMs: now - (STALE_MS + 1) });

  assert.strictEqual(
    checkHasKnownPrivateLanPeer([publicPeer, staleLan], opts),
    false,
    'public + stale private should NOT suppress probe — no known live LAN peer',
  );
}

// ─── Runner ──────────────────────────────────────────────────────────────────

function run() {
  testFreshDiscoveredPrivatePeerSuppressesProbe();
  testStaleDiscoveredPrivatePeerDoesNotSuppressProbe();
  testAtExactStaleBoundaryPeerIsStillFresh();
  testRecentlyReachablePrivatePeerSuppressesProbe();
  testExpiredReachabilityDoesNotSuppressProbe();
  testFailedReachabilityEntryDoesNotSuppressProbe();
  testPublicIpPeerNeverSuppressesProbe();
  testSelfPeerIsFilteredOut();
  testEmptyPeerListReturnsFalse();
  testNullOrNonArrayPeerListReturnsFalse();
  testMixedPeersOnlyPrivateFreshOnesSuppress();
  testOnlyPublicAndStalePrivatePeersDoNotSuppress();
  console.log('LAN gate tests passed');
}

run();
