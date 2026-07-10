'use strict';

const { WebSocket } = require('ws');

function createHandlers(deps) {
  const {
    getLedgerNetworkSettings,
    getOnlineAttestationPeers,
    getActivePeers,
    walletAddressCache,
    getAsicConfigModule,
    findGpuBinary,
    hwAuthority,
    saveHwAuthState,
    roundLedger,
    normalizePeerUrl,
    peerReachabilityCache,
    requestPeerJson,
    _flushPendingContribution,
    getAppDisplayVersion,
    recordPeerAttestation,
    broadcastProbeReceiptToPeers,
    getProbeReceiptSigningPayload,
    attachProbeReceiptSignature,
    getWtcNode,
    submitPeerProbeResult,
    getCurrentNetworkRoundId,
    refreshCoordinatorIdentityKey,
    cancelPendingPeerProbesForWorker,
    issuePeerProbe,
    _probePushConns,
    _workerIsMining,
    _probePushWssRef,
    _PROBE_PUSH_INTERVAL_MAX_MS,
    _pendingContributionWhRef,
    _probePushTimerRef,
  } = deps;

  // -- State ------------------------------------------------------------------
  let _localMiningStatus = deps._localMiningStatus;
  let _pendingProbes = [];
  const _PENDING_PROBES_MAX = 4;
  const _PROBE_TIMEOUT_MS = 100 * 1000;
  const _PROBE_TRUST_WINDOW = 50;
  const _PROBE_FAIL_RATIO_THRESHOLD = 0.3;
  let _probeInProgress = false;
  const _pendingProbeVerdicts = new Map();
  let _probeInProgressId = '';
  let _probeInProgressEpoch = -1;
  let _probeTimeoutTimer = null;
  let _probeEpoch = 0;
  let _probeConns = [];
  let _pendingConns = new Map();
  let _probeConnIdSeq = 0;
  let _connectingProbeWs = false;
  const _PROBE_CONN_TARGET = 3;
  let _allowGpuWorkloads = false;
  let _gpuPowCapable = false;
  const _BG_WS_RECONNECT_MAX_MS = 60_000;

  // -- Internal helpers -------------------------------------------------------

  function _clearProbeTimeoutTimer() {
    if (_probeTimeoutTimer !== null) {
      clearTimeout(_probeTimeoutTimer);
      _probeTimeoutTimer = null;
    }
  }

  function _closeBgProbeWs() {
    for (const [, pending] of _pendingConns) {
      try {
        pending.ws.close();
      } catch (_) {
        /* ignore */
      }
    }
    _pendingConns.clear();
    const conns = _probeConns.slice();
    for (const c of conns) {
      if (c.pingInterval) clearInterval(c.pingInterval);
      try {
        if (c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(JSON.stringify({ type: 'worker-done' }), () => {
            try {
              c.ws.close();
            } catch (_) {
              /* ws already closed */
            }
          });
        } else {
          try {
            c.ws.close();
          } catch (_) {
            /* ws already closed */
          }
        }
      } catch (_) {
        try {
          c.ws.close();
        } catch (_) {
          /* ws already closed */
        }
      }
      c.ws._probePushPingInterval = null;
    }
    _probeConns = [];
    _pendingProbes = [];
    _probeInProgress = false;
    _probeInProgressId = '';
    _probeInProgressEpoch = -1;
    _probeEpoch++;
    _clearProbeTimeoutTimer();
    if (typeof setImmediate === 'function') {
      setImmediate(() => {
        for (const c of conns) {
          try {
            c.ws.terminate();
          } catch (_) {
            /* ws already closed */
          }
        }
      });
    }
  }

  function _scheduleBgProbeWsReconnect() {
    _closeBgProbeWs();
    const delay = Math.round(Math.random() * _BG_WS_RECONNECT_MAX_MS);
    setTimeout(() => {
      _connectBgProbeWs();
    }, delay);
  }

  function _getProbeConnPeerUrls() {
    return new Set(_probeConns.map((c) => c.peerUrl));
  }

  function _removeProbeConn(peerUrl) {
    const idx = _probeConns.findIndex((c) => c.peerUrl === peerUrl);
    if (idx === -1) return;
    const c = _probeConns[idx];
    if (c.pingInterval) clearInterval(c.pingInterval);
    try {
      c.ws.close();
    } catch (_) {
      /* ignore */
    }
    _probeConns.splice(idx, 1);
  }

  function _scheduleProbeConnReplacement() {
    if (_probeConns.length >= _PROBE_CONN_TARGET) return;
    if (_pendingConns.size >= _PROBE_CONN_TARGET) return;
    const delay = Math.round(Math.random() * _BG_WS_RECONNECT_MAX_MS);
    setTimeout(async () => {
      try {
        if (_probeConns.length >= _PROBE_CONN_TARGET) return;
        if (_pendingConns.size >= _PROBE_CONN_TARGET) return;
        const settings = getLedgerNetworkSettings();
        if (!settings.enabled || settings.mode !== 'peer') return;
        const workerId = walletAddressCache.address || 'unknown';
        if (workerId === 'unknown') {
          _scheduleProbeConnReplacement();
          return;
        }
        let peers = await getOnlineAttestationPeers(settings, workerId, {});
        if (!peers || peers.length < _PROBE_CONN_TARGET) {
          const allPeers = getActivePeers(settings);
          if (allPeers.length > 0) {
            const merged = new Set(peers || []);
            for (const p of allPeers) merged.add(p);
            peers = Array.from(merged);
          }
        }
        if (!peers || peers.length === 0) {
          _scheduleProbeConnReplacement();
          return;
        }
        const currentUrls = _getProbeConnPeerUrls();
        for (const [peerUrl] of _pendingConns) currentUrls.add(peerUrl);
        const available = peers.filter((p) => !currentUrls.has(p));
        if (available.length === 0) {
          if (_probeConns.length < _PROBE_CONN_TARGET) {
            setTimeout(() => {
              _scheduleProbeConnReplacement();
            }, _BG_WS_RECONNECT_MAX_MS);
          }
          return;
        }
        _startBgProbeWs(available[Math.floor(Math.random() * available.length)]);
      } catch (_) {
        _scheduleProbeConnReplacement();
      }
    }, delay);
  }

  function _startBgProbeWs(peerUrl) {
    if (_probeConns.some((c) => c.peerUrl === peerUrl)) return;
    _gpuPowCapable = _allowGpuWorkloads && !!findGpuBinary();
    if (_pendingConns.has(peerUrl)) return;
    const connId = ++_probeConnIdSeq;
    const wsUrl = peerUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/api/v1/probe/push';
    const workerId = walletAddressCache.address || 'unknown';
    try {
      const ws = new WebSocket(
        wsUrl +
          '?workerId=' +
          encodeURIComponent(workerId) +
          '&allowGpu=' +
          (_allowGpuWorkloads ? 'true' : 'false') +
          '&hasAsic=' +
          (getAsicConfigModule().length > 0 ? 'true' : 'false') +
          '&gpuPowCapable=' +
          (_gpuPowCapable ? 'true' : 'false'),
      );
      _pendingConns.set(peerUrl, { ws, connId });

      ws.on('open', () => {
        const pending = _pendingConns.get(peerUrl);
        if (!pending || pending.connId !== connId) {
          try {
            ws.close();
          } catch (_) {
            /* ignore */
          }
          return;
        }
        _pendingConns.delete(peerUrl);
        const conn = { ws, connId, peerUrl, pingInterval: null };
        _probeConns.push(conn);
        conn.ws._connectedWorkerId = walletAddressCache.address || 'unknown';
        try {
          ws.send(JSON.stringify({ type: 'mining-status', data: { mining: _localMiningStatus } }));
        } catch (_) {
          /* ignore */
        }
        try {
          if (ws._socket) ws._socket.setKeepAlive(true, 15000);
        } catch (_) {
          /* ignore */
        }
        ws._bgProbeIsAlive = true;
        ws.on('pong', () => {
          ws._bgProbeIsAlive = true;
        });
        conn.pingInterval = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) {
            clearInterval(conn.pingInterval);
            conn.pingInterval = null;
            return;
          }
          if (!ws._bgProbeIsAlive) {
            clearInterval(conn.pingInterval);
            conn.pingInterval = null;
            ws.terminate();
            return;
          }
          ws._bgProbeIsAlive = false;
          try {
            ws.ping();
          } catch (_) {
            /* ignore */
          }
        }, 30_000);
      });

      ws.on('message', (data) => {
        const cur = _probeConns.find((c) => c.peerUrl === peerUrl);
        if (!cur || cur.connId !== connId) return;
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === 'probe' && msg.data && msg.data.probe) {
            const probeId = msg.data.probe.id;
            if (probeId === _probeInProgressId || _pendingProbes.some((p) => p.probe.id === probeId)) {
              if (_probeInProgress) {
                try {
                  ws.send(JSON.stringify({ type: 'busy', probeId }));
                } catch (_) {
                  /* ignore */
                }
              }
              return;
            }
            if (_probeInProgress) {
              try {
                ws.send(JSON.stringify({ type: 'busy', probeId }));
              } catch (_) {
                /* ignore */
              }
              if (_pendingProbes.length >= _PENDING_PROBES_MAX) _pendingProbes.shift();
              msg.data.probe._peerUrl = peerUrl;
              _pendingProbes.push({ probe: msg.data.probe, source: 'peer', peerUrl });
              return;
            }
            msg.data.probe._peerUrl = peerUrl;
            if (_pendingProbes.length >= _PENDING_PROBES_MAX) _pendingProbes.shift();
            _pendingProbes.push({ probe: msg.data.probe, source: 'peer', peerUrl });
          } else if (msg.type === 'probe-verdict') {
            const pending = _pendingProbeVerdicts.get(msg.probeId);
            if (pending) {
              clearTimeout(pending.timer);
              _pendingProbeVerdicts.delete(msg.probeId);
              pending.resolve(msg);
            }
          }
        } catch (_) {
          /* ignore parse errors */
        }
      });

      ws.on('close', () => {
        const wasPending = _pendingConns.delete(peerUrl);
        const cur = _probeConns.find((c) => c.peerUrl === peerUrl);
        if (!cur || cur.connId !== connId) {
          if (wasPending) _scheduleProbeConnReplacement();
          return;
        }
        if (cur.pingInterval) {
          clearInterval(cur.pingInterval);
          cur.pingInterval = null;
        }
        _removeProbeConn(peerUrl);
        _scheduleProbeConnReplacement();
      });

      ws.on('error', () => {
        const wasPending = _pendingConns.delete(peerUrl);
        const cur = _probeConns.find((c) => c.peerUrl === peerUrl);
        if (!cur || cur.connId !== connId) {
          if (wasPending) _scheduleProbeConnReplacement();
          return;
        }
        if (cur.pingInterval) {
          clearInterval(cur.pingInterval);
          cur.pingInterval = null;
        }
        _removeProbeConn(peerUrl);
        _scheduleProbeConnReplacement();
      });
    } catch (_) {
      _pendingConns.delete(peerUrl);
      _scheduleProbeConnReplacement();
    }
  }

  async function _connectBgProbeWs() {
    if (_connectingProbeWs) return;
    _connectingProbeWs = true;
    try {
      const settings = getLedgerNetworkSettings();
      if (!settings.enabled || settings.mode !== 'peer') return;
      const workerId = walletAddressCache.address || 'unknown';
      if (workerId === 'unknown') {
        setTimeout(() => {
          _connectBgProbeWs();
        }, 5000);
        return;
      }
      let peers = await getOnlineAttestationPeers(settings, workerId, {});
      if (!peers || peers.length < _PROBE_CONN_TARGET) {
        const allPeers = getActivePeers(settings);
        if (allPeers.length > 0) {
          const merged = new Set(peers || []);
          for (const p of allPeers) merged.add(p);
          peers = Array.from(merged);
        }
      }
      if (!peers || peers.length === 0) {
        _scheduleBgProbeWsReconnect();
        return;
      }
      const shuffled = [...peers].sort(() => Math.random() - 0.5);
      const target = Math.min(_PROBE_CONN_TARGET, shuffled.length);
      for (let i = 0; i < target; i++) _startBgProbeWs(shuffled[i]);
      _scheduleProbeConnReplacement();
    } catch (_) {
      _scheduleBgProbeWsReconnect();
    } finally {
      _connectingProbeWs = false;
    }
  }

  function _submitViaWs(ws, probeId, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _pendingProbeVerdicts.delete(probeId);
        reject(new Error('probe verdict timed out'));
      }, timeoutMs || 15000);
      _pendingProbeVerdicts.set(probeId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ type: 'probe-result', probeId, ...body }));
      } catch (e) {
        clearTimeout(timer);
        _pendingProbeVerdicts.delete(probeId);
        reject(e);
      }
    });
  }

  // -- IPC handlers --------------------------------------------------------------

  function registerIpcHandlers(ipcMain) {
    ipcMain.handle('wattcoin-mining-status', (_event, { mining }) => {
      _localMiningStatus = !!mining;
      if (!_localMiningStatus) {
        _pendingContributionWhRef.current = 0;
        _pendingProbes = [];
        _clearProbeTimeoutTimer();
        _probeInProgress = false;
        _probeInProgressId = '';
        _probeInProgressEpoch = -1;
      }
      for (const conn of _probeConns) {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
          try {
            conn.ws.send(JSON.stringify({ type: 'mining-status', data: { mining: _localMiningStatus } }));
          } catch (_) {
            /* ignore */
          }
        }
      }
      return { ok: true };
    });

    ipcMain.handle('wattcoin-request-peer-probe', (_event, opts) => {
      const settings = getLedgerNetworkSettings();
      if (!settings.enabled || settings.mode !== 'peer') {
        return { ok: false, error: 'Peer attestation is required but peer mode is not enabled.' };
      }

      let needsReconnect = false;
      const rendererAllowGpu = !!(opts && opts.allowGpuWorkloads);
      if (rendererAllowGpu !== _allowGpuWorkloads) {
        _allowGpuWorkloads = rendererAllowGpu;
        needsReconnect = true;
      }
      const currentWorkerId = walletAddressCache.address || 'unknown';
      if (currentWorkerId !== 'unknown') {
        for (const c of _probeConns) {
          if (c.ws && c.ws.readyState === WebSocket.OPEN && c.ws._connectedWorkerId !== currentWorkerId) {
            c.ws._connectedWorkerId = currentWorkerId;
            needsReconnect = true;
          }
        }
      }
      if (needsReconnect && _probeConns.length > 0) {
        _closeBgProbeWs();
        _connectBgProbeWs();
      }

      if (_probeConns.length === 0 && _pendingConns.size === 0) {
        _connectBgProbeWs();
      }

      _clearProbeTimeoutTimer();

      const cached = _pendingProbes.shift() || null;
      if (cached) {
        if (cached.probe && cached.probe._peerUrl && !_getProbeConnPeerUrls().has(cached.probe._peerUrl)) {
          return { ok: false, error: 'Stale probe from previous coordinator.' };
        }
        _probeInProgress = true;
        _probeInProgressId = cached.probe.id;
        _probeInProgressEpoch = _probeEpoch;
        _clearProbeTimeoutTimer();
        _probeTimeoutTimer = setTimeout(() => {
          if (_probeInProgress && _probeInProgressId === cached.probe.id) {
            console.warn(`[PeerProbe] Probe ${cached.probe.id} timed out on worker side - penalizing trust`);
            hwAuthority.trustScore = Math.max(0, hwAuthority.trustScore - 1);
            _probeInProgress = false;
            _probeInProgressId = '';
            _probeInProgressEpoch = -1;
            _probeTimeoutTimer = null;
            saveHwAuthState();
          }
        }, _PROBE_TIMEOUT_MS);
        return { ok: true, source: cached.source, probe: cached.probe };
      }

      return { ok: false, error: 'No probe available.' };
    });

    ipcMain.handle('wattcoin-submit-peer-probe-result', async (_event, payload = {}) => {
      if (typeof payload !== 'object' || payload === null) {
        return { ok: false, transient: false, issues: ['payload must be an object'] };
      }
      const settings = getLedgerNetworkSettings();
      const source = String((payload && payload.source) || 'peer');
      const result = payload && payload.result ? payload.result : {};
      const hardwareSpec = payload && typeof payload.hardwareSpec === 'object' ? payload.hardwareSpec : null;

      if (result && result.type === 'skip') {
        _probeInProgress = false;
        _probeInProgressId = '';
        _probeInProgressEpoch = -1;
        _clearProbeTimeoutTimer();
        return { ok: false, issues: ['probe skipped'] };
      }

      if (source === 'peer' && settings.enabled && settings.mode === 'peer') {
        const peerUrl = result._peerUrl ? String(result._peerUrl) : null;
        if (peerUrl) {
          if (!_localMiningStatus) {
            _probeInProgress = false;
            _probeInProgressId = '';
            _probeInProgressEpoch = -1;
            _clearProbeTimeoutTimer();
            return { ok: false, transient: false, issues: ['mining stopped while probe was in flight'] };
          }
          if (!_getProbeConnPeerUrls().has(peerUrl) || _probeEpoch !== _probeInProgressEpoch) {
            return { ok: false, transient: false, issues: ['stale probe: coordinator disconnected'] };
          }
          try {
            console.warn(
              `[PeerProbe] submit body probeWallClockMs=${typeof result.probeWallClockMs === 'number' ? Math.round(result.probeWallClockMs) : '?'} id=${result.id} N=${result._probeIterations || '?'} intDateMs=${typeof result._intDateMs === 'number' ? Math.round(result._intDateMs) : '?'} warmupTotal=${typeof result._warmupTotalMs === 'number' ? Math.round(result._warmupTotalMs) : '?'} retried=${result._retried || 0} callCount=${result._callCount || '?'} chunks=${result._chunks || ''}`,
            );
            const body = {
              probeId: result.id || '',
              proof: result.proof || '',
              pixelHash: result.pixelHash || '',
              devices: Array.isArray(result.devices) ? result.devices : [],
              probeWallClockMs: typeof result.probeWallClockMs === 'number' ? result.probeWallClockMs : null,
              hardwareSpec: hardwareSpec,
              loadPercent: hwAuthority.currentLoadPercent,
              version: getAppDisplayVersion(),
            };
            let verdict;
            const wsConn = _probeConns.find((c) => c.peerUrl === peerUrl);
            if (wsConn && wsConn.ws.readyState === WebSocket.OPEN) {
              try {
                verdict = await _submitViaWs(wsConn.ws, result.id, body, 15000);
              } catch (_) {
                console.warn('[PeerProbe] WS submit failed, falling back to HTTP');
                verdict = null;
              }
            }
            if (!verdict) {
              for (let attempt = 0; attempt < 2; attempt++) {
                if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
                try {
                  verdict = await requestPeerJson(peerUrl, 'POST', '/api/v1/probe/submit', body, undefined, {
                    trackReachability: false,
                    suppressPeerDiscovery: true,
                    source: 'peer-probe-submit',
                    timeoutMs: 15000,
                  });
                  if (verdict && (verdict.ok || !verdict.transient)) break;
                } catch (e) {
                  console.warn('[PeerProbe] HTTP submit attempt ' + (attempt + 1) + '/2 failed:', e.message);
                  if (attempt === 1) throw e;
                  continue;
                }
              }
            }
            if (verdict && verdict.ok) {
              hwAuthority.peerProbeVerifiedForRound = true;
              const receipt = verdict.receipt;
              if (receipt && receipt.verifierAddress && receipt.workerId) {
                recordPeerAttestation(receipt.verifierAddress, receipt.workerId);
              }
              if (receipt && typeof receipt.chainIndex === 'number' && receipt.chainIndex > 0) {
                hwAuthority.peerProbeChainIndex = receipt.chainIndex;
              } else if (typeof verdict.chainIndex === 'number' && verdict.chainIndex > 0) {
                hwAuthority.peerProbeChainIndex = verdict.chainIndex;
              }
              if (walletAddressCache.address) {
                try {
                  roundLedger.recordPeerProbe(walletAddressCache.address);
                } catch (_) {
                  /* best-effort */
                }
              }
              const trustScoreBefore = hwAuthority.trustScore;
              hwAuthority.consecutiveCleanProbes += 1;
              const window = hwAuthority.probeResultWindow;
              window.push(true);
              if (window.length > _PROBE_TRUST_WINDOW) window.shift();
              if (hwAuthority.consecutiveCleanProbes >= 25) {
                hwAuthority.consecutiveCleanProbes = 0;
                hwAuthority.trustScore = Math.min(100, hwAuthority.trustScore + 1);
                saveHwAuthState();
              }
              verdict = Object.assign({}, verdict, {
                trustScoreBefore,
                trustScoreAfter: hwAuthority.trustScore,
              });
              _flushPendingContribution(hwAuthority.peerProbeChainIndex);
            } else {
              const trustScoreBefore = hwAuthority.trustScore;
              const issues = Array.isArray(verdict && verdict.issues) ? verdict.issues : [];
              if (
                issues.length > 0 &&
                issues.every(
                  (i) =>
                    i.includes('unknown or expired probe id') ||
                    i.includes('no pending probe') ||
                    i.includes('mining stopped'),
                )
              ) {
                console.warn(
                  `[PeerProbe] Probe ${result.id} discarded (mining stopped or expired, no trust impact):`,
                  issues.join('; '),
                );
              } else {
                hwAuthority.consecutiveCleanProbes = 0;
                if (walletAddressCache.address) {
                  try {
                    roundLedger.recordPeerProbeFailed(walletAddressCache.address);
                  } catch (_) {
                    /* best-effort */
                  }
                }
                let penalty = -1;
                if (
                  issues.some(
                    (i) =>
                      i.includes('proof hash mismatch') ||
                      i.includes('pixel hash mismatch') ||
                      i.includes('no pixel hash returned'),
                  )
                ) {
                  penalty = -3;
                }
                hwAuthority.trustScore = Math.max(0, hwAuthority.trustScore + penalty);
                const window$ = hwAuthority.probeResultWindow;
                window$.push(false);
                if (window$.length > _PROBE_TRUST_WINDOW) window$.shift();
                if (window$.length >= _PROBE_TRUST_WINDOW) {
                  const fails = window$.filter((r) => !r).length;
                  if (fails / window$.length >= _PROBE_FAIL_RATIO_THRESHOLD) {
                    hwAuthority.trustScore = Math.max(0, hwAuthority.trustScore - 1);
                    console.warn(
                      `[PeerProbe] Fail ratio ${fails}/${window$.length} exceeds ${(_PROBE_FAIL_RATIO_THRESHOLD * 100).toFixed(0)}% - additional trust penalty`,
                    );
                    hwAuthority.probeResultWindow = [];
                  }
                }
              }
              saveHwAuthState();
              verdict = Object.assign({}, verdict, {
                trustScoreBefore,
                trustScoreAfter: hwAuthority.trustScore,
              });
            }
            return verdict;
          } catch (e) {
            console.warn('[PeerProbe] Could not submit peer probe result:', e.message);
            const np = normalizePeerUrl(peerUrl);
            if (np) {
              peerReachabilityCache.set(np, { ok: false, lastAttemptAtMs: Date.now(), lastSuccessAtMs: 0 });
            }
            _removeProbeConn(peerUrl);
            _scheduleProbeConnReplacement();
            return { ok: false, transient: true, issues: ['peer unreachable: ' + e.message] };
          } finally {
            _probeInProgress = false;
            _probeInProgressId = '';
            _probeInProgressEpoch = -1;
            _clearProbeTimeoutTimer();
          }
        }
      }

      _probeInProgress = false;
      _probeInProgressId = '';
      _probeInProgressEpoch = -1;
      _clearProbeTimeoutTimer();
      return {
        ok: false,
        error: 'Peer probe result submission requires peer mode and a valid attestation peer URL.',
      };
    });
  }

  // -- Coordinator push-probe helpers (exported for main file) -------------------

  function _clearProbePushTimer() {
    const t = _probePushTimerRef.current;
    if (t) {
      clearTimeout(t);
      _probePushTimerRef.current = null;
    }
  }

  function _scheduleProbePush() {
    _clearProbePushTimer();
    const delay = Math.round(Math.random() * _PROBE_PUSH_INTERVAL_MAX_MS);
    _probePushTimerRef.current = setTimeout(() => {
      _runProbePush();
    }, delay);
  }

  function _runProbePush() {
    try {
      if (_probePushConns.size === 0) return;
      const deadWorkers = [];
      const liveWorkers = [];
      for (const [wid, conn] of _probePushConns) {
        if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
          deadWorkers.push(wid);
        } else if (wid !== 'unknown') {
          liveWorkers.push(wid);
        }
      }
      for (const wid of deadWorkers) {
        _probePushConns.delete(wid);
        _workerIsMining.delete(wid);
        cancelPendingPeerProbesForWorker(wid);
      }
      for (const wid of liveWorkers) {
        const conn = _probePushConns.get(wid);
        if (!conn) continue;
        if (conn.ws._probePushMissedPongs > 0) continue;
        const _miningStatus = _workerIsMining.get(wid);
        if (_miningStatus !== true) continue;
        try {
          const probe = issuePeerProbe(wid, conn.allowGpu, conn.hasAsic, conn.gpuPowCapable);
          if (probe === null) {
            _probePushConns.delete(wid);
            _workerIsMining.delete(wid);
            cancelPendingPeerProbesForWorker(wid);
            try {
              conn.ws.close();
            } catch (_) {
              /* ignore */
            }
            continue;
          }
          if (probe) {
            conn.ws.send(JSON.stringify({ type: 'probe', data: { ok: true, probe, source: 'peer' } }));
          }
        } catch (_) {
          cancelPendingPeerProbesForWorker(wid);
        }
      }
    } catch (_) {
      /* outer safety net */
    } finally {
      _scheduleProbePush();
    }
  }

  async function _handleWsProbeResult(workerId, msg, ws) {
    try {
      refreshCoordinatorIdentityKey();
      const probeResult = {
        id: msg.probeId || '',
        proof: msg.proof || '',
        pixelHash: msg.pixelHash || '',
        devices: Array.isArray(msg.devices) ? msg.devices : [],
        probeWallClockMs: typeof msg.probeWallClockMs === 'number' ? msg.probeWallClockMs : undefined,
        loadPercent: typeof msg.loadPercent === 'number' ? msg.loadPercent : undefined,
        version: msg.version || '',
      };
      const hardwareSpec = msg.hardwareSpec || null;
      const probeRoundId = getCurrentNetworkRoundId();
      const verdict = await submitPeerProbeResult(probeResult, hardwareSpec, probeRoundId);

      const _probeWtcNode = getWtcNode();
      if (verdict && verdict.receipt && _probeWtcNode && typeof _probeWtcNode.signMessage === 'function') {
        const verifierAddress = String(verdict.receipt.verifierAddress || '').trim();
        const wid = String(verdict.receipt.workerId || '').trim();
        if (verifierAddress && wid && verifierAddress === wid) {
          verdict.ok = false;
          verdict.issues = [
            ...(Array.isArray(verdict.issues) ? verdict.issues : []),
            'self-verification is not allowed',
          ];
          verdict.receipt = null;
        } else {
          const signingPayload = getProbeReceiptSigningPayload(verdict.receipt);
          if (verifierAddress && signingPayload) {
            try {
              const signed = _probeWtcNode.signMessage(verifierAddress, signingPayload);
              verdict.receipt = attachProbeReceiptSignature(verdict.receipt, signed && signed.signature);
              if (verdict.receipt) {
                recordPeerAttestation(verifierAddress, wid);
                broadcastProbeReceiptToPeers(verdict.receipt);
              }
            } catch (error) {
              console.warn('[PeerProbe/WS] Failed to sign probe receipt:', error && error.message);
            }
          }
        }
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'probe-verdict', probeId: msg.probeId, ...verdict }));
      }
    } catch (error) {
      console.warn('[PeerProbe/WS] Error handling WS probe result:', error && error.message);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'probe-verdict',
            probeId: msg.probeId,
            ok: false,
            issues: ['internal error: ' + (error && error.message)],
          }),
        );
      }
    }
  }

  return {
    registerIpcHandlers,
    _connectBgProbeWs,
    _closeBgProbeWs,
    _scheduleBgProbeWsReconnect,
    _clearProbePushTimer,
    _scheduleProbePush,
    _runProbePush,
    _handleWsProbeResult,
    _localMiningStatus,
  };
}

module.exports = { createHandlers };
