'use strict';

const path = require('path');

const DEV_PEER_PRIVACY_DIR = '.dev';
const DEV_PEER_PRIVACY_FILE = 'peer-privacy-recovery.json';

function getPeerPrivacyRecoveryFilePath(baseDir = '.') {
  return path.join(String(baseDir || '.'), DEV_PEER_PRIVACY_DIR, DEV_PEER_PRIVACY_FILE);
}

function buildPeerPrivacyRecoveryPayload({ secret, deviceId = '', createdAt = 0, exportedAtMs = Date.now() } = {}) {
  const normalizedSecret = String(secret || '').trim();
  if (!normalizedSecret) return null;

  return {
    version: 1,
    algorithm: 'hmac-sha256',
    aliasHostPattern: 'peer-ip{family}-{token}.wtc.invalid',
    tokenHexLength: 12,
    secret: normalizedSecret,
    deviceId: String(deviceId || '').trim(),
    createdAt: Number(createdAt) || 0,
    exportedAt: new Date(Number(exportedAtMs) || Date.now()).toISOString(),
    note: 'Developer-only recovery key for reproducing peer IP aliases in local diagnostics.',
  };
}

function writePeerPrivacyRecoveryFile({ fs, baseDir = '.', payload } = {}) {
  if (!fs || typeof fs.mkdirSync !== 'function' || typeof fs.writeFileSync !== 'function') {
    throw new Error('fs implementation is required');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }

  const filePath = getPeerPrivacyRecoveryFilePath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

module.exports = {
  buildPeerPrivacyRecoveryPayload,
  getPeerPrivacyRecoveryFilePath,
  writePeerPrivacyRecoveryFile,
};
