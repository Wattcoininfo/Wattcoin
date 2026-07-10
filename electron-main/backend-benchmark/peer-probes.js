'use strict';
const crypto = require('crypto');
const { PROBE_RECEIPT_VERSION, normalizeProbeReceipt } = require('../../probe-attestation');
const { getExpectedCpuSpeedOps, getAsicPowerW, getGpuTdpW } = require('../../hardware-tables.cjs');
const { verifyX11Share, STRATUM_DIFFICULTY } = require('../../local-stratum');
const {
  computeGpuProbeExpectedHash,
  verifyGpuPowProbe,
  verifyCpuProbe,
  verifyMemProbe,
  deriveProbeSeed,
  PROBE_CPU_ITERS,
  PROBE_MEM_ENTRIES,
  PROBE_MEM_ITERS,
  PROBE_GPU_SIZE,
  PROBE_GPU_ITERS,
  PROBE_GPU_POW_DIFFICULTY,
  PROBE_PEER_SLACK,
} = require('./benchmark-execution');
const {
  WORKER_HW_ENROLL_COUNT,
  WORKER_MAX_CONSECUTIVE_TIMEOUTS,
  workerHwHistory,
  recentWorkerActivity,
  workerChainState,
  workerConsecutiveTimeouts,
  appendWorkerHwSample,
  getWorkerRtt,
} = require('./worker-state');
const { PROBE_TIMEOUT_MS } = require('./local-probes');

// --- Peer probe API (coordinator side) ----------------------------------------
// When this node acts as a ledger coordinator it issues probes TO other workers.
// Those workers run the computation and post results back.  The coordinator measures
// wall-clock time from issuance to result receipt — the worker cannot lie about speed.
//
// --- Coordinator identity key (for signing probe receipts) ----------------------
// Set from electron-main after wallet address is available.
let coordinatorIdentityKey = '';
function setCoordinatorIdentityKey(key) {
  coordinatorIdentityKey = typeof key === 'string' ? key : '';
}

// Per-worker hardware-speed history (coordinator side).
// Each entry is a rolling window of WORKER_HW_HISTORY_MAX actual speeds derived
// from wall-clock timing of verified probes — NOT the self-reported values.
// Used as a floor on self-reported hardwareSpec so a worker cannot inflate
// expectedMs by under-reporting speed after the coordinator has measured faster.

// A separate peerProbeIssuances map is used so multiple workers can have concurrent
// in-flight probes.  Key = probeId, value = { probe, issuedAt, workerId, expectedPixelHash? }.
const peerProbeIssuances = new Map(); // probeId — { probe, issuedAt, workerId, expectedPixelHash? }
const PEER_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;

// Ring buffer of the last 50 probes this node verified as coordinator.
// Entries: { ts, type, workerId, ok, wallClockMs, chainIndex, issues[] }
const peerAttestHistory = [];
const PEER_ATTEST_HISTORY_MAX = 50;

