const { parentPort } = require('worker_threads');
const { performance } = require('perf_hooks');
const crypto = require('crypto');

let targetPercent = 0;
let running = true;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const STATS_REPORT_MS = 1000;
let statsLastReportAt = performance.now();
let statsOps = 0;
let statsBurnMs = 0;
let statsTotalMs = 0;

// ── Coordinator seed state ────────────────────────────────────────────────
// The coordinator issues a seed via peer probe.  The worker mines with that
// seed and accumulates total ops for the seed period.  When the next seed
// arrives, the worker submits a proof of work.
const BURN_PROOF_STEP = 256;
let activeSeed = null;
let seedStartTs = 0;
let seedTotalOps = 0;
let seedTotalBurnMs = 0;
let seedStartState = null;
let seedLastState = null;
let seedAbsoluteStep = 0;
let seedIntermediates = [];

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function sleepMs(ms) {
  if (ms <= 0) return;
  Atomics.wait(sleepArray, 0, 0, Math.round(ms));
}

// Work-bounded burn: execute `ops` iterations of iterated SHA-256.
//   state = SHA-256(burnStartState ‖ LE32(i) ‖ seed) for i in 0..ops
// burnStartState = SHA-256(chainState ‖ seed) binds the burn to the seed.
// Intermediate states are recorded every BURN_PROOF_STEP iterations for proof.
// Returns { burnResult (Buffer), proof (Buffer) }.
function burnCpuOps(ops, seed) {
  const seedBuf = seed ? Buffer.from(seed, 'hex') : Buffer.alloc(32);

  let state;
  if (!seedStartState) {
    // First call for this seed: store the chain state (prevState) and
    // derive the burn start state: SHA-256(chainState ‖ seed).
    seedStartState = Buffer.alloc(32);
    seedStartTs = Date.now();
    const startInput = Buffer.alloc(64);
    seedStartState.copy(startInput, 0);
    seedBuf.copy(startInput, 32);
    state = crypto.createHash('sha256').update(startInput).digest();
  } else {
    // Subsequent calls: continue from the last running state.
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

  // Proof = SHA-256(concatenated intermediate states)
  const proof =
    seedIntermediates.length > 0
      ? crypto.createHash('sha256').update(Buffer.concat(seedIntermediates)).digest()
      : crypto.createHash('sha256').update(Buffer.alloc(0)).digest();

  return { burnResult: state, proof };
}

// EMA of ops per ms at current CPU frequency.
let opsPerMs = 1_000;

// Target busy-phase duration at 100% load.  Scales proportionally at lower %.
const TARGET_BURST_MS = 120;
const MIN_BURN_MS = 8;

// ── Seed proof submission ─────────────────────────────────────────────────
// When a new seed arrives, submit proof of work done with the previous seed.
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
// Called when coordinator issues a new seed.  Submit proof of previous work,
// then reset accumulators for the new seed.
function setActiveSeed(newSeed) {
  if (newSeed === activeSeed) return;
  const prevSeed = activeSeed;

  // Submit proof of work done with previous seed BEFORE resetting accumulators
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

// Rolling-window proportional feedback controller
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
        opsPerMs,
        // Seed proof data for coordinator verification
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
    const { burnResult } = burnCpuOps(ops, activeSeed);
    const wallBurnMs = Math.max(0.1, performance.now() - t0);
    statsOps += ops;
    seedTotalOps += ops;
    seedTotalBurnMs += wallBurnMs;

    // Update frequency EMA
    opsPerMs = 0.85 * opsPerMs + 0.15 * (ops / wallBurnMs);

    // Nominal idle for this cycle
    const nominalIdle = ((1 - f) / f) * wallBurnMs;

    // Proportional correction
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
      const error = f - measuredDuty;
      const avgCycle = sumTotal / n;
      idleMs = Math.max(0, nominalIdle - error * avgCycle * 1.2);
    }

    // Sleep and measure actual sleep
    const sleepT0 = performance.now();
    if (Math.round(idleMs) >= 1) sleepMs(Math.round(idleMs));
    const actualSleep = Math.max(0, performance.now() - sleepT0);
    statsBurnMs += wallBurnMs;
    statsTotalMs += wallBurnMs + actualSleep;

    // Record this cycle in the rolling window
    burnBuf[wIdx] = wallBurnMs;
    totalBuf[wIdx] = wallBurnMs + actualSleep;
    wIdx = (wIdx + 1) % WINDOW;
    if (wIdx === 0) wFull = true;
  } else {
    sleepMs(50); // quiescent: wait for a new target
    resetWindow();
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
    if (targetPercent !== prev) resetWindow();
  } else if (message.type === 'set-seed') {
    setActiveSeed(message.seed || null);
  } else if (message.type === 'stop') {
    running = false;
    // Submit proof of any in-progress work before exiting
    if (activeSeed && seedTotalOps >= 1000) {
      submitSeedProof(activeSeed);
    }
    process.exit(0);
  }
});

loop();
