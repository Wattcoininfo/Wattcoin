'use strict';
const { spawnSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const CPU_SPEED_N = 20_000_000;
const CPU_SPEED_DEFAULT_RUNS = 5;

const PROBE_CPU_ITERS = 200_000_000;
const PROBE_CPU_DURATION_MS = 1000;
const PROBE_GPU_POW_DIFFICULTY = 1024;
const PROBE_GPU_POW_SIZE = 32;
const PROBE_GPU_POW_ITERS = 50000;

const PROBE_PEER_SLACK = 1.4;
const PROBE_LOCAL_SLACK = 1.4;

const GPU_PROOF_SIZE = 128;
const GPU_PROOF_ITERS = 32;

function _hasCommand(command, args = ['--help']) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 1500,
    });
    return !result.error;
  } catch (_) {
    return false;
  }
}

function _runCommand(command, args = [], timeout = 2000) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
    });
    if (result.error || result.status !== 0) return '';
    return (result.stdout || '').trim();
  } catch (_) {
    return '';
  }
}

function _runCommandDetailed(command, args = [], timeout = 2000) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
    });
    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      error: result.error || null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      stdout: '',
      stderr: '',
      error,
    };
  }
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sum = values.reduce((acc, value) => acc + value, 0);
  return sum / values.length;
}

function deriveProbeSeed(chainHead, chainIndex) {
  const raw = crypto.createHash('sha256').update(`${chainHead}|${chainIndex}`).digest('hex');
  return parseInt(raw.slice(0, 8), 16) >>> 0;
}

async function runCpuBenchmark(request = {}) {
  const challengeSeed = Number.isFinite(Number(request.challengeSeed))
    ? Math.floor(Number(request.challengeSeed))
    : crypto.randomBytes(4).readUInt32BE(0) % 1_000_000_000;
  let x = challengeSeed || 1;
  const cpuSamples = [];
  const phaseCount = Number.isFinite(Number(request.phaseCount)) ? Math.max(1, Number(request.phaseCount)) : 4;
  const phaseDurationMs = Number.isFinite(Number(request.phaseDurationMs))
    ? Math.max(30, Number(request.phaseDurationMs))
    : 100;

  for (let phase = 0; phase < phaseCount; phase += 1) {
    const phaseStart = performance.now();
    let ops = 0;
    const CPU_YIELD_INTERVAL = 5_000_000;
    while (performance.now() - phaseStart < phaseDurationMs) {
      for (let j = 0; j < CPU_YIELD_INTERVAL; j++) {
        x = (x * 48271 + (phase + 1) * 9973) % 2147483647;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
      }
      ops += CPU_YIELD_INTERVAL;
      if (performance.now() - phaseStart < phaseDurationMs) await new Promise((r) => setImmediate(r));
    }
    const elapsed = Math.max(1, performance.now() - phaseStart);
    cpuSamples.push((ops * 1000) / elapsed);
    if (phase + 1 < phaseCount) await new Promise((r) => setImmediate(r));
  }

  const cpuOpsPerSec = average(cpuSamples);

  const variance =
    cpuSamples.reduce((acc, sample) => acc + Math.pow(sample - cpuOpsPerSec, 2), 0) / Math.max(1, cpuSamples.length);
  const jitterRatio = cpuOpsPerSec > 0 ? Math.sqrt(variance) / cpuOpsPerSec : 1;

  return {
    challengeSeed,
    cpuOpsPerSec,
    jitterRatio,
    cpuSamples,
  };
}

function cpuSpeedStep(x) {
  x = (Math.imul(x, 48271) + 9973) | 0;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  x &= 0x7fffffff;
  return x;
}

async function runCpuSpeedBenchmark(seed, runs = CPU_SPEED_DEFAULT_RUNS) {
  const initialSeed =
    Number.isFinite(seed) && seed > 0 ? seed | 0 || 1 : (crypto.randomBytes(4).readUInt32BE(0) % 999_999_999) + 1;
  const runCount = Math.max(
    1,
    Math.min(5, Number.isFinite(Number(runs)) ? Math.floor(Number(runs)) : CPU_SPEED_DEFAULT_RUNS),
  );
  const samples = [];
  let proof = '';
  let totalElapsed = 0;

  const BATCH = Math.max(1, Math.min(CPU_SPEED_N, 5_000_000));

  for (let r = 0; r < runCount; r++) {
    let x = initialSeed;
    const start = performance.now();
    let remaining = CPU_SPEED_N;
    while (remaining > 0) {
      const n = Math.min(remaining, BATCH);
      for (let i = 0; i < n; i++) x = cpuSpeedStep(x);
      remaining -= n;
      if (remaining > 0) await new Promise((r) => setImmediate(r));
    }
    const elapsed = Math.max(1, performance.now() - start);
    totalElapsed += elapsed;
    const sampleOps = Math.round(CPU_SPEED_N / (elapsed / 1000));
    samples.push(sampleOps);

    if (!proof) {
      proof = (x >>> 0).toString(16).padStart(8, '0');
    }
    if (r + 1 < runCount) await new Promise((r) => setImmediate(r));
  }

  const maxOps = samples.reduce((a, b) => Math.max(a, b), 0) || 0;

  return {
    initialSeed,
    opsPerSec: maxOps,
    samples,
    proof,
    elapsedMs: Math.round(totalElapsed / runCount),
    runCount,
  };
}