// Issue a probe challenge TO a specific worker (called by coordinator HTTP handler).
// Returns the probe object to send to the worker.
function issuePeerProbe(workerId, allowGpuWorkloads, hasAsic, gpuPowCapable) {
  const now = Date.now();
  recentWorkerActivity.set(workerId, now);
  // Chain derivation: the next seed is derived from the worker's last verified proof
  // so the worker cannot pre-compute future answers without running every prior probe.
  const workerChain = workerChainState.get(workerId) || { chainHead: null, chainIndex: 0 };
  const rawSeed =
    workerChain.chainHead !== null
      ? deriveProbeSeed(workerChain.chainHead, workerChain.chainIndex) || 1
      : crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff || 1;
  // GPU probes require gl.uniform1i-compatible seed: [1, 0x7FFFFFFF]
  const seed = (rawSeed & 0x7fffffff) | 1;
  const types = [
    'cpu',
    'memory',
    ...(allowGpuWorkloads ? ['gpu'] : []),
    ...(gpuPowCapable ? ['gpu-pow'] : []),
    ...(hasAsic ? ['asic'] : []),
  ];
  const type = types[Math.floor(Math.random() * types.length)];

  const probe = {
    id: `peer-${now.toString(36)}-${seed.toString(16)}`,
    type,
    issuedAt: now,
    params:
      type === 'cpu'
        ? { seed, iterations: PROBE_CPU_ITERS }
        : type === 'memory'
          ? { arraySeed: seed, iterations: PROBE_MEM_ITERS, entries: PROBE_MEM_ENTRIES }
          : type === 'gpu'
            ? { seed, size: PROBE_GPU_SIZE, shaderIterations: PROBE_GPU_ITERS }
            : type === 'gpu-pow'
              ? { seed, difficulty: PROBE_GPU_POW_DIFFICULTY }
              : /* asic */ { minShares: 3 },
  };

  // ASIC liveness challenge: generate a random 32-byte prevHash that the worker
  // must inject into the local stratum.  The ASIC must X11-hash a header built
  // from this challenge to produce a valid share — prevents pre-mined shares.
  if (type === 'asic') {
    const challengePrevHash = crypto.randomBytes(32).toString('hex');
    probe.params.challengePrevHash = challengePrevHash;
  }

  // Expire stale issuances for this worker before adding new one.
  // Record each expired entry into peerAttestHistory as a timeout so the UI
  // can show that a worker received a probe but never submitted a result.
  for (const [id, entry] of peerProbeIssuances) {
    if (entry.workerId === workerId && now - entry.issuedAt > PEER_PROBE_TIMEOUT_MS) {
      peerProbeIssuances.delete(id);
      console.warn(`[PeerProbe] ${entry.probe.type} probe timed out (no submission) id=${id} worker=${workerId}`);
      peerAttestHistory.unshift({
        ts: now,
        id: entry.probe.id,
        type: entry.probe.type,
        workerId: entry.workerId,
        ok: false,
        wallClockMs: now - entry.issuedAt,
        chainIndex: null,
        issues: ['probe timed out: worker received challenge but never submitted result'],
      });
      if (peerAttestHistory.length > PEER_ATTEST_HISTORY_MAX) peerAttestHistory.length = PEER_ATTEST_HISTORY_MAX;
      // Break the worker's chain on timeout so the next probe uses a fresh random seed
      // instead of re-deriving from the same stale chain head.
      const wc = workerChainState.get(entry.workerId);
      if (wc) {
        workerChainState.set(entry.workerId, {
          chainHead: null,
          chainIndex: wc.chainIndex || 0,
          lastShareCount: wc.lastShareCount,
          lastShareCheckTime: wc.lastShareCheckTime,
        });
      }
      // Track consecutive timeouts so the coordinator can quarantine the worker.
      const to = (workerConsecutiveTimeouts.get(entry.workerId) || 0) + 1;
      workerConsecutiveTimeouts.set(entry.workerId, to);
    }
  }
  // If this worker already has an active in-flight probe (not yet timed out),
  // return the same challenge instead of stacking a new entry.  Mirrors the
  // behaviour of getPendingProbe() for local probes — prevents entries from
  // accumulating in peerProbeIssuances when a worker polls repeatedly without
  // submitting (e.g. a transient network failure on the submit path).
  for (const [_existingId, existingEntry] of peerProbeIssuances) {
    if (existingEntry.workerId === workerId) {
      return { ...existingEntry.probe };
    }
  }
  // If this worker has exceeded the consecutive timeout threshold, quarantine it
  // by refusing to issue new probes.  The worker must reconnect or submit a
  // successful result to reset the counter.
  if ((workerConsecutiveTimeouts.get(workerId) || 0) >= WORKER_MAX_CONSECUTIVE_TIMEOUTS) {
    console.warn(
      `[PeerProbe] Worker ${workerId} has ${workerConsecutiveTimeouts.get(workerId)} consecutive timeouts - quarantined`,
    );
    return null;
  }

  // For GPU probes: pre-compute the expected pixel hash using pure-JS integer algebra.
  // This allows algebraic verification in submitPeerProbeResult without needing a GPU.
  const expectedPixelHash =
    type === 'gpu'
      ? computeGpuProbeExpectedHash(probe.params.seed, probe.params.size, probe.params.shaderIterations)
      : null;
  peerProbeIssuances.set(probe.id, {
    probe,
    issuedAt: now,
    workerId,
    expectedPixelHash,
    challengePrevHash: probe.params.challengePrevHash || null,
    workerChainIndexAtIssuance: workerChain.chainIndex,
  });
  console.log(
    `[PeerProbe] Issued ${type} probe id=${probe.id} to worker=${workerId} chain=${workerChain.chainIndex}${expectedPixelHash ? ' (GPU expected hash pre-computed)' : ''}`,
  );
  // Return probe WITHOUT params.seed in plaintext for GPU (no computational advantage),
  // but CPU/memory seeds are needed by the worker to run the algorithm — they're fine
  // to transmit because re-running is equivalent to computing a new result.
  return { ...probe };
}

