// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const path = require('path');
const os = require('os');

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
  const { getDataDir, getActiveNetwork } = require('../electron-main/env');

  await test('getDataDir returns correct path', () => {
    assert.strictEqual(getDataDir(), path.join(os.homedir(), 'WattcoinMinerUserData'));
  });

  await test('getActiveNetwork returns wtc-mainnet', () => {
    assert.strictEqual(getActiveNetwork(), 'wtc-mainnet');
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
