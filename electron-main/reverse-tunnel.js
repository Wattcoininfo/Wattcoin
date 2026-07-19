'use strict';

const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');

function createReverseTunnel(ctx) {
  const {
    reverseTunnelSessions,
    reverseTunnelSessionsByPeerIdentity,
    reverseTunnelPendingResponses,
    reverseTunnelClientState,
    relayWorkerConns,
    probePushConns,
    workerIsMining,
    cancelPendingPeerProbesForWorker,
    handleWorkerBusy,
    handleWsProbeResult,
    getConfiguredAdvertisedPeerUrls,
    isPublicPeerHost,
    normalizePeerUrl,
    getPeerDirectoryTargets,
    getLedgerNetworkSettings,
    sendJson,
    forgetDiscoveredPeer,
    rememberDiscoveredPeer,
    scheduleWtcPeerSync,
    forgetDiscoveredPeersByIdentity,
    refreshPeerDirectory,
    writeStartupTrace,
    obfuscatePublicPeerUrl,
    isSelfPeerUrl,
    isLocallyServedReverseTunnelPeerUrl,
    buildPeerAnnouncementHeaders,
    getPeerProtocolInfo,
    getLocalPeerHosts,
    verifyChainPeerCompatibility,
    getLocalPeerIdentity,
    peerUtils,
    sanitizeForwardedTunnelHeaders,
    updateWorkerRtt,
    forgetPeerUrlState,
    crypto,
    ledgerNetworkServerRef,
    probePushWssRef,
    clearProbePushTimer,
    runProbePush,
    REVERSE_TUNNEL_CONNECT_TIMEOUT_MS,
    REVERSE_TUNNEL_REQUEST_TIMEOUT_MS,
    REVERSE_TUNNEL_MAX_PENDING,
    REVERSE_TUNNEL_RECONNECT_BASE_MS,
    REVERSE_TUNNEL_RECONNECT_MAX_MS,
    REVERSE_TUNNEL_PING_INTERVAL_MS,
    REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
  } = ctx;

  let reverseTunnelWss = null;

  function getReverseTunnelCoordinatorBaseUrl(req, settings = getLedgerNetworkSettings()) {
    const advertisedUrls = getConfiguredAdvertisedPeerUrls(settings);
    const publicAdvertisedUrl = advertisedUrls.find((candidate) => {
      try {
        const parsed = new URL(candidate);
        return isPublicPeerHost(parsed.hostname) && !parsed.pathname.startsWith('/api/v1/tunnel/');
      } catch (_) {
        return false;
      }
    });
    if (publicAdvertisedUrl) return publicAdvertisedUrl;
    const host = String((req && req.headers && req.headers.host) || '').trim();
    if (!host) return '';
    return normalizePeerUrl(`http://${host}`);
  }

  function buildReverseTunnelCoordinatorCandidates(settings = getLedgerNetworkSettings()) {
    const candidates = [];
    for (const peerUrl of getPeerDirectoryTargets(settings)) {
      try {
        const parsed = new URL(peerUrl);
        if (!isPublicPeerHost(parsed.hostname)) continue;
        if (parsed.pathname && parsed.pathname !== '/') continue;
        candidates.push(normalizePeerUrl(peerUrl));
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }
    return Array.from(new Set(candidates.filter(Boolean)));
  }

  function chooseReverseTunnelCoordinator(settings = getLedgerNetworkSettings()) {
    const configuredCoordinator = normalizePeerUrl(settings && settings.coordinatorUrl);
    if (configuredCoordinator) return configuredCoordinator;
    const candidates = buildReverseTunnelCoordinatorCandidates(settings);
    if (candidates.length === 0) return '';
    if (!reverseTunnelClientState.rotateCoordinatorOnNextAttempt) {
      return candidates[0];
    }
    const previousCoordinator = normalizePeerUrl(reverseTunnelClientState.coordinatorUrl);
    const previousIndex = previousCoordinator ? candidates.indexOf(previousCoordinator) : -1;
    if (previousIndex < 0) return candidates[0];
    return candidates[(previousIndex + 1) % candidates.length];
  }

  function cleanupReverseTunnelPendingRequest(requestId) {
    const pending = reverseTunnelPendingResponses.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    reverseTunnelPendingResponses.delete(requestId);
  }

  function failReverseTunnelPendingRequestsForSession(session, reason = 'Reverse tunnel disconnected.') {
    for (const [requestId, pending] of reverseTunnelPendingResponses.entries()) {
      if (!pending || pending.tunnelId !== session.tunnelId) continue;
      cleanupReverseTunnelPendingRequest(requestId);
      if (!pending.res.headersSent) {
        sendJson(pending.res, 502, { ok: false, code: 'REVERSE_TUNNEL_DOWN', message: reason });
      }
    }
  }

  function destroyReverseTunnelSession(session, reason = 'closed') {
    if (!session) return;
    reverseTunnelSessions.delete(session.tunnelId);
    if (session.peerIdentity) {
      const mapped = reverseTunnelSessionsByPeerIdentity.get(session.peerIdentity);
      if (mapped === session) {
        reverseTunnelSessionsByPeerIdentity.delete(session.peerIdentity);
      }
    }
    if (reason === 'replaced' || reason === 'stopped') {
      forgetDiscoveredPeer(session.publicUrl);
    } else if (session.publicUrl) {
      rememberDiscoveredPeer(session.publicUrl, {
        source: 'managed-tunnel',
        quiet: true,
        seenAtMs: Math.max(0, Number(session.lastSeenAtMs) || Date.now()),
        peerIdentity: session.peerIdentity || '',
      });
      scheduleWtcPeerSync(`managed-reverse-tunnel-${reason}`, 150);
    }
    failReverseTunnelPendingRequestsForSession(session, `Reverse tunnel ${reason}.`);
    const relayed = relayWorkerConns.get(session.tunnelId);
    if (relayed) {
      for (const [, ws] of relayed) {
        try {
          ws.close();
        } catch (_) {
          /* ignore */
        }
      }
      relayWorkerConns.delete(session.tunnelId);
    }
    try {
      clearInterval(session.pingTimer);
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    try {
      session.socket.close();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function getReverseTunnelPeerIdentity(req) {
    const headerValue = String(req && req.headers ? req.headers['x-wtc-peer-identity'] || '' : '').trim();
    return peerUtils.isValidPeerIdentity(headerValue) ? headerValue : '';
  }

  function handleReverseTunnelResponseMessage(session, message) {
    const requestId = String((message && message.requestId) || '').trim();
    const pending = reverseTunnelPendingResponses.get(requestId);
    if (!pending || pending.tunnelId !== session.tunnelId) return;
    cleanupReverseTunnelPendingRequest(requestId);
    const statusCode = Math.max(100, Number(message && message.statusCode) || 500);
    const headers =
      message && typeof message.headers === 'object' && message.headers
        ? message.headers
        : { 'content-type': 'application/json; charset=utf-8' };
    const bodyBuffer =
      message && message.bodyBase64 ? Buffer.from(String(message.bodyBase64), 'base64') : Buffer.alloc(0);
    pending.res.writeHead(statusCode, headers);
    pending.res.end(bodyBuffer);
  }

  function handleReverseTunnelSocketMessage(session, rawMessage) {
    let message = null;
    try {
      message = JSON.parse(String(rawMessage || ''));
    } catch (_) {
      return;
    }
    if (!message || typeof message !== 'object') return;
    session.lastSeenAtMs = Date.now();
    if (session.publicUrl) {
      rememberDiscoveredPeer(session.publicUrl, {
        source: 'managed-tunnel',
        quiet: true,
        seenAtMs: session.lastSeenAtMs,
        peerIdentity: session.peerIdentity || '',
      });
    }
    if (message.type === 'pong' || message.type === 'ping' || message.type === 'tunnel-ready') {
      if (session.publicUrl) {
        rememberDiscoveredPeer(session.publicUrl, {
          source: 'managed-tunnel',
          quiet: true,
          seenAtMs: Date.now(),
          peerIdentity: session.peerIdentity || '',
        });
      }
      return;
    }
    if (message.type === 'http-response') {
      handleReverseTunnelResponseMessage(session, message);
      return;
    }
    if (message.type === 'relay-ws-data') {
      const workerId = String(message.workerId || '');
      const dataBase64 = String(message.dataBase64 || '');
      const relays = relayWorkerConns.get(session.tunnelId);
      if (relays) {
        const ws = relays.get(workerId);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(Buffer.from(dataBase64, 'base64'));
        }
      }
      return;
    }
    if (message.type === 'relay-ws-close') {
      const workerId = String(message.workerId || '');
      const relays = relayWorkerConns.get(session.tunnelId);
      if (relays) {
        const ws = relays.get(workerId);
        if (ws) {
          relays.delete(workerId);
          try {
            ws.close();
          } catch (_) {
            /* ignore */
          }
        }
      }
      return;
    }
  }

  async function handleReverseTunnelHttpRequest(req, res, _settings) {
    const segments = String(req.url || '')
      .split('?')[0]
      .split('/')
      .filter(Boolean);
    const tunnelId = segments[3] ? decodeURIComponent(segments[3]) : '';
    const session = reverseTunnelSessions.get(tunnelId);
    if (!session || session.socket.readyState !== WebSocket.OPEN) {
      sendJson(res, 502, { ok: false, code: 'REVERSE_TUNNEL_UNAVAILABLE', message: 'Tunnel session unavailable.' });
      return true;
    }
    if (reverseTunnelPendingResponses.size >= REVERSE_TUNNEL_MAX_PENDING) {
      sendJson(res, 503, { ok: false, code: 'REVERSE_TUNNEL_BUSY', message: 'Tunnel is temporarily busy.' });
      return true;
    }
    const proxiedPath = `/${segments.slice(4).join('/')}${new URL(req.url || '/', 'http://127.0.0.1').search}`;
    if (!proxiedPath.startsWith('/api/v1/')) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Ledger endpoint not found.' });
      return true;
    }
    const requestId = crypto.randomBytes(12).toString('hex');
    const bodyBuffer = await peerUtils.readRequestBodyBuffer(req);
    const forwardedHeaders = {
      'content-type': String(req.headers['content-type'] || 'application/json; charset=utf-8'),
      'x-wtc-network-id': String(req.headers['x-wtc-network-id'] || ''),
      'x-wtc-protocol-version': String(req.headers['x-wtc-protocol-version'] || ''),
      'x-wtc-genesis-hash': String(req.headers['x-wtc-genesis-hash'] || ''),
      'x-wtc-peer-identity': String(req.headers['x-wtc-peer-identity'] || ''),
      'x-wtc-peer-port': String(req.headers['x-wtc-peer-port'] || ''),
      'x-wtc-peer-urls': String(req.headers['x-wtc-peer-urls'] || ''),
      'x-wtc-via-tunnel': '1',
      'x-wattcoin-ledger-token': String(req.headers['x-wattcoin-ledger-token'] || ''),
    };
    reverseTunnelPendingResponses.set(requestId, {
      tunnelId,
      res,
      timer: setTimeout(() => {
        cleanupReverseTunnelPendingRequest(requestId);
        if (!res.headersSent) {
          sendJson(res, 504, {
            ok: false,
            code: 'REVERSE_TUNNEL_TIMEOUT',
            message: 'Reverse tunnel request timed out.',
          });
        }
      }, REVERSE_TUNNEL_REQUEST_TIMEOUT_MS),
    });
    session.socket.send(
      JSON.stringify({
        type: 'http-request',
        requestId,
        method: String(req.method || 'GET').toUpperCase(),
        path: proxiedPath,
        headers: forwardedHeaders,
        bodyBase64: bodyBuffer.toString('base64'),
      }),
    );
    return true;
  }

  function startReverseTunnelCoordinator(settings = getLedgerNetworkSettings()) {
    if (!ledgerNetworkServerRef.current || reverseTunnelWss) return;
    reverseTunnelWss = new WebSocketServer({ noServer: true });
    reverseTunnelWss.on('connection', (socket, req) => {
      const tunnelId = crypto.randomBytes(16).toString('hex');
      const coordinatorBaseUrl = getReverseTunnelCoordinatorBaseUrl(req, settings);
      const publicUrl = peerUtils.buildReverseTunnelPublicUrl(coordinatorBaseUrl, tunnelId);
      const peerIdentity = getReverseTunnelPeerIdentity(req);
      const localPeerIdentity = getLocalPeerIdentity();
      if (peerIdentity && localPeerIdentity && peerIdentity === localPeerIdentity) {
        console.log(`[ReverseTunnel] Rejecting self-connecting tunnel from ${peerIdentity}`);
        try {
          socket.close();
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
        return;
      }
      if (peerIdentity) {
        const previousSession = reverseTunnelSessionsByPeerIdentity.get(peerIdentity);
        if (previousSession) {
          console.log(`[ReverseTunnel] Replacing stale tunnel session for ${peerIdentity}`);
          destroyReverseTunnelSession(previousSession, 'replaced');
        }
      }
      const session = {
        tunnelId,
        publicUrl,
        peerIdentity,
        socket,
        connectedAtMs: Date.now(),
        lastSeenAtMs: Date.now(),
        pingTimer: setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          try {
            socket.send(JSON.stringify({ type: 'ping', nowMs: Date.now() }));
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
          }
        }, REVERSE_TUNNEL_PING_INTERVAL_MS),
      };
      reverseTunnelSessions.set(tunnelId, session);
      if (peerIdentity) {
        reverseTunnelSessionsByPeerIdentity.set(peerIdentity, session);
      }
      rememberDiscoveredPeer(publicUrl, {
        source: 'managed-tunnel',
        quiet: true,
        peerIdentity,
      });
      if (peerIdentity) {
        forgetDiscoveredPeersByIdentity(peerIdentity, { keepUrl: publicUrl });
      }
      socket.on('message', (message) => handleReverseTunnelSocketMessage(session, message));
      socket.on('close', () => destroyReverseTunnelSession(session, 'closed'));
      socket.on('error', () => destroyReverseTunnelSession(session, 'errored'));
      socket.send(JSON.stringify({ type: 'tunnel-ready', tunnelId, publicUrl }));
      refreshPeerDirectory(getLedgerNetworkSettings()).catch(() => {});
    });
    ledgerNetworkServerRef.current.on('upgrade', (req, socket, head) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

        if (reqUrl.pathname === '/api/v1/probe/push') {
          const workerId = String(reqUrl.searchParams.get('workerId') || 'unknown');
          const allowGpu = reqUrl.searchParams.get('allowGpu') === 'true';
          const hasAsic = reqUrl.searchParams.get('hasAsic') === 'true';
          const gpuPowCapable = reqUrl.searchParams.get('gpuPowCapable') === 'true';
          if (!probePushWssRef.current) {
            probePushWssRef.current = new WebSocketServer({ noServer: true });
          }
          probePushWssRef.current.handleUpgrade(req, socket, head, (ws) => {
            const existing = probePushConns.get(workerId);
            if (existing) {
              try {
                existing.ws.close();
              } catch (_) {
                /* ws already closed */
              }
            }
            const hadWorkers = probePushConns.size > 0;
            probePushConns.set(workerId, { ws, allowGpu, hasAsic, gpuPowCapable });
            workerIsMining.set(workerId, null);
            const _pendingMiningTimeout = setTimeout(() => {
              if (workerIsMining.get(workerId) === null) {
                workerIsMining.delete(workerId);
              }
            }, 5000);
            ws._pendingMiningTimeout = _pendingMiningTimeout;
            if (!hadWorkers) {
              clearProbePushTimer();
              runProbePush();
            }
            const dropWorker = (id) => {
              clearInterval(ws._probePushPingInterval);
              if (ws._pendingMiningTimeout) {
                clearTimeout(ws._pendingMiningTimeout);
                ws._pendingMiningTimeout = null;
              }
              if (probePushConns.get(id) && probePushConns.get(id).ws === ws) {
                probePushConns.delete(id);
              }
              workerIsMining.delete(id);
            };
            ws.on('close', () => dropWorker(workerId));
            ws.on('error', () => dropWorker(workerId));
            const PROBE_PUSH_MAX_MISSED_PONGS = 2;
            try {
              if (ws._socket) ws._socket.setKeepAlive(true, 15000);
            } catch (_) {
              /* ignore */
            }
            ws.isAlive = true;
            ws._probePushMissedPongs = 0;
            ws.on('pong', () => {
              ws.isAlive = true;
              if (ws._pingSentAt) {
                const rtt = Date.now() - ws._pingSentAt;
                ws._pingSentAt = 0;
                ws._smoothedRttMs = ws._smoothedRttMs ? Math.round(ws._smoothedRttMs * 0.7 + rtt * 0.3) : rtt;
                updateWorkerRtt(workerId, ws._smoothedRttMs);
              }
            });
            ws.on('message', (data) => {
              try {
                const msg = JSON.parse(String(data));
                if (msg.type === 'busy' && msg.probeId) {
                  handleWorkerBusy(workerId, msg.probeId);
                } else if (msg.type === 'worker-done') {
                  dropWorker(workerId);
                } else if (msg.type === 'probe-result') {
                  handleWsProbeResult(workerId, msg, ws).catch(() => {});
                } else if (msg.type === 'mining-status') {
                  if (msg.data && typeof msg.data.mining === 'boolean') {
                    workerIsMining.set(workerId, msg.data.mining);
                  }
                }
              } catch (_) {
                /* ignore */
              }
            });
            ws._probePushPingInterval = setInterval(() => {
              if (ws.readyState !== WebSocket.OPEN) {
                clearInterval(ws._probePushPingInterval);
                return;
              }
              if (!ws.isAlive) {
                ws._probePushMissedPongs++;
                if (ws._probePushMissedPongs >= PROBE_PUSH_MAX_MISSED_PONGS) {
                  dropWorker(workerId);
                  ws.terminate();
                  return;
                }
                ws.isAlive = false;
                try {
                  ws._pingSentAt = Date.now();
                  ws.ping();
                } catch (_) {
                  /* ignore */
                }
                return;
              }
              ws._probePushMissedPongs = 0;
              ws.isAlive = false;
              try {
                ws._pingSentAt = Date.now();
                ws.ping();
              } catch (_) {
                /* ignore */
              }
            }, 30_000);
          });
          return;
        }

        const tunnelProbePushMatch = reqUrl.pathname.match(/^\/api\/v1\/tunnel\/([^/]+)\/api\/v1\/probe\/push$/);
        if (tunnelProbePushMatch) {
          const tunnelId = decodeURIComponent(tunnelProbePushMatch[1]);
          const session = reverseTunnelSessions.get(tunnelId);
          if (!session || session.socket.readyState !== WebSocket.OPEN) {
            socket.destroy();
            return;
          }
          const workerId = String(reqUrl.searchParams.get('workerId') || 'unknown');
          const allowGpu = reqUrl.searchParams.get('allowGpu') === 'true';
          const hasAsic = reqUrl.searchParams.get('hasAsic') === 'true';
          if (!probePushWssRef.current) {
            probePushWssRef.current = new WebSocketServer({ noServer: true });
          }
          probePushWssRef.current.handleUpgrade(req, socket, head, (ws) => {
            let tunnelRelays = relayWorkerConns.get(tunnelId);
            if (!tunnelRelays) {
              tunnelRelays = new Map();
              relayWorkerConns.set(tunnelId, tunnelRelays);
            }
            tunnelRelays.set(workerId, ws);
            try {
              session.socket.send(
                JSON.stringify({
                  type: 'relay-ws-open',
                  workerId,
                  allowGpu,
                  hasAsic,
                }),
              );
            } catch (_) {
              /* tunnel closed */
            }
            ws.on('message', (data) => {
              try {
                session.socket.send(
                  JSON.stringify({
                    type: 'relay-ws-data',
                    workerId,
                    dataBase64: Buffer.from(data).toString('base64'),
                  }),
                );
              } catch (_) {
                /* tunnel closed */
              }
            });
            ws.on('close', () => {
              const relays = relayWorkerConns.get(tunnelId);
              if (relays) relays.delete(workerId);
              try {
                session.socket.send(JSON.stringify({ type: 'relay-ws-close', workerId }));
              } catch (_) {
                /* tunnel closed */
              }
            });
            ws.on('error', () => {
              const relays = relayWorkerConns.get(tunnelId);
              if (relays) relays.delete(workerId);
            });
          });
          return;
        }

        if (reqUrl.pathname !== '/api/v1/tunnel/connect') {
          socket.destroy();
          return;
        }
        const compat = verifyChainPeerCompatibility(req);
        if (!compat.ok) {
          console.warn(
            `[ReverseTunnel] Rejected upgrade from ${(req.socket && req.socket.remoteAddress) || 'unknown'}: ${compat.reason}`,
          );
          socket.destroy();
          return;
        }
        reverseTunnelWss.handleUpgrade(req, socket, head, (ws) => {
          reverseTunnelWss.emit('connection', ws, req);
        });
      } catch (_) {
        try {
          socket.destroy();
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
      }
    });
  }

  function stopReverseTunnelCoordinator() {
    for (const session of reverseTunnelSessions.values()) {
      destroyReverseTunnelSession(session, 'stopped');
    }
    reverseTunnelSessions.clear();
    for (const requestId of Array.from(reverseTunnelPendingResponses.keys())) {
      cleanupReverseTunnelPendingRequest(requestId);
    }
    if (reverseTunnelWss) {
      try {
        reverseTunnelWss.close();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      reverseTunnelWss = null;
    }
  }

  function stopManagedReverseTunnelClient() {
    reverseTunnelClientState.connecting = false;
    reverseTunnelClientState.publicUrl = '';
    reverseTunnelClientState.tunnelId = '';
    reverseTunnelClientState.coordinatorUrl = '';
    reverseTunnelClientState.connectedAtMs = 0;
    reverseTunnelClientState.lastSeenAtMs = 0;
    reverseTunnelClientState.reconnectDelayMs = REVERSE_TUNNEL_RECONNECT_BASE_MS;
    if (reverseTunnelClientState.reconnectTimer) {
      clearTimeout(reverseTunnelClientState.reconnectTimer);
      reverseTunnelClientState.reconnectTimer = null;
    }
    if (reverseTunnelClientState.pingTimer) {
      clearInterval(reverseTunnelClientState.pingTimer);
      reverseTunnelClientState.pingTimer = null;
    }
    if (reverseTunnelClientState.socket) {
      try {
        reverseTunnelClientState.socket.close();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      reverseTunnelClientState.socket = null;
    }
    for (const [wid, conn] of probePushConns) {
      if (conn && conn.ws && conn.ws._isRelayWs) {
        probePushConns.delete(wid);
      }
    }
  }

  function scheduleManagedReverseTunnelReconnect() {
    if (reverseTunnelClientState.reconnectTimer) return;
    const delayMs = reverseTunnelClientState.reconnectDelayMs;
    reverseTunnelClientState.rotateCoordinatorOnNextAttempt = true;
    reverseTunnelClientState.reconnectTimer = setTimeout(() => {
      reverseTunnelClientState.reconnectTimer = null;
      ensureManagedReverseTunnelClient();
    }, delayMs);
    reverseTunnelClientState.reconnectDelayMs = Math.min(
      REVERSE_TUNNEL_RECONNECT_MAX_MS,
      Math.max(REVERSE_TUNNEL_RECONNECT_BASE_MS, delayMs * 2),
    );
  }

  async function forwardReverseTunnelRequestToLocalNode(socket, message) {
    const settings = getLedgerNetworkSettings();
    const targetPath = String((message && message.path) || '/').trim() || '/';
    const method = String((message && message.method) || 'GET').toUpperCase();
    const requestId = String((message && message.requestId) || '').trim();
    const bodyBuffer =
      message && message.bodyBase64 ? Buffer.from(String(message.bodyBase64), 'base64') : Buffer.alloc(0);
    const forwardedHeaders = sanitizeForwardedTunnelHeaders(message && message.headers);
    const protocolInfo = getPeerProtocolInfo();
    const requestOptions = {
      method,
      hostname: '127.0.0.1',
      port: settings.listenPort,
      path: targetPath,
      timeout: REVERSE_TUNNEL_REQUEST_TIMEOUT_MS,
      headers: {
        ...forwardedHeaders,
        'Content-Length': Buffer.byteLength(bodyBuffer),
        'x-wtc-network-id': forwardedHeaders['x-wtc-network-id'] || protocolInfo.networkId,
        'x-wtc-protocol-version': forwardedHeaders['x-wtc-protocol-version'] || String(protocolInfo.protocolVersion),
        ...(protocolInfo.genesisHash && !forwardedHeaders['x-wtc-genesis-hash']
          ? { 'x-wtc-genesis-hash': protocolInfo.genesisHash }
          : {}),
      },
    };
    const responsePayload = await new Promise((resolve) => {
      const request = http.request(requestOptions, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: Number(response.statusCode) || 500,
            headers: { 'content-type': String(response.headers['content-type'] || 'application/json; charset=utf-8') },
            bodyBase64: Buffer.concat(chunks).toString('base64'),
          });
        });
      });
      request.on('timeout', () => request.destroy(new Error('Local reverse tunnel request timed out.')));
      request.on('error', (error) => {
        resolve({
          statusCode: 502,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          bodyBase64: Buffer.from(
            JSON.stringify({
              ok: false,
              code: 'REVERSE_TUNNEL_LOCAL_ERROR',
              message: error && error.message ? error.message : 'Local reverse tunnel request failed.',
            }),
            'utf8',
          ).toString('base64'),
        });
      });
      request.write(bodyBuffer);
      request.end();
    });
    try {
      socket.send(JSON.stringify({ type: 'http-response', requestId, ...responsePayload }));
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function createRelayVirtualWs(workerId) {
    const eventHandlers = { message: [], close: [], error: [] };
    const virtualWs = {
      _isRelayWs: true,
      readyState: 1,
      _probePushMissedPongs: 0,
      send: (data) => {
        const ws = reverseTunnelClientState.socket;
        if (ws && ws.readyState === 1) {
          const payload = typeof data === 'string' ? data : String(data);
          try {
            ws.send(
              JSON.stringify({
                type: 'relay-ws-data',
                workerId,
                dataBase64: Buffer.from(payload).toString('base64'),
              }),
            );
          } catch (_) {
            /* tunnel closed */
          }
        }
      },
      close: () => {
        virtualWs.readyState = 3;
        const ws = reverseTunnelClientState.socket;
        if (ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify({ type: 'relay-ws-close', workerId }));
          } catch (_) {
            /* tunnel closed */
          }
        }
      },
      on: (event, handler) => {
        if (eventHandlers[event]) {
          eventHandlers[event].push(handler);
        }
      },
      _emitMessage: (data) => {
        virtualWs.readyState = 1;
        for (const handler of eventHandlers.message) {
          try {
            handler(data);
          } catch (_) {
            /* ignore handler error */
          }
        }
      },
      _emitClose: () => {
        virtualWs.readyState = 3;
        for (const handler of eventHandlers.close) {
          try {
            handler();
          } catch (_) {
            /* ignore handler error */
          }
        }
      },
    };
    return virtualWs;
  }

  function handleManagedReverseTunnelMessage(socket, rawMessage) {
    let message = null;
    try {
      message = JSON.parse(String(rawMessage || ''));
    } catch (_) {
      return;
    }
    if (!message || typeof message !== 'object') return;
    reverseTunnelClientState.lastSeenAtMs = Date.now();
    if (message.type === 'ping') {
      try {
        socket.send(JSON.stringify({ type: 'pong', nowMs: Date.now() }));
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      return;
    }
    if (message.type === 'tunnel-ready') {
      const previousPublicUrl = normalizePeerUrl(reverseTunnelClientState.publicUrl);
      reverseTunnelClientState.tunnelId = String(message.tunnelId || '');
      reverseTunnelClientState.publicUrl = normalizePeerUrl(message.publicUrl);
      if (previousPublicUrl && previousPublicUrl !== reverseTunnelClientState.publicUrl) {
        forgetPeerUrlState(previousPublicUrl);
      }
      reverseTunnelClientState.connectedAtMs = Date.now();
      reverseTunnelClientState.lastSeenAtMs = Date.now();
      reverseTunnelClientState.reconnectDelayMs = REVERSE_TUNNEL_RECONNECT_BASE_MS;
      writeStartupTrace('reverse-tunnel.ready', {
        tunnelId: reverseTunnelClientState.tunnelId,
        publicUrl: obfuscatePublicPeerUrl(reverseTunnelClientState.publicUrl),
        coordinatorUrl: obfuscatePublicPeerUrl(reverseTunnelClientState.coordinatorUrl),
      });
      console.log(
        `[ReverseTunnel] Reachable via ${obfuscatePublicPeerUrl(reverseTunnelClientState.publicUrl) || 'managed tunnel'}; awaiting a higher compatible peer chain before sync import.`,
      );
      scheduleWtcPeerSync('managed-reverse-tunnel-ready', 150);
      return;
    }
    if (message.type === 'http-request') {
      forwardReverseTunnelRequestToLocalNode(socket, message).catch(() => {});
      return;
    }
    if (message.type === 'relay-ws-open') {
      const workerId = String(message.workerId || '');
      const allowGpu = message.allowGpu === true;
      const hasAsic = message.hasAsic === true;
      const existing = probePushConns.get(workerId);
      if (existing) {
        try {
          existing.ws.close();
        } catch (_) {
          /* ignore */
        }
      }
      const virtualWs = createRelayVirtualWs(workerId);
      probePushConns.set(workerId, { ws: virtualWs, allowGpu, hasAsic });
      workerIsMining.set(workerId, null);
      const _pendingTimeout = setTimeout(() => {
        if (workerIsMining.get(workerId) === null) {
          workerIsMining.delete(workerId);
        }
      }, 5000);
      virtualWs._pendingMiningTimeout = _pendingTimeout;
      virtualWs.on('message', (data) => {
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === 'busy' && msg.probeId) {
            handleWorkerBusy(workerId, msg.probeId);
          } else if (msg.type === 'worker-done') {
            if (virtualWs._pendingMiningTimeout) {
              clearTimeout(virtualWs._pendingMiningTimeout);
              virtualWs._pendingMiningTimeout = null;
            }
            const conn = probePushConns.get(workerId);
            if (conn && conn.ws === virtualWs) {
              probePushConns.delete(workerId);
            }
            workerIsMining.delete(workerId);
            cancelPendingPeerProbesForWorker(workerId);
          } else if (msg.type === 'probe-result') {
            handleWsProbeResult(workerId, msg, virtualWs).catch(() => {});
          } else if (msg.type === 'mining-status') {
            if (msg.data && typeof msg.data.mining === 'boolean') {
              workerIsMining.set(workerId, msg.data.mining);
            }
          }
        } catch (_) {
          /* ignore */
        }
      });
      console.log(`[RelayWS] Worker ${workerId} connected via relay tunnel`);
      return;
    }
    if (message.type === 'relay-ws-data') {
      const workerId = String(message.workerId || '');
      const conn = probePushConns.get(workerId);
      if (conn && conn.ws && conn.ws._isRelayWs) {
        const data = Buffer.from(String(message.dataBase64 || ''), 'base64');
        conn.ws._emitMessage(data);
      }
      return;
    }
    if (message.type === 'relay-ws-close') {
      const workerId = String(message.workerId || '');
      const conn = probePushConns.get(workerId);
      if (conn && conn.ws && conn.ws._isRelayWs) {
        if (conn.ws._pendingMiningTimeout) {
          clearTimeout(conn.ws._pendingMiningTimeout);
          conn.ws._pendingMiningTimeout = null;
        }
        probePushConns.delete(workerId);
        workerIsMining.delete(workerId);
        conn.ws._emitClose();
      }
      return;
    }
  }

  function connectManagedReverseTunnelClient(coordinatorUrl, settings = getLedgerNetworkSettings()) {
    const connectUrl = peerUtils.buildReverseTunnelConnectUrl(coordinatorUrl);
    if (!connectUrl) {
      writeStartupTrace('reverse-tunnel.connect-skipped', {
        reason: 'missing-connect-url',
        coordinatorUrl,
      });
      return false;
    }
    const protocolInfo = getPeerProtocolInfo();
    const localPeerIdentity = getLocalPeerIdentity();
    const headers = {
      ...buildPeerAnnouncementHeaders(settings),
      'x-wtc-network-id': protocolInfo.networkId,
      'x-wtc-protocol-version': String(protocolInfo.protocolVersion),
      ...(localPeerIdentity ? { 'x-wtc-peer-identity': localPeerIdentity } : {}),
      ...(protocolInfo.genesisHash ? { 'x-wtc-genesis-hash': protocolInfo.genesisHash } : {}),
    };
    writeStartupTrace('reverse-tunnel.connecting', {
      coordinatorUrl,
      connectUrl,
      peerIdentity: localPeerIdentity,
      networkId: protocolInfo.networkId,
      protocolVersion: protocolInfo.protocolVersion,
      genesisHash: protocolInfo.genesisHash,
      peerUrls: String(headers['x-wtc-peer-urls'] || ''),
    });
    reverseTunnelClientState.connecting = true;
    reverseTunnelClientState.coordinatorUrl = coordinatorUrl;
    let socket;
    try {
      socket = new WebSocket(connectUrl, { headers, handshakeTimeout: REVERSE_TUNNEL_CONNECT_TIMEOUT_MS });
    } catch (_) {
      reverseTunnelClientState.connecting = false;
      writeStartupTrace('reverse-tunnel.connect-failed', {
        coordinatorUrl,
        connectUrl,
        reason: 'websocket-constructor-failed',
      });
      scheduleManagedReverseTunnelReconnect();
      return false;
    }
    reverseTunnelClientState.socket = socket;
    socket.on('open', () => {
      reverseTunnelClientState.connecting = false;
      writeStartupTrace('reverse-tunnel.open', {
        coordinatorUrl,
        connectUrl,
      });
      reverseTunnelClientState.pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send(JSON.stringify({ type: 'pong', nowMs: Date.now() }));
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
      }, REVERSE_TUNNEL_PING_INTERVAL_MS);
    });
    socket.on('message', (message) => handleManagedReverseTunnelMessage(socket, message));
    socket.on('close', () => {
      writeStartupTrace('reverse-tunnel.closed', {
        coordinatorUrl,
        connectUrl,
      });
      if (reverseTunnelClientState.socket === socket) {
        stopManagedReverseTunnelClient();
        scheduleManagedReverseTunnelReconnect();
      }
    });
    socket.on('error', (error) => {
      writeStartupTrace('reverse-tunnel.error', {
        coordinatorUrl,
        connectUrl,
        message: error && error.message ? error.message : String(error || ''),
      });
      if (reverseTunnelClientState.socket === socket) {
        stopManagedReverseTunnelClient();
        scheduleManagedReverseTunnelReconnect();
      }
    });
    return true;
  }

  function ensureManagedReverseTunnelClient(settings = getLedgerNetworkSettings()) {
    if (!peerUtils.shouldUseManagedReverseTunnel(settings)) {
      writeStartupTrace('reverse-tunnel.disabled', {
        enabled: Boolean(settings && settings.enabled),
        mode: settings && settings.mode,
        explicitAdvertisedPeerUrls: peerUtils.getExplicitAdvertisedPeerUrls(settings),
      });
      stopManagedReverseTunnelClient();
      return;
    }
    if (reverseTunnelClientState.socket || reverseTunnelClientState.connecting) return;
    const coordinatorUrl = chooseReverseTunnelCoordinator(settings);
    if (!coordinatorUrl) {
      writeStartupTrace('reverse-tunnel.connect-skipped', {
        reason: 'missing-coordinator-url',
      });
      scheduleManagedReverseTunnelReconnect();
      return;
    }
    if (isSelfPeerUrl(coordinatorUrl) || isLocallyServedReverseTunnelPeerUrl(coordinatorUrl, settings)) {
      writeStartupTrace('reverse-tunnel.connect-skipped', {
        reason: 'coordinator-is-self',
        coordinatorUrl: obfuscatePublicPeerUrl(coordinatorUrl),
      });
      return;
    }
    try {
      const coordParsed = new URL(coordinatorUrl);
      const coordPort = Number(coordParsed.port || (coordParsed.protocol === 'https:' ? 443 : 80));
      if (coordPort === Number(settings.listenPort) && getLocalPeerHosts().has(coordParsed.hostname)) {
        writeStartupTrace('reverse-tunnel.connect-skipped', {
          reason: 'coordinator-is-local',
          coordinatorUrl: obfuscatePublicPeerUrl(coordinatorUrl),
        });
        return;
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    writeStartupTrace('reverse-tunnel.enabled', {
      coordinatorUrl: obfuscatePublicPeerUrl(coordinatorUrl),
    });
    reverseTunnelClientState.rotateCoordinatorOnNextAttempt = false;
    connectManagedReverseTunnelClient(coordinatorUrl, settings);
  }

  function getActiveReverseTunnelPeerConnectionCount() {
    const { countLiveReverseTunnelPeers } = require('./peer-utils');
    const now = Date.now();
    return countLiveReverseTunnelPeers({
      sessions: reverseTunnelSessions.values(),
      nowMs: now,
      liveThresholdMs: REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
      openState: WebSocket.OPEN,
    });
  }

  return {
    startReverseTunnelCoordinator,
    stopReverseTunnelCoordinator,
    stopManagedReverseTunnelClient,
    ensureManagedReverseTunnelClient,
    handleReverseTunnelHttpRequest,
    getActiveReverseTunnelPeerConnectionCount,
    handleManagedReverseTunnelMessage,
  };
}

module.exports = { createReverseTunnel };
