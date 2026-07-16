const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

let cpuWorkers = [];
let ddrWorker = null;
let _physicalCoreCount = null;

// SharedArrayBuffer for zero-event-loop DDR target communication.
let ddrSharedBuf = null;
let ddrSharedInt = null;
const cpuWorkerTelemetry = new Map();
let ddrTelemetry = {
  mbps: 0,
  duty: 0,
  burnMs: 0,
  totalMs: 0,
  targetPercent: 0,
  ts: 0,
};
let _accumulatedMemBurnMs = 0;
let currentPercent = 0;
let targetPercent = 0;
let rampUpStartTime = 0;
let rampUpTimer = null;
const RAMP_UP_DURATION_MS = 3000;
const MEMORY_LOAD_ENABLE_THRESHOLD_PERCENT = 12;
const MEMORY_LOAD_MAX_WEIGHT = 0.35;

// ── Coordinator seed state ────────────────────────────────────────────────
// Tracks the current coordinator-issued seed and cumulative proof data
// across all CPU workers for the current seed period.
let _activeCoordinatorSeed = null;
let _seedProofs = new Map(); // workerThreadId → { startState, totalOps, burnMs }
let _onSeedProof = null; // callback: (proof) => void — called when a worker submits a proof

// ── DDR seed state ────────────────────────────────────────────────────────
// Memory worker seed proof tracking (same pattern as CPU).
let _activeDdrSeed = null;
let _ddrSeedProofs = new Map(); // workerThreadId → { startState, totalOps, burnMs }
let _onDdrSeedProof = null;

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function stopCpuWorkers() {
  for (const worker of cpuWorkers) {
    try {
      worker.postMessage({ type: 'stop' });
      worker.terminate();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[HwLoad] Caught:', String(_.message || _).slice(0, 80));
    }
  }
  cpuWorkers = [];
  cpuWorkerTelemetry.clear();
  _seedProofs.clear();
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
  const workerCount = Math.min(physicalCores, 16);
  const workerPath = path.join(__dirname, 'cpu-load-worker.js');

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(workerPath);
    worker.on('message', (msg) => {
      if (!msg) return;
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
    worker.on('exit', () => {
      cpuWorkerTelemetry.delete(worker.threadId);
      _seedProofs.delete(worker.threadId);
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

// ── DDR seed management ───────────────────────────────────────────────────
function setDdrCoordinatorSeed(seed) {
  if (seed === _activeDdrSeed) return;
  _activeDdrSeed = seed;
  if (ddrWorker) {
    try {
      ddrWorker.postMessage({ type: 'set-seed', seed });
    } catch (_) {
      /* worker may have exited */
    }
  }
}

function drainDdrSeedProofs() {
  const entries = [];
  for (const [k, v] of _ddrSeedProofs) entries.push([k, v]);
  _ddrSeedProofs.clear();
  return new Map(entries);
}

function onDdrSeedProof(callback) {
  _onDdrSeedProof = callback;
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
      if (getEffectiveMemoryTargetPercent(nextPercent) > 0) {
        setMemoryTarget(nextPercent);
      } else {
        stopMemoryPressure();
      }
    }

    if (rampFactor >= 1) {
      stopRampUp();
    }
  }, 50);
}

function ensureDdrShared() {
  if (!ddrSharedBuf) {
    ddrSharedBuf = new SharedArrayBuffer(8);
    ddrSharedInt = new Int32Array(ddrSharedBuf);
    Atomics.store(ddrSharedInt, 0, 0);
    Atomics.store(ddrSharedInt, 1, 0);
  }
}

function stopMemoryPressure() {
  if (ddrSharedInt) {
    Atomics.store(ddrSharedInt, 1, 0);
    Atomics.notify(ddrSharedInt, 0);
  }
  if (ddrWorker) {
    try {
      ddrWorker.postMessage({ type: 'stop' });
      ddrWorker.terminate();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[HwLoad] Caught:', String(_.message || _).slice(0, 80));
    }
    ddrWorker = null;
  }
  _ddrSeedProofs.clear();
  ddrTelemetry = {
    mbps: 0,
    duty: 0,
    burnMs: 0,
    totalMs: 0,
    targetPercent: 0,
    ts: Date.now(),
  };
}

function getEffectiveMemoryTargetPercent(percent) {
  const clamped = clampPercent(percent);
  if (clamped <= MEMORY_LOAD_ENABLE_THRESHOLD_PERCENT) return 0;
  const normalizedRange =
    (clamped - MEMORY_LOAD_ENABLE_THRESHOLD_PERCENT) / (100 - MEMORY_LOAD_ENABLE_THRESHOLD_PERCENT);
  return Math.round(clamped * MEMORY_LOAD_MAX_WEIGHT * Math.max(0, Math.min(1, normalizedRange)));
}

function setMemoryTarget(percent) {
  const effectiveTarget = getEffectiveMemoryTargetPercent(percent);
  if (effectiveTarget <= 0) {
    stopMemoryPressure();
    return;
  }

  ensureDdrShared();
  Atomics.store(ddrSharedInt, 1, effectiveTarget);
  Atomics.notify(ddrSharedInt, 0);

  if (!ddrWorker) {
    const ddrWorkerPath = path.join(__dirname, 'ddr-load-worker.js');
    ddrWorker = new Worker(ddrWorkerPath, { workerData: { sharedBuf: ddrSharedBuf } });
    ddrWorker.on('message', (msg) => {
      if (!msg) return;
      if (msg.type === 'stats') {
        _accumulatedMemBurnMs += Math.max(0, Number(msg.burnMs) || 0);
        ddrTelemetry = {
          mbps: Math.max(0, Number(msg.mbps) || 0),
          duty: Math.max(0, Math.min(1, Number(msg.duty) || 0)),
          burnMs: Math.max(0, Number(msg.burnMs) || 0),
          totalMs: Math.max(0, Number(msg.totalMs) || 0),
          targetPercent: Math.max(0, Math.min(100, Number(msg.targetPercent) || 0)),
          ts: Date.now(),
        };
      } else if (msg.type === 'seed-proof') {
        _ddrSeedProofs.set(ddrWorker.threadId, {
          seed: msg.seed,
          startState: msg.startState,
          endState: msg.endState,
          totalOps: Number(msg.totalOps) || 0,
          burnMs: Number(msg.burnMs) || 0,
          intermediateProof: msg.intermediateProof,
        });
        if (typeof _onDdrSeedProof === 'function') {
          _onDdrSeedProof(msg);
        }
      }
    });
    ddrWorker.on('error', () => {
      ddrWorker = null;
    });
  }
}

function setHardwareLoadPercent(percent) {
  const next = clampPercent(percent);

  if (next <= 0) {
    stopRampUp();
    stopCpuWorkers();
    stopMemoryPressure();
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
  _accumulatedMemBurnMs = 0;
  stopCpuWorkers();
  stopMemoryPressure();
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
  const memLoadMBps = nowMs - (ddrTelemetry.ts || 0) <= staleAfterMs ? Math.max(0, Number(ddrTelemetry.mbps) || 0) : 0;
  const memDuty =
    nowMs - (ddrTelemetry.ts || 0) <= staleAfterMs ? Math.max(0, Math.min(1, Number(ddrTelemetry.duty) || 0)) : 0;

  return {
    targetPercent: targetPercent,
    currentPercent: currentPercent,
    cpuWorkers: cpuWorkers.length,
    memoryPressureEnabled: !!ddrWorker,
    rampingUp: !!rampUpTimer,
    cpuLoadOpsPerSec,
    avgCpuWorkerDuty,
    memLoadMBps,
    memDuty,
    mode: 'cpu-memory-ramp-best-effort',
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

function consumeMemBurnMs() {
  const ms = _accumulatedMemBurnMs;
  _accumulatedMemBurnMs = 0;
  return ms;
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
  consumeMemBurnMs,
  setDdrCoordinatorSeed,
  drainDdrSeedProofs,
  onDdrSeedProof,
};
