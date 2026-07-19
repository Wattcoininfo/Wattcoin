const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

let cpuWorkers = [];
let _physicalCoreCount = null;

const cpuWorkerTelemetry = new Map();
const _staleWorkerIds = new Set(); // threadIds of workers that received 'stop'
let currentPercent = 0;
let targetPercent = 0;
let rampUpStartTime = 0;
let rampUpTimer = null;
const RAMP_UP_DURATION_MS = 3000;

// ── Coordinator seed state ────────────────────────────────────────────────
// Tracks the current coordinator-issued seed and cumulative proof data
// across all CPU workers for the current seed period.
let _activeCoordinatorSeed = null;
let _seedProofs = new Map(); // workerThreadId → { startState, totalOps, burnMs }
let _onSeedProof = null; // callback: (proof) => void — called when a worker submits a proof

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function stopCpuWorkers() {
  const workersToStop = cpuWorkers;
  cpuWorkers = [];
  cpuWorkerTelemetry.clear();
  _seedProofs.clear();

  for (const worker of workersToStop) {
    _staleWorkerIds.add(worker.threadId);
    try {
      worker.postMessage({ type: 'stop' });
    } catch (_) {
      try {
        worker.terminate();
      } catch (_) {
        /* already dead */
      }
    }
  }
  // Give workers time to finish their current native burn and call process.exit(0).
  // Terminating mid-N-API call crashes the main process.
  const deadline = Date.now() + 3000;
  const forceKill = () => {
    for (const worker of workersToStop) {
      try {
        worker.terminate();
      } catch (_) {
        /* already dead */
      }
    }
  };
  const poll = () => {
    // Check if all workers have exited (exit event fires and threadId becomes stale)
    const anyAlive = workersToStop.some((w) => {
      try {
        w.postMessage({ type: 'stats' });
        return true;
      } catch (_) {
        return false;
      }
    });
    if (!anyAlive || Date.now() >= deadline) {
      forceKill();
      return;
    }
    setTimeout(poll, 50);
  };
  poll();
}

function ensureCpuWorkers() {
  if (cpuWorkers.length > 0) return;

  const logicalCores = Math.max(1, os.cpus().length || 1);
  // When _physicalCoreCount is not yet resolved (si.cpu() is async), fall back to
  // logical/2 which is correct for HT/SMT CPUs.  Under-provisions non-HT CPUs
  // (fewer workers, but each gets full core throughput) which is safe — over-
  // provisioning causes workers to share physical cores and halves throughput,
  // triggering ops_too_low rejections.
  const physicalCores = _physicalCoreCount || Math.max(1, Math.floor(logicalCores / 2));
  const workerCount = physicalCores;
  const workerPath = path.join(__dirname, 'cpu-load-worker.js');

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(workerPath);
    worker.on('message', (msg) => {
      if (!msg) return;
      if (_staleWorkerIds.has(worker.threadId)) return;
      if (msg.type === 'stats') {
        cpuWorkerTelemetry.set(worker.threadId, {
          opsPerSec: Math.max(0, Number(msg.opsPerSec) || 0),
          duty: Math.max(0, Math.min(1, Number(msg.duty) || 0)),
          burnMs: Math.max(0, Number(msg.burnMs) || 0),
          totalMs: Math.max(0, Number(msg.totalMs) || 0),
          targetPercent: Math.max(0, Math.min(100, Number(msg.targetPercent) || 0)),
          ts: Date.now(),
          opsPerMs: Math.max(0, Number(msg.opsPerMs) || 0),
        });
      } else if (msg.type === 'seed-proof') {
        // Worker submitted proof of work done with a coordinator seed.
        _seedProofs.set(worker.threadId, {
          seed: msg.seed,
          startState: msg.startState,
          endState: msg.endState,
          totalOps: Number(msg.totalOps) || 0,
          burnMs: Number(msg.burnMs) || 0,
          intermediateProof: msg.intermediateProof,
        });
        if (typeof _onSeedProof === 'function') {
          _onSeedProof(msg);
        }
      }
    });
    worker.on('exit', (code) => {
      cpuWorkerTelemetry.delete(worker.threadId);
      _seedProofs.delete(worker.threadId);
      _staleWorkerIds.delete(worker.threadId);
      if (code !== 0 && code !== null) {
        if (process.env.WATTCOIN_DEBUG) console.warn(`[HwLoad] Worker ${worker.threadId} exited with code ${code}`);
      }
    });
    worker.on('error', (err) => {
      if (process.env.WATTCOIN_DEBUG)
        console.warn(`[HwLoad] Worker ${worker.threadId} error:`, String((err && err.message) || err).slice(0, 120));
      cpuWorkerTelemetry.delete(worker.threadId);
      _seedProofs.delete(worker.threadId);
      _staleWorkerIds.delete(worker.threadId);
    });
    cpuWorkers.push(worker);
  }
}

function setCpuTarget(percent) {
  ensureCpuWorkers();
  for (const worker of cpuWorkers) {
    worker.postMessage({ type: 'set-target', percent });
  }
}

// ── Coordinator seed management ───────────────────────────────────────────
// Called when the coordinator issues a new seed via peer probe.
// Distributes the seed to all CPU workers.
function setCoordinatorSeed(seed) {
  if (seed === _activeCoordinatorSeed) return;
  _activeCoordinatorSeed = seed;
  ensureCpuWorkers();
  for (const worker of cpuWorkers) {
    try {
      worker.postMessage({ type: 'set-seed', seed });
    } catch (_) {
      /* worker may have exited */
    }
  }
}

