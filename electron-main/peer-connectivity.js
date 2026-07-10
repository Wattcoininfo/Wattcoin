function createPeerConnectivityInspector({
  normalizePeerUrl,
  peerUtils,
  discoveredPeers,
  isLocallyServedReverseTunnelPeerUrl,
  extractTunnelIdFromUrl,
  reverseTunnelSessions,
  WebSocket,
  REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
  isPeerIdentitySelfReference,
  shouldAttemptPeerReachability,
  peerReachabilityCache,
  PEER_COUNT_CACHE_TTL_MS,
  PEER_CHAIN_TIP_TIMEOUT_MS,
  PEER_HEALTHY_GRACE_PERIOD_MS,
  requestPeerJson,
  recordPeerUrlSuccess,
  rememberDiscoveredPeer,
  isReverseTunnelPeerUrl,
  getLedgerNetworkSettings,
  getWtcNode,
  getActivePeers,
  PEER_COUNT_PROBE_CONCURRENCY,
  PEER_COUNT_PROBE_TIMEOUT_MS,
}) {
  async function inspectPeerConnectivityForTargets(
    peerUrls = [],
    {
      source = 'peer-contact',
      initialBestPeerHeight = Number(
        (() => {
          const node = getWtcNode();
          return node && typeof node.getHeight === 'function' ? node.getHeight() : 0;
        })(),
      ) || 0,
      concurrency = 0,
      probeTimeoutMs = 0,
    } = {},
  ) {
    const peers = Array.from(new Set((peerUrls || []).map(normalizePeerUrl).filter(Boolean)));
    const distinctPeerKeys = new Set();
    const healthyPeerKeys = new Set();
    const healthyTunnelPeerKeys = new Set();
    let bestPeerHeight = initialBestPeerHeight;
    const effectiveTimeout = Math.max(1000, Number(probeTimeoutMs) || PEER_CHAIN_TIP_TIMEOUT_MS);
    const maxConcurrency = Math.max(1, Number(concurrency) || peers.length);
    const settings = getLedgerNetworkSettings();
    const nowMs = Date.now();
    const getFallbackPeerKey = (peerUrl) => {
      const normalizedPeerUrl = normalizePeerUrl(peerUrl);
      const discoveredInfo = normalizedPeerUrl ? discoveredPeers.get(normalizedPeerUrl) : null;
      const peerIdentity = String((discoveredInfo && discoveredInfo.peerIdentity) || '').trim();
      if (peerIdentity) return `id:${peerIdentity}`;
      return peerUtils.getPeerIdentityKey(peerUrl, null);
    };

    const httpPeers = [];
    for (const peerUrl of peers) {
      if (isLocallyServedReverseTunnelPeerUrl(peerUrl, settings)) {
        const tunnelId = extractTunnelIdFromUrl(peerUrl);
        const session = tunnelId ? reverseTunnelSessions.get(tunnelId) : null;
        if (
          session &&
          session.socket &&
          session.socket.readyState === WebSocket.OPEN &&
          nowMs - Number(session.lastSeenAtMs || 0) <= REVERSE_TUNNEL_LIVE_THRESHOLD_MS
        ) {
          const identity = String(session.peerIdentity || '').trim();
          if (isPeerIdentitySelfReference(identity, peerUrl)) continue;
          const peerKey = identity || `tunnel:${tunnelId}`;
          distinctPeerKeys.add(peerKey);
          healthyPeerKeys.add(peerKey);
          healthyTunnelPeerKeys.add(peerKey);
        } else {
          distinctPeerKeys.add(getFallbackPeerKey(peerUrl));
        }
      } else if (shouldAttemptPeerReachability(peerUrl, nowMs)) {
        httpPeers.push(peerUrl);
      } else {
        const _normalized = normalizePeerUrl(peerUrl);
        const _cached = _normalized ? peerReachabilityCache.get(_normalized) : null;
        if (_cached && _cached.ok) {
          if (nowMs - Number(_cached.lastSuccessAtMs || 0) < PEER_COUNT_CACHE_TTL_MS) {
            const _peerKey = getFallbackPeerKey(peerUrl);
            distinctPeerKeys.add(_peerKey);
            healthyPeerKeys.add(_peerKey);
          } else {
            httpPeers.push(peerUrl);
          }
        } else {
          distinctPeerKeys.add(getFallbackPeerKey(peerUrl));
        }
      }
    }

    const probePeer = async (peerUrl) => {
      const fallbackKey = getFallbackPeerKey(peerUrl);
      try {
        const tip = await requestPeerJson(peerUrl, 'GET', '/api/v1/chain/tip', undefined, undefined, {
          source,
          timeoutMs: effectiveTimeout,
          trackReachability: false,
        });
        if (!tip || !tip.ok) {
          distinctPeerKeys.add(fallbackKey);
          return;
        }
        recordPeerUrlSuccess(normalizePeerUrl(peerUrl));
        const _tipNp = normalizePeerUrl(peerUrl);
        if (_tipNp) {
          peerReachabilityCache.set(_tipNp, { ok: true, lastAttemptAtMs: Date.now(), lastSuccessAtMs: Date.now() });
        }
        const peerIdentity = String((tip && tip.peerIdentity) || '').trim();
        if (isPeerIdentitySelfReference(peerIdentity, peerUrl)) {
          return;
        }
        const peerKey = peerUtils.getPeerIdentityKey(peerUrl, tip);
        distinctPeerKeys.add(peerKey);
        healthyPeerKeys.add(peerKey);
        rememberDiscoveredPeer(peerUrl, { source, quiet: true });
        if (isReverseTunnelPeerUrl(peerUrl)) {
          healthyTunnelPeerKeys.add(peerKey);
        }
        const height = Number(tip.height);
        if (Number.isFinite(height) && height > bestPeerHeight) bestPeerHeight = height;
      } catch (_) {
        const _normalized = normalizePeerUrl(peerUrl);
        const _disc = _normalized ? discoveredPeers.get(_normalized) : null;
        if (_disc && _disc.lastSeenMs && Date.now() - _disc.lastSeenMs < PEER_HEALTHY_GRACE_PERIOD_MS) {
          const _peerKey = getFallbackPeerKey(peerUrl);
          distinctPeerKeys.add(_peerKey);
          healthyPeerKeys.add(_peerKey);
        } else {
          distinctPeerKeys.add(fallbackKey);
        }
        if (_normalized) {
          peerReachabilityCache.set(_normalized, { ok: false, lastAttemptAtMs: Date.now(), lastSuccessAtMs: 0 });
        }
      }
    };

    for (let i = 0; i < httpPeers.length; i += maxConcurrency) {
      const batch = httpPeers.slice(i, i + maxConcurrency);
      await Promise.all(batch.map(probePeer));
    }

    return {
      peers,
      totalDistinct: distinctPeerKeys.size,
      healthyDistinct: healthyPeerKeys.size,
      healthyTunnelDistinct: healthyTunnelPeerKeys.size,
      bestPeerHeight,
    };
  }

  function inspectPeerConnectivity(settings = getLedgerNetworkSettings(), { source = 'peer-contact' } = {}) {
    const peers = getActivePeers(settings);
    return inspectPeerConnectivityForTargets(peers, {
      source,
      initialBestPeerHeight:
        Number(
          (() => {
            const node = getWtcNode();
            return node && typeof node.getHeight === 'function' ? node.getHeight() : 0;
          })(),
        ) || 0,
      concurrency: PEER_COUNT_PROBE_CONCURRENCY,
      probeTimeoutMs: PEER_COUNT_PROBE_TIMEOUT_MS,
    });
  }

  return { inspectPeerConnectivityForTargets, inspectPeerConnectivity };
}

module.exports = { createPeerConnectivityInspector };
