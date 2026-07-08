'use strict';

const { normalizePeerUrl, isDeprecatedPeerUrl } = require('./main-utils');
const peerUtils = require('./peer-utils');

function createPeerNetworking(ctx) {
  const {
    // Shared Maps (by reference)
    discoveredPeers,
    peerReachabilityCache,
    peerChainTipCache,
    peerChainTipInflight,
    peerUrlFailures,
    peerAttestationHistory,
    bootstrapPeerAddresses,

    // External state refs (read-only)
    reverseTunnelSessions,
    reverseTunnelClientState,

    // Scalar/timer refs
    autoDetectedPublicPeerUrlRef,
    autoDetectedPublicPeerUrlFromUpnpRef,
    autoDetectedPublicPeerLookupPromiseRef,
    remoteSeedPeerRefreshTimerRef,
    autoPublicPeerRefreshTimerRef,
    seedRegistryHeartbeatTimerRef,

    // Config constants
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

    // External functions
    getRuntimeConfig,
    getLedgerNetworkSettings,
    getActivePeers,
    getLocalPeerHosts,
    getLocalPeerIdentity,
    getTrustedRequesterPeerIdentity,
    requestPeerJson,
    isSelfPeerUrlCandidate,
    filterAdvertisedPeerUrls,
    sortPeerUrlsByPreference,
    normalizeIpLiteral,
    isPublicPeerHost,
    formatPeerHostForUrl,
    isPeerUrlBanned,
    isReverseTunnelPeerUrl,
    buildPeerUrlFromSocket,
    selectPreferredPeerUrl,
    recordPeerUrlSuccess,
    gossipAnnounce,
    scheduleWtcPeerSync,
    extractTunnelIdFromUrl,
    maybeRegisterReachableRequesterHelper,
    scheduleDiscoveredSeedPeerCacheSave,
    loadDiscoveredSeedPeerCache,
    remoteSeedManifestManager,
    obfuscatePublicPeerUrl,
    getWtcNode,
  } = ctx;

  // -- Remote seed manifest wrappers ----------------------------------------

  function _getRemoteSeedManifestUrls(settings) {
    return remoteSeedManifestManager.getRemoteSeedManifestUrls(settings);
  }

  function loadCachedRemoteSeedPeers() {
    return remoteSeedManifestManager.loadCachedRemoteSeedPeers();
  }

  function _saveCachedRemoteSeedPeers(peers) {
    return remoteSeedManifestManager.saveCachedRemoteSeedPeers(peers);
  }

  function _fetchRemoteSeedManifest(url) {
    return remoteSeedManifestManager.fetchRemoteSeedManifest(url);
  }

  function refreshRemoteSeedPeers(settings, { force = false } = {}) {
    return remoteSeedManifestManager.refreshRemoteSeedPeers(settings, { force });
  }

  function startRemoteSeedPeerRefresh(settings) {
    stopRemoteSeedPeerRefresh();
    if (!settings || getRuntimeConfig().network !== 'wtc-mainnet') return;
    refreshRemoteSeedPeers(getLedgerNetworkSettings(), { force: true }).catch(() => {});
    remoteSeedPeerRefreshTimerRef.current = setInterval(() => {
      refreshRemoteSeedPeers(getLedgerNetworkSettings(), { force: true }).catch(() => {});
    }, REMOTE_SEED_MANIFEST_REFRESH_INTERVAL_MS);
  }

  function stopRemoteSeedPeerRefresh() {
    if (!remoteSeedPeerRefreshTimerRef.current) return;
    clearInterval(remoteSeedPeerRefreshTimerRef.current);
    remoteSeedPeerRefreshTimerRef.current = null;
  }

  // -- Auto public peer URL -------------------------------------------------

  function detectAutoPublicPeerUrl(settings, { force = false } = {}) {
    if (!settings || !settings.enabled || settings.mode !== 'peer') {
      autoDetectedPublicPeerUrlRef.current = '';
      return '';
    }
    if (peerUtils.getExplicitAdvertisedPeerUrls(settings).length > 0) {
      autoDetectedPublicPeerUrlRef.current = '';
      return '';
    }
    if (autoDetectedPublicPeerUrlFromUpnpRef.current && autoDetectedPublicPeerUrlRef.current) {
      return autoDetectedPublicPeerUrlRef.current;
    }
    if (!force && autoDetectedPublicPeerUrlRef.current) {
      try {
        const cached = new URL(autoDetectedPublicPeerUrlRef.current);
        if (Number(cached.port) === Number(settings.listenPort)) return autoDetectedPublicPeerUrlRef.current;
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      autoDetectedPublicPeerUrlRef.current = '';
    }
    if (autoDetectedPublicPeerLookupPromiseRef.current) return autoDetectedPublicPeerLookupPromiseRef.current;

    const previousUrl = autoDetectedPublicPeerUrlRef.current;

    autoDetectedPublicPeerLookupPromiseRef.current = (async () => {
      for (const serviceUrl of AUTO_PUBLIC_IP_SERVICES) {
        try {
          const ipText = normalizeIpLiteral(await peerUtils.requestExternalText(serviceUrl));
          if (!isPublicPeerHost(ipText)) continue;
          const host = formatPeerHostForUrl(ipText);
          const peerUrl = normalizePeerUrl(`http://${host}:${settings.listenPort}`);
          if (!peerUrl) continue;
          autoDetectedPublicPeerUrlRef.current = peerUrl;
          return peerUrl;
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
      }
      return previousUrl || '';
    })().finally(() => {
      autoDetectedPublicPeerLookupPromiseRef.current = null;
    });

    return autoDetectedPublicPeerLookupPromiseRef.current;
  }

  async function refreshAutoPublicPeerUrl(settings) {
    if (!settings || !settings.enabled || settings.mode !== 'peer') return '';
    const previousUrl = autoDetectedPublicPeerUrlRef.current;
    const nextUrl = await detectAutoPublicPeerUrl(settings, { force: true });
    if (nextUrl && nextUrl !== previousUrl) {
      console.log(`[Wattcoin] Auto-detected public peer URL changed: ${nextUrl}`);
    }
    return nextUrl;
  }

  // -- Seed registry heartbeat ----------------------------------------------

  function sendSeedRegistryHeartbeat() {
    const runtime = getRuntimeConfig();
    if (!runtime.seedRegistryHeartbeatEnabled) return;
    let peerUrl = autoDetectedPublicPeerUrlRef.current || '';
    if (!peerUrl) {
      const settings = getLedgerNetworkSettings();
      if (settings.publicUrl) {
        peerUrl = normalizePeerUrl(settings.publicUrl);
      }
      if (!peerUrl) return;
    }
    const manifestUrls = _getRemoteSeedManifestUrls();
    for (const registryUrl of manifestUrls) {
      requestPeerJson(registryUrl, 'POST', '/', { url: peerUrl }, undefined, {
        timeoutMs: 8000,
        suppressPeerDiscovery: true,
        trackReachability: false,
      }).catch(() => {});
    }
  }

  function startAutoPublicPeerUrlRefresh(settings) {
    stopAutoPublicPeerUrlRefresh();
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    if (peerUtils.getExplicitAdvertisedPeerUrls(settings).length > 0) return;
    autoPublicPeerRefreshTimerRef.current = setInterval(() => {
      refreshAutoPublicPeerUrl(getLedgerNetworkSettings())
        .then(() => sendSeedRegistryHeartbeat())
        .catch(() => {});
    }, AUTO_PUBLIC_IP_REFRESH_INTERVAL_MS);
  }

  function stopAutoPublicPeerUrlRefresh() {
    if (!autoPublicPeerRefreshTimerRef.current) return;
    clearInterval(autoPublicPeerRefreshTimerRef.current);
    autoPublicPeerRefreshTimerRef.current = null;
  }

  function startSeedRegistryHeartbeat(settings) {
    stopSeedRegistryHeartbeat();
    const runtime = getRuntimeConfig();
    if (!runtime.seedRegistryHeartbeatEnabled) return;
    if (!settings || !settings.enabled) return;
    sendSeedRegistryHeartbeat();
    seedRegistryHeartbeatTimerRef.current = setInterval(() => {
      sendSeedRegistryHeartbeat();
    }, SEED_REGISTRY_HEARTBEAT_INTERVAL_MS);
    console.log(
      `[Wattcoin] Seed registry heartbeat started (every ${Math.round(SEED_REGISTRY_HEARTBEAT_INTERVAL_MS / 60000)} min)`,
    );
  }

  function stopSeedRegistryHeartbeat() {
    if (!seedRegistryHeartbeatTimerRef.current) return;
    clearInterval(seedRegistryHeartbeatTimerRef.current);
    seedRegistryHeartbeatTimerRef.current = null;
  }

  // -- Self-peer URL helpers -------------------------------------------------

  function isSelfPeerUrl(candidate) {
    const normalized = normalizePeerUrl(candidate);
    if (!normalized) return false;
    try {
      const settings = getLedgerNetworkSettings();
      const selfAdvertisedUrls = getConfiguredAdvertisedPeerUrls(settings);
      return isSelfPeerUrlCandidate(normalized, {
        selfAdvertisedUrls,
        listenPort: settings.listenPort,
        localHosts: Array.from(getLocalPeerHosts()),
      });
    } catch (_) {
      return false;
    }
  }

  function isPeerIdentitySelfReference(peerIdentity, peerUrl) {
    const normalizedIdentity = String(peerIdentity || '').trim();
    const localPeerIdentity = getLocalPeerIdentity();
    if (!normalizedIdentity || !localPeerIdentity || normalizedIdentity !== localPeerIdentity) {
      return false;
    }
    return isSelfPeerUrl(peerUrl);
  }

  function isLocallyServedReverseTunnelPeerUrl(candidate, settings) {
    const normalized = normalizePeerUrl(candidate);
    if (!normalized || !isReverseTunnelPeerUrl(normalized)) return false;
    try {
      const parsed = new URL(normalized);
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
      if (port !== Number(settings && settings.listenPort)) return false;
      const segments = String(parsed.pathname || '')
        .split('/')
        .filter(Boolean);
      const tunnelId = segments.length >= 4 ? String(segments[3] || '').trim() : '';
      if (!tunnelId) return false;
      const session = reverseTunnelSessions.get(tunnelId);
      if (!session || !session.publicUrl) return false;
      return normalizePeerUrl(session.publicUrl) === normalized;
    } catch (_) {
      return false;
    }
  }

  function resolvePeerRequestBaseUrl(baseUrl, settings) {
    try {
      const normalized = normalizePeerUrl(baseUrl && baseUrl.href ? baseUrl.href : baseUrl);
      if (!normalized || !isLocallyServedReverseTunnelPeerUrl(normalized, settings)) {
        return baseUrl;
      }
      const localBase = new URL(normalized);
      localBase.protocol = 'http:';
      localBase.hostname = '127.0.0.1';
      localBase.port = String(Math.max(1, Number(settings && settings.listenPort) || 0));
      return localBase;
    } catch (_) {
      return baseUrl;
    }
  }

  function getConfiguredAdvertisedPeerUrls(settings) {
    const candidates = [
      reverseTunnelClientState.publicUrl,
      settings && settings.tunnelPublicUrl,
      settings && settings.publicUrl,
      autoDetectedPublicPeerUrlRef.current,
      ...((settings && settings.advertiseUrls) || []),
    ];
    return filterAdvertisedPeerUrls(candidates);
  }

  function getPrimaryAdvertisedPeerUrl(settings) {
    const urls = getConfiguredAdvertisedPeerUrls(settings);
    return urls.length > 0 ? urls[0] : '';
  }

  function buildPeerAnnouncementHeaders(settings) {
    const advertisedUrls = getConfiguredAdvertisedPeerUrls(settings);
    return {
      'x-wtc-peer-port': String(Math.max(1, Number(settings && settings.listenPort) || 39310)),
      'x-wtc-peer-urls': advertisedUrls.join(','),
    };
  }

  // -- Peer discovery core ---------------------------------------------------

  function extractReachablePeerCandidates(req, settings) {
    const announcedUrls = String(req.headers['x-wtc-peer-urls'] || '')
      .split(',')
      .map((entry) => normalizePeerUrl(entry))
      .filter(Boolean);
    const declaredPort = Math.max(
      1,
      Number(req.headers['x-wtc-peer-port']) || Number(settings && settings.listenPort) || 0,
    );
    const inferredSocketUrl =
      announcedUrls.length > 0 ? null : buildPeerUrlFromSocket(req.socket && req.socket.remoteAddress, declaredPort);
    return sortPeerUrlsByPreference(
      [...announcedUrls, ...(inferredSocketUrl ? [inferredSocketUrl] : [])].filter(
        (candidate) => candidate && !isSelfPeerUrl(candidate),
      ),
    );
  }

  function shouldAttemptPeerReachability(candidate, nowMs) {
    if (nowMs === undefined) nowMs = Date.now();
    const normalized = normalizePeerUrl(candidate);
    if (!normalized || isPeerUrlBanned(normalized) || isSelfPeerUrl(normalized)) return false;
    const cached = peerReachabilityCache.get(normalized);
    if (!cached) return true;
    if (cached.ok && nowMs - Number(cached.lastSuccessAtMs || 0) < PEER_REACHABILITY_SUCCESS_TTL_MS) return false;
    return nowMs - Number(cached.lastAttemptAtMs || 0) >= PEER_REACHABILITY_RETRY_MS;
  }

  function rememberDiscoveredPeer(
    peerUrl,
    { source = 'peer-exchange', seenAtMs = Date.now(), quiet = false, peerIdentity = '' } = {},
  ) {
    const normalized = normalizePeerUrl(peerUrl);
    if (!normalized || isDeprecatedPeerUrl(normalized) || isSelfPeerUrl(normalized) || isPeerUrlBanned(normalized))
      return false;

    const existing = discoveredPeers.get(normalized);
    const effectiveSource = String(source || (existing && existing.source) || 'peer-exchange');
    const effectivePeerIdentity = String(peerIdentity || (existing && existing.peerIdentity) || '').trim();
    const seenThisSession = effectiveSource !== 'seed-cache';
    const sources = new Set(Array.isArray(existing && existing.sources) ? existing.sources : []);
    sources.add(effectiveSource);

    const next = {
      lastSeenMs: Math.max(Number(seenAtMs) || 0, existing && existing.lastSeenMs ? existing.lastSeenMs : 0),
      source: effectiveSource,
      ...(effectivePeerIdentity ? { peerIdentity: effectivePeerIdentity } : {}),
      seenThisSession: Boolean((existing && existing.seenThisSession) || seenThisSession),
      restoredFromCache: Boolean(existing && existing.restoredFromCache) && !seenThisSession,
      sources: Array.from(sources).sort(),
    };
    const isNew = !existing;
    const changed =
      isNew ||
      next.lastSeenMs !== existing.lastSeenMs ||
      next.source !== existing.source ||
      String(next.peerIdentity || '') !== String((existing && existing.peerIdentity) || '') ||
      Boolean(next.seenThisSession) !== Boolean(existing && existing.seenThisSession) ||
      Boolean(next.restoredFromCache) !== Boolean(existing && existing.restoredFromCache) ||
      JSON.stringify(next.sources) !== JSON.stringify(existing.sources || []);

    discoveredPeers.set(normalized, next);
    if (isNew && !quiet) {
      console.log(`[PeerDiscovery] Found peer via ${next.source}: ${obfuscatePublicPeerUrl(normalized)}`);
    }
    if (changed) scheduleDiscoveredSeedPeerCacheSave();
    if (isNew && effectiveSource !== 'seed-cache') scheduleWtcPeerSync(`new-peer:${effectiveSource}`);
    return isNew;
  }

  function forgetDiscoveredPeer(peerUrl, reason) {
    if (reason === undefined) reason = 'unknown';
    const normalized = normalizePeerUrl(peerUrl);
    if (!normalized) return false;
    const removed = discoveredPeers.delete(normalized);
    if (removed) {
      if (process.env.WATTCOIN_DEBUG)
        console.warn('[Peer] forgetDiscoveredPeer: removed', normalized, 'reason:', reason);
      scheduleDiscoveredSeedPeerCacheSave();
    }
    return removed;
  }

  function forgetPeerUrlState(peerUrl, reason) {
    if (reason === undefined) reason = 'unknown';
    const normalized = normalizePeerUrl(peerUrl);
    if (!normalized) return false;
    const removed = forgetDiscoveredPeer(normalized, reason);
    peerReachabilityCache.delete(normalized);
    peerChainTipCache.delete(normalized);
    peerChainTipInflight.delete(normalized);
    peerUrlFailures.delete(normalized);
    return removed;
  }

  function forgetDiscoveredPeersByIdentity(peerIdentity, { keepUrl = '' } = {}) {
    const normalizedIdentity = String(peerIdentity || '').trim();
    if (!normalizedIdentity) return 0;
    const normalizedKeepUrl = normalizePeerUrl(keepUrl);
    let removed = 0;
    for (const [peerUrl, info] of discoveredPeers.entries()) {
      if (String((info && info.peerIdentity) || '').trim() !== normalizedIdentity) continue;
      if (normalizedKeepUrl && peerUrl === normalizedKeepUrl) continue;
      discoveredPeers.delete(peerUrl);
      removed += 1;
    }
    if (removed > 0) scheduleDiscoveredSeedPeerCacheSave();
    return removed;
  }

  function getLocalTunnelPeerLiveness(peerUrl) {
    const settings = getLedgerNetworkSettings();
    if (!isLocallyServedReverseTunnelPeerUrl(peerUrl, settings)) return null;
    const tunnelId = extractTunnelIdFromUrl(peerUrl);
    const session = tunnelId ? reverseTunnelSessions.get(tunnelId) : null;
    if (
      session &&
      session.socket &&
      session.socket.readyState === WebSocket.OPEN &&
      Date.now() - Number(session.lastSeenAtMs || 0) <= REVERSE_TUNNEL_LIVE_THRESHOLD_MS
    ) {
      return { live: true, peerIdentity: String(session.peerIdentity || '').trim() };
    }
    return null;
  }

  async function getOnlineAttestationPeers(settings, localWorkerId, extraOpts) {
    const _localWorkerKey = String(localWorkerId || '').trim();
    const peers = getActivePeers(settings);
    const distinctPeerKeys = new Set();
    const onlinePeers = [];
    const httpPeers = [];

    const _seedPeerUrlSet = new Set((settings && settings.seedPeers) || []);
    const _cacheBootstrapIdentity = (peerUrl, identity) => {
      if (identity && _seedPeerUrlSet.has(normalizePeerUrl(peerUrl))) {
        bootstrapPeerAddresses.add(identity);
      }
    };

    for (const peerUrl of peers) {
      const liveTunnel = getLocalTunnelPeerLiveness(peerUrl);
      if (liveTunnel && liveTunnel.live) {
        const peerIdentity = String(liveTunnel.peerIdentity || '').trim();
        _cacheBootstrapIdentity(peerUrl, peerIdentity);
        if (isPeerIdentitySelfReference(peerIdentity, peerUrl)) continue;
        const peerKey = peerIdentity || normalizePeerUrl(peerUrl);
        if (distinctPeerKeys.has(peerKey)) continue;
        distinctPeerKeys.add(peerKey);
        onlinePeers.push(peerUrl);
        continue;
      }

      const shouldProbe = shouldAttemptPeerReachability(peerUrl);
      if (!shouldProbe) {
        const np = normalizePeerUrl(peerUrl);
        const cached = np ? peerReachabilityCache.get(np) : null;
        if (cached && cached.ok) {
          const tunnel = getLocalTunnelPeerLiveness(peerUrl);
          const peerIdentity =
            tunnel && tunnel.peerIdentity ? String(tunnel.peerIdentity).trim() : cached.peerIdentity || '';
          _cacheBootstrapIdentity(peerUrl, peerIdentity);
          if (!isPeerIdentitySelfReference(peerIdentity, peerUrl)) {
            const peerKey = peerIdentity || np;
            if (!distinctPeerKeys.has(peerKey)) {
              distinctPeerKeys.add(peerKey);
              onlinePeers.push(peerUrl);
            }
          }
        }
        continue;
      }
      httpPeers.push(peerUrl);
    }

    const enoughFound = { current: false };
    const probePeer = async (peerUrl) => {
      if (enoughFound.current) return;
      try {
        const tip = await requestPeerJson(peerUrl, 'GET', '/api/v1/chain/tip', undefined, undefined, {
          timeoutMs: (extraOpts && extraOpts.fastTimeoutMs) || PEER_ATTESTATION_SELECTION_TIMEOUT_MS,
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'peer-probe-select',
        });
        if (!tip || !tip.ok) return;
        if (enoughFound.current) return;
        const peerIdentity = String((tip && tip.peerIdentity) || '').trim();
        _cacheBootstrapIdentity(peerUrl, peerIdentity);
        if (isPeerIdentitySelfReference(peerIdentity, peerUrl)) return;
        const peerKey = peerUtils.getPeerIdentityKey(peerUrl, tip);
        if (distinctPeerKeys.has(peerKey)) return;
        distinctPeerKeys.add(peerKey);
        rememberDiscoveredPeer(peerUrl, { source: 'peer-probe-select', quiet: true });
        onlinePeers.push(peerUrl);
        if (onlinePeers.length >= MIN_PROBE_VERIFIERS) {
          enoughFound.current = true;
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        const np = normalizePeerUrl(peerUrl);
        if (np) {
          peerReachabilityCache.set(np, { ok: false, lastAttemptAtMs: Date.now(), lastSuccessAtMs: 0 });
        }
      }
    };

    for (
      let index = 0;
      index < httpPeers.length && onlinePeers.length < MIN_PROBE_VERIFIERS;
      index += PEER_ATTESTATION_SELECTION_CONCURRENCY
    ) {
      const batch = httpPeers.slice(index, index + PEER_ATTESTATION_SELECTION_CONCURRENCY);
      await Promise.all(batch.map(probePeer));
    }

    if (process.env.WATTCOIN_DEBUG && onlinePeers.length < MIN_PROBE_VERIFIERS) {
      console.warn(
        '[Peer] getOnlineAttestationPeers: only',
        onlinePeers.length,
        'online, httpPeers tried:',
        httpPeers.length,
        'tunnelPeers:',
        peers.length - httpPeers.length,
      );
    }
    return onlinePeers;
  }

  // -- Peer maintenance -----------------------------------------------------

  function pruneDiscoveredPeers(nowMs) {
    if (nowMs === undefined) nowMs = Date.now();
    let changed = false;
    for (const [url, info] of discoveredPeers.entries()) {
      if (!info) {
        discoveredPeers.delete(url);
        changed = true;
      } else if (nowMs - Number(info.lastSeenMs || 0) > PEER_STALE_THRESHOLD_MS) {
        if (process.env.WATTCOIN_DEBUG) {
          const ageSec = ((nowMs - Number(info.lastSeenMs || 0)) / 1000).toFixed(0);
          console.warn('[Peer] pruneDiscoveredPeers: stale', url, 'lastSeen', ageSec + 's ago');
        }
        discoveredPeers.delete(url);
        changed = true;
      } else if (isPeerUrlBanned(url)) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Peer] pruneDiscoveredPeers: banned', url);
        discoveredPeers.delete(url);
        changed = true;
      }
    }
    if (changed) scheduleDiscoveredSeedPeerCacheSave();
    return changed;
  }

  // -- Peer attestation history ---------------------------------------------

  function clearStalePeerAttestationHistory(nowMs) {
    if (nowMs === undefined) nowMs = Date.now();
    for (const [peerIdentity, relations] of peerAttestationHistory.entries()) {
      if (!relations || relations.size === 0) {
        peerAttestationHistory.delete(peerIdentity);
        continue;
      }
      for (const [otherIdentity, ts] of relations.entries()) {
        if (nowMs - Number(ts || 0) > PEER_ATTESTATION_RECIPROCITY_WINDOW_MS) {
          relations.delete(otherIdentity);
        }
      }
      if (!relations.size) peerAttestationHistory.delete(peerIdentity);
    }
  }

  function recordPeerAttestation(verifierAddress, workerId) {
    const verifierIdentity = String(verifierAddress || '').trim();
    const workerIdentity = String(workerId || '').trim();
    if (!verifierIdentity || !workerIdentity || verifierIdentity === workerIdentity) return;
    const nowMs = Date.now();
    if (!peerAttestationHistory.has(verifierIdentity)) {
      peerAttestationHistory.set(verifierIdentity, new Map());
    }
    peerAttestationHistory.get(verifierIdentity).set(workerIdentity, nowMs);
  }

  function hasRecentPeerAttestationRelation(peerA, peerB, nowMs) {
    if (nowMs === undefined) nowMs = Date.now();
    const a = String(peerA || '').trim();
    const b = String(peerB || '').trim();
    if (!a || !b || a === b) return false;
    clearStalePeerAttestationHistory(nowMs);
    const aRelations = peerAttestationHistory.get(a);
    if (aRelations && aRelations.has(b)) return true;
    const bRelations = peerAttestationHistory.get(b);
    if (bRelations && bRelations.has(a)) return true;
    return false;
  }

  // -- Peer list builders ---------------------------------------------------

  function buildAdvertisedPeerList(settings) {
    const peers = [];
    const seen = new Set();
    const localPeerIdentity = getLocalPeerIdentity();
    const addPeer = (peerUrl, source, lastSeenMs, { allowSelf = false, peerIdentity = '' } = {}) => {
      if (lastSeenMs === undefined) lastSeenMs = Date.now();
      const normalized = normalizePeerUrl(peerUrl);
      if (
        !normalized ||
        seen.has(normalized) ||
        (!allowSelf && isSelfPeerUrl(normalized)) ||
        isPeerUrlBanned(normalized)
      )
        return;
      seen.add(normalized);
      const normalizedIdentity = String(peerIdentity || '').trim();
      peers.push({
        url: normalized,
        source,
        lastSeenMs,
        ...(normalizedIdentity ? { peerIdentity: normalizedIdentity } : {}),
      });
    };

    for (const peerUrl of getConfiguredAdvertisedPeerUrls(settings)) {
      addPeer(peerUrl, 'public', Date.now(), { allowSelf: true, peerIdentity: localPeerIdentity });
    }
    for (const peerUrl of (settings && settings.configuredPeers) || []) addPeer(peerUrl, 'configured');
    for (const peerUrl of (settings && settings.seedPeers) || []) addPeer(peerUrl, 'seed');
    for (const [peerUrl, info] of discoveredPeers.entries()) {
      addPeer(peerUrl, (info && info.source) || 'peer-exchange', (info && info.lastSeenMs) || Date.now(), {
        peerIdentity: String((info && info.peerIdentity) || '').trim(),
      });
    }
    return peers.slice(0, 64);
  }

  // -- Reachability verification --------------------------------------------

  async function verifyReachablePeerCandidate(candidate, source) {
    const wtcNode = getWtcNode();
    if (source === undefined) source = 'peer-contact';
    const normalized = normalizePeerUrl(candidate);
    if (!normalized) return { ok: false, reason: 'invalid-url' };
    const nowMs = Date.now();
    if (!shouldAttemptPeerReachability(normalized, nowMs)) {
      const cached = peerReachabilityCache.get(normalized);
      if (cached && cached.ok) {
        rememberDiscoveredPeer(normalized, { source, quiet: true });
      }
      return {
        ok: Boolean(cached && cached.ok),
        cached: true,
        source,
      };
    }

    peerReachabilityCache.set(normalized, {
      lastAttemptAtMs: nowMs,
      lastSuccessAtMs: 0,
      ok: false,
    });

    try {
      const tip = await requestPeerJson(normalized, 'GET', '/api/v1/chain/tip', undefined, undefined, {
        timeoutMs: PEER_REACHABILITY_TIMEOUT_MS,
        trackReachability: false,
        suppressPeerDiscovery: true,
        source,
      });
      const localHeight = wtcNode && typeof wtcNode.getHeight === 'function' ? Number(wtcNode.getHeight()) : Number.NaN;
      const remoteHeight = Number(tip && tip.height);
      peerReachabilityCache.set(normalized, {
        lastAttemptAtMs: nowMs,
        lastSuccessAtMs: Date.now(),
        ok: true,
      });
      recordPeerUrlSuccess(normalized);
      rememberDiscoveredPeer(normalized, { source, quiet: true });
      gossipAnnounce([normalized]);
      if (Number.isFinite(remoteHeight) && Number.isFinite(localHeight) && remoteHeight > localHeight) {
        scheduleWtcPeerSync(`${source}-higher-tip`, 150);
      }
      return { ok: true, remoteHeight, source };
    } catch (error) {
      peerReachabilityCache.set(normalized, {
        lastAttemptAtMs: nowMs,
        lastSuccessAtMs: 0,
        ok: false,
      });
      return {
        ok: false,
        source,
        reason: error && error.message ? error.message : 'reachability-check-failed',
      };
    }
  }

  // -- Requester registration -----------------------------------------------

  function maybeRegisterReachableRequester(req, settings, source) {
    if (source === undefined) source = 'peer-contact';
    return maybeRegisterReachableRequesterHelper(req, settings, source, {
      isReverseTunnelForwardedRequest: peerUtils.isReverseTunnelForwardedRequest,
      rememberObservedRequester,
      extractReachablePeerCandidates,
      isPublicPeerHost,
      verifyReachablePeerCandidate,
    });
  }

  function rememberObservedRequester(req, settings, source) {
    if (source === undefined) source = 'peer-presence';
    const candidates = extractReachablePeerCandidates(req, settings);
    const peerIdentity = getTrustedRequesterPeerIdentity(req, settings);
    let observed = false;
    let preferredPeerUrl = '';
    for (const candidate of candidates) {
      preferredPeerUrl = selectPreferredPeerUrl(preferredPeerUrl, candidate);
      observed =
        rememberDiscoveredPeer(candidate, {
          source,
          quiet: true,
          peerIdentity,
        }) || observed;
    }
    if (peerIdentity && preferredPeerUrl) {
      forgetDiscoveredPeersByIdentity(peerIdentity, { keepUrl: preferredPeerUrl });
    }
    return observed;
  }

  return {
    _getRemoteSeedManifestUrls,
    loadCachedRemoteSeedPeers,
    _saveCachedRemoteSeedPeers,
    _fetchRemoteSeedManifest,
    refreshRemoteSeedPeers,
    startRemoteSeedPeerRefresh,
    stopRemoteSeedPeerRefresh,
    detectAutoPublicPeerUrl,
    refreshAutoPublicPeerUrl,
    sendSeedRegistryHeartbeat,
    startAutoPublicPeerUrlRefresh,
    stopAutoPublicPeerUrlRefresh,
    startSeedRegistryHeartbeat,
    stopSeedRegistryHeartbeat,
    isSelfPeerUrl,
    isPeerIdentitySelfReference,
    isLocallyServedReverseTunnelPeerUrl,
    resolvePeerRequestBaseUrl,
    getConfiguredAdvertisedPeerUrls,
    getPrimaryAdvertisedPeerUrl,
    buildPeerAnnouncementHeaders,
    extractReachablePeerCandidates,
    shouldAttemptPeerReachability,
    rememberDiscoveredPeer,
    forgetDiscoveredPeer,
    forgetPeerUrlState,
    forgetDiscoveredPeersByIdentity,
    getLocalTunnelPeerLiveness,
    getOnlineAttestationPeers,
    pruneDiscoveredPeers,
    clearStalePeerAttestationHistory,
    recordPeerAttestation,
    hasRecentPeerAttestationRelation,
    loadDiscoveredSeedPeerCache,
    buildAdvertisedPeerList,
    verifyReachablePeerCandidate,
    maybeRegisterReachableRequester,
    rememberObservedRequester,
  };
}

module.exports = { createPeerNetworking };