// Returns the current coordinator-issued seed.
function getCoordinatorSeed() {
  return _activeCoordinatorSeed;
}

// Returns and clears seed proof data from all workers.
function drainSeedProofs() {
  const entries = [];
  for (const [k, v] of _seedProofs) entries.push([k, v]);
  _seedProofs.clear();
  return new Map(entries);
}

// Register callback for when a worker submits a seed proof.
function onSeedProof(callback) {
  _onSeedProof = callback;
}

function stopRampUp() {
  if (rampUpTimer) {
    clearInterval(rampUpTimer);
    rampUpTimer = null;
  }
  rampUpStartTime = 0;
}

function startRampUp(targetLoad) {
  stopRampUp();
  const startPercent = currentPercent;
  rampUpStartTime = Date.now();
  targetPercent = targetLoad;

  rampUpTimer = setInterval(() => {
    const elapsedMs = Date.now() - rampUpStartTime;
    const rampFactor = Math.min(1, elapsedMs / RAMP_UP_DURATION_MS);
    const nextPercent = Math.round(startPercent + (targetLoad - startPercent) * rampFactor);

    if (nextPercent !== currentPercent) {
      currentPercent = nextPercent;
      setCpuTarget(nextPercent);
    }

    if (rampFactor >= 1) {
      stopRampUp();
    }
  }, 50);
}

function setHardwareLoadPercent(percent) {
  const next = clampPercent(percent);

  if (next <= 0) {
    stopRampUp();
    stopCpuWorkers();
    currentPercent = 0;
    targetPercent = 0;
    return currentPercent;
  }

  startRampUp(next);
  return next;
}

function stopHardwareLoad() {
  stopRampUp();
  currentPercent = 0;
  targetPercent = 0;
  stopCpuWorkers();
}

function getHardwareLoadState() {
  let cpuLoadOpsPerSec = 0;
  let cpuDutySum = 0;
  let cpuDutyCount = 0;
  const nowMs = Date.now();
  const staleAfterMs = 2500;

  for (const t of cpuWorkerTelemetry.values()) {
    if (!t || nowMs - (t.ts || 0) > staleAfterMs) continue;
    cpuLoadOpsPerSec += Math.max(0, Number(t.opsPerSec) || 0);
    cpuDutySum += Math.max(0, Math.min(1, Number(t.duty) || 0));
    cpuDutyCount += 1;
  }

  const avgCpuWorkerDuty = cpuDutyCount > 0 ? cpuDutySum / cpuDutyCount : 0;

  return {
    targetPercent: targetPercent,
    currentPercent: currentPercent,
    cpuWorkers: cpuWorkers.length,
    rampingUp: !!rampUpTimer,
    cpuLoadOpsPerSec,
    avgCpuWorkerDuty,
    mode: 'cpu-ramp-best-effort',
    gpuControlled: false,
  };
}

function configurePhysicalCores(count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  if (_physicalCoreCount === n) return;
  _physicalCoreCount = n;
  if (cpuWorkers.length > 0) stopCpuWorkers();
}

function applyOsCpuFeedback(osUtilPct, targetPct) {
  if (!Number.isFinite(osUtilPct) || !Number.isFinite(targetPct) || targetPct <= 0) return;
  if (rampUpTimer) return;
  if (cpuWorkers.length === 0) return;

  const measuredDuty = Math.max(0.01, osUtilPct / 100);
  const targetDuty = targetPct / 100;
  const error = targetDuty - measuredDuty;

  const correctionPp = Math.max(-15, Math.min(15, error * 100 * 1.5));
  const correctedTarget = Math.max(1, Math.min(100, targetPct + correctionPp));
  setCpuTarget(correctedTarget);
}

function getMeasuredOpsPerMs() {
  const nowMs = Date.now();
  let totalOpsPerSec = 0;
  let count = 0;
  for (const t of cpuWorkerTelemetry.values()) {
    if (!t || nowMs - (t.ts || 0) > 2500) continue;
    totalOpsPerSec += Math.max(0, Number(t.opsPerSec) || 0);
    count += 1;
  }
  if (count === 0) return 100_000;
  return Math.max(1000, totalOpsPerSec / count / 1000);
}

function getMeasuredCpuDuty() {
  const nowMs = Date.now();
  const staleAfterMs = 2500;
  let totalDuty = 0;
  let count = 0;
  for (const t of cpuWorkerTelemetry.values()) {
    if (!t || nowMs - (t.ts || 0) > staleAfterMs) continue;
    totalDuty += Math.max(0, Math.min(1, Number(t.duty) || 0));
    count += 1;
  }
  if (count === 0) return -1;
  return totalDuty / count;
}

module.exports = {
  setHardwareLoadPercent,
  stopHardwareLoad,
  getHardwareLoadState,
  configurePhysicalCores,
  applyOsCpuFeedback,
  getMeasuredCpuDuty,
  getMeasuredOpsPerMs,
  setCoordinatorSeed,
  getCoordinatorSeed,
  drainSeedProofs,
  onSeedProof,
  setCpuTarget,
};
