const HW_RESET_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_CACHE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

function registerHardwareAuthorityIpcHandlers(ipcMain, deps) {
  const {
    hwAuthority,
    hwAuthStateIsNew,
    saveHwAuthState,
    loadHwFingerprint,
    clearHwFingerprint,
    clearBenchmarkHistory,
    walletAddressCache,
    enforceEndpointRateLimit,
    loadBenchmarkHistory,
    appendBenchmarkSample,
    getPersonalReference,
    saveBenchmarkHistory,
  } = deps;

  ipcMain.handle('wattcoin-get-authority-state', () => {
    const now = Date.now();
    const hwResetCooldownRemainingMs = Math.max(0, hwAuthority.lastHwResetAtMs + HW_RESET_COOLDOWN_MS - now);
    const searchCacheCooldownRemainingMs = Math.max(
      0,
      hwAuthority.lastSearchCacheClearAtMs + SEARCH_CACHE_COOLDOWN_MS - now,
    );
    return {
      trustScore: hwAuthority.trustScore,
      hwHoldUntilMs: hwAuthority.hwHoldUntilMs,
      isOnHold: hwAuthority.hwHoldUntilMs > now,
      benchmarkOpsCalibration: hwAuthority.benchmarkOpsCalibration,
      benchmarkMemCalibration: hwAuthority.benchmarkMemCalibration,
      benchmarkGpuCalibration: hwAuthority.benchmarkGpuCalibration,
      peerProbeVerifiedForRound: hwAuthority.peerProbeVerifiedForRound,
      calibratedUnitPowerW: hwAuthority.calibratedUnitPowerW,
      currentLoadPercent: hwAuthority.currentLoadPercent,
      hwChangedBlocked: hwAuthority.hwChangedBlocked,
      lastHwResetAtMs: hwAuthority.lastHwResetAtMs,
      hwResetCooldownRemainingMs,
      hwResetOnCooldown: hwResetCooldownRemainingMs > 0,
      searchCacheCooldownRemainingMs,
      searchCacheOnCooldown: searchCacheCooldownRemainingMs > 0,
      isFirstRun: hwAuthStateIsNew.current,
    };
  });

  ipcMain.handle('wattcoin-clear-search-cache', () => {
    const now = Date.now();
    const cooldownRemainingMs = Math.max(0, hwAuthority.lastSearchCacheClearAtMs + SEARCH_CACHE_COOLDOWN_MS - now);
    if (cooldownRemainingMs > 0) {
      const remainingDays = Math.ceil(cooldownRemainingMs / (24 * 60 * 60 * 1000));
      console.warn(`[searchCache] Clear blocked - cooldown active, ${remainingDays}d remaining.`);
      return { ok: false, reason: 'cooldown', cooldownRemainingMs, remainingDays };
    }
    hwAuthority.lastSearchCacheClearAtMs = now;
    saveHwAuthState();
    console.log('[searchCache] Search cache clear recorded.');
    return { ok: true, nextClearAllowedAtMs: now + SEARCH_CACHE_COOLDOWN_MS };
  });

  ipcMain.handle('wattcoin-reset-hardware-identity', () => {
    const now = Date.now();
    const cooldownRemainingMs = Math.max(0, hwAuthority.lastHwResetAtMs + HW_RESET_COOLDOWN_MS - now);
    if (cooldownRemainingMs > 0) {
      const remainingDays = Math.ceil(cooldownRemainingMs / (24 * 60 * 60 * 1000));
      console.warn(`[hwReset] Reset blocked - cooldown active, ${remainingDays}d remaining.`);
      return {
        ok: false,
        reason: 'cooldown',
        cooldownRemainingMs,
        remainingDays,
      };
    }
    const previousFingerprint = loadHwFingerprint();
    clearHwFingerprint();
    clearBenchmarkHistory();
    hwAuthority.hwChangedBlocked = false;
    hwAuthority.lastHwResetAtMs = now;
    saveHwAuthState();
    console.log('[hwReset] Hardware identity reset performed.');
    return {
      ok: true,
      clearedFingerprint: !!previousFingerprint,
      clearedBenchmarkHistory: true,
      previousFingerprint,
      nextResetAllowedAtMs: now + HW_RESET_COOLDOWN_MS,
    };
  });

  ipcMain.handle('wattcoin-seed-authority-state', (_event, payload = {}) => {
    if (!hwAuthStateIsNew.current) {
      return { ok: false, reason: 'not first run' };
    }
    const legacyTrust = Number(payload && payload.trustScore);
    const legacyHold = Number((payload && payload.hwHoldUntilMs) || 0);
    if (Number.isFinite(legacyTrust) && legacyTrust >= 0 && legacyTrust <= 50) {
      hwAuthority.trustScore = legacyTrust;
    }
    if (legacyHold > Date.now()) {
      hwAuthority.hwHoldUntilMs = legacyHold;
    }
    hwAuthStateIsNew.current = false;
    saveHwAuthState();
    return { ok: true, trustScore: hwAuthority.trustScore };
  });

  ipcMain.handle('wattcoin-report-gpu-calibration', async (_event, payload = {}) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, code: 'INVALID_PAYLOAD', personalMeanGpuRatio: 0 };
    }
    const gpuActorId = walletAddressCache.address || 'local-client';
    const gpuRateLimit = await enforceEndpointRateLimit('wattcoin-report-gpu-calibration', gpuActorId, {});
    if (!gpuRateLimit.ok) {
      return { ok: gpuRateLimit.ok, personalMeanGpuRatio: 0 };
    }
    const gpuScore = Number((payload && payload.gpuScore) || 0);
    const GPU_MAX_EXPECTED_SCORE_MIN = 300_000;
    const GPU_MAX_EXPECTED_SCORE_MAX = 5_000_000_000;
    const rawMaxExpected = Number((payload && payload.maxExpectedScore) || 0);
    const maxExpectedScore =
      rawMaxExpected > 0
        ? Math.min(GPU_MAX_EXPECTED_SCORE_MAX, Math.max(GPU_MAX_EXPECTED_SCORE_MIN, rawMaxExpected))
        : 0;
    if (maxExpectedScore > 0 && gpuScore > 0) {
      const rawRatio = gpuScore / maxExpectedScore;
      if (rawRatio <= 10.0) {
        const benchmarkHistory = loadBenchmarkHistory();
        benchmarkHistory.gpuSamples = appendBenchmarkSample(benchmarkHistory.gpuSamples, rawRatio);
        const referenceRatio = getPersonalReference(benchmarkHistory.gpuSamples, 1.0);
        hwAuthority.benchmarkGpuCalibration = Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * (rawRatio / referenceRatio)));
        saveBenchmarkHistory(benchmarkHistory);
        const _gpuSamples = benchmarkHistory.gpuSamples;
        const personalMeanGpuRatio =
          _gpuSamples.length >= 1 ? _gpuSamples.reduce((a, b) => a + b, 0) / _gpuSamples.length : 0;
        return { ok: true, personalMeanGpuRatio };
      }
    }
    return { ok: true, personalMeanGpuRatio: 0 };
  });

  const HARDWARE_HOLD_MAX_DURATION_MS = 48 * 60 * 60_000;
  ipcMain.handle('wattcoin-activate-hardware-hold', (_event, payload = {}) => {
    const durationMs = Math.min(
      HARDWARE_HOLD_MAX_DURATION_MS,
      Math.max(0, Number((payload && payload.durationMs) || 5 * 60 * 1000)),
    );
    const now = Date.now();
    if (hwAuthority.hwHoldUntilMs <= now) {
      hwAuthority.hwHoldUntilMs = now + durationMs;
      hwAuthority.trustScore = Math.max(0, hwAuthority.trustScore - 10);
      saveHwAuthState();
    }
    return { ok: true, hwHoldUntilMs: hwAuthority.hwHoldUntilMs };
  });
}

module.exports = { registerHardwareAuthorityIpcHandlers };
