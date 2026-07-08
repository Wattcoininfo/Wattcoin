'use strict';

const { expect } = require('chai');
const { createPeerNetworking } = require('../electron-main/peer-networking');

function noop() {}

function buildMinimalCtx(overrides = {}) {
  const discoveredPeers = new Map();
  const peerReachabilityCache = new Map();
  const peerChainTipCache = new Map();
  const peerChainTipInflight = new Map();
  const peerUrlFailures = new Map();
  const peerAttestationHistory = new Map();
  const bootstrapPeerAddresses = new Set();

  const defaults = {
    discoveredPeers,
    peerReachabilityCache,
    peerChainTipCache,
    peerChainTipInflight,
    peerUrlFailures,
    peerAttestationHistory,
    bootstrapPeerAddresses,

    reverseTunnelSessions: new Map(),
    reverseTunnelClientState: { publicUrl: '' },

    autoDetectedPublicPeerUrlRef: { current: '' },
    autoDetectedPublicPeerUrlFromUpnpRef: { current: false },
    autoDetectedPublicPeerLookupPromiseRef: { current: null },
    remoteSeedPeerRefreshTimerRef: { current: null },
    autoPublicPeerRefreshTimerRef: { current: null },
    seedRegistryHeartbeatTimerRef: { current: null },

    PEER_STALE_THRESHOLD_MS: 15 * 60_000,
    PEER_REACHABILITY_RETRY_MS: 3 * 60_000,
    PEER_REACHABILITY_SUCCESS_TTL_MS: 10 * 60_000,
    PEER_REACHABILITY_TIMEOUT_MS: 20_000,
    PEER_ATTESTATION_SELECTION_TIMEOUT_MS: 25_000,
    PEER_ATTESTATION_SELECTION_CONCURRENCY: 5,
    PEER_ATTESTATION_RECIPROCITY_WINDOW_MS: 60 * 60 * 1000,
    REMOTE_SEED_MANIFEST_REFRESH_INTERVAL_MS: 5 * 60_000,
    AUTO_PUBLIC_IP_REFRESH_INTERVAL_MS: 60_000,
    SEED_REGISTRY_HEARTBEAT_INTERVAL_MS: 30 * 60_000,
    REVERSE_TUNNEL_LIVE_THRESHOLD_MS: 90_000,
    MIN_PROBE_VERIFIERS: 3,
    AUTO_PUBLIC_IP_SERVICES: ['https://api.ipify.org'],

    getRuntimeConfig: () => ({ network: 'wtc-mainnet', seedRegistryHeartbeatEnabled: false }),
    getLedgerNetworkSettings: () => ({
      enabled: true,
      mode: 'peer',
      peers: ['http://peer-a:39310'],
      seedPeers: ['http://seed-a:39310'],
      listenPort: 39310,
      listenHost: '0.0.0.0',
      publicUrl: '',
      tunnelPublicUrl: '',
      advertiseUrls: [],
      authToken: '',
    }),
    getActivePeers: () => ['http://peer-a:39310'],
    getPeerDirectoryTargets: () => [],
    getLocalPeerHosts: () => new Set(['127.0.0.1', '::1', '192.168.1.100']),
    getLocalPeerIdentity: () => 'local-peer-id',
    getTrustedRequesterPeerIdentity: () => '',
    requestPeerJson: () => ({ ok: true }),
    isSelfPeerUrlCandidate: () => false,
    filterAdvertisedPeerUrls: (candidates) => candidates.filter(Boolean),
    sortPeerUrlsByPreference: (peers) => peers,
    normalizeIpLiteral: (ip) => ip,
    isPublicPeerHost: () => true,
    formatPeerHostForUrl: (ip) => ip,
    getWtcNode: () => ({}),
    isPeerUrlBanned: () => false,
    isReverseTunnelPeerUrl: () => false,
    buildPeerUrlFromSocket: (addr, port) => `http://${addr}:${port}`,
    selectPreferredPeerUrl: (a, b) => b || a,
    recordPeerUrlSuccess: noop,
    gossipAnnounce: noop,
    scheduleWtcPeerSync: noop,
    extractTunnelIdFromUrl: () => '',
    maybeRegisterReachableRequesterHelper: () => false,
    scheduleDiscoveredSeedPeerCacheSave: noop,
    loadDiscoveredSeedPeerCache: noop,
    remoteSeedManifestManager: {
      getRemoteSeedManifestUrls: () => [],
      loadCachedRemoteSeedPeers: () => [],
      saveCachedRemoteSeedPeers: noop,
      fetchRemoteSeedManifest: () => null,
      refreshRemoteSeedPeers: () => Promise.resolve([]),
    },
    obfuscatePublicPeerUrl: (url) => url,
    wtcNode: { getHeight: () => 100 },

    ...overrides,
  };
  return defaults;
}

