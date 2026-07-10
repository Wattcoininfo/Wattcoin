const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildPeerPrivacyRecoveryPayload,
  getPeerPrivacyRecoveryFilePath,
  writePeerPrivacyRecoveryFile,
} = require('../electron-main/peer-privacy-dev');

function testBuildPeerPrivacyRecoveryPayload() {
  const recoverySecret = ['peer', 'privacy', 'secret'].join('-');
  const payload = buildPeerPrivacyRecoveryPayload({
    secret: recoverySecret,
    deviceId: 'device-123',
    createdAt: 1234,
    exportedAtMs: Date.UTC(2026, 3, 21, 12, 0, 0),
  });

  assert.ok(payload);
  assert.strictEqual(payload.version, 1);
  assert.strictEqual(payload.algorithm, 'hmac-sha256');
  assert.strictEqual(payload.secret, recoverySecret);
  assert.strictEqual(payload.deviceId, 'device-123');
  assert.strictEqual(payload.createdAt, 1234);
  assert.strictEqual(payload.exportedAt, '2026-04-21T12:00:00.000Z');
}

function testWritePeerPrivacyRecoveryFile() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-peer-privacy-'));
  try {
    const recoverySecret = ['peer', 'privacy', 'secret'].join('-');
    const payload = buildPeerPrivacyRecoveryPayload({ secret: recoverySecret });
    const filePath = writePeerPrivacyRecoveryFile({ fs, baseDir: tempDir, payload });
    const expectedPath = getPeerPrivacyRecoveryFilePath(tempDir);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    assert.strictEqual(filePath, expectedPath);
    assert.strictEqual(saved.secret, recoverySecret);
    assert.strictEqual(saved.aliasHostPattern, 'peer-ip{family}-{token}.wtc.invalid');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function run() {
  testBuildPeerPrivacyRecoveryPayload();
  testWritePeerPrivacyRecoveryFile();
  console.log('peer privacy dev tests passed');
}

run();
