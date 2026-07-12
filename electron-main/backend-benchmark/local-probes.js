'use strict';
const crypto = require('crypto');
const {
  verifyCpuProbe,
  verifyMemProbe,
  verifyGpuPowProbe,
  deriveProbeSeed,
  PROBE_CPU_DURATION_MS,
  PROBE_MEM_ENTRIES,
  PROBE_MEM_DURATION_MS,
  PROBE_GPU_POW_DIFFICULTY,
} = require('./benchmark-execution');
const { verifyX11Share, STRATUM_DIFFICULTY } = require('../local-stratum');

// --- Calibration probe system ------------------------------------------------
// There is no solo mining — mining always requires a peer connection and
// the coordinator sends push probes (see WebSocket push-probe coordinator
// in electron-main.js; max interval 60 s).  The local probe system below
// is used ONLY for initial hardware calibration / benchmarking, never
// during active mining.
//
// The renderer runs a small challenge workload and returns a proof hash +
// elapsed time.  The node re-runs the same deterministic computation to
// verify the hash (CPU + memory).  GPU-PoW probes use a native binary to
// search for a nonce — the proof IS the nonce (self-authenticating).
//
// Calibration probe schedule: 2-8 min random jitter (PROBE_INTERVAL_MIN/MS)._MAX/MS).
// Three types cycle randomly: 'cpu', 'memory', 'gpu-pow' (only if allowGpuWorkloads).
// If the renderer does not respond within PROBE_TIMEOUT_MS, it is recorded as a failure.
//
// SIZING RATIONALE:
//   For peer-verified probes the coordinator measures wall-clock time independently.
//   To make network latency (~50-150 ms RTT) and scheduler jitter a minor fraction,
//   computation should stay comfortably in the multi-hundred-ms to low-second range
//   even on weaker hardware. Values below intentionally bias toward longer runtimes:
//     CPU:    1000 ms fixed duration (duration-based probe)
//     Memory: 1000 ms fixed duration (duration-based probe)
//     GPU-PoW: native binary nonce search (difficulty 1024)
// ----------------------------------------------------------------------------------

// Probe cadence: uniformly random in [PROBE_INTERVAL_MIN_MS, PROBE_INTERVAL_MAX_MS].
// The next interval is re-rolled after every issued probe so a cheater cannot
// predict or schedule around the timing of upcoming challenges.
const PROBE_INTERVAL_MIN_MS = 2 * 60 * 1000; // earliest a new probe can fire (2 min)
const PROBE_INTERVAL_MAX_MS = 8 * 60 * 1000; // latest a new probe can fire (8 min)
const PROBE_INTERVAL_MS = 60_000; // max push-probe interval (60 s) — during mining only push probes fire, not local probes
const PROBE_TIMEOUT_MS = 100 * 1000; // 100 s — ~1.67× max push interval (0-60 s)
// Timing tolerance: allow up to PROBE_TIMING_SLACK x expected time before flagging.
// Peer-measured timing is tight; local self-timing is held to the same standard now
// that the chained-proof replay guard catches any attempt to pre-compute answers.
// ASIC probe: queries the cgminer-compatible API for the `summary` command to get
// the actual hashrate (TH/s) and compares against the expected rate for the model.
// The hashrate must be >= 50 % of the expected rate — drops below this indicate
// either a model mismatch (e.g. S9 claiming to be S21) or severe undervolting.

function _nextProbeIntervalMs() {
  return Math.round(PROBE_INTERVAL_MIN_MS + Math.random() * (PROBE_INTERVAL_MAX_MS - PROBE_INTERVAL_MIN_MS));
}

let probeState = {
  pending: null, // { id, type, params, issuedAt }
  lastIssuedAt: 0,
  nextIntervalMs: _nextProbeIntervalMs(), // randomised per-probe; re-rolled on each issue
  history: [], // last 20 results
  consecutiveFailures: 0,
  hardwareSpec: null, // { measuredCpuOpsPerSec, measuredMemLatencyNs, allowGpuWorkloads }
  // Chained-probe continuity — each probe's seed derives from the previous proof so a
  // worker cannot answer future probes without having run every prior one in sequence.
  chainHead: null, // last verified proof hash (null = genesis or after a break)
  chainIndex: 0, // count of probes in the current unbroken chain
  chainBroken: false, // set when a probe times out or fails
  // Cross-probe ASIC share monitoring: stratum share count from last probe.
  lastShareCount: -1,
  lastShareCheckTime: 0,
};

