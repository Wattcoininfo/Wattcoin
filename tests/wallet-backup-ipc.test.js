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
  const { registerWalletBackupIpcHandlers } = require('../electron-main/wallet-backup-ipc');

  await test('registerWalletBackupIpcHandlers is a function', () => {
    assert.strictEqual(typeof registerWalletBackupIpcHandlers, 'function');
  });

  // registerWalletBackupIpcHandlers requires an Electron runtime to actually
  // register IPC handlers (ipcMain.handle). Tests requiring Electron are
  // skipped in this plain-Node test runner.

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
