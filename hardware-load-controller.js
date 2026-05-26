const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

let cpuWorkers = [];
let ddrWorker = null;
// Physical core count: set by the main process via configurePhysicalCores().
// Workers are limited to physical cores so that N% duty cycle = N% of TDP power draw.
// On HT CPUs, spawning workers on all logical cores saturates physical cores at
// 2× the intended duty cycle — double the intended power.
let _physicalCoreCount = null;

// SharedArrayBuffer for zero-event-loop DDR target communication.
// Atomics.wait blocks the worker thread entirely (no JS event loop runs inside it),
// so postMessage is never delivered while the worker sleeps.  SharedArrayBuffer lets
// the main process write a new target percent atomically; the worker reads it at
// the start of each loop iteration without any message-passing delay.
// Layout: Int32Array[0] = sleep semaphore (Atomics.wait/notify), Int32Array[1] = target %
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
let currentPercent = 0;
let targetPercent = 0;
let rampUpStartTime = 0;
let rampUpTimer = null;
const RAMP_UP_DURATION_MS = 3000; // 3 second ramp-up, matching GPU
const MEMORY_LOAD_ENABLE_THRESHOLD_PERCENT = 12;
const MEMORY_LOAD_MAX_WEIGHT = 0.35;

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
}

function ensureCpuWorkers() {
  if (cpuWorkers.length > 0) return;

  const logicalCores = Math.max(1, os.cpus().length || 1);
  // Use physical core count if known (set via configurePhysicalCores from si.cpu()).
  // Fallback: use the full logical count.  On non-HT CPUs logical == physical (correct).
  // On HT CPUs si.cpu() almost always succeeds, so the fallback is rare in practice.
  const physicalCores = _physicalCoreCount || logicalCores;
  const workerCount = Math.min(physicalCores, 16);
  const workerPath = path.join(__dirname, 'cpu-load-worker.js');

  for (let i = 0; i < workerCount; i++) {
    const worker = new Worker(workerPath);
    worker.on('message', (msg) => {
      if (!msg || msg.type !== 'stats') return;
      cpuWorkerTelemetry.set(worker.threadId, {
        opsPerSec: Math.max(0, Number(msg.opsPerSec) || 0),
        duty: Math.max(0, Math.min(1, Number(msg.duty) || 0)),
        burnMs: Math.max(0, Number(msg.burnMs) || 0),
        totalMs: Math.max(0, Number(msg.totalMs) || 0),
        targetPercent: Math.max(0, Math.min(100, Number(msg.targetPercent) || 0)),
        ts: Date.now(),
      });
    });
    worker.on('exit', () => {
      cpuWorkerTelemetry.delete(worker.threadId);
    });
    cpuWorkers.push(worker);
  }
}

function setCpuTarget(percent) {
  ensureCpuWorkers();
  // Workers self-calibrate via work-bounded busy phases (see cpu-load-worker.js):
  // they measure actual elapsed time per ops-batch and derive idle from that, so
  // duty-cycle accuracy tracks boost and thermal-throttle shifts dynamically.
  for (const worker of cpuWorkers) {
    worker.postMessage({ type: 'set-target', percent });
  }
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
  // Capture where the load currently sits so we ramp FROM here, not from 0.
  // This prevents a visible load drop when the slider is adjusted while workers
  // are already running (e.g. mining at 50% → slider moved to 70%).
  const startPercent = currentPercent;
  rampUpStartTime = Date.now();
  targetPercent = targetLoad;

  // Ramp from startPercent to targetLoad over RAMP_UP_DURATION_MS.
  rampUpTimer = setInterval(() => {
    const elapsedMs = Date.now() - rampUpStartTime;
    const rampFactor = Math.min(1, elapsedMs / RAMP_UP_DURATION_MS);
    const nextPercent = Math.round(startPercent + (targetLoad - startPercent) * rampFactor);

    if (nextPercent !== currentPercent) {
      currentPercent = nextPercent;
      // Apply ramped load to CPU workers
      setCpuTarget(nextPercent);
      // Apply ramped load to memory
      if (getEffectiveMemoryTargetPercent(nextPercent) > 0) {
        setMemoryTarget(nextPercent);
      } else {
        stopMemoryPressure();
      }
    }

    // Ramp complete
    if (rampFactor >= 1) {
      stopRampUp();
    }
  }, 50); // 50ms tick = 60 updates per second for smooth ramp
}

function ensureDdrShared() {
  if (!ddrSharedBuf) {
    ddrSharedBuf = new SharedArrayBuffer(8); // 2 × Int32
    ddrSharedInt = new Int32Array(ddrSharedBuf);
    Atomics.store(ddrSharedInt, 0, 0); // sleep semaphore
    Atomics.store(ddrSharedInt, 1, 0); // target percent
  }
}

