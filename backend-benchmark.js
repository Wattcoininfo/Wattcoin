const { spawnSync } = require('child_process');
const os = require('os');
const crypto = require('crypto');
const { performance } = require('perf_hooks');
const { PROBE_RECEIPT_VERSION, normalizeProbeReceipt } = require('./probe-attestation');

function hasCommand(command, args = ['--help']) {
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

function runCommand(command, args = [], timeout = 2000) {
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

function runCommandDetailed(command, args = [], timeout = 2000) {
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

function simpleHash(value) {
  const str = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Derive the next probe seed deterministically from the previous verified proof hash.
// Only a worker who ran the last probe knows the correct chainHead; the pre-image is
// bound to the prior sequential computation so seeds cannot be pre-computed without
// executing every preceding step in order.
function deriveProbeSeed(chainHead, chainIndex) {
  const raw = simpleHash(`${chainHead}|${chainIndex}`);
  return parseInt(raw, 16) >>> 0;
}

function runCpuAndMemoryBenchmark(request = {}) {
  const challengeSeed = Number.isFinite(Number(request.challengeSeed))
    ? Math.floor(Number(request.challengeSeed))
    : (crypto.randomBytes(4).readUInt32BE(0) % 1_000_000_000);
  let x = challengeSeed || 1;
  const cpuSamples = [];
  const phaseCount = Number.isFinite(Number(request.phaseCount)) ? Math.max(1, Number(request.phaseCount)) : 4;
  const phaseDurationMs = Number.isFinite(Number(request.phaseDurationMs)) ? Math.max(30, Number(request.phaseDurationMs)) : 100;

  for (let phase = 0; phase < phaseCount; phase += 1) {
    const phaseStart = performance.now();
    let ops = 0;
    while (performance.now() - phaseStart < phaseDurationMs) {
      x = (x * 48271 + (phase + 1) * 9973) % 2147483647;
      x ^= (x << 13);
      x ^= (x >>> 17);
      x ^= (x << 5);
      ops += 1;
    }
    const elapsed = Math.max(1, performance.now() - phaseStart);
    cpuSamples.push((ops * 1000) / elapsed);
  }

  const cpuOpsPerSec = average(cpuSamples);
  // Sequential memory bandwidth: use a 32 MB buffer with stride-64 writes.
  // Run 4 passes and average to reduce OS-scheduler jitter (a single ~1-3ms pass
  // produces 3x swings on the same machine; averaging gives stable results).
  const memBytes = Number.isFinite(Number(request.memBytes)) ? Math.max(1024, Number(request.memBytes)) : (32 * 1024 * 1024);
  const memArr = new Uint8Array(memBytes);
  const MEM_PASSES = 4;
  const memSamples = [];
  for (let pass = 0; pass < MEM_PASSES; pass++) {
    const passStart = performance.now();
    for (let i = 0; i < memArr.length; i += 64) {
      memArr[i] = (memArr[i] + (i & 0xff) + x) & 0xff;
    }
    const passElapsedMs = Math.max(1, performance.now() - passStart);
    memSamples.push((memBytes / (1024 * 1024)) / (passElapsedMs / 1000));
  }
  const memElapsedMs = 1; // kept for API compatibility; individual pass times used above
  const memoryMBps = average(memSamples);

  const variance = cpuSamples.reduce((acc, sample) => acc + Math.pow(sample - cpuOpsPerSec, 2), 0) / Math.max(1, cpuSamples.length);
  const jitterRatio = cpuOpsPerSec > 0 ? Math.sqrt(variance) / cpuOpsPerSec : 1;

  return {
    challengeSeed,
    cpuOpsPerSec,
    memoryMBps,
    jitterRatio,
    cpuSamples,
  };
}

// Random-access memory benchmark: dependent random reads on a 16 MB buffer.
// Stays in DRAM on most systems (exceeds L2/L3 on entry-level CPUs), so the
// result is dominated by memory-bus latency, not L3 hit rate.
// Reported as "effective bandwidth" of 4-byte random reads; also estimates latency.
function runRandomMemoryBenchmark(walletAddress) {
  // Use the same 64 MB working set as the peer-probe so the calibrated latency
  // reflects true DRAM access time rather than L3-cached latency (the previous
  // 16 MB array could fit entirely in L3 on modern CPUs, giving an optimistically
  // low latency estimate that made every peer-probe appear "too slow").
  const ENTRIES = 1 << 24; // 16M x4 bytes = 64 MB – must match MEM_ENTRIES/PROBE_MEM_ENTRIES
  const MASK    = ENTRIES - 1; // 0xFFFFFF -- was 0x3FFFFF for 16 MB

  // Derive a 32-bit salt from the wallet address so the proof is unique per miner.
  // A cheater cannot hardcode the answer without knowing which address will be used.
  const addrStr  = typeof walletAddress === 'string' && walletAddress.trim() ? walletAddress.trim() : '';
  let addrSalt = 0;
  for (let i = 0; i < addrStr.length; i++) {
    addrSalt = (Math.imul(addrSalt, 31) + addrStr.charCodeAt(i)) | 0;
  }
  addrSalt = addrSalt >>> 0;
  const arr = new Uint32Array(ENTRIES);
  // Fill with values that point somewhere else in the array (permutation-like),
  // XOR with addrSalt so the traversal path is unique per wallet.
  for (let i = 0; i < ENTRIES; i++) {
    arr[i] = (((i * 1664525 + 1013904223) ^ addrSalt) & MASK); // stay within ENTRIES
  }
  // 2 M iterations ≈ 160 ms on DDR4 @ 80 ns/access – large enough to swamp
  // OS scheduler jitter, which caused the estimate to vary by ±25 % with the
  // previous 500 K count (~25 ms window on cached 16 MB data).
  const ITERS = 2_000_000;
  let idx = arr[0];
  const start = performance.now();
  for (let i = 0; i < ITERS; i++) {
    idx = arr[idx & MASK];
  }
  const elapsed = Math.max(1, performance.now() - start);
  const latencyNs = (elapsed * 1e6) / ITERS; // ns per access
  const randomBandwidthMBps = Math.round((ITERS * 4) / (elapsed / 1000) / (1024 * 1024));
  return {
    randomBandwidthMBps,
    latencyNs: Math.round(latencyNs * 10) / 10,
    proof: (idx >>> 0).toString(16).padStart(8, '0'),
  };
}

// Fixed-N CPU speed benchmark: no performance.now() in the inner loop, so the
// result reflects genuine CPU integer throughput (imul + XOR-shift dependency chain)
// rather than OS timer call overhead.  Expected range: ~100M�700M ops/s depending
// on CPU generation and clock speed.
//
// Pass a known seed (e.g. challengeSeed from the server) so the proof is server-
// verifiable: given initialSeed + N, any independent runner can recompute the
// expected proof hash and confirm this computation actually happened.
const CPU_SPEED_N = 20_000_000;
const CPU_SPEED_DEFAULT_RUNS = 3;
function cpuSpeedStep(x) {
  x = (Math.imul(x, 48271) + 9973) | 0;
  x ^= x << 13;
  x ^= x >> 17;
  x ^= x << 5;
  x &= 0x7FFFFFFF;
  return x;
}
function runCpuSpeedBenchmark(seed, runs = CPU_SPEED_DEFAULT_RUNS) {
  // Use provided seed if valid; otherwise pick a random one.
  const initialSeed = (Number.isFinite(seed) && seed > 0)
    ? (seed | 0) || 1
    : ((crypto.randomBytes(4).readUInt32BE(0) % 999_999_999) + 1);
  const runCount = Math.max(1, Math.min(5, Number.isFinite(Number(runs)) ? Math.floor(Number(runs)) : CPU_SPEED_DEFAULT_RUNS));
  const samples = [];
  let proof = '';
  let totalElapsed = 0;

  for (let r = 0; r < runCount; r++) {
    let x = initialSeed;
    const start = performance.now();
    for (let i = 0; i < CPU_SPEED_N; i++) x = cpuSpeedStep(x);
    const elapsed = Math.max(1, performance.now() - start);
    totalElapsed += elapsed;
    samples.push(Math.round(CPU_SPEED_N / (elapsed / 1000)));
    if (!proof) {
      proof = (x >>> 0).toString(16).padStart(8, '0');
    }
  }

  const sortedSamples = [...samples].sort((a, b) => a - b);
  const medianOps = sortedSamples[Math.floor(sortedSamples.length / 2)] || 0;

  return {
    initialSeed,
    opsPerSec: medianOps,
    samples,
    proof,
    elapsedMs: Math.round(totalElapsed / runCount),
    runCount,
  };
}

// Verification: given the initialSeed that was used, re-run the identical N-step
// chain and confirm the proof matches.  Takes ~same wall-clock time as the benchmark
// itself but guarantees tamper-evidence in the Node process.
function verifyCpuSpeedProof(initialSeed, expectedProof) {
  try {
    let x = (initialSeed | 0) || 1;
    for (let i = 0; i < CPU_SPEED_N; i++) x = cpuSpeedStep(x);
    return (x >>> 0).toString(16).padStart(8, '0') === expectedProof;
  } catch (_) { return false; }
}

// Memory proof verification: the traversal is 100% deterministic given the same
// wallet address seed.  Any honest run with the same wallet produces the same proof.
// Cache is keyed by wallet address to avoid re-computation on repeated calls.
const MEM_ENTRIES = 1 << 24; // must match runRandomMemoryBenchmark (64 MB)
const MEM_MASK    = MEM_ENTRIES - 1; // 0xFFFFFF
const MEM_ITERS = 2_000_000;
const _memProofCache = new Map(); // addrSalt (string) → proof hex
function verifyMemProof(expectedProof, walletAddress) {
  try {
    const addrStr  = typeof walletAddress === 'string' && walletAddress.trim() ? walletAddress.trim() : '';
    let addrSalt = 0;
    for (let i = 0; i < addrStr.length; i++) {
      addrSalt = (Math.imul(addrSalt, 31) + addrStr.charCodeAt(i)) | 0;
    }
    addrSalt = addrSalt >>> 0;
    const cacheKey = String(addrSalt);
    let cached = _memProofCache.get(cacheKey);
    if (cached === undefined) {
      const arr = new Uint32Array(MEM_ENTRIES);
      for (let i = 0; i < MEM_ENTRIES; i++) {
        arr[i] = (((i * 1664525 + 1013904223) ^ addrSalt) & MEM_MASK);
      }
      let idx = arr[0];
      for (let i = 0; i < MEM_ITERS; i++) idx = arr[idx & MEM_MASK];
      cached = (idx >>> 0).toString(16).padStart(8, '0');
      _memProofCache.set(cacheKey, cached);
    }
    return cached === expectedProof;
  } catch (_) { return false; }
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
      supported: false,
      status: 'renderer-only',
      note: 'GPU probe runs in the Electron renderer (WebGL) — not available in Node.js backend.',
    },
  };
}

async function runBackendBenchmark(_request = {}) {
  const request = _request || {};
  const walletAddress = typeof request.walletAddress === 'string' ? request.walletAddress.trim() : '';
  const startedAt = performance.now();
  try {
    const cpuMem = runCpuAndMemoryBenchmark(request);
    // Use challengeSeed as the CPU speed seed so a server can independently verify:
    // given (challengeSeed, N=20M, algorithm) ? expected proof.
    const cpuSpeedRuns = Number.isFinite(Number(request.cpuSpeedRuns)) ? Number(request.cpuSpeedRuns) : CPU_SPEED_DEFAULT_RUNS;
    const cpuSpeed = runCpuSpeedBenchmark(cpuMem.challengeSeed, cpuSpeedRuns);
    const randMem = runRandomMemoryBenchmark(walletAddress);

    // Verify both proofs inside Node � catches any code-level corruption or patching.
    // verifyCpuSpeedProof re-runs 20M iterations from the same seed; verifyMemProof
    // re-runs the deterministic traversal keyed by wallet address.
    const cpuSpeedProofVerified = verifyCpuSpeedProof(cpuSpeed.initialSeed, cpuSpeed.proof);
    const memProofVerified = verifyMemProof(randMem.proof, walletAddress);

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
      gpuProofError: '',  // renderer-only; GPU probes use the probe system, not backend benchmarks
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

// --- Runtime probe system ------------------------------------------------------
// During active mining the node periodically issues a small challenge workload to
// the renderer.  The renderer runs it and returns a proof hash + elapsed time.
// Node re-runs the same deterministic computation to verify the hash (CPU + memory).
// GPU probes are timing-only � Node cannot execute GPU code, but it checks that the
// wall-clock time is consistent with what the declared GPU should take.
//
// Probe schedule: one probe every PROBE_INTERVAL_MS of active mining.
// Three types cycle randomly: 'cpu', 'memory', 'gpu' (only if allowGpuWorkloads).
// If the renderer does not respond within PROBE_TIMEOUT_MS, it is recorded as a failure.
//
// SIZING RATIONALE:
//   For peer-verified probes the coordinator measures wall-clock time independently.
//   To make network latency (~50-150 ms RTT) and scheduler jitter a minor fraction,
//   computation should stay comfortably in the multi-hundred-ms to low-second range
//   even on weaker hardware. Values below intentionally bias toward longer runtimes:
//     CPU:    200M iters @ 100M ops/s (entry CPU)   = ~2000 ms
//     Memory: 10M iters @ 50 ns/access (DDR4-3200) = ~500 ms
//   GPU probes are timing-only (Node can't re-run GL) and use a 640x640 render with
//   160 MAD iterations per pixel so timing is less bursty than the previous size.
// ----------------------------------------------------------------------------------

// Probe cadence: uniformly random in [PROBE_INTERVAL_MIN_MS, PROBE_INTERVAL_MAX_MS].
// The next interval is re-rolled after every issued probe so a cheater cannot
// predict or schedule around the timing of upcoming challenges.
const PROBE_INTERVAL_MIN_MS = 2 * 60 * 1000;  // earliest a new probe can fire (2 min)
const PROBE_INTERVAL_MAX_MS = 8 * 60 * 1000;  // latest a new probe can fire (8 min)
const PROBE_INTERVAL_MS     = 5 * 60 * 1000;  // retained for coverage-ratio math (used as mean)
const PROBE_TIMEOUT_MS      = 90 * 1000;       // 90 s - generous for slow hardware, tight vs 5-min window
const PROBE_CPU_ITERS       = 200_000_000;     // ~1000-4000 ms - pushes timing above scheduler/network noise
const PROBE_MEM_ENTRIES     = 1 << 24;         // 64 MB - large enough to stay in DRAM on mainstream systems
const PROBE_MEM_ITERS       = 10_000_000;      // ~500-4000 ms depending on latency
const PROBE_GPU_SIZE        = 640;             // larger render target reduces bursty sub-frame timings
const PROBE_GPU_ITERS       = 160;             // more shader work improves timing stability
// Timing tolerance: allow up to PROBE_TIMING_SLACK x expected time before flagging.
// Peer-measured timing is tight; local self-timing is held to the same standard now
// that the chained-proof replay guard catches any attempt to pre-compute answers.
const PROBE_PEER_SLACK      = 3.0;             // peer: flag if < 1/3x or > 3x expected
const PROBE_LOCAL_SLACK     = 3.0;             // local (self-polled): 3x — same as peer; hash check catches hardcoded answers

function _nextProbeIntervalMs() {
  return Math.round(PROBE_INTERVAL_MIN_MS + Math.random() * (PROBE_INTERVAL_MAX_MS - PROBE_INTERVAL_MIN_MS));
}

let probeState = {
  pending:              null,   // { id, type, params, issuedAt }
  lastIssuedAt:         0,
  nextIntervalMs:       _nextProbeIntervalMs(), // randomised per-probe; re-rolled on each issue
  history:              [],     // last 20 results
  consecutiveFailures:  0,
  hardwareSpec:         null,   // { measuredCpuOpsPerSec, measuredMemLatencyNs, allowGpuWorkloads }
  // Chained-probe continuity � each probe's seed derives from the previous proof so a
  // worker cannot answer future probes without having run every prior one in sequence.
  chainHead:            null,   // last verified proof hash (null = genesis or after a break)
  chainIndex:           0,      // count of probes in the current unbroken chain
  chainBroken:          false,  // set when a probe times out or fails
};

// Reuses the same step function as the full benchmark � same algorithm = verifiable.
function runCpuProbe(seed, iterations) {
  let x = (seed | 0) || 1;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) x = cpuSpeedStep(x);
  const elapsed = Math.max(1, performance.now() - start);
  return { proof: (x >>> 0).toString(16).padStart(8, '0'), elapsedMs: Math.round(elapsed) };
}

function verifyCpuProbe(seed, iterations, expectedProof) {
  try {
    let x = (seed | 0) || 1;
    for (let i = 0; i < iterations; i++) x = cpuSpeedStep(x);
    return (x >>> 0).toString(16).padStart(8, '0') === expectedProof;
  } catch (_) { return false; }
}

// Memory probe: seeded array fill so each probe has a unique, unguessable answer.
function runMemProbe(arraySeed, iterations) {
  const ENTRIES = PROBE_MEM_ENTRIES;
  const s = (arraySeed | 0) || 1;
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

function verifyMemProbe(arraySeed, iterations, expectedProof) {
  try {
    const ENTRIES = PROBE_MEM_ENTRIES;
    const s = (arraySeed | 0) || 1;
    const arr = new Uint32Array(ENTRIES);
    for (let i = 0; i < ENTRIES; i++) {
      arr[i] = ((i * 1664525 + s) ^ (s >>> 13)) & (ENTRIES - 1);
    }
    let idx = arr[0];
    for (let i = 0; i < iterations; i++) idx = arr[idx & (ENTRIES - 1)];
    return (idx >>> 0).toString(16).padStart(8, '0') === expectedProof;
  } catch (_) { return false; }
}

// Called from electron-main after a benchmark run so probes use measured values.
function setProbeHardwareSpec(spec) {
  probeState.hardwareSpec = spec && typeof spec === 'object' ? { ...spec } : null;
}

// Called from mining loop in renderer (via IPC) � returns the next probe to run,
// or null if it is too soon / no probe is currently pending.
function getPendingProbe() {
  const now = Date.now();

  // Expire timed-out probes.
  if (probeState.pending && now - probeState.pending.issuedAt > PROBE_TIMEOUT_MS) {
    probeState.consecutiveFailures += 1;
    probeState.history.unshift({ id: probeState.pending.id, type: probeState.pending.type, ok: false, issues: ['probe timed out'], wallClockMs: now - probeState.pending.issuedAt, ts: now });
    if (probeState.history.length > 20) probeState.history.length = 20;
    console.warn(`[Probe] ${probeState.pending.type} probe timed out (id=${probeState.pending.id})`);
    probeState.chainBroken = true;
    probeState.chainHead   = null; // break the chain; next probe starts a new segment
    probeState.pending = null;
  }

  // Return existing pending probe if still in-flight.
  if (probeState.pending) return { ...probeState.pending };

  // Not yet time for a new probe.
  if (now - probeState.lastIssuedAt < probeState.nextIntervalMs) return null;

  // Choose type at random; include 'gpu' only when hardware spec allows it.
  const allowGpu = !!(probeState.hardwareSpec && probeState.hardwareSpec.allowGpuWorkloads);
  const types = ['cpu', 'memory', ...(allowGpu ? ['gpu'] : [])];
  const type  = types[Math.floor(Math.random() * types.length)];
  // Chain derivation: next seed is deterministically derived from the previous proof so
  // the worker cannot pre-compute answers without executing every prior probe in sequence.
  const seed = probeState.chainHead !== null
    ? (deriveProbeSeed(probeState.chainHead, probeState.chainIndex) || 1)
    : (crypto.randomBytes(4).readUInt32BE(0) || 1);

  const probe = {
    id: `${now.toString(36)}-${seed.toString(16)}`,
    type,
    issuedAt: now,
    params: type === 'cpu'    ? { seed, iterations: PROBE_CPU_ITERS }
           : type === 'memory' ? { arraySeed: seed, iterations: PROBE_MEM_ITERS, entries: PROBE_MEM_ENTRIES }
           : /* gpu */           { seed, size: PROBE_GPU_SIZE, shaderIterations: PROBE_GPU_ITERS },
  };

  // Pre-compute the expected GPU pixel hash in pure JS so submitProbeResult can
  // verify it cryptographically � identical approach to peer probe issuance.
  if (type === 'gpu') {
    probe._expectedPixelHash = computeGpuProbeExpectedHash(probe.params.seed, probe.params.size, probe.params.shaderIterations);
  }

  probeState.pending        = probe;
  probeState.lastIssuedAt   = now;
  probeState.nextIntervalMs = _nextProbeIntervalMs(); // randomise next window immediately
  console.log(`[Probe] Issued ${type} probe id=${probe.id} (next in ~${Math.round(probeState.nextIntervalMs / 1000)}s)${probe._expectedPixelHash ? ' (GPU hash pre-computed)' : ''}`);
  // Strip internal fields before handing the probe to the renderer � the renderer
  // must not see _expectedPixelHash or it could trivially forge the GPU proof answer.
  const { _expectedPixelHash: _hidden, ...publicProbe } = probe; // eslint-disable-line no-unused-vars
  return publicProbe;
}

// Called when the renderer returns a completed probe.
// peerTimed=true means wallClockMs was measured by the coordinator (trusted external clock).
function submitProbeResult(result, peerTimed = false) {
  if (!result || !probeState.pending) {
    return { ok: false, issues: ['no pending probe'] };
  }
  if (result.id !== probeState.pending.id) {
    return { ok: false, issues: ['probe id mismatch'] };
  }

  const probe       = probeState.pending;
  const wallClockMs = Date.now() - probe.issuedAt;
  probeState.pending = null;

  const issues = [];
  let   proofValid = false;

  if (probe.type === 'cpu') {
    // Re-run exact same computation � proof MUST match for an honest node.
    proofValid = verifyCpuProbe(probe.params.seed, probe.params.iterations, result.proof || '');
    if (!proofValid) {
      issues.push('cpu probe: proof hash mismatch � computation was tampered or skipped');
    } else if (probeState.hardwareSpec && probeState.hardwareSpec.measuredCpuOpsPerSec > 0) {
      const expectedMs = (probe.params.iterations / probeState.hardwareSpec.measuredCpuOpsPerSec) * 1000;
      const slack = peerTimed ? PROBE_PEER_SLACK : PROBE_LOCAL_SLACK;
      const ratio = wallClockMs / Math.max(1, expectedMs);
      if (ratio < 1 / slack) issues.push(`cpu probe suspiciously fast: ${Math.round(wallClockMs)}ms (expected ~${Math.round(expectedMs)}ms)`);
      if (ratio > slack)     issues.push(`cpu probe unexpectedly slow: ${Math.round(wallClockMs)}ms (expected ~${Math.round(expectedMs)}ms)`);
    }
  } else if (probe.type === 'memory') {
    proofValid = verifyMemProbe(probe.params.arraySeed, probe.params.iterations, result.proof || '');
    if (!proofValid) {
      issues.push('memory probe: proof hash mismatch � computation was tampered or skipped');
    } else if (probeState.hardwareSpec && probeState.hardwareSpec.measuredMemLatencyNs > 0) {
      const expectedMs = (probe.params.iterations * probeState.hardwareSpec.measuredMemLatencyNs) / 1e6;
      const slack = peerTimed ? PROBE_PEER_SLACK : PROBE_LOCAL_SLACK;
      const ratio = wallClockMs / Math.max(1, expectedMs);
      if (ratio < 1 / slack) issues.push(`memory probe suspiciously fast: ${Math.round(wallClockMs)}ms (expected ~${Math.round(expectedMs)}ms)`);
      if (ratio > slack)     issues.push(`memory probe unexpectedly slow: ${Math.round(wallClockMs)}ms (expected ~${Math.round(expectedMs)}ms)`);
    }
  } else if (probe.type === 'gpu') {
    if (typeof result.pixelHash !== 'string' || result.pixelHash.length === 0) {
      proofValid = false;
      issues.push('gpu probe: no pixel hash returned � WebGL unavailable or render was skipped');
    } else if (probe._expectedPixelHash) {
      // Algebraic verification: compare against the hash pre-computed at issuance using
      // the pure-JS integer XOR-shift algorithm � identical to the GLSL shader output.
      proofValid = result.pixelHash === probe._expectedPixelHash;
      if (!proofValid) {
        issues.push(`gpu probe: pixel hash mismatch (got ${result.pixelHash}, expected ${probe._expectedPixelHash})`);
      } else if (wallClockMs < 2) {
        issues.push(`gpu probe completed impossibly fast (${wallClockMs}ms) � GPU render was likely skipped`);
      }
    } else {
      // No expected hash available (legacy path) � fall back to timing + presence check.
      proofValid = true;
      if (wallClockMs < 2) issues.push(`gpu probe completed impossibly fast (${wallClockMs}ms) � GPU render was likely skipped`);
    }
  }

  const ok = issues.length === 0;
  if (!ok) probeState.consecutiveFailures += 1;
  else     probeState.consecutiveFailures = 0;

  // Advance or break the chain based on outcome.
  if (ok && proofValid) {
    // Successful: store the proof as the new chain head so the next seed derives from it.
    const proofKey = probe.type === 'gpu' ? (result.pixelHash || '') : (result.proof || '');
    probeState.chainHead  = proofKey;
    probeState.chainIndex += 1;
  } else {
    // Failed: break continuity so the gap is visible in proofData at block commit time.
    probeState.chainBroken = true;
    probeState.chainHead   = null;
  }

  probeState.history.unshift({
    id: probe.id, type: probe.type, ok, issues, wallClockMs, ts: Date.now(),
    chainIndex: probeState.chainIndex, chainHead: probeState.chainHead,
  });
  if (probeState.history.length > 20) probeState.history.length = 20;

  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[Probe] ${probe.type} ${tag} wall=${wallClockMs}ms chain=${probeState.chainIndex}${probeState.chainBroken ? '(broken)' : ''}${issues.length ? ' - ' + issues.join('; ') : ''}`);
  return {
    ok, proofValid, issues, wallClockMs, consecutiveFailures: probeState.consecutiveFailures,
    chainHead: probeState.chainHead, chainIndex: probeState.chainIndex, chainBroken: probeState.chainBroken,
  };
}

function getProbeHistory() {
  return {
    history:              [...probeState.history],
    consecutiveFailures:  probeState.consecutiveFailures,
    hasPending:           !!probeState.pending,
    chainHead:            probeState.chainHead,
    chainIndex:           probeState.chainIndex,
    chainBroken:          probeState.chainBroken,
  };
}

// --- Peer probe API (coordinator side) ----------------------------------------
// When this node acts as a ledger coordinator it issues probes TO other workers.
// Those workers run the computation and post results back.  The coordinator measures
// wall-clock time from issuance to result receipt � the worker cannot lie about speed.
//
// --- Coordinator identity key (for signing probe receipts) ----------------------
// Set from electron-main after wallet address is available.
let coordinatorIdentityKey = '';
function setCoordinatorIdentityKey(key) {
  coordinatorIdentityKey = typeof key === 'string' ? key : '';
}

// Pure-JS integer GPU probe hash � matches the integer GLSL shader in runGpuProbe.
// Uses 32-bit signed integer XOR-shift per pixel; results are bit-identical to
// the WebGL shader output because integer ops have no floating-point precision drift.
// This lets the coordinator verify GPU probes without needing a GPU.
function computeGpuProbeExpectedHash(seed, size, shaderIterations) {
  const seedInt = (seed | 0) || 1; // match shader: gl.uniform1i uses (seed | 0) || 1, so seed=0 → 1
  let h = 5381;
  // Iterate over every 4th pixel (flat index 0, 4, 8, ...) matching runGpuProbe's
  // hash loop: for (let i = 0; i < pixels.length; i += 16) ? every 4th pixel red channel.
  for (let p = 0; p < size * size; p += 4) {
    const row = Math.floor(p / size); // 0 = bottom row (readPixels order)
    const col = p % size;
    // Must match GLSL: int px = int(gl_FragCoord.x), py = int(gl_FragCoord.y)
    // gl_FragCoord for pixel (col, row) is (col+0.5, row+0.5); int truncation gives col, row
    let x = (Math.imul(col, 1000003) ^ Math.imul(row, 7919) ^ seedInt) | 0;
    x = x | 1; // ensure non-zero (matches shader: x |= 1)
    for (let i = 0; i < shaderIterations; i++) {
      x = (x ^ (x << 13)) | 0;
      x = (x ^ (x >> 17));          // arithmetic right shift � JS >> matches GLSL int >>
      x = (x ^ (x << 5)) | 0;
    }
    // Hash all 4 bytes (full 32-bit x packed as RGBA) — matches runGpuProbe's hash loop.
    h = ((h << 5) + h + ((x >> 24) & 255)) | 0; // R = bits 31–24
    h = ((h << 5) + h + ((x >> 16) & 255)) | 0; // G = bits 23–16
    h = ((h << 5) + h + ((x >>  8) & 255)) | 0; // B = bits 15–8
    h = ((h << 5) + h + ( x        & 255)) | 0; // A = bits 7–0
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// A separate peerProbeIssuances map is used so multiple workers can have concurrent
// in-flight probes.  Key = probeId, value = { probe, issuedAt, workerId, expectedPixelHash? }.
const peerProbeIssuances = new Map(); // probeId ? { probe, issuedAt, workerId, expectedPixelHash? }
const PEER_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;

// Ring buffer of the last 50 probes this node verified as coordinator.
// Entries: { ts, type, workerId, ok, wallClockMs, chainIndex, issues[] }
const peerAttestHistory = [];
const PEER_ATTEST_HISTORY_MAX = 50;

// Per-worker hardware-speed history (coordinator side).
// Each entry is a rolling window of WORKER_HW_HISTORY_MAX actual speeds derived
// from wall-clock timing of verified probes � NOT the self-reported values.
// Used as a floor on self-reported hardwareSpec so a worker cannot inflate
// expectedMs by under-reporting speed after the coordinator has measured faster.
const WORKER_HW_HISTORY_MAX = 20;
const WORKER_HW_ENROLL_COUNT = 4; // samples before history mean is used as floor
const workerHwHistory = new Map(); // workerId ? { cpuSamples: [], memSamples: [] }

function appendWorkerHwSample(samples, newValue) {
  if (!isFinite(newValue) || newValue <= 0) return samples;
  // Outlier rejection: ignore if > 3� or < 0.33� the current mean (slightly looser
  // than the local benchmark outlier window because network jitter adds genuine variance).
  if (samples.length >= WORKER_HW_ENROLL_COUNT) {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    if (newValue > mean * 3.0 || newValue < mean / 3.0) return samples;
  }
  const updated = [...samples, newValue];
  return updated.length > WORKER_HW_HISTORY_MAX
    ? updated.slice(updated.length - WORKER_HW_HISTORY_MAX)
    : updated;
}

// Tracks the last time each workerId requested a probe.  Used to report the
// number of active Wattcoin workers to the coordinator's UI.
const recentWorkerActivity = new Map(); // workerId ? lastSeenMs
const WORKER_ACTIVE_WINDOW_MS = 10 * 60 * 1000; // consider a worker active if seen within 10 min

// Per-worker chain state (coordinator side) � each worker has its own chained-proof head
// so the coordinator can derive the next expected seed and verify unbroken continuity.
const workerChainState = new Map(); // workerId ? { chainHead, chainIndex }

function getActiveWorkerCount() {
  const now = Date.now();
  let count = 0;
  for (const [, lastSeen] of recentWorkerActivity) {
    if (now - lastSeen < WORKER_ACTIVE_WINDOW_MS) count++;
  }
  return count;
}

// Issue a probe challenge TO a specific worker (called by coordinator HTTP handler).
// Returns the probe object to send to the worker.
function issuePeerProbe(workerId, allowGpuWorkloads) {
  const now  = Date.now();
  recentWorkerActivity.set(workerId, now);
  // Chain derivation: the next seed is derived from the worker's last verified proof
  // so the worker cannot pre-compute future answers without running every prior probe.
  const workerChain = workerChainState.get(workerId) || { chainHead: null, chainIndex: 0 };
  const rawSeed = workerChain.chainHead !== null
    ? (deriveProbeSeed(workerChain.chainHead, workerChain.chainIndex) || 1)
    : ((crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF) || 1);
  // GPU probes require gl.uniform1i-compatible seed: [1, 0x7FFFFFFF]
  const seed = (rawSeed & 0x7FFFFFFF) | 1;
  const types = ['cpu', 'memory', ...(allowGpuWorkloads ? ['gpu'] : [])];
  const type  = types[Math.floor(Math.random() * types.length)];

  const probe = {
    id: `peer-${now.toString(36)}-${seed.toString(16)}`,
    type,
    issuedAt: now,
    params: type === 'cpu'    ? { seed, iterations: PROBE_CPU_ITERS }
           : type === 'memory' ? { arraySeed: seed, iterations: PROBE_MEM_ITERS, entries: PROBE_MEM_ENTRIES }
           : /* gpu */           { seed, size: PROBE_GPU_SIZE, shaderIterations: PROBE_GPU_ITERS },
  };

  // Expire stale issuances for this worker before adding new one.
  // Record each expired entry into peerAttestHistory as a timeout so the UI
  // can show that a worker received a probe but never submitted a result.
  for (const [id, entry] of peerProbeIssuances) {
    if (entry.workerId === workerId && now - entry.issuedAt > PEER_PROBE_TIMEOUT_MS) {
      peerProbeIssuances.delete(id);
      console.warn(`[PeerProbe] ${entry.probe.type} probe timed out (no submission) id=${id} worker=${workerId}`);
      peerAttestHistory.unshift({
        ts:         now,
        id:         entry.probe.id,
        type:       entry.probe.type,
        workerId:   entry.workerId,
        ok:         false,
        wallClockMs: now - entry.issuedAt,
        chainIndex: null,
        issues:     ['probe timed out: worker received challenge but never submitted result'],
      });
      if (peerAttestHistory.length > PEER_ATTEST_HISTORY_MAX) peerAttestHistory.length = PEER_ATTEST_HISTORY_MAX;
    }
  }
  // If this worker already has an active in-flight probe (not yet timed out),
  // return the same challenge instead of stacking a new entry.  Mirrors the
  // behaviour of getPendingProbe() for local probes � prevents entries from
  // accumulating in peerProbeIssuances when a worker polls repeatedly without
  // submitting (e.g. a transient network failure on the submit path).
  for (const [existingId, existingEntry] of peerProbeIssuances) {
    if (existingEntry.workerId === workerId) {
      console.log(`[PeerProbe] Returning in-flight ${existingEntry.probe.type} probe id=${existingId} for worker=${workerId}`);
      return { ...existingEntry.probe };
    }
  }
  // For GPU probes: pre-compute the expected pixel hash using pure-JS integer algebra.
  // This allows algebraic verification in submitPeerProbeResult without needing a GPU.
  const expectedPixelHash = (type === 'gpu')
    ? computeGpuProbeExpectedHash(probe.params.seed, probe.params.size, probe.params.shaderIterations)
    : null;
  peerProbeIssuances.set(probe.id, { probe, issuedAt: now, workerId, expectedPixelHash, workerChainIndexAtIssuance: workerChain.chainIndex });
  console.log(`[PeerProbe] Issued ${type} probe id=${probe.id} to worker=${workerId} chain=${workerChain.chainIndex}${expectedPixelHash ? ' (GPU expected hash pre-computed)' : ''}`);
  // Return probe WITHOUT params.seed in plaintext for GPU (no computational advantage),
  // but CPU/memory seeds are needed by the worker to run the algorithm � they're fine
  // to transmit because re-running is equivalent to computing a new result.
  return { ...probe };
}

// Receive and verify a worker's probe result (called by coordinator HTTP handler).
// wallClockMs is the coordinator's own measurement: Date.now() - entry.issuedAt.
function submitPeerProbeResult(result, hardwareSpec) {
  if (!result || !result.id) return { ok: false, issues: ['missing probe id'] };
  const entry = peerProbeIssuances.get(result.id);
  if (!entry) return { ok: false, issues: ['unknown or expired probe id'] };

  peerProbeIssuances.delete(result.id);
  const wallClockMs = Date.now() - entry.issuedAt;
  const probe = entry.probe;
  const issues = [];
  let proofValid = false;

  if (probe.type === 'cpu') {
    proofValid = verifyCpuProbe(probe.params.seed, probe.params.iterations, result.proof || '');
    if (!proofValid) {
      issues.push('cpu peer-probe: proof hash mismatch');
    } else if (hardwareSpec && hardwareSpec.measuredCpuOpsPerSec > 0) {
      // Derive actual speed the coordinator measured independently from wall clock.
      const workerHist = workerHwHistory.get(entry.workerId) || { cpuSamples: [], memSamples: [] };
      const historicalCpuMean = workerHist.cpuSamples.length >= WORKER_HW_ENROLL_COUNT
        ? workerHist.cpuSamples.reduce((a, b) => a + b, 0) / workerHist.cpuSamples.length : 0;
      // Floor: a worker cannot claim to be slower than history shows they actually are.
      const effectiveCpuOpsPerSec = Math.max(hardwareSpec.measuredCpuOpsPerSec, historicalCpuMean);
      const expectedMs = (probe.params.iterations / effectiveCpuOpsPerSec) * 1000;
      const ratio = wallClockMs / Math.max(1, expectedMs);
      if (ratio < 1 / PROBE_PEER_SLACK) issues.push(`cpu peer-probe suspiciously fast: ${Math.round(wallClockMs)}ms vs expected ~${Math.round(expectedMs)}ms`);
      if (ratio > PROBE_PEER_SLACK)     issues.push(`cpu peer-probe too slow: ${Math.round(wallClockMs)}ms vs expected ~${Math.round(expectedMs)}ms (ratio=${ratio.toFixed(2)})`);
    }
  } else if (probe.type === 'memory') {
    proofValid = verifyMemProbe(probe.params.arraySeed, probe.params.iterations, result.proof || '');
    if (!proofValid) {
      issues.push('memory peer-probe: proof hash mismatch');
    } else if (hardwareSpec && hardwareSpec.measuredMemLatencyNs > 0) {
      const workerHist = workerHwHistory.get(entry.workerId) || { cpuSamples: [], memSamples: [] };
      const historicalMemMean = workerHist.memSamples.length >= WORKER_HW_ENROLL_COUNT
        ? workerHist.memSamples.reduce((a, b) => a + b, 0) / workerHist.memSamples.length : 0;
      // Floor: a worker cannot claim higher latency (slower) than history shows.
      const effectiveMemLatencyNs = Math.min(
        hardwareSpec.measuredMemLatencyNs,
        historicalMemMean > 0 ? historicalMemMean : hardwareSpec.measuredMemLatencyNs
      );
      const expectedMs = (probe.params.iterations * effectiveMemLatencyNs) / 1e6;
      const ratio = wallClockMs / Math.max(1, expectedMs);
      if (ratio < 1 / PROBE_PEER_SLACK) issues.push(`memory peer-probe suspiciously fast: ${Math.round(wallClockMs)}ms vs expected ~${Math.round(expectedMs)}ms`);
      if (ratio > PROBE_PEER_SLACK)     issues.push(`memory peer-probe too slow: ${Math.round(wallClockMs)}ms vs expected ~${Math.round(expectedMs)}ms`);
    }
  } else if (probe.type === 'gpu') {
    if (typeof result.pixelHash !== 'string' || result.pixelHash.length === 0) {
      issues.push('gpu peer-probe: no pixel hash returned');
      proofValid = false;
    } else if (entry.expectedPixelHash) {
      // Algebraic verification: coordinator pre-computed the expected hash using the
      // integer shader algorithm in pure JS � must match exactly.
      proofValid = result.pixelHash === entry.expectedPixelHash;
      if (!proofValid) {
        issues.push(`gpu peer-probe: pixel hash mismatch (got ${result.pixelHash}, expected ${entry.expectedPixelHash})`);
      } else if (wallClockMs < 5) {
        issues.push(`gpu peer-probe suspiciously fast: ${wallClockMs}ms`);
      }
    } else {
      // No expected hash (coordinator couldn't pre-compute) � fall back to timing + presence.
      proofValid = true;
      if (wallClockMs < 5) issues.push(`gpu peer-probe suspiciously fast: ${wallClockMs}ms`);
    }
  }

  const ok = issues.length === 0;

  // Update per-worker hardware-speed history using wall-clock actual speeds.
  // Only update on a passing proof so cheating attempts don't corrupt the history.
  if (proofValid) {
    const wh = workerHwHistory.get(entry.workerId) || { cpuSamples: [], memSamples: [] };
    if (probe.type === 'cpu' && wallClockMs > 0) {
      const actualCpuOpsPerSec = (probe.params.iterations / wallClockMs) * 1000;
      wh.cpuSamples = appendWorkerHwSample(wh.cpuSamples, actualCpuOpsPerSec);
    } else if (probe.type === 'memory' && wallClockMs > 0) {
      const actualMemLatencyNs = (wallClockMs * 1e6) / probe.params.iterations;
      wh.memSamples = appendWorkerHwSample(wh.memSamples, actualMemLatencyNs);
    }
    workerHwHistory.set(entry.workerId, wh);
  }

  // Advance or break the worker's chain based on outcome.
  const workerChainEntry = workerChainState.get(entry.workerId) || { chainHead: null, chainIndex: 0 };
  if (proofValid && ok) {
    const proofKey = probe.type === 'gpu' ? (result.pixelHash || '') : (result.proof || '');
    workerChainEntry.chainHead  = proofKey;
    workerChainEntry.chainIndex = (workerChainEntry.chainIndex || 0) + 1;
    workerChainState.set(entry.workerId, workerChainEntry);
  } else {
    // Break: reset chainHead so next probe uses a fresh random seed
    workerChainState.set(entry.workerId, { chainHead: null, chainIndex: workerChainEntry.chainIndex || 0 });
  }

  const tag = ok ? 'PASS' : 'FAIL';

  // Generate the canonical receipt payload so the HTTP handler can sign it with the
  // verifier's secp256k1 wallet key before returning it to the worker.
  let receipt = null;
  if (coordinatorIdentityKey) {
    receipt = normalizeProbeReceipt({
      version: PROBE_RECEIPT_VERSION,
      probeId:     entry.probe.id,
      verifierAddress: coordinatorIdentityKey,
      workerId:    entry.workerId,
      type:        probe.type,
      ok,
      wallClockMs,
      ts:          Date.now(),
      chainIndex:  workerChainEntry.chainIndex,
      chainHead:   workerChainEntry.chainHead,
    }, { includeSignature: false });
  }

  console.log(`[PeerProbe] ${probe.type} ${tag} wall=${wallClockMs}ms worker=${entry.workerId}${issues.length ? ' - ' + issues.join('; ') : ''}`);

  // Record in coordinator attest history so the UI can display attested probes.
  peerAttestHistory.unshift({
    ts:         Date.now(),
    id:         probe.id,
    type:       probe.type,
    workerId:   entry.workerId,
    ok,
    wallClockMs,
    chainIndex: workerChainEntry.chainIndex,
    pixelHash:  probe.type === 'gpu' ? String(result.pixelHash || '') : '',
    proof:      probe.type !== 'gpu' ? String(result.proof || '') : '',
    issues,
  });
  if (peerAttestHistory.length > PEER_ATTEST_HISTORY_MAX) peerAttestHistory.length = PEER_ATTEST_HISTORY_MAX;

  return { ok, proofValid, issues, wallClockMs, workerId: entry.workerId, receipt };
}

function getAttestHistory() {
  return { history: peerAttestHistory.map(e => ({ ...e })) };
}

function getPeerProbeHistory() {
  // Expose any still-pending (in-flight) probes for diagnostics.
  const now = Date.now();
  const pending = [];
  for (const [id, entry] of peerProbeIssuances) {
    pending.push({ id, type: entry.probe.type, workerId: entry.workerId, ageMs: now - entry.issuedAt });
  }
  return { pendingCount: pending.length, pending };
}

// Returns the standalone (local) probe chain state so settlement can use the
// backend's own tracked values instead of trusting renderer-supplied values.
function getLocalProbeChain() {
  return {
    chainHead:   probeState.chainHead,
    chainIndex:  probeState.chainIndex,
    chainBroken: probeState.chainBroken,
  };
}

// Tracks whether a peer probe was successfully verified per worker (coordinator mode)
// and per local round (standalone mode).  Keyed by workerId/minedAddress.
const workerPeerProbeVerifiedMap = new Map();
function getWorkerPeerProbeVerified(workerId) {
  return !!workerPeerProbeVerifiedMap.get(String(workerId || ''));
}
function setWorkerPeerProbeVerified(workerId) {
  workerPeerProbeVerifiedMap.set(String(workerId || ''), true);
}
function resetWorkerPeerProbeVerified(workerId) {
  workerPeerProbeVerifiedMap.delete(String(workerId || ''));
}

// Returns probe-derived hardware stats for a worker, or null if no history.
function getWorkerHwStats(workerId) {
  const hist = workerHwHistory.get(String(workerId || ''));
  if (!hist) return null;
  const cpuMean = hist.cpuSamples.length > 0
    ? hist.cpuSamples.reduce((a, b) => a + b, 0) / hist.cpuSamples.length : 0;
  const memMean = hist.memSamples.length > 0
    ? hist.memSamples.reduce((a, b) => a + b, 0) / hist.memSamples.length : 0;
  return { cpuMean, memMean, cpuCount: hist.cpuSamples.length, memCount: hist.memSamples.length };
}

// Returns a JSON-serialisable snapshot of coordinator in-memory state for persistence.
function getCoordinatorStateSnapshot() {
  const hwHistObj = {};
  for (const [k, v] of workerHwHistory) {
    hwHistObj[k] = { cpuSamples: v.cpuSamples.slice(), memSamples: v.memSamples.slice() };
  }
  const probeVerifiedObj = {};
  for (const [k] of workerPeerProbeVerifiedMap) {
    probeVerifiedObj[k] = true;
  }
  return { workerHwHistory: hwHistObj, workerPeerProbeVerified: probeVerifiedObj };
}

// Restores coordinator in-memory state from a persisted snapshot.
function restoreCoordinatorState(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (snapshot.workerHwHistory && typeof snapshot.workerHwHistory === 'object') {
    for (const [k, v] of Object.entries(snapshot.workerHwHistory)) {
      if (v && Array.isArray(v.cpuSamples) && Array.isArray(v.memSamples)) {
        workerHwHistory.set(k, { cpuSamples: v.cpuSamples.slice(), memSamples: v.memSamples.slice() });
      }
    }
  }
  if (snapshot.workerPeerProbeVerified && typeof snapshot.workerPeerProbeVerified === 'object') {
    for (const [k, v] of Object.entries(snapshot.workerPeerProbeVerified)) {
      if (v) workerPeerProbeVerifiedMap.set(k, true);
    }
  }
}

// Periodic sweep: expire peerProbeIssuances for ALL workers, not just ones that
// come back to poll again.  Without this, probes from workers that go offline
// accumulate silently in the map and are only recorded as timeouts when (if) the
// worker reconnects.  Running every 60 s means a timeout is recorded within
// PEER_PROBE_TIMEOUT_MS + 60 s instead of PEER_PROBE_TIMEOUT_MS + "next worker poll".
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of peerProbeIssuances) {
    if (now - entry.issuedAt > PEER_PROBE_TIMEOUT_MS) {
      peerProbeIssuances.delete(id);
      console.warn(`[PeerProbe] ${entry.probe.type} probe timed out (sweep) id=${id} worker=${entry.workerId}`);
      peerAttestHistory.unshift({
        ts:         now,
        id:         entry.probe.id,
        type:       entry.probe.type,
        workerId:   entry.workerId,
        ok:         false,
        wallClockMs: now - entry.issuedAt,
        chainIndex: null,
        issues:     ['probe timed out: worker received challenge but never submitted result'],
      });
      if (peerAttestHistory.length > PEER_ATTEST_HISTORY_MAX) peerAttestHistory.length = PEER_ATTEST_HISTORY_MAX;
    }
  }
}, 60_000);

module.exports = {
  getBenchmarkCapabilities,
  runBackendBenchmark,
  setProbeHardwareSpec,
  getPendingProbe,
  submitProbeResult,
  getProbeHistory,
  issuePeerProbe,
  submitPeerProbeResult,
  getPeerProbeHistory,
  getActiveWorkerCount,
  // Exported for cross-process verification (item 1) and GPU hash (item 3)
  verifyCpuSpeedProof,
  verifyMemProof,
  computeGpuProbeExpectedHash,
  setCoordinatorIdentityKey,
  // Exported so settlement logic can compute expected probe count per round
  PROBE_INTERVAL_MS,
  // Authoritative probe chain state (cannot be spoofed by renderer)
  getLocalProbeChain,
  // Per-worker peer-probe verification tracking (coordinator mode)
  getWorkerPeerProbeVerified,
  setWorkerPeerProbeVerified,
  resetWorkerPeerProbeVerified,
  // Probe-history stats and coordinator state persistence helpers
  getWorkerHwStats,
  getCoordinatorStateSnapshot,
  restoreCoordinatorState,
  getAttestHistory,
};

