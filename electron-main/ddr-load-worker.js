// DDR (system memory) load worker.
// Runs in a dedicated Worker thread so the main Node.js event loop is never
// blocked, allowing IPC handlers to respond normally even under heavy DDR load.
//
// Uses Atomics.wait for sleep — it bypasses the Windows OS timer floor (~4 ms)
// that cripples setTimeout-based duty-cycle control at moderate-to-high loads.
//
// Duty-cycle design:
//   Each iteration walks CHUNK_SIZE bytes with 64-byte (cache-line) stride so
//   every access is a cache miss and forces a real DRAM fetch.  After each walk
//   the worker measures the actual elapsed time (chunkMs) and uses a rolling-window
//   proportional feedback controller to compute idleMs, giving:
//     busyTime / (busyTime + idleTime) = f  (accurate load fraction).
//   Because Atomics.wait is precise to ~1 ms on Windows, the formula works for
//   any DDR speed without pre-calibration.
//
// SHA-256 seed proof generation:
//   In addition to memory walks, the worker runs an iterated SHA-256 hash chain
//   using the coordinator-assigned seed.  This produces verifiable seed proofs
//   (same format as the CPU worker) for energy accounting.
//
// Target communication via SharedArrayBuffer (workerData.sharedBuf):
//   Atomics.wait blocks the thread at the OS level — no JavaScript event loop
//   runs while sleeping, so postMessage is silently dropped.  Instead, the
//   controller writes the target percent directly into a shared Int32Array and
//   calls Atomics.notify to wake the worker early if it is mid-sleep.
//   Layout: sharedInt[0] = sleep semaphore, sharedInt[1] = target percent (0-100).

'use strict';

const { workerData, parentPort } = require('worker_threads');
const { performance } = require('perf_hooks');
const crypto = require('crypto');

// sharedInt[0]: sleep semaphore -- Atomics.wait here; controller calls Atomics.notify to wake early
// sharedInt[1]: target percent (0-100) written atomically by the controller
const sharedInt = new Int32Array(workerData.sharedBuf);

const BUF_SIZE = 128 * 1024 * 1024; // 128 MB -- exceeds typical L3 cache
const CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB burst per iteration for smoother laptop load

let buf = null;
let cursor = 0;
const STATS_REPORT_MS = 1000;
let statsLastReportAt = performance.now();
let statsBytesTouched = 0;
let statsBurnMs = 0;
let statsTotalMs = 0;

// ── Coordinator seed state ────────────────────────────────────────────────
// Same pattern as cpu-load-worker: iterated SHA-256 hash chain with seed
// proof submission on seed change.
const BURN_PROOF_STEP = 256;
let activeSeed = null;
let seedStartTs = 0;
let seedTotalOps = 0;
let seedTotalBurnMs = 0;
let seedStartState = null;
let seedLastState = null;
let seedAbsoluteStep = 0;
let seedIntermediates = [];

function sleepMs(ms) {
  const rounded = Math.max(0, Math.round(ms));
  if (rounded === 0) return;
  // Atomics.wait on the semaphore index; controller can wake us early via Atomics.notify.
  Atomics.wait(sharedInt, 0, 0, rounded);
}

function ensureBuffer() {
  if (!buf || buf.length !== BUF_SIZE) {
    buf = Buffer.allocUnsafe(BUF_SIZE);
    cursor = 0;
  }
}

function walkChunk() {
  ensureBuffer();
  const len = buf.length;
  const end = Math.min(len, cursor + CHUNK_SIZE);
  // 64-byte stride = one cache line -> forces sequential DRAM reads
  for (let i = cursor; i < end; i += 64) {
    buf[i] = (buf[i] + 1) & 0xff;
  }
  statsBytesTouched += Math.max(0, end - cursor);
  cursor = end >= len ? 0 : end;
}

// ── SHA-256 hash burning (same as cpu-load-worker) ────────────────────────
function burnMemOps(ops, seed) {
  const seedBuf = seed ? Buffer.from(seed, 'hex') : Buffer.alloc(32);

  let state;
  if (!seedStartState) {
    seedStartState = Buffer.alloc(32);
    seedStartTs = Date.now();
    const startInput = Buffer.alloc(64);
    seedStartState.copy(startInput, 0);
    seedBuf.copy(startInput, 32);
    state = crypto.createHash('sha256').update(startInput).digest();
  } else {
    state = seedLastState;
  }

  const n = ops | 0;
  for (let i = 0; i < n; i++) {
    const absStep = seedAbsoluteStep + i;
    const input = Buffer.alloc(68);
    state.copy(input, 0);
    input.writeUInt32LE(absStep >>> 0, 32);
    seedBuf.copy(input, 36);
    state = crypto.createHash('sha256').update(input).digest();
    if (absStep % BURN_PROOF_STEP === 0) {
      seedIntermediates.push(state);
    }
  }

  seedAbsoluteStep += n;
  seedLastState = state;

  const proof =
    seedIntermediates.length > 0
      ? crypto.createHash('sha256').update(Buffer.concat(seedIntermediates)).digest()
      : crypto.createHash('sha256').update(Buffer.alloc(0)).digest();

  return { burnResult: state, proof };
}

