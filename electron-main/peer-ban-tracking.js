'use strict';

function createHandlers(deps) {
  const {
    peerUtils,
    pushTimestampWindow,
    getLedgerNetworkSettings,
    recordOpsAlert,
    peerRequestFailTimestamps,
    peerRequestOkTimestamps,
    opsWindowMs,
  } = deps;

  const PEER_FAILURE_WINDOW_MS = 10 * 60_000;
  const PEER_FAILURE_BAN_THRESHOLD = 8;
  const PEER_IDENTITY_BAN_MS = 30 * 60_000;
  const PEER_URL_BAN_MS = 30 * 60_000;

  const bannedPeerIdentities = new Map();
  const bannedPeerUrls = new Map();
  const peerIdentityFailures = new Map();
  const peerUrlFailures = deps.peerUrlFailures || new Map();

  function isPeerIdentityBanned(identity) {
    const key = String(identity || '').trim();
    if (!key) return false;
    const entry = bannedPeerIdentities.get(key);
    if (!entry) return false;
    if (entry.untilMs <= Date.now()) {
      bannedPeerIdentities.delete(key);
      return false;
    }
    return true;
  }

  function isPeerUrlBanned(peerUrl) {
    const key = String(peerUrl || '').trim();
    if (!key) return false;
    if (peerUtils.isPinnedPeerUrl(key, getLedgerNetworkSettings())) {
      bannedPeerUrls.delete(key);
      return false;
    }
    const entry = bannedPeerUrls.get(key);
    if (!entry) return false;
    if (entry.untilMs <= Date.now()) {
      bannedPeerUrls.delete(key);
      return false;
    }
    return true;
  }

  function banPeerIdentity(identity, reason, durationMs = PEER_IDENTITY_BAN_MS) {
    const key = String(identity || '').trim();
    if (!key) return;
    const untilMs = Date.now() + durationMs;
    bannedPeerIdentities.set(key, { untilMs, reason: String(reason || 'policy') });
    recordOpsAlert('peer.identity.ban', 'warn', `Banned peer identity ${key}`, { reason, untilMs });
  }

  function banPeerUrl(peerUrl, reason, durationMs = PEER_URL_BAN_MS) {
    const key = String(peerUrl || '').trim();
    if (!key) return;
    if (peerUtils.isPinnedPeerUrl(key, getLedgerNetworkSettings())) return;
    const untilMs = Date.now() + durationMs;
    bannedPeerUrls.set(key, { untilMs, reason: String(reason || 'policy') });
    if (process.env.WATTCOIN_DEBUG)
      console.warn('[Peer] BANNED', key, 'until', new Date(untilMs).toISOString(), 'reason:', reason);
    recordOpsAlert('peer.url.ban', 'warn', `Banned peer ${key}`, { reason, untilMs });
  }

  function recordPeerIdentityFailure(identity, reason) {
    const key = String(identity || '').trim();
    if (!key) return;
    const hits = peerIdentityFailures.get(key) || [];
    const updated = pushTimestampWindow(hits, PEER_FAILURE_WINDOW_MS, 200);
    peerIdentityFailures.set(key, updated);
    if (updated.length >= PEER_FAILURE_BAN_THRESHOLD) {
      banPeerIdentity(key, reason || 'excessive failures');
      peerIdentityFailures.set(key, []);
    }
  }

  function recordPeerUrlFailure(peerUrl, reason) {
    const key = String(peerUrl || '').trim();
    if (!key) return;
    peerRequestFailTimestamps.current = pushTimestampWindow(peerRequestFailTimestamps.current, opsWindowMs, 5000);
    const hits = peerUrlFailures.get(key) || [];
    const updated = pushTimestampWindow(hits, PEER_FAILURE_WINDOW_MS, 200);
    peerUrlFailures.set(key, updated);
    if (process.env.WATTCOIN_DEBUG && updated.length >= 3) {
      console.warn('[Peer] failures', key, updated.length + '/' + PEER_FAILURE_BAN_THRESHOLD, 'reason:', reason);
    }
    if (updated.length >= PEER_FAILURE_BAN_THRESHOLD) {
      banPeerUrl(key, reason || 'excessive failures');
      peerUrlFailures.set(key, []);
    }
  }

  function recordPeerUrlSuccess(peerUrl) {
    const key = String(peerUrl || '').trim();
    if (!key) return;
    peerRequestOkTimestamps.current = pushTimestampWindow(peerRequestOkTimestamps.current, opsWindowMs, 5000);
    const hits = peerUrlFailures.get(key) || [];
    if (hits.length <= 1) {
      peerUrlFailures.delete(key);
    } else {
      peerUrlFailures.set(key, hits.slice(-1));
    }
  }

  return {
    isPeerIdentityBanned,
    isPeerUrlBanned,
    banPeerIdentity,
    banPeerUrl,
    recordPeerIdentityFailure,
    recordPeerUrlFailure,
    recordPeerUrlSuccess,
    bannedPeerIdentities,
    bannedPeerUrls,
    peerUrlFailures,
    peerIdentityFailures,
  };
}

module.exports = { createHandlers };
