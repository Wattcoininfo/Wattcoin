const http = require('http');
const https = require('https');

module.exports = function createPeerHttp(deps) {
  const {
    peerGossipTopology,
    discoveredPeers,
    peerReachabilityCache,
    peerChainTipCache,
    peerChainTipInflight,
    reverseTunnelSessions,
    peerUtils,
    normalizePeerUrl,
    isReverseTunnelPeerUrl,
    isPeerIdentitySelfReference,
    isPeerUrlBanned,
    getLedgerNetworkSettings,
    resolvePeerRequestBaseUrl,
    recordPeerUrlSuccess,
    recordPeerUrlFailure,
    forgetPeerUrlState,
    rememberDiscoveredPeer,
    getPeerProtocolInfo,
    buildPeerAnnouncementHeaders,
    getLocalPeerIdentity,
    GOSSIP_STALE_MS,
    GOSSIP_BROADCAST_INTERVAL_MS,
    GOSSIP_MAX_CONNECTIONS_PER_PEER,
    PEER_CHAIN_TIP_CACHE_MS,
  } = deps;

  const peerAgents = new Map();
  let peerGossipBroadcastTimer = null;

  function handleIncomingGossip(senderIdentity, body) {
    if (!body || !body.sender || !Array.isArray(body.connectedPeers)) return;
    const sender = String(body.sender).trim();
    if (!peerUtils.isValidPeerIdentity(sender)) return;
    if (isPeerIdentitySelfReference(sender, '')) return;
    const connected = body.connectedPeers
      .map((id) => String(id || '').trim())
      .filter((id) => peerUtils.isValidPeerIdentity(id) && id !== sender)
      .slice(0, GOSSIP_MAX_CONNECTIONS_PER_PEER);
    const now = Date.now();
    peerGossipTopology.set(sender, { connectedIds: new Set(connected), lastReceivedMs: now });
    for (const [id, info] of peerGossipTopology) {
      if (now - info.lastReceivedMs > GOSSIP_STALE_MS) {
        peerGossipTopology.delete(id);
      }
    }
  }

  async function broadcastOurTopology() {
    const ourIdentity = getLocalPeerIdentity();
    if (!ourIdentity) return;
    const connectedPeers = [];
    const seenIds = new Set();
    for (const [url, info] of discoveredPeers) {
      const reachable = peerReachabilityCache.get(url);
      if (!reachable || !reachable.ok) continue;
      const id = String(info.peerIdentity || '').trim();
      if (!id || !peerUtils.isValidPeerIdentity(id) || id === ourIdentity || seenIds.has(id)) continue;
      seenIds.add(id);
      connectedPeers.push(id);
    }
    for (const [, session] of reverseTunnelSessions) {
      if (!session || !session.peerIdentity || !session.socket || session.socket.readyState !== 1) continue;
      const id = String(session.peerIdentity).trim();
      if (!id || !peerUtils.isValidPeerIdentity(id) || id === ourIdentity || seenIds.has(id)) continue;
      seenIds.add(id);
      connectedPeers.push(id);
    }
    const payload = { sender: ourIdentity, connectedPeers, timestamp: Date.now() };
    const sendPromises = [];
    for (const [url] of discoveredPeers) {
      const reachable = peerReachabilityCache.get(url);
      if (!reachable || !reachable.ok) continue;
      if (isPeerIdentitySelfReference(ourIdentity, url)) continue;
      sendPromises.push(
        requestPeerJson(url, 'POST', '/api/v1/peers/gossip', payload, {}, { trackReachability: false }).catch(() => {}),
      );
    }
    await Promise.allSettled(sendPromises);
  }

  function startGossipBroadcastLoop() {
    if (peerGossipBroadcastTimer) return;
    setTimeout(() => broadcastOurTopology().catch(() => {}), 30_000);
    peerGossipBroadcastTimer = setInterval(() => broadcastOurTopology().catch(() => {}), GOSSIP_BROADCAST_INTERVAL_MS);
  }

  function stopGossipBroadcastLoop() {
    if (!peerGossipBroadcastTimer) return;
    clearInterval(peerGossipBroadcastTimer);
    peerGossipBroadcastTimer = null;
  }

  function verifyChainPeerCompatibility(req) {
    const expected = getPeerProtocolInfo();
    const suppliedNetwork = String(req.headers['x-wtc-network-id'] || '').trim();
    const suppliedVersion = String(req.headers['x-wtc-protocol-version'] || '').trim();
    const suppliedGenesis = String(req.headers['x-wtc-genesis-hash'] || '').trim();

    if (!suppliedNetwork || suppliedNetwork !== expected.networkId) {
      return { ok: false, reason: 'network mismatch' };
    }
    if (!suppliedVersion || suppliedVersion !== String(expected.protocolVersion)) {
      return { ok: false, reason: 'protocol version mismatch' };
    }
    if (expected.genesisHash && (!suppliedGenesis || suppliedGenesis !== expected.genesisHash)) {
      return { ok: false, reason: 'genesis hash mismatch' };
    }
    return { ok: true };
  }

  function getPeerAgent(hostname, port, httpsTransport) {
    const key = `${hostname}:${port}`;
    let agent = peerAgents.get(key);
    if (!agent) {
      const AgentClass = httpsTransport ? https.Agent : http.Agent;
      agent = new AgentClass({
        keepAlive: true,
        keepAliveMsecs: 30_000,
        maxSockets: 8,
        maxFreeSockets: 4,
        scheduling: 'fifo',
      });
      peerAgents.set(key, agent);
    }
    return agent;
  }

  function requestPeerJson(peerUrl, method, routePath, payload, query = {}, options = {}) {
    return new Promise((resolve, reject) => {
      if (isPeerUrlBanned(peerUrl)) {
        reject(new Error(`Peer is temporarily banned: ${peerUrl}`));
        return;
      }
      const settings = getLedgerNetworkSettings();
      let base;
      try {
        base = new URL(peerUrl);
        if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('bad protocol');
      } catch (_) {
        reject(new Error(`Invalid peer URL: ${peerUrl}`));
        return;
      }

      const relativeRoutePath = String(routePath || '').replace(/^\/+/, '');
      const normalizedRoutePath = `/${relativeRoutePath}`;
      const basePath = base.pathname && base.pathname !== '/' ? `${base.pathname.replace(/\/+$/, '')}/` : '/';
      const resolvedBase = resolvePeerRequestBaseUrl(base, settings);
      const fullUrl = new URL(relativeRoutePath, `${resolvedBase.origin}${basePath}`);
      for (const [key, value] of Object.entries(query || {})) {
        if (value === undefined || value === null || value === '') continue;
        fullUrl.searchParams.set(key, String(value));
      }

      const normalizedPeerUrl = normalizePeerUrl(peerUrl);
      const trackReachability = options && options.trackReachability !== false;
      const isChainTipProbe =
        method === 'GET' &&
        normalizedRoutePath === '/api/v1/chain/tip' &&
        Object.keys(query || {}).length === 0 &&
        payload === undefined;
      if (isChainTipProbe && normalizedPeerUrl) {
        const cached = peerChainTipCache.get(normalizedPeerUrl);
        if (cached && Number(cached.expiresAtMs || 0) > Date.now() && cached.value) {
          if (trackReachability) {
            recordPeerUrlSuccess(normalizedPeerUrl);
          }
          resolve(cached.value);
          return;
        }
        const inflight = peerChainTipInflight.get(normalizedPeerUrl);
        if (inflight) {
          inflight.then(resolve).catch(reject);
          return;
        }
      }

      const isHttps = fullUrl.protocol === 'https:';
      const transport = isHttps ? https : http;
      const body = payload !== undefined ? JSON.stringify(payload) : '';
      const protocolInfo = getPeerProtocolInfo();
      const announcementHeaders = buildPeerAnnouncementHeaders(settings);
      const localPeerIdentity = getLocalPeerIdentity();
      const requestPromise = new Promise((requestResolve, requestReject) => {
        const request = transport.request(
          {
            method,
            protocol: fullUrl.protocol,
            hostname: fullUrl.hostname,
            port: fullUrl.port || (isHttps ? 443 : 80),
            path: `${fullUrl.pathname}${fullUrl.search}`,
            timeout: Math.max(1000, Number(options && options.timeoutMs) || settings.requestTimeoutMs),
            agent: getPeerAgent(fullUrl.hostname, fullUrl.port || (isHttps ? 443 : 80), isHttps),
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Length': Buffer.byteLength(body),
              'x-wtc-network-id': protocolInfo.networkId,
              'x-wtc-protocol-version': String(protocolInfo.protocolVersion),
              ...(protocolInfo.genesisHash ? { 'x-wtc-genesis-hash': protocolInfo.genesisHash } : {}),
              ...(localPeerIdentity ? { 'x-wtc-peer-identity': localPeerIdentity } : {}),
              ...(settings.authToken ? { 'x-wattcoin-ledger-token': settings.authToken } : {}),
              ...announcementHeaders,
            },
          },
          (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
              try {
                const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (res.statusCode >= 400) {
                  const msg = parsed && parsed.message ? parsed.message : `HTTP ${res.statusCode}`;
                  const isUnavailableReverseTunnel =
                    normalizedPeerUrl &&
                    isReverseTunnelPeerUrl(normalizedPeerUrl) &&
                    parsed &&
                    parsed.code === 'REVERSE_TUNNEL_UNAVAILABLE';
                  if (isUnavailableReverseTunnel) {
                    forgetPeerUrlState(normalizedPeerUrl);
                  }
                  if (trackReachability) {
                    if (!isUnavailableReverseTunnel) {
                      recordPeerUrlFailure(peerUrl, `http-${res.statusCode}`);
                    }
                  }
                  requestReject(new Error(msg));
                } else {
                  if (trackReachability) {
                    recordPeerUrlSuccess(peerUrl);
                  }
                  if (trackReachability && (!options || options.suppressPeerDiscovery !== true)) {
                    rememberDiscoveredPeer(peerUrl, {
                      source: String((options && options.source) || 'peer-contact'),
                      quiet: true,
                    });
                  }
                  requestResolve(parsed);
                }
              } catch (_) {
                if (trackReachability) {
                  recordPeerUrlFailure(peerUrl, 'invalid-json');
                }
                requestReject(new Error('Invalid JSON from peer'));
              }
            });
          },
        );
        request.on('socket', (socket) => {
          socket.setKeepAlive(true, 10000);
          socket.setNoDelay(true);
        });
        request.on('timeout', () => {
          request.destroy(new Error('Peer request timed out.'));
        });
        request.on('error', (err) => {
          if (trackReachability) {
            recordPeerUrlFailure(peerUrl, err && err.message ? err.message : 'request-error');
          }
          requestReject(err);
        });
        request.write(body);
        request.end();
      });

      if (isChainTipProbe && normalizedPeerUrl) {
        peerChainTipInflight.set(normalizedPeerUrl, requestPromise);
        requestPromise
          .then((value) => {
            peerChainTipCache.set(normalizedPeerUrl, {
              expiresAtMs: Date.now() + PEER_CHAIN_TIP_CACHE_MS,
              value,
            });
            peerChainTipInflight.delete(normalizedPeerUrl);
          })
          .catch(() => {
            peerChainTipCache.delete(normalizedPeerUrl);
            peerChainTipInflight.delete(normalizedPeerUrl);
          });
      }

      requestPromise.then(resolve).catch(reject);
    });
  }

  return {
    requestPeerJson,
    getPeerAgent,
    handleIncomingGossip,
    broadcastOurTopology,
    startGossipBroadcastLoop,
    stopGossipBroadcastLoop,
    verifyChainPeerCompatibility,
  };
};
