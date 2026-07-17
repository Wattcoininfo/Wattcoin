'use strict';

const crypto = require('crypto');

// ── Burn proof constants ──────────────────────────────────────────────────
const BURN_PROOF_STEP = 256;

// Burn timing bounds: SHA-256 takes ~200ns+ per iteration on modern CPUs.
const MIN_BURN_NS_PER_OP = 200;
const MAX_BURN_NS_PER_OP = 15000; // fallback when opsPerMs is unknown
const BURN_OVERHEAD_NS_PER_OP = 35000; // Buffer alloc/copy overhead per iteration

// Plausibility tolerance factors: actual ops must be between
// expectedOps * LOW and expectedOps * HIGH.
// LOW is generous because the benchmarked opsPerMs is measured at the
// current hardware load, but actual mining throughput can vary due to
// OS scheduling, GC pauses, and I/O contention.
const PLAUSIBILITY_LOW_FACTOR = 0.7;
const PLAUSIBILITY_HIGH_FACTOR = 1.2;

const MIN_BURN_MS = 8;

// ── Validation helpers ───────────────────────────────────────────────────

function isValidHex32(state) {
  return typeof state === 'string' && state.length === 64 && /^[0-9a-f]{64}$/i.test(state);
}

function isValidOps(ops) {
  return Number.isInteger(ops) && ops >= 1000;
}

// ── Burn proof verification ───────────────────────────────────────────────
// Verifies that the burn loop was computed correctly:
//   1. Derive burnStartState = SHA-256(prevState ‖ seed)
//   2. Re-compute: state = SHA-256(state ‖ LE32(i) ‖ seed) for i in 0..ops
//   3. Record intermediate states every BURN_PROOF_STEP iterations
//   4. Verify proof = SHA-256(concatenated intermediate states)
//   5. Verify final state matches burnResult
// Yields to the event loop every VERIFY_CHUNK_SIZE iterations to keep the
// Electron renderer responsive during large proof verifications.
const VERIFY_CHUNK_SIZE = 50_000;
function verifyBurnProof(prevStateHex, ops, seedHex, burnResultHex, proofHex) {
  if (!isValidHex32(prevStateHex)) return { ok: false, reason: 'invalid_prev_state' };
  if (!isValidOps(ops)) return { ok: false, reason: 'invalid_ops' };
  if (!isValidHex32(seedHex)) return { ok: false, reason: 'invalid_seed' };
  if (!isValidHex32(burnResultHex)) return { ok: false, reason: 'invalid_burn_result' };
  if (!isValidHex32(proofHex)) return { ok: false, reason: 'invalid_proof' };

  const prevState = Buffer.from(prevStateHex, 'hex');
  const seed = Buffer.from(seedHex, 'hex');

  // 1. Derive burn start state: SHA-256(prevState ‖ seed)
  const startInput = Buffer.alloc(64);
  prevState.copy(startInput, 0);
  seed.copy(startInput, 32);
  let state = crypto.createHash('sha256').update(startInput).digest();

  // 2. Re-compute the burn loop, recording intermediate states
  const intermediates = [];
  let i = 0;
  const runChunk = (deadline) => {
    while (i < ops && performance.now() < deadline) {
      const end = Math.min(i + VERIFY_CHUNK_SIZE, ops);
      while (i < end && performance.now() < deadline) {
        const input = Buffer.alloc(68);
        state.copy(input, 0);
        input.writeUInt32LE(i >>> 0, 32);
        seed.copy(input, 36);
        state = crypto.createHash('sha256').update(input).digest();
        if (i % BURN_PROOF_STEP === 0) {
          intermediates.push(state);
        }
        i++;
      }
    }
    return i >= ops;
  };

  const chunkedVerify = () =>
    new Promise((resolve) => {
      const step = () => {
        if (runChunk(performance.now() + 10)) {
          resolve();
        } else {
          setImmediate(step);
        }
      };
      step();
    });

  return chunkedVerify().then(() => {
    // 3. Verify final state matches burnResult
    if (state.toString('hex') !== burnResultHex) {
      return { ok: false, reason: 'burn_result_mismatch' };
    }

    // 4. Verify proof
    const expectedProof =
      intermediates.length > 0
        ? crypto.createHash('sha256').update(Buffer.concat(intermediates)).digest('hex')
        : crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');
    if (expectedProof !== proofHex) {
      return { ok: false, reason: 'burn_proof_invalid' };
    }

    return { ok: true };
  });
}

// ── Burn timing verification ──────────────────────────────────────────────
// Verifies that the reported burnMs is consistent with the claimed ops count.
// When opsPerMs is known, uses dynamic bounds: pure hash time + per-op overhead.
function verifyBurnMs(burnMs, ops, opsPerMs) {
  const minBurnMs = (ops * MIN_BURN_NS_PER_OP) / 1_000_000;
  let maxBurnMs;
  if (opsPerMs && opsPerMs > 0) {
    const nsPerOp = 1e6 / opsPerMs + BURN_OVERHEAD_NS_PER_OP;
    maxBurnMs = (ops * nsPerOp) / 1e6;
  } else {
    maxBurnMs = (ops * MAX_BURN_NS_PER_OP) / 1_000_000;
  }
  if (burnMs < minBurnMs) return { ok: false, reason: 'burn_too_fast' };
  if (burnMs > maxBurnMs) return { ok: false, reason: 'burn_too_slow' };
  return { ok: true };
}