function stopMemoryPressure() {
  if (ddrSharedInt) {
    Atomics.store(ddrSharedInt, 1, 0); // signal worker: target = 0
    Atomics.notify(ddrSharedInt, 0); // wake it if sleeping
  }
  if (ddrWorker) {
    try {
      ddrWorker.terminate();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[HwLoad] Caught:', String(_.message || _).slice(0, 80));
    }
    ddrWorker = null;
  }
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

  // DDR load runs in a dedicated Worker thread (ddr-load-worker.js) using
  // Atomics.wait for precise sub-ms sleep, bypassing the Windows OS timer floor
  // (~4 ms) that makes setTimeout-based duty-cycle control inaccurate at moderate
  // to high loads.  The worker self-calibrates its chunk walk time each iteration.
  // Target is communicated via SharedArrayBuffer (atomic write + notify) rather
  // than postMessage — Atomics.wait blocks the entire thread so the event loop
  // never runs and postMessage would be silently dropped.
  ensureDdrShared();
  Atomics.store(ddrSharedInt, 1, effectiveTarget);
  Atomics.notify(ddrSharedInt, 0); // wake worker early if it's mid-sleep

  if (!ddrWorker) {
    const ddrWorkerPath = path.join(__dirname, 'ddr-load-worker.js');
    ddrWorker = new Worker(ddrWorkerPath, { workerData: { sharedBuf: ddrSharedBuf } });
    ddrWorker.on('message', (msg) => {
      if (!msg || msg.type !== 'stats') return;
      ddrTelemetry = {
        mbps: Math.max(0, Number(msg.mbps) || 0),
        duty: Math.max(0, Math.min(1, Number(msg.duty) || 0)),
        burnMs: Math.max(0, Number(msg.burnMs) || 0),
        totalMs: Math.max(0, Number(msg.totalMs) || 0),
        targetPercent: Math.max(0, Math.min(100, Number(msg.targetPercent) || 0)),
        ts: Date.now(),
      };
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

  // Start ramping CPU and memory load gradually from current to next over 3 seconds
  startRampUp(next);
  return currentPercent;
}

function stopHardwareLoad() {
  stopRampUp();
  currentPercent = 0;
  targetPercent = 0;
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

// Must be called once at startup with the physical (non-HT) core count so that
// duty-cycle % maps linearly to power-draw %.  If called after workers are already
// running, existing workers are torn down so the next load call recreates the correct number.
function configurePhysicalCores(count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  if (_physicalCoreCount === n) return;
  _physicalCoreCount = n;
  // Tear down existing workers so ensureCpuWorkers() recreates with the right count.
  if (cpuWorkers.length > 0) stopCpuWorkers();
}

// OS CPU feedback: outer proportional correction loop driven by the Windows
// Performance Counter reading (same source as Task Manager's CPU%).
// The per-worker internal controller already self-corrects based on wall-clock duty
// within each worker's own thread.  This outer loop corrects for:
//   • Scheduling contention from other processes eating into the target share
//   • Per-worker internal controllers drifting relative to system-wide load
//
// targetPct: the user-requested load (e.g. 50%)
// osUtilPct: system-wide CPU% reported by Task Manager (0-100)
//
// The correction formula mirrors the GPU feedback idle adjustment:
//   error = (target% - measured%) / 100
//   correctedTarget = targetPct + error × targetPct × gain
// Gain 1.5 gives fast convergence (~3 cycles) without oscillation.
// Clamp to ±15 pp so a brief spike from another process can't zero-out the workers.
// Skipped during ramp-up so the correction doesn't fight the ramp.
function applyOsCpuFeedback(osUtilPct, targetPct) {
  if (!Number.isFinite(osUtilPct) || !Number.isFinite(targetPct) || targetPct <= 0) return;
  if (rampUpTimer) return; // don't fight the ramp-up logic
  if (cpuWorkers.length === 0) return;

  const measuredDuty = Math.max(0.01, osUtilPct / 100);
  const targetDuty = targetPct / 100;
  const error = targetDuty - measuredDuty; // positive = under-shooting

  // Proportional correction: clamp to ±15 pp to avoid over-reacting to spikes.
  const correctionPp = Math.max(-15, Math.min(15, error * 100 * 1.5));
  const correctedTarget = Math.max(1, Math.min(100, targetPct + correctionPp));
  setCpuTarget(correctedTarget);
}

module.exports = {
  setHardwareLoadPercent,
  stopHardwareLoad,
  getHardwareLoadState,
  configurePhysicalCores,
  applyOsCpuFeedback,
};