// Receive and verify a worker's probe result (called by coordinator HTTP handler).
// wallClockMs is the coordinator's own measurement: Date.now() - entry.issuedAt.
async function submitPeerProbeResult(result, hardwareSpec, currentRoundId) {
  if (!result || !result.id) return { ok: false, issues: ['missing probe id'] };
  const entry = peerProbeIssuances.get(result.id);
  if (!entry) return { ok: false, issues: ['unknown or expired probe id'] };

  peerProbeIssuances.delete(result.id);
  const wallClockMs = Date.now() - entry.issuedAt;
  // Use the worker-reported probeWallClockMs capped at the coordinator's RTT.
  // The worker reports actual computation time; the RTT is an upper bound
  // (computation can't exceed the total round-trip). This prevents network
  // latency and poll-cycle delays from inflating the timing ratio.
  const probeWallClockMs =
    typeof result.probeWallClockMs === 'number' && result.probeWallClockMs > 0
      ? Math.min(wallClockMs, result.probeWallClockMs)
      : wallClockMs;
  const probe = entry.probe;
  const issues = [];
  let proofValid = false;

  if (probe.type === 'cpu') {
    proofValid = await verifyCpuProbe(probe.params.seed, probe.params.iterations, result.proof || '');
    if (!proofValid) {
      issues.push('cpu peer-probe: proof hash mismatch');
    } else if (hardwareSpec && hardwareSpec.measuredCpuOpsPerSec > 0) {
      // Derive actual speed the coordinator measured independently from wall clock.
      const workerHist = workerHwHistory.get(entry.workerId) || { cpuSamples: [], memSamples: [], gpuPowSamples: [] };
      const historicalCpuMean =
        workerHist.cpuSamples.length >= WORKER_HW_ENROLL_COUNT
          ? workerHist.cpuSamples.reduce((a, b) => a + b, 0) / workerHist.cpuSamples.length
          : 0;
      // Floor: a worker cannot claim to be slower than history shows they actually are.
      const effectiveCpuOpsPerSec = Math.max(hardwareSpec.measuredCpuOpsPerSec, historicalCpuMean);
      const loadPct = result.loadPercent;
      const expectedMs = (probe.params.iterations / effectiveCpuOpsPerSec) * 1000;
      const probeTimeMs = probeWallClockMs;
      const ratio = probeTimeMs / Math.max(1, expectedMs);
      if (ratio < 1 / PROBE_PEER_SLACK)
        issues.push(
          `cpu peer-probe suspiciously fast: ${Math.round(probeTimeMs)}ms vs expected ~${Math.round(expectedMs)}ms load=${loadPct != null ? loadPct : '?'}%`,
        );
      if (ratio > PROBE_PEER_SLACK)
        issues.push(
          `cpu peer-probe too slow: ${Math.round(probeTimeMs)}ms vs expected ~${Math.round(expectedMs)}ms (ratio=${ratio.toFixed(2)}) load=${loadPct != null ? loadPct : '?'}%`,
        );
    }
  } else if (probe.type === 'memory') {
    proofValid = await verifyMemProbe(probe.params.arraySeed, probe.params.iterations, result.proof || '');
    if (!proofValid) {
      issues.push('memory peer-probe: proof hash mismatch');
    } else if (hardwareSpec && hardwareSpec.measuredMemLatencyNs > 0) {
      const workerHist = workerHwHistory.get(entry.workerId) || { cpuSamples: [], memSamples: [], gpuPowSamples: [] };
      const historicalMemMean =
        workerHist.memSamples.length >= WORKER_HW_ENROLL_COUNT
          ? workerHist.memSamples.reduce((a, b) => a + b, 0) / workerHist.memSamples.length
          : 0;
      // Floor: a worker cannot claim higher latency (slower) than history shows.
      const effectiveMemLatencyNs = Math.min(
        hardwareSpec.measuredMemLatencyNs,
        historicalMemMean > 0 ? historicalMemMean : hardwareSpec.measuredMemLatencyNs,
      );
      const loadPct = result.loadPercent;
      const expectedMs = (probe.params.iterations * effectiveMemLatencyNs) / 1e6;
      const probeTimeMs = probeWallClockMs;
      const ratio = probeTimeMs / Math.max(1, expectedMs);
      if (ratio < 1 / PROBE_PEER_SLACK)
        issues.push(
          `memory peer-probe suspiciously fast: ${Math.round(probeTimeMs)}ms vs expected ~${Math.round(expectedMs)}ms load=${loadPct != null ? loadPct : '?'}%`,
        );
      if (ratio > PROBE_PEER_SLACK)
        issues.push(
          `memory peer-probe too slow: ${Math.round(probeTimeMs)}ms vs expected ~${Math.round(expectedMs)}ms load=${loadPct != null ? loadPct : '?'}%`,
        );
    }
  } else if (probe.type === 'gpu') {
    if (typeof result.pixelHash !== 'string' || result.pixelHash.length === 0) {
      issues.push('gpu peer-probe: no pixel hash returned');
      proofValid = false;
    } else if (entry.expectedPixelHash) {
      // Algebraic verification: coordinator pre-computed the expected hash using the
      // integer shader algorithm in pure JS — must match exactly.
      proofValid = result.pixelHash === entry.expectedPixelHash;
      if (!proofValid) {
        issues.push(
          `gpu peer-probe: pixel hash mismatch (got ${result.pixelHash}, expected ${entry.expectedPixelHash})`,
        );
      } else if (wallClockMs < 5) {
        issues.push(`gpu peer-probe suspiciously fast: ${wallClockMs}ms`);
      }
    } else {
      // No expected hash (coordinator couldn't pre-compute) — fall back to timing + presence.
      proofValid = true;
      if (wallClockMs < 5) issues.push(`gpu peer-probe suspiciously fast: ${wallClockMs}ms`);
    }
  } else if (probe.type === 'gpu-pow') {
    // GPU PoW probe: worker found a nonce on each device where the proof hash (lower 16 bits) < difficulty.
    // Each device uses its own seed partition, so all GPUs independently prove work.
    const devices = Array.isArray(result.devices) ? result.devices : [];
    if (devices.length === 0) {
      proofValid = false;
      issues.push('gpu-pow peer-probe: no device results');
    } else {
      let allValid = true;
      for (const d of devices) {
        if (d.nonce == null) {
          allValid = false;
          issues.push(`gpu-pow peer-probe: device ${d.deviceIndex} missing nonce`);
          break;
        }
        const nonce = Number(d.nonce);
        if (!Number.isFinite(nonce)) {
          allValid = false;
          issues.push(`gpu-pow peer-probe: device ${d.deviceIndex} invalid nonce: ${d.nonce}`);
          break;
        }
        const v = verifyGpuPowProbe(probe.params.seed, d.deviceIndex, nonce, probe.params.difficulty);
        if (!v.passes) {
          allValid = false;
          issues.push(
            `gpu-pow peer-probe: device ${d.deviceIndex} hash ${v.hash16} >= difficulty ${probe.params.difficulty} (nonce=${nonce})`,
          );
          break;
        }
      }
      proofValid = allValid;
      if (allValid && wallClockMs < 10) {
        issues.push(`gpu-pow peer-probe suspiciously fast: ${wallClockMs}ms — nonce likely pre-computed`);
      }
      if (allValid && probeWallClockMs > 0) {
        const gpuCount = Math.max(1, devices.length);
        const workerHist = workerHwHistory.get(entry.workerId) || { cpuSamples: [], memSamples: [], gpuPowSamples: [] };
        const historicalTimePerNonceMean =
          workerHist.gpuPowSamples.length >= WORKER_HW_ENROLL_COUNT
            ? workerHist.gpuPowSamples.reduce((a, b) => a + b, 0) / workerHist.gpuPowSamples.length
            : 0;
        if (historicalTimePerNonceMean > 0) {
          const expectedMs = historicalTimePerNonceMean * gpuCount;
          const ratio = probeWallClockMs / expectedMs;
          if (ratio < 1 / PROBE_PEER_SLACK)
            issues.push(
              `gpu-pow peer-probe suspiciously fast: ${Math.round(probeWallClockMs)}ms for ${gpuCount} GPUs vs historical ~${Math.round(expectedMs)}ms`,
            );
          if (ratio > PROBE_PEER_SLACK)
            issues.push(
              `gpu-pow peer-probe too slow: ${Math.round(probeWallClockMs)}ms for ${gpuCount} GPUs vs historical ~${Math.round(expectedMs)}ms (ratio=${ratio.toFixed(2)})`,
            );
        }
      }
    }
  } else if (probe.type === 'asic') {
    // ASIC peer-probe: worker returned fresh X11 shares from stratum.
    // Verify each share cryptographically: X11(header) === hash < target.
    const shares = Array.isArray(result.shares) ? result.shares : [];
    const expectedTHs = hardwareSpec && hardwareSpec.asicHashrateTHs > 0 ? hardwareSpec.asicHashrateTHs : 0;
    if (shares.length === 0) {
      proofValid = false;
      issues.push('asic peer-probe: no shares returned — ASIC not hashing');
    } else {
      let allValid = true;
      for (let i = 0; i < shares.length; i++) {
        const s = shares[i];
        if (!s.headerHex || !s.hashHex || !s.nbitsHex) {
          allValid = false;
          issues.push(`asic peer-probe: share ${i} missing header/hash/nbits`);
          continue;
        }
        const verified = await verifyX11Share(s.headerHex, s.hashHex, s.nbitsHex);
        if (!verified) {
          allValid = false;
          issues.push(`asic peer-probe: share ${i} X11 verification failed`);
        } else if (entry.challengePrevHash) {
          // Verify the share header contains the peer-generated prevHash challenge.
          // Header bytes 4-35 (0-indexed) are the prevHash in little-endian.
          const headerBuf = Buffer.from(s.headerHex, 'hex');
          const sharePrevHashLE = headerBuf.subarray(4, 36);
          const sharePrevHashBE = Buffer.from(sharePrevHashLE).reverse().toString('hex');
          if (sharePrevHashBE !== entry.challengePrevHash) {
            allValid = false;
            issues.push(`asic peer-probe: share ${i} prevHash does not match liveness challenge`);
          }
        } else if (probe.issuedAt && s.timestamp && s.timestamp < probe.issuedAt - 5000) {
          allValid = false;
          issues.push(`asic peer-probe: share ${i} timestamp ${s.timestamp} is before probe issuance`);
        }
      }
      proofValid = allValid;
      // Timing consistency: expected wall clock based on declared ASIC hashrate and stratum difficulty
      if (proofValid && expectedTHs > 0 && shares.length > 0) {
        const expectedMs = ((shares.length * STRATUM_DIFFICULTY * 4294967296) / (expectedTHs * 1e12)) * 1000;
        if (wallClockMs > 0 && wallClockMs < expectedMs * 0.1) {
          issues.push(
            `asic peer-probe suspiciously fast: ${Math.round(wallClockMs)}ms for ${shares.length} shares ` +
              `(expected ~${Math.round(expectedMs)}ms at ${expectedTHs.toFixed(4)} TH/s, diff=${STRATUM_DIFFICULTY})`,
          );
        }
      }
      // Cross-probe share-delta check for this worker.
      if (expectedTHs > 0) {
        const wc = workerChainState.get(entry.workerId) || { chainHead: null, chainIndex: 0 };
        const lastCount = wc.lastShareCount;
        const lastCheckTime = wc.lastShareCheckTime || 0;
        if (
          typeof lastCount === 'number' &&
          lastCount >= 0 &&
          typeof result.shareCount === 'number' &&
          result.shareCount >= 0
        ) {
          const delta = result.shareCount - lastCount;
          const elapsedMs = Date.now() - lastCheckTime;
          if (elapsedMs > 20000 && delta < 3) {
            const expectedDelta = ((elapsedMs / 1000) * (expectedTHs * 1e12)) / (STRATUM_DIFFICULTY * 4294967296);
            if (expectedDelta > 5 && delta < expectedDelta * 0.1) {
              issues.push(
                `asic peer-probe: only ${delta} shares since last probe in ${(elapsedMs / 1000).toFixed(0)}s ` +
                  `(expected ~${Math.round(expectedDelta)}) — ASIC may have been idle between probes`,
              );
            }
          }
        }
        if (typeof result.shareCount === 'number' && result.shareCount >= 0) {
          wc.lastShareCount = result.shareCount;
          wc.lastShareCheckTime = Date.now();
          workerChainState.set(entry.workerId, wc);
        }
      }
    }
    // Use share count + best hash as chain proof for continuity tracking.
    const bestHash = shares.length > 0 ? shares[0].hashHex || '' : '';
    result.proof = result.proof || `${shares.length}:${bestHash.slice(0, 16)}`;
  }

  const ok = issues.length === 0;

  // Update per-worker hardware-speed history using actual computation time
  // (worker-reported probeWallClockMs) so network latency does not distort
  // the measured hardware speed. Only update on a passing proof so cheating
  // attempts don't corrupt the history.
  if (proofValid) {
    const wh = workerHwHistory.get(entry.workerId) || { cpuSamples: [], memSamples: [], gpuPowSamples: [] };
    if (probe.type === 'cpu' && probeWallClockMs > 0) {
      const actualCpuOpsPerSec = (probe.params.iterations / probeWallClockMs) * 1000;
      wh.cpuSamples = appendWorkerHwSample(wh.cpuSamples, actualCpuOpsPerSec);
    } else if (probe.type === 'memory' && probeWallClockMs > 0) {
      const actualMemLatencyNs = (probeWallClockMs * 1e6) / probe.params.iterations;
      wh.memSamples = appendWorkerHwSample(wh.memSamples, actualMemLatencyNs);
    } else if (probe.type === 'gpu-pow' && probeWallClockMs > 0) {
      const gpuCount = Math.max(1, Array.isArray(result.devices) ? result.devices.length : 1);
      const timePerNonceMs = probeWallClockMs / gpuCount;
      wh.gpuPowSamples = appendWorkerHwSample(wh.gpuPowSamples, timePerNonceMs);
    }
    workerHwHistory.set(entry.workerId, wh);
  }

  // Advance or break the worker's chain based on outcome.
  const workerChainEntry = workerChainState.get(entry.workerId) || {
    chainHead: null,
    chainIndex: 0,
    lastShareCount: -1,
    lastShareCheckTime: 0,
  };
  if (proofValid && ok) {
    const proofKey = probe.type === 'gpu' ? result.pixelHash || '' : result.proof || '';
    workerChainEntry.chainHead = proofKey;
    workerChainEntry.chainIndex = (workerChainEntry.chainIndex || 0) + 1;
    workerChainState.set(entry.workerId, workerChainEntry);
    // Successful submission resets the consecutive timeout counter.
    workerConsecutiveTimeouts.set(entry.workerId, 0);
  } else {
    // Break: reset chainHead so next probe uses a fresh random seed, but preserve share tracking.
    workerChainState.set(entry.workerId, {
      chainHead: null,
      chainIndex: workerChainEntry.chainIndex || 0,
      lastShareCount: workerChainEntry.lastShareCount,
      lastShareCheckTime: workerChainEntry.lastShareCheckTime,
    });
  }

  // Cross-check the claimed hardware against known tables and measured throughput.
  // If the hardware model is not in the coordinator's tables the power is set to 0
  // (no reward for that probe).  This prevents unknown/unrecognised hardware from
  // earning rewards — a tampered renderer cannot inflate hwPowerW either.
  let verifiedHwPowerW = 0;
  if (hardwareSpec && hardwareSpec.hwPowerW > 0) {
    let hardwareKnown = false;
    if (probe.type === 'cpu' || probe.type === 'memory') {
      hardwareKnown = hardwareSpec.cpuModel && getExpectedCpuSpeedOps(hardwareSpec.cpuModel) > 0;
    } else if (probe.type === 'gpu' || probe.type === 'gpu-pow') {
      const gpuModels = Array.isArray(hardwareSpec.gpuModels) ? hardwareSpec.gpuModels : [];
      hardwareKnown = gpuModels.length > 0 && gpuModels.every((m) => getGpuTdpW(m) > 0);
    } else if (probe.type === 'asic') {
      hardwareKnown = hardwareSpec.asicModel && getAsicPowerW(hardwareSpec.asicModel) > 0;
    }
    if (hardwareKnown) {
      if (probe.type === 'cpu' && hardwareSpec.measuredCpuOpsPerSec > 0) {
        const maxPlausibleW = Math.round(hardwareSpec.measuredCpuOpsPerSec / 10);
        if (hardwareSpec.hwPowerW <= maxPlausibleW) {
          verifiedHwPowerW = Math.round(hardwareSpec.hwPowerW);
        }
      } else if (probe.type === 'memory' || probe.type === 'gpu' || probe.type === 'gpu-pow' || probe.type === 'asic') {
        verifiedHwPowerW = Math.round(hardwareSpec.hwPowerW);
      }
    }
  }

  // Timing-consistent power cap: subtract verifier-measured network RTT from the
  // total wall-clock round trip to isolate pure GPU compute time, then verify
  // that hwPowerW × computeTimeMs is physically plausible.  The product is
  // roughly constant across GPU tiers (20k–30k W·ms for the fixed probe workload)
  // because energy = power × time is conserved.  Threshold at 50k (≈2× margin).
  if (verifiedHwPowerW > 0 && (probe.type === 'gpu' || probe.type === 'gpu-pow') && entry.workerId) {
    const smoothedRtt = getWorkerRtt(entry.workerId);
    if (smoothedRtt !== null && wallClockMs > smoothedRtt) {
      const MAX_GPU_PROBE_PRODUCT = 50_000;
      const computeTimeMs = wallClockMs - smoothedRtt;
      if (verifiedHwPowerW * computeTimeMs > MAX_GPU_PROBE_PRODUCT) {
        const cappedPower = Math.round(MAX_GPU_PROBE_PRODUCT / computeTimeMs);
        if (cappedPower > 0 && cappedPower < verifiedHwPowerW) {
          verifiedHwPowerW = cappedPower;
        }
      }
    }
  }

  const tag = ok ? 'PASS' : 'FAIL';

  // Hardware model fields for independent power verification by other peers.
  const receiptHwModels = {};
  if (probe.type === 'gpu' || probe.type === 'gpu-pow') {
    const gpuModels = Array.isArray(hardwareSpec && hardwareSpec.gpuModels) ? hardwareSpec.gpuModels : [];
    if (gpuModels.length > 0) {
      receiptHwModels.gpuModels = gpuModels.map((m) => String(m || '').trim()).filter(Boolean);
    }
  } else if (probe.type === 'cpu' || probe.type === 'memory') {
    if (hardwareSpec && hardwareSpec.cpuModel) {
      receiptHwModels.cpuModel = String(hardwareSpec.cpuModel).trim();
    }
  } else if (probe.type === 'asic') {
    if (hardwareSpec && hardwareSpec.asicModel) {
      receiptHwModels.asicModel = String(hardwareSpec.asicModel).trim();
    }
  }

  // Generate the canonical receipt payload so the HTTP handler can sign it with the
  // verifier's secp256k1 wallet key before returning it to the worker.
  let receipt = null;
  if (coordinatorIdentityKey) {
    receipt = normalizeProbeReceipt(
      {
        version: PROBE_RECEIPT_VERSION,
        probeId: entry.probe.id,
        verifierAddress: coordinatorIdentityKey,
        workerId: entry.workerId,
        type: probe.type,
        ok,
        wallClockMs,
        ts: Date.now(),
        roundId: Math.max(0, Math.round(Number(currentRoundId) || 0)),
        chainIndex: workerChainEntry.chainIndex,
        chainHead: workerChainEntry.chainHead,
        hwPowerW: verifiedHwPowerW,
        ...receiptHwModels,
      },
      { includeSignature: false },
    );
  }

  console.log(
    `[PeerProbe] ${probe.type} ${tag} wall=${wallClockMs}ms worker=${entry.workerId}${issues.length ? ' - ' + issues.join('; ') : ''}`,
  );

  // Derive network RTT and pure compute time for the probe log UI.
  const attestRttMs = entry.workerId ? getWorkerRtt(entry.workerId) : null;
  const attestComputeTimeMs = attestRttMs !== null && wallClockMs > attestRttMs ? wallClockMs - attestRttMs : null;

  // Record in coordinator attest history so the UI can display attested probes.
  peerAttestHistory.unshift({
    ts: Date.now(),
    id: probe.id,
    type: probe.type,
    workerId: entry.workerId,
    ok,
    wallClockMs,
    rttMs: attestRttMs,
    computeTimeMs: attestComputeTimeMs,
    chainIndex: workerChainEntry.chainIndex,
    pixelHash: probe.type === 'gpu' ? String(result.pixelHash || '') : '',
    proof: probe.type !== 'gpu' ? String(result.proof || '') : '',
    issues,
    loadPercent: result.loadPercent,
    version: result.version,
  });
  if (peerAttestHistory.length > PEER_ATTEST_HISTORY_MAX) peerAttestHistory.length = PEER_ATTEST_HISTORY_MAX;

  return {
    ok,
    proofValid,
    issues,
    wallClockMs,
    rttMs: attestRttMs,
    computeTimeMs: attestComputeTimeMs,
    workerId: entry.workerId,
    receipt,
    probeWallClockMs: result && typeof result.probeWallClockMs === 'number' ? result.probeWallClockMs : undefined,
    loadPercent: result.loadPercent,
    version: result.version,
  };
}