// Called from electron-main after a benchmark run so probes use measured values.
function setProbeHardwareSpec(spec) {
  probeState.hardwareSpec = spec && typeof spec === 'object' ? { ...spec } : null;
}

// Called from electron-main when the hardware load slider changes so local probe
// timing accounts for CPU contention from mining threads.
let _probeLoadPercent = 100;
function setProbeLoadPercent(pct) {
  _probeLoadPercent = Math.max(0, Math.min(100, Number(pct) || 100));
}

// Called from electron-main after the ASIC hashrate benchmark to set the expected
// hashrate for the declared model so periodic ASIC probes can compare against it.
function setAsicHardwareSpec(spec) {
  if (spec && typeof spec === 'object') {
    probeState.hardwareSpec = probeState.hardwareSpec || {};
    probeState.hardwareSpec.asicHashrateTHs = Number(spec.asicHashrateTHs) || 0;
    probeState.hardwareSpec.asicModel = String(spec.asicModel || '');
  }
}

// Called from mining loop in renderer (via IPC) — returns the next probe to run,
// or null if it is too soon / no probe is currently pending.
function getPendingProbe() {
  const now = Date.now();

  // Expire timed-out probes.
  if (probeState.pending && now - probeState.pending.issuedAt > PROBE_TIMEOUT_MS) {
    probeState.consecutiveFailures += 1;
    probeState.history.unshift({
      id: probeState.pending.id,
      type: probeState.pending.type,
      ok: false,
      issues: ['probe timed out'],
      wallClockMs: now - probeState.pending.issuedAt,
      ts: now,
    });
    if (probeState.history.length > 20) probeState.history.length = 20;
    console.warn(`[Probe] ${probeState.pending.type} probe timed out (id=${probeState.pending.id})`);
    probeState.chainBroken = true;
    probeState.chainHead = null; // break the chain; next probe starts a new segment
    probeState.pending = null;
  }

  // Return existing pending probe if still in-flight.
  if (probeState.pending) return { ...probeState.pending };

  // Not yet time for a new probe.
  if (now - probeState.lastIssuedAt < probeState.nextIntervalMs) return null;

  // Choose type at random; include 'gpu-pow' only when hardware spec allows it.
  // Include 'asic' only when the hardware spec has an expected hashrate for it.
  const allowGpu = !!(probeState.hardwareSpec && probeState.hardwareSpec.allowGpuWorkloads);
  const hasAsic = !!(probeState.hardwareSpec && probeState.hardwareSpec.asicHashrateTHs > 0);
  const types = ['cpu', 'memory', ...(allowGpu ? ['gpu-pow'] : []), ...(hasAsic ? ['asic'] : [])];
  const type = types[Math.floor(Math.random() * types.length)];
  // Chain derivation: next seed is deterministically derived from the previous proof so
  // the worker cannot pre-compute answers without executing every prior probe in sequence.
  const seed =
    probeState.chainHead !== null
      ? deriveProbeSeed(probeState.chainHead, probeState.chainIndex) || 1
      : crypto.randomBytes(4).readUInt32BE(0) || 1;

  const probe = {
    id: `${now.toString(36)}-${seed.toString(16)}`,
    type,
    issuedAt: now,
    params:
      type === 'cpu'
        ? { seed, durationMs: PROBE_CPU_DURATION_MS }
        : type === 'memory'
          ? { arraySeed: seed, durationMs: PROBE_MEM_DURATION_MS, entries: PROBE_MEM_ENTRIES }
          : type === 'gpu-pow'
            ? { seed, difficulty: PROBE_GPU_POW_DIFFICULTY }
            : /* asic */ { minShares: 3 },
  };

  // ASIC liveness challenge: generate a random 32-byte prevHash that the worker
  // must inject into the local stratum — prevents pre-mined shares.
  if (type === 'asic') {
    probe.params.challengePrevHash = crypto.randomBytes(32).toString('hex');
  }

  probeState.pending = probe;
  probeState.lastIssuedAt = now;
  probeState.nextIntervalMs = _nextProbeIntervalMs(); // randomise next window immediately
  console.log(
    `[Probe] Issued ${type} probe id=${probe.id} (next in ~${Math.round(probeState.nextIntervalMs / 1000)}s)`,
  );
  return probe;
}

