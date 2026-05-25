// SPDX-License-Identifier: MIT
'use strict';

const crypto = require('crypto');

function deriveActiveOpsAlerts(
  snapshot,
  {
    chainStallAlertMs = 20 * 60_000,
    minPeerDiversityPeers = 3,
    minUniquePeerSegments = 3,
    mempoolPressureThreshold = 0.85,
  } = {},
) {
  const alerts = [];
  const chain = snapshot && snapshot.chain ? snapshot.chain : {};
  const peers = snapshot && snapshot.peers ? snapshot.peers : {};
  const mempool = snapshot && snapshot.mempool ? snapshot.mempool : {};

  const latestBlockAgeMs = Math.max(0, Number(chain.latestBlockAgeMs) || 0);
  if (latestBlockAgeMs >= chainStallAlertMs) {
    alerts.push({
      code: 'chain.stall',
      severity: 'critical',
      message: 'No new block observed within stall threshold',
      details: {
        latestBlockAgeMs,
        thresholdMs: chainStallAlertMs,
      },
    });
  }

  const peerTotal = Math.max(0, Number(peers.total) || 0);
  const uniqueNetworkSegments = Math.max(0, Number(peers.uniqueNetworkSegments) || 0);
  if (peerTotal >= minPeerDiversityPeers && uniqueNetworkSegments < minUniquePeerSegments) {
    alerts.push({
      code: 'peer.diversity.low',
      severity: 'warn',
      message: 'Peer diversity below recommended threshold',
      details: {
        peerCount: peerTotal,
        uniqueSegments: uniqueNetworkSegments,
      },
    });
  }

  const pressure = Math.max(0, Number(mempool.pressure) || 0);
  if (pressure >= mempoolPressureThreshold) {
    alerts.push({
      code: 'mempool.pressure.high',
      severity: 'warn',
      message: 'Mempool pressure is above 85%',
      details: {
        mempoolSize: Math.max(0, Number(mempool.size) || 0),
        capacity: Math.max(0, Number(mempool.capacity) || 0),
      },
    });
  }

  return alerts;
}

function buildOpsHealthResponse(snapshot, options = {}) {
  const activeAlerts = deriveActiveOpsAlerts(snapshot, options);
  const criticalCount = activeAlerts.filter((alert) => alert && alert.severity === 'critical').length;
  const warnCount = activeAlerts.filter((alert) => alert && alert.severity === 'warn').length;
  const status = criticalCount > 0 ? 'critical' : warnCount > 0 ? 'degraded' : 'healthy';

  return {
    ok: true,
    status,
    generatedAt: snapshot && snapshot.timestamp ? snapshot.timestamp : new Date().toISOString(),
    metrics: {
      localHeight: Math.max(-1, Number(snapshot && snapshot.chain && snapshot.chain.localHeight) || 0),
      nodeLagBlocks: Math.max(0, Number(snapshot && snapshot.chain && snapshot.chain.nodeLagBlocks) || 0),
      forkRatePerHour: Math.max(0, Number(snapshot && snapshot.chain && snapshot.chain.forkRatePerHour) || 0),
      rollbackMedianDepth: Math.max(0, Number(snapshot && snapshot.chain && snapshot.chain.rollbackMedianDepth) || 0),
      peerHealthy: Math.max(0, Number(snapshot && snapshot.peers && snapshot.peers.healthy) || 0),
      peerTotal: Math.max(0, Number(snapshot && snapshot.peers && snapshot.peers.total) || 0),
      mempoolPressure: Math.max(0, Number(snapshot && snapshot.mempool && snapshot.mempool.pressure) || 0),
    },
    alerts: Array.isArray(snapshot && snapshot.alerts) ? snapshot.alerts : [],
    activeAlerts,
  };
}

/**
 * Timing-safe token comparison for the ledger-network auth header.
 *
 * Both tokens are trimmed before comparison.  Returns false (fail-closed)
 * when either token is absent so callers never accidentally accept requests
 * when the required token has not been configured.
 *
 * @param {string|null|undefined} suppliedToken   — value from the request header
 * @param {string|null|undefined} requiredToken   — value from node settings
 * @returns {boolean}
 */
function checkLedgerNetworkAuth(suppliedToken, requiredToken) {
  const supplied = String(suppliedToken || '').trim();
  if (!supplied) return false;
  const required = String(requiredToken || '').trim();
  if (!required) return false;
  const a = Buffer.from(required, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  deriveActiveOpsAlerts,
  buildOpsHealthResponse,
  checkLedgerNetworkAuth,
};
