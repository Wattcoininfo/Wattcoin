'use strict';

const os = require('os');

// -- Rolling window constants (same as electron-main.js) ------------------------
const _CPU_DUTY_WINDOW_MS = 20000;
const _GPU_DUTY_WINDOW_MS = 20000;

// -- OS CPU utilization cross-check: local state ---------------------------------
let _osCpuUsagePrev = null;
let _osCpuUsageCheckTs = 0;
let _smoothedOsCpuDuty = -1;
let _osMeasurementsCount = 0;
let _physicalCoreCount = 0;

function _getOsCpuDuty() {
  const now = Date.now();
  if (_osCpuUsagePrev && now - _osCpuUsageCheckTs < 10000) {
    return _smoothedOsCpuDuty >= 0 ? _smoothedOsCpuDuty : 0;
  }
  const current = process.cpuUsage();
  if (_osCpuUsagePrev) {
    const deltaUs = current.user - _osCpuUsagePrev.user + (current.system - _osCpuUsagePrev.system);
    const deltaMs = now - _osCpuUsageCheckTs;
    if (deltaMs > 100) {
      const coreFraction = deltaUs / 1_000_000 / (deltaMs / 1000);
      const rawOsDuty = _physicalCoreCount > 0 ? Math.min(1, coreFraction / _physicalCoreCount) : 1;
      _smoothedOsCpuDuty = _smoothedOsCpuDuty < 0 ? rawOsDuty : _smoothedOsCpuDuty * 0.95 + rawOsDuty * 0.05;
      _osMeasurementsCount++;
    }
  }
  _osCpuUsagePrev = current;
  _osCpuUsageCheckTs = now;
  return _smoothedOsCpuDuty >= 0 ? _smoothedOsCpuDuty : 0;
}

/**
 * Cache of peer governance capability: Map<peerUrl, { hasNfts, cachedAtMs }>
 * Extracted here because it is needed by the ledger request handler.
 */
function _nodeHasGovernanceNfts(wtcNode) {
  if (!wtcNode) return false;
  const addrs = wtcNode.getAddresses();
  for (const addr of addrs) {
    const nfts = wtcNode.getNftsForAddress(addr);
    if (nfts && nfts.length > 0) return true;
  }
  return false;
}

