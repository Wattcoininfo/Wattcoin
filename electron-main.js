const { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, shell } = require('electron');
// Keep the GPU compositor active even when the window is minimized or occluded.
// backgroundThrottling:false (set on the BrowserWindow) stops JS timer throttling but
// Chromium's GPU process still pauses WebGL rasterisation for invisible windows.
// These switches disable that optimisation so the GPU load loop runs at full duty cycle
// whether the window is visible, minimised, or covered by another application.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setAppUserModelId('com.wattcoin.miner');
const { spawnSync: _spawnSync } = require('child_process');
const http = require('http');
const _dns = require('dns').promises;
const dgram = require('dgram');
const { WebSocket } = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const {
  setProbeLoadPercent,
  issuePeerProbe,
  submitPeerProbeResult,
  updateWorkerRtt,
  getPeerProbeHistory: _getPeerProbeHistory,
  verifyCpuSpeedProof: _verifyCpuSpeedProof,
  verifyMemProof: _verifyMemProof,
  setCoordinatorIdentityKey,
  PROBE_INTERVAL_MS,
  getLocalProbeChain,
  cancelPendingPeerProbesForWorker,
  handleWorkerBusy,
} = require('./electron-main/backend-benchmark');
const {
  getExpectedCpuSpeedOps,
  getAsicPowerW,
  getAsicHashrateTHs,
  getGpuTdpW,
  getCpuTdpW,
} = require('./electron-main/hardware-tables.cjs');
const { stopStratumServer, stopAll: stopAllStrata } = require('./electron-main/local-stratum');
const asicDrivers = require('./asic-drivers');
const {
  setHardwareLoadPercent,
  stopHardwareLoad,
  getHardwareLoadState,
  configurePhysicalCores,
  getMeasuredCpuDuty,
} = require('./electron-main/hardware-load-controller');
const {
  ensureGpu,
  getGpuInfo,
  getGpuLoadState,
  setGpuLoadPercent: setGpuLoadPercentFn,
  stopGpuHardwareLoad,
  shutdownGpu,
  runGpuPowProbe,
  findGpuBinary,
} = require('./electron-main/gpu-load-controller');
const si = require('systeminformation');
const { createRoundLedger } = require('./electron-main/round-ledger');
const { buildOpsHealthResponse } = require('./electron-main/ops-health');
const { createRemoteSeedManifestManager } = require('./electron-main/remote-seed-manifest');
const {
  maybeRegisterReachableRequester: maybeRegisterReachableRequesterHelper,
} = require('./electron-main/requester-registration');
const peerUtils = require('./electron-main/peer-utils');
const hwProf = require('./electron-main/hardware-profiles');
const { createPersistence } = require('./electron-main/persistence');
const { createGovernance } = require('./electron-main/governance');
const { createLedgerNetwork } = require('./electron-main/ledger-network');
const { createLedgerRequestHandler } = require('./electron-main/ledger-routes');
const { createPeerNetworking } = require('./electron-main/peer-networking');
const { createIntegrityVerifier } = require('./electron-main/integrity');
const { createRoundContributions } = require('./electron-main/round-contributions');
const { createWtcChainSync } = require('./electron-main/wtc-chain-sync');
const { createPeerDiscovery } = require('./electron-main/peer-discovery');
const { createWalletSyncStateManager } = require('./electron-main/wallet-sync-state');
const { registerLedgerIpcHandlers, _nodeHasGovernanceNfts } = require('./electron-main/ledger-ipc');
const startupTrace = require('./electron-main/startup-trace');
const hwIdentity = require('./electron-main/hardware-identity');
hwIdentity.setDeps(app, si);

const { createReverseTunnel } = require('./electron-main/reverse-tunnel');
const {
  normalizePeerUrl,
  isDeprecatedPeerUrl,
  normalizeIpLiteral,
  isPublicPeerHost,
  formatPeerHostForUrl,
  appendBenchmarkSample,
  getPersonalReference,
  secureStringEquals,
  isReverseTunnelPeerUrl,
  extractTunnelIdFromUrl,
  sha256Hex,
  median,
  pruneOldTimestamps,
  pushTimestampWindow,
  getEndpointActorKey,
  shouldEscalateRateLimitToIdentityFailure,
  normalizeMinerIdentity,
  normalizeHardwareDescriptor,
  getPeerNetworkSegment,
  defaultAttestationState,
  verifyPolicyFeedEnvelope,
  _computeMaturedMinedCoinsFromHeight,
  _computeWattcoinFromMinedBlocks,
  sendJson,
  computeNextReattestDueAt,
  verifyManifestSignature,
  sanitizeForwardedTunnelHeaders,
} = require('./electron-main/main-utils');
const { initUpdater } = require('./electron-main/updater');
const { registerAttestationIpcHandlers } = require('./electron-main/attestation');
const { registerMinerAccessIpcHandlers } = require('./electron-main/mining-ipc');
const { registerFirewallIpcHandlers } = require('./electron-main/firewall-ipc');
const { registerHardwareAuthorityIpcHandlers } = require('./electron-main/hardware-authority-ipc');
const { registerExternalUrlIpcHandlers } = require('./electron-main/external-url-ipc');
const { setupRpcCredentials } = require('./electron-main/setup-rpc-credentials');
const { ensureCanonicalGenesis } = require('./electron-main/main-utils');
const { initQueues } = require('./electron-main/queue-init');
const { registerPeerNetworkIpcHandlers } = require('./electron-main/peer-network-ipc');
const { registerHardwareLoadIpcHandlers } = require('./electron-main/hardware-load-ipc');
const { registerWalletIpcHandlers } = require('./electron-main/wallet-ipc');
const { createPeerConnectivityInspector } = require('./electron-main/peer-connectivity');
const { createOpsMetricsManager } = require('./electron-main/ops-metrics');
const { registerMiningIpcHandlers } = require('./electron-main/mining-ipc');
const { registerMainIpcHandlers } = require('./electron-main/main-ipc');
const {
  buildPeerUrlFromSocket,
  getLocalPeerHosts,
  getLocalPeerIpv4InterfaceEntries,
  getLocalPeerIpv4Interfaces,
} = require('./electron-main/peer-utils');
const { createLedgerServer } = require('./electron-main/ledger-server');
const { createPeerDirectoryRefresher } = require('./electron-main/peer-directory-refresh');

const { getDataDir, getActiveNetwork } = require('./electron-main/main-utils');
function refreshCoordinatorIdentityKey() {
  try {
    const address = String(
      wtcNode && typeof wtcNode.getPrimaryAddress === 'function' ? wtcNode.getPrimaryAddress() : '',
    ).trim();
    if (address) {
      walletAddressCache.address = address;
      walletAddressCache.at = Date.now();
      setCoordinatorIdentityKey(address);
    }
    return address;
  } catch (_) {
    return '';
  }
}
const {
  getAppDisplayVersion,
  createWindow,
  getRateLockFilePath,
  getHwAuthStatePath,
  getHwFingerprintPath,
  getBenchmarkHistoryPath,
  getDiscoveredSeedPeerCachePath,
  getRemoteSeedPeerCachePath,
  getConsumedProofsFilePath,
  persistDevPeerPrivacyRecoveryKey,
} = require('./electron-main/electron-utils');
const { registerWalletBackupIpcHandlers } = require('./electron-main/wallet-backup-ipc');
const { getRuntimeConfig } = require('./electron-main/runtime-config');
const { autoUpdater } = require('electron-updater');
const { createWtcNode } = require('./electron-main/wtc-node');
const { summarizeDisplayedPeerCounts } = require('./electron-main/peer-utils');
const { buildPeerDiscoverySnapshot } = require('./electron-main/peer-discovery-observability');
const {
  filterAdvertisedPeerUrls,
  obfuscatePeerUrl,
  resolvePeerPrivacySecret,
} = require('./electron-main/peer-privacy');
const { isSelfPeerUrlCandidate, filterExternalPeerUrls } = require('./electron-main/peer-utils');
const { setupUpnpPortMapping, removeUpnpPortMapping: removeUpnpMapping } = require('./electron-main/upnp-port-forward');
const {
  getLocalSubnetProbeCandidates,
  selectDiscoveryPeerUrl,
  selectPreferredPeerUrl,
  sortPeerUrlsByPreference,
  checkHasKnownPrivateLanPeer,
} = require('./electron-main/local-subnet-discovery');
const {
  detectNatType,
  getMappedAddress: _getMappedAddress,
  NAT_TYPE,
  DEFAULT_STUN_SERVERS,
} = require('./electron-main/stun-client');
const {
  allocatePunchPort,
  buildPunchResponse,
  handlePunchResponse: _handlePunchResponse,
  requestPunch,
  performPunch,
  MIN_PUNCH_PORT: _MIN_PUNCH_PORT,
  MAX_PUNCH_PORT: _MAX_PUNCH_PORT,
} = require('./electron-main/tcp-hole-punch');
const {
  normalizeProbeReceipt,
  getProbeReceiptSigningPayload,
  attachProbeReceiptSignature,
} = require('./electron-main/probe-attestation');
const saleQueue = require('./electron-main/wtc-sale-queue');
const stakingQueue = require('./electron-main/wtc-staking-queue');
const { isValidAddress: isValidWtcAddress } = require('./electron-main/wtc-address');
const { rewardForHeight } = require('./electron-main/wtc-chain');

const _CLI_DEFAULT_TIMEOUT_MS = 6000;
const _WALLET_READINESS_REFRESH_INTERVAL_MS = 12000;
const _WALLET_READINESS_DETAILED_REFRESH_INTERVAL_MS = 5 * 60_000;
// While syncing, re-run getblockchaininfo on every UI poll (5 s) so block count visibly advances.
const _WALLET_READINESS_DETAILED_RETRY_INTERVAL_MS = 5_000;
const _WALLET_ADDRESS_CACHE_MS = 30000;
// -- Hardware-authority state -----------------------------------------------------
// Owned by the main process only.  Calibrations, trust score, and hw-hold are
// persisted to a userData file so they cannot be reset by patching the renderer
// or clearing localStorage.  The renderer reads these values back via IPC and
// uses them for display only.

