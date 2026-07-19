// TDP tables are no longer used for power calculation.
// import { cpuTDPTable, gpuTDPTable, cpuPowerTable, gpuPowerTable, asicPowerTable } from './minerTDPTables';

const MAX_HARDWARE_LOAD_PERCENT = 85;

const CONFIDENCE_TIER_LABELS = {
  measured: 'Measured (hardware sensor)',
  derived: 'Derived (counter delta)',
  estimated: 'Estimated (model)',
};

const fmtNum = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

function interpolateCurveValue(steps, loadPercent, valueKey) {
  if (!steps || steps.length === 0) return 0;
  const pct = Math.max(0, Math.min(100, Number(loadPercent) || 0));
  if (steps.length === 1) return steps[0][valueKey];
  if (pct >= steps[steps.length - 1].loadPercent) return steps[steps.length - 1][valueKey];
  // Extrapolate below the lowest measured step down to 0 at 0% load
  if (pct <= steps[0].loadPercent) {
    const t = pct / steps[0].loadPercent;
    return t * steps[0][valueKey];
  }
  for (let i = 0; i < steps.length - 1; i++) {
    const a = steps[i];
    const b = steps[i + 1];
    if (pct >= a.loadPercent && pct <= b.loadPercent) {
      const t = (pct - a.loadPercent) / (b.loadPercent - a.loadPercent);
      return a[valueKey] + t * (b[valueKey] - a[valueKey]);
    }
  }
  return steps[steps.length - 1][valueKey];
}

export function estimateHardwarePower({
  hardware: _hardware,
  allGpuModels: _allGpuModels,
  isWholeDeviceMiniPcModel: _isWholeDeviceMiniPcModel,
  loadPercent,
  trustScore,
  benchmarkOpsCalibration: _benchmarkOpsCalibration,
  benchmarkGpuCalibration: _benchmarkGpuCalibration,
  isHardwareOnHold,
  benchPower: _benchPower,
  powerCurve,
}) {
  let powerW = 0;
  let usedCurve = false;

  // ── Power curve path (measured via live sensors) ──────────────────────────
  // When a valid power curve exists, interpolate actual measured power directly.
  // TDP tables are NOT used as the power source — only for display/fallback.
  if (powerCurve && Array.isArray(powerCurve.steps) && powerCurve.steps.length >= 2 && powerCurve.measuredWithSensors) {
    usedCurve = true;
    powerW = interpolateCurveValue(powerCurve.steps, loadPercent, 'avgPowerW');
  }

  // ── No power curve yet ────────────────────────────────────────────────
  // TDP tables are NOT used for power calculation. Without a measured
  // power curve, power is unknown — mining is blocked until the curve
  // benchmark establishes measured values.
  if (!usedCurve) {
    powerW = 0;
  }

  const clampedLoadPercent = Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, Number(loadPercent) || 0));

  const hwProfileRaw = powerW;

  // unitFullPowerW: from curve maxPowerW (measured) or 0 (no curve yet)
  let unitFullPowerW;
  if (usedCurve && powerCurve && powerCurve.maxPowerW > 0) {
    unitFullPowerW = Math.round(powerCurve.maxPowerW);
  } else {
    unitFullPowerW = 0;
  }

  const trustLoadCap =
    trustScore <= 70 ? Math.round(20 + trustScore * (50 / 70)) : Math.round(70 + (trustScore - 70) * 0.5);
  const effectiveLoadPercent = Math.min(clampedLoadPercent, trustLoadCap);
  const basePowerW = Math.round((unitFullPowerW * trustLoadCap) / 100);

  // Final powerW: linear fraction of measured max power at the effective load level.
  // Not curve-interpolated because CPU package power doesn't scale linearly with
  // duty cycle (EMI/RAPL reads near-max at high loads).  Linear scaling matches
  // the user's expectation: 85% load → 85% of max power.
  if (usedCurve) {
    powerW = (unitFullPowerW * effectiveLoadPercent) / 100;
  } else {
    powerW = 0;
  }
  if (isHardwareOnHold) powerW = 0;
  const totalPowerUsedW = powerW;

  const _powerSourceLabel = usedCurve ? 'live sensor measurement' : 'power curve not yet calibrated';
  const hardwareCardPowerCalcBreakdown = (() => {
    if (usedCurve) {
      const maxW = powerCurve ? powerCurve.maxPowerW : 0;
      return `measured: ${fmtNum(maxW, 1)} W @ 100%`;
    }
    return 'pending calibration';
  })();
  const _powerCalcBreakdown = (() => {
    if (usedCurve) {
      return `curve: ${fmtNum(unitFullPowerW, 0)} W × ${effectiveLoadPercent}%`;
    }
    return 'pending calibration';
  })();
  const _liveWattageSmallLabel = usedCurve
    ? `Power used live (measured): ${fmtNum(totalPowerUsedW, 2)} W`
    : 'Power used live: pending calibration';
  const _normalizedConfidenceLabel = usedCurve ? CONFIDENCE_TIER_LABELS.measured : 'Not calibrated';
  const _normalizedEnergyLabel = usedCurve
    ? 'Telemetry energy: live sensor measurement'
    : 'Telemetry energy: pending power curve calibration';
  const _powerTrustLabel = usedCurve ? 'measured (live sensors)' : 'unmeasured (no power curve)';
  const _normalizedConfidenceTier = usedCurve ? 'measured' : 'unmeasured';
  const _normalizedSourceName = usedCurve ? 'live power sensor curve' : 'pending calibration';
  const _powerSourceAccent = usedCurve ? '#a7ffb0' : '#facc15';

  return {
    powerW: totalPowerUsedW,
    cpuTDP: usedCurve ? null : hwProfileRaw,
    gpuTDP: usedCurve ? null : null,
    hwProfileRaw,
    unitFullPowerW,
    basePowerW,
    effectiveLoadPercent,
    trustLoadCap,
    clampedLoadPercent,
    laptopTDP: null,
    hardwareCardPowerCalcBreakdown,
    _powerCalcBreakdown,
    _liveWattageSmallLabel,
    _normalizedConfidenceLabel,
    _normalizedEnergyLabel,
    _powerTrustLabel,
    _powerSourceLabel,
    _normalizedConfidenceTier,
    _normalizedSourceName,
    _powerSourceAccent,
    _miningPowerUsedW: 0,
    _usedPowerCurve: usedCurve,
  };
}
