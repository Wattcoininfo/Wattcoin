'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

function createHandlers(deps) {
  const {
    hwAuthority,
    attestationStateRef,
    hwAuthStateIsNew,
    getHwAuthStatePath,
    getAttestationDbFilePath,
    safeStorage,
    networkMiningStats,
  } = deps;

  const TRUST_RESET_EPOCH = '2026-04-23-v1';

  function recordMinerStats(address, powerW, cpuOps) {
    if (!address || powerW <= 0 || cpuOps <= 0) return;
    const existing = networkMiningStats.get(address) || { totalPowerW: 0, totalCpuOps: 0, count: 0, lastSeen: 0 };
    existing.totalPowerW += powerW;
    existing.totalCpuOps += cpuOps;
    existing.count += 1;
    existing.lastSeen = Date.now();
    networkMiningStats.set(address, existing);
    if (networkMiningStats.size > 10000) {
      const cutoff = Date.now() - 86400000;
      for (const [addr, stats] of networkMiningStats) {
        if (stats.lastSeen < cutoff) networkMiningStats.delete(addr);
      }
    }
  }

  function computeHwAuthSig(data) {
    return crypto
      .createHmac('sha256', Buffer.from(attestationStateRef.current.secret, 'utf8'))
      .update(JSON.stringify(data))
      .digest('hex');
  }

  function loadHwAuthState() {
    try {
      const raw = fs.readFileSync(getHwAuthStatePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('invalid format');
      const { sig, ...data } = parsed;
      if (sig) {
        const expected = computeHwAuthSig(data);
        if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
          hwAuthStateIsNew.current = true;
          console.warn('[hwAuth] hw-auth-state.json signature invalid - resetting to defaults.');
          return;
        }
      }
      if (data.trustResetEpoch !== TRUST_RESET_EPOCH) {
        console.log('[hwAuth] Trust reset epoch changed - resetting trust score to 50.');
        hwAuthority.trustScore = 50;
        hwAuthority.hwHoldUntilMs = 0;
        saveHwAuthState();
        return;
      }
      if (typeof data.trustScore === 'number') hwAuthority.trustScore = Math.max(0, Math.min(100, data.trustScore));
      if (typeof data.hwHoldUntilMs === 'number') hwAuthority.hwHoldUntilMs = data.hwHoldUntilMs;
      if (typeof data.lastHwResetAtMs === 'number') hwAuthority.lastHwResetAtMs = data.lastHwResetAtMs;
      if (typeof data.lastSearchCacheClearAtMs === 'number')
        hwAuthority.lastSearchCacheClearAtMs = data.lastSearchCacheClearAtMs;
      if (typeof data.sha256OpsPerMs === 'number' && data.sha256OpsPerMs > 0)
        hwAuthority.sha256OpsPerMs = data.sha256OpsPerMs;
      if (typeof data.gpuOpsPerMs === 'number' && data.gpuOpsPerMs > 0) hwAuthority.gpuOpsPerMs = data.gpuOpsPerMs;
      if (hwAuthority.hwHoldUntilMs > 0 && hwAuthority.hwHoldUntilMs <= Date.now() && hwAuthority.trustScore === 0) {
        hwAuthority.trustScore = 25;
        hwAuthority.hwHoldUntilMs = 0;
      }
    } catch (_) {
      let recovered = false;
      if (safeStorage && safeStorage.isEncryptionAvailable()) {
        try {
          const atPath = getAttestationDbFilePath();
          if (fs.existsSync(atPath)) {
            const atParsed = JSON.parse(fs.readFileSync(atPath, 'utf8'));
            if (typeof atParsed.encryptedTrustBackup === 'string') {
              const backupJson = safeStorage.decryptString(Buffer.from(atParsed.encryptedTrustBackup, 'base64'));
              const backup = JSON.parse(backupJson);
              if (typeof backup.trustScore === 'number') {
                hwAuthority.trustScore = Math.max(0, Math.min(100, backup.trustScore));
                hwAuthority.hwHoldUntilMs = typeof backup.hwHoldUntilMs === 'number' ? backup.hwHoldUntilMs : 0;
                if (typeof backup.lastHwResetAtMs === 'number') hwAuthority.lastHwResetAtMs = backup.lastHwResetAtMs;
                if (typeof backup.lastSearchCacheClearAtMs === 'number')
                  hwAuthority.lastSearchCacheClearAtMs = backup.lastSearchCacheClearAtMs;
                if (typeof backup.sha256OpsPerMs === 'number' && backup.sha256OpsPerMs > 0)
                  hwAuthority.sha256OpsPerMs = backup.sha256OpsPerMs;
                if (typeof backup.gpuOpsPerMs === 'number' && backup.gpuOpsPerMs > 0)
                  hwAuthority.gpuOpsPerMs = backup.gpuOpsPerMs;
                saveHwAuthState();
                console.log('[hwAuth] Trust state recovered from encrypted attestation backup.');
                recovered = true;
              }
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
      }
      if (!recovered) {
        hwAuthStateIsNew.current = true;
      }
    }
  }

  let _savePending = false;
  let _saveTimer = null;

  async function _doSaveHwAuthState() {
    _savePending = false;
    _saveTimer = null;
    try {
      const p = getHwAuthStatePath();
      await fsp.mkdir(path.dirname(p), { recursive: true });
      const data = {
        trustScore: hwAuthority.trustScore,
        hwHoldUntilMs: hwAuthority.hwHoldUntilMs,
        lastHwResetAtMs: hwAuthority.lastHwResetAtMs,
        lastSearchCacheClearAtMs: hwAuthority.lastSearchCacheClearAtMs,
        sha256OpsPerMs: hwAuthority.sha256OpsPerMs,
        gpuOpsPerMs: hwAuthority.gpuOpsPerMs,
        trustResetEpoch: TRUST_RESET_EPOCH,
      };
      await fsp.writeFile(p, JSON.stringify({ ...data, sig: computeHwAuthSig(data) }), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }

    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      try {
        const backupJson = JSON.stringify({
          trustScore: hwAuthority.trustScore,
          hwHoldUntilMs: hwAuthority.hwHoldUntilMs,
          lastHwResetAtMs: hwAuthority.lastHwResetAtMs,
          lastSearchCacheClearAtMs: hwAuthority.lastSearchCacheClearAtMs,
          sha256OpsPerMs: hwAuthority.sha256OpsPerMs,
          gpuOpsPerMs: hwAuthority.gpuOpsPerMs,
        });
        const encrypted = safeStorage.encryptString(backupJson).toString('base64');
        const atPath = getAttestationDbFilePath();
        let atRaw = {};
        try {
          atRaw = JSON.parse(await fsp.readFile(atPath, 'utf8'));
        } catch (_) {
          /* no prior attestation db — will create */
        }
        atRaw.encryptedTrustBackup = encrypted;
        await fsp.writeFile(atPath, JSON.stringify(atRaw, null, 2), 'utf8');
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  }

  function saveHwAuthState() {
    if (_savePending) return;
    _savePending = true;
    _saveTimer = setTimeout(_doSaveHwAuthState, 200);
  }

  return {
    recordMinerStats,
    computeHwAuthSig,
    loadHwAuthState,
    saveHwAuthState,
  };
}

module.exports = { createHandlers };
