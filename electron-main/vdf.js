'use strict';

const crypto = require('crypto');
const { WesolowskiVDFParams, getPrecomputedDiscriminant } = require('crypto-vdf');

// Default VDF parameters for peer probes.
// Difficulty 2000 with 512-bit discriminant ≈ 1s solve, ~135ms verify on modern CPU.
const DEFAULT_VDF_DIFFICULTY = 2000;
const DEFAULT_VDF_DISCRIMINANT_BITS = 512;

// Supported discriminant sizes (precomputed by Rust GMP).
const SUPPORTED_DISCRIMINANT_BITS = new Set([256, 512, 1024, 2048]);

// Cache VDF instances per discriminant size to avoid re-instantiation.
const _vdfInstances = new Map();

function _getVdfInstance(discriminantSizeBits) {
  if (_vdfInstances.has(discriminantSizeBits)) {
    return _vdfInstances.get(discriminantSizeBits);
  }
  const instance = new WesolowskiVDFParams(discriminantSizeBits).new();
  _vdfInstances.set(discriminantSizeBits, instance);
  return instance;
}

function _getDiscriminant(discriminantSizeBits) {
  return getPrecomputedDiscriminant(discriminantSizeBits);
}

/**
 * Derive a deterministic VDF challenge from probe context.
 * The challenge binds the VDF to a specific probe, worker, and chain position
 * so the worker cannot pre-compute or replay VDF proofs across probes.
 */
function deriveVdfInput(probeId, workerId, chainIndex) {
  const raw = `wtc-vdf-v1|${probeId}|${workerId}|${chainIndex}`;
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * Estimate wall-clock time for a VDF with given parameters.
 * This is an empirical approximation used for timing caps when VDF replaces
 * the coordinator's wall clock.  Calibrated against crypto-vdf on modern CPUs.
 *
 * The relationship is roughly linear in difficulty for a given discriminant size.
 */
function estimateVdfTimingMs(steps, discriminantSizeBits) {
  if (!Number.isFinite(steps) || steps <= 0) return 0;
  // Baseline: difficulty 2000 at 512-bit ≈ 1000ms.
  // Scale linearly with difficulty; apply a discriminant-size multiplier.
  const BASE_DIFFICULTY = 2000;
  const BASE_TIME_MS = 1000;
  const DISC_MULTIPLIER = {
    256: 0.5,
    512: 1.0,
    1024: 3.0,
    2048: 12.0,
  };
  const multiplier = DISC_MULTIPLIER[discriminantSizeBits] || 1.0;
  return Math.round((steps / BASE_DIFFICULTY) * BASE_TIME_MS * multiplier);
}

/**
 * Evaluate a Wesolowski VDF.
 * @param {Object} opts
 * @param {Uint8Array} opts.challenge - VDF input (from deriveVdfInput)
 * @param {number} opts.difficulty - Number of sequential squarings
 * @param {number} opts.discriminantSizeBits - Bit length of discriminant (256/512/1024/2048)
 * @returns {Promise<{proof: string, output: string, steps: number}>}
 */
async function vdfEvaluate(opts) {
  let { challenge, difficulty, discriminantSizeBits } = opts || {};
  if (challenge === undefined && difficulty === undefined && discriminantSizeBits === undefined) {
    challenge = Uint8Array.from([0]);
    difficulty = DEFAULT_VDF_DIFFICULTY;
    discriminantSizeBits = DEFAULT_VDF_DISCRIMINANT_BITS;
  }
  const bits = Number(discriminantSizeBits) || DEFAULT_VDF_DISCRIMINANT_BITS;
  if (!SUPPORTED_DISCRIMINANT_BITS.has(bits)) {
    throw new Error(`Unsupported discriminant size: ${bits}`);
  }
  const d = Math.max(1, Math.floor(Number(difficulty) || DEFAULT_VDF_DIFFICULTY));
  const input = challenge instanceof Uint8Array ? challenge : Uint8Array.from(challenge || [0]);
  const discriminant = _getDiscriminant(bits);
  const vdf = _getVdfInstance(bits);

  const proofBytes = await vdf.solve(input, d, discriminant);
  const proof = Buffer.from(proofBytes).toString('hex');

  // Compute the VDF output (the iterated hash) for binding into the receipt.
  // The output is the SHA-256 of the proof — used as a compact identifier.
  const output = crypto.createHash('sha256').update(proofBytes).digest('hex');

  return { proof, output, steps: d, discriminantSizeBits: bits };
}

/**
 * Verify a Wesolowski VDF proof.
 * @param {Object} opts
 * @param {Uint8Array} opts.challenge - VDF input
 * @param {number} opts.difficulty - Number of squarings
 * @param {number} opts.discriminantSizeBits - Bit length of discriminant
 * @param {string} opts.proof - Hex-encoded proof
 * @returns {boolean} true if valid, false otherwise
 */
function vdfVerify(opts) {
  if (!opts || typeof opts !== 'object') return false;
  const { challenge, difficulty, discriminantSizeBits, proof } = opts;
  const bits = Number(discriminantSizeBits) || DEFAULT_VDF_DISCRIMINANT_BITS;
  if (!SUPPORTED_DISCRIMINANT_BITS.has(bits)) return false;
  const d = Math.max(1, Math.floor(Number(difficulty) || 0));
  if (d <= 0) return false;
  const input = challenge instanceof Uint8Array ? challenge : Uint8Array.from(challenge || [0]);
  if (typeof proof !== 'string' || proof.length === 0) return false;

  try {
    const proofBytes = Buffer.from(proof, 'hex');
    const discriminant = _getDiscriminant(bits);
    const vdf = _getVdfInstance(bits);
    vdf.verify(input, d, proofBytes, discriminant);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  DEFAULT_VDF_DIFFICULTY,
  DEFAULT_VDF_DISCRIMINANT_BITS,
  SUPPORTED_DISCRIMINANT_BITS,
  deriveVdfInput,
  estimateVdfTimingMs,
  vdfEvaluate,
  vdfVerify,
};
