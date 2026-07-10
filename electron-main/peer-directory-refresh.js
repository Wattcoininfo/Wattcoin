'use strict';

function createPeerDirectoryRefresher(ctx) {
  const {
    ledgerNetwork,
    peerDiscovery,
    peerUtils,
    requestPeerJson,
    peerNetworking,
    selectPreferredPeerUrl,
    stunNatInfoRef,
    NAT_TYPE,
    tryHolePunchToPeers,
  } = ctx;

  async function refreshPeerDirectory(settings = ledgerNetwork.getLedgerNetworkSettings()) {
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    const targets = peerDiscovery.getPeerDirectoryTargets(settings);
    const peers = peerUtils.pickPeerExchangeTargets(targets);
    const discoveredCandidates = [];
    for (const peerUrl of peers) {
      try {
        const response = await requestPeerJson(peerUrl, 'GET', '/api/v1/network/peers', undefined, undefined, {
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'peer-directory',
        });
        peerNetworking.rememberDiscoveredPeer(peerUrl, { source: 'peer-directory', quiet: true });
        const advertised = Array.isArray(response && response.peers) ? response.peers : [];
        const preferredPeerUrlsByIdentity = new Map();
        for (const entry of advertised) {
          const candidate = typeof entry === 'string' ? entry : String(entry && entry.url ? entry.url : '');
          const peerIdentity = typeof entry === 'string' ? '' : String((entry && entry.peerIdentity) || '').trim();
          peerNetworking.rememberDiscoveredPeer(candidate, { source: 'peer-directory', quiet: true, peerIdentity });
          if (candidate) discoveredCandidates.push(candidate);
          if (peerIdentity) {
            const preferredPeerUrl = preferredPeerUrlsByIdentity.get(peerIdentity) || '';
            preferredPeerUrlsByIdentity.set(peerIdentity, selectPreferredPeerUrl(preferredPeerUrl, candidate));
          }
        }
        for (const [peerIdentity, keepUrl] of preferredPeerUrlsByIdentity.entries()) {
          peerNetworking.forgetDiscoveredPeersByIdentity(peerIdentity, { keepUrl });
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }
    if (
      discoveredCandidates.length > 0 &&
      stunNatInfoRef.current &&
      stunNatInfoRef.current.natType !== NAT_TYPE.PUBLIC &&
      stunNatInfoRef.current.natType !== NAT_TYPE.TIMEOUT
    ) {
      tryHolePunchToPeers(discoveredCandidates, settings);
    }
  }

  return { refreshPeerDirectory };
}

module.exports = { createPeerDirectoryRefresher };
