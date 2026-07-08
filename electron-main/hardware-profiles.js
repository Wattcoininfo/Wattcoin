const { parseRegexSafe, normalizeHardwareDescriptor } = require('./main-utils');

function normalizeRemoteProfile(entry = {}) {
  const id = String(entry.id || '').trim();
  if (!id) return null;
  const deviceTypeRe = parseRegexSafe(String(entry.deviceTypeRegex || ''));
  const cpuRe = parseRegexSafe(String(entry.cpuRegex || ''));
  const gpuRe = parseRegexSafe(String(entry.gpuRegex || ''));
  const conservativeCapW = Math.max(10, Number(entry.conservativeCapW) || 0);
  const maxCapW = Math.max(conservativeCapW, Number(entry.maxCapW) || conservativeCapW);
  const stepW = Math.max(1, Number(entry.stepW) || 10);
  const minCpuOpsPerSec = Math.max(10_000, Number(entry.minCpuOpsPerSec) || 100_000);
  const minMemoryMBps = Math.max(100, Number(entry.minMemoryMBps) || 400);
  const requireGpuProof = !!entry.requireGpuProof;
  const spotCheckProbability = Math.min(0.5, Math.max(0, Number(entry.spotCheckProbability) || 0.05));

  return {
    id,
    match: (descriptor) => {
      const typeOk = !deviceTypeRe || deviceTypeRe.test(String(descriptor.deviceType || ''));
      const cpuOk = !cpuRe || cpuRe.test(String(descriptor.cpu || ''));
      const gpuOk = !gpuRe || gpuRe.test(String(descriptor.gpu || ''));
      return typeOk && cpuOk && gpuOk;
    },
    conservativeCapW,
    maxCapW,
    stepW,
    minCpuOpsPerSec,
    minMemoryMBps,
    requireGpuProof,
    spotCheckProbability,
  };
}

function buildAttestationMessage(challenge) {
  return `WATTCOIN_ATTEST:${challenge.id}:${challenge.challengeSeed}:${challenge.expiresAtMs}:${challenge.minerId}`;
}

function shouldAllowGpuWorkloadsForSummary(summary = {}) {
  const descriptor = normalizeHardwareDescriptor(summary);
  if (/laptop|notebook|mini\s*pc/i.test(descriptor.deviceType)) return false;
  if (!descriptor.gpu) return true;
  if (/RTX|GTX|MX\d|Arc\s*(?:A|B)|Quadro|Tesla|Titan|GeForce|Radeon\s*(?:RX|Pro|VII)|FirePro/i.test(descriptor.gpu)) {
    return true;
  }
  if (
    /Intel.*(?:HD|UHD|Iris(?!\s*(?:Xe\s*Max|Pro))|Xe(?!\s*Max))|Radeon\(TM\)\s+Graphics|Radeon\s+Graphics|Vega\s*(?:3|5|6|7|8|10|11)|Mali|Adreno/i.test(
      descriptor.gpu,
    )
  ) {
    return false;
  }
  return true;
}

module.exports = {
  normalizeRemoteProfile,
  buildAttestationMessage,
  shouldAllowGpuWorkloadsForSummary,
};