function getAttestHistory() {
  return { history: peerAttestHistory.map((e) => ({ ...e })) };
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

/**
 * Silently removes all in-flight peer-probe issuances for a given worker
 * without recording timeout entries.  Called when the worker's WebSocket
 * connection drops so that its orphaned probes do not appear as "timed out"
 * failures in the attestation log after the 180 s timeout expires.
 */
function cancelPendingPeerProbesForWorker(workerId) {
  const key = String(workerId || '').trim();
  if (!key) return;
  for (const [id, entry] of peerProbeIssuances) {
    if (entry.workerId === key) {
      peerProbeIssuances.delete(id);
    }
  }
  // Reset consecutive timeout counter so a reconnecting worker starts fresh.
  workerConsecutiveTimeouts.delete(key);
}

/**
 * Extends a probe's deadline when the worker signals that it is busy running
 * another probe.  Prevents false timeouts when probes arrive faster than the
 * worker can process them.  Limited to 3 extensions per probe to prevent abuse.
 */
function handleWorkerBusy(workerId, probeId) {
  const entry = peerProbeIssuances.get(probeId);
  if (entry && entry.workerId === workerId) {
    const busyCount = (entry._busyCount || 0) + 1;
    if (busyCount > 3) return;
    entry._busyCount = busyCount;
    entry.issuedAt = Date.now();
    console.log(
      `[PeerProbe] Worker ${workerId} busy, extended deadline for ${entry.probe.type} probe ${probeId} (${busyCount}/3)`,
    );
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
        ts: now,
        id: entry.probe.id,
        type: entry.probe.type,
        workerId: entry.workerId,
        ok: false,
        wallClockMs: now - entry.issuedAt,
        chainIndex: null,
        issues: ['probe timed out: worker received challenge but never submitted result'],
      });
      if (peerAttestHistory.length > PEER_ATTEST_HISTORY_MAX) peerAttestHistory.length = PEER_ATTEST_HISTORY_MAX;
      // Break the worker's chain on timeout so the next probe uses a fresh random seed.
      const wc = workerChainState.get(entry.workerId);
      if (wc) {
        workerChainState.set(entry.workerId, {
          chainHead: null,
          chainIndex: wc.chainIndex || 0,
          lastShareCount: wc.lastShareCount,
          lastShareCheckTime: wc.lastShareCheckTime,
        });
      }
      // Track consecutive timeouts so the coordinator can quarantine the worker.
      const to = (workerConsecutiveTimeouts.get(entry.workerId) || 0) + 1;
      workerConsecutiveTimeouts.set(entry.workerId, to);
    }
  }
}, 60_000);

module.exports = {
  coordinatorIdentityKey,
  peerAttestHistory,
  setCoordinatorIdentityKey,
  issuePeerProbe,
  submitPeerProbeResult,
  getAttestHistory,
  getPeerProbeHistory,
  cancelPendingPeerProbesForWorker,
  handleWorkerBusy,
};
