'use strict';

function createWtcChainSync(deps) {
  const {
    getWtcNode,
    getLedgerNetworkSettings,
    getPeerDirectoryTargets,
    requestPeerJson,
    normalizePeerUrl,
    isSelfPeerUrl,
    isPeerUrlBanned,
    rememberDiscoveredPeer,
    peerReachabilityCache,
    peerUtils,
    stunNatInfoRef,
    allocatePunchPort,
    requestPunch,
    filterExternalPeerUrls,
    getConfiguredAdvertisedPeerUrls,
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

    PEER_PUNCH_RETRY_INTERVAL_MS,
    PEER_PUNCH_PER_CYCLE_MAX,
    PEER_GOSSIP_FANOUT,
    PEER_GOSSIP_TTL,
    PEER_GOSSIP_SEEN_TTL_MS,
    PEER_REACHABILITY_SUCCESS_TTL_MS,
    WTC_PEER_SYNC_INTERVAL_MS,
    WTC_PEER_SYNC_DEBOUNCE_MS,
  } = deps;

  async function runWtcPeerSync(triggerLabel) {
    const wtcNode = getWtcNode();
    const label = String(triggerLabel || 'unknown');
    opsState.lastSyncAttemptAt = Date.now();

    if (!wtcNode) {
      opsState.lastSyncResult = { ok: false, reason: 'wtcNode unavailable', trigger: label };
      console.warn(`[WtcSync] ${label}: wtcNode unavailable`);
      return opsState.lastSyncResult;
    }
    if (typeof wtcNode.syncWithPeers !== 'function') {
      opsState.lastSyncResult = { ok: false, reason: 'syncWithPeers unavailable', trigger: label };
      console.warn(`[WtcSync] ${label}: syncWithPeers unavailable`);
      return opsState.lastSyncResult;
    }

    try {
      const res = await wtcNode.syncWithPeers();
      opsState.lastSyncResult = res || null;
      if (res && res.synced) {
        console.log(
          `[WtcSync] ${label}: synced ${res.fromHeight}->${res.toHeight} from ${res.peer} (${res.imported} blocks)`,
        );
      } else if (res && !res.ok) {
        console.warn(`[WtcSync] ${label}: sync failed: ${res.reason}`);
      }
      if (res && typeof res.rollbackDepth === 'number') {
        recordRollbackDepth(res.rollbackDepth, { peer: res.peer || '', ancestor: res.ancestor, trigger: label });
      }
      return res;
    } catch (e) {
      const reason = e && e.message ? e.message : String(e);
      opsState.lastSyncResult = { ok: false, reason, trigger: label };
      console.warn(`[WtcSync] ${label}: peer sync threw: ${reason}`);
      return opsState.lastSyncResult;
    }
  }

  function attemptHolePunchToSeedPeers(settings = getLedgerNetworkSettings()) {
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    if (
      !stunNatInfoRef.current ||
      stunNatInfoRef.current.natType === NAT_TYPE.PUBLIC ||
      stunNatInfoRef.current.natType === NAT_TYPE.TIMEOUT
    )
      return;
    const peerTargets = filterExternalPeerUrls(
      Array.from(new Set([...(settings.seedPeers || []), ...(settings.configuredPeers || [])])),
      {
        selfAdvertisedUrls: getConfiguredAdvertisedPeerUrls(settings),
        listenPort: settings && settings.listenPort,
        localHosts: Array.from(getLocalPeerHosts()),
      },
    );
    if (peerTargets.length === 0) return;
    const stunInfo = stunNatInfoRef.current;
    if (!stunInfo || !stunInfo.mappedIp) return;
    const localPunchPort = allocatePunchPort(usedPunchPorts);
    if (!localPunchPort) return;
    usedPunchPorts.add(localPunchPort);
    const targetUrl = peerTargets[Math.floor(Math.random() * peerTargets.length)];
    const punchReq = requestPunch(targetUrl, stunInfo.mappedIp, stunInfo.mappedPort, {
      requestPeerJson,
      localPunchPort,
      timeoutMs: 5000,
    });
    punchReq
      .execute()
      .then((result) => {
        if (result && result.ok && result.socket) {
          console.log(`[HolePunch] Direct connection to seed peer ${targetUrl} via NAT punch`);
          const np = normalizePeerUrl(targetUrl);
          if (np) {
            peerReachabilityCache.set(np, { ok: true, lastAttemptAtMs: Date.now(), lastSuccessAtMs: Date.now() });
            rememberDiscoveredPeer(np, { source: 'hole-punch', quiet: true });
          }
        }
        if (result && result.socket && !result.socket.destroyed) {
          try {
            result.socket.end();
            result.socket.destroy();
          } catch (_) {
            /* ignore */
          }
        }
      })
      .catch(() => {});
  }

  function tryHolePunchToPeers(peerUrls, settings = getLedgerNetworkSettings()) {
    if (
      !stunNatInfoRef.current ||
      stunNatInfoRef.current.natType === NAT_TYPE.PUBLIC ||
      stunNatInfoRef.current.natType === NAT_TYPE.TIMEOUT
    )
      return;
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    const stunInfo = stunNatInfoRef.current;
    if (!stunInfo || !stunInfo.mappedIp) return;
    const nowMs = Date.now();
    const candidates = [];
    const seen = new Set();
    for (const url of peerUrls) {
      const normalized = normalizePeerUrl(url);
      if (!normalized || seen.has(normalized) || isSelfPeerUrl(normalized) || isPeerUrlBanned(normalized)) continue;
      seen.add(normalized);
      const lastAttempt = peerPunchAttemptTimestamps.get(normalized) || 0;
      if (nowMs - lastAttempt < PEER_PUNCH_RETRY_INTERVAL_MS) continue;
      const cached = peerReachabilityCache.get(normalized);
      if (cached && cached.ok && nowMs - (cached.lastSuccessAtMs || 0) < PEER_REACHABILITY_SUCCESS_TTL_MS) continue;
      candidates.push(normalized);
    }
    const targets = candidates.slice(0, PEER_PUNCH_PER_CYCLE_MAX);
    for (const targetUrl of targets) {
      peerPunchAttemptTimestamps.set(targetUrl, nowMs);
      const localPunchPort = allocatePunchPort(usedPunchPorts);
      if (!localPunchPort) break;
      usedPunchPorts.add(localPunchPort);
      const punchReq = requestPunch(targetUrl, stunInfo.mappedIp, stunInfo.mappedPort, {
        requestPeerJson,
        localPunchPort,
        timeoutMs: 5000,
      });
      punchReq
        .execute()
        .then((result) => {
          if (result && result.ok && result.socket) {
            console.log(`[HolePunch] Direct connection to ${targetUrl} via NAT punch`);
            const np = normalizePeerUrl(targetUrl);
            if (np) {
              peerReachabilityCache.set(np, { ok: true, lastAttemptAtMs: Date.now(), lastSuccessAtMs: Date.now() });
              rememberDiscoveredPeer(np, { source: 'hole-punch', quiet: true });
            }
          }
          if (result && result.socket && !result.socket.destroyed) {
            try {
              result.socket.end();
              result.socket.destroy();
            } catch (_) {
              /* ignore */
            }
          }
        })
        .catch(() => {});
    }
  }

  function _prunePeerGossipSeen() {
    const nowMs = Date.now();
    for (const [key, detectedAtMs] of peerGossipSeen) {
      if (nowMs - detectedAtMs > PEER_GOSSIP_SEEN_TTL_MS) peerGossipSeen.delete(key);
    }
  }

  function receivePeerGossip(payload) {
    const entries = Array.isArray(payload && payload.peers) ? payload.peers : [];
    let ttl = Math.max(0, Number(payload && payload.ttl) || 0);
    if (ttl > PEER_GOSSIP_TTL) ttl = PEER_GOSSIP_TTL;
    const gossipId = String((payload && payload.gossipId) || '');
    if (entries.length === 0) return;
    const settings = getLedgerNetworkSettings();
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    const dedupKey = ttl > 0 && gossipId ? `${gossipId}` : '';
    if (dedupKey && peerGossipSeen.has(dedupKey)) return;
    if (dedupKey) peerGossipSeen.set(dedupKey, Date.now());
    const discovered = [];
    for (const entry of entries) {
      const url = typeof entry === 'string' ? entry : String(entry && entry.url ? entry.url : '');
      const peerIdentity = typeof entry === 'string' ? '' : String((entry && entry.peerIdentity) || '').trim();
      const normalized = normalizePeerUrl(url);
      if (!normalized) continue;
      rememberDiscoveredPeer(normalized, { source: 'gossip', quiet: true, peerIdentity });
      if (ttl > 1 && peerReachabilityCache.get(normalized)?.ok) {
        discovered.push(normalized);
      }
    }
    if (ttl > 1 && discovered.length > 0) {
      gossipAnnounce(discovered, { ttl: ttl - 1, gossipId });
    }
  }

  function gossipAnnounce(peerUrls, options = {}) {
    const { ttl = PEER_GOSSIP_TTL, gossipId: existingGossipId } = options;
    const settings = getLedgerNetworkSettings();
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    const entries = Array.isArray(peerUrls) ? peerUrls : [peerUrls];
    const normalizedEntries = [];
    for (const entry of entries) {
      const url = typeof entry === 'string' ? entry : (entry && entry.url) || '';
      const normalized = normalizePeerUrl(url);
      if (!normalized || isSelfPeerUrl(normalized)) continue;
      normalizedEntries.push(normalized);
    }
    if (normalizedEntries.length === 0) return;
    const gossipId = existingGossipId || crypto.randomBytes(8).toString('hex');
    const dedupKey = `${gossipId}`;
    if (ttl > 1 && peerGossipSeen.has(dedupKey)) return;
    if (ttl > 1) peerGossipSeen.set(dedupKey, Date.now());
    const targets = peerUtils.pickPeerExchangeTargets(getPeerDirectoryTargets(settings), PEER_GOSSIP_FANOUT);
    const payload = { peers: normalizedEntries.map((url) => ({ url })), ttl, gossipId };
    for (const targetUrl of targets) {
      requestPeerJson(targetUrl, 'POST', '/api/v1/network/gossip', payload, undefined, {
        timeoutMs: 4000,
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'gossip-send',
      }).catch(() => {});
    }
  }

  function scheduleWtcPeerSync(reason, delayMs = WTC_PEER_SYNC_DEBOUNCE_MS) {
    const settings = getLedgerNetworkSettings();
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    const normalizedReason = String(reason || 'scheduled');
    wtcPeerSyncPendingReasonRef.current = wtcPeerSyncPendingReasonRef.current
      ? `${wtcPeerSyncPendingReasonRef.current},${normalizedReason}`
      : normalizedReason;
    if (wtcPeerSyncDebounceTimerRef.current) return;
    wtcPeerSyncDebounceTimerRef.current = setTimeout(
      async () => {
        const pendingReason = wtcPeerSyncPendingReasonRef.current || normalizedReason;
        wtcPeerSyncPendingReasonRef.current = '';
        wtcPeerSyncDebounceTimerRef.current = null;
        await runWtcPeerSync(`debounced:${pendingReason}`);
      },
      Math.max(0, Number(delayMs) || 0),
    );
  }

  function handlePeerTipSignal(peerUrl, tip = null, source = 'tip-probe') {
    const wtcNode = getWtcNode();
    rememberDiscoveredPeer(peerUrl, { source, quiet: true });
    const remoteHeight = Number(tip && tip.height);
    const localHeight = wtcNode && typeof wtcNode.getHeight === 'function' ? Number(wtcNode.getHeight()) : Number.NaN;
    if (Number.isFinite(remoteHeight) && Number.isFinite(localHeight) && remoteHeight > localHeight) {
      scheduleWtcPeerSync(`${source}-higher-tip`, 250);
    }
  }

  function buildPushChainPayload(windowSize = 200) {
    const wtcNode = getWtcNode();
    if (!wtcNode || typeof wtcNode.handleGetBlocks !== 'function' || typeof wtcNode.getHeight !== 'function') {
      return null;
    }
    const tipHeight = Number(wtcNode.getHeight());
    if (!Number.isFinite(tipHeight) || tipHeight < 0) return null;
    const fromHeight = Math.max(0, tipHeight - Math.max(1, Number(windowSize) || 1) + 1);
    const response = wtcNode.handleGetBlocks(fromHeight, windowSize);
    const blocks = response && Array.isArray(response.blocks) ? response.blocks : [];
    if (blocks.length === 0) return null;
    return {
      ancestorHeight: fromHeight - 1,
      blocks,
    };
  }

  function pushChainToPeers({ windowSize = 200 } = {}) {
    const settings = getLedgerNetworkSettings();
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    const payload = buildPushChainPayload(windowSize);
    if (!payload) return;
    const peers = Array.from(new Set(getPeerDirectoryTargets(settings).filter((peerUrl) => !isSelfPeerUrl(peerUrl))));
    for (const peerUrl of peers) {
      requestPeerJson(peerUrl, 'POST', '/api/v1/chain/push', payload, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'chain-push',
      }).catch(() => {});
    }
  }

  function announceTipToPeers({ height, hash }) {
    const settings = getLedgerNetworkSettings();
    if (!settings || !settings.enabled || settings.mode !== 'peer') return;
    const payload = {
      height: Number(height) || 0,
      hash: String(hash || '').trim(),
      announcedAtMs: Date.now(),
    };
    const peers = Array.from(new Set(getPeerDirectoryTargets(settings).filter((peerUrl) => !isSelfPeerUrl(peerUrl))));
    for (const peerUrl of peers) {
      requestPeerJson(peerUrl, 'POST', '/api/v1/chain/tip', payload, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'tip-announcement',
      }).catch(() => {});
    }
  }

  function startWtcPeerSyncLoop() {
    if (wtcPeerSyncTimerRef.current) return;
    setTimeout(async () => {
      await runWtcPeerSync('initial');
      await refreshWalletSyncState('peer-sync-initial', { force: true });
    }, 5_000);
    wtcPeerSyncTimerRef.current = setInterval(async () => {
      await runWtcPeerSync('periodic');
      await refreshWalletSyncState('peer-sync-periodic');
    }, WTC_PEER_SYNC_INTERVAL_MS);
  }

  function stopWtcPeerSyncLoop() {
    if (!wtcPeerSyncTimerRef.current) return;
    clearInterval(wtcPeerSyncTimerRef.current);
    wtcPeerSyncTimerRef.current = null;
  }

  return {
    runWtcPeerSync,
    attemptHolePunchToSeedPeers,
    tryHolePunchToPeers,
    _prunePeerGossipSeen,
    receivePeerGossip,
    gossipAnnounce,
    scheduleWtcPeerSync,
    handlePeerTipSignal,
    buildPushChainPayload,
    pushChainToPeers,
    announceTipToPeers,
    startWtcPeerSyncLoop,
    stopWtcPeerSyncLoop,
  };
}

module.exports = { createWtcChainSync };
