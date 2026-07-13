'use strict';

const WORKER_HW_HISTORY_MAX = 20;
const WORKER_HW_ENROLL_COUNT = 4;
const workerHwHistory = new Map();

function appendWorkerHwSample(samples, newValue) {
  if (!isFinite(newValue) || newValue <= 0) return samples;
  if (samples.length >= WORKER_HW_ENROLL_COUNT) {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    if (newValue > mean * 1.4 || newValue < mean / 1.4) return samples;
  }
  const updated = [...samples, newValue];
  return updated.length > WORKER_HW_HISTORY_MAX ? updated.slice(updated.length - WORKER_HW_HISTORY_MAX) : updated;
}

const recentWorkerActivity = new Map();
const WORKER_ACTIVE_WINDOW_MS = 10 * 60 * 1000;

const workerChainState = new Map();

const workerConsecutiveTimeouts = new Map();
const WORKER_MAX_CONSECUTIVE_TIMEOUTS = 3;

const workerNetworkRtt = new Map();
const WORKER_RTT_EWMA_ALPHA = 0.3;
const WORKER_RTT_STALE_MS = 120_000;

function updateWorkerRtt(workerId, rttMs) {
  if (!workerId || typeof rttMs !== 'number' || rttMs <= 0) return;
  const now = Date.now();
  const prev = workerNetworkRtt.get(workerId);
  const smoothedMs = prev
    ? Math.round(prev.smoothedMs * (1 - WORKER_RTT_EWMA_ALPHA) + rttMs * WORKER_RTT_EWMA_ALPHA)
    : Math.round(rttMs);
  workerNetworkRtt.set(workerId, { smoothedMs, lastUpdatedMs: now });
  if (workerNetworkRtt.size > 500) {
    const cutoff = now - WORKER_RTT_STALE_MS;
    for (const [id, entry] of workerNetworkRtt) {
      if (entry.lastUpdatedMs < cutoff) workerNetworkRtt.delete(id);
    }
  }
}

function getWorkerRtt(workerId) {
  const entry = workerNetworkRtt.get(workerId);
  if (!entry) return null;
  if (Date.now() - entry.lastUpdatedMs > WORKER_RTT_STALE_MS) {
    workerNetworkRtt.delete(workerId);
    return null;
  }
  return entry.smoothedMs;
}

function getActiveWorkerCount() {
  const now = Date.now();
  let count = 0;
  for (const [, lastSeen] of recentWorkerActivity) {
    if (now - lastSeen < WORKER_ACTIVE_WINDOW_MS) count++;
  }
  return count;
}

module.exports = {
  WORKER_HW_HISTORY_MAX,
  WORKER_HW_ENROLL_COUNT,
  WORKER_ACTIVE_WINDOW_MS,
  WORKER_MAX_CONSECUTIVE_TIMEOUTS,
  WORKER_RTT_EWMA_ALPHA,
  WORKER_RTT_STALE_MS,
  workerHwHistory,
  recentWorkerActivity,
  workerChainState,
  workerConsecutiveTimeouts,
  workerNetworkRtt,
  appendWorkerHwSample,
  updateWorkerRtt,
  getWorkerRtt,
  getActiveWorkerCount,
};
