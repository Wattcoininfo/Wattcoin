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
  const { createIntegrityVerifier } = require('../electron-main/integrity');

  await test('createIntegrityVerifier is a function', () => {
    assert.strictEqual(typeof createIntegrityVerifier, 'function');
  });

  // -- verifyReleaseDebuggerFriction -------------------------------------------
  await test('verifyReleaseDebuggerFriction ok in dev-mode (no debug flags)', () => {
    const verifier = createIntegrityVerifier({
      app: { isPackaged: true },
      verifyManifestSignature: () => true,
    });
    const result = verifier.verifyReleaseDebuggerFriction();
    assert.strictEqual(result.ok, true);
  });

  await test('verifyReleaseDebuggerFriction detects --inspect in execArgv', () => {
    const origExecArgv = process.execArgv;
    const origArgv = process.argv;
    let restore = false;
    try {
      Object.defineProperty(process, 'execArgv', { value: ['--inspect=9229'], configurable: true });
      Object.defineProperty(process, 'argv', { value: ['node', 'app.js'], configurable: true });
      restore = true;
      const verifier = createIntegrityVerifier({
        app: { isPackaged: true },
        verifyManifestSignature: () => true,
      });
      const result = verifier.verifyReleaseDebuggerFriction();
      assert.strictEqual(result.ok, false);
      assert.ok(Array.isArray(result.reasons));
      assert.ok(result.reasons.some((r) => r.includes('--inspect')));
    } finally {
      if (restore) {
        Object.defineProperty(process, 'execArgv', { value: origExecArgv, configurable: true });
        Object.defineProperty(process, 'argv', { value: origArgv, configurable: true });
      }
    }
  });

  await test('verifyReleaseDebuggerFriction detects NODE_OPTIONS with inspect', () => {
    const orig = process.env.NODE_OPTIONS;
    let restore = false;
    try {
      process.env.NODE_OPTIONS = '--inspect-brk';
      restore = true;
      const verifier = createIntegrityVerifier({
        app: { isPackaged: true },
        verifyManifestSignature: () => true,
      });
      const result = verifier.verifyReleaseDebuggerFriction();
      assert.strictEqual(result.ok, false);
      assert.ok(result.reasons.some((r) => r.includes('NODE_OPTIONS')));
    } finally {
      if (restore) {
        process.env.NODE_OPTIONS = orig;
      }
    }
  });

  await test('verifyReleaseDebuggerFriction respects WATTCOIN_ALLOW_DEBUGGER override', () => {
    const orig = process.env.WATTCOIN_ALLOW_DEBUGGER;
    let restore = false;
    try {
      process.env.WATTCOIN_ALLOW_DEBUGGER = '1';
      restore = true;
      const verifier = createIntegrityVerifier({
        app: { isPackaged: true },
        verifyManifestSignature: () => true,
      });
      const result = verifier.verifyReleaseDebuggerFriction();
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.skipped, 'override');
    } finally {
      if (restore) {
        process.env.WATTCOIN_ALLOW_DEBUGGER = orig;
      }
    }
  });

  // -- Dev-mode skips ----------------------------------------------------------
  await test('verifyBinaryManifest returns dev-mode skip when app is not packaged', () => {
    const verifier = createIntegrityVerifier({
      app: { isPackaged: false },
      verifyManifestSignature: () => true,
    });
    const result = verifier.verifyBinaryManifest();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, 'dev-mode');
  });

  await test('verifyAppIntegrityManifest returns dev-mode skip when app is not packaged', () => {
    const verifier = createIntegrityVerifier({
      app: { isPackaged: false },
      verifyManifestSignature: () => true,
    });
    const result = verifier.verifyAppIntegrityManifest();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, 'dev-mode');
  });

  // verifyBinaryManifest and verifyAppIntegrityManifest when app.isPackaged=true
  // require an Electron runtime (process.resourcesPath, __dirname in asar).
  // In plain-Node tests these paths are undefined, so the function throws.
  // Coverage: the dev-mode branch is tested above. The packaged path is covered
  // by the integration test suite (needs Electron).

  await test('verifyAppIntegrityManifest returns no-manifest skip if manifest not found', () => {
    const verifier = createIntegrityVerifier({
      app: { isPackaged: true },
      verifyManifestSignature: () => true,
    });
    const result = verifier.verifyAppIntegrityManifest();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skipped, 'no-manifest');
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run();
