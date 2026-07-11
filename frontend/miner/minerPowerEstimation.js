import { cpuTDPTable, gpuTDPTable, cpuPowerTable, gpuPowerTable, asicPowerTable } from './minerTDPTables';

const MAX_HARDWARE_LOAD_PERCENT = 85;

const CONFIDENCE_TIER_LABELS = {
  measured: 'Measured (hardware sensor)',
  derived: 'Derived (counter delta)',
  estimated: 'Estimated (model)',
};

const fmtNum = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

export function estimateHardwarePower({
  hardware,
  allGpuModels,
  isWholeDeviceMiniPcModel,
  loadPercent,
  trustScore,
  benchmarkOpsCalibration,
  benchmarkGpuCalibration,
  benchmarkMemCalibration,
  isHardwareOnHold,
  benchPower,
}) {
  let powerW = 0;

  // 1. Try exact model TDP for CPU + sum TDP of ALL detected GPUs
  let matched = false;
  let cpuTDP = null;
  let gpuTDP = null; // total across all detected GPUs
  const cpuSocketCount = Math.max(1, Number(hardware.cpuSockets) || 1);
  // Core-count cross-validation: cap socket count against navigator.hardwareConcurrency.
  // Prevents inflated multi-socket claims from multiplying TDP fraudulently.
  const navCores = Math.max(1, navigator.hardwareConcurrency || 1);
  const maxCredibleSockets = Math.max(1, Math.floor(navCores / 2));
  const coreValidatedSocketCount = Math.min(cpuSocketCount, maxCredibleSockets);
  let cpuKey = '';

  if (hardware.cpu) {
    cpuKey = hardware.cpu.split(' (')[0].replace(/(?: CPU)? @ [\d.]+GHz?$/i, '');
    const w = cpuTDPTable[cpuKey];
    if (w) {
      cpuTDP = w * coreValidatedSocketCount;
      matched = true;
    }
  }
  if (allGpuModels.length > 0) {
    let gpuTDPSum = 0;
    let anyGpuMatched = false;
    for (const gpuModel of allGpuModels) {
      const w = gpuTDPTable[gpuModel];
      if (w) {
        gpuTDPSum += w;
        anyGpuMatched = true;
      }
    }
    if (anyGpuMatched) {
      gpuTDP = gpuTDPSum;
      matched = true;
    }
  }
  // Memory power estimate — per-type W/GB based on JEDEC specs at active load.
  // LPDDR (mobile): ~0.15 W/GB (1.1 V, low-power)
  // DDR5 / LPDDR5: ~0.25 W/GB (1.1 V; faster but lower voltage than DDR4)
  // DDR4: ~0.375 W/GB (1.2 V; ~3 W per 8 GB DIMM)
  // DDR3: ~0.5 W/GB (1.35–1.5 V; older generation)
  // ECC RDIMM (servers): ~0.6 W/GB — raw cells + register + ECC logic overhead;
  //   server memory runs hotter per GB under sustained load.
  // Cap: consumer/laptop capped at 40 W (≤128 GB practical); servers uncapped
  //   because a 4-socket server with 512 GB ECC draws ~300 W from memory alone.
  const memType = (hardware.memType || '').toUpperCase();
  const isServer = hardware.deviceType === 'Server';
  const isLaptop = hardware.deviceType === 'Laptop' || hardware.deviceType === 'Mini PC';
  const isLPDDR = /LPDDR/.test(memType);
  const isDDR5 = /DDR5/.test(memType);
  const isDDR3 = /DDR3/.test(memType);
  const wPerGB = isServer
    ? 0.6
    : isLPDDR
      ? 0.15
      : isDDR5
        ? isLaptop
          ? 0.2
          : 0.25
        : isDDR3
          ? isLaptop
            ? 0.4
            : 0.5
          : isLaptop
            ? 0.3
            : 0.375;
  const memCapW = isServer ? Infinity : 40;
  const memPowerW = Math.min(memCapW, Math.max(0, Math.round((Number(hardware.memTotalGB) || 0) * wPerGB)));

  // Regex fallback for whichever component was not in the exact tables.
  // Without this, a PC with only one matched side (e.g. CPU in table but GPU not)
  // would silently omit the other component from the estimate.
  if (cpuTDP === null && cpuKey) {
    for (const entry of cpuPowerTable) {
      if (entry.regex.test(cpuKey)) {
        cpuTDP = entry.power * coreValidatedSocketCount;
        if (!matched) matched = true;
        break;
      }
    }
  }
  if (gpuTDP === null && allGpuModels.length > 0) {
    let gpuRegexSum = 0;
    for (const gpuModel of allGpuModels) {
      for (const entry of gpuPowerTable) {
        if (entry.regex.test(gpuModel)) {
          gpuRegexSum += entry.power;
          break;
        }
      }
    }
    if (gpuRegexSum > 0) {
      gpuTDP = gpuRegexSum;
      if (!matched) matched = true;
    }
  }

  // Laptop/MiniPC TDP for ref tracking
  let laptopTDP = null;

  if (matched) {
    if (hardware.deviceType === 'ASIC') {
      // ASICs are whole-device units — look up model power, don't decompose.
      let asicPower = null;
      for (const entry of asicPowerTable) {
        if (entry.regex.test(hardware.gpu)) {
          asicPower = entry.power;
          break;
        }
      }
      if (asicPower !== null) powerW = asicPower;
    } else if (
      hardware.deviceType === 'Desktop' ||
      hardware.deviceType === 'PC' ||
      hardware.deviceType === 'Server' ||
      hardware.deviceType === 'Mac'
    ) {
      if (cpuTDP !== null && gpuTDP !== null) powerW = cpuTDP + gpuTDP;
      else if (cpuTDP !== null) powerW = cpuTDP;
      else if (gpuTDP !== null) powerW = gpuTDP;
      powerW += memPowerW;
    } else if (hardware.deviceType === 'Laptop' || isWholeDeviceMiniPcModel) {
      // Laptops and Mini PCs mine CPU-only — iGPU power is inside CPU TDP envelope.
      if (cpuTDP !== null) {
        laptopTDP = cpuTDP;
        powerW = cpuTDP + memPowerW;
      }
    }
  }

  // 2. Try device type and family regex if not matched — iterate all GPUs for sum
  if (!matched) {
    if (hardware.deviceType === 'Laptop' || isWholeDeviceMiniPcModel) {
      // CPU-only: use regex fallback table; no GPU contribution.
      let regexCpuTDP = null;
      if (cpuKey) {
        for (const entry of cpuPowerTable) {
          if (entry.regex.test(cpuKey)) {
            regexCpuTDP = entry.power * coreValidatedSocketCount;
            break;
          }
        }
      }
      if (regexCpuTDP !== null) {
        laptopTDP = regexCpuTDP;
        powerW = regexCpuTDP + memPowerW;
        matched = true;
      }
      // If still not matched, powerW stays 0 (mining impossible)
    } else if (hardware.deviceType === 'Desktop' || hardware.deviceType === 'PC' || hardware.deviceType === 'Server') {
      // Sum regex TDP estimates across ALL GPUs
      let gpuRegexSum = 0;
      for (const gpuModel of allGpuModels) {
        for (const entry of gpuPowerTable) {
          if (entry.regex.test(gpuModel)) {
            gpuRegexSum += entry.power;
            break;
          }
        }
      }
      if (gpuRegexSum > 0) {
        powerW = gpuRegexSum;
        matched = true;
      }
      if (!matched && cpuKey) {
        for (const entry of cpuPowerTable) {
          if (entry.regex.test(cpuKey)) {
            powerW = entry.power * coreValidatedSocketCount;
            matched = true;
            break;
          }
        }
      }
      // Add CPU regex estimate when a GPU sum was used as base
      if (matched && gpuRegexSum > 0 && cpuKey) {
        for (const entry of cpuPowerTable) {
          if (entry.regex.test(cpuKey)) {
            powerW += entry.power * coreValidatedSocketCount;
            break;
          }
        }
      }
      if (matched) powerW += memPowerW;
    } else if (hardware.deviceType === 'ASIC') {
      let asicPower = null;
      for (const entry of asicPowerTable) {
        if (entry.regex.test(hardware.gpu)) {
          asicPower = entry.power;
          break;
        }
      }
      if (asicPower !== null) powerW = asicPower;
    }
  }

  const clampedLoadPercent = Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, Number(loadPercent) || 0));

  // Benchmark-verified cap: clamp hardware-profile estimate to max credible power from measured throughput.
  const hwProfileRaw = powerW;

  // unitFullPowerW must be captured BEFORE the benchmark cap so "Max hardware power" always reflects
  // the trust-adjusted unit TDP ceiling, not a potentially lower early-benchmark reading.
  // Each TDP component is scaled by its own calibration factor (CPU speed ratio, memory bandwidth
  // ratio, and GPU ALU score ratio).  Blend formula: 0.5 + 0.5×ratio, clamped 0.20–1.20.
  // Piecewise trust → factor: 0.20 at trust 0, 0.70 at trust 70, 1.00 at trust 100
  // Calibrated component breakdown (used for both unitFullPowerW and display).
  const calibratedCpuTDP = (cpuTDP !== null ? cpuTDP : 0) * benchmarkOpsCalibration;
  const calibratedGpuTDP = (gpuTDP !== null ? gpuTDP : 0) * benchmarkGpuCalibration;
  const calibratedMemPowerW = memPowerW * benchmarkMemCalibration;
  // Re-derive total with calibrated components; keep original powerW path for laptop (single unit).
  let calibratedPowerW;
  if (hardware.deviceType === 'Laptop' || isWholeDeviceMiniPcModel) {
    // Laptop is modelled as one whole-unit TDP — apply CPU calibration to the whole.
    calibratedPowerW = (Number(powerW) || 0) * benchmarkOpsCalibration;
  } else if (cpuTDP !== null || gpuTDP !== null) {
    calibratedPowerW = calibratedCpuTDP + calibratedGpuTDP + calibratedMemPowerW;
  } else {
    // No component breakdown available — fall back to single-factor calibration.
    calibratedPowerW = (Number(powerW) || 0) * benchmarkOpsCalibration;
  }
  const unitFullPowerW = Math.max(0, Math.round(calibratedPowerW));
  // Effective load: slider capped at the trust ceiling. Moving the slider above the ceiling
  // has no effect until trust grows — the machine simply won't run hotter than it can be credited for.
  // Load cap: 20% at trust 0, 70% at trust 70, 85% at trust 100 (every 2 trust = +1% load)
  const trustLoadCap =
    trustScore <= 70
      ? Math.round(20 + trustScore * (50 / 70)) // 20% → 70%
      : Math.round(70 + (trustScore - 70) * 0.5); // 70% → 85%
  const effectiveLoadPercent = Math.min(clampedLoadPercent, trustLoadCap);
  const basePowerW = Math.round((unitFullPowerW * trustLoadCap) / 100); // trust-capped ceiling → "Max hardware power"

  const hasEstimate = (Number(powerW) || 0) > 0;
  if (!hasEstimate) powerW = 0;

  // Apply load% to the calibrated hardware power.
  // unitFullPowerW is already benchmark-calibrated, so no additional cap is needed.
  powerW = unitFullPowerW * (effectiveLoadPercent / 100);
  // Zero out power contribution while hardware is on hold after consecutive drift failures.
  if (isHardwareOnHold) powerW = 0;
  const totalPowerUsedW = powerW;

  const _powerSourceLabel =
    Number(benchPower) > 0 && basePowerW === Number(benchPower)
      ? 'benchmark fallback estimate'
      : 'hardware profile estimate';
  const hardwareCardPowerCalcBreakdown = (() => {
    const dt = hardware.deviceType;
    const isLaptop = dt === 'Laptop';
    const isPC = dt === 'Desktop' || dt === 'PC' || dt === 'Server';
    const isASIC = dt === 'ASIC';
    const isMac = dt === 'Mac';
    if (isLaptop || isASIC || isMac || isWholeDeviceMiniPcModel) {
      return `unit: ${Math.round(hwProfileRaw || 0)} W`;
    }
    if (isPC) {
      const parts = [];
      if (Math.round(gpuTDP || 0) > 0) parts.push(`GPU: ${Math.round(gpuTDP)} W`);
      if (Math.round(cpuTDP || 0) > 0) parts.push(`CPU: ${Math.round(cpuTDP)} W`);
      if (Math.round(memPowerW || 0) > 0) parts.push(`Mem: ${Math.round(memPowerW)} W`);
      if (parts.length > 0) return parts.join(' + ');
    }
    return `unit: ${Math.round(hwProfileRaw || 0)} W`;
  })();
  const _powerCalcBreakdown = (() => {
    const dt = hardware.deviceType;
    const isLaptop = dt === 'Laptop';
    const isPC = dt === 'Desktop' || dt === 'PC' || dt === 'Server';
    const isASIC = dt === 'ASIC';
    const isMac = dt === 'Mac';
    if (isLaptop) {
      return `unit: ${Math.round(unitFullPowerW)} W`;
    }
    if (isASIC) return `unit: ${unitFullPowerW > 0 ? unitFullPowerW : 3500} W`;
    if (isMac) return `unit: ${unitFullPowerW} W`;
    if (isPC) {
      const parts = [];
      if (Math.round(calibratedGpuTDP) > 0) parts.push(`GPU: ${Math.round(calibratedGpuTDP)} W`);
      if (Math.round(calibratedCpuTDP) > 0) parts.push(`CPU: ${Math.round(calibratedCpuTDP)} W`);
      if (Math.round(calibratedMemPowerW) > 0) parts.push(`Mem: ${Math.round(calibratedMemPowerW)} W`);
      if (parts.length > 0) return parts.join(' + ');
      return `unit: ${unitFullPowerW} W`;
    }
    return `unit: ${unitFullPowerW} W`;
  })();
  const _liveWattageSmallLabel = `Power used live (estimated): ${fmtNum(totalPowerUsedW, 2)} W`;
  const _normalizedConfidenceLabel = CONFIDENCE_TIER_LABELS.estimated;
  const _normalizedEnergyLabel = 'Telemetry energy: model-driven (local miner accounting only)';
  const _powerTrustLabel = 'unattested (no live sensors)';

  return {
    powerW: totalPowerUsedW,
    cpuTDP,
    gpuTDP,
    memPowerW,
    hwProfileRaw,
    unitFullPowerW,
    basePowerW,
    effectiveLoadPercent,
    trustLoadCap,
    clampedLoadPercent,
    laptopTDP,
    hardwareCardPowerCalcBreakdown,
    _powerCalcBreakdown,
    _liveWattageSmallLabel,
    _normalizedConfidenceLabel,
    _normalizedEnergyLabel,
    _powerTrustLabel,
    _powerSourceLabel,
    _normalizedConfidenceTier: 'estimated',
    _normalizedSourceName: 'local hardware profile model',
    _powerSourceAccent: '#4a7a4a',
    _miningPowerUsedW: 0, // caller sets based on mining state
  };
}
