'use strict';

const assert = require('assert');

const { buildOpsHealthResponse } = require('../ops-health');

function testHistoricalAlertsDoNotStickHealth() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: {
      localHeight: 100,
      nodeLagBlocks: 0,
      latestBlockAgeMs: 5_000,
      forkRatePerHour: 0,
      rollbackMedianDepth: 0,
    },
    peers: {
      healthy: 4,
      total: 4,
      uniqueNetworkSegments: 4,
    },
    mempool: {
      size: 3,
      capacity: 5000,
      pressure: 0.0006,
    },
    alerts: [
      {
        code: 'chain.stall',
        severity: 'critical',
        message: 'Old critical evidence',
      },
    ],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'healthy', 'historical alerts should not keep health degraded');
  assert.strictEqual(response.alerts.length, 1, 'historical evidence should still be returned');
  assert.strictEqual(response.activeAlerts.length, 0, 'no active alerts should be emitted for healthy metrics');
}

function testActiveCriticalConditionStillTripsHealth() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: {
      localHeight: 100,
      nodeLagBlocks: 0,
      latestBlockAgeMs: 21 * 60_000,
      forkRatePerHour: 0,
      rollbackMedianDepth: 0,
    },
    peers: {
      healthy: 4,
      total: 4,
      uniqueNetworkSegments: 4,
    },
    mempool: {
      size: 3,
      capacity: 5000,
      pressure: 0.0006,
    },
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'critical', 'active chain stall should surface as critical health');
  assert.strictEqual(response.activeAlerts.length, 1, 'active stall should be included in active alerts');
  assert.strictEqual(response.activeAlerts[0].code, 'chain.stall');
}

// ─── Peer diversity alert ─────────────────────────────────────────────────────

function testPeerDiversityLowAlertWhenSegmentsBelowThreshold() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: { localHeight: 100, nodeLagBlocks: 0, latestBlockAgeMs: 5_000, forkRatePerHour: 0, rollbackMedianDepth: 0 },
    peers: { healthy: 4, total: 4, uniqueNetworkSegments: 2 }, // 4 peers, only 2 segments
    mempool: { size: 3, capacity: 5000, pressure: 0.0006 },
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'degraded', 'low peer diversity should produce degraded status');
  const alert = response.activeAlerts.find((a) => a.code === 'peer.diversity.low');
  assert.ok(alert, 'peer.diversity.low alert should be present');
  assert.strictEqual(alert.severity, 'warn', 'peer diversity alert should have warn severity');
}

function testPeerDiversityAlertNotEmittedWhenSegmentsMeetThreshold() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: { localHeight: 100, nodeLagBlocks: 0, latestBlockAgeMs: 5_000, forkRatePerHour: 0, rollbackMedianDepth: 0 },
    peers: { healthy: 4, total: 4, uniqueNetworkSegments: 3 }, // exactly at threshold
    mempool: { size: 3, capacity: 5000, pressure: 0.0006 },
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'healthy', 'meeting diversity threshold should not degrade status');
  assert.ok(!response.activeAlerts.find((a) => a.code === 'peer.diversity.low'), 'no diversity alert expected');
}

function testPeerDiversityAlertNotEmittedWhenPeerCountBelowMinimum() {
  // With fewer than 3 total peers the alert is intentionally suppressed (not enough data).
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: { localHeight: 100, nodeLagBlocks: 0, latestBlockAgeMs: 5_000, forkRatePerHour: 0, rollbackMedianDepth: 0 },
    peers: { healthy: 2, total: 2, uniqueNetworkSegments: 1 }, // only 2 peers
    mempool: { size: 3, capacity: 5000, pressure: 0.0006 },
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'healthy', 'small peer count should not trigger diversity alert');
  assert.ok(!response.activeAlerts.find((a) => a.code === 'peer.diversity.low'), 'no diversity alert for < 3 peers');
}

// ─── Mempool pressure alert ───────────────────────────────────────────────────

function testMempoolPressureHighAlertWhenAtThreshold() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: { localHeight: 100, nodeLagBlocks: 0, latestBlockAgeMs: 5_000, forkRatePerHour: 0, rollbackMedianDepth: 0 },
    peers: { healthy: 4, total: 4, uniqueNetworkSegments: 4 },
    mempool: { size: 4250, capacity: 5000, pressure: 0.85 }, // exactly at 85% threshold
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'degraded', 'mempool at threshold should produce degraded status');
  const alert = response.activeAlerts.find((a) => a.code === 'mempool.pressure.high');
  assert.ok(alert, 'mempool.pressure.high alert should be present at threshold');
  assert.strictEqual(alert.severity, 'warn', 'mempool pressure alert should have warn severity');
}