// ── Seed proof submission ─────────────────────────────────────────────────
function submitSeedProof(prevSeed) {
  if (!prevSeed || seedTotalOps < 1000) return;
  try {
    parentPort.postMessage({
      type: 'seed-proof',
      seed: prevSeed,
      startState: seedStartState ? seedStartState.toString('hex') : '',
      endState: seedLastState ? seedLastState.toString('hex') : '',
      totalOps: seedTotalOps,
      burnMs: Math.round(seedTotalBurnMs * 100) / 100,
      intermediateProof:
        seedIntermediates.length > 0
          ? crypto.createHash('sha256').update(Buffer.concat(seedIntermediates)).digest('hex')
          : '',
    });
  } catch (_) {
    /* ignore post failures */
  }
}

// ── Seed management ───────────────────────────────────────────────────────
function setActiveSeed(newSeed) {
  if (newSeed === activeSeed) return;
  const prevSeed = activeSeed;
  if (prevSeed) {
    submitSeedProof(prevSeed);
  }
  activeSeed = newSeed;
  seedStartTs = 0;
  seedTotalOps = 0;
  seedTotalBurnMs = 0;
  seedStartState = null;
  seedLastState = null;
  seedAbsoluteStep = 0;
  seedIntermediates = [];
}

function maybeReportStats(targetPercent) {
  const nowMs = performance.now();
  const elapsedMs = nowMs - statsLastReportAt;
  if (elapsedMs < STATS_REPORT_MS) return;
  const secs = Math.max(0.001, elapsedMs / 1000);
  const mbps = statsBytesTouched / (1024 * 1024) / secs;
  const duty = statsTotalMs > 0 ? Math.max(0, Math.min(1, statsBurnMs / statsTotalMs)) : 0;
  try {
    parentPort.postMessage({
      type: 'stats',
      mbps,
      duty,
      burnMs: statsBurnMs,
      totalMs: statsTotalMs,
      targetPercent,
      seedProof: activeSeed
        ? {
            seed: activeSeed,
            totalOps: seedTotalOps,
            burnMs: Math.round(seedTotalBurnMs * 100) / 100,
            startState: seedStartState ? seedStartState.toString('hex') : '',
          }
        : null,
    });
  } catch (_) {
    // Ignore telemetry post failures.
  }
  statsLastReportAt = nowMs;
  statsBytesTouched = 0;
  statsBurnMs = 0;
  statsTotalMs = 0;
}

// ── Rolling-window proportional feedback controller ──────────────────────
const WINDOW = 16;
const burnBuf = new Float64Array(WINDOW);
const totalBuf = new Float64Array(WINDOW);
let wIdx = 0;
let wFull = false;

function resetWindow() {
  wIdx = 0;
  wFull = false;
}

// SHA-256 ops per ms estimate (updated from measured throughput)
let memOpsPerMs = 500;
const TARGET_BURST_MS = 80;

function loop() {
  let lastTarget = -1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const targetPercent = Atomics.load(sharedInt, 1);

    if (targetPercent <= 0) {
      Atomics.wait(sharedInt, 0, 0, 50);
      resetWindow();
      lastTarget = 0;
      statsTotalMs += 50;
      maybeReportStats(0);
      continue;
    }

    // Reset window when target changes so stale history doesn't slow convergence
    if (targetPercent !== lastTarget) {
      resetWindow();
      lastTarget = targetPercent;
    }

    const f = Math.max(0.01, Math.min(1, targetPercent / 100));

    // Walk chunk (DRAM stress) and measure wall time
    const t0 = performance.now();
    walkChunk();
    const wallChunkMs = Math.max(0.1, performance.now() - t0);
    statsBurnMs += wallChunkMs;

    // SHA-256 hash burning (seed proof generation)
    if (activeSeed) {
      const desiredOps = Math.max(1000, Math.round(TARGET_BURST_MS * f * memOpsPerMs));
      const hashT0 = performance.now();
      const { burnResult } = burnMemOps(desiredOps, activeSeed);
      const hashWallMs = Math.max(0.1, performance.now() - hashT0);
      seedTotalOps += desiredOps;
      seedTotalBurnMs += hashWallMs;
      // Update ops/ms EMA
      if (hashWallMs > 0) {
        memOpsPerMs = 0.85 * memOpsPerMs + 0.15 * (desiredOps / hashWallMs);
      }
    }

    // Nominal idle: busy/(busy+idle) = f
    const nominalIdle = ((1 - f) / f) * wallChunkMs;

    // Proportional correction from rolling window
    let idleMs = nominalIdle;
    const n = wFull ? WINDOW : wIdx;
    if (n >= 4) {
      let sumBurn = 0,
        sumTotal = 0;
      for (let i = 0; i < n; i++) {
        sumBurn += burnBuf[i];
        sumTotal += totalBuf[i];
      }
      const measuredDuty = sumBurn / sumTotal;
      const error = f - measuredDuty; // positive = under-shooting target
      const avgCycle = sumTotal / n;
      idleMs = Math.max(0, nominalIdle - error * avgCycle * 1.2);
    }

    // Sleep and record actual sleep
    const sleepT0 = performance.now();
    sleepMs(Math.round(Math.max(0, idleMs)));
    const actualSleep = Math.max(0, performance.now() - sleepT0);
    statsTotalMs += wallChunkMs + actualSleep;

    // Update rolling window
    burnBuf[wIdx] = wallChunkMs;
    totalBuf[wIdx] = wallChunkMs + actualSleep;
    wIdx = (wIdx + 1) % WINDOW;
    if (wIdx === 0) wFull = true;
    maybeReportStats(targetPercent);
  }
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'set-seed') {
    setActiveSeed(message.seed || null);
  } else if (message.type === 'stop') {
    if (activeSeed && seedTotalOps >= 1000) {
      submitSeedProof(activeSeed);
    }
    process.exit(0);
  }
});

loop();
