const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEDGER_FILE_NAME = 'round-ledger.json';
const SUPPLY_PER_TIER = 1_000_000;
const MAX_TIERS = 21;
const BASE_REWARD = 1000;
const MATURITY_DEPTH = 100;

function getDefaultState() {
  return {
    version: 1,
    nextRoundId: 1,
    currentRound: {
      id: 1,
      startedAtMs: Date.now(),
      contributionsWh: {},
      contributionUpdatedAtMs: {},
      probeChainIndex: {},
      contributionMessage: {},
      contributionSignature: {},
    },
    rounds: [],
    balancesByAddress: {},
  };
}

function rewardForRoundIndex(roundIndex) {
  let remaining = Math.max(0, Math.floor(Number(roundIndex) || 0));
  for (let tier = 0; tier < MAX_TIERS; tier++) {
    const reward = BASE_REWARD / Math.pow(2, tier);
    const blocksThisTier = Math.round(SUPPLY_PER_TIER / reward);
    if (remaining < blocksThisTier) return Number(reward.toFixed(8));
    remaining -= blocksThisTier;
  }
  return 0;
}

function normalizeAddress(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function createRoundLedger(options = {}) {
  const baseDir = options.baseDir;
  if (!baseDir) throw new Error('Round ledger requires baseDir.');
  const signingSecret = options.signingSecret || null;
  const filePath = path.join(baseDir, LEDGER_FILE_NAME);
  const tempFilePath = `${filePath}.tmp`;
  let state = getDefaultState();

  function computeLedgerSig(obj) {
    const secret = typeof signingSecret === 'function' ? signingSecret() : signingSecret;
    if (!secret) return null;
    return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(JSON.stringify(obj)).digest('hex');
  }

  function ensureDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function load() {
    try {
      ensureDir();
      if (!fs.existsSync(filePath) && fs.existsSync(tempFilePath)) {
        try {
          fs.renameSync(tempFilePath, filePath);
        } catch (_) {
          // Best effort recovery; fall through to normal create/read behavior.
        }
      }
      if (!fs.existsSync(filePath)) {
        save();
        return;
      }
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const { _sig, ...data } = parsed;
      if (_sig) {
        const resolvedSecret = typeof signingSecret === 'function' ? signingSecret() : signingSecret;
        if (resolvedSecret) {
          const expected = computeLedgerSig(data);
          const a = Buffer.from(String(_sig), 'utf8');
          const b = Buffer.from(String(expected), 'utf8');
          if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            console.warn('[RoundLedger] Tampered ledger detected - resetting to defaults.');
            state = getDefaultState();
            save();
            return;
          }
        }
      }
      state = {
        ...getDefaultState(),
        ...data,
      };
      if (!state.currentRound || typeof state.currentRound !== 'object') {
        state.currentRound = {
          id: state.nextRoundId || 1,
          startedAtMs: Date.now(),
          contributionsWh: {},
          probeChainIndex: {},
        };
      }
      if (!state.currentRound.contributionsWh || typeof state.currentRound.contributionsWh !== 'object') {
        state.currentRound.contributionsWh = {};
      }
      if (
        !state.currentRound.contributionUpdatedAtMs ||
        typeof state.currentRound.contributionUpdatedAtMs !== 'object'
      ) {
        state.currentRound.contributionUpdatedAtMs = {};
      }
      if (!state.currentRound.probeChainIndex || typeof state.currentRound.probeChainIndex !== 'object') {
        state.currentRound.probeChainIndex = {};
      }
      if (!state.currentRound.contributionMessage || typeof state.currentRound.contributionMessage !== 'object') {
        state.currentRound.contributionMessage = {};
      }
      if (!state.currentRound.contributionSignature || typeof state.currentRound.contributionSignature !== 'object') {
        state.currentRound.contributionSignature = {};
      }
      if (!Array.isArray(state.rounds)) state.rounds = [];
      if (!state.balancesByAddress || typeof state.balancesByAddress !== 'object') {
        state.balancesByAddress = {};
      }
    } catch (_) {
      state = getDefaultState();
      save();
    }
  }

  function save() {
    ensureDir();
    const sig = computeLedgerSig(state);
    const toWrite = sig ? { ...state, _sig: sig } : state;
    const serialized = JSON.stringify(toWrite, null, 2);
    const fd = fs.openSync(tempFilePath, 'w');
    try {
      fs.writeSync(fd, serialized, null, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.renameSync(tempFilePath, filePath);
    } catch (err) {
      if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) {
        try {
          fs.rmSync(filePath, { force: true });
        } catch (_) {
          // Best effort fallback before retrying rename.
        }
        fs.renameSync(tempFilePath, filePath);
      } else {
        throw err;
      }
    }
  }

  function ensureBalance(address) {
    const key = normalizeAddress(address);
    if (!key) return null;
    if (!state.balancesByAddress[key]) {
      state.balancesByAddress[key] = {
        pending: 0,
        matured: 0,
        totalCredited: 0,
      };
    }
    return state.balancesByAddress[key];
  }

  function addContribution(address, deltaWh) {
    const key = normalizeAddress(address);
    const delta = Math.max(0, Number(deltaWh) || 0);
    if (!key || delta <= 0) {
      return { ok: true, acceptedWh: 0, roundId: state.currentRound.id };
    }

    const prev = Math.max(0, Number(state.currentRound.contributionsWh[key]) || 0);
    state.currentRound.contributionsWh[key] = Number((prev + delta).toFixed(8));
    state.currentRound.contributionUpdatedAtMs[key] = Date.now();
    save();
    return {
      ok: true,
      acceptedWh: delta,
      address: key,
      roundId: state.currentRound.id,
      addressRoundWh: state.currentRound.contributionsWh[key],
    };
  }

  function setRoundContribution(
    address,
    totalWh,
    updatedAtMs = Date.now(),
    probeChainIndex = -1,
    message = '',
    signature = '',
  ) {
    const key = normalizeAddress(address);
    const nextTotal = Math.max(0, Number(totalWh) || 0);
    const normalizedUpdatedAtMs = Math.max(0, Math.floor(Number(updatedAtMs) || 0));
    if (!key) {
      return { ok: true, acceptedWh: 0, roundId: state.currentRound.id };
    }

    const previousUpdatedAtMs = Math.max(0, Number(state.currentRound.contributionUpdatedAtMs[key]) || 0);
    if (previousUpdatedAtMs > 0 && normalizedUpdatedAtMs > 0 && normalizedUpdatedAtMs < previousUpdatedAtMs) {
      return {
        ok: false,
        stale: true,
        code: 'STALE_CONTRIBUTION',
        address: key,
        roundId: state.currentRound.id,
        addressRoundWh: Math.max(0, Number(state.currentRound.contributionsWh[key]) || 0),
        updatedAtMs: previousUpdatedAtMs,
      };
    }

    const normalizedChainIndex = Math.max(0, Math.floor(Number(probeChainIndex) || 0));

    if (nextTotal <= 0) {
      if (Object.prototype.hasOwnProperty.call(state.currentRound.contributionsWh, key)) {
        delete state.currentRound.contributionsWh[key];
        delete state.currentRound.contributionUpdatedAtMs[key];
        delete state.currentRound.probeChainIndex[key];
        delete state.currentRound.contributionMessage[key];
        delete state.currentRound.contributionSignature[key];
        save();
      }
      return {
        ok: true,
        acceptedWh: 0,
        address: key,
        roundId: state.currentRound.id,
        addressRoundWh: 0,
      };
    }

    state.currentRound.contributionsWh[key] = Number(nextTotal.toFixed(8));
    state.currentRound.contributionUpdatedAtMs[key] = normalizedUpdatedAtMs > 0 ? normalizedUpdatedAtMs : Date.now();
    if (normalizedChainIndex >= 0) {
      state.currentRound.probeChainIndex[key] = normalizedChainIndex;
    }
    if (message) state.currentRound.contributionMessage[key] = String(message);
    if (signature) state.currentRound.contributionSignature[key] = String(signature);
    save();
    return {
      ok: true,
      acceptedWh: state.currentRound.contributionsWh[key],
      address: key,
      roundId: state.currentRound.id,
      addressRoundWh: state.currentRound.contributionsWh[key],
      probeChainIndex: state.currentRound.probeChainIndex[key],
    };
  }

  function getCurrentRoundSnapshot() {
    const contributionsWh = { ...(state.currentRound.contributionsWh || {}) };
    const totalWh = Object.values(contributionsWh).reduce((sum, value) => sum + Math.max(0, Number(value) || 0), 0);
    return {
      id: Number(state.currentRound.id) || 0,
      startedAtMs: Number(state.currentRound.startedAtMs) || 0,
      contributionsWh,
      contributionUpdatedAtMs: { ...(state.currentRound.contributionUpdatedAtMs || {}) },
      contributionMessage: { ...(state.currentRound.contributionMessage || {}) },
      contributionSignature: { ...(state.currentRound.contributionSignature || {}) },
      totalWh: Number(totalWh.toFixed(8)),
    };
  }

  function beginRound(roundId, startedAtMs = Date.now()) {
    const nextRoundId = Math.max(1, Math.floor(Number(roundId) || 0));
    if (nextRoundId <= 0) {
      return getCurrentRoundSnapshot();
    }
    if (Number(state.currentRound.id) === nextRoundId) {
      if (startedAtMs > 0) {
        state.currentRound.startedAtMs = Number(startedAtMs) || state.currentRound.startedAtMs;
        save();
      }
      return getCurrentRoundSnapshot();
    }
    state.nextRoundId = nextRoundId;
    state.currentRound = {
      id: nextRoundId,
      startedAtMs: Number(startedAtMs) || Date.now(),
      contributionsWh: {},
      probeChainIndex: {},
      contributionMessage: {},
      contributionSignature: {},
    };
    save();
    return getCurrentRoundSnapshot();
  }

  function syncMaturity(currentHeight) {
    const height = Math.max(0, Math.floor(Number(currentHeight) || 0));
    let maturedRounds = 0;

    for (const round of state.rounds) {
      if (!round || typeof round !== 'object') continue;
      if (round.maturedAtHeight) continue;
      if ((Number(round.matureAtHeight) || 0) > height) continue;
      const shares = round.sharesByAddress && typeof round.sharesByAddress === 'object' ? round.sharesByAddress : {};
      for (const [address, amountRaw] of Object.entries(shares)) {
        const amount = Math.max(0, Number(amountRaw) || 0);
        if (amount <= 0) continue;
        const balance = ensureBalance(address);
        if (!balance) continue;
        balance.pending = Number(Math.max(0, (Number(balance.pending) || 0) - amount).toFixed(8));
        balance.matured = Number(((Number(balance.matured) || 0) + amount).toFixed(8));
      }
      round.maturedAtHeight = height;
      round.maturedAtMs = Date.now();
      maturedRounds++;
    }

    if (maturedRounds > 0) save();
    return maturedRounds;
  }

  function settleCurrentRound(params = {}) {
    const minedAddress = normalizeAddress(params.minedAddress);
    const blockHash = typeof params.blockHash === 'string' ? params.blockHash.trim() : '';
    const blockHeight = Math.max(0, Math.floor(Number(params.blockHeight) || 0));

    if (blockHash) {
      const existingRound = state.rounds.find((round) => round && round.blockHash === blockHash);
      if (existingRound) {
        return {
          ...existingRound,
          idempotent: true,
          duplicateBlock: true,
        };
      }
    }

    const roundIndex = state.rounds.length;
    const rewardCoins = Number.isFinite(Number(params.rewardCoins))
      ? Math.max(0, Number(params.rewardCoins))
      : rewardForRoundIndex(roundIndex);
    const suppliedContributions =
      params && params.contributionsWh && typeof params.contributionsWh === 'object' ? params.contributionsWh : null;
    const contributions = suppliedContributions
      ? { ...suppliedContributions }
      : { ...(state.currentRound.contributionsWh || {}) };
    const contributionEntries = Object.entries(contributions)
      .map(([address, whRaw]) => [normalizeAddress(address), Math.max(0, Number(whRaw) || 0)])
      .filter(([address, wh]) => address && wh > 0);

    let totalWh = contributionEntries.reduce((sum, [, wh]) => sum + wh, 0);
    if (totalWh <= 0 && minedAddress) {
      contributionEntries.push([minedAddress, 1]);
      totalWh = 1;
    }

    const sharesByAddress = {};
    let allocated = 0;
    if (rewardCoins > 0 && totalWh > 0) {
      contributionEntries.forEach(([address, wh], idx) => {
        const isLast = idx === contributionEntries.length - 1;
        let share = isLast
          ? Number((rewardCoins - allocated).toFixed(8))
          : Number(((rewardCoins * wh) / totalWh).toFixed(8));
        if (share < 0) share = 0;
        allocated = Number((allocated + share).toFixed(8));
        sharesByAddress[address] = Number(((sharesByAddress[address] || 0) + share).toFixed(8));
      });
    }

    for (const [address, amountRaw] of Object.entries(sharesByAddress)) {
      const amount = Math.max(0, Number(amountRaw) || 0);
      if (amount <= 0) continue;
      const balance = ensureBalance(address);
      if (!balance) continue;
      balance.pending = Number(((Number(balance.pending) || 0) + amount).toFixed(8));
      balance.totalCredited = Number(((Number(balance.totalCredited) || 0) + amount).toFixed(8));
    }

    const roundRecord = {
      id: state.currentRound.id,
      rewardCoins,
      totalWh: Number(totalWh.toFixed(8)),
      sharesByAddress,
      contributionsWh: Object.fromEntries(contributionEntries),
      blockHash,
      blockHeight,
      minedAddress,
      foundAtMs: Date.now(),
      matureAtHeight: blockHeight + MATURITY_DEPTH,
      maturedAtHeight: null,
      maturedAtMs: null,
    };

    state.rounds.push(roundRecord);
    state.nextRoundId = Math.max(1, Number(state.nextRoundId) || 1) + 1;
    state.currentRound = {
      id: state.nextRoundId,
      startedAtMs: Date.now(),
      contributionsWh: {},
      probeChainIndex: {},
    };

    save();
    return roundRecord;
  }

  function getAddressSnapshot(address) {
    const key = normalizeAddress(address);
    const balance = key ? state.balancesByAddress[key] : null;
    const pending = Math.max(0, Number(balance && balance.pending) || 0);
    const matured = Math.max(0, Number(balance && balance.matured) || 0);
    const total = Number((pending + matured).toFixed(8));
    return {
      address: key,
      pending,
      matured,
      total,
    };
  }

  function getRoundContribution(address) {
    const key = normalizeAddress(address);
    if (!key) return 0;
    return Math.max(0, Number(state.currentRound.contributionsWh[key]) || 0);
  }

  // Tier 4: forfeit an address's contribution for the current round.n  // Called when a device-fingerprint-change issue is detected at settle time.
  function forfeitContribution(address) {
    const key = normalizeAddress(address);
    if (!key) return { ok: true, forfeited: 0 };
    const forfeited = Math.max(0, Number(state.currentRound.contributionsWh[key]) || 0);
    if (forfeited > 0) {
      delete state.currentRound.contributionsWh[key];
      save();
    }
    return { ok: true, forfeited, address: key };
  }

  // Tier 4c: reduce an address's contribution by a fraction (0–1).
  // Used when a miner has no peer-verified probe for the round (standalone mode).
  // Fraction 0.5 = 50% penalty, preserving 50% of contributions.
  function partialForfeit(address, fraction) {
    const key = normalizeAddress(address);
    if (!key) return { ok: true, forfeited: 0 };
    const current = Math.max(0, Number(state.currentRound.contributionsWh[key]) || 0);
    const f = Math.min(1, Math.max(0, Number(fraction) || 0.5));
    const forfeited = Number((current * f).toFixed(8));
    if (forfeited > 0) {
      state.currentRound.contributionsWh[key] = Number((current - forfeited).toFixed(8));
      save();
    }
    return { ok: true, forfeited, remaining: state.currentRound.contributionsWh[key] || 0, address: key };
  }

  function getCurrentRoundStartMs() {
    return Number(state.currentRound && state.currentRound.startedAtMs) || 0;
  }

  load();

  return {
    addContribution,
    setRoundContribution,
    beginRound,
    settleCurrentRound,
    syncMaturity,
    getAddressSnapshot,
    getRoundContribution,
    getCurrentRoundSnapshot,
    getMaturityDepth: () => MATURITY_DEPTH,
    forfeitContribution,
    partialForfeit,
    getCurrentRoundStartMs,
  };
}

module.exports = {
  createRoundLedger,
};
