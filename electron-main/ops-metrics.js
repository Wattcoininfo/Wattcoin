const fsp = require('fs/promises');
const path = require('path');

function createOpsMetricsManager({
  opsState,
  getWtcNode,
  getLedgerNetworkSettings,
  inspectPeerConnectivity,
  getPeerNetworkSegment,
  median,
  pruneOldTimestamps,
  bannedPeerUrls,
  bannedPeerIdentities,
  runWtcPeerSync,
  getOpsMetricsFilePath,
  OPS_METRICS_SAMPLE_MS,
  OPS_WINDOW_MS,
  CHAIN_STALL_ALERT_MS,
  OPS_ALERT_COOLDOWN_MS,
}) {
  let opsMetricsTimer = null;
  let opsSnapshotInFlight = false;

  const ABUSE_LOG_FILE_NAME = 'abuse-events.jsonl';

  function getAbuseLogFilePath() {
    const { getDataDir } = require('./env');
    return path.join(getDataDir(), ABUSE_LOG_FILE_NAME);
  }

  async function logAbuseEvent(event) {
    try {
      const abusePath = getAbuseLogFilePath();
      await fsp.mkdir(path.dirname(abusePath), { recursive: true });
      await fsp.appendFile(abusePath, JSON.stringify({ ts: Date.now(), event }) + '\n', 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function recordOpsAlert(code, severity, message, details = {}) {
    const now = Date.now();
    const cooldownUntil = opsState.alertCooldownUntil.get(code) || 0;
    if (now < cooldownUntil) return;
    opsState.alerts.push({ ts: now, code, severity, message, details });
    if (opsState.alerts.length > 200) opsState.alerts = opsState.alerts.slice(-200);
    opsState.alertCooldownUntil.set(code, now + OPS_ALERT_COOLDOWN_MS);
    logAbuseEvent({ type: 'ops-alert', code, severity, message, details });
  }

  async function collectOpsSnapshot() {
    if (opsSnapshotInFlight) return opsState.latestSnapshot || {};
    opsSnapshotInFlight = true;
    try {
      return await collectOpsSnapshotInner();
    } finally {
      opsSnapshotInFlight = false;
    }
  }

  async function collectOpsSnapshotInner() {
    const wtcNode = getWtcNode();
    const localTip = wtcNode && typeof wtcNode.getTip === 'function' ? wtcNode.getTip() : null;
    const localHeight = wtcNode && typeof wtcNode.getHeight === 'function' ? Number(wtcNode.getHeight()) : -1;
    const mempoolSize = wtcNode && typeof wtcNode.getMempoolSize === 'function' ? Number(wtcNode.getMempoolSize()) : 0;

    if (localTip && localTip.hash && opsState.lastTipHash && localTip.hash !== opsState.lastTipHash) {
      const prevTs = Number(opsState.lastTipTimestamp) || 0;
      const currTs = Number(localTip.timestamp) || 0;
      if (prevTs > 0 && currTs > prevTs) {
        const deltaSec = (currTs - prevTs) / 1000;
        if (deltaSec > 0 && deltaSec < 24 * 60 * 60) {
          opsState.blockIntervalsSec.push(deltaSec);
          opsState.blockIntervalsSec = opsState.blockIntervalsSec.slice(-500);
        }
      }
    }
    if (localTip && localTip.hash) {
      opsState.lastTipHash = localTip.hash;
      opsState.lastTipTimestamp = Number(localTip.timestamp) || opsState.lastTipTimestamp;
    }

    const settings = getLedgerNetworkSettings();
    const connectivity = await inspectPeerConnectivity(settings, { source: 'ops-peer-snapshot' });
    const peers = connectivity.peers;
    let bestPeerHeight = Math.max(localHeight, connectivity.bestPeerHeight);
    const healthyPeers = connectivity.healthyDistinct;

    const lag = Math.max(0, bestPeerHeight - localHeight);
    opsState.syncLagSamples.push(lag);
    opsState.syncLagSamples = opsState.syncLagSamples.slice(-500);

    const now = Date.now();
    if (lag > 0 && healthyPeers > 0 && now - (Number(opsState.lastSyncAttemptAt) || 0) >= 60_000) {
      await runWtcPeerSync('ops-fallback');
    }

    const latestBlockAgeMs = opsState.lastTipTimestamp > 0 ? Math.max(0, now - opsState.lastTipTimestamp) : 0;
    if (latestBlockAgeMs >= CHAIN_STALL_ALERT_MS) {
      recordOpsAlert('chain.stall', 'critical', 'No new block observed within stall threshold', {
        latestBlockAgeMs,
        thresholdMs: CHAIN_STALL_ALERT_MS,
      });
    }

    const peerSegments = new Set(peers.map(getPeerNetworkSegment).filter(Boolean));
    if (peers.length >= 3 && peerSegments.size < 3) {
      recordOpsAlert('peer.diversity.low', 'warn', 'Peer diversity below recommended threshold', {
        peerCount: peers.length,
        uniqueSegments: peerSegments.size,
      });
    }

    const forkRatePerHour = pruneOldTimestamps(opsState.forkMismatchTimestamps, OPS_WINDOW_MS).length;
    const rollbackMedian = median(opsState.rollbackDepths.slice(-100));
    const blockIntervalMedianSec = median(opsState.blockIntervalsSec.slice(-100));
    const lagMedian = median(opsState.syncLagSamples.slice(-100));
    const peerOkPerHour = pruneOldTimestamps(opsState.peerRequestOkTimestamps, OPS_WINDOW_MS).length;
    const peerFailPerHour = pruneOldTimestamps(opsState.peerRequestFailTimestamps, OPS_WINDOW_MS).length;
    const mempoolPressure = mempoolSize / 5000;
    if (mempoolPressure >= 0.85) {
      recordOpsAlert('mempool.pressure.high', 'warn', 'Mempool pressure is above 85%', { mempoolSize, capacity: 5000 });
    }

    const snapshot = {
      timestamp: new Date(now).toISOString(),
      chain: {
        localHeight,
        bestPeerHeight,
        nodeLagBlocks: lag,
        latestBlockAgeMs,
        blockIntervalMedianSec,
        forkRatePerHour,
        rollbackMedianDepth: rollbackMedian,
      },
      peers: {
        total: connectivity.totalDistinct,
        healthy: healthyPeers,
        bannedUrls: bannedPeerUrls.size,
        bannedIdentities: bannedPeerIdentities.size,
        uniqueNetworkSegments: peerSegments.size,
        requestOkPerHour: peerOkPerHour,
        requestFailPerHour: peerFailPerHour,
      },
      mempool: {
        size: mempoolSize,
        capacity: 5000,
        pressure: Number(mempoolPressure.toFixed(4)),
      },
      alerts: opsState.alerts.slice(-50),
      sync: {
        lagMedianBlocks: lagMedian,
        lastSyncResult: opsState.lastSyncResult,
      },
    };

    opsState.latestSnapshot = snapshot;
    try {
      const metricsPath = getOpsMetricsFilePath();
      await fsp.mkdir(path.dirname(metricsPath), { recursive: true });
      await fsp.writeFile(metricsPath, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    return snapshot;
  }

  function startOpsMetricsLoop() {
    if (opsMetricsTimer) return;
    setImmediate(() => collectOpsSnapshot().catch(() => {}));
    opsMetricsTimer = setInterval(() => {
      collectOpsSnapshot().catch(() => {});
    }, OPS_METRICS_SAMPLE_MS);
  }

  function stopOpsMetricsLoop() {
    if (!opsMetricsTimer) return;
    clearInterval(opsMetricsTimer);
    opsMetricsTimer = null;
  }

  return {
    collectOpsSnapshot,
    startOpsMetricsLoop,
    stopOpsMetricsLoop,
    recordOpsAlert,
    logAbuseEvent,
  };
}

module.exports = { createOpsMetricsManager };