let hwAuthority = {
  trustScore: 50,
  hwHoldUntilMs: 0,
  benchmarkOpsCalibration: 1.0,
  benchmarkMemCalibration: 1.0,
  benchmarkGpuCalibration: 1.0,
  consecutiveCleanBenchmarks: 0,
  peerProbeVerifiedForRound: false,
  peerProbeChainIndex: 0,
  pendingProofCommitment: '',
  calibratedUnitPowerW: 0,
  asicPowerW: 0,
  currentLoadPercent: 100,
  hwChangedBlocked: false,
  lastHwResetAtMs: 0,
  lastSearchCacheClearAtMs: 0,
  nativeGpuTdpW: 0,
  consecutiveCleanProbes: 0,
  consecutivePeerProbeFails: 0,
  probeResultWindow: [],
  rollingJitterMean: 0,
};

// -- Pending contribution buffer -----------------------------------------------
// Energy accumulates here during mining (every 250ms tick).  It is flushed to the
// round ledger only after a successful peer probe, proving the worker was online.
// This prevents unverified energy from entering the ledger.

// -- Bootstrap/seed peer wallet address cache ---------------------------------
// Populated when seed peers respond to chain-tip probes with their identity.
// Used by validateContributionProbe to enforce ≥1 bootstrap verifier.
const bootstrapPeerAddresses = new Set();

// Ref objects shared with the attestation module and other consumers.
const activeAttestationChallengesRef = { current: new Map() };
const attestationStateRef = { current: undefined };

// True until hw-auth-state.json is created for the first time.  Renderer can
// send a one-shot seed message so legacy localStorage trust scores survive the
// migration to the backend-authoritative store.
const hwAuthStateIsNew = { current: false };

const { createHandlers: createHwAuthorityState } = require('./electron-main/hardware-authority-state');
const hwAuthStateDeps = {
  hwAuthority,
  attestationStateRef,
  hwAuthStateIsNew,
  getHwAuthStatePath,
  getAttestationDbFilePath,
  safeStorage,
  networkMiningStats: new Map(),
};
const { recordMinerStats, computeHwAuthSig, loadHwAuthState, saveHwAuthState } =
  createHwAuthorityState(hwAuthStateDeps);

const { createHandlers: createFingerprintHandlers } = require('./electron-main/hardware-fingerprint');
const {
  loadHwFingerprint,
  saveHwFingerprint,
  clearHwFingerprint,
  loadBenchmarkHistory,
  saveBenchmarkHistory,
  clearBenchmarkHistory,
} = createFingerprintHandlers(getHwFingerprintPath, getBenchmarkHistoryPath, computeHwAuthSig);

function getWalletDataDir() {
  return getDataDir();
}

const roundLedger = createRoundLedger({
  baseDir: getWalletDataDir(),
  signingSecret: () => {
    try {
      return attestationStateRef.current && attestationStateRef.current.secret;
    } catch (_) {
      return null;
    }
  },
});

const ledgerNetworkServerRef = { current: null };
let refreshPeerDirectory; // assigned after wtcChainSync is created
let wtcNode = null; // WTC native chain node (initialized in app.whenReady)
function getWtcNode() {
  return wtcNode;
}

// -- Peer-mode UDP discovery ---------------------------------------------------
// Peers send a UDP beacon on PEER_DISCOVERY_PORT every 2 min so that nodes
// on the same subnet find each other without a hand-written peer list.
// Uses link-local multicast (TTL=1) instead of 255.255.255.255 broadcast
// to avoid triggering AV behaviour detection.
// Legacy `ledgerPeers` entries are treated as bootstrap seed peers, not as
// a separate static active-peer bucket.

const PEER_STALE_THRESHOLD_MS = 15 * 60_000; // 15 min without beacon -> evict
const PEER_REACHABILITY_RETRY_MS = 3 * 60_000; // 3 min - WAN peers need longer backoff before re-probe
const PEER_REACHABILITY_SUCCESS_TTL_MS = 10 * 60_000;
const PEER_REACHABILITY_TIMEOUT_MS = 20_000; // WAN: allow for TCP handshake + high latency
const PEER_CHAIN_TIP_TIMEOUT_MS = 25_000; // WAN: allow for TCP handshake + high latency
const PEER_CHAIN_TIP_CACHE_MS = 3_000;

const REVERSE_TUNNEL_CONNECT_TIMEOUT_MS = 30_000;
const REVERSE_TUNNEL_REQUEST_TIMEOUT_MS = 20_000;
const REVERSE_TUNNEL_MAX_PENDING = 64;
const ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS = 1_000;
const MIN_PROBE_VERIFIERS = 3;
const REVERSE_TUNNEL_RECONNECT_BASE_MS = 3_000;
const REVERSE_TUNNEL_RECONNECT_MAX_MS = 60_000;
const REVERSE_TUNNEL_PING_INTERVAL_MS = 20_000;
const REVERSE_TUNNEL_LIVE_THRESHOLD_MS = 90_000;
const AUTO_PUBLIC_IP_REFRESH_INTERVAL_MS = 60_000;
const SEED_REGISTRY_HEARTBEAT_INTERVAL_MS = 30 * 60_000;
const REMOTE_SEED_MANIFEST_REFRESH_INTERVAL_MS = 5 * 60_000;
const REMOTE_SEED_MANIFEST_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_REMOTE_SEED_MANIFEST_URLS = [];
const AUTO_PUBLIC_IP_SERVICES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://ident.me'];

const discoveredPeers = new Map(); // url -> { lastSeenMs, source, sources, peerIdentity?, seenThisSession?, restoredFromCache? }
const peerReachabilityCache = new Map(); // url -> { lastAttemptAtMs, lastSuccessAtMs, ok }
const peerChainTipCache = new Map(); // peerUrl -> { expiresAtMs, value }
const peerChainTipInflight = new Map(); // peerUrl -> Promise
const pendingRoundContributionBroadcasts = new Map(); // key -> { peerUrl, payload, timer }
const forwardedContributionMessages = new Map(); // msgKey `${address}:${message}` -> expiresAtMs (loop prevention)
const witnessedProbeReceipts = new Map(); // workerAddress -> { maxChainIndex: number, receipts: Map<chainIndex, Map<verifierAddress, receipt>> }
const peerAttestationHistory = new Map(); // peerIdentity -> Map<otherPeerIdentity, lastAttestedMs>
const PEER_ATTESTATION_RECIPROCITY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const peerCountCachedResultRef = { current: null }; // { expiresAtMs, value }
const PEER_COUNT_CACHE_TTL_MS = 30_000; // re-use recent inspection result for 30 s (less aggressive probing)
const PEER_COUNT_PROBE_CONCURRENCY = 5; // probe up to 5 peers in parallel
const PEER_COUNT_PROBE_TIMEOUT_MS = 25_000; // WAN-aware timeout for peer-count probes
const PEER_HEALTHY_GRACE_PERIOD_MS = 120_000; // 2 min - don't drop a peer on a single timeout; require sustained failure
const PEER_ATTESTATION_SELECTION_TIMEOUT_MS = 25_000; // attestation peer must be online now (increased for WAN stability)
const PEER_ATTESTATION_SELECTION_CONCURRENCY = 5;
const reverseTunnelSessions = new Map(); // tunnelId -> session
const reverseTunnelSessionsByPeerIdentity = new Map(); // peerIdentity -> session
const reverseTunnelPendingResponses = new Map(); // requestId -> { res, timer }
const peerGossipTopology = new Map(); // peerIdentity -> { connectedIds: Set<string>, lastReceivedMs: number }
const GOSSIP_MAX_CONNECTIONS_PER_PEER = 50; // no peer can claim more than this many connections
const GOSSIP_STALE_MS = 5 * 60 * 1000; // forget gossip reports after 5 minutes
const GOSSIP_BROADCAST_INTERVAL_MS = 60_000; // broadcast our topology every 60 s

// Forward references to peer-ban-tracking functions that aren't initialized yet.
const _peerBanFns = { isPeerUrlBanned: null, recordPeerUrlSuccess: null, recordPeerUrlFailure: null };
const createPeerHttp = require('./electron-main/peer-http');
const peerHttp = createPeerHttp({
  peerGossipTopology,
  discoveredPeers,
  peerReachabilityCache,
  peerChainTipCache,
  peerChainTipInflight,
  reverseTunnelSessions,
  peerUtils,
  normalizePeerUrl,
  isReverseTunnelPeerUrl,
  isPeerIdentitySelfReference: (peerIdentity, peerUrl) =>
    peerNetworking.isPeerIdentitySelfReference(peerIdentity, peerUrl),
  isPeerUrlBanned: (url) => _peerBanFns.isPeerUrlBanned(url),
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  resolvePeerRequestBaseUrl: (baseUrl, ...rest) => peerNetworking.resolvePeerRequestBaseUrl(baseUrl, ...rest),
  recordPeerUrlSuccess: (url) => _peerBanFns.recordPeerUrlSuccess(url),
  recordPeerUrlFailure: (url, ref) => _peerBanFns.recordPeerUrlFailure(url, ref),
  forgetPeerUrlState: (peerUrl, ...rest) => peerNetworking.forgetPeerUrlState(peerUrl, ...rest),
  rememberDiscoveredPeer: (peerUrl, opts) => peerNetworking.rememberDiscoveredPeer(peerUrl, opts),
  getPeerProtocolInfo: () => getPeerProtocolInfo(),
  buildPeerAnnouncementHeaders: (...args) => peerNetworking.buildPeerAnnouncementHeaders(...args),
  getLocalPeerIdentity: () => getLocalPeerIdentity(),
  GOSSIP_STALE_MS,
  GOSSIP_BROADCAST_INTERVAL_MS,
  GOSSIP_MAX_CONNECTIONS_PER_PEER,
  PEER_CHAIN_TIP_CACHE_MS,
});
const {
  requestPeerJson,
  handleIncomingGossip,
  startGossipBroadcastLoop,
  stopGossipBroadcastLoop,
  verifyChainPeerCompatibility,
} = peerHttp;
const relayWorkerConns = new Map(); // tunnelId -> Map<workerId, WebSocket>
const reverseTunnelClientState = {
  socket: null,
  coordinatorUrl: '',
  publicUrl: '',
  tunnelId: '',
  connectedAtMs: 0,
  lastSeenAtMs: 0,
  reconnectDelayMs: REVERSE_TUNNEL_RECONNECT_BASE_MS,
  reconnectTimer: null,
  pingTimer: null,
  connecting: false,
  rotateCoordinatorOnNextAttempt: false,
};
let autoDetectedPublicPeerLookupPromise = null;
let autoPublicPeerRefreshTimer = null;
let seedRegistryHeartbeatTimer = null;

