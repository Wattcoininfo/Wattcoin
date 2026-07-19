'use strict';

const crypto = require('crypto');
const {
  verifySeedProof,
  checkProofPlausibility,
  computeEnergyWh,
  isValidHex32,
  MIN_BURN_MS,
} = require('./token-verification');
const { getMinOpsPerMs, getGpuMinOpsPerMs } = require('./hardware-tables.cjs');

const _SEED_HEX_LENGTH = 64;

function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function createSeedAssignmentManager({
  _getCpuCoordinatorSeed,
  setCpuCoordinatorSeed,
  _getGpuCoordinatorSeed,
  setGpuCoordinatorSeed,
  getCpuSeedProofs,
  getGpuSeedProofs,
  hwAuthority,
  loadPowerCurve,
  interpolatePower,
  console,
}) {
  let _lastSeedAssignedAt = 0;
  let _lastSeedDurationMs = 0;
  const _historicalProofs = [];

  function assignNewSeed() {
    const seed = generateSeed();
    const now = Date.now();
    if (_lastSeedAssignedAt > 0) {
      _lastSeedDurationMs = now - _lastSeedAssignedAt;
    }
    _lastSeedAssignedAt = now;
    if (typeof setCpuCoordinatorSeed === 'function') setCpuCoordinatorSeed(seed);
    if (typeof setGpuCoordinatorSeed === 'function') setGpuCoordinatorSeed(seed);
    return seed;
  }

  function setCpuSeed(hexSeed) {
    const now = Date.now();
    if (_lastSeedAssignedAt > 0) {
      _lastSeedDurationMs = now - _lastSeedAssignedAt;
    }
    _lastSeedAssignedAt = now;
    if (typeof setCpuCoordinatorSeed === 'function') setCpuCoordinatorSeed(hexSeed);
  }

  function setGpuSeed(hexSeed) {
    if (typeof setGpuCoordinatorSeed === 'function') setGpuCoordinatorSeed(hexSeed);
  }

  function assignNewCpuSeed() {
    const seed = generateSeed();
    const now = Date.now();
    _lastSeedAssignedAt = now;
    if (typeof setCpuCoordinatorSeed === 'function') setCpuCoordinatorSeed(seed);
    return seed;
  }

  function assignNewGpuSeed() {
    const seed = generateSeed();
    if (typeof setGpuCoordinatorSeed === 'function') setGpuCoordinatorSeed(seed);
    return seed;
  }

  function collectCpuProofs() {
    const proofs = typeof getCpuSeedProofs === 'function' ? getCpuSeedProofs() : new Map();
    const collected = [];
    for (const [, proof] of proofs) {
      collected.push({ ...proof, type: 'cpu' });
    }
    return collected;
  }

  function collectGpuProofs() {
    const proofs = typeof getGpuSeedProofs === 'function' ? getGpuSeedProofs() : new Map();
    const collected = [];
    for (const [, proof] of proofs) {
      collected.push({ ...proof, type: 'gpu' });
    }
    return collected;
  }

  // Resolve the measured power (W) at a given claimed load from the power curve.
  // Returns 0 if no curve is available — callers must not fall back to TDP.
  function _powerAtLoad(claimedLoad) {
    try {
      const curve = typeof loadPowerCurve === 'function' ? loadPowerCurve() : null;
      if (curve && Array.isArray(curve.steps) && curve.steps.length >= 2 && curve.measuredWithSensors) {
        const loadPct = Math.max(0, Math.min(100, (Number(claimedLoad) || 0) * 100));
        return typeof interpolatePower === 'function' ? interpolatePower(curve, loadPct) : 0;
      }
    } catch (_) {
      /* best-effort */
    }
    return 0;
  }

  async function verifyCpuProofs(proofs, elapsedMs, cpuModel, claimedLoad, overridePowerW) {
    if (!Array.isArray(proofs) || proofs.length === 0) {
      console.log(
        `[SeedManager] CPU proofs: none collected (cpuModel=${cpuModel || 'null'} opsPerMs=${(hwAuthority && hwAuthority.sha256OpsPerMs) || 0})`,
      );
      return { ok: true, totalEnergyWh: 0, proofs: 0, reason: 'no_proofs' };
    }
    const tableOpsPerMs = cpuModel ? getMinOpsPerMs(cpuModel) : 0;
    const opsPerMs = hwAuthority && hwAuthority.sha256OpsPerMs > 0 ? hwAuthority.sha256OpsPerMs : tableOpsPerMs;
    const powerW =
      typeof overridePowerW === 'number' && overridePowerW > 0 ? overridePowerW : _powerAtLoad(claimedLoad);
    console.log(
      `[SeedManager] CPU proofs: count=${proofs.length} opsPerMs=${opsPerMs} powerW=${powerW.toFixed(2)} load=${claimedLoad} elapsedMs=${elapsedMs}`,
    );
    let verifiedCount = 0;
    let rejectReasons = {};
    for (let i = 0; i < proofs.length; i++) {
      const proof = proofs[i];
      if (i > 0) await new Promise((r) => setImmediate(r));
      const seedHex = String(proof.seed || '');
      if (!isValidHex32(seedHex)) {
        rejectReasons['invalid_seed'] = (rejectReasons['invalid_seed'] || 0) + 1;
        continue;
      }
      const result = await verifySeedProof(proof, seedHex, undefined, undefined, opsPerMs);
      if (!result.ok) {
        rejectReasons[result.reason] = (rejectReasons[result.reason] || 0) + 1;
        continue;
      }
      const effectiveElapsedMs = Math.max(MIN_BURN_MS, result.burnMs || 0);
      const plausibility = checkProofPlausibility(
        result.totalOps,
        effectiveElapsedMs,
        {
          opsPerMs,
        },
        claimedLoad,
      );
      if (!plausibility.ok) {
        console.log(
          `[SeedManager] CPU proof implausible: ${plausibility.reason} (actualOps=${plausibility.actualOps} expectedOps=${plausibility.expectedOps} burnMs=${effectiveElapsedMs} opsPerMs=${opsPerMs} load=${claimedLoad})`,
        );
        rejectReasons[plausibility.reason] = (rejectReasons[plausibility.reason] || 0) + 1;
        continue;
      }
      verifiedCount++;
    }
    if (verifiedCount === 0 && proofs.length > 0) {
      console.log(
        `[SeedManager] CPU ALL REJECTED: ${JSON.stringify(rejectReasons)} (opsPerMs=${opsPerMs} powerW=${powerW.toFixed(2)})`,
      );
    }
    const totalEnergyWh = verifiedCount > 0 ? computeEnergyWh('cpu', elapsedMs, powerW) : 0;
    return {
      ok: true,
      totalEnergyWh,
      proofs: verifiedCount,
      total: proofs.length,
    };
  }

  async function verifyGpuProofs(proofs, elapsedMs, gpuModel, claimedLoad, overridePowerW) {
    if (!Array.isArray(proofs) || proofs.length === 0) {
      console.log(`[SeedManager] GPU proofs: none collected (gpuModel=${gpuModel || 'null'})`);
      return { ok: true, totalEnergyWh: 0, proofs: 0, reason: 'no_proofs' };
    }
    const tableOpsPerMs = gpuModel ? getGpuMinOpsPerMs(gpuModel) : 0;
    const opsPerMs = hwAuthority && hwAuthority.gpuOpsPerMs > 0 ? hwAuthority.gpuOpsPerMs : tableOpsPerMs;
    const powerW =
      typeof overridePowerW === 'number' && overridePowerW > 0 ? overridePowerW : _powerAtLoad(claimedLoad);
    console.log(
      `[SeedManager] GPU proofs: count=${proofs.length} opsPerMs=${opsPerMs} powerW=${powerW.toFixed(2)} load=${claimedLoad} elapsedMs=${elapsedMs}`,
    );
    let verifiedCount = 0;
    let rejectReasons = {};
    for (let i = 0; i < proofs.length; i++) {
      const proof = proofs[i];
      if (i > 0) await new Promise((r) => setImmediate(r));
      const seedHex = String(proof.seed || '');
      if (!isValidHex32(seedHex)) {
        rejectReasons['invalid_seed'] = (rejectReasons['invalid_seed'] || 0) + 1;
        continue;
      }
      const result = await verifySeedProof(proof, seedHex);
      if (!result.ok) {
        rejectReasons[result.reason] = (rejectReasons[result.reason] || 0) + 1;
        continue;
      }
      const effectiveElapsedMs = Math.max(MIN_BURN_MS, (result.burnMs || 0) / (claimedLoad || 1));
      const plausibility = checkProofPlausibility(
        result.totalOps,
        effectiveElapsedMs,
        {
          opsPerMs,
        },
        claimedLoad,
      );
      if (!plausibility.ok) {
        console.log(
          `[SeedManager] GPU proof implausible: ${plausibility.reason} (actualOps=${plausibility.actualOps} expectedOps=${plausibility.expectedOps} burnMs=${effectiveElapsedMs} opsPerMs=${opsPerMs} load=${claimedLoad})`,
        );
        rejectReasons[plausibility.reason] = (rejectReasons[plausibility.reason] || 0) + 1;
        continue;
      }
      verifiedCount++;
    }
    if (verifiedCount === 0 && proofs.length > 0) {
      console.log(
        `[SeedManager] GPU ALL REJECTED: ${JSON.stringify(rejectReasons)} (opsPerMs=${opsPerMs} powerW=${powerW.toFixed(2)})`,
      );
    }
    const totalEnergyWh = verifiedCount > 0 ? computeEnergyWh('gpu', elapsedMs, powerW) : 0;
    return {
      ok: true,
      totalEnergyWh,
      proofs: verifiedCount,
      total: proofs.length,
    };
  }

  async function collectAndVerifyAll({ elapsedMs, cpuModel, gpuModel, claimedLoad, overridePowerW } = {}) {
    const effectiveElapsed = Math.max(1, Number(elapsedMs) || 60000);
    const cpuProofs = collectCpuProofs();
    const gpuProofs = collectGpuProofs();
    const cpuResult = await verifyCpuProofs(cpuProofs, effectiveElapsed, cpuModel, claimedLoad, overridePowerW);
    const gpuResult = await verifyGpuProofs(gpuProofs, effectiveElapsed, gpuModel, claimedLoad, overridePowerW);
    const totalEnergyWh = Math.max(0, cpuResult.totalEnergyWh + gpuResult.totalEnergyWh);
    const summary = {
      ok: true,
      totalEnergyWh,
      cpu: { verified: cpuResult.proofs, total: cpuResult.total, energyWh: cpuResult.totalEnergyWh },
      gpu: { verified: gpuResult.proofs, total: gpuResult.total, energyWh: gpuResult.totalEnergyWh },
      elapsedMs: effectiveElapsed,
    };
    _historicalProofs.push({ ts: Date.now(), summary });
    if (_historicalProofs.length > 100) _historicalProofs.shift();
    return summary;
  }

  function getLastSeedInfo() {
    return {
      assignedAt: _lastSeedAssignedAt,
      durationMs: _lastSeedDurationMs,
    };
  }

  function getHistory() {
    return _historicalProofs.slice();
  }

  return {
    generateSeed,
    assignNewSeed,
    setCpuSeed,
    setGpuSeed,
    assignNewCpuSeed,
    assignNewGpuSeed,
    collectCpuProofs,
    collectGpuProofs,
    verifyCpuProofs,
    verifyGpuProofs,
    collectAndVerifyAll,
    getLastSeedInfo,
    getHistory,
  };
}

module.exports = { createSeedAssignmentManager, generateSeed };