async function verifyCpuSpeedProof(initialSeed, expectedProof) {
  try {
    let x = initialSeed | 0 || 1;
    const BATCH = Math.max(1, Math.min(CPU_SPEED_N, 5_000_000));
    let remaining = CPU_SPEED_N;
    while (remaining > 0) {
      const n = Math.min(remaining, BATCH);
      for (let i = 0; i < n; i++) x = cpuSpeedStep(x);
      remaining -= n;
      if (remaining > 0) await new Promise((r) => setImmediate(r));
    }
    return (x >>> 0).toString(16).padStart(8, '0') === expectedProof;
  } catch (_) {
    return false;
  }
}

function getBenchmarkCapabilities() {
  return {
    ok: true,
    backendReady: true,
    cpu: {
      supported: true,
      status: 'ready',
    },
    gpu: {
      supported: true,
      status: 'native',
      note: 'Native GPU binary (gpu-miner.exe) with D3D9/10/11/12 support.',
    },
  };
}

// ── SHA-256 Mining Benchmark ──────────────────────────────────────────────
// Measures actual SHA-256 throughput matching the worker's burnCpuOps pattern:
//   state = SHA-256(state ‖ LE32(step) ‖ seed) per iteration
// This is NOT raw integer math — it includes Buffer.alloc, Buffer.copy,
// crypto.createHash overhead that matches real mining performance.
const SHA256_BENCH_DURATION_MS = 3000;
const SHA256_BENCH_YIELD_MS = 50;
async function runSha256Benchmark(seed) {
  const seedBuf = seed ? Buffer.from(String(seed).slice(0, 64).padEnd(64, '0'), 'hex') : crypto.randomBytes(32);
  const state = crypto.createHash('sha256').update(seedBuf).digest();
  const samples = [];
  let totalOps = 0;
  let totalElapsed = 0;
  const runs = 3;
  for (let r = 0; r < runs; r++) {
    let s = Buffer.from(state);
    const deadline = performance.now() + SHA256_BENCH_DURATION_MS;
    let ops = 0;
    while (performance.now() < deadline) {
      const batchEnd = performance.now() + SHA256_BENCH_YIELD_MS;
      while (performance.now() < batchEnd) {
        const input = Buffer.alloc(68);
        s.copy(input, 0);
        input.writeUInt32LE(ops >>> 0, 32);
        seedBuf.copy(input, 36);
        s = crypto.createHash('sha256').update(input).digest();
        ops++;
      }
      await new Promise((r) => setImmediate(r));
    }
    const elapsed = Math.max(1, performance.now() - (deadline - SHA256_BENCH_DURATION_MS));
    const sampleOpsPerMs = ops / elapsed;
    samples.push(sampleOpsPerMs);
    totalOps += ops;
    totalElapsed += elapsed;
    if (r + 1 < runs) await new Promise((r) => setImmediate(r));
  }
  const opsPerMs = totalOps / totalElapsed;
  return { opsPerMs, totalOps, elapsedMs: Math.round(totalElapsed), samples };
}

async function runBackendBenchmark(_request = {}) {
  const request = _request || {};
  const startedAt = performance.now();
  try {
    const cpuMem = await runCpuBenchmark(request);
    const cpuSpeedRuns = Number.isFinite(Number(request.cpuSpeedRuns))
      ? Number(request.cpuSpeedRuns)
      : CPU_SPEED_DEFAULT_RUNS;
    const cpuSpeed = await runCpuSpeedBenchmark(cpuMem.challengeSeed, cpuSpeedRuns);
    const sha256Bench = await runSha256Benchmark(cpuMem.challengeSeed);

    const cpuSpeedProofVerified = await verifyCpuSpeedProof(cpuSpeed.initialSeed, cpuSpeed.proof);

    return {
      ok: true,
      source: 'backend',
      elapsedMs: performance.now() - startedAt,
      challengeSeed: cpuMem.challengeSeed,
      cpuOpsPerSec: cpuMem.cpuOpsPerSec,
      jitterRatio: cpuMem.jitterRatio,
      gpuFps: 0,
      gpuBenchAvailable: false,
      gpuProvider: 'none',
      cpuSamples: cpuMem.cpuSamples,
      logicalCoresHint: os.cpus().length,
      cpuSpeedOpsPerSec: cpuSpeed.opsPerSec,
      cpuSpeedSamples: cpuSpeed.samples,
      cpuSpeedInitialSeed: cpuSpeed.initialSeed,
      cpuSpeedProof: cpuSpeed.proof,
      cpuSpeedProofVerified,
      cpuSpeedElapsedMs: cpuSpeed.elapsedMs,
      cpuSpeedRunCount: cpuSpeed.runCount,
      sha256OpsPerMs: sha256Bench.opsPerMs,
      sha256TotalOps: sha256Bench.totalOps,
      sha256ElapsedMs: sha256Bench.elapsedMs,
    };
  } catch (error) {
    return {
      ok: false,
      code: 'BACKEND_BENCHMARK_FAILED',
      message: error && error.message ? error.message : 'unknown backend benchmark error',
    };
  }
}

