const crypto = require('crypto');
const { normalizeProbeReceipt } = require('../probe-attestation');

function buildPowerProofCommitment(proofData) {
  if (!proofData || typeof proofData !== 'object') return null;
  const canonical = {
    benchmarkTs: Number(proofData.benchmarkTs) || 0,
    challengeSeed: Number(proofData.challengeSeed) || 0,
    cpuOpsPerSec: Number(proofData.cpuOpsPerSec) || 0,
    cpuSpeedInitialSeed: Number(proofData.cpuSpeedInitialSeed) || 0,
    cpuSpeedProof: String(proofData.cpuSpeedProof || ''),
    cpuSpeedTier: Number(proofData.cpuSpeedTier) || 0,
    energyWh: Number(proofData.energyWh) || 0,
    gpuFps: Number(proofData.gpuFps) || 0,
    gpuProofHash: String(proofData.gpuProofHash || ''),
    gpuProofWorkload: String(proofData.gpuProofWorkload || 'none'),
    issues: Array.isArray(proofData.issues) ? [...proofData.issues].sort() : [],
    jitterRatio: Number(proofData.jitterRatio) || 0,
    memoryMBps: Number(proofData.memoryMBps) || 0,
    memLatencyTier: Number(proofData.memLatencyTier) || 0,
    memProof: String(proofData.memProof || ''),
    miningAddress: String(proofData.miningAddress || ''),
    peerProbeVerified: !!proofData.peerProbeVerified,
    probeReceipt:
      proofData.probeReceipt && typeof proofData.probeReceipt === 'object'
        ? normalizeProbeReceipt(proofData.probeReceipt)
        : null,
    proofTs: Number(proofData.proofTs) || 0,
    score: Number(proofData.score) || 0,
    sensorTier: String(proofData.sensorTier || ''),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

module.exports = { buildPowerProofCommitment };
