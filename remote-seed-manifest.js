'use strict';

function createRemoteSeedManifestManager({
  fs,
  getRuntimeConfig,
  getCachePath,
  normalizePeerUrl,
  isDeprecatedPeerUrl,
  requestExternalResponse,
  fetchTimeoutMs,
  defaultRemoteSeedManifestUrls = [],
  schedulePeerSync = () => {},
  logger = console,
}) {
  let remoteSeedPeersCache = null;
  let remoteSeedPeerRefreshPromise = null;
  const remoteSeedManifestFailureState = new Map();

  function getRemoteSeedManifestUrls() {
    const runtime = getRuntimeConfig();
    const configuredUrls = Array.isArray(runtime && runtime.ledgerSeedManifestUrls)
      ? runtime.ledgerSeedManifestUrls
      : [];
    const urls = configuredUrls.length > 0 ? configuredUrls : defaultRemoteSeedManifestUrls;
    return Array.from(new Set(
      urls
        .map((entry) => String(entry || '').trim())
        .filter((entry) => /^https?:\/\//i.test(entry))
    ));
  }

  function loadCachedRemoteSeedPeers() {
    if (remoteSeedPeersCache) return remoteSeedPeersCache;
    try {
      const parsed = JSON.parse(fs.readFileSync(getCachePath(), 'utf8'));
      const peers = Array.isArray(parsed && parsed.peers)
        ? parsed.peers.map((peer) => normalizePeerUrl(peer)).filter((peer) => peer && !isDeprecatedPeerUrl(peer))
        : [];
      remoteSeedPeersCache = Array.from(new Set(peers));
      return remoteSeedPeersCache;
    } catch (_) {
      remoteSeedPeersCache = [];
      return remoteSeedPeersCache;
    }
  }

  function saveCachedRemoteSeedPeers(peers) {
    try {
      const serializedPeers = Array.from(new Set(
        (peers || [])
          .map((peer) => normalizePeerUrl(peer))
          .filter((peer) => peer && !isDeprecatedPeerUrl(peer))
      ));
      fs.mkdirSync(require('path').dirname(getCachePath()), { recursive: true });
      fs.writeFileSync(
        getCachePath(),
        JSON.stringify({
          peers: serializedPeers,
          savedAtMs: Date.now(),
        }, null, 2),
        'utf8'
      );
    } catch (_) {
      // Best-effort cache persistence only.
    }
  }

  async function fetchRemoteSeedManifest(url) {
    const response = await requestExternalResponse(url, fetchTimeoutMs);
    if (Number(response && response.statusCode) !== 200) {
      throw new Error(`HTTP ${Number(response && response.statusCode) || 0}`);
    }
    const body = String(response && response.body || '').trim();
    if (!body.startsWith('{') && !body.startsWith('[')) {
      throw new Error(`Remote seed manifest did not return JSON (content-type: ${String(response && response.contentType || 'unknown')}).`);
    }
    const parsed = JSON.parse(body);
    const peerEntries = Array.isArray(parsed && parsed.seedPeers)
      ? parsed.seedPeers
      : (Array.isArray(parsed && parsed.peers) ? parsed.peers : []);
    return peerEntries
      .map((peer) => normalizePeerUrl((peer && peer.url) || peer || ''))
      .filter((peer) => peer && !isDeprecatedPeerUrl(peer));
  }

  async function refreshRemoteSeedPeers(settings, { force = false } = {}) {
    if (remoteSeedPeerRefreshPromise && !force) return remoteSeedPeerRefreshPromise;
    const runtime = getRuntimeConfig();
    if (!settings || runtime.network !== 'wtc-mainnet') return loadCachedRemoteSeedPeers();

    remoteSeedPeerRefreshPromise = (async () => {
      const urls = getRemoteSeedManifestUrls();
      if (urls.length === 0) return loadCachedRemoteSeedPeers();

      for (const url of urls) {
        try {
          const peers = await fetchRemoteSeedManifest(url);
          if (peers.length === 0) continue;
          const nextPeers = Array.from(new Set(peers));
          const previousPeers = loadCachedRemoteSeedPeers();
          remoteSeedPeersCache = nextPeers;
          saveCachedRemoteSeedPeers(nextPeers);
          if (remoteSeedManifestFailureState.has(url)) {
            logger.log(`[Bootstrap] Remote seed manifest recovered for ${url}`);
            remoteSeedManifestFailureState.delete(url);
          }
          if (JSON.stringify(previousPeers) !== JSON.stringify(nextPeers)) {
            logger.log(`[Bootstrap] Refreshed ${nextPeers.length} remote seed peer(s) from ${url}`);
            schedulePeerSync('remote-seed-manifest-updated', 150);
          }
          return remoteSeedPeersCache;
        } catch (error) {
          const reason = error && error.message ? error.message : String(error);
          const previousReason = remoteSeedManifestFailureState.get(url) || '';
          if (previousReason !== reason) {
            logger.warn(`[Bootstrap] Remote seed manifest fetch failed for ${url}:`, reason);
            remoteSeedManifestFailureState.set(url, reason);
          }
        }
      }

      return loadCachedRemoteSeedPeers();
    })().finally(() => {
      remoteSeedPeerRefreshPromise = null;
    });

    return remoteSeedPeerRefreshPromise;
  }

  function buildEffectiveSeedPeers({ network = 'wtc-mainnet', bootstrapPeers = [], bundledSeedPeers = [], cachedRemoteSeedPeers = [] } = {}) {
    const peers = network === 'wtc-mainnet'
      ? [...bootstrapPeers, ...bundledSeedPeers, ...cachedRemoteSeedPeers]
      : [...bootstrapPeers];
    return Array.from(new Set(
      peers.map((peer) => normalizePeerUrl(peer)).filter((peer) => peer && !isDeprecatedPeerUrl(peer))
    ));
  }

  return {
    getRemoteSeedManifestUrls,
    loadCachedRemoteSeedPeers,
    saveCachedRemoteSeedPeers,
    fetchRemoteSeedManifest,
    refreshRemoteSeedPeers,
    buildEffectiveSeedPeers,
    getFailureState: () => new Map(remoteSeedManifestFailureState),
  };
}

module.exports = {
  createRemoteSeedManifestManager,
};