function _runCpuProbe(seed, iterations) {
  let x = seed | 0 || 1;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) x = cpuSpeedStep(x);
  const elapsed = Math.max(1, performance.now() - start);
  return { proof: (x >>> 0).toString(16).padStart(8, '0'), elapsedMs: Math.round(elapsed) };
}

function _runCpuProbeForDuration(seed, durationMs) {
  let x = seed | 0 || 1;
  const start = performance.now();
  const deadline = start + durationMs;
  let iterations = 0;
  const BATCH = 25_000_000;
  while (performance.now() < deadline) {
    const end = iterations + BATCH;
    for (let i = iterations; i < end; i++) x = cpuSpeedStep(x);
    iterations = end;
  }
  const elapsed = Math.max(1, performance.now() - start);
  return { proof: (x >>> 0).toString(16).padStart(8, '0'), iterations, elapsedMs: Math.round(elapsed) };
}

async function verifyCpuProbe(seed, iterations, expectedProof) {
  try {
    let x = seed | 0 || 1;
    const BATCH = Math.max(1, Math.min(iterations, 5_000_000));
    let remaining = iterations;
    while (remaining > 0) {
      const n = Math.min(remaining, BATCH);
      for (let i = 0; i < n; i++) x = cpuSpeedStep(x);
      remaining -= n;
      if (remaining > 0) await new Promise((r) => setImmediate(r));
    }
    return (x >>> 0).toString(16).padStart(8, '0') === expectedProof;
  } catch (_) {
    return false;
  }
}

function computeGpuProbeExpectedHash(seed, size, shaderIterations) {
  const seedInt = seed | 0 || 1;
  let h = 5381;
  for (let p = 0; p < size * size; p += 4) {
    const row = Math.floor(p / size);
    const col = p % size;
    let x = (Math.imul(col, 1000003) ^ Math.imul(row, 7919) ^ seedInt) | 0;
    x = x | 1;
    for (let i = 0; i < shaderIterations; i++) {
      x = (x ^ (x << 13)) | 0;
      x = x ^ (x >> 17);
      x = (x ^ (x << 5)) | 0;
    }
    h = ((h << 5) + h + ((x >> 24) & 255)) | 0;
    h = ((h << 5) + h + ((x >> 16) & 255)) | 0;
    h = ((h << 5) + h + ((x >> 8) & 255)) | 0;
    h = ((h << 5) + h + (x & 255)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function verifyGpuPowProbe(seed, deviceIndex, nonce, difficulty) {
  const deviceSeed = (seed ^ ((deviceIndex || 0) * 7919)) >>> 0;
  const s = (deviceSeed ^ (nonce * 1000003) ^ ((nonce >>> 16) * 7919)) | 0 | 1;
  const hash = computeGpuProbeExpectedHash(s >>> 0, PROBE_GPU_POW_SIZE, PROBE_GPU_POW_ITERS);
  const hash16 = parseInt(hash.slice(-4), 16);
  const passes = hash16 < difficulty;
  return { hash, hash16, passes, nonce, deviceIndex };
}

module.exports = {
  getBenchmarkCapabilities,
  runBackendBenchmark,
  runCpuBenchmark,
  cpuSpeedStep,
  runSha256Benchmark,
  runCpuSpeedBenchmark,
  verifyCpuSpeedProof,
  _runCpuProbe,
  verifyCpuProbe,
  _runCpuProbeForDuration,
  computeGpuProbeExpectedHash,
  verifyGpuPowProbe,
  average,
  deriveProbeSeed,
  _hasCommand,
  _runCommand,
  _runCommandDetailed,
  CPU_SPEED_N,
  CPU_SPEED_DEFAULT_RUNS,
  GPU_PROOF_SIZE,
  GPU_PROOF_ITERS,
  PROBE_CPU_ITERS,
  PROBE_CPU_DURATION_MS,
  PROBE_GPU_POW_DIFFICULTY,
  PROBE_GPU_POW_SIZE,
  PROBE_GPU_POW_ITERS,
  PROBE_PEER_SLACK,
  PROBE_LOCAL_SLACK,
};
