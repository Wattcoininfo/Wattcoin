const { parentPort } = require('worker_threads');
const { performance } = require('perf_hooks');

let targetPercent = 0;
let running = true;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const STATS_REPORT_MS = 1000;
let statsLastReportAt = performance.now();
let statsOps = 0;
let statsBurnMs = 0;
let statsTotalMs = 0;

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(sleepArray, 0, 0, Math.round(ms));
}

// Work-bounded burn: execute exactly `ops` multiply-mod iterations.
// The elapsed wall-clock time varies with current CPU frequency (boost/throttle),
// so measuring it gives real calibration data for opsPerMs.
function burnCpuOps(ops) {
  let x = 1;
  const n = ops | 0;
  for (let i = 0; i < n; i++) {
    x = (x * 48271) % 2147483647;
  }
  return x; // prevent dead-code elimination
}

// EMA of ops per ms at current CPU frequency.  Seed conservatively; calibrates
// to the actual clock within a handful of cycles via the EMA update below.
let opsPerMs = 1_000_000;

// Target busy-phase duration at 100% load.  Scales proportionally at lower %.
// Longer windows reduce visible Task Manager oscillation on laptops/Win10 while
// still reacting quickly to slider changes.
const TARGET_BURST_MS = 120;
const MIN_BURN_MS = 8;

// ---------------------------------------------------------------------------
// Rolling-window proportional feedback controller
//
// process.cpuUsage() on Windows uses GetProcessTimes() — it returns the WHOLE
// process CPU time across all threads, not per-thread.  With N workers burning
// in parallel each worker sees ~N× the CPU time it actually consumed, making idle
// N× too long and actual duty-cycle f/N instead of f.
//
// This controller avoids that bias entirely: it only uses wall-clock time, but
// measures the ACTUAL duty cycle achieved over the last WINDOW cycles and applies
// a proportional correction to each upcoming sleep.  Preemption spikes are single-
// cycle outliers that the window averages away; thermal/boost shifts update
// opsPerMs continuously so op-count stays correct every cycle.
//
// Convergence: with WINDOW=16 and gain=1.2, correction is smoother (less oscillation)
// and typically settles within ~1-2 seconds after start/target change.
// ---------------------------------------------------------------------------
const WINDOW  = 16;
const burnBuf  = new Float64Array(WINDOW);
const totalBuf = new Float64Array(WINDOW);
let wIdx  = 0;
let wFull = false;

function resetWindow() { wIdx = 0; wFull = false; }

function loop() {
  if (!running) return;

  const maybeReportStats = () => {
    const nowMs = performance.now();
    const elapsedMs = nowMs - statsLastReportAt;
    if (elapsedMs < STATS_REPORT_MS) return;
    const secs = Math.max(0.001, elapsedMs / 1000);
    const opsPerSec = statsOps / secs;
    const duty = statsTotalMs > 0 ? Math.max(0, Math.min(1, statsBurnMs / statsTotalMs)) : 0;
    try {
      parentPort.postMessage({
        type: 'stats',
        opsPerSec,
        duty,
        burnMs: statsBurnMs,
        totalMs: statsTotalMs,
        targetPercent,
      });
    } catch (_) {
      // Ignore telemetry post failures.
    }
    statsLastReportAt = nowMs;
    statsOps = 0;
    statsBurnMs = 0;
    statsTotalMs = 0;
  };

  if (targetPercent > 0) {
    const f = Math.min(1, targetPercent / 100);
    const desiredBurnMs = Math.max(MIN_BURN_MS, TARGET_BURST_MS * f);
    const ops = Math.max(1000, Math.round(desiredBurnMs * opsPerMs));

    // Burn phase — wall-clock timed
    const t0 = performance.now();
    burnCpuOps(ops);
    const wallBurnMs = Math.max(0.1, performance.now() - t0);
    statsOps += ops;

    // Update frequency EMA (wall time reflects boost/throttle accurately per-thread)
    opsPerMs = 0.85 * opsPerMs + 0.15 * (ops / wallBurnMs);

    // Nominal idle for this cycle, ignoring history: busy/(busy+idle) = f
    const nominalIdle = (1 - f) / f * wallBurnMs;

    // Proportional correction: compare measured duty over the last n cycles to f.
    let idleMs = nominalIdle;
    const n = wFull ? WINDOW : wIdx;
    if (n >= 4) {
      let sumBurn = 0, sumTotal = 0;
      for (let i = 0; i < n; i++) { sumBurn += burnBuf[i]; sumTotal += totalBuf[i]; }
      const measuredDuty = sumBurn / sumTotal;
      const error = f - measuredDuty;          // positive = under-shooting target
      const avgCycle = sumTotal / n;
      // Reduce idle when under-shooting, increase when over-shooting.
      // Gain 1.2: smoother correction for laptop schedulers and core parking.
      idleMs = Math.max(0, nominalIdle - error * avgCycle * 1.2);
    }

    // Sleep and measure actual sleep (timer imprecision captured in totalBuf)
    const sleepT0 = performance.now();
    if (Math.round(idleMs) >= 1) sleepMs(Math.round(idleMs));
    const actualSleep = Math.max(0, performance.now() - sleepT0);
    statsBurnMs += wallBurnMs;
    statsTotalMs += wallBurnMs + actualSleep;

    // Record this cycle in the rolling window
    burnBuf[wIdx]  = wallBurnMs;
    totalBuf[wIdx] = wallBurnMs + actualSleep;
    wIdx = (wIdx + 1) % WINDOW;
    if (wIdx === 0) wFull = true;
  } else {
    sleepMs(50); // quiescent: wait for a new target
    resetWindow(); // discard history so restart doesn't inherit stale data
    statsTotalMs += 50;
  }

  maybeReportStats();

  setImmediate(loop);
}

parentPort.on('message', (message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'set-target') {
    const prev = targetPercent;
    targetPercent = clampPercent(message.percent);
    // Reset window on target change so stale history doesn't slow convergence
    if (targetPercent !== prev) resetWindow();
  } else if (message.type === 'stop') {
    running = false;
    process.exit(0);
  }
});

loop();
