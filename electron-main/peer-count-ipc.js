function registerPeerCountIpcHandlers(
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
}

module.exports = { registerPeerCountIpcHandlers };
