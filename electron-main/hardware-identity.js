'use strict';

const os = require('os');
const { isUnusableGpuIdentity } = require('./main-utils');

let osHardwareIdentity = null;
let _app = null;
let _si = null;

function setDeps(app, si) {
  _app = app;
  _si = si;
}

async function resolveOsHardwareIdentity() {
  if (osHardwareIdentity) return osHardwareIdentity;
  if (!_app || !_si) return null;

  const cpuModel = ((os.cpus()[0] && os.cpus()[0].model) || '').trim();

  let gpuModels = [];
  try {
    const gpuInfo = await _app.getGPUInfo('basic');
    if (gpuInfo && Array.isArray(gpuInfo.gpuDevice)) {
      gpuModels = gpuInfo.gpuDevice
        .map((d) => {
          const vendor = String(d.vendorString || d.driverVendor || d.vendor || '').trim();
          const model = String(d.deviceString || d.deviceName || d.name || '').trim();
          const named = `${vendor} ${model}`.replace(/\s+/g, ' ').trim();
          if (named && /[a-z]/i.test(named)) return named;
          const fallbackId = String(d.deviceId || d.vendorId || '').trim();
          return fallbackId;
        })
        .map((s) => String(s || '').trim())
        .filter(Boolean);
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  if (!gpuModels.length || gpuModels.every((g) => isUnusableGpuIdentity(g))) {
    try {
      const graphics = await _si.graphics();
      if (graphics && Array.isArray(graphics.controllers)) {
        gpuModels = graphics.controllers.map((c) => (c.model || c.name || '').trim()).filter(Boolean);
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  gpuModels = gpuModels.filter((g) => !isUnusableGpuIdentity(g));

  let chassisType = '';
  let deviceType = 'PC';
  const LAPTOP_CHASSIS_CODES = ['8', '9', '10', '14'];
  try {
    const chassis = await _si.chassis();
    chassisType = String((chassis && chassis.type) || '').trim();
    if (/notebook|laptop|portable/i.test(chassisType) || LAPTOP_CHASSIS_CODES.includes(chassisType))
      deviceType = 'Laptop';
    else if (/server/i.test(chassisType)) deviceType = 'Server';
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  if (deviceType === 'PC') {
    try {
      const battery = await _si.battery();
      if (battery && battery.hasBattery) deviceType = 'Laptop';
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  let isVM = false;
  let vmType = '';
  try {
    const sysInfo = await _si.system();
    if (sysInfo && sysInfo.virtual) {
      isVM = true;
      vmType = String(sysInfo.virtual);
    }
    const mfr = String((sysInfo && sysInfo.manufacturer) || '').toLowerCase();
    const model = String((sysInfo && sysInfo.model) || '').toLowerCase();
    const vmHints = /virtualbox|vmware|qemu|kvm|xen|hyper-v|parallels|bhyve|bochs|innotek|virtual machine/i;
    if (vmHints.test(mfr) || vmHints.test(model)) {
      isVM = true;
      if (!vmType) vmType = mfr || model;
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  if (!isVM) {
    const cpuLower = cpuModel.toLowerCase();
    if (/qemu|virtual|kvm/i.test(cpuLower)) {
      isVM = true;
      vmType = 'cpu-string-hint';
    }
  }

  if (!isVM && gpuModels.length > 0) {
    const vmGpuHints = /virtualbox|vmware|microsoft basic|hyper-v|qxl|virtio|red hat|bochs/i;
    if (gpuModels.some((g) => vmGpuHints.test(g))) {
      isVM = true;
      vmType = 'virtual-gpu';
    }
  }

  osHardwareIdentity = { cpuModel, gpuModels, chassisType, deviceType, isVM, vmType };
  console.log(
    `[HW-Identity] OS-level: cpu="${cpuModel}", gpus=[${gpuModels.join(', ')}], chassis="${chassisType}", type="${deviceType}", vm=${isVM}${isVM ? ' (' + vmType + ')' : ''}`,
  );
  return osHardwareIdentity;
}

module.exports = { setDeps, resolveOsHardwareIdentity };
