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
  const { registerWalletIpcHandlers } = require('../electron-main/wallet-ipc');

  await test('registerWalletIpcHandlers is a function', () => {
    assert.strictEqual(typeof registerWalletIpcHandlers, 'function');
  });

  // registerWalletIpcHandlers requires an Electron runtime to actually
  // register IPC handlers (ipcMain.handle). Tests requiring Electron are
  // skipped in this plain-Node test runner.

  await test('registerWalletIpcHandlers accepts deps without throwing', () => {
    const ipcMain = {
      handle: () => {},
    };
    registerWalletIpcHandlers({
      ipcMain,
      wtcNode: null,
      getLedgerNetworkSettings: () => ({ enabled: false }),
      enforceEndpointRateLimit: () => ({ ok: true }),
      normalizePeerUrl: (url) => url,
      requestPeerJson: () => null,
      getActivePeers: () => [],
      getCurrentBlockHeight: () => 0,
      settleLocalLedgerRound: () => ({ ok: true }),
      https: { get: () => ({ on: () => {}, destroy: () => {} }) },
      getBetaPolicy: () => ({ withdrawalsEnabled: false, policyMessage: 'Betas only' }),
      logAbuseEvent: async () => {},
      refreshWalletSyncState: async () => {},
    });
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (!process.env.VITEST) process.exit(failed > 0 ? 1 : 0);
}

run();
