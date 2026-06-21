const cgminer = require('./cgminer');
const nmminer = require('./nmminer');
const webminer = require('./webminer');

const DRIVERS = [cgminer, nmminer, webminer];
const DRIVER_MAP = Object.fromEntries(DRIVERS.map((d) => [d.name, d]));

function getDriver(name) {
  return DRIVER_MAP[name] || null;
}

function getAllDrivers() {
  return DRIVERS;
}

async function detectAsic(ip) {
  const allPorts = [...new Set(DRIVERS.flatMap((d) => d.probePorts))];

  for (const port of allPorts) {
    for (const driver of DRIVERS) {
      if (!driver.probePorts.includes(port)) continue;
      try {
        const result = await driver.detect(ip, port);
        if (result && result.isAsic) {
          return { ...result, apiPort: port };
        }
      } catch {}
    }
  }
  return null;
}

async function tryDetectAll(ip) {
  const results = [];
  const allPorts = [...new Set(DRIVERS.flatMap((d) => d.probePorts))];

  for (const port of allPorts) {
    for (const driver of DRIVERS) {
      if (!driver.probePorts.includes(port)) continue;
      try {
        const result = await driver.detect(ip, port);
        if (result && result.isAsic) {
          results.push({ ...result, apiPort: port });
        }
      } catch {}
    }
  }
  return results;
}

module.exports = {
  getDriver,
  getAllDrivers,
  detectAsic,
  tryDetectAll,
  DRIVERS,
};
