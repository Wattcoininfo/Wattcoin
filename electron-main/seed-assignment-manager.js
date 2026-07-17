'use strict';

const crypto = require('crypto');
const {
  verifySeedProof,
  checkProofPlausibility,
  computeEnergyWh,
  isValidHex32,
  MIN_BURN_MS,
} = require('./token-verification');
const { getMinOpsPerMs, getGpuMinOpsPerMs, getCpuTdpW, getGpuTdpW } = require('./hardware-tables.cjs');

const _SEED_HEX_LENGTH = 64;

function generateSeed() {
  return crypto.randomBytes(32).toString('hex');
}

function createSeedAssignmentManager({
  _getCpuCoordinatorSeed,
  setCpuCoordinatorSeed,
  _getGpuCoordinatorSeed,
  setGpuCoordinatorSeed,
  getMemSeedProofs,
  setMemCoordinatorSeed,
  getCpuSeedProofs,
  getGpuSeedProofs,
  hwAuthority,
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
    if (typeof setMemCoordinatorSeed === 'function') setMemCoordinatorSeed(seed);
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

  function setMemSeed(hexSeed) {
    if (typeof setMemCoordinatorSeed === 'function') setMemCoordinatorSeed(hexSeed);
  }

  function collectMemProofs() {
    const proofs = typeof getMemSeedProofs === 'function' ? getMemSeedProofs() : new Map();
    const collected = [];
    for (const [, proof] of proofs) {
      collected.push({ ...proof, type: 'memory' });
    }
    return collected;
  }

  async function verifyCpuProofs(proofs, elapsedMs, cpuModel, claimedLoad) {
    if (!Array.isArray(proofs) || proofs.length === 0) {
      console.log(
        `[SeedManager] CPU proofs: none collected (cpuModel=${cpuModel || 'null'} opsPerMs=${(hwAuthority && hwAuthority.sha256OpsPerMs) || 0})`,
      );
      return { ok: true, totalEnergyWh: 0, proofs: 0, reason: 'no_proofs' };
    }
    const tdpW = cpuModel ? getCpuTdpW(cpuModel) : 0;
    const tableOpsPerMs = cpuModel ? getMinOpsPerMs(cpuModel) : 0;
    const opsPerMs = hwAuthority && hwAuthority.sha256OpsPerMs > 0 ? hwAuthority.sha256OpsPerMs : tableOpsPerMs;
    console.log(
      `[SeedManager] CPU proofs: count=${proofs.length} opsPerMs=${opsPerMs} tdpW=${tdpW} load=${claimedLoad}`,
    );
    let totalEnergyWh = 0;
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
          tdpW,
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
      const energyWh = computeEnergyWh(
        'cpu',
        {
          totalOps: plausibility.creditedOps,
          burnMs: result.burnMs,
          elapsedMs,
        },
        { opsPerMs, tdpW },
      );
      totalEnergyWh += energyWh;
      verifiedCount++;
    }
    if (verifiedCount === 0 && proofs.length > 0) {
      console.log(
        `[SeedManager] CPU ALL REJECTED: ${JSON.stringify(rejectReasons)} (opsPerMs=${opsPerMs} tdpW=${tdpW})`,
      );
    }
    return {
      ok: true,
      totalEnergyWh,
      proofs: verifiedCount,
      total: proofs.length,
    };
  }

  async function verifyGpuProofs(proofs, elapsedMs, gpuModel, claimedLoad) {
    if (!Array.isArray(proofs) || proofs.length === 0) {
      console.log(`[SeedManager] GPU proofs: none collected (gpuModel=${gpuModel || 'null'})`);
      return { ok: true, totalEnergyWh: 0, proofs: 0, reason: 'no_proofs' };
    }
    const tdpW = gpuModel ? getGpuTdpW(gpuModel) : 0;
    const tableOpsPerMs = gpuModel ? getGpuMinOpsPerMs(gpuModel) : 0;
    const opsPerMs = hwAuthority && hwAuthority.gpuOpsPerMs > 0 ? hwAuthority.gpuOpsPerMs : tableOpsPerMs;
    console.log(
      `[SeedManager] GPU proofs: count=${proofs.length} opsPerMs=${opsPerMs} tdpW=${tdpW} load=${claimedLoad}`,
    );
    let totalEnergyWh = 0;
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
          tdpW,
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
      const energyWh = computeEnergyWh(
        'gpu',
        {
          totalOps: plausibility.creditedOps,
          burnMs: result.burnMs,
        },
        { tdpW },
      );
      totalEnergyWh += energyWh;
      verifiedCount++;
    }
    if (verifiedCount === 0 && proofs.length > 0) {
      console.log(
        `[SeedManager] GPU ALL REJECTED: ${JSON.stringify(rejectReasons)} (opsPerMs=${opsPerMs} tdpW=${tdpW})`,
      );
    }
    return {
      ok: true,
      totalEnergyWh,
      proofs: verifiedCount,
      total: proofs.length,
    };
  }

  async function verifyMemProofs(proofs, elapsedMs, cpuModel, claimedLoad) {
    if (!Array.isArray(proofs) || proofs.length === 0) {
      console.log(
        `[SeedManager] MEM proofs: none collected (cpuModel=${cpuModel || 'null'} opsPerMs=${(hwAuthority && hwAuthority.sha256OpsPerMs) || 0})`,
      );
      return { ok: true, totalEnergyWh: 0, proofs: 0, reason: 'no_proofs' };
    }
    const tdpW = cpuModel ? getCpuTdpW(cpuModel) : 0;
    const tableOpsPerMs = cpuModel ? getMinOpsPerMs(cpuModel) : 0;
    const opsPerMs = hwAuthority && hwAuthority.sha256OpsPerMs > 0 ? hwAuthority.sha256OpsPerMs : tableOpsPerMs;
    console.log(
      `[SeedManager] MEM proofs: count=${proofs.length} opsPerMs=${opsPerMs} tdpW=${tdpW} load=${claimedLoad}`,
    );
    let totalEnergyWh = 0;
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
          tdpW,
        },
        claimedLoad,
      );
      if (!plausibility.ok) {
        console.log(
          `[SeedManager] MEM proof implausible: ${plausibility.reason} (actualOps=${plausibility.actualOps} expectedOps=${plausibility.expectedOps} burnMs=${effectiveElapsedMs} opsPerMs=${opsPerMs} load=${claimedLoad})`,
        );
        rejectReasons[plausibility.reason] = (rejectReasons[plausibility.reason] || 0) + 1;
        continue;
      }
      const energyWh = computeEnergyWh(
        'memory',
        {
          totalOps: plausibility.creditedOps,
          burnMs: result.burnMs,
          elapsedMs,
        },
        { opsPerMs, tdpW },
      );
      totalEnergyWh += energyWh;
      verifiedCount++;
    }
    if (verifiedCount === 0 && proofs.length > 0) {
      console.log(
        `[SeedManager] MEM ALL REJECTED: ${JSON.stringify(rejectReasons)} (opsPerMs=${opsPerMs} tdpW=${tdpW})`,
      );
    }
    return {
      ok: true,
      totalEnergyWh,
      proofs: verifiedCount,
      total: proofs.length,
    };
  }

  async function collectAndVerifyAll({ elapsedMs, cpuModel, gpuModel, claimedLoad } = {}) {
    const effectiveElapsed = Math.max(1, Number(elapsedMs) || 60000);
    const cpuProofs = collectCpuProofs();
    const gpuProofs = collectGpuProofs();
    const memProofs = collectMemProofs();
    const cpuResult = await verifyCpuProofs(cpuProofs, effectiveElapsed, cpuModel, claimedLoad);
    const gpuResult = await verifyGpuProofs(gpuProofs, effectiveElapsed, gpuModel, claimedLoad);
    const memResult = await verifyMemProofs(memProofs, effectiveElapsed, cpuModel, claimedLoad);
    const totalEnergyWh = Math.max(0, cpuResult.totalEnergyWh + gpuResult.totalEnergyWh + memResult.totalEnergyWh);
    const summary = {
      ok: true,
      totalEnergyWh,
      cpu: { verified: cpuResult.proofs, total: cpuResult.total, energyWh: cpuResult.totalEnergyWh },
      gpu: { verified: gpuResult.proofs, total: gpuResult.total, energyWh: gpuResult.totalEnergyWh },
      mem: { verified: memResult.proofs, total: memResult.total, energyWh: memResult.totalEnergyWh },
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
    setMemSeed,
    assignNewCpuSeed,
    assignNewGpuSeed,
    collectCpuProofs,
    collectGpuProofs,
    collectMemProofs,
    verifyCpuProofs,
    verifyGpuProofs,
    verifyMemProofs,
    collectAndVerifyAll,
    getLastSeedInfo,
    getHistory,
  };
}

module.exports = { createSeedAssignmentManager, generateSeed };
