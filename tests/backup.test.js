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
    BACKUP_FILE_EXTENSION,
    BACKUP_FORMAT_VERSION,
    parseBackupContainer,
  } = require('../electron-main/wallet-backup-ipc');

  await test('BACKUP_FILE_EXTENSION is wcbak', () => {
    assert.strictEqual(BACKUP_FILE_EXTENSION, 'wcbak');
  });

  await test('BACKUP_FORMAT_VERSION is 1', () => {
    assert.strictEqual(BACKUP_FORMAT_VERSION, 1);
  });

  await test('parseBackupContainer accepts a valid container', () => {
    const raw = JSON.stringify({
      format: 'WATTCOIN_WALLET_BACKUP',
      version: 1,
      encrypted: { salt: 'abc', iv: 'def', tag: 'ghi', ciphertext: 'jkl' },
    });
    const result = parseBackupContainer(raw);
    assert.strictEqual(result.format, 'WATTCOIN_WALLET_BACKUP');
    assert.strictEqual(result.version, 1);
    assert.ok(result.encrypted);
  });

  await test('parseBackupContainer throws on invalid JSON', () => {
    assert.throws(() => parseBackupContainer('not json'), /JSON parsing failed/);
  });

  await test('parseBackupContainer throws on wrong format', () => {
    const raw = JSON.stringify({
      format: 'WRONG_FORMAT',
      version: 1,
      encrypted: {},
    });
    assert.throws(() => parseBackupContainer(raw), /Unsupported backup format/);
  });

  await test('parseBackupContainer throws on wrong version', () => {
    const raw = JSON.stringify({
      format: 'WATTCOIN_WALLET_BACKUP',
      version: 999,
      encrypted: {},
    });
    assert.throws(() => parseBackupContainer(raw), /Unsupported backup format/);
  });

  await test('parseBackupContainer throws on missing encrypted payload', () => {
    const raw = JSON.stringify({
      format: 'WATTCOIN_WALLET_BACKUP',
      version: 1,
    });
    assert.throws(() => parseBackupContainer(raw), /missing encrypted payload/);
  });

  await test('parseBackupContainer throws when encrypted is not an object', () => {
    const raw = JSON.stringify({
      format: 'WATTCOIN_WALLET_BACKUP',
      version: 1,
      encrypted: 'not an object',
    });
    assert.throws(() => parseBackupContainer(raw), /missing encrypted payload/);
  });

  await test('parseBackupContainer throws on null input', () => {
    assert.throws(() => parseBackupContainer('null'), /Unsupported backup format/);
  });

  await test('parseBackupContainer preserves extra fields', () => {
    const raw = JSON.stringify({
      format: 'WATTCOIN_WALLET_BACKUP',
      version: 1,
      encrypted: { data: 'test' },
      kdf: { name: 'scrypt' },
      cipher: { name: 'aes-256-gcm' },
    });
    const result = parseBackupContainer(raw);
    assert.strictEqual(result.kdf.name, 'scrypt');
    assert.strictEqual(result.cipher.name, 'aes-256-gcm');
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
