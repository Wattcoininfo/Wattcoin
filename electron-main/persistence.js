'use strict';

const path = require('path');
const fs = require('fs');
const hwProf = require('./hardware-profiles');
const { normalizePeerUrl } = require('./main-utils');

function createPersistence(getters) {
  const {
    getRateLockFilePath,
    getPolicyAnchorCacheFilePath,
    getAttestationProfileCacheFilePath,
    getDiscoveredSeedPeerCachePath,
    getTeamFilePath,
    getDocsFilePath,
    getDeviceIdentityFilePath,
    rememberedDiscoveredPeers,
    rememberDiscoveredPeer,
    PEER_STALE_THRESHOLD_MS,
    app,
  } = getters;

  let discoveredPeerCacheSaveTimer = null;

  // -- Rate locks ------------------------------------------------------------

  function loadRateLocks(endpointRateState) {
    try {
      const raw = fs.readFileSync(getRateLockFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const nowMs = Date.now();
      for (const [key, lockedUntil] of Object.entries(parsed)) {
        if (typeof lockedUntil === 'number' && lockedUntil > nowMs) {
          endpointRateState.set(key, { hits: [], lockedUntil });
        }
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  function saveRateLock(key, lockedUntil) {
    try {
      const filePath = getRateLockFilePath();
      let existing = {};
      try {
        existing = JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      const nowMs = Date.now();
      const fresh = {};
      for (const [k, v] of Object.entries(existing)) {
        if (typeof v === 'number' && v > nowMs) fresh[k] = v;
      }
      if (lockedUntil > nowMs) fresh[key] = lockedUntil;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(fresh), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  // -- Policy anchor state ---------------------------------------------------

  function loadPolicyAnchorState() {
    try {
      const raw = fs.readFileSync(getPolicyAnchorCacheFilePath(), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return {
          latestAnchor: parsed.latestAnchor || null,
          lastScannedHeight: Number(parsed.lastScannedHeight) || -1,
          scannedAtMs: Number(parsed.scannedAtMs) || 0,
        };
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    return null;
  }

  function savePolicyAnchorState(state) {
    try {
      const fp = getPolicyAnchorCacheFilePath();
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, JSON.stringify(state, null, 2), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  // -- Attestation profile cache ---------------------------------------------

  function loadCachedRemoteProfiles() {
    const filePath = getAttestationProfileCacheFilePath();
    try {
      if (!fs.existsSync(filePath)) return null;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const profiles = Array.isArray(parsed && parsed.profiles)
        ? parsed.profiles.map(hwProf.normalizeRemoteProfile).filter(Boolean)
        : [];
      const expiresAtMs = Number(parsed && parsed.expiresAtMs) || 0;
      if (profiles.length > 0 && expiresAtMs > Date.now()) {
        return {
          profiles,
          rawProfiles: parsed.profiles,
          source: 'cache',
          fetchedAtMs: Number(parsed.fetchedAtMs) || Date.now(),
          expiresAtMs,
          version: Number(parsed.version) || 0,
        };
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    return null;
  }

  function saveRemoteProfilesToCache(state) {
    const filePath = getAttestationProfileCacheFilePath();
    try {
      const cachePayload = {
        profiles: Array.isArray(state.rawProfiles) ? state.rawProfiles : [],
        fetchedAtMs: state.fetchedAtMs,
        expiresAtMs: state.expiresAtMs,
        version: state.version,
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(cachePayload, null, 2), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  // -- Discovered seed peer cache --------------------------------------------

  function loadDiscoveredSeedPeerCache() {
    try {
      const filePath = getDiscoveredSeedPeerCachePath();
      if (!fs.existsSync(filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const entries = Array.isArray(parsed && parsed.peers) ? parsed.peers : [];
      const now = Date.now();
      let restored = 0;
      for (const entry of entries) {
        const lastSeenMs = Number(entry && entry.lastSeenMs) || 0;
        if (lastSeenMs <= 0 || now - lastSeenMs > PEER_STALE_THRESHOLD_MS) continue;
        if (Array.isArray(entry && entry.sources) && entry.sources.length > 0) {
          for (const source of entry.sources) {
            const wasNew = rememberDiscoveredPeer(entry && entry.url, {
              source: 'seed-cache',
              seenAtMs: lastSeenMs,
              quiet: true,
              peerIdentity: String((entry && entry.peerIdentity) || '').trim(),
            });
            const normalized = normalizePeerUrl(entry && entry.url);
            if (normalized && rememberedDiscoveredPeers.has(normalized)) {
              const current = rememberedDiscoveredPeers.get(normalized);
              rememberedDiscoveredPeers.set(normalized, {
                ...current,
                source: String(source || (current && current.source) || 'seed-cache'),
                sources: Array.from(
                  new Set([
                    ...(Array.isArray(current && current.sources) ? current.sources : []),
                    String(source || 'seed-cache'),
                  ]),
                ).sort(),
                restoredFromCache: true,
                seenThisSession: Boolean(current && current.seenThisSession),
              });
            }
            if (wasNew) {
              restored += 1;
            }
          }
        } else if (
          rememberDiscoveredPeer(entry && entry.url, {
            source: 'seed-cache',
            seenAtMs: lastSeenMs,
            quiet: true,
            peerIdentity: String((entry && entry.peerIdentity) || '').trim(),
          })
        ) {
          restored += 1;
          const normalized = normalizePeerUrl(entry && entry.url);
          if (normalized && rememberedDiscoveredPeers.has(normalized)) {
            const current = rememberedDiscoveredPeers.get(normalized);
            rememberedDiscoveredPeers.set(normalized, {
              ...current,
              restoredFromCache: true,
              seenThisSession: false,
            });
          }
        }
      }
      if (restored > 0) {
        console.log(`[PeerDiscovery] Restored ${restored} cached discovered peers.`);
      }
    } catch (err) {
      console.warn('[PeerDiscovery] Failed to load discovered peer cache:', err && err.message ? err.message : err);
    }
  }

  function scheduleDiscoveredSeedPeerCacheSave() {
    if (!app.isReady()) return;
    if (discoveredPeerCacheSaveTimer) clearTimeout(discoveredPeerCacheSaveTimer);
    discoveredPeerCacheSaveTimer = setTimeout(() => {
      discoveredPeerCacheSaveTimer = null;
      try {
        const now = Date.now();
        const peers = [];
        for (const [url, info] of rememberedDiscoveredPeers.entries()) {
          if (!info || now - Number(info.lastSeenMs || 0) > PEER_STALE_THRESHOLD_MS) continue;
          peers.push({
            url,
            lastSeenMs: Number(info.lastSeenMs) || now,
            source: info.source || 'peer-exchange',
            ...(info.peerIdentity ? { peerIdentity: info.peerIdentity } : {}),
            sources: Array.isArray(info.sources) ? info.sources : [info.source || 'peer-exchange'],
          });
        }
        fs.mkdirSync(path.dirname(getDiscoveredSeedPeerCachePath()), { recursive: true });
        fs.writeFileSync(getDiscoveredSeedPeerCachePath(), JSON.stringify({ peers }, null, 2), 'utf8');
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }, 250);
  }

  // -- Governance team/docs data ---------------------------------------------

  function readTeamData() {
    try {
      const fp = getTeamFilePath();
      if (!fs.existsSync(fp)) return [];
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) {
      return [];
    }
  }

  function writeTeamData(members) {
    const fp = getTeamFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(members, null, 2), 'utf8');
  }

  function readDocsData() {
    try {
      const fp = getDocsFilePath();
      if (!fs.existsSync(fp)) return [];
      return JSON.parse(fs.readFileSync(fp, 'utf8'));
    } catch (_) {
      return [];
    }
  }

  function writeDocsData(docs) {
    const fp = getDocsFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(docs, null, 2), 'utf8');
  }

  // -- Device identity -------------------------------------------------------

  function getDeviceIdentitySecret() {
    const filePath = getDeviceIdentityFilePath();
    try {
      if (!fs.existsSync(filePath)) return '';
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (raw && typeof raw.secret === 'string' && raw.secret.length >= 32) {
        return raw.secret;
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    return '';
  }

  function loadOrCreateDeviceIdentity() {
    const filePath = getDeviceIdentityFilePath();
    let identity = null;
    let isNew = false;
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf8');
        identity = JSON.parse(raw);
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }

    if (!identity || !identity.secret || typeof identity.secret !== 'string') {
      const crypto = require('crypto');
      const secret = crypto.randomBytes(32).toString('hex');
      const deviceId = crypto.createHash('sha256').update(secret).digest('hex');
      identity = { secret, deviceId, createdAt: Date.now(), version: 1 };
      isNew = true;
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(identity, null, 2), 'utf8');
        console.log('[device-identity] First run: generated and saved device identity.');
      } catch (e) {
        console.error('[device-identity] Failed to save device identity:', e && e.message);
      }
    }

    return {
      deviceId: identity.deviceId,
      secret: identity.secret,
      createdAt: identity.createdAt,
      version: identity.version || 1,
      isNew,
    };
  }

  return {
    loadRateLocks,
    saveRateLock,
    loadPolicyAnchorState,
    savePolicyAnchorState,
    loadCachedRemoteProfiles,
    saveRemoteProfilesToCache,
    loadDiscoveredSeedPeerCache,
    scheduleDiscoveredSeedPeerCacheSave,
    readTeamData,
    writeTeamData,
    readDocsData,
    writeDocsData,
    getDeviceIdentitySecret,
    loadOrCreateDeviceIdentity,
  };
}

module.exports = { createPersistence };
