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
  const mod = require('../electron-main/electron-utils');

  await test('getFocusedWindow is a function', () => {
    assert.strictEqual(typeof mod.getFocusedWindow, 'function');
  });

  await test('getAppDisplayVersion is a function', () => {
    assert.strictEqual(typeof mod.getAppDisplayVersion, 'function');
  });

  await test('createWindow is a function', () => {
    assert.strictEqual(typeof mod.createWindow, 'function');
  });

  await test('getRateLockFilePath is a function', () => {
    assert.strictEqual(typeof mod.getRateLockFilePath, 'function');
  });

  await test('getHwAuthStatePath is a function', () => {
    assert.strictEqual(typeof mod.getHwAuthStatePath, 'function');
  });

  await test('getHwFingerprintPath is a function', () => {
    assert.strictEqual(typeof mod.getHwFingerprintPath, 'function');
  });

  await test('getBenchmarkHistoryPath is a function', () => {
    assert.strictEqual(typeof mod.getBenchmarkHistoryPath, 'function');
  });

  await test('getDiscoveredSeedPeerCachePath is a function', () => {
    assert.strictEqual(typeof mod.getDiscoveredSeedPeerCachePath, 'function');
  });

  await test('getRemoteSeedPeerCachePath is a function', () => {
    assert.strictEqual(typeof mod.getRemoteSeedPeerCachePath, 'function');
  });

  await test('getConsumedProofsFilePath is a function', () => {
    assert.strictEqual(typeof mod.getConsumedProofsFilePath, 'function');
  });

  await test('getProbeLogFilePath is a function', () => {
    assert.strictEqual(typeof mod.getProbeLogFilePath, 'function');
  });

  await test('persistDevPeerPrivacyRecoveryKey is a function', () => {
    assert.strictEqual(typeof mod.persistDevPeerPrivacyRecoveryKey, 'function');
  });

  // Functional tests require Electron at runtime.

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
