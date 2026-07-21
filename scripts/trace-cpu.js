#!/usr/bin/env node
'use strict';
/**
 * Standalone CPU profiler — requires the main-process modules that run
 * during normal operation and captures a 10-second V8 CPU profile.
 *
 * Usage: node scripts/trace-cpu.js
 * Output: ~/Desktop/wattcoin-profiles/manual-profile-<ts>.cpuprofile
 */
const v8 = require('v8');
const fs = require('fs');
const path = require('path');
const os = require('os');

const profileDir = path.join(os.homedir(), 'Desktop', 'wattcoin-profiles');
try {
  fs.mkdirSync(profileDir, { recursive: true });
} catch (_) {
  /* ignore */
}

const profileName = `manual-trace-${Date.now()}`;
console.log(`[Trace] Starting V8 profile "${profileName}" for 15 seconds...`);
console.log('[Trace] Loading modules...');

// Load the main-process modules that run continuously
try {
  // Peer discovery — has UDP listeners
  require('../electron-main/peer-discovery');
  console.log('[Trace] peer-discovery loaded');
} catch (e) {
  console.log('[Trace] peer-discovery load error:', e.message);
}

try {
  // Token verification — has verifyBurnProof (SHA-256 on main thread)
  require('../electron-main/token-verification');
  console.log('[Trace] token-verification loaded');
} catch (e) {
  console.log('[Trace] token-verification load error:', e.message);
}

try {
  // Local stratum — X11 share verification
  require('../electron-main/local-stratum');
  console.log('[Trace] local-stratum loaded');
} catch (e) {
  console.log('[Trace] local-stratum load error:', e.message);
}

try {
  // Hardware load controller — the TICK and workers
  require('../electron-main/hardware-load-controller');
  console.log('[Trace] hardware-load-controller loaded');
} catch (e) {
  console.log('[Trace] hardware-load-controller load error:', e.message);
}

try {
  // WTC node — blockchain sync
  require('../electron-main/wtc-node');
  console.log('[Trace] wtc-node loaded');
} catch (e) {
  console.log('[Trace] wtc-node load error:', e.message);
}

try {
  // Governance
  require('../electron-main/governance');
  console.log('[Trace] governance loaded');
} catch (e) {
  console.log('[Trace] governance load error:', e.message);
}

try {
  // Ops health
  require('../electron-main/ops-health');
  console.log('[Trace] ops-health loaded');
} catch (e) {
  console.log('[Trace] ops-health load error:', e.message);
}

console.log('[Trace] All modules loaded. Starting profile...');

const prof = v8.startProfiling(profileName, false);

// Capture periodic CPU snapshots
const cpuBefore = process.cpuUsage();
const wallStart = Date.now();

setInterval(() => {
  const elapsed = ((Date.now() - wallStart) / 1000).toFixed(1);
  const cpuDelta = process.cpuUsage(cpuBefore);
  const userMs = (cpuDelta.user / 1000).toFixed(0);
  const sysMs = (cpuDelta.system / 1000).toFixed(0);
  console.log(`[Trace] +${elapsed}s — user=${userMs}ms system=${sysMs}ms`);
}, 2000);

// Stop after 15 seconds
setTimeout(() => {
  console.log('[Trace] Stopping profile...');
  const data = prof.stop();
  const filePath = path.join(profileDir, `${profileName}.cpuprofile`);
  fs.writeFileSync(filePath, JSON.stringify(data));
  console.log(`[Trace] Profile saved to ${filePath}`);
  console.log('[Trace] Open in Chrome DevTools: Performance tab → Load profile');
  process.exit(0);
}, 15000);