// Ref objects shared with the peer-networking module so external sites
// (e.g. UPnP handler) can sync scalar state with the module's copies.
const autoDetectedPublicPeerUrlRef = { current: '' };
const autoDetectedPublicPeerUrlFromUpnpRef = { current: false };
const autoDetectedPublicPeerLookupPromiseRef = { current: autoDetectedPublicPeerLookupPromise };
const remoteSeedPeerRefreshTimerRef = { current: null };
const autoPublicPeerRefreshTimerRef = { current: autoPublicPeerRefreshTimer };
const seedRegistryHeartbeatTimerRef = { current: seedRegistryHeartbeatTimer };
// NAT / STUN detection state
const stunNatInfoRef = { current: null }; // { natType, mappedIp, mappedPort, stunHost, detectedAtMs }
const stunDetectionPromiseRef = { current: null };
let usedPunchPorts = new Set();
let peerPunchAttemptTimestamps = new Map(); // normalizedUrl -> lastAttemptAtMs
// Gossip state
const peerGossipSeen = new Map(); // `peerUrl:gossipId` -> detectedAtMs
// blockHash - { minedAddress, totalWh, rewardCoins, settledAtMs, sig, fromPeer }
const witnessedSettlements = new Map();

const remoteSeedManifestManager = createRemoteSeedManifestManager({
  fs,
  getRuntimeConfig,
  getCachePath: getRemoteSeedPeerCachePath,
  normalizePeerUrl,
  isDeprecatedPeerUrl,
  requestExternalResponse: peerUtils.requestExternalResponse,
  fetchTimeoutMs: REMOTE_SEED_MANIFEST_FETCH_TIMEOUT_MS,
  defaultRemoteSeedManifestUrls: DEFAULT_REMOTE_SEED_MANIFEST_URLS,
  schedulePeerSync: (reason, delayMs) => wtcChainSync.scheduleWtcPeerSync(reason, delayMs),
  logger: console,
});

const TEAM_FILE = 'wtc-team.json';
const DOCS_FILE = 'wtc-docs.json';

function getTeamFilePath() {
  return path.join(getWalletDataDir(), TEAM_FILE);
}

function getDocsFilePath() {
  return path.join(getWalletDataDir(), DOCS_FILE);
}

// -- Module initialisation ----------------------------------------------------
// Factories are called once; the returned object replaces the duplicated
// function bodies below so that electron-main.js delegates to the new modules.

const _deviceIdentityFns = { getDeviceIdentityFilePath: null, getDeviceIdentitySecret: null };

const persistence = createPersistence({
  getRateLockFilePath,
  getPolicyAnchorCacheFilePath,
  getAttestationProfileCacheFilePath,
  getDiscoveredSeedPeerCachePath,
  getTeamFilePath,
  getDocsFilePath,
  getDeviceIdentityFilePath: (...args) => _deviceIdentityFns.getDeviceIdentityFilePath(...args),
  rememberedDiscoveredPeers: discoveredPeers,
  rememberDiscoveredPeer: (peerUrl, opts) => peerNetworking.rememberDiscoveredPeer(peerUrl, opts),
  PEER_STALE_THRESHOLD_MS,
  app,
});

// ── Shared mutable state refs for extracted modules ───────────────
const _pendingContributionWhRef = { current: 0 };
const _contributionSecondStartRef = { current: 0 };
const _contributionPerSecondRef = { current: 0 };
const _cpuDutySamplesRef = { current: [] };
const _prevRawCpuDutyRef = { current: -1 };
const _startupRampUpRef = { current: false };
const _startupRampUpStartedAtRef = { current: 0 };
const _gpuDutySamplesRef = { current: [] };
const _prevRawGpuDutyRef = { current: -1 };
const _startupGpuRampUpRef = { current: false };
const _startupGpuRampUpStartedAtRef = { current: 0 };
const wtcPeerSyncTimerRef = { current: null };
const wtcPeerSyncDebounceTimerRef = { current: null };
const wtcPeerSyncPendingReasonRef = { current: '' };
const _physicalCoreCountRef = { current: 0 };
const WTC_PEER_SYNC_INTERVAL_MS = 60_000;
const WTC_PEER_SYNC_DEBOUNCE_MS = 1500;

let walletAddressCache = { address: '', at: 0 };
const { refreshWalletSyncState, startWalletSyncStateLoop, stopWalletSyncStateLoop, updateInstallInProgressRef } =
  createWalletSyncStateManager({
    getWtcNode: () => wtcNode,
    walletAddressCache,
    setCoordinatorIdentityKey,
    BrowserWindow,
  });
const ENABLE_POWER_PROOF_COMMITMENT = true;

const integrityVerifier = createIntegrityVerifier({
  app,
  verifyManifestSignature,
});

const opsState = {
  lastTipHash: '',
  lastTipTimestamp: 0,
  blockIntervalsSec: [],
  rollbackDepths: [],
  forkMismatchTimestamps: [],
  syncLagSamples: [],
  lastSyncResult: null,
  lastSyncAttemptAt: 0,
  peerRequestOkTimestamps: [],
  peerRequestFailTimestamps: [],
  alerts: [],
  alertCooldownUntil: new Map(),
  latestSnapshot: null,
};

const peerUrlFailures = new Map(); // peerUrl -> number[] timestamps

const LEDGER_RECONCILE_INTERVAL_MS = 10 * 60_000;

const peerDiscovery = createPeerDiscovery({
  dgram,
  normalizePeerUrl,
  isSelfPeerUrl: (candidate) => peerNetworking.isSelfPeerUrl(candidate),
  isPeerUrlBanned: (url) => _peerBanFns.isPeerUrlBanned(url),
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  rememberDiscoveredPeer: (peerUrl, opts) => peerNetworking.rememberDiscoveredPeer(peerUrl, opts),
  requestPeerJson,
  getConfiguredAdvertisedPeerUrls: (...args) => peerNetworking.getConfiguredAdvertisedPeerUrls(...args),
  getPrimaryAdvertisedPeerUrl: (...args) => peerNetworking.getPrimaryAdvertisedPeerUrl(...args),
  getLocalPeerHosts,
  getLocalPeerIpv4Interfaces,
  getLocalPeerIpv4InterfaceEntries,
  getLocalSubnetProbeCandidates,
  sortPeerUrlsByPreference,
  filterExternalPeerUrls,
  buildPeerUrlFromSocket,
  selectDiscoveryPeerUrl,
  checkHasKnownPrivateLanPeer,
  pruneDiscoveredPeers: (...args) => peerNetworking.pruneDiscoveredPeers(...args),
  refreshPeerDirectory: (...args) => refreshPeerDirectory(...args),
  discoveredPeers,
  peerReachabilityCache,
  peerCountCachedResultRef,
});

const roundContributions = createRoundContributions({
  roundLedger,
  getWtcNode: () => wtcNode,
  hwAuthority,
  walletAddressCache,
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  requestPeerJson,
  normalizePeerUrl,
  getLocalProbeChain,
  rewardForHeight,
  getActiveNetwork,
  computeHwAuthSig,
  getCurrentBlockHeight,
  getCurrentNetworkRoundId,
  recordForkMismatch,
  alignRoundLedgerToChain,
  ENABLE_POWER_PROOF_COMMITMENT,
  console,
  _pendingContributionWh: _pendingContributionWhRef,
  _contributionPerSecond: _contributionPerSecondRef,
  _contributionSecondStart: _contributionSecondStartRef,
  pendingRoundContributionBroadcasts,
  witnessedSettlements,
  witnessedProbeReceipts,
  bootstrapPeerAddresses,
  MIN_PROBE_VERIFIERS,
  REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
  ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS,
});

const wtcChainSync = createWtcChainSync({
  getWtcNode: () => wtcNode,
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  getPeerDirectoryTargets: (...args) => peerDiscovery.getPeerDirectoryTargets(...args),
  requestPeerJson,
  normalizePeerUrl,
  isSelfPeerUrl: (candidate) => peerNetworking.isSelfPeerUrl(candidate),
  isPeerUrlBanned: (url) => _peerBanFns.isPeerUrlBanned(url),
  rememberDiscoveredPeer: (peerUrl, opts) => peerNetworking.rememberDiscoveredPeer(peerUrl, opts),
  peerReachabilityCache,
  peerUtils,
  stunNatInfoRef,
  allocatePunchPort,
  requestPunch,
  filterExternalPeerUrls,
  getConfiguredAdvertisedPeerUrls: (...args) => peerNetworking.getConfiguredAdvertisedPeerUrls(...args),
  getLocalPeerHosts,
  NAT_TYPE,
  crypto,
  refreshWalletSyncState,
  recordRollbackDepth,
  wtcPeerSyncTimerRef,
  wtcPeerSyncDebounceTimerRef,
  wtcPeerSyncPendingReasonRef,
  peerPunchAttemptTimestamps,
  usedPunchPorts,
  peerGossipSeen,
  opsState,
  PEER_PUNCH_RETRY_INTERVAL_MS: 120_000,
  PEER_PUNCH_PER_CYCLE_MAX: 3,
  PEER_GOSSIP_FANOUT: 4,
  PEER_GOSSIP_TTL: 2,
  PEER_GOSSIP_SEEN_TTL_MS: 300_000,
  PEER_REACHABILITY_SUCCESS_TTL_MS: 10 * 60_000,
  WTC_PEER_SYNC_INTERVAL_MS,
  WTC_PEER_SYNC_DEBOUNCE_MS,
});

