'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createHandlers(getHwFingerprintPath, getBenchmarkHistoryPath, computeHwAuthSig) {
  let _benchHistCache = null;
  let _benchHistCachePath = '';

  function loadHwFingerprint() {
    try {
      const raw = fs.readFileSync(getHwFingerprintPath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const { sig, ...data } = parsed;
      if (sig) {
        const expected = computeHwAuthSig(data);
        if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
          console.warn('[hwFingerprint] Tampered fingerprint detected - ignoring.');
          return null;
        }
      }
      return data;
    } catch (_) {
      return null;
    }
  }

  function saveHwFingerprint(data) {
    try {
      const p = getHwFingerprintPath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ ...data, sig: computeHwAuthSig(data) }), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function clearHwFingerprint() {
    try {
      fs.unlinkSync(getHwFingerprintPath());
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function loadBenchmarkHistory() {
    const empty = { cpuSamples: [], memSamples: [], gpuSamples: [], jitterSamples: [] };
    try {
      const filePath = getBenchmarkHistoryPath();
      if (_benchHistCache && _benchHistCachePath === filePath) return _benchHistCache;
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return empty;
      const { sig, ...data } = parsed;
      if (sig) {
        const expected = computeHwAuthSig(data);
        if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
          console.warn('[benchmarkHistory] Tampered history - resetting.');
          return empty;
        }
      }
      const result = {
        cpuSamples: Array.isArray(data.cpuSamples)
          ? data.cpuSamples.map(Number).filter((v) => isFinite(v) && v > 0)
          : [],
        memSamples: Array.isArray(data.memSamples)
          ? data.memSamples.map(Number).filter((v) => isFinite(v) && v > 0)
          : [],
        gpuSamples: Array.isArray(data.gpuSamples)
          ? data.gpuSamples.map(Number).filter((v) => isFinite(v) && v > 0)
          : [],
        jitterSamples: Array.isArray(data.jitterSamples)
          ? data.jitterSamples.map(Number).filter((v) => isFinite(v) && v >= 0)
          : [],
      };
      _benchHistCache = result;
      _benchHistCachePath = filePath;
      return result;
    } catch (_) {
      return empty;
    }
  }

  function saveBenchmarkHistory(history) {
    try {
      const p = getBenchmarkHistoryPath();
      const data = {
        cpuSamples: history.cpuSamples,
        memSamples: history.memSamples,
        gpuSamples: history.gpuSamples,
        jitterSamples: history.jitterSamples,
      };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ ...data, sig: computeHwAuthSig(data) }), 'utf8');
      _benchHistCache = null;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function clearBenchmarkHistory() {
    try {
      fs.unlinkSync(getBenchmarkHistoryPath());
      _benchHistCache = null;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  return {
    loadHwFingerprint,
    saveHwFingerprint,
    clearHwFingerprint,
    loadBenchmarkHistory,
    saveBenchmarkHistory,
    clearBenchmarkHistory,
  };
}

module.exports = { createHandlers };
