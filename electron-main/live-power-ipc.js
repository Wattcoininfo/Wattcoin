'use strict';
/**
 * live-power-ipc.js — IPC handler for live hardware power reading
 *
 * Uses the native-power N-API addon to read real wattage from
 * EMI / RAPL driver / NVML / ADL / PDH sensors. Lazy-loads the addon
 * on first call so the app starts even if the .node file is missing.
 */
const path = require('path');

let _powerAddon = null;
let _initResult = null;
let _addonLoadAttempted = false;

function _loadAddon() {
  if (_addonLoadAttempted) return;
  _addonLoadAttempted = true;
  // Packaged app: power.node is in resources/native-power/power.node
  // Dev mode: power.node is in native-power/build/Release/power.node
  const candidates = [
    path.join(process.resourcesPath || '', 'native-power', 'power.node'),
    path.join(__dirname, '..', 'native-power', 'build', 'Release', 'power.node'),
  ];
  for (const candidate of candidates) {
    try {
      _powerAddon = require(candidate);
      _initResult = _powerAddon.init();
      console.warn('[LivePower] init:', JSON.stringify(_initResult, null, 2));
      return;
    } catch (_) {
      /* try next */
    }
  }
  _powerAddon = null;
  _initResult = null;
}

function registerLivePowerIpcHandlers(ipcMain) {
  ipcMain.handle('wattcoin-get-live-power', () => {
    _loadAddon();

    if (!_powerAddon) {
      return { ok: false, totalW: 0, cpuW: 0, gpus: [], source: 'unavailable' };
    }

    try {
      const result = _powerAddon.readAll();
      const cpuW = result.cpu ? result.cpu.watts : 0;
      const cpuSource = result.cpu ? result.cpu.source : 'none';
      const gpus = (result.gpus || []).map((g) => ({
        watts: g.watts,
        name: g.name || '',
        source: g.source || '',
      }));
      const gpuTotal = gpus.reduce((s, g) => s + (g.watts || 0), 0);
      if (process.env.WATTCOIN_DEBUG) {
        console.warn(
          `[LivePower] cpu=${cpuW.toFixed(1)}W(${cpuSource}) gpu=${gpuTotal.toFixed(1)}W(${gpus.length} devices) total=${(result.totalW || 0).toFixed(1)}W src=${result.source || '?'}`,
        );
      }
      const response = {
        ok: true,
        totalW: result.totalW || 0,
        cpuW,
        gpus,
        source: result.source || 'unknown',
      };
      // Forward EMI diagnostics for the renderer console (measurementUnit, raw counters)
      if (result.cpu && result.cpu.source === 'emi') {
        response.cpuDiag = {
          measurementUnit: result.cpu.measurementUnit,
          rawEnergyDelta: result.cpu.rawEnergyDelta,
          rawTimeDelta: result.cpu.rawTimeDelta,
          bytesReturned: result.cpu.bytesReturned,
          channelCount: result.cpu.channelCount,
          allChannels: result.cpu.allChannels || [],
        };
      }
      // Include init diagnostics on the first response so the renderer can log them.
      if (_initResult && !_initResult._reported) {
        response.init = _initResult;
        _initResult._reported = true;
      }
      return response;
    } catch (_) {
      return { ok: false, totalW: 0, cpuW: 0, gpus: [], source: 'error' };
    }
  });
}

module.exports = { registerLivePowerIpcHandlers, readEnergySnapshot, readLivePowerW, getSensorInitInfo };

/**
 * Read live power in watts from the lazy-loaded addon.
 * Returns { totalW, cpuW, gpus, source } or null if no sensor is available.
 */
function readLivePowerW() {
  _loadAddon();
  if (!_powerAddon) return null;
  try {
    const result = _powerAddon.readAll();
    if (!result) return null;
    return {
      totalW: result.totalW || 0,
      cpuW: result.cpu ? result.cpu.watts : 0,
      gpus: (result.gpus || []).map((g) => ({
        watts: g.watts,
        name: g.name || '',
        source: g.source || '',
      })),
      source: result.source || 'unknown',
    };
  } catch (_) {
    return null;
  }
}

/**
 * Return the init result from the lazy-loaded addon (sensor availability flags).
 * Returns { emi, rapl, nvml, adl, pdh } or null.
 */
function getSensorInitInfo() {
  _loadAddon();
  return _initResult || null;
}

/**
 * Read a raw energy snapshot from the hardware sensor (µJ).
 * Used by peer-probe-ipc.js to bracket proof computation for cross-validation.
 * Returns { energyUj, timeMs, source } or null if no sensor is available.
 */
function readEnergySnapshot() {
  _loadAddon();
  if (!_powerAddon || typeof _powerAddon.readEnergyUj !== 'function') return null;
  try {
    return _powerAddon.readEnergyUj();
  } catch (_) {
    return null;
  }
}