// -- WebSocket push-probe coordinator -------------------------------------------
// Pushes probes to connected workers at unpredictable intervals so the
// renderer cannot predict or control probe timing.
const _probePushConns = new Map(); // workerId -> { ws, allowGpu }
const _probePushWssRef = { current: null };
const _probePushTimerRef = { current: null };
const _PROBE_PUSH_INTERVAL_MAX_MS = 60_000;

// On the coordinator side: tracks which connected workers have reported
// they are actively mining. Workers that explicitly signal non-mining
// (idle) are skipped in _runProbePush to avoid sending probes that
// would time out. Workers that haven't reported a status default to
// unknown (undefined), which preserves backward compatibility - they
// continue to receive probes. New connections start as null (pending)
// and are skipped until the first mining-status message or a 5s timeout.
const _workerIsMining = new Map(); // workerId ? boolean | null | undefined

const { createHandlers: createPeerProbeIpc } = require('./electron-main/peer-probe-ipc');
const peerProbeIpc = createPeerProbeIpc({
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  getOnlineAttestationPeers: (...args) => peerNetworking.getOnlineAttestationPeers(...args),
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  walletAddressCache,
  getAsicConfigModule: (...args) => getAsicConfigModule(...args),
  findGpuBinary,
  _localMiningStatus: false,
  hwAuthority,
  saveHwAuthState,
  roundLedger,
  normalizePeerUrl,
  peerReachabilityCache,
  requestPeerJson,
  _flushPendingContribution: (chainIndex) => roundContributions._flushPendingContribution(chainIndex),
  getAppDisplayVersion,
  recordPeerAttestation: (verifierAddress, workerId) => peerNetworking.recordPeerAttestation(verifierAddress, workerId),
  broadcastProbeReceiptToPeers: (receipt) => roundContributions.broadcastProbeReceiptToPeers(receipt),
  getProbeReceiptSigningPayload,
  attachProbeReceiptSignature,
  getWtcNode: () => wtcNode,
  submitPeerProbeResult,
  getCurrentNetworkRoundId,
  refreshCoordinatorIdentityKey,
  cancelPendingPeerProbesForWorker,
  issuePeerProbe,
  _probePushConns,
  _workerIsMining,
  _probePushWssRef,
  _PROBE_PUSH_INTERVAL_MAX_MS,
  _pendingContributionWhRef,
  _probePushTimerRef,
});
const { registerIpcHandlers, _connectBgProbeWs, _closeBgProbeWs, _scheduleBgProbeWsReconnect } = peerProbeIpc;

const reverseTunnel = createReverseTunnel({
  reverseTunnelSessions,
  reverseTunnelSessionsByPeerIdentity,
  reverseTunnelPendingResponses,
  reverseTunnelClientState,
  relayWorkerConns,
  probePushConns: _probePushConns,
  workerIsMining: _workerIsMining,
  cancelPendingPeerProbesForWorker,
  handleWorkerBusy,
  handleWsProbeResult: peerProbeIpc._handleWsProbeResult,
  getConfiguredAdvertisedPeerUrls: (...args) => peerNetworking.getConfiguredAdvertisedPeerUrls(...args),
  isPublicPeerHost,
  normalizePeerUrl,
  getPeerDirectoryTargets: (...args) => peerDiscovery.getPeerDirectoryTargets(...args),
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  sendJson,
  forgetDiscoveredPeer: (peerUrl, ...args) => peerNetworking.forgetDiscoveredPeer(peerUrl, ...args),
  rememberDiscoveredPeer: (peerUrl, opts) => peerNetworking.rememberDiscoveredPeer(peerUrl, opts),
  scheduleWtcPeerSync: (reason, delayMs) => wtcChainSync.scheduleWtcPeerSync(reason, delayMs),
  forgetDiscoveredPeersByIdentity: (peerIdentity, opts) =>
    peerNetworking.forgetDiscoveredPeersByIdentity(peerIdentity, opts),
  refreshPeerDirectory: (...args) => refreshPeerDirectory(...args),
  writeStartupTrace: startupTrace.writeStartupTrace,
  obfuscatePublicPeerUrl,
  isSelfPeerUrl: (candidate) => peerNetworking.isSelfPeerUrl(candidate),
  isLocallyServedReverseTunnelPeerUrl: (candidate, ...args) =>
    peerNetworking.isLocallyServedReverseTunnelPeerUrl(candidate, ...args),
  buildPeerAnnouncementHeaders: (...args) => peerNetworking.buildPeerAnnouncementHeaders(...args),
  getPeerProtocolInfo,
  getLocalPeerHosts,
  verifyChainPeerCompatibility,
  getLocalPeerIdentity,
  sanitizeForwardedTunnelHeaders,
  peerUtils,
  updateWorkerRtt,
  forgetPeerUrlState: (peerUrl, ...args) => peerNetworking.forgetPeerUrlState(peerUrl, ...args),
  crypto,
  ledgerNetworkServerRef,
  probePushWssRef: _probePushWssRef,
  clearProbePushTimer: peerProbeIpc._clearProbePushTimer,
  runProbePush: peerProbeIpc._runProbePush,
  REVERSE_TUNNEL_CONNECT_TIMEOUT_MS,
  REVERSE_TUNNEL_REQUEST_TIMEOUT_MS,
  REVERSE_TUNNEL_MAX_PENDING,
  REVERSE_TUNNEL_RECONNECT_BASE_MS,
  REVERSE_TUNNEL_RECONNECT_MAX_MS,
  REVERSE_TUNNEL_PING_INTERVAL_MS,
  REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
});

registerIpcHandlers(ipcMain);

const peerNetworking = createPeerNetworking({
  discoveredPeers,
  peerReachabilityCache,
  peerChainTipCache,
  peerChainTipInflight,
  peerUrlFailures,
  peerAttestationHistory,
  bootstrapPeerAddresses,
  reverseTunnelSessions,
  reverseTunnelClientState,
  autoDetectedPublicPeerUrlRef,
  autoDetectedPublicPeerUrlFromUpnpRef,
  autoDetectedPublicPeerLookupPromiseRef,
  remoteSeedPeerRefreshTimerRef,
  autoPublicPeerRefreshTimerRef,
  seedRegistryHeartbeatTimerRef,
  PEER_STALE_THRESHOLD_MS,
  PEER_REACHABILITY_RETRY_MS,
  PEER_REACHABILITY_SUCCESS_TTL_MS,
  PEER_REACHABILITY_TIMEOUT_MS,
  PEER_ATTESTATION_SELECTION_TIMEOUT_MS,
  PEER_ATTESTATION_SELECTION_CONCURRENCY,
  PEER_ATTESTATION_RECIPROCITY_WINDOW_MS,
  REMOTE_SEED_MANIFEST_REFRESH_INTERVAL_MS,
  AUTO_PUBLIC_IP_REFRESH_INTERVAL_MS,
  SEED_REGISTRY_HEARTBEAT_INTERVAL_MS,
  REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
  MIN_PROBE_VERIFIERS,
  AUTO_PUBLIC_IP_SERVICES,
  getRuntimeConfig,
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  getPeerDirectoryTargets: (...args) => peerDiscovery.getPeerDirectoryTargets(...args),
  getLocalPeerHosts,
  getLocalPeerIdentity,
  getTrustedRequesterPeerIdentity: (...args) => ledgerNetwork.getTrustedRequesterPeerIdentity(...args),
  requestPeerJson,
  isSelfPeerUrlCandidate,
  filterAdvertisedPeerUrls,
  sortPeerUrlsByPreference,
  normalizeIpLiteral,
  isPublicPeerHost,
  formatPeerHostForUrl,
  isPeerUrlBanned: (url) => _peerBanFns.isPeerUrlBanned(url),
  isReverseTunnelPeerUrl,
  buildPeerUrlFromSocket,
  selectPreferredPeerUrl,
  recordPeerUrlSuccess: (url, peerIdentity) => _peerBanFns.recordPeerUrlSuccess(url, peerIdentity),
  gossipAnnounce: (...args) => wtcChainSync.gossipAnnounce(...args),
  scheduleWtcPeerSync: (reason, delayMs) => wtcChainSync.scheduleWtcPeerSync(reason, delayMs),
  extractTunnelIdFromUrl,
  maybeRegisterReachableRequesterHelper,
  scheduleDiscoveredSeedPeerCacheSave: persistence.scheduleDiscoveredSeedPeerCacheSave,
  loadDiscoveredSeedPeerCache: persistence.loadDiscoveredSeedPeerCache,
  remoteSeedManifestManager,
  obfuscatePublicPeerUrl,
  getWtcNode: () => wtcNode,
});

const ledgerNetwork = createLedgerNetwork({
  getRuntimeConfig,
  getConfiguredAdvertisedPeerUrls: (...args) => peerNetworking.getConfiguredAdvertisedPeerUrls(...args),
  roundLedger,
  getCurrentBlockHeight,
  LEDGER_RECONCILE_INTERVAL_MS,
  loadCachedRemoteSeedPeers: () => peerNetworking.loadCachedRemoteSeedPeers(),
});

const governance = createGovernance({
  getWtcNode: () => wtcNode,
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  requestPeerJson,
  readTeamData: persistence.readTeamData,
  writeTeamData: persistence.writeTeamData,
  readDocsData: persistence.readDocsData,
  writeDocsData: persistence.writeDocsData,
});

refreshPeerDirectory = createPeerDirectoryRefresher({
  ledgerNetwork,
  peerDiscovery,
  peerUtils,
  requestPeerJson,
  peerNetworking,
  selectPreferredPeerUrl,
  stunNatInfoRef,
  NAT_TYPE,
  tryHolePunchToPeers: (...args) => wtcChainSync.tryHolePunchToPeers(...args),
}).refreshPeerDirectory;

function getPeerDiscoverySnapshot(settings = ledgerNetwork.getLedgerNetworkSettings()) {
  return buildPeerDiscoverySnapshot({
    settings,
    discoveredEntries: Array.from(discoveredPeers.entries()).map(([url, info]) => ({ url, info })),
    staleThresholdMs: PEER_STALE_THRESHOLD_MS,
    isPeerUrlBanned: (url) => _peerBanFns.isPeerUrlBanned(url),
    transformUrl: obfuscatePublicPeerUrl,
  });
}

