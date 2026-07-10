'use strict';
/**
 * Risk: runtime-config.js contains the comment
 *   "RPC credentials must never ship with a hardcoded fallback"
 * and the code uses:
 *   rpcUser:     String(process.env.WATTCOIN_RPC_USER     || fileConfig.rpcUser     || ''),
 *   rpcPassword: String(process.env.WATTCOIN_RPC_PASSWORD || fileConfig.rpcPassword || ''),
 *
 * In practice, electron-main.js generates random per-install credentials on
 * first launch and writes them to the local-override config file.  So the
 * empty-string fallback is the code-level safety net — not the runtime default.
 *
 * This test verifies:
 *  1. Config-file credentials are correctly picked up via WATTCOIN_RUNTIME_CONFIG.
 *  2. Env-var credentials override any config-file value.
 *  3. When a config explicitly provides empty credentials, the fallback is ''
 *     (not an error, not undefined), which depends on wattcoind to reject empty auth.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withEnv(overrides, fn) {
  const saved = {};
  for (const [key, val] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = String(val);
  }
  try {
    return fn();
  } finally {
    for (const [key, val] of Object.entries(saved)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  }
}

function freshRuntimeConfig() {
  const modulePath = require.resolve('../electron-main/runtime-config');
  delete require.cache[modulePath];
  const { getRuntimeConfig } = require('../electron-main/runtime-config');
  return getRuntimeConfig;
}

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-rpc-creds-'));
  const origCwd = process.cwd();

  try {
    process.chdir(tmpDir); // isolate from CWD-relative wattcoin-beta-config.json

    // ── Case 1: config file supplies credentials ──────────────────────────────
    const cfgFile = path.join(tmpDir, 'test-config.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ rpcUser: 'cfg-user', rpcPassword: 'cfg-pass' }));

    const config1 = withEnv(
      {
        WATTCOIN_RUNTIME_CONFIG: cfgFile,
        WATTCOIN_RPC_USER: undefined,
        WATTCOIN_RPC_PASSWORD: undefined,
      },
      () => freshRuntimeConfig()(),
    );

    assert.strictEqual(
      config1.rpcUser,
      'cfg-user',
      'rpcUser should come from WATTCOIN_RUNTIME_CONFIG when env var is absent',
    );
    assert.strictEqual(
      config1.rpcPassword,
      'cfg-pass',
      'rpcPassword should come from WATTCOIN_RUNTIME_CONFIG when env var is absent',
    );

    // ── Case 2: env var overrides config file ─────────────────────────────────
    const config2 = withEnv(
      {
        WATTCOIN_RUNTIME_CONFIG: cfgFile,
        WATTCOIN_RPC_USER: 'env-user',
        WATTCOIN_RPC_PASSWORD: 'env-pass',
      },
      () => freshRuntimeConfig()(),
    );

    assert.strictEqual(config2.rpcUser, 'env-user', 'env-var WATTCOIN_RPC_USER should override config-file rpcUser');
    assert.strictEqual(
      config2.rpcPassword,
      'env-pass',
      'env-var WATTCOIN_RPC_PASSWORD should override config-file rpcPassword',
    );

    // ── Case 3: empty-string credentials in config file ───────────────────────
    // WATTCOIN_RUNTIME_CONFIG has highest merge priority, so explicit '' here
    // overrides any value in the per-machine local-override config file.
    // This verifies the code returns '' (not undefined/null/throw) when no
    // credentials are configured — matching the || '' fallback in the source.
    const emptyCredsFile = path.join(tmpDir, 'empty-creds.json');
    fs.writeFileSync(emptyCredsFile, JSON.stringify({ rpcUser: '', rpcPassword: '' }));

    const config3 = withEnv(
      {
        WATTCOIN_RUNTIME_CONFIG: emptyCredsFile,
        WATTCOIN_RPC_USER: undefined,
        WATTCOIN_RPC_PASSWORD: undefined,
      },
      () => freshRuntimeConfig()(),
    );

    assert.strictEqual(typeof config3.rpcUser, 'string', 'rpcUser must be a string even when credentials are empty');
    assert.strictEqual(
      typeof config3.rpcPassword,
      'string',
      'rpcPassword must be a string even when credentials are empty',
    );
    assert.strictEqual(
      config3.rpcUser,
      '',
      'RISK DOCUMENTED: rpcUser is empty string when config provides no value — ' +
        'depends on wattcoind to reject empty auth',
    );
    assert.strictEqual(
      config3.rpcPassword,
      '',
      'RISK DOCUMENTED: rpcPassword is empty string when config provides no value',
    );

    console.log(
      '[PASS] rpc-credentials: config-file and env-var override paths verified; empty-string fallback documented',
    );
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../electron-main/runtime-config')];
  }
}

run();
