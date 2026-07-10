'use strict';

function createRateLimiter(
  persistence,
  getEndpointActorKey,
  shouldEscalateRateLimitToIdentityFailure,
  recordPeerIdentityFailure,
  logAbuseEvent,
) {
  const ENDPOINT_RATE_LIMITS = {
    'wattcoin-mine-block': { windowMs: 60_000, max: 30, lockMs: 60_000 },
    'wattcoin-ledger-add-contribution': { windowMs: 60_000, max: 360, lockMs: 60_000 },
    'wattcoin-ledger-settle-round': { windowMs: 60_000, max: 60, lockMs: 60_000 },
    'wattcoin-ledger-get-balances': { windowMs: 60_000, max: 360, lockMs: 60_000 },
    'wtc-peer-chain-headers': { windowMs: 60_000, max: 240, lockMs: 60_000 },
    'wtc-peer-chain-blocks': { windowMs: 60_000, max: 240, lockMs: 60_000 },
    'wtc-peer-chain-block-hash': { windowMs: 60_000, max: 240, lockMs: 60_000 },
    'wattcoin-send': { windowMs: 10 * 60_000, max: 3, lockMs: 30 * 60_000 },
    'wattcoin-list-transactions': { windowMs: 60_000, max: 180, lockMs: 60_000 },
    'wattcoin-report-gpu-calibration': { windowMs: 10 * 60_000, max: 10, lockMs: 10 * 60_000 },
    'peer-probe-issue': { windowMs: 60_000, max: 60, lockMs: 5 * 60_000 },
    'peer-probe-submit': { windowMs: 60_000, max: 60, lockMs: 5 * 60_000 },
  };

  const endpointRateState = new Map();

  function loadRateLocks() {
    persistence.loadRateLocks(endpointRateState);
  }

  function saveRateLock(key, lockedUntil) {
    persistence.saveRateLock(key, lockedUntil);
  }

  async function enforceEndpointRateLimit(endpointName, actorId = 'local-client', metadata = {}) {
    const limit = ENDPOINT_RATE_LIMITS[endpointName];
    if (!limit) {
      return { ok: true };
    }

    const nowMs = Date.now();
    const key = getEndpointActorKey(endpointName, actorId);
    const existing = endpointRateState.get(key) || { hits: [], lockedUntil: 0 };
    const escalateIdentityFailure = shouldEscalateRateLimitToIdentityFailure(endpointName);

    if (existing.lockedUntil > nowMs) {
      if (escalateIdentityFailure) {
        recordPeerIdentityFailure(actorId, `${endpointName}:lock-active`);
      }
      await logAbuseEvent({
        type: 'temporary-lock-active',
        endpoint: endpointName,
        actorId,
        lockedUntil: new Date(existing.lockedUntil).toISOString(),
        metadata,
      });
      return {
        ok: false,
        code: 'RATE_LIMIT_LOCKED',
        message: `Temporary lock active for ${endpointName}. Try again later.`,
        lockedUntil: existing.lockedUntil,
      };
    }

    existing.hits = existing.hits.filter((timestamp) => nowMs - timestamp < limit.windowMs);
    existing.hits.push(nowMs);

    if (existing.hits.length > limit.max) {
      existing.lockedUntil = nowMs + limit.lockMs;
      endpointRateState.set(key, existing);
      saveRateLock(key, existing.lockedUntil);
      if (escalateIdentityFailure) {
        recordPeerIdentityFailure(actorId, `${endpointName}:rate-limit-triggered`);
      }
      await logAbuseEvent({
        type: 'rate-limit-triggered',
        endpoint: endpointName,
        actorId,
        count: existing.hits.length,
        windowMs: limit.windowMs,
        lockedUntil: new Date(existing.lockedUntil).toISOString(),
        metadata,
      });
      return {
        ok: false,
        code: 'RATE_LIMIT_EXCEEDED',
        message: `Rate limit exceeded for ${endpointName}. Temporary lock applied.`,
        lockedUntil: existing.lockedUntil,
      };
    }

    existing.lockedUntil = 0;
    endpointRateState.set(key, existing);
    return { ok: true };
  }

  return { loadRateLocks, saveRateLock, enforceEndpointRateLimit };
}

module.exports = { createRateLimiter };