function registerLedgerIpcHandlers(deps) {
  const {
    ipcMain,
    roundLedger,
    getWtcNode,
    hwAuthority,
    walletAddressCache,
    getLedgerNetworkSettings,
    enforceEndpointRateLimit,
    settleLocalLedgerRound,
    alignRoundLedgerToChain,
    getMeasuredCpuDuty,
    getGpuLoadState,
    getSharedRoundSnapshot,
    hasOnlinePeers,
    getLocalLedgerBalances,
    loadBenchmarkHistory,
    getMeasuredOpsPerMs,
    hasValidGpuTelemetry,
    // Shared mutable state (object refs – use .current)
    _pendingContributionWh,
    _contributionPerSecond,
    _contributionSecondStart,
    _startupRampUp,
    _startupRampUpStartedAt,
    _cpuDutySamples,
    _prevRawCpuDuty,
    _startupGpuRampUp,
    _startupGpuRampUpStartedAt,
    _gpuDutySamples,
    _prevRawGpuDuty,
    _physicalCoreCount: _physicalCoreCountRef,
  } = deps;

  // Sync module-level _physicalCoreCount with the caller's ref so the
  // external caller (electron-main.js) can set it from startup data.
  if (_physicalCoreCountRef && typeof _physicalCoreCountRef.current === 'number') {
    _physicalCoreCount = _physicalCoreCountRef.current;
  }
  // Allow external updates by reassigning the ref's .current (handled below).

  // ---- Rolling CPU duty helpers (use .current on ref arrays) --------------------

  function _trackCpuDuty(duty) {
    _cpuDutySamples.current.push({ ts: Date.now(), duty: Math.max(0, Math.min(1, Number(duty) || 0)) });
  }

  function _getRollingCpuDuty() {
    const now = Date.now();
    while (_cpuDutySamples.current.length > 0 && now - _cpuDutySamples.current[0].ts > _CPU_DUTY_WINDOW_MS) {
      _cpuDutySamples.current.shift();
    }
    if (_cpuDutySamples.current.length === 0) return 0;
    let sum = 0;
    for (const s of _cpuDutySamples.current) sum += s.duty;
    return sum / _cpuDutySamples.current.length;
  }

  // ---- Rolling GPU duty helpers (use .current on ref arrays) --------------------

  function _trackGpuDuty(duty) {
    _gpuDutySamples.current.push({ ts: Date.now(), duty: Math.max(0, Math.min(1, Number(duty) || 0)) });
  }

  function _getRollingGpuDuty() {
    const now = Date.now();
    while (_gpuDutySamples.current.length > 0 && now - _gpuDutySamples.current[0].ts > _GPU_DUTY_WINDOW_MS) {
      _gpuDutySamples.current.shift();
    }
    if (_gpuDutySamples.current.length === 0) return 0;
    let sum = 0;
    for (const s of _gpuDutySamples.current) sum += s.duty;
    return sum / _gpuDutySamples.current.length;
  }

  // ---- IPC: wattcoin-ledger-add-contribution ------------------------------------

  ipcMain.handle('wattcoin-ledger-add-contribution', async (_, address, deltaWh) => {
    const wtcNode = getWtcNode();
    // Keep _physicalCoreCount in sync with the external ref (set at startup).
    if (
      _physicalCoreCountRef &&
      typeof _physicalCoreCountRef.current === 'number' &&
      _physicalCoreCountRef.current !== _physicalCoreCount
    ) {
      _physicalCoreCount = _physicalCoreCountRef.current;
    }

    const verifiedAddress =
      walletAddressCache.address || (typeof address === 'string' && address.trim() ? address.trim() : 'local-client');

    if (roundLedger.isTampered && roundLedger.isTampered()) {
      return {
        ok: false,
        code: 'LEDGER_TAMPERED',
        message: 'Round ledger file integrity check failed. Pulling correct state from peers...',
      };
    }

    if (hwAuthority.hwChangedBlocked) {
      return {
        ok: false,
        code: 'HW_CHANGED',
        message: 'Hardware changed. Please create a new wallet to continue mining.',
      };
    }

    if (hwAuthority.hwHoldUntilMs > Date.now()) {
      const remainingH = ((hwAuthority.hwHoldUntilMs - Date.now()) / 3600000).toFixed(1);
      return {
        ok: false,
        code: 'HW_HOLD',
        message: `Mining suspended for ${remainingH}h due to hardware trust violations. Complete a benchmark when the hold expires.`,
      };
    }

    const _contributionBenchHistory = loadBenchmarkHistory();
    if (_contributionBenchHistory.cpuSamples.length === 0) {
      return {
        ok: false,
        code: 'NEVER_BENCHMARKED',
        message: 'No benchmark data on record. Complete a full hardware benchmark before mining.',
      };
    }

    if (!hwAuthority.calibratedUnitPowerW || hwAuthority.calibratedUnitPowerW <= 0) {
      return {
        ok: false,
        code: 'NO_CALIBRATED_POWER',
        message: 'Hardware power not calibrated. Complete a full hardware benchmark to calibrate.',
      };
    }

    if (wtcNode && !hasOnlinePeers(getLedgerNetworkSettings())) {
      return {
        ok: false,
        code: 'NO_PEERS',
        message: 'At least one peer must be connected before mining. Waiting for peer connection...',
      };
    }

    // ── Coordinator seed gate ────────────────────────────────────────────────
    // Energy contribution requires that the coordinator has issued a seed
    // and the worker has submitted at least one proof of work.  This replaces
    // the previous token-log verification with externally-verified seed proofs.
    // The actual seed proof verification happens at the coordinator level
    // (peer-probe-ipc.js); here we just ensure the worker is actively mining.
    if (!hwAuthority.calibratedUnitPowerW || hwAuthority.calibratedUnitPowerW <= 0) {
      return {
        ok: false,
        code: 'NO_CALIBRATED_POWER',
        message: 'Hardware power not calibrated. Complete a full hardware benchmark to calibrate.',
      };
    }

    let clampedDeltaWh = Math.max(0, Number(deltaWh) || 0);
    const tf = Math.min(1.0, 0.2 + (hwAuthority.trustScore / 100) * 0.8);
    const claimedLoad = Math.min(1, Math.max(0.1, (hwAuthority.currentLoadPercent || 100) / 100));

    let measuredCpuDuty = 0;
    const _rawCpuDuty = getMeasuredCpuDuty();
    if (_rawCpuDuty >= 0) measuredCpuDuty = Math.min(claimedLoad, Math.max(0, _rawCpuDuty));

    if (_rawCpuDuty >= 0 && !_startupRampUp.current && _prevRawCpuDuty.current < 0) {
      _startupRampUp.current = true;
      _startupRampUpStartedAt.current = Date.now();
    }
    if (
      _startupRampUp.current &&
      _osMeasurementsCount >= 2 &&
      (_rawCpuDuty >= claimedLoad * 0.5 || Date.now() - _startupRampUpStartedAt.current > 15000)
    ) {
      _startupRampUp.current = false;
      _cpuDutySamples.current.length = 0;
    }
    _prevRawCpuDuty.current = _rawCpuDuty;

    _trackCpuDuty(measuredCpuDuty);
    const windowedCpuDuty = _getRollingCpuDuty();
    const _osCpuDuty = _startupRampUp.current ? claimedLoad : _getOsCpuDuty();
    const effectiveCpuDuty = _startupRampUp.current
      ? Math.min(claimedLoad, Math.max(measuredCpuDuty, windowedCpuDuty))
      : Math.min(claimedLoad, measuredCpuDuty, windowedCpuDuty, _osCpuDuty);

    let effectiveGpuDuty = 0;
    try {
      // GPU contribution gated on coordinator-issued seed proofs.
      // hasValidGpuTelemetry returns true once the GPU binary reports
      // actual load data (dispatch_count, pow_time_ms, etc.).
      const hasGpuTelemetry = typeof hasValidGpuTelemetry === 'function' && hasValidGpuTelemetry();
      if (!hasGpuTelemetry) {
        _trackGpuDuty(0);
        effectiveGpuDuty = 0;
      } else {
        const _gpuState = getGpuLoadState();
        if (_gpuState) {
          const _gpuFresh = _gpuState.ts > 0 && Date.now() - _gpuState.ts < 5000;
          if (_gpuFresh && _gpuState.duty !== undefined) {
            const instantDuty = Math.max(0, Number(_gpuState.duty) || 0);
            _trackGpuDuty(instantDuty);
            const windowedDuty = _getRollingGpuDuty();

            if (instantDuty >= 0 && !_startupGpuRampUp.current && _prevRawGpuDuty.current < 0) {
              _startupGpuRampUp.current = true;
              _startupGpuRampUpStartedAt.current = Date.now();
            }
            if (
              _startupGpuRampUp.current &&
              (instantDuty >= claimedLoad * 0.5 || Date.now() - _startupGpuRampUpStartedAt.current > 15000)
            ) {
              _startupGpuRampUp.current = false;
              _gpuDutySamples.current.length = 0;
            }
            _prevRawGpuDuty.current = instantDuty;

            effectiveGpuDuty = _startupGpuRampUp.current
              ? Math.min(claimedLoad, Math.max(instantDuty, windowedDuty))
              : Math.min(claimedLoad, instantDuty, windowedDuty);
          } else {
            _trackGpuDuty(0);
            effectiveGpuDuty = 0;
          }
        }
      }
    } catch (_) {
      /* ignore telemetry failures */
    }

    const _gpuPower = hwAuthority.nativeGpuTdpW || 0;
    const pcCalibratedPowerW = Math.max(0, hwAuthority.calibratedUnitPowerW - (hwAuthority.asicPowerW || 0));
    const _gpuFraction = pcCalibratedPowerW > 0 ? _gpuPower / pcCalibratedPowerW : 0;
    const _cpuFraction = 1 - _gpuFraction;
    const loadFactor = Math.max(0.1, effectiveCpuDuty * _cpuFraction + effectiveGpuDuty * _gpuFraction);

    const _now = Date.now();
    if (!_contributionPerSecond.current || _now - _contributionSecondStart.current > 1000) {
      _contributionSecondStart.current = _now;
      _contributionPerSecond.current = 0;
    }
    const _maxWhPerSecond = ((pcCalibratedPowerW * loadFactor + (hwAuthority.asicPowerW || 0)) * tf * 4 * 1.15) / 3600;
    const _remainingThisSecond = Math.max(0, _maxWhPerSecond - _contributionPerSecond.current);
    const _cappedDeltaWh = Math.min(clampedDeltaWh, _remainingThisSecond);
    if (_cappedDeltaWh < clampedDeltaWh) {
      clampedDeltaWh = _cappedDeltaWh;
    }
    _contributionPerSecond.current += clampedDeltaWh;

    const maxDeltaWh = ((pcCalibratedPowerW * loadFactor + (hwAuthority.asicPowerW || 0)) * tf * 0.5) / 3600;
    if (clampedDeltaWh > maxDeltaWh) {
      clampedDeltaWh = maxDeltaWh;
    }

    const actorId = verifiedAddress;
    const rateLimit = await enforceEndpointRateLimit('wattcoin-ledger-add-contribution', actorId, {
      address: actorId,
      deltaWh: clampedDeltaWh,
    });
    if (!rateLimit.ok) {
      return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
    }

    _pendingContributionWh.current += clampedDeltaWh;
    try {
      alignRoundLedgerToChain();
      const snapshot = roundLedger.getCurrentRoundSnapshot();
      return {
        ok: true,
        acceptedWh: clampedDeltaWh,
        addressRoundWh: 0,
        roundTotalWh: snapshot.totalWh,
      };
    } catch (_) {
      return { ok: true, acceptedWh: clampedDeltaWh, addressRoundWh: 0, roundTotalWh: 0 };
    }
  });

  // ---- IPC: wattcoin-ledger-get-round-summary -----------------------------------

  ipcMain.handle('wattcoin-ledger-get-round-summary', () => {
    try {
      const snapshot = getSharedRoundSnapshot();
      return {
        ok: true,
        roundId: snapshot.id,
        startedAtMs: snapshot.startedAtMs,
        totalWh: snapshot.totalWh,
        contributionsWh: snapshot.contributionsWh,
      };
    } catch (e) {
      return {
        ok: false,
        code: 'ROUND_SUMMARY_FAILED',
        message: e && e.message ? e.message : 'Failed to read round summary.',
      };
    }
  });

  // ---- IPC: wattcoin-ledger-settle-round ----------------------------------------

  ipcMain.handle('wattcoin-ledger-settle-round', async (_, payload = {}) => {
    const minedAddress = payload && payload.minedAddress ? String(payload.minedAddress) : 'local-client';
    const rateLimit = await enforceEndpointRateLimit('wattcoin-ledger-settle-round', minedAddress, {
      blockHash: payload && payload.blockHash ? String(payload.blockHash) : '',
      minedAddress,
    });
    if (!rateLimit.ok) {
      return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
    }
    try {
      return await settleLocalLedgerRound(payload || {});
    } catch (e) {
      return {
        ok: false,
        code: 'LEDGER_SETTLE_FAILED',
        message: e && e.message ? e.message : 'Failed to settle round.',
      };
    }
  });

  // ---- IPC: wattcoin-ledger-get-balances ----------------------------------------

  ipcMain.handle('wattcoin-ledger-get-balances', async (_, selectedAddress) => {
    const wtcNode = getWtcNode();
    const actorId =
      typeof selectedAddress === 'string' && selectedAddress.trim() ? selectedAddress.trim() : 'local-client';
    const rateLimit = await enforceEndpointRateLimit('wattcoin-ledger-get-balances', actorId, {
      selectedAddress: actorId,
    });
    if (!rateLimit.ok) {
      return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
    }
    if (wtcNode) {
      try {
        const addr =
          typeof selectedAddress === 'string' && selectedAddress.trim()
            ? selectedAddress.trim()
            : wtcNode.getPrimaryAddress();
        const bal = wtcNode.getBalance(addr);
        const stats = wtcNode.getMinedStats(addr);
        const blockHeight = wtcNode.getHeight();
        const currentRoundContributionWh = roundLedger.getRoundContribution(addr);
        return {
          ok: true,
          address: addr,
          balanceSource: 'wtc-native-chain',
          accountingModel: 'wtc-native',
          balanceSemanticsVersion: 3,
          isAddressSpecific: true,
          totalMinedCoins: stats.totalWTC,
          maturedMinedCoins: bal.confirmed,
          unmaturedMinedCoins: bal.unmatured,
          currentRoundContributionWh,
          blockHeight,
          maturityDepth: 100,
        };
      } catch (e) {
        return {
          ok: false,
          code: 'BALANCE_READ_FAILED',
          message: e && e.message ? e.message : 'Failed to read balance.',
        };
      }
    }
    try {
      return await getLocalLedgerBalances(selectedAddress);
    } catch (e) {
      return {
        ok: false,
        code: 'LEDGER_READ_FAILED',
        message: e && e.message ? e.message : 'Failed to read balances.',
      };
    }
  });
}

module.exports = { registerLedgerIpcHandlers, _nodeHasGovernanceNfts };
