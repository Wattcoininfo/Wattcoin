'use strict';

function createLedgerServer(ctx) {
  const {
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
  } = ctx;

  function startLedgerNetworkServer() {
    if (ledgerNetworkServerRef.current) return;
    const settings = ledgerNetwork.getLedgerNetworkSettings();
    if (!settings.enabled || settings.mode !== 'peer') return;

    ledgerNetworkServerRef.current = http.createServer(ledgerRequestHandler);
    reverseTunnel.startReverseTunnelCoordinator(settings);
    peerProbeIpc._scheduleProbePush();

    ledgerNetworkServerRef.current.listen(settings.listenPort, settings.listenHost, async () => {
      await peerNetworking.refreshAutoPublicPeerUrl(settings);
      const upnpResult = await setupUpnpPortMapping(settings.listenPort, settings.listenHost);
      if (upnpResult) {
        const upnpUrl = normalizePeerUrl(`http://${upnpResult.publicIp}:${upnpResult.publicPort}`);
        if (upnpUrl) {
          autoDetectedPublicPeerUrlRef.current = upnpUrl;
          autoDetectedPublicPeerUrlFromUpnpRef.current = true;
          console.log(`[Wattcoin] UPnP: public peer URL set to ${upnpUrl}`);
          peerNetworking.sendSeedRegistryHeartbeat();
        }
      }
      if (!stunDetectionPromiseRef.current) {
        stunDetectionPromiseRef.current = detectNatType({
          stunServers: DEFAULT_STUN_SERVERS,
          timeoutMs: 3000,
        })
          .then((info) => {
            if (info && info.natType !== NAT_TYPE.TIMEOUT) {
              stunNatInfoRef.current = { ...info, detectedAtMs: Date.now() };
              console.log(
                `[NAT] Detected NAT type: ${info.natType}, mapped: ${info.mappedIp || '?'}:${info.mappedPort || '?'}`,
              );
            } else {
              console.log('[NAT] STUN detection timed out; assuming unknown NAT type.');
            }
            stunDetectionPromiseRef.current = null;
            return stunNatInfoRef.current;
          })
          .catch(() => {
            stunDetectionPromiseRef.current = null;
          });
      }
      await peerNetworking.refreshRemoteSeedPeers(settings);
      const effectiveSettings = ledgerNetwork.getLedgerNetworkSettings();
      const listenUrls = ledgerNetwork.getLedgerListenUrls(effectiveSettings);
      const advertisedUrls = peerNetworking.getConfiguredAdvertisedPeerUrls(effectiveSettings);
      const configuredPeers = (effectiveSettings.configuredPeers || []).join(', ');
      const seedPeers = (effectiveSettings.seedPeers || []).join(', ');
      console.log(`[Wattcoin] Ledger ${effectiveSettings.mode} listening on this node: ${listenUrls.join(', ')}`);
      if (advertisedUrls.length > 0) {
        console.log(`[Wattcoin] Ledger ${effectiveSettings.mode} advertising as: ${advertisedUrls.join(', ')}`);
      } else if (effectiveSettings.mode === 'peer') {
        console.log(
          '[Wattcoin] Ledger peer public advertise URL: none configured; using seed/bootstrap peers, discovery, and managed tunnel when available.',
        );
      }
      if (configuredPeers) {
        console.log(`[Wattcoin] Explicit static ledger peers: ${configuredPeers}`);
      }
      if (seedPeers) {
        console.log(`[Wattcoin] Seed/bootstrap peers: ${seedPeers}`);
      }
      peerDiscovery.startPeerDiscovery(
        effectiveSettings.listenPort,
        peerNetworking.getPrimaryAdvertisedPeerUrl(effectiveSettings),
      );
      peerNetworking.startAutoPublicPeerUrlRefresh(effectiveSettings);
      peerNetworking.startRemoteSeedPeerRefresh(effectiveSettings);
      peerNetworking.startSeedRegistryHeartbeat(effectiveSettings);
      reverseTunnel.ensureManagedReverseTunnelClient(effectiveSettings);
      wtcChainSync.attemptHolePunchToSeedPeers(effectiveSettings);
    });
  }

  function stopLedgerNetworkServer() {
    governance.stopGovernanceSync();
    peerNetworking.stopRemoteSeedPeerRefresh();
    peerNetworking.stopAutoPublicPeerUrlRefresh();
    peerNetworking.stopSeedRegistryHeartbeat();
    peerDiscovery.stopPeerDiscovery();
    reverseTunnel.stopManagedReverseTunnelClient();
    reverseTunnel.stopReverseTunnelCoordinator();
    removeUpnpMapping();
    autoDetectedPublicPeerUrlFromUpnpRef.current = false;
    stunNatInfoRef.current = null;
    stunDetectionPromiseRef.current = null;
    usedPunchPorts.clear();
    peerPunchAttemptTimestamps.clear();
    peerGossipSeen.clear();
    if (!ledgerNetworkServerRef.current) return;
    try {
      ledgerNetworkServerRef.current.close();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    ledgerNetworkServerRef.current = null;
  }

  return { startLedgerNetworkServer, stopLedgerNetworkServer };
}

module.exports = { createLedgerServer };