// ── Seed proof verification (coordinator-side) ────────────────────────────
// Verifies a worker's proof of work done with a coordinator-issued seed.
// The proof includes: prevState, startState, endState, totalOps, burnMs,
// intermediateProof, and a window of tokens for chain verification.
async function verifySeedProof(proof, seedHex, expectedMinOps, expectedMaxOps, opsPerMs) {
  if (!proof) return { ok: false, reason: 'no_proof' };
  if (!isValidHex32(seedHex)) return { ok: false, reason: 'invalid_seed' };

  const { startState, endState, totalOps, burnMs, intermediateProof } = proof;

  // Validate fields
  if (!isValidHex32(startState)) return { ok: false, reason: 'invalid_start_state' };
  if (!isValidHex32(endState)) return { ok: false, reason: 'invalid_end_state' };
  if (!isValidOps(totalOps)) return { ok: false, reason: 'invalid_ops' };
  if (!isValidHex32(intermediateProof)) return { ok: false, reason: 'invalid_intermediate_proof' };

  // Verify burn timing
  if (burnMs !== undefined && burnMs !== null) {
    const timing = verifyBurnMs(Number(burnMs) || 0, totalOps, opsPerMs);
    if (!timing.ok) return { ok: false, reason: timing.reason };
  }

  // Verify the burn proof: re-compute from startState
  const proofResult = await verifyBurnProof(startState, totalOps, seedHex, endState, intermediateProof);
  if (!proofResult.ok) return { ok: false, reason: proofResult.reason };

  // Verify ops are within expected range
  if (expectedMinOps !== undefined && totalOps < expectedMinOps) {
    return { ok: false, reason: 'ops_below_minimum', expectedMinOps, actualOps: totalOps };
  }
  if (expectedMaxOps !== undefined && totalOps > expectedMaxOps) {
    return { ok: false, reason: 'ops_above_maximum', expectedMaxOps, actualOps: totalOps };
  }

  return { ok: true, totalOps, burnMs: Number(burnMs) || 0 };
}

// ── Plausibility check ────────────────────────────────────────────────────
// Checks whether a proof's ops count is plausible given the hardware's
// known capability and the elapsed time.
function checkProofPlausibility(totalOps, elapsedMs, hardwareSpec, claimedLoad) {
  if (!hardwareSpec || !hardwareSpec.opsPerMs) {
    return { ok: false, reason: 'no_hardware_spec', creditedOps: 0 };
  }

  const _load = Math.max(0, Math.min(1, Number(claimedLoad) || 1));
  const effectiveOpsPerMs = Math.max(1, Number(hardwareSpec.opsPerMs) || 1);

  // expectedOps = burn time × benchmarked throughput (measured at current load).
  // The `load` parameter is not used here — energy is credited via
  // duty-cycle measurement in ledger-ipc.js instead.
  const desiredBurnMs = Math.max(MIN_BURN_MS, elapsedMs);
  const expectedOps = Math.max(1000, Math.round(desiredBurnMs * effectiveOpsPerMs));

  const creditedOps = Math.min(totalOps, expectedOps);
  if (totalOps < 1000) {
    return { ok: false, reason: 'ops_below_minimum', expectedOps, actualOps: totalOps, creditedOps: 0 };
  }
  if (totalOps < expectedOps * PLAUSIBILITY_LOW_FACTOR) {
    return { ok: false, reason: 'ops_too_low', expectedOps, actualOps: totalOps, creditedOps: 0 };
  }
  if (totalOps > expectedOps * PLAUSIBILITY_HIGH_FACTOR) {
    return { ok: false, reason: 'ops_too_high', expectedOps, actualOps: totalOps, creditedOps: 0 };
  }
  return { ok: true, reason: '', expectedOps, actualOps: totalOps, creditedOps };
}

// ── Energy calculation ────────────────────────────────────────────────────
// Computes energy credit (Wh) from verified proof and hardware specs.
function computeEnergyWh(hardwareType, proof, hardwareSpec) {
  const ops = Number(proof.totalOps) || 0;
  const burnMs = Number(proof.burnMs) || 0;
  const elapsedMs = Number(proof.elapsedMs) || burnMs || 0;

  switch (hardwareType) {
    case 'cpu': {
      if (!hardwareSpec || !hardwareSpec.opsPerMs || !hardwareSpec.tdpW) return 0;
      const energyPerOp = hardwareSpec.tdpW / (hardwareSpec.opsPerMs * 1000);
      return (ops * energyPerOp) / 3600;
    }
    case 'gpu': {
      if (!hardwareSpec || !hardwareSpec.tdpW) return 0;
      return (hardwareSpec.tdpW * (burnMs / 1000)) / 3600;
    }
    case 'memory': {
      if (!hardwareSpec || !hardwareSpec.opsPerMs || !hardwareSpec.tdpW) return 0;
      const energyPerOp = hardwareSpec.tdpW / (hardwareSpec.opsPerMs * 1000);
      return (ops * energyPerOp) / 3600;
    }
    case 'asic': {
      if (!hardwareSpec || !hardwareSpec.powerW) return 0;
      return (hardwareSpec.powerW * (elapsedMs / 1000)) / 3600;
    }
    default:
      return 0;
  }
}

module.exports = {
  verifyBurnProof,
  verifyBurnMs,
  verifySeedProof,
  checkProofPlausibility,
  computeEnergyWh,
  isValidHex32,
  isValidOps,
  BURN_PROOF_STEP,
  MIN_BURN_NS_PER_OP,
  MAX_BURN_NS_PER_OP,
  PLAUSIBILITY_LOW_FACTOR,
  PLAUSIBILITY_HIGH_FACTOR,
  MIN_BURN_MS,
};
