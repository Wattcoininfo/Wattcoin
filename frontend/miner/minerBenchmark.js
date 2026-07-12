// ─── Memory bandwidth expected values ─────────────────────────────────────────
// Returns expected sequential bandwidth in MB/s for the declared memory spec.
// Formula: channels × speedMhz × 8 bytes (64-bit bus) × efficiency_factor.
// Node.js sequential bench achieves ~55% of theoretical peak, so efficiency=0.55.
// Called with hardware.memType (DDR4/DDR5/LPDDR5…), memSpeedMhz, and memSticks.
export function getExpectedMemBandwidthMBps(memType, memSpeedMhz, memSticks) {
  if (!memSpeedMhz || memSpeedMhz <= 0) return 0;
  // Infer channel count: ≥2 sticks usually implies dual-channel for DDR4/DDR5.
  // LPDDR is always one "virtual channel" per package (spec-defined 128-bit bus treats as 2 ch).
  const isLPDDR = /LPDDR/i.test(memType || '');
  const _isDDR5 = /DDR5/i.test(memType || '');
  let channels = isLPDDR ? 2 : memSticks >= 2 ? 2 : 1;
  // DDR4/5: bus width = 64 bits = 8 bytes per transfer; speed in MT/s
  const theoreticalMBps = channels * memSpeedMhz * 8; // MT/s × 8 B = MB/s
  const efficiency = 0.25; // fraction of theoretical peak reported by this bench.
  // Stride-64 writes cause a read-for-ownership per cache line,
  // so actual DRAM traffic is 2× the buffer size, but we only
  // count bytes written.  V8 vs native adds further overhead.
  // Derivation: 65% peak × 50% RFO factor × 80% V8 ≈ 26%,
  // round down to 0.25 — applies universally across all DDR types.
  return Math.round(theoreticalMBps * efficiency);
}

// ─── GPU-PoW native benchmark ─────────────────────────────────────────────────
// Calls the native GPU binary via IPC to run proof-of-work on all detected GPUs.
// Returns { score, elapsedMs, devices, gpuCount } or { error }.
// Score = CALIB_DIFFICULTY / elapsedMs × 1_000_000 (throughput metric).
// The native binary handles multi-GPU partitioning internally.
const GPU_POW_CALIB_DIFFICULTY = 1024;
export async function runGpuPowBenchmark() {
  try {
    if (!window.wattcoinHardware || !window.wattcoinHardware.invoke) {
      return { error: 'GPU-PoW: wattcoinHardware.invoke unavailable' };
    }
    const seed = (Math.random() * 0x7fffffff) | 0 || 1;
    const result = await window.wattcoinHardware.invoke('wattcoin-gpu-pow-probe', {
      seed,
      difficulty: GPU_POW_CALIB_DIFFICULTY,
    });
    if (!result || !result.ok || !Array.isArray(result.devices) || result.devices.length === 0) {
      return { error: 'GPU-PoW: probe returned no results' };
    }
    // Use the slowest device elapsed time (bottleneck determines calibration).
    let maxMs = 0;
    let _totalMs = 0;
    let validDevices = 0;
    for (const d of result.devices) {
      if (d && d.elapsedMs > 0) {
        maxMs = Math.max(maxMs, d.elapsedMs);
        _totalMs += d.elapsedMs;
        validDevices++;
      }
    }
    if (maxMs <= 0) return { error: 'GPU-PoW: no valid device timings' };
    const elapsedMs = maxMs;
    const score = Math.round((GPU_POW_CALIB_DIFFICULTY / elapsedMs) * 1_000_000);
    return { score, elapsedMs, devices: result.devices, gpuCount: validDevices };
  } catch (e) {
    return { error: 'GPU-PoW: ' + ((e && e.message) || 'exception') };
  }
}
let _cpuProbeCallCount = 0;
export function getCpuProbeCallCount() {
  return _cpuProbeCallCount;
}
export function resetCpuProbeCallCount(v) {
  _cpuProbeCallCount = v;
}
export function runCpuProbe(seed, iterations, recordChunks) {
  _cpuProbeCallCount++;
  let x = seed | 0 || 1;
  const N = iterations | 0;
  const chunks = recordChunks ? [] : null;
  const CHUNK = 25000000;
  let prev = performance.now();
  for (let chunkStart = 0; chunkStart < N; chunkStart += CHUNK) {
    const chunkEnd = Math.min(chunkStart + CHUNK, N);
    for (let i = chunkStart; i < chunkEnd; i++) {
      x = (Math.imul(x, 48271) + 9973) | 0;
      x ^= x << 13;
      x ^= x >> 17;
      x ^= x << 5;
      x &= 0x7fffffff;
    }
    if (chunks) {
      const now = performance.now();
      chunks.push(Math.round((now - prev) * 10) / 10);
      prev = now;
    }
  }
  return { proof: (x >>> 0).toString(16).padStart(8, '0'), chunks };
}