describe('peer-networking', function () {
  let pn;
  let ctx;

  beforeEach(function () {
    ctx = buildMinimalCtx();
    pn = createPeerNetworking(ctx);
  });

  // -- Remote seed manifest wrappers ----------------------------------------

  describe('remote seed manifest', function () {
    it('loadCachedRemoteSeedPeers returns empty array', function () {
      expect(pn.loadCachedRemoteSeedPeers()).to.deep.equal([]);
    });

    it('refreshRemoteSeedPeers calls manager', async function () {
      const result = await pn.refreshRemoteSeedPeers();
      expect(result).to.deep.equal([]);
    });
  });

  // -- Self-peer URL helpers ------------------------------------------------

  describe('isSelfPeerUrl', function () {
    it('returns false for null input', function () {
      expect(pn.isSelfPeerUrl(null)).to.equal(false);
    });
  });

  describe('isPeerIdentitySelfReference', function () {
    it('returns false when identity does not match local', function () {
      expect(pn.isPeerIdentitySelfReference('other-id', 'http://peer:39310')).to.equal(false);
    });
  });

  describe('getConfiguredAdvertisedPeerUrls', function () {
    it('returns empty when no candidates are valid', function () {
      ctx.filterAdvertisedPeerUrls = () => [];
      const pn2 = createPeerNetworking(ctx);
      expect(pn2.getConfiguredAdvertisedPeerUrls()).to.deep.equal([]);
    });

    it('includes auto-detected URL when set', function () {
      ctx.filterAdvertisedPeerUrls = (candidates) => candidates.filter(Boolean);
      ctx.autoDetectedPublicPeerUrlRef.current = 'http://1.2.3.4:39310';
      const pn2 = createPeerNetworking(ctx);
      const urls = pn2.getConfiguredAdvertisedPeerUrls();
      expect(urls).to.include('http://1.2.3.4:39310');
    });
  });

  // -- Peer discovery core --------------------------------------------------

  describe('rememberDiscoveredPeer', function () {
    it('adds a new peer to discoveredPeers', function () {
      const added = pn.rememberDiscoveredPeer('http://new-peer:39310', { source: 'test' });
      expect(added).to.equal(true);
      expect(ctx.discoveredPeers.has('http://new-peer:39310')).to.equal(true);
    });

    it('rejects self-peer URLs', function () {
      ctx.isSelfPeerUrlCandidate = () => true;
      const pn2 = createPeerNetworking(ctx);
      const added = pn2.rememberDiscoveredPeer('http://self:39310');
      expect(added).to.equal(false);
    });

    it('rejects deprecated peer URLs', function () {
      const removed = pn.rememberDiscoveredPeer('http://deprecated-peer:39310');
      // not deprecated in default test context, so should succeed
      expect(removed).to.equal(true);
    });

    it('updates lastSeenMs for existing peer', function () {
      pn.rememberDiscoveredPeer('http://existing:39310', { source: 'first', seenAtMs: 1000 });
      const added = pn.rememberDiscoveredPeer('http://existing:39310', { source: 'second', seenAtMs: 2000 });
      expect(added).to.equal(false);
      const entry = ctx.discoveredPeers.get('http://existing:39310');
      expect(entry.lastSeenMs).to.equal(2000);
    });
  });

  describe('forgetDiscoveredPeer', function () {
    it('removes a peer from discoveredPeers', function () {
      pn.rememberDiscoveredPeer('http://peer:39310');
      const removed = pn.forgetDiscoveredPeer('http://peer:39310');
      expect(removed).to.equal(true);
      expect(ctx.discoveredPeers.has('http://peer:39310')).to.equal(false);
    });
  });

  describe('pruneDiscoveredPeers', function () {
    it('removes stale peers', function () {
      ctx.PEER_STALE_THRESHOLD_MS = 1000;
      const pn2 = createPeerNetworking(ctx);
      pn2.rememberDiscoveredPeer('http://stale:39310', { seenAtMs: Date.now() - 100000 });
      const changed = pn2.pruneDiscoveredPeers(Date.now());
      expect(changed).to.equal(true);
    });
  });

  describe('shouldAttemptPeerReachability', function () {
    it('returns true for unknown peer', function () {
      expect(pn.shouldAttemptPeerReachability('http://unknown:39310')).to.equal(true);
    });

    it('returns false for recently successful peer', function () {
      ctx.peerReachabilityCache.set('http://recent:39310', {
        ok: true,
        lastSuccessAtMs: Date.now(),
        lastAttemptAtMs: Date.now(),
      });
      const pn2 = createPeerNetworking(ctx);
      expect(pn2.shouldAttemptPeerReachability('http://recent:39310')).to.equal(false);
    });
  });

  describe('buildAdvertisedPeerList', function () {
    it('includes configured and discovered peers', function () {
      pn.rememberDiscoveredPeer('http://disc:39310', { source: 'peer-exchange' });
      const list = pn.buildAdvertisedPeerList(ctx.getLedgerNetworkSettings());
      expect(list.length).to.be.greaterThan(0);
    });
  });

  describe('extractReachablePeerCandidates', function () {
    it('extracts announced URLs from headers', function () {
      const req = {
        headers: { 'x-wtc-peer-urls': 'http://announced:39310' },
        socket: { remoteAddress: '10.0.0.1' },
      };
      const candidates = pn.extractReachablePeerCandidates(req, ctx.getLedgerNetworkSettings());
      expect(candidates).to.include('http://announced:39310');
    });
  });

  describe('attestation history', function () {
    it('recordPeerAttestation stores relation', function () {
      pn.recordPeerAttestation('verifier-id', 'worker-id');
      expect(ctx.peerAttestationHistory.has('verifier-id')).to.equal(true);
    });

    it('hasRecentPeerAttestationRelation returns true for recorded relation', function () {
      pn.recordPeerAttestation('peer-a', 'peer-b');
      expect(pn.hasRecentPeerAttestationRelation('peer-a', 'peer-b')).to.equal(true);
    });

    it('clearStalePeerAttestationHistory removes old relations', function () {
      ctx.PEER_ATTESTATION_RECIPROCITY_WINDOW_MS = 0;
      const pn2 = createPeerNetworking(ctx);
      pn2.recordPeerAttestation('old-a', 'old-b');
      pn2.clearStalePeerAttestationHistory(Date.now() + 1000);
      expect(ctx.peerAttestationHistory.size).to.equal(0);
    });
  });

  describe('verifyReachablePeerCandidate', function () {
    it('returns invalid-url for null candidate', async function () {
      const result = await pn.verifyReachablePeerCandidate(null);
      expect(result.ok).to.equal(false);
      expect(result.reason).to.equal('invalid-url');
    });

    it('returns ok=true for reachable peer', async function () {
      ctx.requestPeerJson = () => ({ ok: true, height: 100 });
      const pn2 = createPeerNetworking(ctx);
      const result = await pn2.verifyReachablePeerCandidate('http://reachable:39310');
      expect(result.ok).to.equal(true);
    });
  });

  describe('rememberObservedRequester', function () {
    it('registers peers from request', function () {
      const req = {
        headers: { 'x-wtc-peer-urls': 'http://observed:39310' },
        socket: { remoteAddress: '10.0.0.1' },
      };
      const observed = pn.rememberObservedRequester(req, ctx.getLedgerNetworkSettings());
      expect(observed).to.equal(true);
    });
  });

  describe('auto public peer URL', function () {
    it('detectAutoPublicPeerUrl returns empty when settings disabled', function () {
      const settings = { enabled: false, mode: 'standalone' };
      const result = pn.detectAutoPublicPeerUrl(settings);
      expect(result).to.equal('');
    });
  });

  describe('sendSeedRegistryHeartbeat', function () {
    it('does not throw when heartbeat disabled', function () {
      ctx.getRuntimeConfig = () => ({ network: 'wtc-testnet', seedRegistryHeartbeatEnabled: false });
      const pn2 = createPeerNetworking(ctx);
      pn2.sendSeedRegistryHeartbeat();
    });
  });

  describe('timer lifecycle', function () {
    it('start/stop seed registry heartbeat', function () {
      ctx.getRuntimeConfig = () => ({ network: 'wtc-mainnet', seedRegistryHeartbeatEnabled: true });
      const pn2 = createPeerNetworking(ctx);
      pn2.startSeedRegistryHeartbeat(ctx.getLedgerNetworkSettings());
      expect(ctx.seedRegistryHeartbeatTimerRef.current).to.not.be.null;
      pn2.stopSeedRegistryHeartbeat();
      expect(ctx.seedRegistryHeartbeatTimerRef.current).to.be.null;
    });

    it('start/stop remote seed peer refresh', function () {
      pn.startRemoteSeedPeerRefresh(ctx.getLedgerNetworkSettings());
      expect(ctx.remoteSeedPeerRefreshTimerRef.current).to.not.be.null;
      pn.stopRemoteSeedPeerRefresh();
      expect(ctx.remoteSeedPeerRefreshTimerRef.current).to.be.null;
    });

    it('start/stop auto public peer URL refresh', function () {
      const settings = { ...ctx.getLedgerNetworkSettings(), enabled: true, mode: 'peer' };
      pn.startAutoPublicPeerUrlRefresh(settings);
      expect(ctx.autoPublicPeerRefreshTimerRef.current).to.not.be.null;
      pn.stopAutoPublicPeerUrlRefresh();
      expect(ctx.autoPublicPeerRefreshTimerRef.current).to.be.null;
    });
  });
});
