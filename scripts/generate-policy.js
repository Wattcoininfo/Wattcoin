/**
 * generate-policy.js
 *
 * Generates a hardware profile policy JSON file from the same tiers used in
 * LOCAL_HARDWARE_PROFILE_DB, computes its SHA-256 hash, and writes it to disk.
 *
 * Usage:
 *   node scripts/generate-policy.js [--out <path>] [--version <n>]
 *
 * The resulting JSON file is what you host at attestationPolicyFeedUrl.
 * The printed hash is what goes on-chain via:
 *   window.wattcoinHardware.invoke('wattcoin-publish-policy-anchor', policyText)
 *
 * To sign with RSA as well (optional belt-and-suspenders):
 *   node scripts/generate-policy.js --sign-key /path/to/private.pem
 *   (outputs an envelope { policy, signature } instead of raw policy)
 */

'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Mirror of LOCAL_HARDWARE_PROFILE_DB from electron-main.js ─────────────────
// Keep in sync when you update the in-app defaults.
const DEFAULT_PROFILES = [
  {
    id: 'desktop-high',
    deviceTypeRegex: '',
    cpuRegex: 'i9|ryzen\\s*9|threadripper|epyc|xeon',
    gpuRegex: '4090|4080|3090|3080|7900|6900|6800',
    conservativeCapW: 130,
    maxCapW: 520,
    stepW: 35,
    minCpuOpsPerSec: 260000,
    minMemoryMBps: 800,
    spotCheckProbability: 0.08,
  },
  {
    id: 'desktop-mid',
    deviceTypeRegex: 'desktop|pc|server',
    cpuRegex: '',
    gpuRegex: '',
    conservativeCapW: 95,
    maxCapW: 360,
    stepW: 25,
    minCpuOpsPerSec: 170000,
    minMemoryMBps: 650,
    spotCheckProbability: 0.06,
  },
  {
    id: 'laptop',
    deviceTypeRegex: 'laptop|notebook',
    cpuRegex: '',
    gpuRegex: '',
    conservativeCapW: 45,
    maxCapW: 130,
    stepW: 10,
    minCpuOpsPerSec: 120000,
    minMemoryMBps: 500,
    spotCheckProbability: 0.04,
  },
  {
    id: 'fallback',
    deviceTypeRegex: '',
    cpuRegex: '',
    gpuRegex: '',
    conservativeCapW: 70,
    maxCapW: 220,
    stepW: 15,
    minCpuOpsPerSec: 100000,
    minMemoryMBps: 450,
    spotCheckProbability: 0.05,
  },
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { out: null, version: 1, signKey: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out' && args[i + 1]) opts.out = args[++i];
    else if (args[i] === '--version' && args[i + 1]) opts.version = Number(args[++i]) || 1;
    else if (args[i] === '--sign-key' && args[i + 1]) opts.signKey = args[++i];
  }
  return opts;
}

function main() {
  const opts = parseArgs();
  const policy = {
    version: opts.version,
    issuedAtMs: Date.now(),
    profiles: DEFAULT_PROFILES,
  };

  const policyText = JSON.stringify(policy);
  const policyHash = crypto.createHash('sha256').update(policyText, 'utf8').digest('hex');

  let outputText;
  let outputLabel;

  if (opts.signKey) {
    // RSA-SHA256 envelope mode.
    const keyPem = fs.readFileSync(path.resolve(opts.signKey), 'utf8');
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(policyText);
    signer.end();
    const signature = signer.sign(keyPem, 'base64');
    const envelope = { policy, signature };
    outputText = JSON.stringify(envelope, null, 2);
    outputLabel = 'envelope (policy + RSA signature)';
  } else {
    // Raw policy mode (chain anchor is the sole verification).
    outputText = JSON.stringify(policy, null, 2);
    outputLabel = 'raw policy';
  }

  const outPath = opts.out ? path.resolve(opts.out) : path.resolve(__dirname, '..', 'hardware-policy.json');

  fs.writeFileSync(outPath, outputText, 'utf8');

  console.log('');
  console.log('='.repeat(64));
  console.log(`  Wattcoin Hardware Policy Generator`);
  console.log('='.repeat(64));
  console.log(`  Output:    ${outputPath(outPath)}`);
  console.log(`  Format:    ${outputLabel}`);
  console.log(`  Version:   ${policy.version}`);
  console.log(`  Profiles:  ${policy.profiles.length}`);
  console.log('');
  console.log('  SHA-256 hash (publish this on-chain):');
  console.log(`  ${policyHash}`);
  console.log('');
  console.log('  Next steps:');
  console.log('  1. Host the output file at a public URL (GitHub raw, etc.)');
  console.log('  2. Set attestationPolicyFeedUrl in wattcoin-beta-config.json');
  console.log('  3. In the running Wattcoin Miner app dev tools:');
  console.log("     const txt = require('fs').readFileSync('<outPath>', 'utf8');");
  console.log("     wattcoinHardware.invoke('wattcoin-publish-policy-anchor', txt)");
  console.log('  4. Confirm the returned txid appears in your blockchain.');
  console.log('='.repeat(64));
  console.log('');
}

function outputPath(p) {
  return p.replace(/\\/g, '/');
}

main();
