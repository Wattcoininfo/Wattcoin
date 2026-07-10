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
// Target communication via SharedArrayBuffer (workerData.sharedBuf):
//   Atomics.wait blocks the thread at the OS level — no JavaScript event loop
//   runs while sleeping, so postMessage is silently dropped.  Instead, the
//   controller writes the target percent directly into a shared Int32Array and
//   calls Atomics.notify to wake the worker early if it is mid-sleep.
//   Layout: sharedInt[0] = sleep semaphore, sharedInt[1] = target percent (0-100).

'use strict';

const { workerData } = require('worker_threads');
const { performance } = require('perf_hooks');
const { parentPort } = require('worker_threads');

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
    });
  } catch (_) {
    // Ignore telemetry post failures.
  }
  statsLastReportAt = nowMs;
  statsBytesTouched = 0;
  statsBurnMs = 0;
  statsTotalMs = 0;
}

// ---------------------------------------------------------------------------
// Rolling-window proportional feedback controller (same design as cpu-load-worker).
// Measures actual duty cycle over the last WINDOW cycles and applies a proportional
// correction to each idle sleep.  Immune to process.cpuUsage() process-wide bias,
// OS timer imprecision, and per-cycle preemption spikes (averaged out by the window).
// ---------------------------------------------------------------------------
const WINDOW = 16;
const burnBuf = new Float64Array(WINDOW);
const totalBuf = new Float64Array(WINDOW);
let wIdx = 0;
let wFull = false;

function resetWindow() {
  wIdx = 0;
  wFull = false;
}

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

    // Walk chunk and measure wall time
    const t0 = performance.now();
    walkChunk();
    const wallChunkMs = Math.max(0.1, performance.now() - t0);
    statsBurnMs += wallChunkMs;

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

loop();