function getPeerPrivacySecret() {
  try {
    const secret = getDeviceIdentitySecret();
    if (secret) return resolvePeerPrivacySecret(secret);
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  try {
    const identity = loadOrCreateDeviceIdentity();
    return resolvePeerPrivacySecret(getDeviceIdentitySecret(), identity && identity.deviceId);
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  return '';
}

function obfuscatePublicPeerUrl(peerUrl) {
  return obfuscatePeerUrl(peerUrl, getPeerPrivacySecret());
}

const OPS_WINDOW_MS = 60 * 60_000;
const CHAIN_STALL_ALERT_MS = 20 * 60_000;

const ATTESTATION_PROFILE_CACHE_FILE_NAME = 'attestation-profile-cache.json';
const POLICY_ANCHOR_CACHE_FILE = 'policy-anchor-cache.json';
const ATTESTATION_CHALLENGE_TTL_MS = 2 * 60_000;
const ATTESTATION_REPLAY_WINDOW_MS = 12 * 60 * 60_000;
const ATTESTATION_MAX_LEVEL = 10;
const ATTESTATION_REATTEST_MIN_MS = 2 * 60 * 60_000;
const ATTESTATION_REATTEST_MAX_MS = 4 * 60 * 60_000;
const ATTESTATION_SPOTCHECK_MIN_GAP_MS = 30 * 60_000;
const ATTESTATION_SPOTCHECK_DURATION_MS = 20 * 60_000;
const POLICY_FEED_REFRESH_MS = 15 * 60_000;
const ENABLE_NODE_ATTESTATION = true;
// OP_RETURN prefix for on-chain policy anchors - 'WTCP1:' + 64-char SHA-256 hex = 70 bytes.
const _POLICY_OPRETURN_PREFIX = 'WTCP1:';

function getAttestationDbFilePath() {
  return path.join(getWalletDataDir(), 'attestation-state.json');
}

function getPolicyAnchorCacheFilePath() {
  return path.join(getWalletDataDir(), POLICY_ANCHOR_CACHE_FILE);
}

function getAttestationProfileCacheFilePath() {
  return path.join(getWalletDataDir(), ATTESTATION_PROFILE_CACHE_FILE_NAME);
}

const { LOCAL_HARDWARE_PROFILE_DB } = require('./electron-main/hardware-profiles');

const { createAttestation } = require('./electron-main/attestation');
const attestation = createAttestation({
  getWalletDataDir,
  safeStorage,
  getDeviceIdentitySecret: (...args) => _deviceIdentityFns.getDeviceIdentitySecret(...args),
  persistence,
  hwProf,
  verifyPolicyFeedEnvelope,
  sha256Hex,
  secureStringEquals,
  computeNextReattestDueAt,
  normalizeHardwareDescriptor,
  normalizeMinerIdentity,
  defaultAttestationState,
  getRuntimeConfig,
  getConsumedProofsFilePath,
  hwAuthority,
  getWtcNode,
  computeHwAuthSig,
  activeAttestationChallengesRef,
  attestationStateRef,
  LOCAL_HARDWARE_PROFILE_DB,
  POLICY_FEED_REFRESH_MS,
  ATTESTATION_REPLAY_WINDOW_MS,
  ATTESTATION_PROFILE_CACHE_FILE_NAME,
  ATTESTATION_SPOTCHECK_MIN_GAP_MS,
  ATTESTATION_SPOTCHECK_DURATION_MS,
  ATTESTATION_MAX_LEVEL,
  ATTESTATION_REATTEST_MIN_MS,
  ATTESTATION_REATTEST_MAX_MS,
  ATTESTATION_CHALLENGE_TTL_MS,
  ENABLE_NODE_ATTESTATION,
  POLICY_ANCHOR_CACHE_FILE,
});
const {
  loadAttestationState: loadAttestationStateFromModule,
  saveAttestationState: saveAttestationStateFromModule,
  loadConsumedProofs: loadConsumedProofsFromModule,
  issueBenchmarkChallenge,
  submitBenchmarkProof,
  enforceReattestationGateForMiner,
  computePolicyForMiner,
  ensurePolicyFeedRefreshLoop,
} = attestation;

ipcMain.handle('wattcoin-publish-policy-anchor', (_event, _policyText) => {
  return {
    ok: false,
    code: 'NOT_SUPPORTED',
    message: 'Policy anchor publishing is not supported on WTC native chain.',
  };
});

function isBetaModeEnabled() {
  return Boolean(getRuntimeConfig().betaMode);
}

function getBetaPolicy() {
  const betaMode = isBetaModeEnabled();
  return {
    betaMode,
    withdrawalsEnabled: !betaMode,
    rewardsConvertible: !betaMode,
    resetWipePolicy: betaMode,
    policyMessage: betaMode
      ? 'Closed beta mode active: balances are test-only, withdrawals are disabled, and balances may be reset or wiped.'
      : 'Standard mode active.',
  };
}

function getOpsMetricsFilePath() {
  return path.join(getWalletDataDir(), 'ops-metrics.json');
}

function _getDiscoveredPeerPresenceCount(settings = ledgerNetwork.getLedgerNetworkSettings()) {
  const now = Date.now();
  const selfAdvertisedUrls = new Set(
    peerNetworking.getConfiguredAdvertisedPeerUrls(settings).map(normalizePeerUrl).filter(Boolean),
  );
  const presenceKeys = new Set();
  for (const [peerUrl, info] of discoveredPeers.entries()) {
    if (!info || now - Number(info.lastSeenMs || 0) > PEER_STALE_THRESHOLD_MS || isPeerUrlBanned(peerUrl)) continue;
    if (!info.seenThisSession) continue;
    const peerIdentity = String(info.peerIdentity || '').trim();
    if (peerNetworking.isPeerIdentitySelfReference(peerIdentity, peerUrl)) continue;
    // Skip self even when our public IP is not in the local interfaces (NAT).
    if (selfAdvertisedUrls.has(normalizePeerUrl(peerUrl))) continue;
    presenceKeys.add(peerIdentity ? `id:${peerIdentity}` : `url:${peerUrl}`);
  }
  return presenceKeys.size;
}

function getCurrentBlockHeight() {
  if (wtcNode) return wtcNode.getHeight();
  return 0;
}

ipcMain.handle('wattcoin-is-hardware-recognized', (_event, { gpuModels, cpuModel, asicModel } = {}) => {
  const unrecognized = [];
  if (Array.isArray(gpuModels)) {
    for (const m of gpuModels) {
      if (m && getGpuTdpW(m) === 0) unrecognized.push({ type: 'gpu', model: m });
    }
  }
  if (cpuModel && getExpectedCpuSpeedOps(cpuModel) === 0 && getCpuTdpW(cpuModel) === 0) {
    unrecognized.push({ type: 'cpu', model: cpuModel });
  }
  if (asicModel && getAsicPowerW(asicModel) === 0) {
    unrecognized.push({ type: 'asic', model: asicModel });
  }
  return { recognized: unrecognized.length === 0, unrecognized };
});

const {
  registerBenchmarkIpcHandlers,
  getAsicConfig: getAsicConfigModule,
  getStratumHandles,
} = require('./electron-main/benchmark-ipc');
const asicMgmt = require('./electron-main/asic-management');
asicMgmt.setDeps(getAsicConfigModule, asicDrivers, getStratumHandles);
registerBenchmarkIpcHandlers({
  ipcMain,
  wtcNode: () => wtcNode,
  walletAddressCache,
  hwAuthority,
  activeAttestationChallenges: activeAttestationChallengesRef.current,
  resolveOsHardwareIdentity: hwIdentity.resolveOsHardwareIdentity,
  loadHwFingerprint,
  saveHwFingerprint,
  clearBenchmarkHistory,
  loadBenchmarkHistory,
  saveBenchmarkHistory,
  verifyAsicLiveness: asicMgmt.verifyAsicLiveness,
  verifyAsicFirmware: asicMgmt.verifyAsicFirmware,
  recordMinerStats,
  saveHwAuthState,
  _closeBgProbeWs,
  _connectBgProbeWs,
  computeHwAuthSig,
  stopStratumServer,
});
const { createHandlers: createDeviceIdentityHandlers } = require('./electron-main/device-identity');
const {
  getDeviceIdentityFilePath,
  getDeviceIdentitySecret,
  getOrCreateWalletEncryptionKey,
  loadOrCreateDeviceIdentity,
} = createDeviceIdentityHandlers(getDataDir, persistence, safeStorage);
// Wire up device-identity forward references used by persistence
_deviceIdentityFns.getDeviceIdentityFilePath = getDeviceIdentityFilePath;
_deviceIdentityFns.getDeviceIdentitySecret = getDeviceIdentitySecret;

const { createRateLimiter } = require('./electron-main/rate-limiter');

// ── Forward refs for circular deps (ban-tracking ↔ ops-metrics) ──
let _recordOpsAlert = () => {};
let _logAbuseEvent = () => {};

const { createHandlers: createBanTracking } = require('./electron-main/peer-ban-tracking');
const peerRequestFailTimestamps = { current: opsState.peerRequestFailTimestamps };
const peerRequestOkTimestamps = { current: opsState.peerRequestOkTimestamps };
const {
  isPeerIdentityBanned,
  isPeerUrlBanned,
  recordPeerIdentityFailure,
  recordPeerUrlFailure,
  recordPeerUrlSuccess,
  bannedPeerIdentities,
  bannedPeerUrls,
} = createBanTracking({
  peerUtils,
  pushTimestampWindow,
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  recordOpsAlert: (code, severity, message, details) => _recordOpsAlert(code, severity, message, details),
  peerRequestFailTimestamps,
  peerRequestOkTimestamps,
  opsWindowMs: OPS_WINDOW_MS,
  peerUrlFailures,
});
// Wire up peer-ban forward references used by peerHttp
_peerBanFns.isPeerUrlBanned = isPeerUrlBanned;
_peerBanFns.recordPeerUrlSuccess = recordPeerUrlSuccess;
_peerBanFns.recordPeerUrlFailure = recordPeerUrlFailure;
// Re-bind opsState arrays to the refs set from the module
opsState.peerRequestFailTimestamps = peerRequestFailTimestamps.current;
opsState.peerRequestOkTimestamps = peerRequestOkTimestamps.current;

// -- Peer connectivity inspector -----------------------------------------------
const { inspectPeerConnectivityForTargets, inspectPeerConnectivity } = createPeerConnectivityInspector({
  normalizePeerUrl,
  peerUtils,
  discoveredPeers,
  isLocallyServedReverseTunnelPeerUrl: (candidate, ...args) =>
    peerNetworking.isLocallyServedReverseTunnelPeerUrl(candidate, ...args),
  extractTunnelIdFromUrl,
  reverseTunnelSessions,
  WebSocket,
  REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
  isPeerIdentitySelfReference: (peerIdentity, peerUrl) =>
    peerNetworking.isPeerIdentitySelfReference(peerIdentity, peerUrl),
  shouldAttemptPeerReachability: (candidate, ...args) =>
    peerNetworking.shouldAttemptPeerReachability(candidate, ...args),
  peerReachabilityCache,
  PEER_COUNT_CACHE_TTL_MS,
  PEER_CHAIN_TIP_TIMEOUT_MS,
  PEER_HEALTHY_GRACE_PERIOD_MS,
  requestPeerJson,
  recordPeerUrlSuccess,
  rememberDiscoveredPeer: (peerUrl, opts) => peerNetworking.rememberDiscoveredPeer(peerUrl, opts),
  isReverseTunnelPeerUrl,
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  getWtcNode: () => wtcNode,
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  PEER_COUNT_PROBE_CONCURRENCY,
  PEER_COUNT_PROBE_TIMEOUT_MS,
});

// -- Ops metrics manager -------------------------------------------------------
const { collectOpsSnapshot, startOpsMetricsLoop, stopOpsMetricsLoop, recordOpsAlert, logAbuseEvent } =
  createOpsMetricsManager({
    opsState,
    getWtcNode: () => wtcNode,
    getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
    inspectPeerConnectivity,
    getPeerNetworkSegment,
    median,
    pruneOldTimestamps,
    pushTimestampWindow,
    bannedPeerUrls,
    bannedPeerIdentities,
    runWtcPeerSync: (...args) => wtcChainSync.runWtcPeerSync(...args),
    getOpsMetricsFilePath,
    OPS_METRICS_SAMPLE_MS: 30_000,
    OPS_WINDOW_MS,
    CHAIN_STALL_ALERT_MS,
    OPS_ALERT_COOLDOWN_MS: 5 * 60_000,
    getDataDir,
  });

// Wire up forward refs
_recordOpsAlert = recordOpsAlert;
_logAbuseEvent = logAbuseEvent;

function recordForkMismatch(details = {}) {
  opsState.forkMismatchTimestamps = pushTimestampWindow(opsState.forkMismatchTimestamps, OPS_WINDOW_MS, 5000);
  recordOpsAlert('chain.fork.mismatch', 'warn', 'Settlement mismatch detected across peers', details);
}

function recordRollbackDepth(depth, details = {}) {
  const n = Math.max(0, Number(depth) || 0);
  if (n <= 0) return;
  opsState.rollbackDepths.push(n);
  opsState.rollbackDepths = opsState.rollbackDepths.slice(-500);
  if (n >= 3) {
    recordOpsAlert('chain.rollback.depth', 'warn', `Rollback depth ${n} observed`, details);
  }
}

const { loadRateLocks, enforceEndpointRateLimit } = createRateLimiter(
  persistence,
  getEndpointActorKey,
  shouldEscalateRateLimitToIdentityFailure,
  recordPeerIdentityFailure,
  _logAbuseEvent,
);

// -- Peer probe IPC (worker mode) — handled by electron-main/peer-probe-ipc.js

// -- Hardware-authority read-back (renderer uses for display only) -------------
registerHardwareAuthorityIpcHandlers(ipcMain, {
  hwAuthority,
  hwAuthStateIsNew,
  saveHwAuthState,
  loadHwFingerprint,
  clearHwFingerprint,
  clearBenchmarkHistory,
  walletAddressCache,
  enforceEndpointRateLimit,
  loadBenchmarkHistory,
  appendBenchmarkSample,
  getPersonalReference,
  saveBenchmarkHistory,
});

registerAttestationIpcHandlers(ipcMain, {
  issueBenchmarkChallenge,
  submitBenchmarkProof,
  computePolicyForMiner,
  getWtcNode,
});

registerMinerAccessIpcHandlers(ipcMain, {
  getRuntimeConfig,
  secureStringEquals,
  logAbuseEvent,
  getBetaPolicy,
});

registerFirewallIpcHandlers(ipcMain, { app });

registerExternalUrlIpcHandlers(ipcMain, { shell });

// Business IPC handlers extracted to electron-main/business-ipc.js

// Business IPC handlers extracted to electron-main/business-ipc.js

// Business IPC handlers extracted to electron-main/business-ipc.js

// Business IPC handlers extracted to electron-main/business-ipc.js

// Business IPC handlers extracted to electron-main/business-ipc.js

// Business IPC handlers extracted to electron-main/business-ipc.js

// Business IPC handlers extracted to electron-main/business-ipc.js

const { registerBusinessIpcHandlers } = require('./electron-main/business-ipc');
registerBusinessIpcHandlers({
  wtcNode: () => wtcNode,
  persistence,
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  broadcastTeamDocsToPeers: (...args) => governance.broadcastTeamDocsToPeers(...args),
});

registerPeerNetworkIpcHandlers(ipcMain, {
  peerCountCachedResultRef,
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  pruneDiscoveredPeers: (...args) => peerNetworking.pruneDiscoveredPeers(...args),
  getPeerDiscoverySnapshot,
  opsState,
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  getPeerDirectoryTargets: (...args) => peerDiscovery.getPeerDirectoryTargets(...args),
  inspectPeerConnectivityForTargets,
  PEER_COUNT_PROBE_CONCURRENCY,
  PEER_COUNT_PROBE_TIMEOUT_MS,
  getActiveReverseTunnelPeerConnectionCount: () => reverseTunnel.getActiveReverseTunnelPeerConnectionCount(),
  summarizeDisplayedPeerCounts,
  PEER_COUNT_CACHE_TTL_MS,
  discoveredPeers,
  peerReachabilityCache,
  peerChainTipCache,
  isValidWtcAddress,
  peerAttestationHistory,
  PEER_ATTESTATION_RECIPROCITY_WINDOW_MS,
  reverseTunnelSessions,
  getSharedRoundSnapshot,
  getConfiguredAdvertisedPeerUrls: (...args) => peerNetworking.getConfiguredAdvertisedPeerUrls(...args),
  peerGossipTopology,
});

registerHardwareLoadIpcHandlers(ipcMain, {
  setHardwareLoadPercent,
  hwAuthority,
  setProbeLoadPercent,
  getHardwareLoadState,
  stopHardwareLoad,
  _closeBgProbeWs,
  ensureGpu,
  getGpuInfo,
  getGpuLoadState,
  setGpuLoadPercentFn,
  stopGpuHardwareLoad,
  runGpuPowProbe,
});

// ---------------------------------------------------------------------------
// Power-proof on-chain commitment
// ---------------------------------------------------------------------------
// Before mining each block we broadcast a zero-value OP_RETURN transaction that
// encodes a SHA-256 commitment of the energy+benchmark proof supplied by the
// renderer.  The miner's `generatetoaddress` call then picks up that mempool
// transaction and includes it in the block, making the proof auditable on-chain.
// The commitment is: SHA-256(JSON.stringify(sortedProofFields))  - 32 bytes - 64 hex chars.
// Format on-chain (80-byte OP_RETURN payload limit):
//   WTC1:<32-byte-hex-commitment>  (37 bytes)
// ---------------------------------------------------------------------------
registerMiningIpcHandlers(ipcMain, {
  walletAddressCache,
  enforceEndpointRateLimit,
  enforceReattestationGateForMiner,
  getWtcNode: () => wtcNode,
  hasOnlinePeers: (s) => peerDiscovery.hasOnlinePeers(s),
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  normalizeProbeReceipt,
  hasRecentPeerAttestationRelation: (a, b, ...args) => peerNetworking.hasRecentPeerAttestationRelation(a, b, ...args),
  buildPowerProofCommitment: require('./electron-main/probe-attestation').buildPowerProofCommitment,
  getSharedRoundSnapshot,
  buildRewardMapFromRoundSnapshot: (...args) => roundContributions.buildRewardMapFromRoundSnapshot(...args),
  hwAuthority,
  announceTipToPeers: (...args) => wtcChainSync.announceTipToPeers(...args),
  pushChainToPeers: (...args) => wtcChainSync.pushChainToPeers(...args),
  saleQueue,
  stakingQueue,
});

function getPeerProtocolInfo() {
  const tip = wtcNode && typeof wtcNode.handleGetTip === 'function' ? wtcNode.handleGetTip() : null;
  return {
    networkId: (tip && tip.networkId) || getActiveNetwork(),
    protocolVersion: String((tip && tip.protocolVersion) || 1),
    genesisHash: (tip && tip.genesisHash) || '',
  };
}

function getLocalPeerIdentity() {
  try {
    if (wtcNode && typeof wtcNode.getPeerIdentity === 'function') {
      return String(wtcNode.getPeerIdentity() || '').trim();
    }
    const identity = loadOrCreateDeviceIdentity();
    return String((identity && identity.deviceId) || '').trim();
  } catch (_) {
    return '';
  }
}

function getCurrentNetworkRoundId() {
  try {
    return wtcNode && typeof wtcNode.getHeight === 'function'
      ? Math.max(1, wtcNode.getHeight() + 1)
      : Math.max(1, Number(roundLedger.getCurrentRoundSnapshot().id) || 1);
  } catch (_) {
    return 1;
  }
}

function alignRoundLedgerToChain(roundId = getCurrentNetworkRoundId()) {
  try {
    const prevSnapshot = roundLedger.getCurrentRoundSnapshot();
    const prevRoundId = prevSnapshot.id;
    if (prevRoundId && prevRoundId !== roundId) {
      // Round boundary crossed - archive prior round contributions
      // (saved to state.rounds[] so no data is ever lost).
      roundLedger.archiveCurrentRound();
    }
    const result = roundLedger.beginRound(roundId, 0);
    if (prevRoundId && prevRoundId !== roundId) {
      // Purge witnessed probe receipts from prior round.
      witnessedProbeReceipts.clear();
    }
    return result;
  } catch (_) {
    return roundLedger.getCurrentRoundSnapshot();
  }
}

function getSharedRoundSnapshot() {
  alignRoundLedgerToChain();
  return roundLedger.getCurrentRoundSnapshot();
}

const ledgerRequestHandler = createLedgerRequestHandler({
  getRequesterIdentity: (...args) => ledgerNetwork.getRequesterIdentity(...args),
  isPeerIdentityBanned,
  handleReverseTunnelHttpRequest: reverseTunnel.handleReverseTunnelHttpRequest,
  refreshCoordinatorIdentityKey,
  enforceEndpointRateLimit,
  submitPeerProbeResult,
  getCurrentNetworkRoundId,
  getProbeReceiptSigningPayload,
  attachProbeReceiptSignature,
  recordPeerAttestation: (verifierAddress, workerId) => peerNetworking.recordPeerAttestation(verifierAddress, workerId),
  broadcastProbeReceiptToPeers: (receipt) => roundContributions.broadcastProbeReceiptToPeers(receipt),
  normalizeProbeReceipt,
  _nodeHasGovernanceNfts,
  readTeamData: persistence.readTeamData,
  writeTeamData: persistence.writeTeamData,
  readDocsData: persistence.readDocsData,
  writeDocsData: persistence.writeDocsData,
  isLedgerNetworkAuthorized: (...args) => ledgerNetwork.isLedgerNetworkAuthorized(...args),
  recordPeerIdentityFailure,
  collectOpsSnapshot,
  rememberObservedRequester: (...args) => peerNetworking.rememberObservedRequester(...args),
  maybeRegisterReachableRequester: (...args) => peerNetworking.maybeRegisterReachableRequester(...args),
  buildAdvertisedPeerList: (...args) => peerNetworking.buildAdvertisedPeerList(...args),
  receivePeerGossip: (...args) => wtcChainSync.receivePeerGossip(...args),
  getPrimaryAdvertisedPeerUrl: (...args) => peerNetworking.getPrimaryAdvertisedPeerUrl(...args),
  extractReachablePeerCandidates: (...args) => peerNetworking.extractReachablePeerCandidates(...args),
  rememberDiscoveredPeer: (peerUrl, opts) => peerNetworking.rememberDiscoveredPeer(peerUrl, opts),
  allocatePunchPort,
  buildPunchResponse,
  performPunch,
  buildOpsHealthResponse,
  computeHwAuthSig,
  recordWitnessedSettlement: (...args) => roundContributions.recordWitnessedSettlement(...args),
  verifyChainPeerCompatibility,
  handlePeerTipSignal: (...args) => wtcChainSync.handlePeerTipSignal(...args),
  handleIncomingGossip,
  requestPeerJson,
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  validateContributionProbe: (...args) => roundContributions.validateContributionProbe(...args),
  alignRoundLedgerToChain,
  buildRoundContributionMessage: (msg) => roundContributions.buildRoundContributionMessage(msg),
  isValidWtcAddress,
  opsState,
  getWtcNode: () => wtcNode,
  roundLedger,
  walletAddressCache,
  witnessedProbeReceipts,
  forwardedContributionMessages,
  peerReachabilityCache,
  usedPunchPorts,
  stunNatInfoRef,
  CHAIN_STALL_ALERT_MS,
});
const { startLedgerNetworkServer, stopLedgerNetworkServer } = createLedgerServer({
  http,
  ledgerNetwork,
  ledgerNetworkServerRef,
  ledgerRequestHandler,
  reverseTunnel,
  peerNetworking,
  peerDiscovery,
  wtcChainSync,
  governance,
  peerProbeIpc,
  normalizePeerUrl,
  setupUpnpPortMapping,
  removeUpnpMapping,
  detectNatType,
  NAT_TYPE,
  DEFAULT_STUN_SERVERS,
  autoDetectedPublicPeerUrlRef,
  autoDetectedPublicPeerUrlFromUpnpRef,
  stunNatInfoRef,
  stunDetectionPromiseRef,
  usedPunchPorts,
  peerPunchAttemptTimestamps,
  peerGossipSeen,
});

registerLedgerIpcHandlers({
  ipcMain,
  roundLedger,
  getWtcNode: () => wtcNode,
  hwAuthority,
  walletAddressCache,
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  getCurrentBlockHeight,
  getCurrentNetworkRoundId,
  requestPeerJson,
  enforceEndpointRateLimit,
  settleLocalLedgerRound: (p) => roundContributions.settleLocalLedgerRound(p),
  broadcastRoundContributionToPeers: (p) => roundContributions.broadcastRoundContributionToPeers(p),
  alignRoundLedgerToChain,
  _flushPendingContribution: (i) => roundContributions._flushPendingContribution(i),
  PROBE_INTERVAL_MS,
  ENABLE_POWER_PROOF_COMMITMENT,
  getGpuTdpW,
  getCpuTdpW,
  getAsicPowerW,
  getAsicHashrateTHs,
  getLocalProbeChain,
  getMeasuredCpuDuty,
  getGpuLoadState,
  getSharedRoundSnapshot,
  hasOnlinePeers: (s) => peerDiscovery.hasOnlinePeers(s),
  getLocalLedgerBalances: (a) => roundContributions.getLocalLedgerBalances(a),
  loadBenchmarkHistory,
  _pendingContributionWh: _pendingContributionWhRef,
  _contributionPerSecond: _contributionPerSecondRef,
  _contributionSecondStart: _contributionSecondStartRef,
  _startupRampUp: _startupRampUpRef,
  _startupRampUpStartedAt: _startupRampUpStartedAtRef,
  _cpuDutySamples: _cpuDutySamplesRef,
  _prevRawCpuDuty: _prevRawCpuDutyRef,
  _startupGpuRampUp: _startupGpuRampUpRef,
  _startupGpuRampUpStartedAt: _startupGpuRampUpStartedAtRef,
  _gpuDutySamples: _gpuDutySamplesRef,
  _prevRawGpuDuty: _prevRawGpuDutyRef,
  _physicalCoreCount: _physicalCoreCountRef,
});

// Get WTC balances reconstructed from mined block history for a specific mining address.
registerWalletIpcHandlers({
  ipcMain,
  getWtcNode,
  walletAddressCache,
  enforceEndpointRateLimit,
  https: require('https'),
  getBetaPolicy,
  logAbuseEvent,
  refreshWalletSyncState,
});

registerWalletBackupIpcHandlers({
  getWalletDataDir,
  getDeviceIdentityFilePath,
  getOrCreateWalletEncryptionKey,
  loadOrCreateDeviceIdentity,
  getActivePeers: (s) => peerDiscovery.getActivePeers(s),
  getActiveReverseTunnelPeerConnectionCount: () => reverseTunnel.getActiveReverseTunnelPeerConnectionCount(),
  getPeerDirectoryTargets: (...args) => peerDiscovery.getPeerDirectoryTargets(...args),
  getTrustedPeerTargets: (...args) => peerDiscovery.getTrustedPeerTargets(...args),
  requestPeerJson,
  isSelfPeerUrl: (candidate) => peerNetworking.isSelfPeerUrl(candidate),
  handlePeerTipSignal: (...args) => wtcChainSync.handlePeerTipSignal(...args),
  getLedgerNetworkSettings: (settings) => ledgerNetwork.getLedgerNetworkSettings(settings),
  getLocalTunnelPeerLiveness: (peerUrl) => peerNetworking.getLocalTunnelPeerLiveness(peerUrl),
  roundLedger,
  startGovernanceSync: () => governance.startGovernanceSync(),
  setCoordinatorIdentityKey,
  refreshWalletSyncState,
  stopHardwareLoad,
  createWtcNode,
  setWtcNode: (node) => {
    wtcNode = node;
  },
  setWalletAddressCache: (cache) => {
    if (cache && typeof cache === 'object') {
      walletAddressCache.address = cache.address || '';
      walletAddressCache.at = typeof cache.at === 'number' ? cache.at : 0;
    }
  },
});

registerMainIpcHandlers(ipcMain, {
  getWtcNode: () => wtcNode,
  walletAddressCache,
  setCoordinatorIdentityKey,
  refreshWalletSyncState,
  opsState,
  collectOpsSnapshot,
  loadOrCreateDeviceIdentity,
});

// Force cache and userData to a writable location (user's home directory)
const userDataPath = getWalletDataDir();
app.setPath('userData', userDataPath);
app.setPath('cache', path.join(userDataPath, 'Cache'));

app.setAppPath(__dirname);

// -- Single-instance lock -------------------------------------------------------
// Prevent a second instance from running alongside, which would let an attacker
// double contribution throughput under a different wallet address on the same machine.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another instance is already running - bring its window to front and quit this one.
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance - focus the existing window.
    const wins = require('electron').BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.isDestroyed());
    if (main) {
      if (main.isMinimized()) main.restore();
      main.focus();
    }
  });
}

