// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

async function run() {
  const {
    normalizeRemoteProfile,
    buildAttestationMessage,
    shouldAllowGpuWorkloadsForSummary,
  } = require('../electron-main/hardware-profiles');

  // ─── normalizeRemoteProfile ────────────────────────────────────────────────

  await test('normalizeRemoteProfile returns null for empty id', () => {
    assert.strictEqual(normalizeRemoteProfile({}), null);
    assert.strictEqual(normalizeRemoteProfile({ id: '' }), null);
  });

  await test('normalizeRemoteProfile returns profile with id', () => {
    const profile = normalizeRemoteProfile({ id: 'test-profile' });
    assert.ok(profile);
    assert.strictEqual(profile.id, 'test-profile');
  });

  await test('normalizeRemoteProfile sets default cap values', () => {
    const profile = normalizeRemoteProfile({ id: 'p1' });
    assert.strictEqual(profile.conservativeCapW, 10);
    assert.strictEqual(profile.maxCapW, 10);
    assert.strictEqual(profile.stepW, 10);
    assert.strictEqual(profile.minCpuOpsPerSec, 100_000);
    assert.strictEqual(profile.minMemoryMBps, 400);
    assert.strictEqual(profile.spotCheckProbability, 0.05);
    assert.strictEqual(profile.requireGpuProof, false);
  });

  await test('normalizeRemoteProfile caps maxCapW at conservativeCapW minimum', () => {
    const profile = normalizeRemoteProfile({ id: 'p1', conservativeCapW: 50, maxCapW: 20 });
    assert.strictEqual(profile.conservativeCapW, 50);
    assert.strictEqual(profile.maxCapW, 50);
  });

  await test('normalizeRemoteProfile allows higher maxCapW than conservativeCapW', () => {
    const profile = normalizeRemoteProfile({ id: 'p1', conservativeCapW: 50, maxCapW: 200 });
    assert.strictEqual(profile.conservativeCapW, 50);
    assert.strictEqual(profile.maxCapW, 200);
  });

  await test('normalizeRemoteProfile clamps spotCheckProbability to 0-0.5', () => {
    const tooHigh = normalizeRemoteProfile({ id: 'p1', spotCheckProbability: 1 });
    assert.strictEqual(tooHigh.spotCheckProbability, 0.5);
    const tooLow = normalizeRemoteProfile({ id: 'p1', spotCheckProbability: -1 });
    assert.strictEqual(tooLow.spotCheckProbability, 0);
  });

  await test('normalizeRemoteProfile match function tests regex patterns', () => {
    const profile = normalizeRemoteProfile({
      id: 'gpu-profile',
      deviceTypeRegex: 'GPU|ASIC',
      cpuRegex: 'Ryzen|Intel',
      gpuRegex: 'RTX|NVIDIA',
    });
    assert.ok(profile.match({ deviceType: 'GPU', cpu: 'Ryzen', gpu: 'RTX 3080' }));
    assert.ok(!profile.match({ deviceType: 'CPU', cpu: 'Ryzen', gpu: 'RTX 3080' }));
    assert.ok(!profile.match({ deviceType: 'GPU', cpu: 'ARM', gpu: 'RTX 3080' }));
    assert.ok(!profile.match({ deviceType: 'GPU', cpu: 'Ryzen', gpu: 'AMD' }));
  });

  await test('normalizeRemoteProfile match returns true when no regexes set', () => {
    const profile = normalizeRemoteProfile({ id: 'any' });
    assert.ok(profile.match({ deviceType: 'whatever', cpu: 'any', gpu: 'anything' }));
  });

  await test('normalizeRemoteProfile captures requireGpuProof flag', () => {
    const profile = normalizeRemoteProfile({ id: 'p1', requireGpuProof: true });
    assert.strictEqual(profile.requireGpuProof, true);
  });

  // ─── buildAttestationMessage ────────────────────────────────────────────────

  await test('buildAttestationMessage formats challenge into attestation message', () => {
    const challenge = {
      id: 'abc123',
      challengeSeed: 42,
      expiresAtMs: 1000,
      minerId: 'miner-1',
    };
    const result = buildAttestationMessage(challenge);
    assert.strictEqual(result, 'WATTCOIN_ATTEST:abc123:42:1000:miner-1');
  });

  await test('buildAttestationMessage handles large numbers', () => {
    const challenge = {
      id: 'big',
      challengeSeed: 2147483647,
      expiresAtMs: 9999999999999,
      minerId: 'a'.repeat(64),
    };
    const result = buildAttestationMessage(challenge);
    assert.ok(result.startsWith('WATTCOIN_ATTEST:big:2147483647:9999999999999:'));
  });

  // ─── shouldAllowGpuWorkloadsForSummary ─────────────────────────────────────

  await test('shouldAllowGpuWorkloadsForSummary returns false for laptop device types', () => {
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'RTX 3080', deviceType: 'Laptop' }), false);
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'RTX 3080', deviceType: 'Notebook' }), false);
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'RTX 3080', deviceType: 'Mini PC' }), false);
  });

  await test('shouldAllowGpuWorkloadsForSummary returns true for no GPU', () => {
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ deviceType: 'Desktop' }), true);
  });

  await test('shouldAllowGpuWorkloadsForSummary allows dedicated desktop GPUs', () => {
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'RTX 4090', deviceType: 'Desktop' }), true);
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'GTX 1080 Ti', deviceType: 'Desktop' }), true);
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'Arc A770', deviceType: 'Desktop' }), true);
  });

  await test('shouldAllowGpuWorkloadsForSummary blocks integrated GPUs', () => {
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'Intel HD Graphics', deviceType: 'Desktop' }), false);
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'Intel UHD Graphics', deviceType: 'Desktop' }), false);
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'Intel Iris Xe', deviceType: 'Desktop' }), false);
  });

  await test('shouldAllowGpuWorkloadsForSummary allows Intel Iris Pro (not blocked)', () => {
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'Intel Iris Pro 580', deviceType: 'Desktop' }), true);
  });

  await test('shouldAllowGpuWorkloadsForSummary blocks Mali and Adreno', () => {
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'Mali-G76', deviceType: 'Desktop' }), false);
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'Adreno 640', deviceType: 'Desktop' }), false);
  });

  await test('shouldAllowGpuWorkloadsForSummary defaults to true for unknown GPUs', () => {
    assert.strictEqual(shouldAllowGpuWorkloadsForSummary({ gpu: 'Custom GPU v2', deviceType: 'Desktop' }), true);
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
