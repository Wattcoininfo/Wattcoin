'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CURVE_VERSION = 1;
const CURVE_STEPS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

function createHandlers(deps) {
  const { getPowerCurvePath, computeHwAuthSig, getHwFingerprintPath } = deps;

  let _curveCache = null;

  function loadPowerCurve() {
    try {
      const filePath = getPowerCurvePath();
      if (_curveCache && fs.existsSync(filePath)) return _curveCache;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const { sig, ...data } = parsed;
      if (sig) {
        const expected = computeHwAuthSig(data);
        if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
          console.warn('[powerCurve] Tampered curve detected - ignoring.');
          return null;
        }
      }
      if (data.version !== CURVE_VERSION) return null;
      if (!Array.isArray(data.steps) || data.steps.length < 2) return null;
      _curveCache = data;
      return data;
    } catch (_) {
      return null;
    }
  }

  function savePowerCurve(curve) {
    try {
      const p = getPowerCurvePath();
      const data = { ...curve, version: CURVE_VERSION, sig: undefined };
      const sig = computeHwAuthSig(data);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ ...data, sig }, null, 2), 'utf8');
      _curveCache = { ...data, sig };
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function clearPowerCurve() {
    try {
      const p = getPowerCurvePath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      _curveCache = null;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function isCurveValidForHardware(curve) {
    if (!curve || !curve.hardwareHash) return false;
    try {
      const fpRaw = fs.readFileSync(getHwFingerprintPath(), 'utf8');
      const fpParsed = JSON.parse(fpRaw);
      return fpParsed && fpParsed.hash === curve.hardwareHash;
    } catch (_) {
      return false;
    }
  }

  function interpolatePower(curve, loadPercent) {
    if (!curve || !Array.isArray(curve.steps) || curve.steps.length === 0) return 0;
    const pct = Math.max(0, Math.min(100, Number(loadPercent) || 0));
    const steps = curve.steps;
    if (steps.length === 1) return steps[0].avgPowerW;
    if (pct <= steps[0].loadPercent) return steps[0].avgPowerW;
    if (pct >= steps[steps.length - 1].loadPercent) return steps[steps.length - 1].avgPowerW;
    for (let i = 0; i < steps.length - 1; i++) {
      const a = steps[i];
      const b = steps[i + 1];
      if (pct >= a.loadPercent && pct <= b.loadPercent) {
        const t = (pct - a.loadPercent) / (b.loadPercent - a.loadPercent);
        return a.avgPowerW + t * (b.avgPowerW - a.avgPowerW);
      }
    }
    return steps[steps.length - 1].avgPowerW;
  }

  function interpolateOpsPerMs(curve, loadPercent) {
    if (!curve || !Array.isArray(curve.steps) || curve.steps.length === 0) return 0;
    const pct = Math.max(0, Math.min(100, Number(loadPercent) || 0));
    const steps = curve.steps;
    if (steps.length === 1) return steps[0].avgOpsPerMs;
    if (pct <= steps[0].loadPercent) return steps[0].avgOpsPerMs;
    if (pct >= steps[steps.length - 1].loadPercent) return steps[steps.length - 1].avgOpsPerMs;
    for (let i = 0; i < steps.length - 1; i++) {
      const a = steps[i];
      const b = steps[i + 1];
      if (pct >= a.loadPercent && pct <= b.loadPercent) {
        const t = (pct - a.loadPercent) / (b.loadPercent - a.loadPercent);
        return a.avgOpsPerMs + t * (b.avgOpsPerMs - a.avgOpsPerMs);
      }
    }
    return steps[steps.length - 1].avgOpsPerMs;
  }

  return {
    loadPowerCurve,
    savePowerCurve,
    clearPowerCurve,
    isCurveValidForHardware,
    interpolatePower,
    interpolateOpsPerMs,
    CURVE_STEPS,
  };
}

module.exports = { createHandlers };
