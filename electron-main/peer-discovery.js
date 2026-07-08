'use strict';

function createPeerDiscovery(deps) {
  const {
    dgram,
    normalizePeerUrl,
    isSelfPeerUrl,
    isPeerUrlBanned,
    getLedgerNetworkSettings,
    rememberDiscoveredPeer,
    requestPeerJson,
    getConfiguredAdvertisedPeerUrls,
    getPrimaryAdvertisedPeerUrl,
    getLocalPeerHosts,
    getLocalPeerIpv4Interfaces,
    getLocalPeerIpv4InterfaceEntries,
    getLocalSubnetProbeCandidates,
    sortPeerUrlsByPreference,
    filterExternalPeerUrls,
    buildPeerUrlFromSocket,
    selectDiscoveryPeerUrl,
    checkHasKnownPrivateLanPeer,
    pruneDiscoveredPeers,
    refreshPeerDirectory,
    peerCountCachedResultRef,
  } = deps;

  // ── Shared mutable state ──────────────────────────────────────────────
  // These use a `.current` wrapper because they are `let` variables that get
  // reassigned.  The caller owns the object; we mutate `.current` on it.
  const state = {
    peerDiscoverySocket: null,
    peerDiscoveryInterval: null,
    peerLocalSubnetDiscoveryPromise: null,
    peerLocalSubnetDiscoveryLastRunAt: 0,
  };

  // Passed-by-reference Map objects (mutated in-place, never reassigned).
  const discoveredPeers = deps.discoveredPeers;
  const peerReachabilityCache = deps.peerReachabilityCache;

  // ── Constants ─────────────────────────────────────────────────────────
  const PEER_DISCOVERY_PORT = 39311;
  const PEER_DISCOVERY_MCAST = '239.0.52.67';
  const PEER_BEACON_INTERVAL_MS = 120_000;
  const PEER_STALE_THRESHOLD_MS = 15 * 60_000;
  const PEER_REACHABILITY_SUCCESS_TTL_MS = 10 * 60_000;
  const PEER_LOCAL_SUBNET_DISCOVERY_CONCURRENCY = 24;
  const PEER_LOCAL_SUBNET_DISCOVERY_TIMEOUT_MS = 1_200;
  const PEER_LOCAL_SUBNET_DISCOVERY_MIN_INTERVAL_MS = 60_000;

  // ── Functions ─────────────────────────────────────────────────────────

  function getActivePeers(settings) {
    const staticPeers = settings && settings.peers ? settings.peers : [];
    const seedPeers = settings && settings.seedPeers ? settings.seedPeers : [];
    const now = Date.now();
    const dynamic = [];
    for (const [url, info] of discoveredPeers.entries()) {
      if (now - info.lastSeenMs > PEER_STALE_THRESHOLD_MS || isPeerUrlBanned(url)) continue;
      dynamic.push(url);
    }
    const allPeers = sortPeerUrlsByPreference(
      Array.from(new Set([...staticPeers, ...seedPeers, ...dynamic])).filter((url) => !isPeerUrlBanned(url)),
    );
    return filterExternalPeerUrls(allPeers, {
      selfAdvertisedUrls: getConfiguredAdvertisedPeerUrls(settings),
      listenPort: settings && settings.listenPort,
      localHosts: Array.from(getLocalPeerHosts()),
    });
  }

  function hasOnlinePeers(settings) {
    const activePeers = getActivePeers(settings);
    if (activePeers.length === 0) return false;
    const pc = peerCountCachedResultRef && peerCountCachedResultRef.current;
    if (pc && pc.value && pc.value.source === 'peer') {
      if (pc.value.onlineCount === 0) return false;
      if (pc.expiresAtMs > Date.now()) return true;
      return true;
    }
    return false;
  }

  function getPeerDirectoryTargets(settings) {
    const configuredPeers = settings && settings.configuredPeers ? settings.configuredPeers : [];
    const seedPeers = settings && settings.seedPeers ? settings.seedPeers : [];
    return filterExternalPeerUrls(
      sortPeerUrlsByPreference(
        Array.from(new Set([...configuredPeers, ...seedPeers, ...getActivePeers(settings)])).filter(
          (peerUrl) => !isPeerUrlBanned(peerUrl),
        ),
      ),
      {
        selfAdvertisedUrls: getConfiguredAdvertisedPeerUrls(settings),
        listenPort: settings && settings.listenPort,
        localHosts: Array.from(getLocalPeerHosts()),
      },
    );
  }

  function getTrustedPeerTargets(settings) {
    const seedPeers = settings && settings.seedPeers ? settings.seedPeers : [];
    const managedTunnelPeers = [];
    for (const [peerUrl, info] of discoveredPeers.entries()) {
      const sources = Array.isArray(info && info.sources) ? info.sources : [];
      if (!sources.includes('managed-tunnel')) continue;
      if (isPeerUrlBanned(peerUrl)) continue;
      managedTunnelPeers.push(peerUrl);
    }
    return filterExternalPeerUrls(
      Array.from(new Set([...managedTunnelPeers, ...seedPeers])).filter((peerUrl) => !isPeerUrlBanned(peerUrl)),
      {
        selfAdvertisedUrls: getConfiguredAdvertisedPeerUrls(settings),
        listenPort: settings && settings.listenPort,
        localHosts: Array.from(getLocalPeerHosts()),
      },
    );
  }

  function sendPeerBeacon(httpPort, publicUrl = '') {
    if (!state.peerDiscoverySocket) return;
    const normalizedPublicUrl = normalizePeerUrl(publicUrl) || getPrimaryAdvertisedPeerUrl(getLedgerNetworkSettings());
    const msg = Buffer.from(
      JSON.stringify({
        type: 'wattcoin-peer-beacon',
        httpPort,
        ...(normalizedPublicUrl ? { publicUrl: normalizedPublicUrl } : {}),
      }),
    );
    const interfaceAddresses = getLocalPeerIpv4Interfaces();
    const sendBeacon = () => {
      state.peerDiscoverySocket.send(msg, 0, msg.length, PEER_DISCOVERY_PORT, PEER_DISCOVERY_MCAST, (err) => {
        if (err) console.warn('[PeerDiscovery] Beacon send error:', err.message);
      });
    };
    if (interfaceAddresses.length === 0) {
      sendBeacon();
      return;
    }
    for (const address of interfaceAddresses) {
      try {
        state.peerDiscoverySocket.setMulticastInterface(address);
        sendBeacon();
      } catch (err) {
        console.warn(
          `[PeerDiscovery] Failed to select multicast interface ${address}:`,
          err && err.message ? err.message : err,
        );
      }
    }
  }

  function hasKnownPrivateLanPeer(settings = getLedgerNetworkSettings()) {
    return checkHasKnownPrivateLanPeer(getActivePeers(settings), {
      discoveredPeers,
      peerReachabilityCache,
      normalizePeerUrl,
      isSelfPeerUrl,
      staleThresholdMs: PEER_STALE_THRESHOLD_MS,
      reachabilitySuccessTtlMs: PEER_REACHABILITY_SUCCESS_TTL_MS,
      now: Date.now(),
    });
  }

  async function discoverPeersOnLocalSubnets(httpPort, settings = getLedgerNetworkSettings()) {
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    if (hasKnownPrivateLanPeer(settings)) return;
    if (state.peerLocalSubnetDiscoveryPromise) return state.peerLocalSubnetDiscoveryPromise;
    const now = Date.now();
    if (now - state.peerLocalSubnetDiscoveryLastRunAt < PEER_LOCAL_SUBNET_DISCOVERY_MIN_INTERVAL_MS) return;
    const candidates = getLocalSubnetProbeCandidates(getLocalPeerIpv4InterfaceEntries(), {
      selfHosts: Array.from(getLocalPeerHosts()),
    });
    if (candidates.length === 0) return;

    state.peerLocalSubnetDiscoveryLastRunAt = now;
    state.peerLocalSubnetDiscoveryPromise = (async () => {
      let found = 0;
      let nextIndex = 0;
      const workerCount = Math.min(PEER_LOCAL_SUBNET_DISCOVERY_CONCURRENCY, candidates.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextIndex < candidates.length) {
          const candidateAddress = candidates[nextIndex];
          nextIndex += 1;
          const peerUrl = normalizePeerUrl(`http://${candidateAddress}:${httpPort}`);
          if (!peerUrl || isSelfPeerUrl(peerUrl) || isPeerUrlBanned(peerUrl)) continue;
          try {
            const tip = await requestPeerJson(peerUrl, 'GET', '/api/v1/chain/tip', undefined, undefined, {
              timeoutMs: PEER_LOCAL_SUBNET_DISCOVERY_TIMEOUT_MS,
              source: 'subnet-probe',
            });
            rememberDiscoveredPeer(peerUrl, {
              source: 'subnet-probe',
              quiet: true,
              peerIdentity: String((tip && tip.peerIdentity) || '').trim(),
            });
            found += 1;
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
          }
        }
      });
      await Promise.all(workers);
      if (found > 0) {
        console.log(`[PeerDiscovery] Local subnet probe found ${found} peer(s).`);
      }
    })();

    try {
      await state.peerLocalSubnetDiscoveryPromise;
    } finally {
      state.peerLocalSubnetDiscoveryPromise = null;
    }
  }

  function startPeerDiscovery(httpPort, publicUrl = '') {
    if (state.peerDiscoverySocket) return;

    const selfIps = getLocalPeerHosts();

    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('message', (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString('utf8'));
        if (data && data.type === 'wattcoin-peer-beacon' && data.httpPort > 0) {
          const advertisedPeerUrl = normalizePeerUrl(data.publicUrl);
          const directLanPeerUrl = buildPeerUrlFromSocket(rinfo && rinfo.address, data.httpPort);
          if (
            advertisedPeerUrl &&
            isSelfPeerUrl(advertisedPeerUrl) &&
            (!directLanPeerUrl || isSelfPeerUrl(directLanPeerUrl))
          )
            return;
          if (!advertisedPeerUrl && !directLanPeerUrl) return;
          if (!advertisedPeerUrl && selfIps.has(rinfo.address) && data.httpPort === httpPort) return;
          if (directLanPeerUrl && isSelfPeerUrl(directLanPeerUrl)) return;
          if (data.httpPort <= 1023) {
            console.warn(`[PeerDiscovery] Ignoring beacon from ${rinfo.address} with reserved port ${data.httpPort}`);
            return;
          }
          const beaconCandidates = [
            advertisedPeerUrl && !isSelfPeerUrl(advertisedPeerUrl) ? advertisedPeerUrl : '',
            directLanPeerUrl,
          ].filter(Boolean);
          const peerUrl = selectDiscoveryPeerUrl(beaconCandidates) || directLanPeerUrl;
          rememberDiscoveredPeer(peerUrl, { source: 'beacon', seenAtMs: Date.now() });
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    });

    sock.on('error', (err) => {
      console.warn('[PeerDiscovery] UDP socket error:', err.message);
    });

    sock.bind(PEER_DISCOVERY_PORT, '0.0.0.0', () => {
      let joinedGroups = 0;
      try {
        const interfaceAddresses = getLocalPeerIpv4Interfaces();
        if (interfaceAddresses.length > 0) {
          for (const address of interfaceAddresses) {
            try {
              sock.addMembership(PEER_DISCOVERY_MCAST, address);
              joinedGroups += 1;
            } catch (err) {
              console.warn(
                `[PeerDiscovery] Failed to join multicast group on ${address}:`,
                err && err.message ? err.message : err,
              );
            }
          }
        }
        if (joinedGroups === 0) {
          sock.addMembership(PEER_DISCOVERY_MCAST);
          joinedGroups = 1;
        }
        sock.setMulticastTTL(1);
        sock.setMulticastLoopback(true);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      console.log(
        `[PeerDiscovery] Listening for peers on UDP ${PEER_DISCOVERY_PORT}${joinedGroups > 0 ? ` across ${joinedGroups} interface(s)` : ''}`,
      );
      sendPeerBeacon(httpPort, getPrimaryAdvertisedPeerUrl(getLedgerNetworkSettings()) || publicUrl);
      discoverPeersOnLocalSubnets(httpPort, getLedgerNetworkSettings()).catch(() => {});
      refreshPeerDirectory(getLedgerNetworkSettings()).catch(() => {});
    });

    state.peerDiscoverySocket = sock;

    const FAST_REFRESH_INTERVAL_MS = 15_000;
    const FAST_REFRESH_DURATION_MS = 120_000;
    const fastRefreshEnd = Date.now() + FAST_REFRESH_DURATION_MS;
    const fastRefreshTimer = setInterval(() => {
      if (Date.now() >= fastRefreshEnd) {
        clearInterval(fastRefreshTimer);
        return;
      }
      refreshPeerDirectory(getLedgerNetworkSettings()).catch(() => {});
    }, FAST_REFRESH_INTERVAL_MS);

    state.peerDiscoveryInterval = setInterval(() => {
      pruneDiscoveredPeers();
      sendPeerBeacon(httpPort, getPrimaryAdvertisedPeerUrl(getLedgerNetworkSettings()) || publicUrl);
      discoverPeersOnLocalSubnets(httpPort, getLedgerNetworkSettings()).catch(() => {});
      refreshPeerDirectory(getLedgerNetworkSettings()).catch(() => {});
    }, PEER_BEACON_INTERVAL_MS);
  }

  function stopPeerDiscovery() {
    if (state.peerDiscoveryInterval) {
      clearInterval(state.peerDiscoveryInterval);
      state.peerDiscoveryInterval = null;
    }
    if (state.peerDiscoverySocket) {
      try {
        state.peerDiscoverySocket.close();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      state.peerDiscoverySocket = null;
    }
    state.peerLocalSubnetDiscoveryPromise = null;
    discoveredPeers.clear();
  }

  return {
    getActivePeers,
    hasOnlinePeers,
    getPeerDirectoryTargets,
    getTrustedPeerTargets,
    sendPeerBeacon,
    hasKnownPrivateLanPeer,
    discoverPeersOnLocalSubnets,
    startPeerDiscovery,
    stopPeerDiscovery,
  };
}

module.exports = { createPeerDiscovery };
