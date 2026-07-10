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

module.exports = LOCAL_HARDWARE_PROFILE_DB;
