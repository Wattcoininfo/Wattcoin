const fs = require('fs');
const fsp = fs.promises;
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
  let _tampered = false;

  function computeLedgerSig(obj) {
    const secret = typeof signingSecret === 'function' ? signingSecret() : signingSecret;
    if (!secret) return null;
    return crypto.createHmac('sha256', Buffer.from(secret, 'utf8')).update(JSON.stringify(obj)).digest('hex');
  }

  function ensureDir() {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  function tryLoadBackup() {
    const backupPath = filePath + '.bak';
    if (!fs.existsSync(backupPath)) return null;
    try {
      const raw = fs.readFileSync(backupPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const { _sig, ...data } = parsed;
      const resolvedSecret = typeof signingSecret === 'function' ? signingSecret() : signingSecret;
      if (resolvedSecret) {
        const expected = computeLedgerSig(data);
        const a = Buffer.from(String(_sig || ''), 'utf8');
        const b = Buffer.from(String(expected), 'utf8');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          return null;
        }
      }
      return data;
    } catch (_) {
      return null;
    }
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
      const resolvedSecret = typeof signingSecret === 'function' ? signingSecret() : signingSecret;
      let sigValid = !resolvedSecret; // no secret → can't check, accept
      if (resolvedSecret && _sig) {
        const expected = computeLedgerSig(data);
        const a = Buffer.from(String(_sig), 'utf8');
        const b = Buffer.from(String(expected), 'utf8');
        sigValid = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (!sigValid) {
        _tampered = true;
        console.warn('[RoundLedger] HMAC mismatch - attempting recovery from backup.');
        const backupData = tryLoadBackup();
        if (backupData && backupData.currentRound && typeof backupData.currentRound === 'object') {
          state = {
            ...getDefaultState(),
            rounds: Array.isArray(backupData.rounds)
              ? backupData.rounds
              : Array.isArray(data.rounds)
                ? data.rounds
                : [],
            balancesByAddress:
              backupData.balancesByAddress && typeof backupData.balancesByAddress === 'object'
                ? { ...backupData.balancesByAddress }
                : data.balancesByAddress && typeof data.balancesByAddress === 'object'
                  ? { ...data.balancesByAddress }
                  : {},
            nextRoundId: Math.max(1, Number(data.nextRoundId) || 1),
            currentRound: {
              ...backupData.currentRound,
              contributionMessage: {},
              contributionSignature: {},
            },
          };
          save();
          return;
        }
        console.warn('[RoundLedger] No valid backup - resetting current round data.');
        state = {
          ...getDefaultState(),
          nextRoundId: Math.max(1, Number(data.nextRoundId) || 1),
        };
        if (data.currentRound && typeof data.currentRound === 'object' && Number(data.currentRound.id) > 0) {
          state.currentRound.id = Number(data.currentRound.id);
        }
        state.currentRound.startedAtMs = Date.now();
        save();
        return;
      }
      state = {
        ...getDefaultState(),
        ...data,
      };
      delete state.currentRound.probeChainSegments;
      delete state.currentRound.peerProbesAnswered;
      delete state.currentRound.peerProbesFailed;
      if (!state.currentRound || typeof state.currentRound !== 'object') {
        state.currentRound = {
          id: state.nextRoundId || 1,
          startedAtMs: Date.now(),
          contributionsWh: {},
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
      if (!state.currentRound.contributionMessage || typeof state.currentRound.contributionMessage !== 'object') {
        state.currentRound.contributionMessage = {};
      }
      if (!state.currentRound.contributionSignature || typeof state.currentRound.contributionSignature !== 'object') {
        state.currentRound.contributionSignature = {};
      }
      if (!Array.isArray(state.rounds)) state.rounds = [];
      for (const r of state.rounds) {
        if (r && typeof r === 'object') {
          delete r.peerProbesAnswered;
          delete r.peerProbesFailed;
          delete r.probeChainSegments;
        }
      }
      if (!state.balancesByAddress || typeof state.balancesByAddress !== 'object') {
        state.balancesByAddress = {};
      }
      for (const b of Object.values(state.balancesByAddress)) {
        if (b && typeof b === 'object') {
          delete b.totalCredited;
        }
      }
    } catch (_) {
      console.warn('[RoundLedger] Parse error - attempting recovery from backup.');
      const backupData = tryLoadBackup();
      if (backupData) {
        state = {
          ...getDefaultState(),
          ...backupData,
        };
        save();
        return;
      }
      console.warn('[RoundLedger] No valid backup - resetting to default.');
      state = getDefaultState();
      save();
    }
  }

  let _savePending = false;
  let _saveTimer = null;

  async function _doSave() {
    _savePending = false;
    _saveTimer = null;
    try {
      ensureDir();
      const sig = computeLedgerSig(state);
      const toWrite = sig ? { ...state, _sig: sig } : state;
      const serialized = JSON.stringify(toWrite, null, 2);
      const backupPath = filePath + '.bak';
      try {
        await fsp.copyFile(filePath, backupPath);
      } catch (_) {}
      const fd = await fsp.open(tempFilePath, 'w');
      try {
        await fd.writeFile(serialized, null, 'utf8');
        await fd.sync();
      } finally {
        await fd.close();
      }
      try {
        await fsp.rename(tempFilePath, filePath);
      } catch (err) {
        if (err && (err.code === 'EEXIST' || err.code === 'EPERM')) {
          try {
            await fsp.rm(filePath, { force: true });
          } catch (_) {}
          await fsp.rename(tempFilePath, filePath);
        } else {
          throw err;
        }
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[RoundLedger] Save failed:', String(_.message || _).slice(0, 80));
    }
  }

  function save() {
    if (_savePending) return;
    _savePending = true;
    _saveTimer = setTimeout(_doSave, 200);
  }

  function ensureBalance(address) {
    const key = normalizeAddress(address);
    if (!key) return null;
    if (!state.balancesByAddress[key]) {
      state.balancesByAddress[key] = {
        pending: 0,
        matured: 0,
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

  function recordPeerProbe(_address) {
    return { ok: true, total: 0 };
  }

  function recordPeerProbeFailed(_address) {
    return { ok: true, total: 0 };
  }

  function setRoundContribution(address, totalWh, updatedAtMs = Date.now(), message = '', signature = '') {
    const key = normalizeAddress(address);
    const nextTotal = Math.max(0, Number(totalWh) || 0);
    const normalizedUpdatedAtMs = Math.max(0, Math.floor(Number(updatedAtMs) || 0));
    if (!key) {
      return { ok: true, acceptedWh: 0, roundId: state.currentRound.id };
    }

    const previousUpdatedAtMs = Math.max(0, Number(state.currentRound.contributionUpdatedAtMs[key]) || 0);
    const hasExistingSig = !!state.currentRound.contributionSignature[key];
    const hasIncomingSig = !!(signature && message);
    if (previousUpdatedAtMs > 0 && normalizedUpdatedAtMs > 0 && normalizedUpdatedAtMs < previousUpdatedAtMs) {
      // If the incoming contribution is cryptographically signed but the stored
      // entry has no signature, the stored timestamp may have been inflated by
      // an unverified pull (e.g. majority-vote used Date.now()).  Allow the
      // signed contribution through so the original worker's broadcasts are not
      // permanently blocked by a synthetic timestamp.
      if (!hasIncomingSig || hasExistingSig) {
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
    }

    const prevTotal = Math.max(0, Number(state.currentRound.contributionsWh[key]) || 0);
    if (prevTotal > 0 && nextTotal < prevTotal) {
      return {
        ok: false,
        stale: false,
        code: 'REDUCTION_NOT_ALLOWED',
        message: 'Contribution reduction rejected (use forfeit path or pull from peers to restore correct value).',
        address: key,
        roundId: state.currentRound.id,
        addressRoundWh: prevTotal,
        updatedAtMs: previousUpdatedAtMs,
      };
    }

    if (nextTotal <= 0) {
      if (Object.prototype.hasOwnProperty.call(state.currentRound.contributionsWh, key)) {
        delete state.currentRound.contributionsWh[key];
        delete state.currentRound.contributionUpdatedAtMs[key];
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
    if (message) state.currentRound.contributionMessage[key] = String(message);
    if (signature) state.currentRound.contributionSignature[key] = String(signature);
    save();
    return {
      ok: true,
      acceptedWh: state.currentRound.contributionsWh[key],
      address: key,
      roundId: state.currentRound.id,
      addressRoundWh: state.currentRound.contributionsWh[key],
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
      contributionUpdatedAtMs: {},
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
      contributionUpdatedAtMs: {},
      contributionMessage: {},
      contributionSignature: {},
    };

    save();
    return roundRecord;
  }

  function archiveCurrentRound() {
    const contributions = state.currentRound.contributionsWh || {};
    const entries = Object.entries(contributions);
    if (entries.length === 0) return null;
    const archiveRecord = {
      id: Number(state.currentRound.id) || 0,
      startedAtMs: Number(state.currentRound.startedAtMs) || 0,
      archivedAtMs: Date.now(),
      totalWh: Number(entries.reduce((sum, [, wh]) => sum + Math.max(0, Number(wh) || 0), 0).toFixed(8)),
      contributionsWh: { ...contributions },
      contributionUpdatedAtMs: { ...(state.currentRound.contributionUpdatedAtMs || {}) },
      contributionMessage: { ...(state.currentRound.contributionMessage || {}) },
      contributionSignature: { ...(state.currentRound.contributionSignature || {}) },
    };
    state.rounds.push(archiveRecord);
    save();
    return archiveRecord;
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

  function getRoundContributionUpdatedAt(address) {
    const key = normalizeAddress(address);
    if (!key) return 0;
    return Math.max(0, Number(state.currentRound.contributionUpdatedAtMs[key]) || 0);
  }

  // Tier 4: forfeit an address's contribution for the current round.n  // Called when a device-fingerprint-change issue is detected at settle time.
  function getCurrentRoundStartMs() {
    return Number(state.currentRound && state.currentRound.startedAtMs) || 0;
  }

  function isTampered() {
    return _tampered;
  }

  function clearTamperedFlag() {
    _tampered = false;
  }

  return {
    load,
    addContribution,
    setRoundContribution,
    beginRound,
    settleCurrentRound,
    syncMaturity,
    getAddressSnapshot,
    getRoundContribution,
    getRoundContributionUpdatedAt,
    getCurrentRoundSnapshot,
    getMaturityDepth: () => MATURITY_DEPTH,
    recordPeerProbe,
    recordPeerProbeFailed,
    getCurrentRoundStartMs,
    archiveCurrentRound,
    isTampered,
    clearTamperedFlag,
  };
}

module.exports = {
  createRoundLedger,
};
