'use strict';

let _getAsicConfig = null;
let _asicDrivers = null;
let _stratumHandles = null;

function setDeps(getAsicConfigFn, asicDriversRef, getStratumHandlesFn) {
  _getAsicConfig = getAsicConfigFn;
  _asicDrivers = asicDriversRef;
  _stratumHandles = getStratumHandlesFn;
}

async function verifyAsicLiveness(_modelName) {
  const config = _getAsicConfig();

  if (config.length > 0) {
    const results = [];
    for (const entry of config) {
      try {
        const driver = _asicDrivers.getDriver(entry.driverName || 'cgminer');
        if (!driver) throw new Error(`no driver for ${entry.driverName}`);
        const result = await driver.verifyLiveness(
          entry.ip,
          entry.apiPort,
          entry.stratumPort,
          _stratumHandles(),
          entry.driverConfig,
        );
        results.push({
          ...result,
          driverName: entry.driverName || 'cgminer',
          driverConfig: entry.driverConfig,
        });
      } catch (_) {
        results.push({
          ok: false,
          elapsedMs: 0,
          rounds: 0,
          bytesTotal: 0,
          asicType: '',
          ip: entry.ip,
          telemetry: null,
          shareDelta: null,
          shareRatePerSec: null,
          driverName: entry.driverName || 'cgminer',
          driverConfig: entry.driverConfig,
        });
      }
    }
    const ok = results.find((r) => r.ok);
    return ok || results[results.length - 1];
  }

  const cgminerDriver = _asicDrivers.getDriver('cgminer');
  const PORTS = [4028, 4029, 4030];
  for (const port of PORTS) {
    try {
      const result = await cgminerDriver.verifyLiveness('127.0.0.1', port, null, _stratumHandles());
      return { ...result, driverName: 'cgminer', driverConfig: null };
    } catch (_) {
      /* port not responding */
    }
  }
  return { ok: false, elapsedMs: 0, asicType: '', telemetry: null, driverName: 'cgminer', driverConfig: null };
}

function verifyAsicFirmware(ip, port, checkModel, _modelName, driverName, driverConfig) {
  const driver = _asicDrivers.getDriver(driverName || 'cgminer');
  if (!driver) {
    return { ok: false, identities: [], compileTimes: [], issues: ['unknown driver'] };
  }
  return driver.verifyFirmware(ip, port, checkModel, _modelName, driverConfig);
}

module.exports = { setDeps, verifyAsicLiveness, verifyAsicFirmware };
