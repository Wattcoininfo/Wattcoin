const { parseRegexSafe, normalizeHardwareDescriptor } = require('./main-utils');

const LOCAL_HARDWARE_PROFILE_DB = [
  {
    id: 'desktop-high',
    match: (descriptor) =>
      /4090|4080|3090|3080|7900|6900|6800/i.test(descriptor.gpu) ||
      /i9|ryzen\s*9|threadripper|epyc|xeon/i.test(descriptor.cpu),
    conservativeCapW: 130,
    maxCapW: 520,
    stepW: 35,
    minCpuOpsPerSec: 260_000,
    minMemoryMBps: 800,
    requireGpuProof: true,
    spotCheckProbability: 0.08,
  },
  {
    id: 'desktop-mid',
    match: (descriptor) => /desktop|pc|server/i.test(descriptor.deviceType),
    conservativeCapW: 95,
    maxCapW: 360,
    stepW: 25,
    minCpuOpsPerSec: 170_000,
    minMemoryMBps: 650,
    requireGpuProof: true,
    spotCheckProbability: 0.06,
  },
  {
    id: 'laptop',
    match: (descriptor) => /laptop|notebook/i.test(descriptor.deviceType),
    conservativeCapW: 45,
    maxCapW: 130,
    stepW: 10,
    minCpuOpsPerSec: 120_000,
    minMemoryMBps: 500,
    requireGpuProof: false,
    spotCheckProbability: 0.04,
  },
  {
    id: 'fallback',
    match: () => true,
    conservativeCapW: 70,
    maxCapW: 220,
    stepW: 15,
    minCpuOpsPerSec: 100_000,
    minMemoryMBps: 450,
    requireGpuProof: false,
    spotCheckProbability: 0.05,
  },
];

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
  LOCAL_HARDWARE_PROFILE_DB,
  normalizeRemoteProfile,
  buildAttestationMessage,
  shouldAllowGpuWorkloadsForSummary,
};
