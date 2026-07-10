'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function createHandlers(getDataDir, persistence, safeStorage) {
  const DEVICE_IDENTITY_FILE = 'device-identity.json';
  let _deviceIdentity = null;
  let _deviceIdentitySecret = '';
  let _walletEncryptionKey = null;

  function getDeviceIdentityFilePath() {
    return path.join(getDataDir(), DEVICE_IDENTITY_FILE);
  }

  function getDeviceIdentitySecret() {
    if (_deviceIdentitySecret) return _deviceIdentitySecret;
    _deviceIdentitySecret = persistence.getDeviceIdentitySecret();
    return _deviceIdentitySecret;
  }

  function getOrCreateWalletEncryptionKey() {
    if (_walletEncryptionKey) return _walletEncryptionKey;
    const keyFile = path.join(getDataDir(), 'wallet-key.enc');
    try {
      if (fs.existsSync(keyFile)) {
        const stored = fs.readFileSync(keyFile);
        if (safeStorage.isEncryptionAvailable()) {
          const keyHex = safeStorage.decryptString(stored);
          if (keyHex && keyHex.length === 64) {
            _walletEncryptionKey = Buffer.from(keyHex, 'hex');
            return _walletEncryptionKey;
          }
        }
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }

    const newKey = crypto.randomBytes(32);
    const keyHex = newKey.toString('hex');

    if (safeStorage.isEncryptionAvailable()) {
      try {
        const enc = safeStorage.encryptString(keyHex);
        fs.mkdirSync(path.dirname(keyFile), { recursive: true });
        fs.writeFileSync(keyFile, enc);
        _walletEncryptionKey = newKey;
        return _walletEncryptionKey;
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }

    try {
      const deviceSecret = getDeviceIdentitySecret();
      if (deviceSecret && deviceSecret.length >= 32) {
        const fbKey = crypto
          .createHash('sha256')
          .update(deviceSecret + ':wallet-encryption')
          .digest();
        _walletEncryptionKey = fbKey;
        return _walletEncryptionKey;
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }

    _walletEncryptionKey = newKey;
    return _walletEncryptionKey;
  }

  function loadOrCreateDeviceIdentity() {
    if (_deviceIdentity) return _deviceIdentity;
    const loaded = persistence.loadOrCreateDeviceIdentity();
    _deviceIdentitySecret = loaded.secret;
    _deviceIdentity = {
      deviceId: loaded.deviceId,
      createdAt: loaded.createdAt,
      version: loaded.version,
      isNew: loaded.isNew,
    };
    return _deviceIdentity;
  }

  return {
    getDeviceIdentityFilePath,
    getDeviceIdentitySecret,
    getOrCreateWalletEncryptionKey,
    loadOrCreateDeviceIdentity,
  };
}

module.exports = { createHandlers };
