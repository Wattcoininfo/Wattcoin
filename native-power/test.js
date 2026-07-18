const path = require('path');

// Try to load the native addon
let power;
try {
  power = require(path.join(__dirname, 'build', 'Release', 'power.node'));
} catch (e) {
  console.error('Failed to load native power addon:', e.message);
  console.error('Make sure to run: cd native-power && node-gyp rebuild');
  process.exit(1);
}

console.log('=== Wattcoin Power Sensor Test ===\n');

// Initialize sensors
console.log('Initializing sensors...');
const info = power.init();
console.log('  EMI (Intel RAPL):', info.emi ? 'AVAILABLE' : 'not available');
console.log('  NVML (NVIDIA):    ', info.nvml ? 'AVAILABLE' : 'not available');
console.log('  PDH (Counters):   ', info.pdh ? 'AVAILABLE' : 'not available');

if (info.emiChannels) {
  console.log('\n  EMI Channels:');
  for (const ch of info.emiChannels) {
    const pkg = ch.index === info.pkgChannel ? ' <-- PACKAGE' : '';
    const pp0 = ch.index === info.pp0Channel ? ' <-- PP0 (cores)' : '';
    const dram = ch.index === info.dramChannel ? ' <-- DRAM' : '';
    console.log(`    [${ch.index}] ${ch.name}  unit=${ch.measurementUnit}${pkg}${pp0}${dram}`);
  }
}

if (info.nvmlDevices) {
  console.log('\n  NVIDIA GPUs:');
  for (const dev of info.nvmlDevices) {
    console.log(`    [${dev.index}] ${dev.name}`);
  }
}

// Take 5 readings, 1 second apart
console.log('\n--- Taking 5 readings (1s interval) ---\n');

let reading = 0;
const interval = setInterval(() => {
  reading++;

  const result = power.readAll();

  const cpuStr = result.cpu ? `${result.cpu.watts.toFixed(1)}W (${result.cpu.source})` : 'N/A';

  let cpuDiag = '';
  if (result.cpu && result.cpu.source === 'emi') {
    const e = result.cpu.rawEnergyDelta;
    const t = result.cpu.rawTimeDelta;
    const u = result.cpu.measurementUnit;
    // Possible conversions for measurementUnit >= 100
    const pWh = t > 0 ? (e * 3.6e-9) / (t * 1e-7) : 0; // current (pWh)
    const nJ = t > 0 ? (e * 1e-9) / (t * 1e-7) : 0; // nanojoules
    const nJx100 = t > 0 ? (e * 1e-7) / (t * 1e-7) : 0; // unit×1e-9 as J
    const uWh = t > 0 ? (e * 3.6e-6) / (t * 1e-7) : 0; // microwatt-hours
    const mJ = t > 0 ? (e * 1e-3) / (t * 1e-7) : 0; // millijoules
    cpuDiag = `\n    [unit=${u} rawE=${e} rawT=${t}]\n    [assuming pWh: ${pWh.toFixed(2)}W | nJ: ${nJ.toFixed(2)}W | nJ(unit×1e-9): ${nJx100.toFixed(2)}W | uWh: ${uWh.toFixed(2)}W | mJ: ${mJ.toFixed(2)}W]`;
  }

  const gpuStrs = [];
  if (result.gpus) {
    for (const gpu of result.gpus) {
      gpuStrs.push(`${gpu.watts.toFixed(1)}W ${gpu.name} (${gpu.source})`);
    }
  }

  console.log(`Reading ${reading}/5:`);
  console.log(`  CPU:  ${cpuStr}${cpuDiag}`);
  if (gpuStrs.length > 0) {
    for (const gs of gpuStrs) {
      console.log(`  GPU:  ${gs}`);
    }
  }
  console.log(`  TOTAL: ${result.totalW.toFixed(1)}W  [source: ${result.source}]`);
  console.log('');

  if (reading >= 5) {
    clearInterval(interval);
    power.shutdown();
    console.log('Done. Sensors shut down.');
  }
}, 1000);
