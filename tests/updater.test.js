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

function makeMockElectron() {
  const handlers = {};
  const autoUpdaterHandlers = {};

  return {
    app: {
      isPackaged: true,
      whenReady() {
        return { then: (cb) => {} };
      },
    },
    autoUpdater: {
      setFeedURL: () => {},
      checkForUpdates: async () => ({ updateInfo: { version: '1.0.500' } }),
      on: (event, handler) => {
        autoUpdaterHandlers[event] = handler;
      },
      autoDownload: false,
      autoInstallOnAppQuit: true,
      quitAndInstall: () => {},
    },
    BrowserWindow: {
      getAllWindows: () => [],
    },
    ipcMain: {
      handle: (channel, handler) => {
        handlers[channel] = handler;
      },
    },
    _handlers: handlers,
    _autoUpdaterHandlers: autoUpdaterHandlers,
  };
}

function silence(fn) {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

async function run() {
  const { initUpdater } = require('../electron-main/updater');

  await test('does nothing when app.isPackaged is false', () => {
    const mock = makeMockElectron();
    mock.app.isPackaged = false;
    const ref = { value: false };
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: ref }));
    assert.strictEqual(Object.keys(mock._handlers).length, 0);
    assert.strictEqual(Object.keys(mock._autoUpdaterHandlers).length, 0);
  });

  await test('registers autoUpdater event handlers when packaged', () => {
    const mock = makeMockElectron();
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    assert.ok(mock._autoUpdaterHandlers['before-quit-for-update']);
    assert.ok(mock._autoUpdaterHandlers['update-downloaded']);
    assert.ok(mock._autoUpdaterHandlers['error']);
  });

  await test('registers IPC handlers when packaged', () => {
    const mock = makeMockElectron();
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    assert.ok(mock._handlers['wattcoin-check-for-update']);
    assert.ok(mock._handlers['wattcoin-install-update']);
  });

  await test('sets autoUpdater.autoDownload and autoInstallOnAppQuit', () => {
    const mock = makeMockElectron();
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    assert.strictEqual(mock.autoUpdater.autoDownload, true);
    assert.strictEqual(mock.autoUpdater.autoInstallOnAppQuit, false);
  });

  await test('before-quit-for-update sets ref.value to true', () => {
    const mock = makeMockElectron();
    const ref = { value: false };
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: ref }));
    mock._autoUpdaterHandlers['before-quit-for-update']();
    assert.strictEqual(ref.value, true);
  });

  await test('sets _verifyUpdateCodeSignature when WATTCOIN_WINDOWS_SIGNING_ON_HOLD=1', () => {
    process.env.WATTCOIN_WINDOWS_SIGNING_ON_HOLD = '1';
    try {
      const mock = makeMockElectron();
      silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
      assert.strictEqual(typeof mock.autoUpdater._verifyUpdateCodeSignature, 'function');
    } finally {
      delete process.env.WATTCOIN_WINDOWS_SIGNING_ON_HOLD;
    }
  });

  await test('does not set _verifyUpdateCodeSignature when env var not set', () => {
    const mock = makeMockElectron();
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    assert.strictEqual(mock.autoUpdater._verifyUpdateCodeSignature, undefined);
  });

  await test('update-downloaded sends wattcoin-update-downloaded to all windows', () => {
    const sent = [];
    const win1 = { webContents: { send: (ch, d) => sent.push([ch, d]) } };
    const win2 = { webContents: { send: (ch, d) => sent.push([ch, d]) } };
    const mock = makeMockElectron();
    mock.BrowserWindow.getAllWindows = () => [win1, win2];
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    mock._autoUpdaterHandlers['update-downloaded']({ version: '1.0.500' });
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0][0], 'wattcoin-update-downloaded');
    assert.strictEqual(sent[0][1].version, '1.0.500');
    assert.strictEqual(sent[1][0], 'wattcoin-update-downloaded');
    assert.strictEqual(sent[1][1].version, '1.0.500');
  });

  await test('update-downloaded handles send errors gracefully', () => {
    const win = {
      webContents: {
        send: () => {
          throw new Error('send failed');
        },
      },
    };
    const mock = makeMockElectron();
    mock.BrowserWindow.getAllWindows = () => [win];
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    assert.doesNotThrow(() => mock._autoUpdaterHandlers['update-downloaded']({ version: '1.0.500' }));
  });

  await test('wattcoin-check-for-update returns result from checkForUpdates', async () => {
    const mock = makeMockElectron();
    mock.autoUpdater.checkForUpdates = async () => ({ updateInfo: { version: '2.0.0' } });
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    const result = await mock._handlers['wattcoin-check-for-update']();
    assert.deepStrictEqual(result, { updateInfo: { version: '2.0.0' } });
  });

  await test('wattcoin-check-for-update returns null on failure', async () => {
    const mock = makeMockElectron();
    mock.autoUpdater.checkForUpdates = async () => {
      throw new Error('network error');
    };
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    const result = await mock._handlers['wattcoin-check-for-update']();
    assert.strictEqual(result, null);
  });

  await test('wattcoin-install-update removes close listeners and closes all windows', () => {
    const removed = [];
    const closed = [];
    const win1 = {
      removeAllListeners: (e) => removed.push(e),
      close: () => closed.push('win1'),
    };
    const win2 = {
      removeAllListeners: (e) => removed.push(e),
      close: () => closed.push('win2'),
    };
    const mock = makeMockElectron();
    mock.BrowserWindow.getAllWindows = () => [win1, win2];
    let quitAndInstallCalled = false;
    mock.autoUpdater.quitAndInstall = () => {
      quitAndInstallCalled = true;
    };
    const ref = { value: false };
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: ref }));
    const result = mock._handlers['wattcoin-install-update']();
    assert.deepStrictEqual(removed, ['close', 'close']);
    assert.deepStrictEqual(closed, ['win1', 'win2']);
    assert.strictEqual(quitAndInstallCalled, true);
    assert.strictEqual(ref.value, true);
    assert.deepStrictEqual(result, { ok: true });
  });

  await test('wattcoin-install-update resets ref.value on quitAndInstall error', () => {
    const mock = makeMockElectron();
    mock.BrowserWindow.getAllWindows = () => [];
    mock.autoUpdater.quitAndInstall = () => {
      throw new Error('install failed');
    };
    const ref = { value: false };
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: ref }));
    mock._handlers['wattcoin-install-update']();
    assert.strictEqual(ref.value, false);
  });

  await test('wattcoin-install-update returns ok on success', () => {
    const mock = makeMockElectron();
    mock.BrowserWindow.getAllWindows = () => [];
    const ref = { value: false };
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: ref }));
    const result = mock._handlers['wattcoin-install-update']();
    assert.deepStrictEqual(result, { ok: true });
  });

  await test('calls setUpdateFeed with first feed on startup', () => {
    const mock = makeMockElectron();
    const feedUrls = [];
    mock.autoUpdater.setFeedURL = (cfg) => {
      feedUrls.push(cfg.url);
    };
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    assert.ok(feedUrls.length >= 1);
    assert.ok(feedUrls.some((u) => u.startsWith('http')));
  });

  await test('returns null when all fallback feeds fail in checkForUpdates', async () => {
    const mock = makeMockElectron();
    mock.autoUpdater.checkForUpdates = async () => {
      throw new Error('all failed');
    };
    silence(() => initUpdater({ ...mock, updateInstallInProgressRef: { value: false } }));
    const result = await mock._handlers['wattcoin-check-for-update']();
    assert.strictEqual(result, null);
  });

  await test('error event handler logs to console.warn', () => {
    const mock = makeMockElectron();
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    try {
      initUpdater({ ...mock, updateInstallInProgressRef: { value: false } });
      mock._autoUpdaterHandlers.error(new Error('something went wrong'));
      assert.ok(warnings.length > 0);
    } finally {
      console.warn = origWarn;
    }
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