app.whenReady().then(() => {
  // Clean up stale .tmp.ico files left by Windows icon caching (Electron
  // BrowserWindow icon - %TEMP%\{GUID}.tmp.ico). Remove older than 1 hour.
  try {
    const tmpDir = os.tmpdir();
    const cutoff = Date.now() - 3_600_000;
    for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.tmp.ico')) {
        const p = path.join(tmpDir, entry.name);
        const st = fs.statSync(p);
        if (st.mtimeMs < cutoff || st.birthtimeMs < cutoff) {
          fs.rmSync(p, { force: true });
        }
      }
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] tmp.ico cleanup error:', String(_.message || _).slice(0, 80));
  }

  // Remove default File, Edit, View, Window menus.
  Menu.setApplicationMenu(null);

  // Query physical CPU core count so hardware-load workers are limited to physical
  // cores only.  On HT CPUs (2 logical per physical) spawning workers on all logical
  // cores doubles the duty-cycle pressure on each physical core, causing actual power
  // draw that is ~2- the intended %.  One worker per physical core makes N% duty = N% TDP.
  si.cpu()
    .then((cpu) => {
      try {
        const logical = Math.max(1, os.cpus().length || 1);
        let physical = Math.max(0, Number(cpu && cpu.physicalCores) || 0);
        // Some Windows/laptop environments occasionally report physicalCores=1
        // despite multiple logical cores. That under-provisions workers and can make
        // a 20% target look like ~0-1% total system load. Use HT-style fallback.
        if (logical >= 4 && physical === 1) {
          physical = Math.max(1, Math.floor(logical / 2));
        }
        if (physical <= 0) {
          physical = logical;
        }
        configurePhysicalCores(physical);
        _physicalCoreCountRef.current = physical;
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    })
    .catch(() => {}); // best-effort; controller falls back to logical core count

  // Ensure device identity is available before loading attestation state (the
  // fallback encryption layer relies on the device-identity secret).
  try {
    loadOrCreateDeviceIdentity();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  // Load and decrypt attestation state now that safeStorage is available.
  // Re-save immediately to migrate any legacy plaintext secret to encrypted form.
  attestationStateRef.current = loadAttestationStateFromModule();
  saveAttestationStateFromModule();

  // Load the round ledger from disk (requires the attestation secret for HMAC).
  roundLedger.load();

  loadRateLocks();
  loadConsumedProofsFromModule();
  loadHwAuthState();
  peerNetworking.loadDiscoveredSeedPeerCache();
  // Restore rolling jitter mean from persistent benchmark history so the attestation
  // threshold is correct immediately after restart (before the first benchmark run).
  try {
    const _hist = loadBenchmarkHistory();
    if (_hist.jitterSamples.length >= 2) {
      hwAuthority.rollingJitterMean = _hist.jitterSamples.reduce((a, b) => a + b, 0) / _hist.jitterSamples.length;
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  setupRpcCredentials({
    getRuntimeConfig,
    normalizePeerUrl,
  });

  try {
    persistDevPeerPrivacyRecoveryKey(getDeviceIdentitySecret, loadOrCreateDeviceIdentity);
  } catch (e) {
    console.warn('[PeerPrivacy] Failed to write dev recovery key:', e && e.message ? e.message : e);
  }

  ensureCanonicalGenesis({ getWalletDataDir });

  // -- WTC native chain node -------------------------------------------------
  try {
    const wtcSecret = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(getDeviceIdentityFilePath(), 'utf8'));
        return raw && raw.secret ? raw.secret : '';
      } catch (_) {
        return '';
      }
    })();
    wtcNode = createWtcNode({
      dataDir: getWalletDataDir(),
      signingSecret: wtcSecret || crypto.randomBytes(32).toString('hex'),
      peerIdentity: String(loadOrCreateDeviceIdentity().deviceId || '').trim(),
      walletKey: getOrCreateWalletEncryptionKey(),
      getActivePeers: () => peerDiscovery.getActivePeers(ledgerNetwork.getLedgerNetworkSettings()),
      getConnectedPeerCount: () => reverseTunnel.getActiveReverseTunnelPeerConnectionCount(),
      getPeerTargets: () => peerDiscovery.getPeerDirectoryTargets(ledgerNetwork.getLedgerNetworkSettings()),
      getTrustedPeerTargets: () => peerDiscovery.getTrustedPeerTargets(ledgerNetwork.getLedgerNetworkSettings()),
      requestPeerJson,
      isSelfPeerUrl: (candidate) => peerNetworking.isSelfPeerUrl(candidate),
      onPeerTip: (peerUrl, tip) => wtcChainSync.handlePeerTipSignal(peerUrl, tip, 'tip-probe'),
      allowPartialQuorumCommit: !(
        ledgerNetwork.getLedgerNetworkSettings().enabled && ledgerNetwork.getLedgerNetworkSettings().mode === 'peer'
      ),
      isLiveLocalTunnelPeer: (peerUrl) => peerNetworking.getLocalTunnelPeerLiveness(peerUrl),
      getEnergyContributions: () => roundLedger.getCurrentRoundSnapshot().contributionsWh,
    });
    governance.startGovernanceSync();
    refreshCoordinatorIdentityKey();
  } catch (e) {
    console.error('[WtcNode] Failed to initialize:', e && e.message ? e.message : e);
  }

  const runtime = getRuntimeConfig();
  startupTrace.setEnabled(runtime.enableStartupTraceLogging !== false);
  const _startupTraceWindowMs = Math.max(10_000, Number(runtime.startupTraceWindowMs) || 180_000);
  startupTrace.setWindowMs(_startupTraceWindowMs);
  startupTrace.beginStartupTrace('app.ready');
  startupTrace.writeStartupTrace('app.ready', {
    autoLaunchNode: !!runtime.autoLaunchNode,
    autoLaunchNodeDelayMs: Math.max(0, Number(runtime.autoLaunchNodeDelayMs) || 0),
    startupTraceWindowMs: _startupTraceWindowMs,
  });

  // Verify bundled binary integrity before starting the node daemon.
  // If the manifest exists and any hash mismatches, show an error and refuse to start.
  const debugFrictionResult = integrityVerifier.verifyReleaseDebuggerFriction();
  if (!debugFrictionResult.ok) {
    dialog.showErrorBox(
      'Wattcoin Miner - Debugger Blocked',
      `Debugger launch flags were detected in this release build.\n\n${(debugFrictionResult.reasons || []).join('\n')}\n\nTo run with debugger for support, set WATTCOIN_ALLOW_DEBUGGER=1.`,
    );
    app.quit();
    return;
  }

  const appIntegrityResult = integrityVerifier.verifyAppIntegrityManifest();
  if (!appIntegrityResult.ok) {
    const failedList = (appIntegrityResult.failures || []).map((f) => `  - ${f.rel} (${f.reason})`).join('\n');
    dialog.showErrorBox(
      'Wattcoin Miner - Integrity Check Failed',
      `One or more application modules have been modified or are missing.\n\n${failedList}\n\nThe application cannot start safely. Please reinstall Wattcoin Miner.`,
    );
    app.quit();
    return;
  }

  const binaryIntegrityResult = integrityVerifier.verifyBinaryManifest();
  if (!binaryIntegrityResult.ok) {
    const failedList = (binaryIntegrityResult.failures || []).map((f) => `  \u2022 ${f.rel} (${f.reason})`).join('\n');
    dialog.showErrorBox(
      'Wattcoin Miner \u2014 Integrity Check Failed',
      `One or more bundled binaries have been modified or are missing.\n\n${failedList}\n\nThe application cannot start safely. Please reinstall Wattcoin Miner.`,
    );
    app.quit();
    return;
  }

  // Load signed remote profile policy feed (with local fallback) and keep it fresh.
  if (ENABLE_NODE_ATTESTATION) {
    ensurePolicyFeedRefreshLoop();
  }
  ledgerNetwork.startLedgerReconcileLoop();
  startLedgerNetworkServer();
  // Start the WebSocket push-probe client after wallet address is available.
  _connectBgProbeWs();
  wtcChainSync.startWtcPeerSyncLoop();
  startGossipBroadcastLoop();
  startWalletSyncStateLoop();
  startOpsMetricsLoop();

  // Pull current round contributions from peers so a fresh install
  // recovers mid-round contributions that were broadcast before data loss.
  // Also re-pull periodically to pick up contributions from newly-connected peers
  // that were not available at startup or whose broadcasts did not reach us.
  setTimeout(async () => {
    try {
      await roundContributions.pullContributionsFromPeers();
      if (roundLedger.isTampered && roundLedger.isTampered()) {
        roundLedger.clearTamperedFlag();
        console.warn('[RoundLedger] Tampered flag cleared - peer data restored.');
      }
    } catch (_) {
      /* retry on next interval */
    }
  }, 10000);
  setInterval(async () => {
    try {
      await roundContributions.pullContributionsFromPeers();
      if (roundLedger.isTampered && roundLedger.isTampered()) {
        roundLedger.clearTamperedFlag();
        console.warn('[RoundLedger] Tampered flag cleared - peer data restored.');
      }
    } catch (_) {
      /* retry */
    }
  }, 60000);

  initQueues({ getWtcNode: () => wtcNode, saleQueue, stakingQueue, getDataDir });

  // Detect --updated flag from installer (NSIS passes it after a successful update).
  // The renderer uses this to re-verify firewall rules - the installer may have
  // added the rule while the old process was shutting down.
  global._appWasUpdated = process.argv.includes('--updated');
  createWindow(); // Open window immediately; UI handles "node connecting" state
});

app.on('window-all-closed', () => {
  if (updateInstallInProgressRef.value) {
    // quitAndInstall handles shutdown - don't call app.quit() here
    return;
  }

  // Stop the node before quitting
  ledgerNetwork.stopLedgerReconcileLoop();
  wtcChainSync.stopWtcPeerSyncLoop();
  stopGossipBroadcastLoop();
  stopWalletSyncStateLoop();
  stopOpsMetricsLoop();
  stopLedgerNetworkServer();
  try {
    stopHardwareLoad();
  } catch (e) {
    console.error('Failed to stop hardware load controller:', e);
  }
  try {
    _closeBgProbeWs();
  } catch (e) {
    console.error('Failed to close probe WebSocket:', e);
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

initUpdater({ app, autoUpdater, BrowserWindow, ipcMain, updateInstallInProgressRef });

// Clean up native GPU process on exit
process.on('exit', () => {
  try {
    shutdownGpu();
  } catch (_) {
    return undefined;
  }
});
app.on('before-quit', () => {
  try {
    shutdownGpu();
  } catch (_) {
    return undefined;
  }
  try {
    stopAllStrata();
  } catch (_) {
    return undefined;
  }
});
