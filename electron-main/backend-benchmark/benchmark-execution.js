'use strict';
const { spawnSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const CPU_SPEED_N = 20_000_000;
const CPU_SPEED_DEFAULT_RUNS = 5;

const PROBE_CPU_ITERS = 200_000_000;
const PROBE_MEM_ENTRIES = 1 << 24;
const PROBE_MEM_ITERS = 10_000_000;
const PROBE_GPU_SIZE = 640;
const PROBE_GPU_ITERS = 160;
const PROBE_GPU_POW_DIFFICULTY = 1024;
const PROBE_GPU_POW_SIZE = 32;
const PROBE_GPU_POW_ITERS = 50000;

const PROBE_PEER_SLACK = 3.0;
const PROBE_LOCAL_SLACK = 3.0;

const GPU_PROOF_SIZE = 128;
const GPU_PROOF_ITERS = 32;

const MEM_ENTRIES = 1 << 24;
const MEM_MASK = MEM_ENTRIES - 1;
const MEM_ITERS = 2_000_000;
const _memProofCache = new Map();

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

async function runCpuAndMemoryBenchmark(request = {}) {
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
  const memBytes = Number.isFinite(Number(request.memBytes))
    ? Math.max(1024, Number(request.memBytes))
    : 32 * 1024 * 1024;
  const memArr = new Uint8Array(memBytes);
  const MEM_PASSES = 4;
  const memSamples = [];
  const MEM_YIELD_INTERVAL = Math.max(1, Math.min(memArr.length / 64, 500_000));
  for (let pass = 0; pass < MEM_PASSES; pass++) {
    const passStart = performance.now();
    let i = 0;
    while (i < memArr.length) {
      const end = Math.min(i + MEM_YIELD_INTERVAL * 64, memArr.length);
      for (; i < end; i += 64) {
        memArr[i] = (memArr[i] + (i & 0xff) + x) & 0xff;
      }
      if (i < memArr.length) await new Promise((r) => setImmediate(r));
    }
    const passElapsedMs = Math.max(1, performance.now() - passStart);
    memSamples.push(memBytes / (1024 * 1024) / (passElapsedMs / 1000));
    if (pass + 1 < MEM_PASSES) await new Promise((r) => setImmediate(r));
  }
  const memoryMBps = average(memSamples);

  const variance =
    cpuSamples.reduce((acc, sample) => acc + Math.pow(sample - cpuOpsPerSec, 2), 0) / Math.max(1, cpuSamples.length);
  const jitterRatio = cpuOpsPerSec > 0 ? Math.sqrt(variance) / cpuOpsPerSec : 1;

  return {
    challengeSeed,
    cpuOpsPerSec,
    memoryMBps,
    jitterRatio,
    cpuSamples,
  };
}

async function runRandomMemoryBenchmark(walletAddress, seed = 0) {
  const ENTRIES = 1 << 24;
  const MASK = ENTRIES - 1;

  const addrStr = typeof walletAddress === 'string' && walletAddress.trim() ? walletAddress.trim() : '';
  let addrSalt = 0;
  for (let i = 0; i < addrStr.length; i++) {
    addrSalt = (Math.imul(addrSalt, 31) + addrStr.charCodeAt(i)) | 0;
  }
  addrSalt = (addrSalt ^ (Number(seed) >>> 0)) >>> 0;
  const arr = new Uint32Array(ENTRIES);
  const FILL_BATCH = Math.max(1, Math.min(ENTRIES, 1_000_000));
  let fillIdx = 0;
  while (fillIdx < ENTRIES) {
    const end = Math.min(fillIdx + FILL_BATCH, ENTRIES);
    for (; fillIdx < end; fillIdx++) {
      arr[fillIdx] = ((fillIdx * 1664525 + 1013904223) ^ addrSalt) & MASK;
    }
    if (fillIdx < ENTRIES) await new Promise((r) => setImmediate(r));
  }

  const ITERS = 2_000_000;
  let idx = arr[0];
  const start = performance.now();
  const WALK_BATCH = Math.max(1, Math.min(ITERS, 500_000));
  let remaining = ITERS;
  while (remaining > 0) {
    const n = Math.min(remaining, WALK_BATCH);
    for (let i = 0; i < n; i++) idx = arr[idx & MASK];
    remaining -= n;
    if (remaining > 0) await new Promise((r) => setImmediate(r));
  }
  const elapsed = Math.max(1, performance.now() - start);
  const latencyNs = (elapsed * 1e6) / ITERS;
  const randomBandwidthMBps = Math.round((ITERS * 4) / (elapsed / 1000) / (1024 * 1024));
  return {
    randomBandwidthMBps,
    latencyNs: Math.round(latencyNs * 10) / 10,
    proof: (idx >>> 0).toString(16).padStart(8, '0'),
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

async function verifyMemProof(expectedProof, walletAddress, seed = 0) {
  try {
    const addrStr = typeof walletAddress === 'string' && walletAddress.trim() ? walletAddress.trim() : '';
    let addrSalt = 0;
    for (let i = 0; i < addrStr.length; i++) {
      addrSalt = (Math.imul(addrSalt, 31) + addrStr.charCodeAt(i)) | 0;
    }
    addrSalt = (addrSalt ^ (Number(seed) >>> 0)) >>> 0;
    const cacheKey = String(addrSalt);
    let cached = _memProofCache.get(cacheKey);
    if (cached === undefined) {
      const arr = new Uint32Array(MEM_ENTRIES);
      const FILL_BATCH = Math.max(1, Math.min(MEM_ENTRIES, 1_000_000));
      let fillIdx = 0;
      while (fillIdx < MEM_ENTRIES) {
        const end = Math.min(fillIdx + FILL_BATCH, MEM_ENTRIES);
        for (; fillIdx < end; fillIdx++) {
          arr[fillIdx] = ((fillIdx * 1664525 + 1013904223) ^ addrSalt) & MEM_MASK;
        }
        if (fillIdx < MEM_ENTRIES) await new Promise((r) => setImmediate(r));
      }
      let idx = arr[0];
      const WALK_BATCH = Math.max(1, Math.min(MEM_ITERS, 500_000));
      let remaining = MEM_ITERS;
      while (remaining > 0) {
        const n = Math.min(remaining, WALK_BATCH);
        for (let i = 0; i < n; i++) idx = arr[idx & MEM_MASK];
        remaining -= n;
        if (remaining > 0) await new Promise((r) => setImmediate(r));
      }
      cached = (idx >>> 0).toString(16).padStart(8, '0');
      _memProofCache.set(cacheKey, cached);
    }
    return cached === expectedProof;
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

async function runBackendBenchmark(_request = {}) {
  const request = _request || {};
  const walletAddress = typeof request.walletAddress === 'string' ? request.walletAddress.trim() : '';
  const startedAt = performance.now();
  try {
    const cpuMem = await runCpuAndMemoryBenchmark(request);
    const cpuSpeedRuns = Number.isFinite(Number(request.cpuSpeedRuns))
      ? Number(request.cpuSpeedRuns)
      : CPU_SPEED_DEFAULT_RUNS;
    const cpuSpeed = await runCpuSpeedBenchmark(cpuMem.challengeSeed, cpuSpeedRuns);
    const randMem = await runRandomMemoryBenchmark(walletAddress, cpuMem.challengeSeed);

    const [cpuSpeedProofVerified, memProofVerified] = await Promise.all([
      verifyCpuSpeedProof(cpuSpeed.initialSeed, cpuSpeed.proof),
      verifyMemProof(randMem.proof, walletAddress, cpuMem.challengeSeed),
    ]);

    return {
      ok: true,
      source: 'backend',
      elapsedMs: performance.now() - startedAt,
      challengeSeed: cpuMem.challengeSeed,
      cpuOpsPerSec: cpuMem.cpuOpsPerSec,
      memoryMBps: cpuMem.memoryMBps,
      jitterRatio: cpuMem.jitterRatio,
      gpuFps: 0,
      gpuBenchAvailable: false,
      gpuProvider: 'none',
      gpuProofHash: '',
      gpuProofWorkload: 'none',
      gpuProofError: '',
      cpuSamples: cpuMem.cpuSamples,
      logicalCoresHint: os.cpus().length,
      cpuSpeedOpsPerSec: cpuSpeed.opsPerSec,
      cpuSpeedSamples: cpuSpeed.samples,
      cpuSpeedInitialSeed: cpuSpeed.initialSeed,
      cpuSpeedProof: cpuSpeed.proof,
      cpuSpeedProofVerified,
      cpuSpeedElapsedMs: cpuSpeed.elapsedMs,
      cpuSpeedRunCount: cpuSpeed.runCount,
      randomMemBandwidthMBps: randMem.randomBandwidthMBps,
      memLatencyNs: randMem.latencyNs,
      memProof: randMem.proof,
      memProofSeed: cpuMem.challengeSeed,
      memProofVerified,
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

function _runMemProbe(arraySeed, iterations) {
  const ENTRIES = PROBE_MEM_ENTRIES;
  const s = arraySeed | 0 || 1;
  const arr = new Uint32Array(ENTRIES);
  for (let i = 0; i < ENTRIES; i++) {
    arr[i] = ((i * 1664525 + s) ^ (s >>> 13)) & (ENTRIES - 1);
  }
  let idx = arr[0];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) idx = arr[idx & (ENTRIES - 1)];
  const elapsed = Math.max(1, performance.now() - start);
  return { proof: (idx >>> 0).toString(16).padStart(8, '0'), elapsedMs: Math.round(elapsed) };
}

async function verifyMemProbe(arraySeed, iterations, expectedProof) {
  try {
    const ENTRIES = PROBE_MEM_ENTRIES;
    const s = arraySeed | 0 || 1;
    const arr = new Uint32Array(ENTRIES);
    const FILL_BATCH = Math.max(1, Math.min(ENTRIES, 1_000_000));
    let i = 0;
    while (i < ENTRIES) {
      const end = Math.min(i + FILL_BATCH, ENTRIES);
      for (; i < end; i++) {
        arr[i] = ((i * 1664525 + s) ^ (s >>> 13)) & (ENTRIES - 1);
      }
      if (i < ENTRIES) await new Promise((r) => setImmediate(r));
    }
    let idx = arr[0];
    const WALK_BATCH = Math.max(1, Math.min(iterations, 1_000_000));
    let remaining = iterations;
    while (remaining > 0) {
      const n = Math.min(remaining, WALK_BATCH);
      for (let j = 0; j < n; j++) idx = arr[idx & (ENTRIES - 1)];
      remaining -= n;
      if (remaining > 0) await new Promise((r) => setImmediate(r));
    }
    return (idx >>> 0).toString(16).padStart(8, '0') === expectedProof;
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
  runCpuAndMemoryBenchmark,
  runRandomMemoryBenchmark,
  cpuSpeedStep,
  runCpuSpeedBenchmark,
  verifyCpuSpeedProof,
  verifyMemProof,
  _runCpuProbe,
  verifyCpuProbe,
  _runMemProbe,
  verifyMemProbe,
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
  PROBE_MEM_ENTRIES,
  PROBE_MEM_ITERS,
  PROBE_GPU_SIZE,
  PROBE_GPU_ITERS,
  PROBE_GPU_POW_DIFFICULTY,
  PROBE_GPU_POW_SIZE,
  PROBE_GPU_POW_ITERS,
  PROBE_PEER_SLACK,
  PROBE_LOCAL_SLACK,
};