// Duration-based CPU probe: runs until deadline expires, returns { proof, iterations, chunks }.
// Iteration count is self-authenticating via the proof hash H(seed, iterations).
export function runCpuProbeForDuration(seed, durationMs, recordChunks) {
  _cpuProbeCallCount++;
  let x = seed | 0 || 1;
  const chunks = recordChunks ? [] : null;
  const CHUNK = 25000000;
  const deadline = performance.now() + durationMs;
  let iterations = 0;
  let prev = performance.now();
  while (performance.now() < deadline) {
    const chunkEnd = iterations + CHUNK;
    for (let i = iterations; i < chunkEnd; i++) {
      x = (Math.imul(x, 48271) + 9973) | 0;
      x ^= x << 13;
      x ^= x >> 17;
      x ^= x << 5;
      x &= 0x7fffffff;
    }
    iterations = chunkEnd;
    if (chunks) {
      const now = performance.now();
      chunks.push(Math.round((now - prev) * 10) / 10);
      prev = now;
    }
  }
  return { proof: (x >>> 0).toString(16).padStart(8, '0'), iterations, chunks };
}

// ─── GPU VRAM / memory-type lookup table ─────────────────────────────────────
// Returns { vramGb, memType } for a GPU model string.
// Used as fallback when systeminformation doesn't populate vram/memoryType
// (e.g. when hardware source is 'electron' or drivers don't expose it).
export function getGpuVramInfo(model) {
  if (!model) return { vramGb: 0, memType: '' };
  const m = model;
  // NVIDIA RTX 40-series
  if (/RTX\s*4090/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*4080\s*Super/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4080/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Ti\s*Super/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Ti/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Super/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4070/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4060\s*Ti/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RTX\s*4060/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*4050/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  // NVIDIA RTX 30-series
  if (/RTX\s*3090\s*Ti/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*3090/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*3080\s*Ti/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*3080\s*12/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*3080/i.test(m)) return { vramGb: 10, memType: 'GDDR6X' };
  if (/RTX\s*3070\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR6X' };
  if (/RTX\s*3070/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*3060\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*3060/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RTX\s*3050/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // NVIDIA RTX 20-series
  if (/RTX\s*2080\s*Ti/i.test(m)) return { vramGb: 11, memType: 'GDDR6' };
  if (/RTX\s*2080\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2080/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2070\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2070/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2060\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2060/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  // NVIDIA GTX 16-series
  if (/GTX\s*1660\s*Ti/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/GTX\s*1660\s*Super/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/GTX\s*1660/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1650\s*Super/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  if (/GTX\s*1650/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  // NVIDIA GTX 10-series
  if (/GTX\s*1080\s*Ti/i.test(m)) return { vramGb: 11, memType: 'GDDR5X' };
  if (/GTX\s*1080/i.test(m)) return { vramGb: 8, memType: 'GDDR5X' };
  if (/GTX\s*1070\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/GTX\s*1070/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/GTX\s*1060\s*6/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1060\s*3/i.test(m)) return { vramGb: 3, memType: 'GDDR5' };
  if (/GTX\s*1060/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1050\s*Ti/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  if (/GTX\s*1050/i.test(m)) return { vramGb: 2, memType: 'GDDR5' };
  // AMD RX 9000-series (RDNA 4)
  if (/RX\s*9070\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*9070/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  // AMD RX 7000-series (RDNA 3)
  if (/RX\s*7900\s*XTX/i.test(m)) return { vramGb: 24, memType: 'GDDR6' };
  if (/RX\s*7900\s*GRE/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7900\s*XT/i.test(m)) return { vramGb: 20, memType: 'GDDR6' };
  if (/RX\s*7800\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7700\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*7600\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7600/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*7500\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // AMD RX 6000-series (RDNA 2)
  if (/RX\s*6950\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6900\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6800\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6800/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6750\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*6700\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*6700/i.test(m)) return { vramGb: 10, memType: 'GDDR6' };
  if (/RX\s*6650\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6600\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6600/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6500\s*XT/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  if (/RX\s*6400/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  // AMD RX 5000-series (RDNA 1)
  if (/RX\s*5700\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*5700/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*5600\s*XT/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/RX\s*5500\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // AMD RX 500/400-series (Polaris)
  if (/RX\s*590/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*580/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*570/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  if (/RX\s*480/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*470/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  // AMD Vega
  if (/Vega\s*64/i.test(m)) return { vramGb: 8, memType: 'HBM2' };
  if (/Vega\s*56/i.test(m)) return { vramGb: 8, memType: 'HBM2' };
  if (/Radeon\s*VII/i.test(m)) return { vramGb: 16, memType: 'HBM2' };
  // Intel Arc
  if (/Arc\s*A770/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/Arc\s*A750/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/Arc\s*A580/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/Arc\s*A380/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/Arc\s*B580/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/Arc\s*B570/i.test(m)) return { vramGb: 10, memType: 'GDDR6' };
  return { vramGb: 0, memType: '' };
}

// ─── Expected GPU-PoW score table ────────────────────────────────────────────
// Returns expected GPU-PoW benchmark score for a GPU model string.
// Score metric: GPU_POW_CALIB_DIFFICULTY / elapsedMs × 1_000_000 (throughput).
// Values derived from GPU compute capability ratios, will be refined with real hardware.
// Returns 0 for unknown GPUs (validation skipped).
export function getExpectedGpuScore(gpuModel) {
  if (!gpuModel) return 0;
  const m = gpuModel;

  // ── NVIDIA RTX 40-series ──────────────────────────────────────────────────────
  if (/RTX\s*4090/i.test(m)) return 1_000_000;
  if (/RTX\s*4080\s*Super/i.test(m)) return 783_000;
  if (/RTX\s*4080/i.test(m)) return 713_000;
  if (/RTX\s*4070\s*Ti\s*Super/i.test(m)) return 609_000;
  if (/RTX\s*4070\s*Ti/i.test(m)) return 570_000;
  if (/RTX\s*4070\s*Super/i.test(m)) return 517_000;
  if (/RTX\s*4070/i.test(m)) return 463_000;
  if (/RTX\s*4060\s*Ti/i.test(m)) return 374_000;
  if (/RTX\s*4060/i.test(m)) return 303_000;
  if (/RTX\s*4050/i.test(m)) return 249_000;

  // ── NVIDIA RTX 30-series ──────────────────────────────────────────────────────
  if (/RTX\s*3090\s*Ti/i.test(m)) return 642_000;
  if (/RTX\s*3090/i.test(m)) return 589_000;
  if (/RTX\s*3080\s*Ti/i.test(m)) return 570_000;
  if (/RTX\s*3080\s*12/i.test(m)) return 517_000;
  if (/RTX\s*3080/i.test(m)) return 482_000;
  if (/RTX\s*3070\s*Ti/i.test(m)) return 410_000;
  if (/RTX\s*3070/i.test(m)) return 392_000;
  if (/RTX\s*3060\s*Ti/i.test(m)) return 321_000;
  if (/RTX\s*3060/i.test(m)) return 268_000;
  if (/RTX\s*3050/i.test(m)) return 178_000;

  // ── NVIDIA RTX 20-series ──────────────────────────────────────────────────────
  if (/RTX\s*2080\s*Ti/i.test(m)) return 410_000;
  if (/RTX\s*2080\s*Super/i.test(m)) return 357_000;
  if (/RTX\s*2080/i.test(m)) return 339_000;
  if (/RTX\s*2070\s*Super/i.test(m)) return 321_000;
  if (/RTX\s*2070/i.test(m)) return 285_000;
  if (/RTX\s*2060\s*Super/i.test(m)) return 268_000;
  if (/RTX\s*2060/i.test(m)) return 232_000;

  // ── NVIDIA GTX 16-series ──────────────────────────────────────────────────────
  if (/GTX\s*1660\s*Ti/i.test(m)) return 197_000;
  if (/GTX\s*1660\s*Super/i.test(m)) return 178_000;
  if (/GTX\s*1660/i.test(m)) return 161_000;
  if (/GTX\s*1650\s*Super/i.test(m)) return 143_000;
  if (/GTX\s*1650/i.test(m)) return 107_000;

  // ── NVIDIA GTX 10-series ──────────────────────────────────────────────────────
  if (/GTX\s*1080\s*Ti/i.test(m)) return 268_000;
  if (/GTX\s*1080/i.test(m)) return 232_000;
  if (/GTX\s*1070\s*Ti/i.test(m)) return 197_000;
  if (/GTX\s*1070/i.test(m)) return 178_000;
  if (/GTX\s*1060\s*6/i.test(m)) return 125_000;
  if (/GTX\s*1060/i.test(m)) return 107_000;
  if (/GTX\s*1050\s*Ti/i.test(m)) return 78_000;
  if (/GTX\s*1050/i.test(m)) return 64_000;

  // ── NVIDIA Quadro / Professional ─────────────────────────────────────────────
  if (/RTX\s*[Aa]\s*6000/i.test(m)) return 642_000;
  if (/RTX\s*[Aa]\s*5000/i.test(m)) return 499_000;
  if (/RTX\s*[Aa]\s*4000/i.test(m)) return 321_000;
  if (/RTX\s*[Aa]\s*2000/i.test(m)) return 178_000;
  if (/Quadro\s*P[45][0-9]{3}/i.test(m)) return 178_000;
  if (/Quadro\s*P[12][0-9]{3}/i.test(m)) return 90_000;

  // ── AMD Radeon RX 7000-series ─────────────────────────────────────────────────
  if (/RX\s*7900\s*XTX/i.test(m)) return 785_000;
  if (/RX\s*7900\s*XT/i.test(m)) return 678_000;
  if (/RX\s*7800\s*XT/i.test(m)) return 499_000;
  if (/RX\s*7700\s*XT/i.test(m)) return 428_000;
  if (/RX\s*7600/i.test(m)) return 303_000;
  if (/RX\s*7500\s*XT/i.test(m)) return 214_000;

  // ── AMD Radeon RX 6000-series ─────────────────────────────────────────────────
  if (/RX\s*6950\s*XT/i.test(m)) return 660_000;
  if (/RX\s*6900\s*XT/i.test(m)) return 624_000;
  if (/RX\s*6800\s*XT/i.test(m)) return 589_000;
  if (/RX\s*6800/i.test(m)) return 535_000;
  if (/RX\s*6750\s*XT/i.test(m)) return 463_000;
  if (/RX\s*6700\s*XT/i.test(m)) return 428_000;
  if (/RX\s*6700/i.test(m)) return 392_000;
  if (/RX\s*6650\s*XT/i.test(m)) return 339_000;
  if (/RX\s*6600\s*XT/i.test(m)) return 321_000;
  if (/RX\s*6600/i.test(m)) return 285_000;
  if (/RX\s*6500\s*XT/i.test(m)) return 161_000;
  if (/RX\s*6400/i.test(m)) return 107_000;

  // ── AMD Radeon RX 5000-series ─────────────────────────────────────────────────
  if (/RX\s*5700\s*XT/i.test(m)) return 357_000;
  if (/RX\s*5700/i.test(m)) return 321_000;
  if (/RX\s*5600\s*XT/i.test(m)) return 268_000;
  if (/RX\s*5500\s*XT/i.test(m)) return 178_000;

  // ── AMD Radeon Vega / RX 400–580 ─────────────────────────────────────────────
  if (/Vega\s*64/i.test(m)) return 285_000;
  if (/Vega\s*56/i.test(m)) return 249_000;
  if (/RX\s*590/i.test(m)) return 178_000;
  if (/RX\s*580/i.test(m)) return 161_000;
  if (/RX\s*570/i.test(m)) return 143_000;
  if (/RX\s*480/i.test(m)) return 161_000;
  if (/RX\s*470/i.test(m)) return 143_000;

  // ── Intel Arc ─────────────────────────────────────────────────────────────────
  if (/Arc\s*A770/i.test(m)) return 392_000;
  if (/Arc\s*A750/i.test(m)) return 339_000;
  if (/Arc\s*A580/i.test(m)) return 268_000;
  if (/Arc\s*A380/i.test(m)) return 143_000;
  if (/Arc\s*A310/i.test(m)) return 90_000;

  // ── Intel Iris Xe (discrete / Evo) ───────────────────────────────────────────
  if (/Iris\s*Xe\s*Max/i.test(m)) return 64_000;
  if (/Iris\s*Xe/i.test(m)) return 32_000;

  // ── Intel UHD / HD integrated ────────────────────────────────────────────────
  if (/UHD\s*Graphics\s*770/i.test(m)) return 18_000;
  if (/UHD\s*Graphics\s*7[0-9]{2}/i.test(m)) return 17_000;
  if (/UHD\s*Graphics\s*6[0-9]{2}/i.test(m)) return 14_000;
  if (/UHD\s*Graphics/i.test(m)) return 14_000;
  if (/HD\s*Graphics\s*[6-9][3-9]0/i.test(m)) return 7_000;
  if (/HD\s*Graphics/i.test(m)) return 5_000;

  // ── AMD Radeon Graphics (integrated RDNA2/3) ──────────────────────────────────
  if (/Radeon\s*Graphics/i.test(m)) return 25_000;

  // ── Apple (Metal — GPU perf via system-reported model) ───────────────────────
  if (/M4\s*(Pro|Max|Ultra)/i.test(m)) return 321_000;
  if (/\bM4\b/i.test(m)) return 178_000;
  if (/M3\s*(Pro|Max|Ultra)/i.test(m)) return 249_000;
  if (/\bM3\b/i.test(m)) return 143_000;
  if (/M2\s*(Pro|Max|Ultra)/i.test(m)) return 197_000;
  if (/\bM2\b/i.test(m)) return 114_000;
  if (/M1\s*(Pro|Max|Ultra)/i.test(m)) return 143_000;
  if (/\bM1\b/i.test(m)) return 90_000;

  // Unknown GPU: conservative mid-range fallback (≈ GTX 1060 / RX 580 class).
  return 125_000;
}

// Returns the expected ops/s for runCpuSpeedBenchmark (fixed-N imul+XOR loop) for a
// given CPU model string.  Values are derived from: boostClockGHz × archFactor × 1e8.
// Used for (1) hardware-claim validation and (2) TDP calibration from measured throughput.
// Returns 0 for unrecognised CPUs (validation skipped).
export function getExpectedCpuSpeedOps(cpuModel) {
  if (!cpuModel) return 0;
  const m = cpuModel;

  // ── Intel 14th / 13th Gen Desktop (Raptor Lake / Refresh) ────────────────────
  if (/Core.*i9-1[34]900KS/i.test(m)) return 620_000_000;
  if (/Core.*i9-1[34]900KF?/i.test(m)) return 600_000_000;
  if (/Core.*i9-1[34]900[FT]?/i.test(m)) return 575_000_000;
  if (/Core.*i7-1[34]700KF?/i.test(m)) return 560_000_000;
  if (/Core.*i7-1[34]700[FT]?/i.test(m)) return 540_000_000;
  if (/Core.*i5-1[34]600KF?/i.test(m)) return 530_000_000;
  if (/Core.*i5-1[34][5-9]0{2}[FT]?/i.test(m)) return 510_000_000;
  if (/Core.*i5-1[34]400[FT]?/i.test(m)) return 480_000_000;
  if (/Core.*i3-1[34]1[0-9]0[FT]?/i.test(m)) return 460_000_000;
  if (/Core.*i3-133[0-9]0/i.test(m)) return 460_000_000;

  // ── Intel 12th Gen Desktop (Alder Lake P-core) ───────────────────────────────
  if (/Core.*i9-12900KS/i.test(m)) return 520_000_000;
  if (/Core.*i9-12900KF?/i.test(m)) return 500_000_000;
  if (/Core.*i9-12900[FT]?/i.test(m)) return 490_000_000;
  if (/Core.*i7-12700KF?/i.test(m)) return 490_000_000;
  if (/Core.*i7-12700[FT]?/i.test(m)) return 470_000_000;
  if (/Core.*i5-12600KF?/i.test(m)) return 470_000_000;
  if (/Core.*i5-12[56]0{2}[FT]?/i.test(m)) return 450_000_000;
  if (/Core.*i5-124[024]0[FT]?/i.test(m)) return 430_000_000;
  if (/Core.*i3-12[13][02][015][FT]?/i.test(m)) return 420_000_000;

  // ── Intel 11th Gen Desktop (Rocket Lake) ─────────────────────────────────────
  if (/Core.*i9-11900KF?/i.test(m)) return 490_000_000;
  if (/Core.*i9-11900[FT]?/i.test(m)) return 480_000_000;
  if (/Core.*i7-11700KF?/i.test(m)) return 480_000_000;
  if (/Core.*i7-11700[FT]?/i.test(m)) return 460_000_000;
  if (/Core.*i5-11[456][0-9]0[FKT]?[F]?/i.test(m)) return 440_000_000;

  // ── Intel 10th Gen Desktop (Comet Lake) ──────────────────────────────────────
  if (/Core.*i9-10900KF?S?/i.test(m)) return 470_000_000;
  if (/Core.*i9-10[89][0-9]0[FKST]?/i.test(m)) return 460_000_000;
  if (/Core.*i7-10700KF?/i.test(m)) return 450_000_000;
  if (/Core.*i7-10700[FT]?/i.test(m)) return 420_000_000;
  if (/Core.*i5-10[456][0-9]0[FKST]?/i.test(m)) return 400_000_000;
  if (/Core.*i3-10[1-9][0-9]0[FT]?/i.test(m)) return 390_000_000;

  // ── Intel 9th / 8th Gen Desktop (Coffee Lake / Refresh) ─────────────────────
  if (/Core.*i9-9900KF?S?/i.test(m)) return 430_000_000;
  if (/Core.*i9-9900[FT]?/i.test(m)) return 430_000_000;
  if (/Core.*i7-9700KF?/i.test(m)) return 420_000_000;
  if (/Core.*i7-9700[FT]?/i.test(m)) return 400_000_000;
  if (/Core.*i5-9[456][0-9]0[FKT]?/i.test(m)) return 380_000_000;
  if (/Core.*i3-9[1-9][0-9]0[FKT]?/i.test(m)) return 360_000_000;
  if (/Core.*i7-8700KF?/i.test(m)) return 400_000_000;
  if (/Core.*i7-8700[FT]?/i.test(m)) return 385_000_000;
  if (/Core.*i5-8[456][0-9]0[FKT]?/i.test(m)) return 360_000_000;
  if (/Core.*i3-8[1-4][0-9]0[FKT]?/i.test(m)) return 340_000_000;

  // ── Intel 7th Gen Desktop (Kaby Lake) ────────────────────────────────────────
  if (/Core.*i7-7700KF?/i.test(m)) return 375_000_000;
  if (/Core.*i7-7700[T]?/i.test(m)) return 350_000_000;
  if (/Core.*i5-7[456][0-9]0[KT]?/i.test(m)) return 335_000_000;
  if (/Core.*i3-73[0-9]0[KT]?/i.test(m)) return 330_000_000;
  if (/Core.*i3-71[0-9]0[T]?/i.test(m)) return 320_000_000;

  // ── Intel 6th Gen Desktop (Skylake) ──────────────────────────────────────────
  if (/Core.*i7-6700KF?/i.test(m)) return 340_000_000;
  if (/Core.*i7-6700[T]?/i.test(m)) return 320_000_000;
  if (/Core.*i5-6[456][0-9]0[KT]?/i.test(m)) return 310_000_000;
  if (/Core.*i3-6[1-3][0-9]0[T]?/i.test(m)) return 300_000_000;

  // ── Intel 5th Gen Desktop (Broadwell) ────────────────────────────────────────
  if (/Core.*i[57]-5[67][0-9]5C/i.test(m)) return 285_000_000;

  // ── Intel 4th Gen Desktop (Haswell) ──────────────────────────────────────────
  if (/Core.*i7-4790K/i.test(m)) return 330_000_000;
  if (/Core.*i7-47[0-9]0[T]?/i.test(m)) return 300_000_000;
  if (/Core.*i5-4[5-9][0-9]0[KT]?/i.test(m)) return 295_000_000;
  if (/Core.*i5-4[34][0-9]0[T]?/i.test(m)) return 270_000_000;
  if (/Core.*i3-4[1-4][0-9]0[T]?/i.test(m)) return 265_000_000;

  // ── Intel 3rd Gen Desktop (Ivy Bridge) ───────────────────────────────────────
  if (/Core.*i7-377[0-9]K?/i.test(m)) return 260_000_000;
  if (/Core.*i5-35[2-7]0[KT]?/i.test(m)) return 250_000_000;
  if (/Core.*i5-34[3-7]0[T]?/i.test(m)) return 240_000_000;
  if (/Core.*i3-3[1-3][0-9]0/i.test(m)) return 220_000_000;

  // ── Intel 2nd Gen Desktop (Sandy Bridge) ─────────────────────────────────────
  if (/Core.*i7-2[6-7]00K?/i.test(m)) return 240_000_000;
  if (/Core.*i7-2[5-9][0-9]0[S]?/i.test(m)) return 230_000_000;
  if (/Core.*i5-2[3-6][0-9]0K?/i.test(m)) return 220_000_000;
  if (/Core.*i3-2[1-3][0-9]0/i.test(m)) return 200_000_000;

  // ── Intel Core Ultra 200S (Arrow Lake Desktop) ───────────────────────────────
  if (/Core.*Ultra 9 2[0-9]{2}K/i.test(m)) return 560_000_000;
  if (/Core.*Ultra 7 2[0-9]{2}KF?/i.test(m)) return 540_000_000;
  if (/Core.*Ultra 5 2[0-9]{2}KF?/i.test(m)) return 510_000_000;

  // ── Intel Core Ultra 100H/U (Meteor Lake Mobile) ─────────────────────────────
  if (/Core.*Ultra 9 1[0-9]{2}H/i.test(m)) return 430_000_000;
  if (/Core.*Ultra 7 1[0-9]{2}H/i.test(m)) return 415_000_000;
  if (/Core.*Ultra 5 1[0-9]{2}H/i.test(m)) return 390_000_000;
  if (/Core.*Ultra [579] 1[0-9]{2}U/i.test(m)) return 350_000_000;

  // ── Intel 13th Gen Mobile (HX / H / U) ───────────────────────────────────────
  if (/Core.*i9-139[0-9]0HX/i.test(m)) return 520_000_000;
  if (/Core.*i9-139[0-9]0H/i.test(m)) return 490_000_000;
  if (/Core.*i7-137[0-9]0HX/i.test(m)) return 480_000_000;
  if (/Core.*i7-137[0-9]0H/i.test(m)) return 460_000_000;
  if (/Core.*i5-13[3-6][0-9]0H/i.test(m)) return 440_000_000;
  if (/Core.*i[37]-13[3-7][0-9]U/i.test(m)) return 420_000_000;
  if (/Core.*i[35]-13[1-5][0-9]U/i.test(m)) return 390_000_000;

  // ── Intel 12th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i9-129[0-9]0H[KX]?/i.test(m)) return 450_000_000;
  if (/Core.*i7-127[0-9]0H/i.test(m)) return 420_000_000;
  if (/Core.*i5-12[45][0-9]0H/i.test(m)) return 400_000_000;
  if (/Core.*i7-12[78][0-9]P/i.test(m)) return 390_000_000;
  if (/Core.*i[35]-12[34][0-9]P/i.test(m)) return 360_000_000;
  if (/Core.*i[37]-12[25][0-9]U/i.test(m)) return 380_000_000;
  if (/Core.*i5-12[23][0-9]U/i.test(m)) return 350_000_000;

  // ── Intel 11th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i9-11980HK/i.test(m)) return 420_000_000;
  if (/Core.*i9-119[0-9]0H/i.test(m)) return 390_000_000;
  if (/Core.*i7-118[0-9]0H/i.test(m)) return 380_000_000;
  if (/Core.*i5-115[0-9]0H/i.test(m)) return 360_000_000;
  if (/Core.*i7-118[56]G[47]/i.test(m)) return 350_000_000;
  if (/Core.*i7-116[56]G7/i.test(m)) return 340_000_000;
  if (/Core.*i5-1135G7/i.test(m)) return 320_000_000;
  if (/Core.*i3-11[12][0-9]G[47]/i.test(m)) return 290_000_000;

  // ── Intel 10th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i7-108[0-9]5H/i.test(m)) return 380_000_000;
  if (/Core.*i7-107[0-9]0H/i.test(m)) return 360_000_000;
  if (/Core.*i5-103[0-9]0H/i.test(m)) return 340_000_000;
  if (/Core.*i7-1065G7/i.test(m)) return 320_000_000; // Ice Lake
  if (/Core.*i5-1035G[14]/i.test(m)) return 290_000_000;
  if (/Core.*i3-1005G1/i.test(m)) return 260_000_000;

  // ── Intel Xeon ────────────────────────────────────────────────────────────────
  if (/Xeon.*w9-35[0-9]{2}X/i.test(m)) return 490_000_000;
  if (/Xeon.*w7-3[0-9]{3}X/i.test(m)) return 470_000_000;
  if (/Xeon.*w7-2[0-9]{3}X/i.test(m)) return 450_000_000;
  if (/Xeon.*W-3175X/i.test(m)) return 390_000_000;
  if (/Xeon.*W-2[2-9][0-9]{2}/i.test(m)) return 410_000_000;
  if (/Xeon.*Gold 6[12][0-9]{2}R?/i.test(m)) return 360_000_000;
  if (/Xeon.*Silver 4[23][0-9]{2}/i.test(m)) return 330_000_000;
  if (/Xeon.*E5-2[6-9][0-9]{2}/i.test(m)) return 260_000_000;

  // ── AMD Ryzen 9000 (Zen 5) ────────────────────────────────────────────────────
  if (/Ryzen 9 9950X/i.test(m)) return 580_000_000;
  if (/Ryzen 9 9900X/i.test(m)) return 570_000_000;
  if (/Ryzen 7 9800X3D/i.test(m)) return 520_000_000;
  if (/Ryzen 7 9700X/i.test(m)) return 560_000_000;
  if (/Ryzen 5 9600X/i.test(m)) return 540_000_000;
  if (/Ryzen 5 9600/i.test(m)) return 510_000_000;

  // ── AMD Ryzen 7000 (Zen 4) ────────────────────────────────────────────────────
  if (/Ryzen 9 7950X3D/i.test(m)) return 540_000_000;
  if (/Ryzen 9 7950X/i.test(m)) return 560_000_000;
  if (/Ryzen 9 7900X3D/i.test(m)) return 530_000_000;
  if (/Ryzen 9 7900X/i.test(m)) return 550_000_000;
  if (/Ryzen 9 7900/i.test(m)) return 530_000_000;
  if (/Ryzen 7 7800X3D/i.test(m)) return 490_000_000;
  if (/Ryzen 7 7700X/i.test(m)) return 530_000_000;
  if (/Ryzen 7 7700/i.test(m)) return 520_000_000;
  if (/Ryzen 5 7600X/i.test(m)) return 520_000_000;
  if (/Ryzen 5 7600/i.test(m)) return 500_000_000;
  if (/Ryzen 5 7500F/i.test(m)) return 490_000_000;

  // ── AMD Ryzen 5000 (Zen 3) ────────────────────────────────────────────────────
  if (/Ryzen 9 5950X/i.test(m)) return 470_000_000;
  if (/Ryzen 9 5900X/i.test(m)) return 460_000_000;
  if (/Ryzen 9 5900HX/i.test(m)) return 420_000_000;
  if (/Ryzen 9 5900/i.test(m)) return 450_000_000;
  if (/Ryzen 7 5800X3D/i.test(m)) return 430_000_000;
  if (/Ryzen 7 5800X/i.test(m)) return 450_000_000;
  if (/Ryzen 7 5800H/i.test(m)) return 410_000_000;
  if (/Ryzen 7 5800/i.test(m)) return 440_000_000;
  if (/Ryzen 7 5700[GX]?/i.test(m)) return 440_000_000;
  if (/Ryzen 5 5600X/i.test(m)) return 440_000_000;
  if (/Ryzen 5 5600H/i.test(m)) return 400_000_000;
  if (/Ryzen 5 5600[G]?/i.test(m)) return 420_000_000;
  if (/Ryzen 5 5500/i.test(m)) return 400_000_000;
  if (/Ryzen 3 5[13][0-9]{2}G?/i.test(m)) return 385_000_000;

  // ── AMD Ryzen 3000 (Zen 2) ────────────────────────────────────────────────────
  if (/Ryzen 9 3950X/i.test(m)) return 420_000_000;
  if (/Ryzen 9 3900X?T?/i.test(m)) return 415_000_000;
  if (/Ryzen 7 3800X?T?/i.test(m)) return 410_000_000;
  if (/Ryzen 7 3700X/i.test(m)) return 400_000_000;
  if (/Ryzen 5 3600X?T?/i.test(m)) return 400_000_000;
  if (/Ryzen 5 3600/i.test(m)) return 380_000_000;
  if (/Ryzen 5 3500X?/i.test(m)) return 360_000_000;
  if (/Ryzen 3 3[13][0-9]{2}X?/i.test(m)) return 370_000_000;

  // ── AMD Ryzen 2000 (Zen+) ─────────────────────────────────────────────────────
  if (/Ryzen 7 2700X/i.test(m)) return 330_000_000;
  if (/Ryzen 7 2700/i.test(m)) return 310_000_000;
  if (/Ryzen 5 2600X/i.test(m)) return 320_000_000;
  if (/Ryzen 5 2600/i.test(m)) return 300_000_000;
  if (/Ryzen 3 2[23][0-9]{2}[GX]?/i.test(m)) return 280_000_000;

  // ── AMD Threadripper ──────────────────────────────────────────────────────────
  if (/Threadripper PRO 79[0-9]{2}W/i.test(m)) return 490_000_000;
  if (/Threadripper PRO 59[0-9]{2}W/i.test(m)) return 440_000_000;
  if (/Threadripper PRO 59[0-9]{2}W/i.test(m)) return 440_000_000;
  if (/Threadripper 39[0-9]{2}X/i.test(m)) return 400_000_000;
  if (/Threadripper 29[0-9]{2}[WX]/i.test(m)) return 310_000_000;

  // ── AMD EPYC ──────────────────────────────────────────────────────────────────
  if (/EPYC 9[5-9][0-9]{2}/i.test(m)) return 390_000_000; // Zen4
  if (/EPYC 9[1-4][0-9]{2}/i.test(m)) return 375_000_000;
  if (/EPYC 7[6-9][0-9]{2}/i.test(m)) return 310_000_000; // Zen3
  if (/EPYC 7[3-5][0-9]{2}/i.test(m)) return 280_000_000; // Zen2
  if (/EPYC 7[0-2][0-9]{2}/i.test(m)) return 260_000_000;

  // ── Apple Silicon ─────────────────────────────────────────────────────────────
  if (/M4 (Pro|Max|Ultra)/i.test(m)) return 620_000_000;
  if (/\bM4\b/i.test(m)) return 590_000_000;
  if (/M3 Max/i.test(m)) return 560_000_000;
  if (/M3 (Pro|Ultra)/i.test(m)) return 550_000_000;
  if (/\bM3\b/i.test(m)) return 540_000_000;
  if (/M2 (Pro|Max|Ultra)/i.test(m)) return 500_000_000;
  if (/\bM2\b/i.test(m)) return 480_000_000;
  if (/M1 (Pro|Max|Ultra)/i.test(m)) return 440_000_000;
  if (/\bM1\b/i.test(m)) return 420_000_000;

  return 0; // unknown — skip validation
}
