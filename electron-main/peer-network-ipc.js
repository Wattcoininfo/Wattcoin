function registerPeerNetworkIpcHandlers(
  ipcMain,
  {
    peerCountCachedResultRef,
    getLedgerNetworkSettings,
    pruneDiscoveredPeers,
    getPeerDiscoverySnapshot,
    opsState,
    getActivePeers,
    getPeerDirectoryTargets,
    inspectPeerConnectivityForTargets,
    PEER_COUNT_PROBE_CONCURRENCY,
    PEER_COUNT_PROBE_TIMEOUT_MS,
    getActiveReverseTunnelPeerConnectionCount,
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
    getConfiguredAdvertisedPeerUrls,
    peerGossipTopology,
  },
) {
  let peerCountInspectionPromise = null;

  ipcMain.handle('wattcoin-get-peer-count', async () => {
    try {
      if (peerCountCachedResultRef.current && peerCountCachedResultRef.current.expiresAtMs > Date.now()) {
        return peerCountCachedResultRef.current.value;
      }
      if (peerCountInspectionPromise) {
        return await peerCountInspectionPromise;
      }
      const doInspection = async () => {
        const settings = getLedgerNetworkSettings();
        pruneDiscoveredPeers();
        const discovery = getPeerDiscoverySnapshot(settings);
        const lastSync = opsState.lastSyncResult || null;
        if (settings.enabled && settings.mode === 'peer') {
          const mergedTargets = Array.from(
            new Set([...getActivePeers(settings), ...getPeerDirectoryTargets(settings)]),
          );
          const activeConnectivity = await inspectPeerConnectivityForTargets(mergedTargets, {
            source: 'peer-count-active',
            concurrency: PEER_COUNT_PROBE_CONCURRENCY,
            probeTimeoutMs: PEER_COUNT_PROBE_TIMEOUT_MS,
          });
          const tunnelCount = getActiveReverseTunnelPeerConnectionCount();
          const counts = summarizeDisplayedPeerCounts({
            healthyDistinct: activeConnectivity.healthyDistinct,
            reverseTunnelDistinct: tunnelCount,
          });
          return {
            ok: true,
            count: counts.onlineCount,
            onlineCount: counts.onlineCount,
            connectedCount: counts.activeCount,
            tunnelCount: counts.tunnelCount,
            activeCount: counts.activeCount,
            source: 'peer',
            configuredPeers: Number(discovery && discovery.configuredPeers) || 0,
            seedPeers: Number(discovery && discovery.seedPeers) || 0,
            discoveredPeers: Number(discovery && discovery.discoveredPeers) || 0,
            lastSyncTrigger: lastSync && lastSync.trigger ? String(lastSync.trigger) : '',
            lastSyncOk: Boolean(lastSync && (lastSync.synced || lastSync.ok)),
          };
        }
        return {
          ok: true,
          count: null,
          onlineCount: null,
          connectedCount: 0,
          tunnelCount: 0,
          activeCount: 0,
          source: 'standalone',
          configuredPeers: 0,
          seedPeers: 0,
          discoveredPeers: 0,
          lastSyncTrigger: '',
          lastSyncOk: false,
        };
      };
      peerCountInspectionPromise = doInspection();
      try {
        const result = await peerCountInspectionPromise;
        peerCountCachedResultRef.current = { expiresAtMs: Date.now() + PEER_COUNT_CACHE_TTL_MS, value: result };
        return result;
      } finally {
        peerCountInspectionPromise = null;
      }
    } catch (_) {
      return {
        ok: false,
        count: null,
        onlineCount: null,
        connectedCount: 0,
        tunnelCount: 0,
        activeCount: 0,
        configuredPeers: 0,
        seedPeers: 0,
        discoveredPeers: 0,
        lastSyncTrigger: '',
        lastSyncOk: false,
      };
    }
  });

  ipcMain.handle('wattcoin-get-peer-topology', () => {
    try {
      const peers = [];
      const now = Date.now();
      for (const [url, info] of discoveredPeers) {
        const reachable = peerReachabilityCache.get(url);
        const tip = peerChainTipCache.get(url);
        const tipValue = tip && tip.value;
        const walletFromTip = tipValue && tipValue.walletAddress ? String(tipValue.walletAddress).trim() : '';
        const peerId = info.peerIdentity || '';
        const walletAddress = walletFromTip || (peerId && isValidWtcAddress(peerId) ? peerId : '');
        peers.push({
          url,
          lastSeenMs: info.lastSeenMs,
          source: info.source || '',
          sources: info.sources || [],
          peerIdentity: peerId,
          walletAddress,
          reachable: reachable ? !!reachable.ok : null,
          lastAttemptAtMs: reachable ? reachable.lastAttemptAtMs : 0,
          lastSuccessAtMs: reachable ? reachable.lastSuccessAtMs : 0,
          tipHeight: tipValue ? tipValue.height : null,
          tipHash: tipValue ? tipValue.hash : null,
        });
      }
      const attestations = [];
      for (const [verifier, workers] of peerAttestationHistory) {
        if (workers && typeof workers.forEach === 'function') {
          workers.forEach((lastAttestedMs, workerId) => {
            if (now - lastAttestedMs < PEER_ATTESTATION_RECIPROCITY_WINDOW_MS) {
              attestations.push({ verifier, worker: workerId, lastAttestedMs });
            }
          });
        }
      }
      const tunnels = [];
      for (const [, session] of reverseTunnelSessions) {
        if (session && session.peerIdentity && session.socket && session.socket.readyState === 1) {
          tunnels.push({
            peerIdentity: session.peerIdentity,
            publicUrl: session.publicUrl || '',
            connectedAtMs: session.connectedAtMs || 0,
            lastSeenAtMs: session.lastSeenAtMs || 0,
          });
        }
      }
      const roundSnapshot = getSharedRoundSnapshot();
      const contributions = (roundSnapshot && roundSnapshot.contributionsWh) || {};
      const contributors = Object.entries(contributions).map(([address, wh]) => ({ address, wh: Number(wh) || 0 }));
      const peerSettings = getLedgerNetworkSettings();
      const localPeerUrls = getConfiguredAdvertisedPeerUrls(peerSettings);
      const gossipEdges = [];
      for (const [peerIdentity, info] of peerGossipTopology) {
        for (const connectedId of info.connectedIds) {
          gossipEdges.push({ source: peerIdentity, target: connectedId });
        }
      }
      return {
        ok: true,
        peers,
        attestations,
        tunnels,
        gossipEdges,
        contributions,
        contributors,
        totalWh: (roundSnapshot && roundSnapshot.totalWh) || 0,
        roundId: (roundSnapshot && roundSnapshot.id) || 0,
        localPeerUrls,
      };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'failed to collect peer topology' };
    }
  });
}

module.exports = { registerPeerNetworkIpcHandlers };
