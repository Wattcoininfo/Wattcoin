'use strict';

const path = require('path');
const fs = require('fs');
const { normalizePeerUrl, isDeprecatedPeerUrl } = require('./main-utils');
const peerUtils = require('./peer-utils');
const { checkLedgerNetworkAuth } = require('../ops-health');

/**
 * Factory that creates the ledger-network module.
 * Dependencies that live in electron-main.js are passed via `ctx`.
 */
function createLedgerNetwork(ctx) {
  const {
    getRuntimeConfig,
    getConfiguredAdvertisedPeerUrls,
    roundLedger,
    getCurrentBlockHeight,
    LEDGER_RECONCILE_INTERVAL_MS,
    loadCachedRemoteSeedPeers,
  } = ctx;

  let ledgerReconcileTimer = null;
  let bundledSeedPeersCache = null;

  // -- Bundled seed peers ----------------------------------------------------

  function getBundledSeedPeerCandidates() {
    const BUNDLED_SEED_PEER_FILE_NAMES = [
      'seed-peers.json',
      'bootstrap-peers.json',
      'ledger-bootstrap-peers.json',
      'peers.json',
    ];
    const candidates = [];
    for (const fileName of BUNDLED_SEED_PEER_FILE_NAMES) {
      if (process.resourcesPath) {
        candidates.push(path.join(process.resourcesPath, fileName));
      }
      candidates.push(path.join(__dirname, 'docs', fileName), path.join(__dirname, 'resources', fileName));
    }
    return Array.from(new Set(candidates));
  }

  function loadBundledSeedPeers() {
    if (bundledSeedPeersCache) return bundledSeedPeersCache;

    for (const candidate of getBundledSeedPeerCandidates()) {
      try {
        if (!candidate || !fs.existsSync(candidate)) continue;
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        const peerEntries = Array.isArray(parsed && parsed.seedPeers)
          ? parsed.seedPeers
          : Array.isArray(parsed && parsed.peers)
            ? parsed.peers
            : [];
        const peers = peerEntries
          .map((peer) => {
            const rawUrl = (peer && peer.url) || peer || '';
            if (peer && peer.ipB64 && typeof peer.ipB64 === 'string') {
              try {
                const decoded = Buffer.from(peer.ipB64, 'base64').toString('utf8').trim();
                if (decoded) return normalizePeerUrl(`http://${decoded}`);
              } catch (err) {
                console.warn('[HW-Identity] si.system() failed:', String(err?.message || err).slice(0, 200));
              }
            }
            return normalizePeerUrl(rawUrl);
          })
          .filter((peer) => peer && !isDeprecatedPeerUrl(peer));
        bundledSeedPeersCache = peers;
        console.log(`[Bootstrap] Loaded ${peers.length} bundled peers from ${candidate}`);
        return bundledSeedPeersCache;
      } catch (err) {
        console.warn('[Bootstrap] Failed to load bundled peers:', err && err.message ? err.message : err);
      }
    }

    bundledSeedPeersCache = [];
    return bundledSeedPeersCache;
  }

  // -- Settings --------------------------------------------------------------

  function getLedgerNetworkSettings() {
    const runtime = getRuntimeConfig();
    const mode = String(runtime.ledgerNetworkMode || 'standalone')
      .trim()
      .toLowerCase();
    const bootstrapPeers = Array.isArray(runtime.ledgerPeers) ? runtime.ledgerPeers.filter(Boolean) : [];
    const seedPeers =
      runtime.network === 'wtc-mainnet'
        ? [...bootstrapPeers, ...loadBundledSeedPeers(), ...ctx.loadCachedRemoteSeedPeers()]
        : [...bootstrapPeers];
    const normalizedConfiguredPeers = Array.from(
      new Set(bootstrapPeers.map(normalizePeerUrl).filter((peer) => peer && !isDeprecatedPeerUrl(peer))),
    );
    const normalizedSeedPeers = Array.from(
      new Set(seedPeers.map(normalizePeerUrl).filter((peer) => peer && !isDeprecatedPeerUrl(peer))),
    );
    const normalizedAdvertiseUrls = Array.from(
      new Set(
        (Array.isArray(runtime.ledgerNetworkAdvertiseUrls) ? runtime.ledgerNetworkAdvertiseUrls : [])
          .map(normalizePeerUrl)
          .filter(Boolean),
      ),
    );
    return {
      enabled: Boolean(runtime.ledgerNetworkEnabled),
      mode,
      configuredPeers: normalizedConfiguredPeers,
      seedPeers: normalizedSeedPeers,
      peers: normalizedConfiguredPeers,
      coordinatorUrl: normalizePeerUrl(runtime.ledgerCoordinatorUrl),
      authToken: String(runtime.ledgerNetworkAuthToken || '').trim(),
      listenHost: String(runtime.ledgerNetworkListenHost || '0.0.0.0').trim() || '0.0.0.0',
      listenPort: Math.max(1, Number(runtime.ledgerNetworkListenPort) || 39310),
      requestTimeoutMs: Math.max(1000, Number(runtime.ledgerNetworkRequestTimeoutMs) || 15000),
      publicUrl: normalizePeerUrl(runtime.ledgerNetworkPublicUrl),
      tunnelPublicUrl: normalizePeerUrl(runtime.ledgerNetworkTunnelPublicUrl),
      advertiseUrls: normalizedAdvertiseUrls,
    };
  }

  // -- Listen URLs -----------------------------------------------------------

  function getLedgerListenUrls(settings) {
    const explicitUrls = getConfiguredAdvertisedPeerUrls(settings);
    if (explicitUrls.length > 0) {
      return explicitUrls;
    }

    const { networkInterfaces } = require('os');
    const ifaces = networkInterfaces();
    const addresses = Object.values(ifaces)
      .flat()
      .filter((info) => info && info.family === 'IPv4' && !info.internal)
      .map((info) => `http://${info.address}:${settings.listenPort}`);

    if (addresses.length === 0) {
      addresses.push(`http://127.0.0.1:${settings.listenPort}`);
    }

    return Array.from(new Set(addresses.map(normalizePeerUrl).filter(Boolean)));
  }

  // -- Authorization ---------------------------------------------------------

  function isLedgerNetworkAuthorized(req, settings) {
    const supplied = String(req.headers['x-wattcoin-ledger-token'] || '').trim();
    if (!supplied) return false;
    const requiredToken = String(settings && settings.authToken ? settings.authToken : '').trim();
    if (!requiredToken) {
      console.error('[Auth] SECURITY: authToken not configured - rejecting all peer requests.');
      return false;
    }
    return checkLedgerNetworkAuth(supplied, requiredToken);
  }

  function getTrustedRequesterPeerIdentity(req, settings) {
    const declaredPeerIdentity = String(req && req.headers ? req.headers['x-wtc-peer-identity'] || '' : '').trim();
    if (!peerUtils.isValidPeerIdentity(declaredPeerIdentity)) return '';
    if (peerUtils.isReverseTunnelForwardedRequest(req)) return declaredPeerIdentity;
    if (isLedgerNetworkAuthorized(req, settings)) return declaredPeerIdentity;
    return '';
  }

  function getRequesterIdentity(req, settings) {
    const trustedPeerIdentity = getTrustedRequesterPeerIdentity(req, settings);
    if (trustedPeerIdentity) {
      return trustedPeerIdentity;
    }
    return String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'remote-client');
  }

  // -- Reconcile loop --------------------------------------------------------

  function startLedgerReconcileLoop() {
    if (ledgerReconcileTimer) return;
    ledgerReconcileTimer = setInterval(async () => {
      try {
        const blockHeight = await getCurrentBlockHeight();
        roundLedger.syncMaturity(blockHeight);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }, LEDGER_RECONCILE_INTERVAL_MS);
  }

  function stopLedgerReconcileLoop() {
    if (!ledgerReconcileTimer) return;
    clearInterval(ledgerReconcileTimer);
    ledgerReconcileTimer = null;
  }

  return {
    getLedgerNetworkSettings,
    getLedgerListenUrls,
    isLedgerNetworkAuthorized,
    getTrustedRequesterPeerIdentity,
    getRequesterIdentity,
    startLedgerReconcileLoop,
    stopLedgerReconcileLoop,
  };
}

module.exports = { createLedgerNetwork };