function testMempoolPressureHighAlertWhenAboveThreshold() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: { localHeight: 100, nodeLagBlocks: 0, latestBlockAgeMs: 5_000, forkRatePerHour: 0, rollbackMedianDepth: 0 },
    peers: { healthy: 4, total: 4, uniqueNetworkSegments: 4 },
    mempool: { size: 4900, capacity: 5000, pressure: 0.98 },
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'degraded', 'high mempool pressure should produce degraded status');
  assert.ok(
    response.activeAlerts.find((a) => a.code === 'mempool.pressure.high'),
    'alert should fire above threshold',
  );
}

function testMempoolPressureAlertNotEmittedBelowThreshold() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: { localHeight: 100, nodeLagBlocks: 0, latestBlockAgeMs: 5_000, forkRatePerHour: 0, rollbackMedianDepth: 0 },
    peers: { healthy: 4, total: 4, uniqueNetworkSegments: 4 },
    mempool: { size: 100, capacity: 5000, pressure: 0.84 }, // just below 85%
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'healthy', 'pressure below threshold should not degrade status');
  assert.ok(!response.activeAlerts.find((a) => a.code === 'mempool.pressure.high'), 'no mempool alert below threshold');
}

// ─── Multiple simultaneous active alerts ─────────────────────────────────────

function testMultipleActiveAlertsAllAppearInResponse() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: {
      localHeight: 100,
      nodeLagBlocks: 0,
      latestBlockAgeMs: 21 * 60_000,
      forkRatePerHour: 0,
      rollbackMedianDepth: 0,
    },
    peers: { healthy: 4, total: 4, uniqueNetworkSegments: 2 }, // diversity low
    mempool: { size: 4900, capacity: 5000, pressure: 0.98 }, // pressure high
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'critical', 'chain stall critical takes precedence over warn alerts');
  const codes = response.activeAlerts.map((a) => a.code);
  assert.ok(codes.includes('chain.stall'), 'chain.stall should be present');
  assert.ok(codes.includes('peer.diversity.low'), 'peer.diversity.low should be present');
  assert.ok(codes.includes('mempool.pressure.high'), 'mempool.pressure.high should be present');
  assert.strictEqual(response.activeAlerts.length, 3, 'all three simultaneous alerts should appear');
}

// ─── Status degraded vs critical distinction ──────────────────────────────────

function testStatusIsDegradedForWarnOnlyAlerts() {
  const snapshot = {
    timestamp: '2026-04-21T00:00:00.000Z',
    chain: { localHeight: 100, nodeLagBlocks: 0, latestBlockAgeMs: 5_000, forkRatePerHour: 0, rollbackMedianDepth: 0 },
    peers: { healthy: 4, total: 4, uniqueNetworkSegments: 1 }, // diversity low (warn)
    mempool: { size: 4900, capacity: 5000, pressure: 0.98 }, // pressure high (warn)
    alerts: [],
  };

  const response = buildOpsHealthResponse(snapshot);
  assert.strictEqual(response.status, 'degraded', 'warn-only alerts should yield degraded, not critical');
  assert.ok(
    response.activeAlerts.every((a) => a.severity === 'warn'),
    'all active alerts should be warn level',
  );
}

function run() {
  testHistoricalAlertsDoNotStickHealth();
  testActiveCriticalConditionStillTripsHealth();
  testPeerDiversityLowAlertWhenSegmentsBelowThreshold();
  testPeerDiversityAlertNotEmittedWhenSegmentsMeetThreshold();
  testPeerDiversityAlertNotEmittedWhenPeerCountBelowMinimum();
  testMempoolPressureHighAlertWhenAtThreshold();
  testMempoolPressureHighAlertWhenAboveThreshold();
  testMempoolPressureAlertNotEmittedBelowThreshold();
  testMultipleActiveAlertsAllAppearInResponse();
  testStatusIsDegradedForWarnOnlyAlerts();
  console.log('ops health integration tests passed');
}

run();