// Called when the renderer returns a completed probe.
// peerTimed=true means wallClockMs was measured by the coordinator (trusted external clock).
async function submitProbeResult(result, _peerTimed = false) {
  if (!result || !probeState.pending) {
    return { ok: false, issues: ['no pending probe'] };
  }
  if (result.id !== probeState.pending.id) {
    return { ok: false, issues: ['probe id mismatch'] };
  }

  const probe = probeState.pending;
  const wallClockMs = Date.now() - probe.issuedAt;
  probeState.pending = null;

  const issues = [];
  let proofValid = false;

  if (probe.type === 'cpu') {
    const cpuIters = result.iterations | 0;
    if (cpuIters <= 0) {
      issues.push('cpu probe: no iterations reported');
      proofValid = false;
    } else {
      proofValid = await verifyCpuProbe(probe.params.seed, cpuIters, result.proof || '');
      if (!proofValid) {
        issues.push('cpu probe: proof hash mismatch — computation was tampered or skipped');
      }
    }
  } else if (probe.type === 'memory') {
    const memIters = result.iterations | 0;
    if (memIters <= 0) {
      issues.push('memory probe: no iterations reported');
      proofValid = false;
    } else {
      proofValid = await verifyMemProbe(probe.params.arraySeed, memIters, result.proof || '');
      if (!proofValid) {
        issues.push('memory probe: proof hash mismatch — computation was tampered or skipped');
      }
    }
  } else if (probe.type === 'gpu-pow') {
    const devices = Array.isArray(result.devices) ? result.devices : [];
    if (devices.length === 0) {
      proofValid = false;
      issues.push('gpu-pow probe: no device results');
    } else {
      let allValid = true;
      for (const d of devices) {
        if (d.nonce == null) {
          allValid = false;
          issues.push(`gpu-pow probe: device ${d.deviceIndex} missing nonce`);
          break;
        }
        const nonce = Number(d.nonce);
        if (!Number.isFinite(nonce)) {
          allValid = false;
          issues.push(`gpu-pow probe: device ${d.deviceIndex} invalid nonce: ${d.nonce}`);
          break;
        }
        const v = verifyGpuPowProbe(probe.params.seed, d.deviceIndex, nonce, probe.params.difficulty);
        if (!v.passes) {
          allValid = false;
          issues.push(
            `gpu-pow probe: device ${d.deviceIndex} hash ${v.hash16} >= difficulty ${probe.params.difficulty} (nonce=${nonce})`,
          );
          break;
        }
      }
      proofValid = allValid;
      if (allValid && wallClockMs < 10) issues.push(`gpu-pow probe suspiciously fast: ${wallClockMs}ms`);
    }
  } else if (probe.type === 'asic') {
    const shares = Array.isArray(result.shares) ? result.shares : [];
    const expectedTHs = probeState.hardwareSpec ? probeState.hardwareSpec.asicHashrateTHs : 0;
    if (shares.length === 0) {
      proofValid = false;
      issues.push('asic probe: no shares returned from stratum — ASIC not hashing');
    } else {
      let allValid = true;
      for (let i = 0; i < shares.length; i++) {
        const s = shares[i];
        if (!s.headerHex || !s.hashHex || !s.nbitsHex) {
          allValid = false;
          issues.push(`asic probe: share ${i} missing header/hash/nbits`);
          continue;
        }
        const verified = await verifyX11Share(s.headerHex, s.hashHex, s.nbitsHex);
        if (!verified) {
          allValid = false;
          issues.push(`asic probe: share ${i} X11 verification failed`);
        } else if (probe.params && probe.params.challengePrevHash) {
          const headerBuf = Buffer.from(s.headerHex, 'hex');
          const sharePrevHashLE = headerBuf.subarray(4, 36);
          const sharePrevHashBE = Buffer.from(sharePrevHashLE).reverse().toString('hex');
          if (sharePrevHashBE !== probe.params.challengePrevHash) {
            allValid = false;
            issues.push(`asic probe: share ${i} prevHash does not match liveness challenge`);
          }
        } else if (probe.issuedAt && s.timestamp && s.timestamp < probe.issuedAt - 5000) {
          allValid = false;
          issues.push(`asic probe: share ${i} timestamp ${s.timestamp} is before probe issuance`);
        }
      }
      proofValid = allValid;
      if (proofValid && expectedTHs > 0 && shares.length > 0) {
        const expectedMs = ((shares.length * STRATUM_DIFFICULTY * 4294967296) / (expectedTHs * 1e12)) * 1000;
        if (wallClockMs > 0 && wallClockMs < expectedMs * 0.1) {
          issues.push(
            `asic probe suspiciously fast: ${Math.round(wallClockMs)}ms for ${shares.length} shares ` +
              `(expected ~${Math.round(expectedMs)}ms at ${expectedTHs.toFixed(4)} TH/s, diff=${STRATUM_DIFFICULTY})`,
          );
        }
      }
      if (expectedTHs > 0 && result.shareCount >= 0 && probeState.lastShareCount >= 0) {
        const delta = result.shareCount - probeState.lastShareCount;
        const elapsedMs = Date.now() - probeState.lastShareCheckTime;
        if (elapsedMs > 20000 && delta < 3) {
          const expectedDelta = ((elapsedMs / 1000) * (expectedTHs * 1e12)) / (STRATUM_DIFFICULTY * 4294967296);
          if (expectedDelta > 5 && delta < expectedDelta * 0.1) {
            issues.push(
              `asic probe: only ${delta} shares since last probe in ${(elapsedMs / 1000).toFixed(0)}s ` +
                `(expected ~${Math.round(expectedDelta)}) — ASIC may have been idle between probes`,
            );
          }
        }
      }
      if (result.shareCount >= 0) {
        probeState.lastShareCount = result.shareCount;
        probeState.lastShareCheckTime = Date.now();
      }
    }
    const bestHash = shares.length > 0 ? shares[0].hashHex || '' : '';
    result.proof = result.proof || `${shares.length}:${bestHash.slice(0, 16)}`;
  }

  const ok = issues.length === 0;
  if (!ok) probeState.consecutiveFailures += 1;
  else probeState.consecutiveFailures = 0;

  // Advance or break the chain based on outcome.
  if (ok && proofValid) {
    const proofKey = result.proof || '';
    probeState.chainHead = proofKey;
    probeState.chainIndex += 1;
  } else {
    probeState.chainBroken = true;
    probeState.chainHead = null;
  }

  probeState.history.unshift({
    id: probe.id,
    type: probe.type,
    ok,
    issues,
    wallClockMs,
    ts: Date.now(),
    chainIndex: probeState.chainIndex,
    chainHead: probeState.chainHead,
    loadPercent: _probeLoadPercent,
  });
  if (probeState.history.length > 20) probeState.history.length = 20;

  const tag = ok ? 'PASS' : 'FAIL';
  console.log(
    `[Probe] ${probe.type} ${tag} wall=${wallClockMs}ms chain=${probeState.chainIndex}${probeState.chainBroken ? '(broken)' : ''}${issues.length ? ' - ' + issues.join('; ') : ''}`,
  );
  return {
    ok,
    proofValid,
    issues,
    wallClockMs,
    consecutiveFailures: probeState.consecutiveFailures,
    chainHead: probeState.chainHead,
    chainIndex: probeState.chainIndex,
    chainBroken: probeState.chainBroken,
    loadPercent: _probeLoadPercent,
  };
}

function getProbeHistory() {
  return {
    history: [...probeState.history],
    consecutiveFailures: probeState.consecutiveFailures,
    hasPending: !!probeState.pending,
    chainHead: probeState.chainHead,
    chainIndex: probeState.chainIndex,
    chainBroken: probeState.chainBroken,
  };
}

// Returns the standalone (local) probe chain state so settlement can use the
// backend's own tracked values instead of trusting renderer-supplied values.
function getLocalProbeChain() {
  return {
    chainHead: probeState.chainHead,
    chainIndex: probeState.chainIndex,
    chainBroken: probeState.chainBroken,
  };
}

module.exports = {
  probeState,
  PROBE_TIMEOUT_MS,
  PROBE_INTERVAL_MS,
  setProbeHardwareSpec,
  setProbeLoadPercent,
  setAsicHardwareSpec,
  getPendingProbe,
  submitProbeResult,
  getProbeHistory,
  getLocalProbeChain,
};
