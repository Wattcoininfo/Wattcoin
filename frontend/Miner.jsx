import React from 'react';

const COINS_PER_TIER = 1_000_000;
const TOTAL_TIERS = 21;
const TIER0_ENERGY = 1;
const TIER1_ENERGY = 20_000;
const BASE_REWARD = 1000;
const MAX_HARDWARE_LOAD_PERCENT = 85;
const LOAD_PERCENT_STORAGE_KEY = 'wattcoin-load-percent';
const STARTUP_BENCHMARK_DONE_STORAGE_KEY = 'wattcoin-startup-benchmark-done-v1';
const BENCHMARK_DRIFT_THRESHOLD = 0.3; // 30% drift on any metric: triggers immediate 2x extended retry
const BENCHMARK_HOLD_DURATION_MS = 5 * 60 * 1000; // 5 minutes on-hold after retry also fails
const HW_HOLD_STORAGE_KEY = 'wattcoin-hw-hold-until-v1';
const ENABLE_HARDWARE_HOLD = true;
const ENABLE_BACKGROUND_BENCHMARKS = true;
const SUSPICIOUS_BENCH_EVAL_INTERVAL_MS = 30_000; // evaluate surprise benchmark chance every 30 s while mining

const FINGERPRINT_HASH_STORAGE_KEY = 'wattcoin-fingerprint-hash-v2';
const FINGERPRINT_SIG_STORAGE_KEY = 'wattcoin-fingerprint-sig-v2';
const FINGERPRINT_SECRET_STORAGE_KEY = 'wattcoin-fingerprint-secret-v2';
const BENCH_BASELINE_OPS_KEY = 'wattcoin-bench-baseline-ops-v1';
const BENCH_BASELINE_GPS_KEY = 'wattcoin-bench-baseline-gps-v1';
const BENCH_BASELINE_SIG_KEY = 'wattcoin-bench-baseline-sig-v1';
const TRUST_SCORE_STORAGE_KEY = 'wattcoin-trust-score-v1';
const HARDWARE_COLUMN_WIDTH_PX = 240;
const PX_PER_MM = 96 / 25.4;
const CARD_HEIGHT_INCREASE_MM = 5;
const CARD_HEIGHT_INCREASE_PX = Math.round(CARD_HEIGHT_INCREASE_MM * PX_PER_MM);
const CARD_HEIGHT_REDUCTION_PX = Math.round((4 * 96) / 25.4);
const STATUS_CARD_HEIGHT_PX = 148;
const METRIC_CARD_HEIGHT_PX = 232 - CARD_HEIGHT_REDUCTION_PX + CARD_HEIGHT_INCREASE_PX + 38;
const TOP_SECTION_GAP_PX = 16;
const HARDWARE_CARD_HEIGHT_PX = STATUS_CARD_HEIGHT_PX + TOP_SECTION_GAP_PX + METRIC_CARD_HEIGHT_PX;
const _LOAD_CARD_HEIGHT_PX = 156;

const energyForTier = (n) => (n === 0 ? TIER0_ENERGY : TIER1_ENERGY * Math.pow(2, n - 1));
const rewardForTier = (n) => BASE_REWARD / Math.pow(2, n);

// Compute the global chain tier from the authoritative chain height.
// height < 0  → empty chain (tier 0 not yet premined)
// height === 0 → genesis only (Tier 0 done; energy mining starts at Tier 1)
// height > 0  → count energy blocks to find which tier we're in
function globalTierFromHeight(height) {
  if (height < 0) return 0;
  if (height === 0) return 1; // genesis premined Tier 0 complete
  let remaining = height; // number of energy blocks mined (heights 1..height)
  for (let tier = 1; tier < TOTAL_TIERS; tier++) {
    const blocksThisTier = Math.round(COINS_PER_TIER / rewardForTier(tier));
    if (remaining <= blocksThisTier) return tier;
    remaining -= blocksThisTier;
  }
  return TOTAL_TIERS - 1;
}

const fmtNum = (n, d = 0) => n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });

const simpleHash = (value) => {
  const str = String(value || '');
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const fmtEnergy = (wh, decimals = 2, kwhDecimals) => {
  const kd = kwhDecimals !== undefined ? kwhDecimals : decimals;
  if (wh >= 1e12) return (wh / 1e12).toFixed(kd) + ' TWh';
  if (wh >= 1e9) return (wh / 1e9).toFixed(kd) + ' GWh';
  if (wh >= 1e6) return (wh / 1e6).toFixed(kd) + ' MWh';
  if (wh >= 1e3) return (wh / 1e3).toFixed(kd) + ' kWh';
  return wh.toFixed(decimals) + ' Wh';
};

import { getHardwareInfo, isWholeDeviceMiniPc, hasOnlyIntegratedGpu } from './miner/minerHardware';
import {
  getCpuProbeCallCount,
  resetCpuProbeCallCount,
  runCpuProbe,
  runCpuProbeForDuration,
  runGpuPowBenchmark,
  getExpectedGpuScore,
  getExpectedCpuSpeedOps,
  getGpuVramInfo,
} from './miner/minerBenchmark';
import { computeCoinsFromEnergy } from './miner/minerUtils';
import { estimateHardwarePower } from './miner/minerPowerEstimation';
import { cpuTDPTable, gpuTDPTable } from './miner/minerTDPTables';

// Add a prop: isActive (true if dashboard is visible)
export default function Miner({
  mining,
  setMining,
  coins,
  setCoins: _setCoins,
  maturedCoins = 0,
  unmaturedCoins = 0,
  energy,
  setEnergy: _setEnergy,
  log: _log,
  setLog,
  probeLog: _probeLog = [],
  setProbeLog,
  isActive = true,
  setPowerW, // NEW: callback to lift powerW
  miningAddress = '',
  onBlockMined,
  chainHeight = -1,
  hardwareLookupResetNonce = 0,
  firewallBlocked = false,
  firewallHealing = false,
  onHealFirewall,
}) {
  // Helper for timestamp
  const now = React.useCallback(() => new Date().toLocaleString('en-GB'), []);
  const [realMineBusy, setRealMineBusy] = React.useState(false);
  const [_realMineStatus, setRealMineStatus] = React.useState('');
  const [peerCount, setPeerCount] = React.useState(null);
  const [connectedPeerCount, setConnectedPeerCount] = React.useState(0);
  const [peerCountSource, setPeerCountSource] = React.useState(null); // null | 'standalone' | 'coordinator'
  const [peerDiscoveryInfo, setPeerDiscoveryInfo] = React.useState({
    configuredPeers: 0,
    seedPeers: 0,
    discoveredPeers: 0,
  });
  const [lastSyncInfo, setLastSyncInfo] = React.useState({ trigger: '', ok: false });
  const [chainReadiness, setChainReadiness] = React.useState({
    spendReady: false,
    message: 'Checking...',
    connections: 0,
    blocks: 0,
  });
  const [sharedRoundTotalWh, setSharedRoundTotalWh] = React.useState(0);

  const [_baselinePowerW, setBaselinePowerW] = React.useState(0);
  const [showRebenchPrompt, setShowRebenchPrompt] = React.useState(false);
  const rebenchRef = React.useRef(false);
  React.useEffect(() => {
    rebenchRef.current = showRebenchPrompt;
  }, [showRebenchPrompt]);
  const [benchmarkState, setBenchmarkState] = React.useState({
    running: false,
    startupDone: (() => {
      try {
        return sessionStorage.getItem(STARTUP_BENCHMARK_DONE_STORAGE_KEY) === '1';
      } catch (_) {
        return false;
      }
    })(),
    lastScore: null,
    lastReason: '',
    lastSummary: '',
    issues: [],
    lastJitterPct: null,
    lastTrustDelta: null,
    lastTrustChangeTime: null,
    lastAvgCpuPct: null,
    lastAvgGpuPct: null,
    lastWasBaseline: false,
    cpuPenaltyPct: -1,
    gpuPenaltyPct: -1,
  });
  const [loadPercent, setLoadPercent] = React.useState(() => {
    try {
      const raw = localStorage.getItem(LOAD_PERCENT_STORAGE_KEY);
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return MAX_HARDWARE_LOAD_PERCENT;
      return Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, parsed));
    } catch (_) {
      return MAX_HARDWARE_LOAD_PERCENT;
    }
  });
  const energyBudgetWhRef = React.useRef(0);
  const lastRoundAttemptRef = React.useRef({ id: 0, atMs: 0 });
  const prevMiningStateRef = React.useRef(mining);
  const benchmarkInFlightRef = React.useRef(false);
  const loadPercentRef = React.useRef(MAX_HARDWARE_LOAD_PERCENT);
  const miningRef = React.useRef(false);

  const lastSuspiciousBenchmarkMsRef = React.useRef(0);
  const [sliderAdjustNonce, setSliderAdjustNonce] = React.useState(0);
  const lastHandledSliderAdjustNonceRef = React.useRef(0);
  const lastSliderCommitAtMsRef = React.useRef(0);
  // Drift-detection baselines — set on startup/slider-stop, compared on every subsequent run.
  const benchmarkRefCpuOpsRef = React.useRef(null);
  const benchmarkRefGpuScoreRef = React.useRef(null);
  const benchmarkRefJitterRef = React.useRef(null);

  // Holds the most recent benchmark proof data for inclusion in the next mineBlock call.
  // Fields: cpuSpeedProof, cpuSpeedInitialSeed, challengeSeed, cpuOpsPerSec,
  //         jitterRatio, score, issues, benchmarkTs.
  const benchmarkProofRef = React.useRef(null);
  // Item 4: set to true when a peer probe was successfully verified in the current round.
  // Reset when a block is mined so each round is independently assessed.
  const peerProbeVerifiedRef = React.useRef(false);
  // Item 5: stores the latest signed receipt from the coordinator peer probe.
  const probeReceiptRef = React.useRef(null);
  // Chained-probe continuity state — updated on each verified probe response.
  // chainHead: last proof hash (drives next seed derivation); chainIndex: count;
  // chainBroken: true if any probe in this session timed out or failed.
  const probeChainRef = React.useRef({ chainHead: null, chainIndex: 0, chainBroken: false });

  // True while waiting for the re-benchmark confirmation after a first drift was detected.
  const benchmarkRetryPendingRef = React.useRef(false);
  // Set when all peers go offline to pause mining. Cleared when a peer reconnects.
  const peerDownRef = React.useRef(false);
  // Toggled when a peer reconnects after being down, forcing the mining effect to re-run.
  const [peerDownToggle, setPeerDownToggle] = React.useState(0);
  // Tracks consecutive peer probe connection failures (no peers, peer unreachable).
  // Resets on success or coordinator rejection (non-transient). Mining stops at 5.
  // WebGL GPU load canvas and GL state (for continuous GPU load during mining).
  const gpuLoadCanvasRef = React.useRef(null);
  const gpuLoadGlStateRef = React.useRef({ gl: null, prog: null, seedLoc: null, initialized: false });
  const gpuLoadRafRef = React.useRef(null);
  const gpuMeasuredDutyRef = React.useRef(0);
  // True when native gpu-miner.exe is running — WebGL GPU load loop should be skipped.
  const [nativeGpuActive, setNativeGpuActive] = React.useState(false);
  const [hardwareHoldUntilMs, setHardwareHoldUntilMs] = React.useState(() => {
    try {
      const stored = Number(localStorage.getItem(HW_HOLD_STORAGE_KEY) || '0');
      if (stored <= Date.now()) return 0;
      // If stored trust is 0 it was likely corrupted by an earlier bug — clear the
      // erroneously-triggered hold so mining can resume at default trust.
      const storedTrust = Number(localStorage.getItem(TRUST_SCORE_STORAGE_KEY) || '0');
      if (!Number.isFinite(storedTrust) || storedTrust === 0) {
        localStorage.removeItem(HW_HOLD_STORAGE_KEY);
        return 0;
      }
      return stored;
    } catch (_) {
      return 0;
    }
  });
  const hardwareHoldUntilRef = React.useRef(hardwareHoldUntilMs);
  const [holdSecondsLeft, setHoldSecondsLeft] = React.useState(0);
  const isHardwareOnHold = ENABLE_HARDWARE_HOLD && hardwareHoldUntilMs > Date.now();

  const [hardwareRecognizedByNetwork, setHardwareRecognizedByNetwork] = React.useState(true);

  // Try to load hardware info from sessionStorage first
  const [hardware, setHardware] = React.useState(() => {
    // eslint-disable-line no-unused-vars
    const saved = sessionStorage.getItem('wattcoinHardware');
    if (saved) return JSON.parse(saved);
    return {
      deviceType: 'Unknown',
      manufacturer: 'Unknown',
      version: 'Unknown',
      motherboardFormFactor: '',
      cpu: 'Unknown',
      logicalCores: 1,
      physicalCores: 1,
      cpuSockets: 1,
      gpu: 'Unknown',
      gpus: [],
      gpuDetailsList: [],
      memory: 'Unknown',
      osName: 'Unknown',
      source: '',
    };
  });

  const [benchPower, setBenchPower] = React.useState(null);

  // Power curve: measured power and ops/ms at each load level (10%→100%).
  // When available, replaces TDP-based power estimation with actual sensor measurements.
  const [powerCurve, setPowerCurve] = React.useState(null);
  const [powerCurveBenchmarkPending, setPowerCurveBenchmarkPending] = React.useState(false);
  const powerCurveRef = React.useRef(null);

  const rebenchPowerCurve = React.useCallback(async () => {
    if (powerCurveBenchmarkPending) return;
    setPowerCurveBenchmarkPending(true);
    try {
      const hw = window.wattcoinHardware;
      if (hw && hw.invoke) {
        const res = await hw.invoke('wattcoin-run-power-curve-benchmark', {
          declaredCpuModel: hardware.cpu ? hardware.cpu.split(' (')[0] : '',
          declaredGpuModel: hardware.gpu || '',
          declaredDeviceType: hardware.deviceType || '',
          declaredGpuCount: Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0,
        });
        if (res && res.ok && res.curve) {
          setPowerCurve(res.curve);
          powerCurveRef.current = res.curve;
        }
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Power curve re-benchmark error:', String(_));
    } finally {
      setPowerCurveBenchmarkPending(false);
    }
  }, [hardware, powerCurveBenchmarkPending]);

  // Persisted hardware card width — saved after hardware is recognized so the card
  // doesn't jump from "Unknown" placeholder size to full content size on next launch.
  // Minimum threshold prevents caching a loading-state narrow width.
  const [savedHwCardWidth, setSavedHwCardWidth] = React.useState(() => {
    try {
      const v = parseInt(localStorage.getItem('wattcoin-hw-card-width'), 10);
      return v > 0 ? v : null;
    } catch (_) {
      return null;
    }
  });
  const hwCardRef = React.useRef(null);
  const [benchmarkPowerCapW, setBenchmarkPowerCapW] = React.useState(null);
  const benchmarkPowerCapWRef = React.useRef(null);
  // Ops-based TDP calibration: ratio of measured cpuSpeedOpsPerSec to expected ops/s
  // for the declared CPU model.  Stays 1.0 when unknown; <1.0 when throttled.
  const [benchmarkOpsCalibration, setBenchmarkOpsCalibration] = React.useState(1.0);
  // GPU ALU-score calibration: ratio of measured WebGL score to expected for declared GPU.
  const [benchmarkGpuCalibration, setBenchmarkGpuCalibration] = React.useState(1.0);
  const consecutiveUnderestimateRef = React.useRef(0);
  // Tracks the sum of online/static CPU+GPU TDP for the current hardware (set each render).
  // Gives runBenchmark a device-type-aware ceiling that doesn't depend on per-core ops math.
  const totalHardwareTDPRef = React.useRef(0);
  // Calibration-adjusted unit TDP, updated every render from the power computation below.
  // Read by runBenchmark to pass declaredUnitPowerW to the main-process power ceiling.
  const unitFullPowerWRef = React.useRef(0);
  // Trust score is owned by the main process (hw-auth-state.json).
  // Renderer starts at 50 and syncs from the authority on mount and after each benchmark.
  const [trustScore, setTrustScore] = React.useState(50);
  const trustScoreRef = React.useRef(50);

  // Global average electricity price (USD/kWh) — fetched from main, cached 24 h.
  const [livePowerW, setLivePowerW] = React.useState(0);
  const [hasLivePower, setHasLivePower] = React.useState(false);
  const [electricityPrice, setElectricityPrice] = React.useState(null);
  const [electricityPriceSource, setElectricityPriceSource] = React.useState(null);

  const [asicConfigStatus, setAsicConfigStatus] = React.useState('');
  const [discoveredAsics, setDiscoveredAsics] = React.useState([]);
  const [scanning, setScanning] = React.useState(false);
  const [asicLiveness, setAsicLiveness] = React.useState([]);

  React.useEffect(() => {
    if (hardwareLookupResetNonce <= 0) return;
    try {
      sessionStorage.removeItem(STARTUP_BENCHMARK_DONE_STORAGE_KEY);
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }
    setBenchmarkState((prev) => ({
      ...prev,
      running: false,
      startupDone: false,
      lastSummary: '',
      issues: [],
      lastReason: '',
    }));
    benchmarkInFlightRef.current = false;
    setBenchmarkPowerCapW(null);
    consecutiveUnderestimateRef.current = 0;
  }, [hardwareLookupResetNonce]);

  const allGpuModels = React.useMemo(() => {
    if (Array.isArray(hardware.gpus) && hardware.gpus.length > 0) return hardware.gpus;
    if (hardware.gpu && hardware.gpu !== 'Unknown') return [hardware.gpu];
    return [];
  }, [hardware.gpu, hardware.gpus]);
  const isWholeDeviceMiniPcModel = isWholeDeviceMiniPc(hardware);
  const allowGpuWorkloads =
    hardware.deviceType !== 'Laptop' &&
    hardware.deviceType !== 'ASIC' &&
    !isWholeDeviceMiniPcModel &&
    !hasOnlyIntegratedGpu(hardware);

  React.useEffect(() => {
    hardwareHoldUntilRef.current = hardwareHoldUntilMs;
  }, [hardwareHoldUntilMs]);
  React.useEffect(() => {
    benchmarkPowerCapWRef.current = benchmarkPowerCapW;
  }, [benchmarkPowerCapW]);
  React.useEffect(() => {
    trustScoreRef.current = trustScore;
    // Trust score is persisted by the main process (hw-auth-state.json in userData).
    // localStorage is no longer the authoritative store; main owns the value.
  }, [trustScore]);
  React.useEffect(() => {
    loadPercentRef.current = loadPercent;
  }, [loadPercent]);
  React.useEffect(() => {
    miningRef.current = mining;
  }, [mining]);

  // Fetch global average electricity price from main (cached 24 h, refreshed every 30 min).
  React.useEffect(() => {
    const fetchPrice = async () => {
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-electricity-price');
        if (res && typeof res.price === 'number' && res.price > 0) {
          setElectricityPrice(res.price);
          setElectricityPriceSource(res.source || null);
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    };
    fetchPrice();
    const id = setInterval(fetchPrice, 30 * 60 * 1000); // refresh every 30 min
    return () => clearInterval(id);
  }, []);

  // On mount: sync trust score and hw-hold from main-process authority state.
  // Main persists these to hw-auth-state.json so they survive localStorage clears.
  // On first run (isFirstRun=true) we migrate any legacy localStorage value to main.
  React.useEffect(() => {
    (async () => {
      try {
        if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const auth = await window.wattcoinHardware.invoke('wattcoin-get-authority-state').catch(() => null);
          if (auth) {
            // One-time migration: seed main with the localStorage value it never had.
            if (auth.isFirstRun) {
              try {
                const legacyTrust = Number(localStorage.getItem(TRUST_SCORE_STORAGE_KEY));
                const legacyHold = Number(localStorage.getItem(HW_HOLD_STORAGE_KEY) || 0);
                const seedPayload = {};
                if (Number.isFinite(legacyTrust) && legacyTrust > 0 && legacyTrust <= 100) {
                  seedPayload.trustScore = legacyTrust;
                }
                if (legacyHold > Date.now()) {
                  seedPayload.hwHoldUntilMs = legacyHold;
                }
                const seeded = await window.wattcoinHardware
                  .invoke('wattcoin-seed-authority-state', seedPayload)
                  .catch(() => null);
                if (seeded && seeded.ok && typeof seeded.trustScore === 'number') {
                  setTrustScore(seeded.trustScore);
                  trustScoreRef.current = seeded.trustScore;
                }
              } catch (_) {
                if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
              }
            } else {
              if (typeof auth.trustScore === 'number') {
                setTrustScore(auth.trustScore);
                trustScoreRef.current = auth.trustScore;
              }
            }
            if (typeof auth.hwHoldUntilMs === 'number' && auth.hwHoldUntilMs > Date.now()) {
              hardwareHoldUntilRef.current = auth.hwHoldUntilMs;
              setHardwareHoldUntilMs(auth.hwHoldUntilMs);
            }
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activateHardwareHold = React.useCallback(
    async (reason, durationMs = BENCHMARK_HOLD_DURATION_MS) => {
      if (!ENABLE_HARDWARE_HOLD) {
        return 0;
      }
      const nowMs = Date.now();
      const existingHoldUntil = Number(hardwareHoldUntilRef.current) || 0;
      if (existingHoldUntil > nowMs) {
        return existingHoldUntil;
      }

      const holdUntil = nowMs + durationMs;
      hardwareHoldUntilRef.current = holdUntil;
      setHardwareHoldUntilMs(holdUntil);
      // Trust decrement is applied by the main process in wattcoin-activate-hardware-hold;
      // renderer syncs the new value below after the IPC call returns.
      // Notify main process so the hold is persisted to the authoritative store
      // (hw-auth-state.json in userData) and cannot be cleared via localStorage.
      try {
        if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const holdResult = await window.wattcoinHardware
            .invoke('wattcoin-activate-hardware-hold', { durationMs })
            .catch(() => null);
          // Sync trust + hold from main after it applies the decrement.
          const authAfterHold = await window.wattcoinHardware.invoke('wattcoin-get-authority-state').catch(() => null);
          if (authAfterHold && typeof authAfterHold.trustScore === 'number') {
            setTrustScore(authAfterHold.trustScore);
            trustScoreRef.current = authAfterHold.trustScore;
          }
          void holdResult;
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }

      if (mining) {
        setMining(false);
        setRealMineStatus('Mining stopped: hardware on hold');
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.stopHardwareLoad) {
            await window.wattcoinHardware.stopHardwareLoad();
          } else if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
            await window.wattcoinHardware.setHardwareLoad(0);
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setLog((log) => [
          {
            time: now(),
            msg: `Hardware hold activated: ${reason}. Mining stopped automatically.`,
            type: 'warn',
          },
          ...log,
        ]);
      }

      return holdUntil;
    },
    [mining, setMining, setLog, now],
  );

  const runBenchmark = React.useCallback(
    async (reason = 'manual', { extended = false } = {}) => {
      if (ENABLE_HARDWARE_HOLD && hardwareHoldUntilRef.current > Date.now()) {
        return { skipped: true, reason: 'hold-active' };
      }
      if (benchmarkInFlightRef.current) return null;
      benchmarkInFlightRef.current = true;
      setBenchmarkState((prev) => ({ ...prev, running: true }));

      // For startup and slider-stop benchmarks: apply the slider's hardware load so
      // measurements are taken under real working conditions.  The hardware load ramp
      // takes ~3 s, so we wait before measuring.  Afterward the load is stopped if
      // mining was not already active when the benchmark started.
      const isBaselineBench = reason === 'startup' || reason === 'slider-stop';
      const wasMiningAtStart = miningRef.current;
      const _rawBenchLoad = isBaselineBench
        ? Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, loadPercentRef.current || 0))
        : 0;
      // Apply the same piecewise trust cap used by effectiveLoadPercent
      // so the baseline benchmark runs at the same load ceiling as live mining.
      const _trustScore = trustScoreRef.current;
      const _trustLoadCap =
        _trustScore <= 70 ? Math.round(20 + _trustScore * (50 / 70)) : Math.round(70 + (_trustScore - 70) * 0.5);
      const benchLoadPct = Math.min(_rawBenchLoad, _trustLoadCap);

      // Poll the hardware load state until the ramp completes and duty cycle
      // reaches near the target, so the benchmark measures settled conditions
      // even on cold startup where the CPU may need extra time to reach boost.
      const settleHardwareLoad = async (targetPct, minWaitMs, timeoutMs) => {
        const targetFrac = targetPct / 100;
        const start = Date.now();
        if (minWaitMs > 0) await new Promise((r) => setTimeout(r, minWaitMs));
        while (Date.now() - start < timeoutMs) {
          let settled = false;
          try {
            if (window.wattcoinHardware && window.wattcoinHardware.getHardwareLoadState) {
              const hwState = await window.wattcoinHardware.getHardwareLoadState();
              if (hwState && hwState.ok && !hwState.rampingUp) {
                const duty = Math.max(0, Math.min(1, Number(hwState.avgCpuWorkerDuty) || 0));
                const currPct = Math.max(0, Math.min(100, Number(hwState.currentPercent) || 0));
                if (currPct >= targetPct * 0.9 && duty >= targetFrac * 0.85) settled = true;
              }
            } else {
              settled = true;
            }
          } catch (_) {
            settled = true;
          }
          if (settled) break;
          await new Promise((r) => setTimeout(r, 200));
        }
      };

      if (benchLoadPct > 0 && !wasMiningAtStart) {
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
            await window.wattcoinHardware.setHardwareLoad(benchLoadPct);
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        // Wait for the hardware load ramp to complete, then poll until settled.
        await settleHardwareLoad(benchLoadPct, 3000, 10000);
      } else if (isBaselineBench && wasMiningAtStart && benchLoadPct > 0) {
        // Mining: syncHardwareLoadTarget already started the ramp when the slider changed,
        // but only ~1500ms ago (the slider-stop debounce). Wait for remaining ramp + settle.
        await settleHardwareLoad(benchLoadPct, 1700, 8000);
      }

      try {
        const issues = [];
        const startedAt = performance.now();

        // Device fingerprint — stored in userData (not localStorage) so clearing browser
        // storage cannot reset cross-session drift detection (item 6).
        // Falls back to localStorage if the IPC API isn't available (dev/browser mode).
        let fingerprintHash = '';
        try {
          const fingerprintPayload = JSON.stringify({
            deviceType: hardware.deviceType || '',
            manufacturer: hardware.manufacturer || '',
            version: hardware.version || '',
            cpu: hardware.cpu || '',
            gpu: hardware.gpu || '',
            memTotalGB: Math.round(hardware.memTotalGB || 0),
            source: hardware.source || '',
            // osName, userAgent, and platform intentionally excluded: all change on
            // OS/app/Electron updates and are not indicators of hardware substitution.
            // navigator.platform is also deprecated in modern Electron/Chrome.
          });
          fingerprintHash = simpleHash(fingerprintPayload);

          const hw = window.wattcoinHardware;
          if (hw && hw.readFingerprintFile && hw.writeFingerprintFile) {
            // File-based path: userData-persisted, wallet-HMAC-signed (items 6).
            const stored = await hw.readFingerprintFile().catch(() => ({ ok: true, data: null }));
            const prevData = stored && stored.data ? stored.data : null;
            const prevHash = prevData && prevData.hash ? String(prevData.hash) : '';
            const prevFmtVer = prevData && prevData.fmtVer ? Number(prevData.fmtVer) : 1;
            // Only compare if stored hash uses the same format version.  A format bump
            // (e.g. removing volatile fields) would produce a different hash for the same
            // hardware, so we silently re-baseline instead of flagging a false change.
            if (prevHash && prevFmtVer === 2 && prevHash !== fingerprintHash) {
              issues.push('device fingerprint changed unexpectedly');
            }
            await hw.writeFingerprintFile({ hash: fingerprintHash, fmtVer: 2, ts: Date.now() }).catch(() => null);
          } else {
            // localStorage fallback (browser/dev mode).
            let secret = localStorage.getItem(FINGERPRINT_SECRET_STORAGE_KEY);
            if (!secret) {
              const _buf = new Uint32Array(2);
              window.crypto.getRandomValues(_buf);
              secret = `${_buf[0].toString(36)}-${_buf[1].toString(36)}`;
              localStorage.setItem(FINGERPRINT_SECRET_STORAGE_KEY, secret);
            }
            const expectedSig = simpleHash(`${secret}|${fingerprintHash}`);
            const prevHash = localStorage.getItem(FINGERPRINT_HASH_STORAGE_KEY) || '';
            const prevSig = localStorage.getItem(FINGERPRINT_SIG_STORAGE_KEY) || '';
            if (prevHash && prevSig === simpleHash(`${secret}|${prevHash}`) && prevHash !== fingerprintHash) {
              issues.push('device fingerprint changed unexpectedly');
            }
            localStorage.setItem(FINGERPRINT_HASH_STORAGE_KEY, fingerprintHash);
            localStorage.setItem(FINGERPRINT_SIG_STORAGE_KEY, expectedSig);
          }
        } catch (_) {
          issues.push('fingerprint persistence check failed');
        }

        // Backend benchmark workload (CPU, GPU provider metric).
        const backendBench =
          window.wattcoinHardware && window.wattcoinHardware.runBackendBenchmark
            ? await window.wattcoinHardware
                .runBackendBenchmark({
                  reason,
                  allowGpuWorkloads,
                  phaseCount: 4,
                  phaseDurationMs: extended ? 200 : 100,
                  cpuSpeedRuns: reason === 'startup' || reason === 'slider-stop' ? 3 : 2,
                  // Hardware description strings for main-process authoritative calibration.
                  // Main uses its own copy of the lookup tables (hardware-tables.cjs) so these
                  // cannot be spoofed to inflate the calibration ratio.
                  // Main also cross-checks these against OS-level APIs (os.cpus(), Electron
                  // GPU info, systeminformation chassis) and applies a trust penalty + TDP
                  // clamp if mismatches are detected.
                  declaredCpuModel: hardware.cpu ? hardware.cpu.split(' (')[0] : '',
                  declaredGpuModel: hardware.gpu || '',
                  declaredDeviceType: hardware.deviceType || '',
                  // Declared calibrated TDP so main can establish the per-tick energy ceiling.
                  // Main applies its own calibration factor on top so declaring a wrong model
                  // is penalised by the benchmark-measured ops ratio.
                  declaredUnitPowerW: unitFullPowerWRef.current || 0,
                  declaredGpuCount: Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0,
                  isBaselineBenchmark: reason === 'startup' || reason === 'slider-stop',
                })
                .catch((e) => {
                  console.error('[Benchmark] IPC error:', e && e.message ? e.message : e);
                  return null;
                })
            : null;
        if (!(backendBench && backendBench.ok)) {
          throw new Error(
            `backend benchmark unavailable${backendBench && backendBench.message ? `: ${backendBench.message}` : ''}`,
          );
        }
        const challengeSeed = Number(backendBench.challengeSeed) || 0;
        const cpuOpsPerSec = Math.max(0, Number(backendBench.cpuOpsPerSec) || 0);
        const jitterRatio = Math.max(0, Number(backendBench.jitterRatio) || 0);
        let cpuSpeedOpsPerSec = Math.max(0, Number(backendBench.cpuSpeedOpsPerSec) || 0);
        // Renderer-side calibration: runCpuProbe executes in the same V8 isolate and
        // CPU core affinity as the actual probe, so its measurement reflects the true
        // probe throughput. On hybrid CPUs (Intel P-core/E-core) the backend benchmark
        // (Node.js main process) may land on slower E-cores, producing a lower ops/sec
        // that would inflate expectedMs and trigger false-positive suspiciously-fast flags.
        try {
          const CALIBRATION_ITERS = 20000000;
          const calSeed = Number(backendBench.cpuSpeedInitialSeed) || 1;
          const calStart = performance.now();
          runCpuProbe(calSeed, CALIBRATION_ITERS, false);
          const calElapsed = Math.max(1, performance.now() - calStart);
          const rendererSpeed = Math.round((CALIBRATION_ITERS / calElapsed) * 1000);
          if (rendererSpeed > cpuSpeedOpsPerSec) cpuSpeedOpsPerSec = rendererSpeed;
        } catch (_) {
          /* renderer calibration is non-fatal */
        }
        const _cpuSamples = Array.isArray(backendBench.cpuSamples) ? backendBench.cpuSamples : [cpuOpsPerSec];

        // Item 2: measurement-derived hardware tiers — independent of declared hardware names.
        // Power credit is anchored to what was actually measured, not what was declared.
        // Tier 1 = weakest measurable / VM; tier 5 = enthusiast.
        const cpuSpeedTier =
          cpuSpeedOpsPerSec < 1e8
            ? 1
            : cpuSpeedOpsPerSec < 2e8
              ? 2
              : cpuSpeedOpsPerSec < 4e8
                ? 3
                : cpuSpeedOpsPerSec < 6e8
                  ? 4
                  : 5;

        // Proof integrity: Node re-runs the same computation and confirms the hash matches.
        // A false value means the Node process itself is corrupted/patched — treat as fatal.
        if (backendBench.cpuSpeedProofVerified === false) {
          issues.push('cpu speed proof failed verification — benchmark integrity compromised');
        }
        if (jitterRatio > 0.45) {
          issues.push('high benchmark jitter detected');
        }
        const logicalCores = Math.max(
          1,
          Number(hardware.logicalCores) || Number(hardware.physicalCores) || Number(navigator.hardwareConcurrency) || 1,
        );
        const minExpectedCpu = logicalCores * 50_000;
        if (cpuOpsPerSec < minExpectedCpu) {
          issues.push('cpu throughput below expected envelope');
        }

        // Hardware-specific ops/s validation: compare measured CPU speed against the
        // expected throughput for the declared CPU model.  Catches extreme mismatches
        // (claimed hardware that would be physically impossible at the reported ops/s)
        // and calibrates the TDP power estimate using the actual performance fraction.
        const cpuKey = hardware.cpu ? hardware.cpu.split(' (')[0] : '';
        let expectedSpeedOps = getExpectedCpuSpeedOps(cpuKey);
        if (expectedSpeedOps <= 0) {
          // Fallback: estimate expected ops/s from CPU model tier + generation.
          // Uses piecewise per-generation values calibrated to the database.
          const m = cpuKey;
          let tierEstimate = 0;
          // ── Intel ──────────────────────────────────────────────────────
          // Extract tier (3/5/7/9) and generation prefix from model number.
          // "i7-14700KF" → tier=7, model="14700", gen=14.
          // "i5-1035G1" → tier=5, model="1035", gen=10.
          const intelMatch = m.match(/Core.*\bi([3579])\D(\d{4,5})/i);
          if (intelMatch) {
            const tier = Number(intelMatch[1]);
            const modelStr = intelMatch[2];
            const genPrefix = modelStr.length >= 5 ? Number(modelStr.slice(0, 2)) : Number(modelStr.slice(0, 1));
            const perGen = [
              // [minGen, {tier → ops/s}]
              [13, { 3: 460e6, 5: 520e6, 7: 560e6, 9: 600e6 }], // Raptor Lake Refresh
              [12, { 3: 420e6, 5: 470e6, 7: 490e6, 9: 520e6 }], // Alder Lake
              [10, { 3: 390e6, 5: 440e6, 7: 470e6, 9: 480e6 }], // Comet / Rocket Lake
              [8, { 3: 340e6, 5: 380e6, 7: 420e6, 9: 450e6 }], // Coffee Lake
              [6, { 3: 300e6, 5: 350e6, 7: 380e6, 9: 400e6 }], // Skylake / Kaby Lake
              [0, { 3: 250e6, 5: 300e6, 7: 340e6, 9: 380e6 }], // Sandy / Ivy / Haswell
            ];
            for (const [minGen, map] of perGen) {
              if (genPrefix >= minGen) {
                tierEstimate = map[tier];
                break;
              }
            }
          }
          // ── AMD Ryzen ──────────────────────────────────────────────────
          // "Ryzen 7 7800X3D" → tier=7, 7000 series
          const amdMatch = m.match(/Ryzen\s+(\d+)\s+(\d)/i);
          if (amdMatch && !tierEstimate) {
            const tier = Number(amdMatch[1]);
            const series = Number(amdMatch[2]);
            const perSeries = [
              [9, { 3: 400e6, 5: 540e6, 7: 560e6, 9: 580e6 }], // Zen 5
              [7, { 3: 380e6, 5: 520e6, 7: 520e6, 9: 560e6 }], // Zen 4
              [5, { 3: 385e6, 5: 440e6, 7: 450e6, 9: 470e6 }], // Zen 3
              [3, { 3: 370e6, 5: 400e6, 7: 410e6, 9: 420e6 }], // Zen 2
              [0, { 3: 280e6, 5: 320e6, 7: 330e6, 9: 350e6 }], // Zen+
            ];
            for (const [minSeries, map] of perSeries) {
              if (series >= minSeries) {
                tierEstimate = map[tier];
                break;
              }
            }
          }
          // ── Apple Silicon ──────────────────────────────────────────────
          const appleMatch = m.match(/M(\d)/i);
          if (appleMatch && !tierEstimate) {
            const gen = Number(appleMatch[1]);
            tierEstimate = gen >= 4 ? 620e6 : gen >= 3 ? 550e6 : gen >= 2 ? 500e6 : 440e6;
          }
          // ── Generic fallback ──────────────────────────────────────────
          expectedSpeedOps = Math.max(50_000_000, tierEstimate || 300_000_000);
        }
        let hardwareOpsRatio = 1.0; // default: no calibration data
        if (expectedSpeedOps > 0 && cpuSpeedOpsPerSec > 0) {
          hardwareOpsRatio = cpuSpeedOpsPerSec / expectedSpeedOps;
          if (hardwareOpsRatio > 3.5) {
            // Measured ops/s is impossibly high for the declared CPU → possible spoofing.
            issues.push(
              `cpu speed ${Math.round(cpuSpeedOpsPerSec / 1e6)}M ops/s exceeds expected ${Math.round(expectedSpeedOps / 1e6)}M for declared hardware`,
            );
          }
          if (hardwareOpsRatio < 0.08) {
            // More than 12× below expected → hardware claim implausible (VM with wrong CPU label?).
            issues.push(
              `cpu speed ${Math.round(cpuSpeedOpsPerSec / 1e6)}M ops/s far below expected ${Math.round(expectedSpeedOps / 1e6)}M for declared hardware`,
            );
          }
        }
        // Ops calibration: blend 50% fixed + 50% ratio-adjusted, clamped 0.20–1.20.
        // At ratio=1.0 → 1.0 (no change); at ratio=0.5 → 0.75 (thermal throttle reflected).
        const newOpsCalibration =
          expectedSpeedOps > 0 && cpuSpeedOpsPerSec > 0
            ? Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * hardwareOpsRatio))
            : 1.0;
        setBenchmarkOpsCalibration(newOpsCalibration);

        // GPU ALU-score calibration: only run for desktops with discrete GPUs.
        // Laptops are modelled as a single thermal unit (CPU+iGPU envelope), so GPU
        // benchmarking is meaningless there.  Also skip for any device where GPU
        // workloads are disabled (allowGpuWorkloads = false).
        // Uses GPU-PoW native binary for self-authenticating measurement.
        let gpuScore = 0;
        let _gpuScoreElapsedMs = 0;
        let gpuPowDevices = null;
        if (allowGpuWorkloads) {
          try {
            const gpuBench = await runGpuPowBenchmark();
            if (gpuBench && gpuBench.score) {
              gpuScore = gpuBench.score;
              _gpuScoreElapsedMs = gpuBench.elapsedMs;
              gpuPowDevices = gpuBench.devices;
            } else if (gpuBench && gpuBench.error) {
              issues.push('gpu-pow-bench: ' + gpuBench.error);
            }
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }
        const declaredGpus =
          Array.isArray(hardware.gpus) && hardware.gpus.length > 0
            ? hardware.gpus
            : hardware.gpu && hardware.gpu !== 'Unknown'
              ? [hardware.gpu]
              : [];
        let maxExpectedGpuScore = 0;
        for (const g of declaredGpus) {
          const exp = getExpectedGpuScore(g);
          if (exp > maxExpectedGpuScore) maxExpectedGpuScore = exp;
        }
        if (
          maxExpectedGpuScore > 0 &&
          !declaredGpus.some((g) => /RTX|GTX|RX\s*[5-9]|Arc|Vega|Iris|UHD|HD Graphics|Radeon|M[1-4]/i.test(g))
        ) {
          console.warn('[GPU] Unrecognised GPU model(s):', declaredGpus.join(', '), '- using fallback expected score');
        }
        let gpuScoreRatio = 1.0;
        if (allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0) {
          gpuScoreRatio = gpuScore / maxExpectedGpuScore;
          if (gpuScoreRatio < 0.05) {
            issues.push(
              `GPU score ${Math.round(gpuScore / 1e3)}K far below expected ${Math.round(maxExpectedGpuScore / 1e3)}K for declared GPU (integrated-only?)`,
            );
          }
        }
        const newGpuCalibration =
          allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0
            ? Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * gpuScoreRatio))
            : 1.0;
        setBenchmarkGpuCalibration(newGpuCalibration);
        let gpuCalibResult = null;
        if (allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0) {
          try {
            if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
              gpuCalibResult = await window.wattcoinHardware
                .invoke('wattcoin-report-gpu-calibration', {
                  gpuScore,
                  maxExpectedScore: maxExpectedGpuScore,
                })
                .catch(() => null);
            }
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }

        // Initialise native GPU binary path with detected GPU count so that
        // per-GPU native processes are ready when the slider triggers load.
        if (allowGpuWorkloads && window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const gpuCount = Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0;
          if (gpuCount > 0) {
            window.wattcoinHardware.invoke('wattcoin-gpu-info', { gpuCount }).catch(() => {});
          }
        }

        // Startup and slider-stop benchmarks define new baselines — no drift check.
        const _adoptSliderBaseline = reason === 'slider-stop';
        const isBaselineBenchmark = reason === 'startup' || reason === 'slider-stop';
        if (isBaselineBenchmark) {
          benchmarkRefCpuOpsRef.current = cpuOpsPerSec;
          benchmarkRefGpuScoreRef.current = gpuScore > 0 ? gpuScore : null;
          benchmarkRefJitterRef.current = jitterRatio > 0 ? jitterRatio : null;
          benchmarkRetryPendingRef.current = false;
        } else {
          let retryEscalationReason = '';
          let scheduleExtendedRetry = false;
          // Multi-metric drift detection: flag any metric that drifts >25% from its per-session baseline.
          const driftChecks = [];

          const refOps = benchmarkRefCpuOpsRef.current;
          if (refOps !== null && refOps > 0) {
            const d = Math.abs(cpuOpsPerSec - refOps) / refOps;
            if (d > BENCHMARK_DRIFT_THRESHOLD) driftChecks.push(`cpu ${(d * 100).toFixed(1)}%`);
          } else {
            benchmarkRefCpuOpsRef.current = cpuOpsPerSec;
          }

          const refGpu = benchmarkRefGpuScoreRef.current;
          if (refGpu !== null && refGpu > 0 && gpuScore > 0) {
            const d = Math.abs(gpuScore - refGpu) / refGpu;
            if (d > BENCHMARK_DRIFT_THRESHOLD) driftChecks.push(`gpu ${(d * 100).toFixed(1)}%`);
          } else if (gpuScore > 0) {
            benchmarkRefGpuScoreRef.current = gpuScore;
          }

          // Jitter is inherently noisy; relative drift against a small baseline produces massive
          // false positives. It is already capped by the absolute >45% threshold above, so skip
          // relative jitter drift here and just keep the baseline current.
          if (jitterRatio > 0) benchmarkRefJitterRef.current = jitterRatio;

          if (driftChecks.length > 0) {
            const driftDesc = driftChecks.join(', ');
            if (benchmarkRetryPendingRef.current) {
              // Second consecutive drift: 5-min hardware hold + -10 trust (applied by activateHardwareHold).
              retryEscalationReason = `drift on retry: ${driftDesc}`;
              issues.push(`benchmark drift on retry: ${driftDesc}`);
            } else {
              // First drift: immediate 2x extended re-benchmark.
              scheduleExtendedRetry = true;
              issues.push(`benchmark drift (${driftDesc}) extended re-benchmark scheduled`);
            }
          } else {
            // No significant drift: update baselines to track gradual hardware changes.
            if (cpuOpsPerSec > 0) benchmarkRefCpuOpsRef.current = cpuOpsPerSec;
            if (gpuScore > 0) benchmarkRefGpuScoreRef.current = gpuScore;
            if (jitterRatio > 0) benchmarkRefJitterRef.current = jitterRatio;
          }

          const benchmarkIssues = issues.filter((issue) => {
            const text = String(issue || '');
            return (
              text && !text.includes('extended re-benchmark scheduled') && !text.startsWith('benchmark drift on retry:')
            );
          });

          if (!retryEscalationReason && benchmarkIssues.length > 0) {
            const issueDesc = benchmarkIssues.join(', ');
            if (benchmarkRetryPendingRef.current || reason === 'retry-drift') {
              retryEscalationReason = `benchmark issues on retry: ${issueDesc}`;
              issues.push(`benchmark issues persisted on retry: ${issueDesc}`);
            } else if (!scheduleExtendedRetry) {
              scheduleExtendedRetry = true;
              issues.push(`benchmark issues (${issueDesc}) extended re-benchmark scheduled`);
            }
          }

          if (retryEscalationReason) {
            await activateHardwareHold(retryEscalationReason);
            benchmarkRetryPendingRef.current = false;
          } else if (scheduleExtendedRetry) {
            benchmarkRetryPendingRef.current = true;
            setTimeout(() => {
              if (!benchmarkInFlightRef.current && hardwareHoldUntilRef.current <= Date.now()) {
                runBenchmark('retry-drift', { extended: true });
              }
            }, 0);
          } else {
            benchmarkRetryPendingRef.current = false;
          }
        }

        // Score — computed after all issue checks so every detected issue penalises the result.
        let score = 100;
        if (!isBaselineBenchmark) {
          score -= Math.min(60, issues.length * 12);
          if (jitterRatio > 0.3) score -= 8;
        }
        score = Math.max(0, Math.min(100, Math.round(score)));

        // Cross-session performance baseline: persist ops/sec to detect hardware spoofing between sessions.
        try {
          const baselineSecret = localStorage.getItem(FINGERPRINT_SECRET_STORAGE_KEY) || '';
          const prevOpsStr = localStorage.getItem(BENCH_BASELINE_OPS_KEY) || '';
          const prevSig = localStorage.getItem(BENCH_BASELINE_SIG_KEY) || '';
          if (prevOpsStr && prevSig === simpleHash(`${baselineSecret}|${prevOpsStr}|0`)) {
            const prevOps = Number(prevOpsStr);
            if (Number.isFinite(prevOps) && prevOps > 0) {
              const crossDrift = Math.abs(cpuOpsPerSec - prevOps) / prevOps;
              if (crossDrift > 0.65) {
                issues.push(`cross-session cpu drift ${(crossDrift * 100).toFixed(1)}%`);
              }
            }
          }
          const opsStr = Math.round(cpuOpsPerSec).toString();
          const newSig = simpleHash(`${baselineSecret}|${opsStr}|0`);
          localStorage.setItem(BENCH_BASELINE_OPS_KEY, opsStr);
          localStorage.setItem(BENCH_BASELINE_GPS_KEY, '0');
          localStorage.setItem(BENCH_BASELINE_SIG_KEY, newSig);
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }

        // Benchmark-derived power cap: conservative on first run, raises gradually after 10 consecutive underestimates.
        {
          const isLaptopForCap = hardware.deviceType === 'Laptop';
          const navCoresForCap = Math.max(1, navigator.hardwareConcurrency || 1);
          let newCapW;
          if (isLaptopForCap) {
            // For laptops, cap is anchored to real manufacturer TDP fetched online.
            // Starting cap = 60% of declared TDP (40% conservative buffer; max mining load is 85%).
            // It grows back toward 100% via the consecutive-clean-benchmark raise logic.
            const refTDP = totalHardwareTDPRef.current;
            if (refTDP > 0) {
              newCapW = Math.round(refTDP * 0.6);
            } else {
              // No TDP data yet: conservative ops-based fallback (small absolute numbers).
              if (cpuOpsPerSec < 200_000) newCapW = 25;
              else if (cpuOpsPerSec < 500_000) newCapW = 35;
              else if (cpuOpsPerSec < 1_000_000) newCapW = 50;
              else newCapW = 65;
            }
          } else {
            // Desktop / PC / Server: derive cap from CPU ops throughput per core + GPU metric.
            let benchCpuCapW;
            if (cpuOpsPerSec < 80_000) benchCpuCapW = 20 * navCoresForCap;
            else if (cpuOpsPerSec < 200_000) benchCpuCapW = 40 * navCoresForCap;
            else if (cpuOpsPerSec < 500_000) benchCpuCapW = 65 * navCoresForCap;
            else if (cpuOpsPerSec < 1_000_000) benchCpuCapW = 100 * navCoresForCap;
            else benchCpuCapW = 160 * navCoresForCap;
            benchCpuCapW = Math.min(benchCpuCapW, 800);
            const benchGpuCapW = allowGpuWorkloads ? 80 : 25;
            newCapW = benchCpuCapW + benchGpuCapW + 30;
          }
          // TDP ceiling: upper bound for raise steps (laptops: full 100% TDP; desktops: static table).
          // Item 2: when hardware name lookup returns 0 (unknown CPU), use measurement-derived tier
          // ceiling so declaring an unknown high-end CPU doesn't give free power headroom.
          let tdpCeilingW = 0;
          if (isLaptopForCap) {
            // Ceiling is the full declared TDP — base is 80%, raises stop at 100%.
            tdpCeilingW = totalHardwareTDPRef.current > 0 ? totalHardwareTDPRef.current : newCapW * 1.5;
          } else {
            const cpuSocketsForCap = Math.max(1, Number(hardware.cpuSockets) || 1);
            const navCoresCap2 = Math.max(1, navigator.hardwareConcurrency || 1);
            const validSocketsCap = Math.min(cpuSocketsForCap, Math.max(1, Math.floor(navCoresCap2 / 2)));
            if (hardware.cpu) {
              const cpuKeyForCap = hardware.cpu.split(' (')[0];
              const staticCpuTdp = cpuTDPTable[cpuKeyForCap];
              if (staticCpuTdp) tdpCeilingW += staticCpuTdp * validSocketsCap;
            }
            for (const m of allGpuModels) {
              const staticGpuTdp = gpuTDPTable[m];
              if (staticGpuTdp) tdpCeilingW += staticGpuTdp;
            }
            tdpCeilingW += 30; // overhead margin
            // Item 2: if hardware name tables gave us nothing (unknown CPU/GPU), fall back to
            // a tier-based ceiling derived purely from measured ops/s — prevents fake declarations
            // from granting an artificially high power ceiling.
            if (tdpCeilingW <= 30) {
              const tierCpuCeilingPerSocket =
                cpuSpeedTier === 5
                  ? 600
                  : cpuSpeedTier === 4
                    ? 350
                    : cpuSpeedTier === 3
                      ? 220
                      : cpuSpeedTier === 2
                        ? 125
                        : 65;
              tdpCeilingW = tierCpuCeilingPerSocket * validSocketsCap + (allowGpuWorkloads ? 120 : 30) + 30;
            }
          }
          const effectiveCeiling = Math.max(tdpCeilingW, newCapW);
          const currentCap = benchmarkPowerCapWRef.current;
          if (currentCap === null) {
            // First benchmark: establish the cap conservatively.
            setBenchmarkPowerCapW(newCapW);
            consecutiveUnderestimateRef.current = 0;
          } else if (newCapW > currentCap) {
            // Throughput implies more power than current cap allows — count as underestimate.
            consecutiveUnderestimateRef.current += 1;
            if (consecutiveUnderestimateRef.current >= 10) {
              const raisable = effectiveCeiling - currentCap;
              if (raisable > 0) {
                setBenchmarkPowerCapW(Math.min(currentCap + raisable / 10, effectiveCeiling));
              }
              consecutiveUnderestimateRef.current = 0;
            }
          } else {
            // Throughput within cap — keep cap, reset counter.
            consecutiveUnderestimateRef.current = 0;
          }
        }

        // Sync trust score and hw-hold from the main-process authority.
        // Main is the only party that computes trust changes — renderer reads back
        // the authoritative values including before/after snapshots for the delta.
        // trustScoreBefore / trustScoreAfter are injected by the benchmark handler.
        let lastTrustDelta = 0;
        const prevTrustForDelta =
          typeof backendBench.trustScoreBefore === 'number' ? backendBench.trustScoreBefore : trustScoreRef.current;
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
            const auth = await window.wattcoinHardware.invoke('wattcoin-get-authority-state').catch(() => null);
            if (auth) {
              if (typeof auth.trustScore === 'number') {
                setTrustScore(auth.trustScore);
                trustScoreRef.current = auth.trustScore;
                if (!isBaselineBenchmark) {
                  lastTrustDelta = auth.trustScore - prevTrustForDelta;
                }
                // If main triggered a hold (trust hit 0), reflect it in the renderer.
                if (!isBaselineBenchmark && auth.trustScore === 0 && prevTrustForDelta > 0 && !auth.isOnHold) {
                  await activateHardwareHold('trust score depleted: repeated anomalies detected', 24 * 60 * 60 * 1000);
                }
              }
              if (typeof auth.hwHoldUntilMs === 'number' && auth.hwHoldUntilMs > Date.now()) {
                hardwareHoldUntilRef.current = auth.hwHoldUntilMs;
                setHardwareHoldUntilMs(auth.hwHoldUntilMs);
              }
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }

        const elapsedMs = performance.now() - startedAt;
        const trustAfter = trustScoreRef.current;
        let bgCpuOpsPerSec = 0;
        let bgCpuDutyPct = 0;
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.getHardwareLoadState) {
            const hwState = await window.wattcoinHardware.getHardwareLoadState();
            if (hwState && hwState.ok) {
              bgCpuOpsPerSec = Math.max(0, Number(hwState.cpuLoadOpsPerSec) || 0);
              bgCpuDutyPct = Math.max(0, Math.min(100, (Number(hwState.avgCpuWorkerDuty) || 0) * 100));
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        const totalCpuWorkOpsPerSec = cpuOpsPerSec + bgCpuOpsPerSec;
        const gpuDutyPct = Math.max(0, Math.min(100, gpuMeasuredDutyRef.current * 100));
        const gpuActualWorkOpsPerMs = gpuScore > 0 ? gpuScore * (gpuDutyPct / 100) : 0;
        const summary =
          `Benchmark score: ${score}/100` +
          `, cpu-speed ${fmtNum(cpuSpeedOpsPerSec, 0)} ops/s${expectedSpeedOps > 0 ? ` (${(hardwareOpsRatio * 100).toFixed(0)}% of expected)` : ''}` +
          `, cpu-phase ${fmtNum(cpuOpsPerSec, 0)} ops/s` +
          `, cpu-total ${fmtNum(totalCpuWorkOpsPerSec, 0)} ops/s (bench ${fmtNum(cpuOpsPerSec, 0)} + bg ${fmtNum(bgCpuOpsPerSec, 0)} @${bgCpuDutyPct.toFixed(0)}%)` +
          (allowGpuWorkloads
            ? gpuScore > 0
              ? `, gpu-score ${fmtNum(gpuScore, 0)} ops/ms${maxExpectedGpuScore > 0 ? ` (${(gpuScoreRatio * 100).toFixed(0)}% of expected)` : ''}`
              : ', gpu-score n/a'
            : '') +
          (allowGpuWorkloads
            ? gpuScore > 0
              ? `, gpu-total ${fmtNum(gpuActualWorkOpsPerMs, 0)} ops/ms (bench ${fmtNum(gpuScore, 0)} @${gpuDutyPct.toFixed(1)}%)`
              : `, gpu-total duty ${gpuDutyPct.toFixed(1)}%`
            : '') +
          `, jitter ${(jitterRatio * 100).toFixed(1)}%, challenge ${challengeSeed}` +
          `, trust ${trustAfter}/100${!isBaselineBenchmark ? ` (${lastTrustDelta > 0 ? '+' : ''}${lastTrustDelta})` : ''}` +
          `, cpu-proof ${backendBench.cpuSpeedProof || 'n/a'} (seed ${backendBench.cpuSpeedInitialSeed || 0})` +
          (gpuPowDevices && gpuPowDevices.length > 0
            ? `, gpu-pow ${gpuPowDevices.length} device${gpuPowDevices.length > 1 ? 's' : ''} (${gpuPowDevices.map((d) => `${d.deviceIndex}:${d.nonce}`).join(' ')})`
            : allowGpuWorkloads
              ? ', gpu-pow n/a'
              : '');
        const issueSummary = issues.length ? `issues: ${issues.join('; ')}` : 'no anomalies';

        // Compute vs-average deviation percentages using personal mean returned by main.
        const personalMeanCpu = Number(backendBench.personalMeanCpu) || 0;
        const personalMeanGpuRatio = Number(gpuCalibResult && gpuCalibResult.personalMeanGpuRatio) || 0;
        const lastAvgCpuPct = personalMeanCpu > 0 ? Math.round((cpuSpeedOpsPerSec / personalMeanCpu - 1) * 100) : null;
        const lastAvgGpuPct =
          allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0 && hardware.deviceType !== 'Laptop'
            ? Math.round((gpuScoreRatio / (personalMeanGpuRatio > 0 ? personalMeanGpuRatio : 1.0) - 1) * 100)
            : null;

        const cpuPenaltyPct =
          expectedSpeedOps > 0 ? Math.max(0, 100 - Math.round((cpuSpeedOpsPerSec / expectedSpeedOps) * 100)) : -1;
        const gpuPenaltyPct =
          allowGpuWorkloads && maxExpectedGpuScore > 0 && gpuScore > 0
            ? Math.max(0, 100 - Math.round((gpuScore / maxExpectedGpuScore) * 100))
            : -1;
        setBenchmarkState({
          running: false,
          startupDone: true,
          lastScore: score,
          lastReason: reason,
          lastSummary: `${summary} (${issueSummary})`,
          issues,
          lastJitterPct: Math.round(jitterRatio * 1000) / 10,
          lastTrustDelta,
          lastAvgCpuPct,
          lastAvgGpuPct,
          lastWasBaseline: isBaselineBenchmark,
          cpuPenaltyPct,
          gpuPenaltyPct,
        });

        // If startup benchmark shows significant performance degradation,
        // prompt the user to re-benchmark before continuing to mine.
        if (isBaselineBenchmark) {
          const anyDegraded = [cpuPenaltyPct, gpuPenaltyPct].some((p) => p > 30);
          if (anyDegraded) setShowRebenchPrompt(true);
        }

        // Persist proof data so the next mineBlock call can include it in the OP_RETURN
        // commitment.  Other nodes can then re-run cpuSpeedStep(initialSeed, N=20M) and
        // confirm the proof hash, giving them independent verification of the computation.
        benchmarkProofRef.current = {
          cpuSpeedProof: backendBench.cpuSpeedProof || '',
          cpuSpeedInitialSeed: Number(backendBench.cpuSpeedInitialSeed) || 0,
          gpuPowDevices: gpuPowDevices || [],
          gpuPowScore: Math.round(gpuScore),
          gpuPowElapsedMs: _gpuScoreElapsedMs,
          challengeSeed: Number(backendBench.challengeSeed) || 0,
          cpuOpsPerSec: Math.round(cpuOpsPerSec),
          cpuSpeedOpsPerSec: Math.round(cpuSpeedOpsPerSec),
          cpuTotalWorkOpsPerSec: Math.round(totalCpuWorkOpsPerSec),
          backgroundCpuOpsPerSec: Math.round(bgCpuOpsPerSec),
          gpuScoreOpsPerMs: Math.round(gpuScore),
          gpuActualWorkOpsPerMs: Math.round(gpuActualWorkOpsPerMs),
          gpuMeasuredDutyPct: Math.round(gpuDutyPct * 10) / 10,
          jitterRatio: Math.round(jitterRatio * 10000) / 10000,
          cpuSpeedTier, // item 2: measurement-derived tier
          score,
          issues: [...issues],
          benchmarkTs: Date.now(),
        };
        try {
          sessionStorage.setItem(STARTUP_BENCHMARK_DONE_STORAGE_KEY, '1');
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }

        setLog((log) => [
          {
            time: now(),
            msg: `Benchmark (${reason}${isBaselineBenchmark && benchLoadPct > 0 ? ` @${benchLoadPct}%` : ''}) in ${fmtNum(elapsedMs, 0)} ms: ${summary} (${issueSummary})`,
            type: !isBaselineBenchmark && issues.length ? 'warn' : 'info',
          },
          ...log,
        ]);

        return { score, issues };
      } catch (e) {
        setBenchmarkState((prev) => ({
          ...prev,
          running: false,
          startupDone: true,
          lastSummary: `benchmark failed: ${e && e.message ? e.message : 'unknown error'}`,
        }));
        try {
          sessionStorage.setItem(STARTUP_BENCHMARK_DONE_STORAGE_KEY, '1');
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setLog((log) => [
          {
            time: now(),
            msg: `Benchmark failed (${reason}): ${e && e.message ? e.message : 'unknown error'}`,
            type: 'error',
          },
          ...log,
        ]);
        return null;
      } finally {
        benchmarkInFlightRef.current = false;
        // Stop the synthetic load if we applied it for this benchmark and mining
        // has not been activated in the meantime.
        if (benchLoadPct > 0 && !wasMiningAtStart && !miningRef.current) {
          try {
            if (window.wattcoinHardware && window.wattcoinHardware.stopHardwareLoad) {
              await window.wattcoinHardware.stopHardwareLoad();
            } else if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
              await window.wattcoinHardware.setHardwareLoad(0);
            }
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }
      }
    },
    // cpuTDPTable/gpuTDPTable are stable useMemo — omitted to avoid TDZ (declared later)
    [activateHardwareHold, allowGpuWorkloads, hardware, setLog, allGpuModels, now], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Simulation mining logic removed

  // Mine a single real block attempt.
  const mineOneRealBlock = React.useCallback(
    async (blockEnergyWh = 0) => {
      if (!(window.wattcoinHardware && window.wattcoinHardware.mineBlock)) {
        console.error('[MinerSimulator] Mining API unavailable - window.wattcoinHardware.mineBlock not found');
        setRealMineStatus('Mining API unavailable');
        return false;
      }
      if (realMineBusy) return false;

      setRealMineBusy(true);
      setRealMineStatus('Mining block...');
      try {
        console.log('[MinerSimulator] Starting mining attempt with address:', miningAddress);
        // Attach the most recent benchmark proof so the OP_RETURN commitment includes
        // (cpuSpeedInitialSeed, cpuSpeedProof) — any peer can re-run the computation
        // from that seed and confirm the proof hash independently.
        const proofData = benchmarkProofRef.current
          ? {
              ...benchmarkProofRef.current,
              energyWh: blockEnergyWh,
              proofTs: Date.now(),
              miningAddress: miningAddress || '',
              peerProbeVerified: peerProbeVerifiedRef.current, // item 4
              probeReceipt: probeReceiptRef.current, // item 5
              probeChain: {
                // chained-probe continuity record
                chainHead: probeChainRef.current.chainHead,
                chainIndex: probeChainRef.current.chainIndex,
                chainBroken: probeChainRef.current.chainBroken,
              },
            }
          : null;
        // Reset per-round probe state after capturing for this block.
        peerProbeVerifiedRef.current = false;
        probeReceiptRef.current = null;
        // Chain continuity persists across blocks (chainHead/chainIndex stay intact).
        // Only reset the 'broken' flag so each new round is assessed independently.
        probeChainRef.current = { ...probeChainRef.current, chainBroken: false };
        let result = await window.wattcoinHardware.mineBlock(miningAddress || undefined, proofData);
        console.log('[MinerSimulator] Mining result:', result);

        // If selected address path fails (but not NO_PEERS), retry once without forcing address.
        if (result && result.code !== 'NO_PEERS' && result.error && miningAddress) {
          console.log('[MinerSimulator] Retrying without forcing address due to error:', result.error);
          result = await window.wattcoinHardware.mineBlock(undefined, proofData);
          console.log('[MinerSimulator] Retry result:', result);
        }

        if (result && result.code === 'NO_PEERS') {
          setRealMineStatus('Waiting for peers...');
          peerDownRef.current = true;
          return 'NO_PEERS';
        }
        if (result && result.address) {
          const blockHash = result && result.blockHash ? String(result.blockHash).trim() : '';
          const walletName = result && result.walletName ? String(result.walletName).trim() : 'wattminer';
          setRealMineStatus(blockHash ? `Block mined: ${blockHash}` : `Block mined to ${result.address}`);
          if (typeof onBlockMined === 'function') {
            try {
              await onBlockMined({
                blockHash,
                address: result.address,
                walletName,
                // Proof fields for Tier 4c coordinator re-verification (item 1).
                cpuSpeedInitialSeed: benchmarkProofRef.current
                  ? Number(benchmarkProofRef.current.cpuSpeedInitialSeed) || 0
                  : 0,
                cpuSpeedProof: benchmarkProofRef.current ? String(benchmarkProofRef.current.cpuSpeedProof || '') : '',
                proofIssues: benchmarkProofRef.current ? benchmarkState.issues || [] : [],
                proofCommitment: result.proofCommitment || null,
                peerProbeVerified: !!(proofData && proofData.peerProbeVerified), // item 4
                probeReceipt: proofData && proofData.probeReceipt ? proofData.probeReceipt : null, // item 5
                probeChain: proofData && proofData.probeChain ? proofData.probeChain : null, // Tier 4e coverage ratio
              });
            } catch (_) {
              if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
            }
          }
          setLog((log) => [
            {
              time: now(),
              msg: blockHash
                ? `Real block mined: hash=${blockHash}, address=${result.address}`
                : `Real block mined: address=${result.address}`,
              type: 'block',
            },
            ...log,
          ]);
          return true;
        } else {
          const errMsg = result && result.error ? result.error : 'Unknown error';
          setRealMineStatus(`Mining failed: ${errMsg}`);
          setLog((log) => [{ time: now(), msg: `Mining failed: ${errMsg}`, type: 'error' }, ...log]);
          return false;
        }
      } catch (e) {
        const errMsg = e && e.message ? e.message : 'Unknown error';
        setRealMineStatus(`Mining failed: ${errMsg}`);
        setLog((log) => [{ time: now(), msg: `Mining failed: ${errMsg}`, type: 'error' }, ...log]);
        return false;
      } finally {
        setRealMineBusy(false);
      }
    },
    [miningAddress, onBlockMined, setLog, setRealMineStatus, setRealMineBusy, benchmarkState, now, realMineBusy],
  );

  // Fetch hardware info at startup if not already found, or if deviceType is still unknown
  React.useEffect(() => {
    if (hardware && hardware.cpu !== 'Unknown' && hardware.deviceType !== 'Unknown') return;
    let cancelled = false;
    (async () => {
      try {
        const hw = await getHardwareInfo();
        if (cancelled) return;
        if (hw && hw.source) {
          setHardware(hw);
          try {
            sessionStorage.setItem('wattcoinHardware', JSON.stringify(hw));
          } catch (_) {
            if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hardware]);

  React.useEffect(() => {
    try {
      localStorage.setItem(
        LOAD_PERCENT_STORAGE_KEY,
        String(Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, Number(loadPercent) || 0))),
      );
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }
  }, [loadPercent]);

  React.useEffect(() => {
    const debounceTimer = setTimeout(() => {
      let cancelled = false;

      async function syncHardwareLoadTarget() {
        if (!(window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad)) return;
        // Don't override the load that runBenchmark applied for a baseline measurement.
        if (benchmarkInFlightRef.current) return;
        const clamped = Math.min(MAX_HARDWARE_LOAD_PERCENT, Math.max(0, Number(loadPercent) || 0));
        // Cap physical OS load at the trust ceiling so the machine doesn't do work that won't be credited.
        const _ts = trustScoreRef.current;
        const _tlc = _ts <= 70 ? Math.round(20 + _ts * (50 / 70)) : Math.round(70 + (_ts - 70) * 0.5);
        const trustCappedLoad = Math.min(clamped, _tlc);
        // Detect number of GPUs from hardware detection
        const gpuCount = Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0;
        try {
          if (isHardwareOnHold) {
            if (window.wattcoinHardware.stopHardwareLoad) {
              await window.wattcoinHardware.stopHardwareLoad();
            } else {
              await window.wattcoinHardware.setHardwareLoad(0);
            }
            if (gpuCount > 0 && window.wattcoinHardware.invoke) {
              await window.wattcoinHardware.invoke('wattcoin-stop-gpu-load').catch(() => {});
            }
            setNativeGpuActive(false);
          } else if (mining) {
            // Start CPU workers immediately so mining begins without waiting
            // for a peer probe.  The coordinator seed is assigned lazily when
            // the first probe arrives (peer-probe-ipc.js).
            await window.wattcoinHardware.setHardwareLoad(trustCappedLoad);
            // Start GPU mining immediately if a discrete GPU is present.
            if (gpuCount > 0 && allowGpuWorkloads && window.wattcoinHardware.invoke) {
              await window.wattcoinHardware
                .invoke('wattcoin-set-gpu-load', { percent: trustCappedLoad, gpuCount })
                .catch(() => {});
              setNativeGpuActive(true);
            }
          } else if (window.wattcoinHardware.stopHardwareLoad) {
            await window.wattcoinHardware.stopHardwareLoad();
            if (gpuCount > 0 && window.wattcoinHardware.invoke) {
              await window.wattcoinHardware.invoke('wattcoin-stop-gpu-load').catch(() => {});
            }
            setNativeGpuActive(false);
          } else {
            await window.wattcoinHardware.setHardwareLoad(0);
            if (gpuCount > 0 && window.wattcoinHardware.invoke) {
              await window.wattcoinHardware.invoke('wattcoin-stop-gpu-load').catch(() => {});
            }
            setNativeGpuActive(false);
          }
        } catch (_) {
          if (!cancelled) {
            // Ignore backend load-control errors to keep UI responsive.
          }
        }
      }

      syncHardwareLoadTarget();
    }, 1500);
    return () => {
      clearTimeout(debounceTimer);
    };
  }, [allowGpuWorkloads, hardware, isHardwareOnHold, loadPercent, mining]);

  // Improved benchmark: only run when dashboard is active
  React.useEffect(() => {
    if (!isActive) return;
    if (!hardware || hardware.cpu === 'Unknown') return;
    // Run the benchmark asynchronously to avoid blocking the UI
    let cancelled = false;
    let rafId = null;
    let timeoutId = null;
    if (hardware.deviceType === 'Laptop' && navigator.getBattery) {
      navigator.getBattery().then((bat) => {
        const initialLevel = bat.level;
        const initialTime = Date.now();
        timeoutId = setTimeout(() => {
          if (cancelled) return;
          function sha256(str) {
            let hash = 5381;
            for (let i = 0; i < str.length; i++) {
              hash = (hash << 5) + hash + str.charCodeAt(i);
            }
            return hash >>> 0;
          }
          let count = 0;
          const start = performance.now();
          function runBench() {
            if (cancelled) return;
            if (performance.now() - start < 5000) {
              for (let i = 0; i < 1000; i++) {
                sha256('wattcoin-bench' + count++);
              }
              rafId = requestAnimationFrame(runBench);
            } else {
              const endLevel = bat.level;
              const endTime = Date.now();
              const deltaLevel = initialLevel - endLevel;
              const deltaTime = (endTime - initialTime) / 1000; // seconds
              if (deltaLevel > 0 && bat.dischargingTime > 0) {
                const batteryCapacityWh = (bat.dischargingTime / 3600) * (bat.level * 100);
                const power = (batteryCapacityWh * deltaLevel) / (deltaTime / 3600);
                if (power > 0 && power < 200) setBenchPower(Math.round(power));
                else setBenchPower(0);
              } else {
                let est = null;
                if (count < 100000) est = 40;
                else if (count < 200000) est = 60;
                else if (count < 400000) est = 80;
                else if (count < 700000) est = 90;
                else est = 90;
                setBenchPower(est);
              }
            }
          }
          runBench();
        }, 0);
      });
    } else {
      timeoutId = setTimeout(() => {
        if (cancelled) return;
        function sha256(str) {
          let hash = 5381;
          for (let i = 0; i < str.length; i++) {
            hash = (hash << 5) + hash + str.charCodeAt(i);
          }
          return hash >>> 0;
        }
        let count = 0;
        const start = performance.now();
        function runBench() {
          if (cancelled) return;
          if (performance.now() - start < 500) {
            for (let i = 0; i < 1000; i++) {
              sha256('wattcoin-bench' + count++);
            }
            rafId = requestAnimationFrame(runBench);
          } else {
            let est = null;
            if (count < 100000) est = 80;
            else if (count < 200000) est = 120;
            else if (count < 400000) est = 200;
            else if (count < 700000) est = 350;
            else est = 600;
            let cpuTDP = null;
            let gpuTDP = null;
            const cpuSocketCount = Math.max(1, Number(hardware.cpuSockets) || 1);
            const navCoresEst = Math.max(1, navigator.hardwareConcurrency || 1);
            const validSocketsEst = Math.min(cpuSocketCount, Math.max(1, Math.floor(navCoresEst / 2)));
            if (hardware.cpu) {
              const cpuKey = hardware.cpu.replace(/ CPU(?: @ [\d.]+GHz?)?$/i, '').split(' (')[0];
              const w = cpuTDPTable[cpuKey];
              if (w) cpuTDP = w * validSocketsEst;
            }
            if (hardware.gpu && gpuTDPTable[hardware.gpu]) gpuTDP = gpuTDPTable[hardware.gpu];
            let maxTDP = 600;
            if (cpuTDP !== null && gpuTDP !== null) maxTDP = cpuTDP + gpuTDP;
            else if (cpuTDP !== null) maxTDP = cpuTDP;
            else if (gpuTDP !== null) maxTDP = gpuTDP;
            if (est !== null) setBenchPower(Math.min(est, maxTDP));
          }
        }
        runBench();
      }, 0);
    }
    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (timeoutId) clearTimeout(timeoutId);
    };
    // cpuTDPTable/gpuTDPTable are stable useMemo — omitted to avoid TDZ (declared later)
  }, [hardware, isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Startup benchmark runs after hardware recognition.
  // Not dashboard-gated: it must also run when another in-app tab is active.
  React.useEffect(() => {
    if (!(hardware && hardware.source)) return;
    if (isHardwareOnHold) return;
    if (benchmarkState.startupDone || benchmarkState.running) return;
    if (clampedLoadPercent === 0) return;
    const timeoutId = setTimeout(() => {
      runBenchmark('startup');
    }, 4000);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isHardwareOnHold,
    hardware,
    benchmarkState.startupDone,
    benchmarkState.running,
    runBenchmark,
    hardwareLookupResetNonce,
  ]);

  // Load power curve from backend on mount and when hardware changes.
  React.useEffect(() => {
    if (!(hardware && hardware.source)) return;
    let cancelled = false;
    const loadCurve = async () => {
      try {
        const hw = window.wattcoinHardware;
        if (hw && hw.invoke) {
          const res = await hw.invoke('wattcoin-get-power-curve');
          if (!cancelled && res && res.ok && res.curve) {
            setPowerCurve(res.curve);
            powerCurveRef.current = res.curve;
          }
        }
      } catch (_) {
        /* curve not available */
      }
    };
    loadCurve();
    return () => {
      cancelled = true;
    };
  }, [hardware, hardwareLookupResetNonce]);

  // Trigger power curve benchmark 5 seconds after startup benchmark finishes.
  const powerCurveAutoTriggeredRef = React.useRef(false);
  // When drift is detected during mining, pause mining and auto-rebench.
  // After the new curve is calibrated, mining resumes automatically.
  const autoRebenchPendingRef = React.useRef(false);
  React.useEffect(() => {
    if (!benchmarkState.startupDone) return;
    if (isHardwareOnHold) return;
    if (powerCurve) return;
    if (powerCurveAutoTriggeredRef.current) return;
    if (!(hardware && hardware.source)) return;
    powerCurveAutoTriggeredRef.current = true;
    const isDriftRebench = autoRebenchPendingRef.current;
    // When resuming after drift, wait longer for CPU workers to fully wind down.
    const delayMs = isDriftRebench ? 10_000 : 5_000;
    const timeoutId = setTimeout(async () => {
      setPowerCurveBenchmarkPending(true);
      try {
        const hw = window.wattcoinHardware;
        if (hw && hw.invoke) {
          const res = await hw.invoke('wattcoin-run-power-curve-benchmark', {
            declaredCpuModel: hardware.cpu ? hardware.cpu.split(' (')[0] : '',
            declaredGpuModel: hardware.gpu || '',
            declaredDeviceType: hardware.deviceType || '',
            declaredGpuCount: Array.isArray(hardware && hardware.gpus) ? hardware.gpus.length : 0,
          });
          if (res && res.ok && res.curve) {
            setPowerCurve(res.curve);
            powerCurveRef.current = res.curve;
            // Auto-resume mining after drift-triggered re-benchmark.
            if (autoRebenchPendingRef.current) {
              autoRebenchPendingRef.current = false;
              setMining(true);
            }
          } else {
            autoRebenchPendingRef.current = false;
          }
        }
      } catch (_) {
        autoRebenchPendingRef.current = false;
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Power curve benchmark error:', String(_));
      } finally {
        setPowerCurveBenchmarkPending(false);
      }
    }, delayMs);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchmarkState.startupDone, isHardwareOnHold, powerCurve, hardware, hardwareLookupResetNonce]);

  // Run a benchmark after user stops adjusting hardware load slider.
  // Not dashboard-gated: slider-triggered baseline checks must run on any tab.
  React.useEffect(() => {
    if (!(hardware && hardware.source)) return;
    if (isHardwareOnHold) return;
    if (sliderAdjustNonce <= 0) return;
    if (sliderAdjustNonce <= lastHandledSliderAdjustNonceRef.current) return;
    if (clampedLoadPercent === 0) return;

    lastHandledSliderAdjustNonceRef.current = sliderAdjustNonce;

    const timeoutId = setTimeout(() => {
      if (!benchmarkInFlightRef.current) {
        runBenchmark('slider-stop');
      }
    }, 1500);

    return () => clearTimeout(timeoutId);
  }, [sliderAdjustNonce, isHardwareOnHold, hardware, runBenchmark]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Runtime hardware probe polling ──────────────────────────────────────────
  // While mining is active, poll every 30 s for a hardware probe job.
  //
  // Source priority:
  //   1. PEER mode  — requestPeerProbe() fetches a challenge issued by the coordinator.
  //      The coordinator measures wall-clock time independently; the worker cannot lie
  //      about speed.  CPU proofs are also hash-verified.
  //   2. LOCAL mode — falls back to self-issued probes when coordinator is unreachable
  //      or node is standalone.  Proof hashes still verified by Node; timing is loose.
  //
  // CPU computations run inline here so they block the JS thread for their
  // full duration (~500-2000 ms) — this is intentional and ensures the timing
  // measurement reflects true hardware throughput and is not easily faked by sleeping.
  const walletAddressRef = React.useRef(miningAddress);
  React.useEffect(() => {
    walletAddressRef.current = miningAddress;
  }, [miningAddress]);

  React.useEffect(() => {
    if (!mining) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.requestPeerProbe || !hw.submitPeerProbeResult) return;

    const POLL_INTERVAL_MS = 2_000;
    let disposed = false;
    let inFlight = false;
    const runProbeTick = async () => {
      if (disposed || inFlight) return;
      if (!walletAddressRef.current) return;
      inFlight = true;
      try {
        // Ask Node (which knows if we're worker/standalone) for a probe.
        const response = await hw.requestPeerProbe({
          workerId: walletAddressRef.current,
          allowGpuWorkloads,
        });
        if (!response || !response.probe) {
          return;
        }
        const probe = response.probe;
        const source = response.source || 'local'; // 'peer' | 'local'
        const probeStartedAt = performance.now();

        // Start VDF computation BEFORE the benchmark so both run in parallel.
        // The VDF input only depends on probe.id, workerId, and chainIndex — all
        // available immediately. The VDF runs in the main process via IPC while the
        // benchmark runs in the renderer, so total probe time = max(benchmark, VDF)
        // instead of benchmark + VDF.
        let vdfPromise = null;
        let vdfStartMs = 0;
        if (source === 'peer' && window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const chainIndex = probeChainRef.current ? probeChainRef.current.chainIndex : 0;
          vdfStartMs = performance.now();
          vdfPromise = window.wattcoinHardware
            .invoke('wattcoin-vdf-derive-input', {
              probeId: probe.id,
              workerId: hardware.address || '',
              chainIndex,
            })
            .then((vdfInputRes) => {
              if (vdfInputRes && vdfInputRes.ok) {
                return window.wattcoinHardware.invoke('wattcoin-vdf-evaluate', {
                  challenge: vdfInputRes.challenge,
                  difficulty: probe.params.vdfDifficulty || 2000,
                  discriminantSizeBits: probe.params.vdfDiscriminantSize || 512,
                });
              }
              return null;
            })
            .catch(() => null);
        }

        let probeResult = null;

        if (probe.type === 'cpu') {
          resetCpuProbeCallCount(0); // exclude keepalive calls from counter
          const seed = probe.params.seed | 0 || 1;
          const durationMs = probe.params.durationMs || 1000;
          // Warmup — keeps CPU hot; no yield here because yielding lets the CPU drop into a
          // lower power state, causing the main loop to run at reduced frequency.
          runCpuProbe(seed, 5000000);
          // Real measurement loop — runs for fixed duration, counts iterations
          let cpuResult = runCpuProbeForDuration(seed, durationMs, true);
          let mainMs = cpuResult.chunks ? cpuResult.chunks.reduce((a, b) => a + b, 0) : 0;
          let retried = false;
          // Retry once if suspiciously slow — transient dips resolve on the second attempt
          if (mainMs > 3000) {
            cpuResult = runCpuProbeForDuration(seed, durationMs, true);
            mainMs = cpuResult.chunks ? cpuResult.chunks.reduce((a, b) => a + b, 0) : 0;
            retried = true;
          }
          const wallMs = Math.round(performance.now() - probeStartedAt);
          const callCount = getCpuProbeCallCount();
          resetCpuProbeCallCount(0);
          probeResult = {
            id: probe.id,
            type: 'cpu',
            proof: cpuResult.proof,
            iterations: cpuResult.iterations,
            _intDateMs: mainMs,
            _warmupTotalMs: wallMs,
            _retried: retried ? 1 : 0,
            _chunks: cpuResult.chunks ? cpuResult.chunks.join(',') : '',
            _callCount: callCount,
            probeWallClockMs: mainMs,
          };
        } else if (probe.type === 'gpu-pow') {
          // GPU PoW probe: use native binary to search for a nonce where hash < difficulty.
          // Each device gets its own seed partition so all GPUs independently prove work.
          if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
            const powResult = await window.wattcoinHardware
              .invoke('wattcoin-gpu-pow-probe', {
                seed: probe.params.seed,
                difficulty: probe.params.difficulty,
              })
              .catch(() => null);
            if (powResult && Array.isArray(powResult.devices) && powResult.devices.length > 0) {
              // Forward all device results to the coordinator for validation,
              // even if some devices returned null nonces.  The coordinator
              // reports individual device failures in the verdict issues.
              const firstValid = powResult.devices.find((d) => d.nonce != null);
              probeResult = {
                id: probe.id,
                type: 'gpu-pow',
                devices: powResult.devices,
                gpuCount: powResult.gpuCount || powResult.devices.length,
                gpuPoWMs: Math.max(...powResult.devices.map((d) => d.elapsedMs || 0)),
                proof: firstValid ? '0x' + Number(firstValid.nonce).toString(16) : '0x0',
              };
            }
          }
          // If native binary unavailable, silently skip the probe
          if (!probeResult) return;
        } else if (probe.type === 'asic') {
          // ASIC probe: inject liveness challenge (if present), then wait for
          // fresh X11 shares.  The challenge PrevHash prevents pre-mined shares.
          const minShares = (probe.params && probe.params.minShares) || 3;
          const challengePrevHash = probe.params && probe.params.challengePrevHash;
          let shares = [];
          let shareCount = 0;
          try {
            if (challengePrevHash) {
              await window.wattcoinHardware.injectAsicCustomJob(challengePrevHash);
            }
            const fresh = await window.wattcoinHardware.waitForFreshShares(minShares);
            if (fresh && fresh.ok && Array.isArray(fresh.shares)) {
              shares = fresh.shares;
              shareCount = fresh.shareCount || 0;
            }
          } catch (_) {
            /* timeout — proceed */
          }
          probeResult = {
            id: probe.id,
            type: 'asic',
            shares,
            shareCount,
            proof: `${shares.length}:${shares.length > 0 ? shares[0].hashHex.slice(0, 16) : '0'}`,
          };
        }

        if (!probeResult) {
          probeResult = { id: probe.id, type: 'skip' };
        }

        if (disposed) return;

        // Await VDF result — the promise was started before the benchmark so
        // VDF and benchmark ran in parallel. Total probe time = max(benchmark, VDF).
        let vdfResult = null;
        let vdfTimingMs = 0;
        if (vdfPromise) {
          try {
            vdfResult = await vdfPromise;
            if (vdfResult && vdfResult.ok) {
              vdfTimingMs = Math.round(performance.now() - vdfStartMs);
            }
          } catch (_) {
            // VDF failure is non-fatal — fall back to coordinator timing.
          }
        }

        const submitPayload = {
          source,
          result: {
            ...probeResult,
            _peerUrl: probe._peerUrl,
            probeWallClockMs: Math.round(performance.now() - probeStartedAt),
            ...(vdfResult && vdfResult.ok
              ? {
                  vdfSteps: vdfResult.steps,
                  vdfDiscriminantSize: vdfResult.discriminantSizeBits,
                  vdfInput: vdfResult.challenge || '',
                  vdfOutput: vdfResult.output,
                  vdfProof: vdfResult.proof,
                  vdfTimingMs,
                }
              : {}),
          },
          hardwareSpec: {
            measuredCpuOpsPerSec: Number(benchmarkProofRef.current && benchmarkProofRef.current.cpuSpeedOpsPerSec) || 0,
            allowGpuWorkloads,
            hwPowerW: Math.max(0, Math.round(Number(totalHardwareTDPRef.current) || 0)),
            cpuModel: typeof hardware.cpu === 'string' ? hardware.cpu : '',
            gpuModels: Array.isArray(hardware.gpus) ? hardware.gpus : [],
            asicModel: typeof hardware.gpu === 'string' ? hardware.gpu : '',
          },
        };
        let verdict = await hw.submitPeerProbeResult(submitPayload);
        // Single retry after 5 s if the coordinator was transiently unreachable.
        // Avoids the probe computation being wasted due to a momentary network hiccup
        // and reduces coordinator-side timeouts from flaky connections.
        if (verdict && !verdict.ok && verdict.transient && source === 'peer') {
          await new Promise((r) => setTimeout(r, 5000));
          verdict = await hw.submitPeerProbeResult(submitPayload);
        }

        if (verdict) {
          // Item 5: capture the signed receipt from the coordinator so it can be
          // included in the next block's OP_RETURN commitment.
          if (verdict.receipt && typeof verdict.receipt === 'object') {
            probeReceiptRef.current = verdict.receipt;
          }
          // Update chained-probe continuity state from the verdict.
          // Local probes return chainHead/chainIndex/chainBroken directly.
          // Peer probes embed chain state in the receipt (coordinator-side chain).
          if (verdict.chainHead !== undefined) {
            probeChainRef.current = {
              chainHead: verdict.chainHead,
              chainIndex:
                typeof verdict.chainIndex === 'number' ? verdict.chainIndex : probeChainRef.current.chainIndex,
              chainBroken: probeChainRef.current.chainBroken || !!verdict.chainBroken,
            };
          } else if (verdict.receipt && typeof verdict.receipt.chainIndex === 'number') {
            probeChainRef.current = {
              chainHead:
                verdict.receipt.chainHead !== undefined ? verdict.receipt.chainHead : probeChainRef.current.chainHead,
              chainIndex: verdict.receipt.chainIndex,
              chainBroken: probeChainRef.current.chainBroken,
            };
          }
          if (!verdict.ok) {
            probeChainRef.current = { ...probeChainRef.current, chainBroken: true };
          }
          // Item 4: mark that a peer probe was verified this round.
          if (source === 'peer' && verdict.ok) {
            peerProbeVerifiedRef.current = true;
          }
          // Sync trust score from the main-process authority (trustScoreBefore/trustScoreAfter
          // are injected by the peer probe handler when verdict.ok === true).
          if (typeof verdict.trustScoreAfter === 'number') {
            const prev = trustScoreRef.current;
            setTrustScore(verdict.trustScoreAfter);
            trustScoreRef.current = verdict.trustScoreAfter;
            const delta =
              verdict.trustScoreAfter -
              (typeof verdict.trustScoreBefore === 'number' ? verdict.trustScoreBefore : prev);
            const pad2 = (n) => String(n).padStart(2, '0');
            const d = new Date();
            setBenchmarkState((prevState) => ({
              ...prevState,
              lastTrustDelta: delta,
              lastTrustChangeTime:
                delta !== 0 ? `${pad2(d.getHours())}.${pad2(d.getMinutes())}.${pad2(d.getSeconds())}` : null,
            }));
          }
          // Record to probe log (real-time capture; covers both local and peer probe paths).
          if (typeof setProbeLog === 'function') {
            const ts = Date.now();
            setProbeLog((prev) =>
              [
                {
                  ts,
                  id: probe.id,
                  time: now(),
                  role: 'self',
                  source,
                  type: probe.type,
                  ok: !!verdict.ok,
                  timedOut: false,
                  wallClockMs:
                    typeof verdict.vdfTimingMs === 'number' && verdict.vdfVerified
                      ? Math.round(verdict.vdfTimingMs)
                      : typeof verdict.probeWallClockMs === 'number'
                        ? Math.round(verdict.probeWallClockMs)
                        : typeof verdict.wallClockMs === 'number'
                          ? Math.round(verdict.wallClockMs)
                          : null,
                  vdfVerified: !!verdict.vdfVerified,
                  vdfTimingMs: typeof verdict.vdfTimingMs === 'number' ? Math.round(verdict.vdfTimingMs) : null,
                  rttMs: typeof verdict.rttMs === 'number' ? Math.round(verdict.rttMs) : null,
                  pixelHash: typeof probeResult.pixelHash === 'string' ? probeResult.pixelHash : '',
                  nonce:
                    Array.isArray(probeResult.devices) && probeResult.devices.length > 0
                      ? Number(probeResult.devices[0].nonce)
                      : null,
                  proof:
                    typeof probeResult.proof === 'string'
                      ? probeResult.proof
                      : Array.isArray(probeResult.devices) && probeResult.devices.length > 0
                        ? '0x' + Number(probeResult.devices[0].nonce).toString(16)
                        : '',
                  verifierAddress:
                    verdict.receipt && typeof verdict.receipt.verifierAddress === 'string'
                      ? verdict.receipt.verifierAddress
                      : '',
                  chainIndex:
                    typeof verdict.chainIndex === 'number'
                      ? verdict.chainIndex
                      : verdict.receipt && typeof verdict.receipt.chainIndex === 'number'
                        ? verdict.receipt.chainIndex
                        : null,
                  issues: Array.isArray(verdict.issues) ? verdict.issues : [],
                  version:
                    typeof verdict.version === 'string'
                      ? verdict.version
                      : (typeof window !== 'undefined' &&
                          window.wattcoinHardware &&
                          window.wattcoinHardware.appVersion) ||
                        null,
                  loadPercent: typeof verdict.loadPercent === 'number' ? verdict.loadPercent : null,
                  energyWh: typeof verdict.energyWh === 'number' ? verdict.energyWh : 0,
                  opsPerMs: typeof verdict.opsPerMs === 'number' ? verdict.opsPerMs : 0,
                  trustDelta:
                    typeof verdict.trustScoreAfter === 'number' && typeof verdict.trustScoreBefore === 'number'
                      ? verdict.trustScoreAfter - verdict.trustScoreBefore
                      : null,
                },
                ...prev,
              ].slice(0, 150),
            );
          }
          if (!verdict.ok) {
            const issueStr = (verdict.issues || []).join('; ');
            const isTransient = /mining stopped while probe|stale probe|coordinator disconnected/i.test(issueStr);
            if (!isTransient) {
              setLog((prev) => [
                {
                  time: now(),
                  msg: `Hardware probe FAILED (${probe.type}, ${source}): ${issueStr}`,
                  type: 'warn',
                },
                ...prev,
              ]);
            }
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      } finally {
        inFlight = false;
      }
    };

    // Keep TurboFan alive for runCpuProbe between probes — prevents V8 from
    // evicting the optimized code, which was causing the first run to recompile
    // in Sparkplug (42M ops/sec) while the retry uses TurboFan (280M ops/sec).
    const keepaliveId = setInterval(() => {
      if (!disposed) runCpuProbe(1, 1);
    }, 5000);

    // Poll for probes at a fixed short interval. The actual coordinator polling
    // happens in the main process on an unpredictable schedule; this renderer-side
    // interval just drains the pre-fetched cache.
    const probeIntervalId = setInterval(() => {
      runProbeTick();
    }, POLL_INTERVAL_MS);
    runProbeTick();
    return () => {
      clearInterval(keepaliveId);
      clearInterval(probeIntervalId);
      disposed = true;
    };
  }, [mining, allowGpuWorkloads, hardware, setLog, setProbeLog, now]);

  // Poll backend probe histories every 20 s to catch:
  //   - timed-out probes (added to probeState.history by getPendingProbe when a probe expires)
  //   - coordinator-attested probes (this node verified for other workers in peer mode)
  // New entries are merged by ts to avoid duplicates with real-time entries above.
  React.useEffect(() => {
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke || typeof setProbeLog !== 'function') return;

    async function mergeBackendHistory() {
      try {
        const [selfRes, attestRes] = await Promise.allSettled([
          hw.invoke('wattcoin-get-probe-history'),
          hw.invoke('wattcoin-get-attest-history'),
        ]);
        const selfHistory =
          selfRes.status === 'fulfilled' && selfRes.value && Array.isArray(selfRes.value.history)
            ? selfRes.value.history
            : [];
        const attestHistory =
          attestRes.status === 'fulfilled' && attestRes.value && Array.isArray(attestRes.value.history)
            ? attestRes.value.history
            : [];

        const selfEntries = selfHistory.map((h) => ({
          ts: typeof h.ts === 'number' ? h.ts : 0,
          id: typeof h.id === 'string' ? h.id : '',
          time: h.ts ? new Date(h.ts).toLocaleString('en-GB') : '—',
          role: 'self',
          source: 'local',
          type: h.type || '?',
          ok: !!h.ok,
          timedOut: Array.isArray(h.issues) && h.issues.some((i) => String(i).includes('timed out')),
          wallClockMs: typeof h.wallClockMs === 'number' ? Math.round(h.wallClockMs) : null,
          rttMs: typeof h.rttMs === 'number' ? Math.round(h.rttMs) : null,
          computeTimeMs: typeof h.computeTimeMs === 'number' ? Math.round(h.computeTimeMs) : null,
          chainIndex: typeof h.chainIndex === 'number' ? h.chainIndex : null,
          issues: Array.isArray(h.issues) ? h.issues : [],
          version: typeof h.version === 'string' ? h.version : null,
          loadPercent: typeof h.loadPercent === 'number' ? h.loadPercent : null,
        }));
        const attestEntries = attestHistory.map((h) => ({
          ts: typeof h.ts === 'number' ? h.ts : 0,
          id: typeof h.id === 'string' ? h.id : '',
          time: h.ts ? new Date(h.ts).toLocaleString('en-GB') : '—',
          role: 'attested',
          source: 'peer',
          type: h.type || '?',
          ok: !!h.ok,
          timedOut: false,
          wallClockMs: typeof h.wallClockMs === 'number' ? Math.round(h.wallClockMs) : null,
          vdfVerified: !!h.vdfVerified,
          vdfTimingMs: typeof h.vdfTimingMs === 'number' ? Math.round(h.vdfTimingMs) : null,
          rttMs: typeof h.rttMs === 'number' ? Math.round(h.rttMs) : null,
          computeTimeMs: typeof h.computeTimeMs === 'number' ? Math.round(h.computeTimeMs) : null,
          chainIndex: typeof h.chainIndex === 'number' ? h.chainIndex : null,
          workerId: typeof h.workerId === 'string' ? h.workerId : '',
          pixelHash: typeof h.pixelHash === 'string' ? h.pixelHash : '',
          proof: typeof h.proof === 'string' ? h.proof : '',
          issues: Array.isArray(h.issues) ? h.issues : [],
          version: typeof h.version === 'string' ? h.version : null,
          loadPercent: typeof h.loadPercent === 'number' ? h.loadPercent : null,
        }));

        setProbeLog((prev) => {
          const seen = new Set(prev.map((e) => e.ts));
          const newEntries = [...selfEntries, ...attestEntries].filter((e) => e.ts > 0 && !seen.has(e.ts));
          if (newEntries.length === 0) return prev;
          return [...newEntries, ...prev].sort((a, b) => b.ts - a.ts).slice(0, 150);
        });
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    }

    mergeBackendHistory();
    const interval = setInterval(mergeBackendHistory, 20_000);
    return () => clearInterval(interval);
  }, [setProbeLog]);

  // High-precision: Estimate power usage (W) using exact model TDP lookup, then family regex, then benchmark fallback
  // Show 0W until a real estimate is available
  const _powerEstimation = estimateHardwarePower({
    hardware,
    allGpuModels,
    isWholeDeviceMiniPcModel,
    loadPercent,
    trustScore,
    benchmarkOpsCalibration,
    benchmarkGpuCalibration,
    isHardwareOnHold,
    benchPower,
    powerCurve,
  });
  let powerW = _powerEstimation.powerW;
  const unitFullPowerW = _powerEstimation.unitFullPowerW;
  const basePowerW = _powerEstimation.basePowerW;
  const effectiveLoadPercent = _powerEstimation.effectiveLoadPercent;
  const trustLoadCap = _powerEstimation.trustLoadCap;
  const clampedLoadPercent = _powerEstimation.clampedLoadPercent;
  if (_powerEstimation.laptopTDP !== null) totalHardwareTDPRef.current = _powerEstimation.laptopTDP;
  unitFullPowerWRef.current = unitFullPowerW;
  const hardwareCardPowerCalcBreakdown = _powerEstimation.hardwareCardPowerCalcBreakdown;
  const _powerCalcBreakdown = _powerEstimation._powerCalcBreakdown;
  const _liveWattageSmallLabel = _powerEstimation._liveWattageSmallLabel;
  const _normalizedConfidenceLabel = _powerEstimation._normalizedConfidenceLabel;
  const _normalizedEnergyLabel = _powerEstimation._normalizedEnergyLabel;
  const _powerTrustLabel = _powerEstimation._powerTrustLabel;
  const _powerSourceLabel = _powerEstimation._powerSourceLabel;
  const _normalizedConfidenceTier = _powerEstimation._normalizedConfidenceTier;
  const _normalizedSourceName = _powerEstimation._normalizedSourceName;
  const _powerSourceAccent = _powerEstimation._powerSourceAccent;
  const totalPowerUsedW = _powerEstimation.powerW;
  const _miningPowerUsedW = mining ? Math.max(0, powerW) : 0;

  // Track non-mining baseline power to estimate mining-only delta from live telemetry.
  React.useEffect(() => {
    if (mining) return;
    const sample = Math.max(0, Number(totalPowerUsedW) || 0);
    if (sample <= 0) return;
    setBaselinePowerW((prev) => (prev > 0 ? prev * 0.9 + sample * 0.1 : sample));
  }, [mining, totalPowerUsedW]);
  const totalTiers = TOTAL_TIERS;
  const totalCoinSupply = COINS_PER_TIER * totalTiers;
  const appEstimatedCoins = Math.max(0, computeCoinsFromEnergy(energy));
  const nodeMatured = Math.max(0, Number(maturedCoins) || 0);
  const nodeUnmatured = Math.max(0, Number(unmaturedCoins) || 0);
  const nodeTotal = Math.max(0, Number(coins) || 0, nodeMatured + nodeUnmatured);
  const _nodeStatusCoins = Math.max(0, nodeMatured + nodeUnmatured);
  const chainEmittedCoins = (() => {
    if (chainHeight < 0) return 0;
    let total = 1_000_000; // genesis premine (Tier 0)
    let remaining = chainHeight; // energy blocks 1..height
    for (let tier = 1; tier < TOTAL_TIERS; tier++) {
      if (remaining <= 0) break;
      const reward = rewardForTier(tier);
      const blocksThisTier = Math.round(COINS_PER_TIER / reward);
      const mined = Math.min(remaining, blocksThisTier);
      total += mined * reward;
      remaining -= mined;
    }
    return total;
  })();
  const chainTier = globalTierFromHeight(chainHeight);
  const currentTier = Math.max(chainTier, Math.min(Math.floor(appEstimatedCoins / COINS_PER_TIER), totalTiers - 1));
  const statusTier = Math.max(chainTier, Math.min(Math.floor(chainEmittedCoins / COINS_PER_TIER), totalTiers - 1));
  const tierEnergyPerCoinWh = energyForTier(currentTier);
  const tierRewardCoins = rewardForTier(currentTier);
  const minedPct = totalCoinSupply > 0 ? Math.min(100, (chainEmittedCoins / totalCoinSupply) * 100) : 0;
  const hardwareRecognitionFinished = !!(hardware && hardware.source);
  const hardwareUnknown =
    hardwareRecognitionFinished &&
    (!hardwareRecognizedByNetwork ||
      hardware.deviceType === 'Unknown' ||
      hardware.cpu === 'Unknown' ||
      (Array.isArray(hardware.gpus) && hardware.gpus.some((g) => g === 'Unknown' || !g)));
  const startupBenchmarkPending = hardwareRecognitionFinished && !benchmarkState.startupDone && clampedLoadPercent > 0;
  const needsPowerCurve = hardwareRecognitionFinished && !powerCurve && !powerCurveBenchmarkPending;
  // Persist the card's rendered width once hardware is fully loaded so the next
  // launch pre-sizes the card and avoids a layout jump.
  React.useEffect(() => {
    if (!hardwareRecognitionFinished) return;
    if (!hwCardRef.current) return;
    const t = setTimeout(() => {
      const w = hwCardRef.current && hwCardRef.current.offsetWidth;
      if (w > 0) {
        try {
          localStorage.setItem('wattcoin-hw-card-width', String(w));
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setSavedHwCardWidth(w);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [hardwareRecognitionFinished, hardware]); // eslint-disable-line react-hooks/exhaustive-deps
  // Once hardware recognition finishes, confirm against the coordinator's authoritative tables.
  React.useEffect(() => {
    if (!hardwareRecognitionFinished) return;
    let cancelled = false;
    const gpuModels = [];
    if (Array.isArray(hardware.gpus)) {
      for (const g of hardware.gpus) {
        if (g && g !== 'Unknown') gpuModels.push(g);
      }
    }
    const cpuModel = hardware.cpu && hardware.cpu !== 'Unknown' ? hardware.cpu : null;
    const asicModel =
      hardware.deviceType === 'ASIC' && hardware.gpu && hardware.gpu !== 'Unknown' ? hardware.gpu : null;
    const deviceType = hardware.deviceType || 'Unknown';
    if (deviceType === 'Laptop' || deviceType === 'Mini PC') {
      // iGPU TDP is inside CPU envelope; dGPU is not used for mining
      gpuModels.length = 0;
    }
    if (gpuModels.length === 0 && !cpuModel && !asicModel) {
      setHardwareRecognizedByNetwork(false);
      return;
    }
    window.wattcoinHardware
      .isHardwareRecognized({ deviceType, gpuModels, cpuModel, asicModel })
      .then((res) => {
        if (!cancelled && res && !res.recognized) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Unrecognized hardware:', res.unrecognized);
          setHardwareRecognizedByNetwork(false);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hardwareRecognitionFinished]); // eslint-disable-line react-hooks/exhaustive-deps

  // Weighted suspicious-event trigger: anomaly score increases benchmark trigger probability.
  // Run on a timer while mining is active so stable sessions still receive surprise checks.
  React.useEffect(() => {
    if (!ENABLE_BACKGROUND_BENCHMARKS) return;
    if (isHardwareOnHold) return;
    if (!mining) return;

    let cancelled = false;
    const evaluateSuspiciousBenchmark = async () => {
      if (cancelled) return;
      if (benchmarkInFlightRef.current) return;

      const nowMs = Date.now();
      const minCooldownMs = 8000;
      if (nowMs - lastSuspiciousBenchmarkMsRef.current < minCooldownMs) return;

      let suspicionScore = 0;
      const reasons = [];
      const currentIssues = Array.isArray(benchmarkState.issues) ? benchmarkState.issues : [];
      const currentJitterPct = Number(benchmarkState.lastJitterPct) || 0;
      const lastTrustDelta = Number(benchmarkState.lastTrustDelta) || 0;
      const effectiveLoad = Math.max(0, Number(effectiveLoadPercent) || 0);

      if (benchmarkRetryPendingRef.current) {
        suspicionScore += 3;
        reasons.push('extended-retry-pending');
      }

      if (currentIssues.length > 0) {
        suspicionScore += 3;
        reasons.push('benchmark-issues-present');
      }

      if (currentJitterPct >= 20) {
        suspicionScore += 2;
        reasons.push(`elevated-jitter-${currentJitterPct.toFixed(1)}pct`);
      }

      if (lastTrustDelta < 0) {
        suspicionScore += 2;
        reasons.push(`trust-drop-${lastTrustDelta}`);
      }

      if (effectiveLoad >= 50) {
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.getHardwareLoadState) {
            const hwState = await window.wattcoinHardware.getHardwareLoadState();
            const cpuDuty = Math.max(0, Math.min(1, Number(hwState && hwState.avgCpuWorkerDuty) || 0));
            const gpuDuty = Math.max(0, Math.min(1, Number(gpuMeasuredDutyRef.current) || 0));
            const peakDuty = Math.max(cpuDuty, gpuDuty);
            const expectedFloor = Math.max(0.08, (effectiveLoad / 100) * 0.35);
            if (peakDuty > 0 && peakDuty < expectedFloor) {
              suspicionScore += 2;
              reasons.push(`load-duty-mismatch-${Math.round(effectiveLoad)}pct-vs-${Math.round(peakDuty * 100)}pct`);
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
      }

      if (suspicionScore <= 0) return;

      const triggerProbability = Math.min(0.9, suspicionScore * 0.15);
      if (Math.random() < triggerProbability) {
        lastSuspiciousBenchmarkMsRef.current = nowMs;
        setLog((log) => [
          {
            time: now(),
            msg: `Suspicious telemetry trigger (score=${suspicionScore}, p=${(triggerProbability * 100).toFixed(0)}%, reasons=${reasons.join('|')})`,
            type: 'warn',
          },
          ...log,
        ]);
        runBenchmark('surprise-suspicious');
      }
    };

    const timer = setInterval(() => {
      evaluateSuspiciousBenchmark().catch(() => {});
    }, SUSPICIOUS_BENCH_EVAL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    benchmarkState.issues,
    benchmarkState.lastJitterPct,
    benchmarkState.lastTrustDelta,
    effectiveLoadPercent,
    isHardwareOnHold,
    mining,
    runBenchmark,
    setLog,
    now,
  ]);

  // Power curve drift detection: every 60s during mining, compare live ops/ms
  // and live sensor wattage against the stored curve. >30% deviation on either
  // metric for 5 consecutive checks triggers automatic re-benchmark.
  React.useEffect(() => {
    if (!mining) return;
    if (!powerCurve || !powerCurve.steps || powerCurve.steps.length < 2) return;
    let cancelled = false;
    let lastCheckMs = 0;
    let consecutiveDriftCount = 0;
    const CURVE_DRIFT_CHECK_INTERVAL_MS = 60_000;
    const CURVE_DRIFT_THRESHOLD = 0.3;
    const DRIFT_CONSECUTIVE_REQUIRED = 5;

    const checkCurveDrift = async () => {
      if (cancelled) return;
      if (benchmarkInFlightRef.current) return;
      if (powerCurveBenchmarkPending) return;
      const nowMs = Date.now();
      if (nowMs - lastCheckMs < CURVE_DRIFT_CHECK_INTERVAL_MS) return;
      lastCheckMs = nowMs;

      try {
        const hw = window.wattcoinHardware;
        if (!hw || !hw.getHardwareLoadState) return;

        const currentLoad = effectiveLoadPercent;

        // Interpolate expected ops/ms from curve at current load
        const expectedOpsPerMs = (() => {
          const steps = powerCurve.steps;
          const pct = Math.max(0, Math.min(100, currentLoad));
          if (pct <= steps[0].loadPercent) return steps[0].avgOpsPerMs;
          if (pct >= steps[steps.length - 1].loadPercent) return steps[steps.length - 1].avgOpsPerMs;
          for (let i = 0; i < steps.length - 1; i++) {
            const a = steps[i];
            const b = steps[i + 1];
            if (pct >= a.loadPercent && pct <= b.loadPercent) {
              const t = (pct - a.loadPercent) / (b.loadPercent - a.loadPercent);
              return a.avgOpsPerMs + t * (b.avgOpsPerMs - a.avgOpsPerMs);
            }
          }
          return steps[steps.length - 1].avgOpsPerMs;
        })();

        // Interpolate expected power from curve at current load
        const expectedPowerW = (() => {
          const steps = powerCurve.steps;
          const pct = Math.max(0, Math.min(100, currentLoad));
          if (pct <= steps[0].loadPercent) return steps[0].avgPowerW;
          if (pct >= steps[steps.length - 1].loadPercent) return steps[steps.length - 1].avgPowerW;
          for (let i = 0; i < steps.length - 1; i++) {
            const a = steps[i];
            const b = steps[i + 1];
            if (pct >= a.loadPercent && pct <= b.loadPercent) {
              const t = (pct - a.loadPercent) / (b.loadPercent - a.loadPercent);
              return a.avgPowerW + t * (b.avgPowerW - a.avgPowerW);
            }
          }
          return steps[steps.length - 1].avgPowerW;
        })();

        // ── Ops/ms drift check ──
        let opsDrifted = false;
        const hwState = await hw.getHardwareLoadState();
        if (hwState && hwState.ok) {
          const currentOpsPerSec = Number(hwState.cpuLoadOpsPerSec) || 0;
          if (currentOpsPerSec > 0 && expectedOpsPerMs > 0) {
            const actualOpsPerMs = currentOpsPerSec / 1000;
            const drift = Math.abs(actualOpsPerMs - expectedOpsPerMs) / expectedOpsPerMs;
            if (drift > CURVE_DRIFT_THRESHOLD) {
              opsDrifted = true;
              if (consecutiveDriftCount < DRIFT_CONSECUTIVE_REQUIRED) {
                setLog((log) => [
                  {
                    time: now(),
                    msg: `Power curve ops/ms drift: ${(drift * 100).toFixed(1)}% at ${currentLoad}% load (expected ${expectedOpsPerMs.toFixed(1)}, got ${actualOpsPerMs.toFixed(1)}). Monitoring... (${consecutiveDriftCount + 1}/${DRIFT_CONSECUTIVE_REQUIRED})`,
                    type: 'warn',
                  },
                  ...log,
                ]);
              }
            }
          }
        }

        // ── Live power drift check ──
        // Only flag when live wattage is BELOW the curve, which may
        // indicate thermal throttling or hardware degradation.
        // Take multiple samples and average them to match the curve's
        // calibration methodology (7-second averaged sensor readings).
        let powerDrifted = false;
        if (hasLivePower && livePowerW > 0 && expectedPowerW > 0 && livePowerW < expectedPowerW) {
          const POWER_SAMPLES = 6;
          const POWER_SAMPLE_GAP_MS = 500;
          const samples = [livePowerW];
          for (let s = 1; s < POWER_SAMPLES; s++) {
            await new Promise((r) => setTimeout(r, POWER_SAMPLE_GAP_MS));
            try {
              const res = await hw.invoke('wattcoin-get-live-power');
              if (res && res.ok && res.totalW > 0) samples.push(res.totalW);
            } catch (_) {
              /* ignore */
            }
          }
          const avgLivePowerW = samples.reduce((a, b) => a + b, 0) / samples.length;
          const powerDrift = (expectedPowerW - avgLivePowerW) / expectedPowerW;
          if (powerDrift > CURVE_DRIFT_THRESHOLD) {
            powerDrifted = true;
            if (consecutiveDriftCount < DRIFT_CONSECUTIVE_REQUIRED) {
              setLog((log) => [
                {
                  time: now(),
                  msg: `Power curve wattage drift: ${(powerDrift * 100).toFixed(1)}% at ${currentLoad}% load (curve ${expectedPowerW.toFixed(1)}W, live ${avgLivePowerW.toFixed(1)}W avg of ${samples.length} samples). Monitoring... (${consecutiveDriftCount + 1}/${DRIFT_CONSECUTIVE_REQUIRED})`,
                  type: 'warn',
                },
                ...log,
              ]);
            }
          }
        }

        // ── Consistency guard ──
        if (opsDrifted || powerDrifted) {
          consecutiveDriftCount += 1;
          if (consecutiveDriftCount >= DRIFT_CONSECUTIVE_REQUIRED) {
            setLog((log) => [
              {
                time: now(),
                msg: `Power curve drift confirmed (${DRIFT_CONSECUTIVE_REQUIRED} consecutive checks). Pausing mining to recalibrate...`,
                type: 'warn',
              },
              ...log,
            ]);
            autoRebenchPendingRef.current = true;
            powerCurveAutoTriggeredRef.current = false;
            setMining(false);
            setPowerCurve(null);
            powerCurveRef.current = null;
          }
        } else {
          consecutiveDriftCount = 0;
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Curve drift check error:', String(_));
      }
    };

    const timer = setInterval(() => {
      checkCurveDrift().catch(() => {});
    }, CURVE_DRIFT_CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [mining, powerCurve, effectiveLoadPercent, powerCurveBenchmarkPending, livePowerW, hasLivePower, setLog, now]); // eslint-disable-line react-hooks/exhaustive-deps

  const coinsPerHour = tierEnergyPerCoinWh > 0 ? powerW / tierEnergyPerCoinWh : 0;
  const displayUnmatured = Math.max(0, nodeUnmatured);
  const displayMatured = Math.max(0, nodeMatured);
  const coinsPerDay = coinsPerHour * 24;
  const coinsPerWeek = coinsPerDay * 7;
  const coinsPerMonth = coinsPerDay * 30;
  const coinsPerYear = coinsPerDay * 365;

  const coinsRateLabel = (() => {
    if (coinsPerHour >= 1) return `${fmtNum(coinsPerHour, 4)} coins/hour`;
    if (coinsPerDay >= 1) return `${fmtNum(coinsPerDay, 4)} coins/day`;
    if (coinsPerWeek >= 1) return `${fmtNum(coinsPerWeek, 4)} coins/week`;
    if (coinsPerMonth >= 1) return `${fmtNum(coinsPerMonth, 4)} coins/month`;
    return `${fmtNum(coinsPerYear, 6)} coins/year`;
  })();

  const timePerCoinHours = coinsPerHour > 0 ? 1 / coinsPerHour : Infinity;
  const timePerCoinLabel = (() => {
    if (!Number.isFinite(timePerCoinHours)) return 'infinite (no mining power estimate yet)';
    if (timePerCoinHours < 24) return `${fmtNum(timePerCoinHours, 2)} hours`;
    if (timePerCoinHours < 24 * 7) return `${fmtNum(timePerCoinHours / 24, 2)} days`;
    if (timePerCoinHours < 24 * 30) return `${fmtNum(timePerCoinHours / (24 * 7), 2)} weeks`;
    if (timePerCoinHours < 24 * 365) return `${fmtNum(timePerCoinHours / (24 * 30), 2)} months`;
    return `${fmtNum(timePerCoinHours / (24 * 365), 2)} years`;
  })();

  React.useEffect(() => {
    const wasMining = prevMiningStateRef.current;
    prevMiningStateRef.current = mining;

    const targetAddress =
      typeof miningAddress === 'string' && miningAddress.trim()
        ? miningAddress.trim()
        : 'auto (primary wallet address)';
    const energyPerBlockWh = tierEnergyPerCoinWh * tierRewardCoins;

    if (!wasMining && mining) {
      // Fetch current round contribution so the start log shows running total.
      (async () => {
        let roundWhStr = '';
        let benchStr = '';
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
            const [bal, auth] = await Promise.all([
              window.wattcoinHardware.invoke('wattcoin-ledger-get-balances', targetAddress).catch(() => null),
              window.wattcoinHardware.invoke('wattcoin-get-authority-state').catch(() => null),
            ]);
            const roundWh =
              bal && typeof bal.currentRoundContributionWh === 'number' ? bal.currentRoundContributionWh : 0;
            if (roundWh > 0) roundWhStr = ` (round so far: ${fmtEnergy(roundWh)})`;
            if (auth) {
              const parts = [];
              if (typeof auth.sha256OpsPerMs === 'number' && auth.sha256OpsPerMs > 0)
                parts.push(`CPU ${auth.sha256OpsPerMs} ops/ms`);
              if (typeof auth.gpuOpsPerMs === 'number' && auth.gpuOpsPerMs > 0)
                parts.push(`GPU ${auth.gpuOpsPerMs} ops/ms`);
              if (parts.length > 0) benchStr = ` [${parts.join(', ')}]`;
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setLog((log) => [
          {
            time: now(),
            msg: `Mining started (tier ${currentTier}, target ${fmtEnergy(energyPerBlockWh)} per block, address=${targetAddress})${benchStr}${roundWhStr}`,
            type: 'info',
          },
          ...log,
        ]);
      })();
    } else if (wasMining && !mining) {
      // Fetch current round contribution so the stop log shows how much was contributed.
      (async () => {
        let roundWhStr = '';
        let benchStr = '';
        try {
          if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
            const [bal, auth] = await Promise.all([
              window.wattcoinHardware.invoke('wattcoin-ledger-get-balances', targetAddress).catch(() => null),
              window.wattcoinHardware.invoke('wattcoin-get-authority-state').catch(() => null),
            ]);
            const roundWh =
              bal && typeof bal.currentRoundContributionWh === 'number' ? bal.currentRoundContributionWh : 0;
            if (roundWh > 0) roundWhStr = ` (contributed ${fmtEnergy(roundWh)} this round)`;
            if (auth) {
              const parts = [];
              if (typeof auth.sha256OpsPerMs === 'number' && auth.sha256OpsPerMs > 0)
                parts.push(`CPU ${auth.sha256OpsPerMs} ops/ms`);
              if (typeof auth.gpuOpsPerMs === 'number' && auth.gpuOpsPerMs > 0)
                parts.push(`GPU ${auth.gpuOpsPerMs} ops/ms`);
              if (parts.length > 0) benchStr = ` [${parts.join(', ')}]`;
            }
          }
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
        setLog((log) => [
          {
            time: now(),
            msg: `Mining stopped${benchStr}${roundWhStr}`,
            type: 'info',
          },
          ...log,
        ]);
      })();
    }
  }, [mining, miningAddress, currentTier, tierEnergyPerCoinWh, tierRewardCoins, setLog, now]);

  // Notify main process when mining starts/stops so it can forward the status
  // to coordinators. Also start/stop ASIC miners together with the PC.
  React.useEffect(() => {
    const hw = window.wattcoinHardware;
    if (!hw) return;
    if (hw.invoke) {
      hw.invoke('wattcoin-mining-status', { mining: !!mining }).catch(() => {});
    }
    if (mining) {
      if (hw.startAsicMining) hw.startAsicMining().catch(() => {});
    } else {
      if (hw.stopAsicMining) hw.stopAsicMining().catch(() => {});
    }
  }, [mining]);

  // Poll per-ASIC liveness status every 30s while mining is active.
  React.useEffect(() => {
    if (!mining) {
      setAsicLiveness([]);
      return;
    }
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const res = await hw.invoke('wattcoin-asic-liveness-status');
        if (!cancelled && res && res.ok) setAsicLiveness(res.status || []);
      } catch (_) {
        /* timeout — ignore */
      }
    };
    poll();
    const timer = setInterval(poll, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [mining]);

  // Continuous mining loop where power->energy drives when blocks are mined.
  React.useEffect(() => {
    if (!mining) {
      energyBudgetWhRef.current = 0;
      lastRoundAttemptRef.current = { id: 0, atMs: 0 };
      setRealMineStatus('Mining stopped');
      return;
    }

    const blockRewardCoins = tierRewardCoins;
    const energyPerBlockWh = tierEnergyPerCoinWh * blockRewardCoins;
    const tickMs = 250;
    const maxBlocksPerTick = 3;

    let cancelled = false;
    let timer = null;
    let lastMs = Date.now();

    const tick = async () => {
      if (cancelled) return;
      if (peerDownRef.current) {
        setRealMineStatus('Waiting for peers...');
        return;
      }

      const nowMs = Date.now();
      const elapsedSeconds = Math.max(0, (nowMs - lastMs) / 1000);
      lastMs = nowMs;

      const effectivePowerW = Math.max(0, Number(powerW) || 0);
      if (effectivePowerW <= 0 || energyPerBlockWh <= 0) {
        setRealMineStatus('Waiting for power estimate...');
        timer = setTimeout(tick, tickMs);
        return;
      }

      try {
        if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
          const roundSummary = await window.wattcoinHardware
            .invoke('wattcoin-ledger-get-round-summary')
            .catch(() => null);
          if (roundSummary && roundSummary.ok) {
            const roundId = Math.max(0, Number(roundSummary.roundId) || 0);
            const sharedTotalWh = Math.max(0, Number(roundSummary.totalWh) || 0);
            const nowAttemptMs = Date.now();
            const lastAttempt = lastRoundAttemptRef.current || { id: 0, atMs: 0 };

            if (sharedTotalWh < energyPerBlockWh) {
              if (lastAttempt.id !== roundId) {
                lastRoundAttemptRef.current = { id: roundId, atMs: 0 };
              }
              setRealMineStatus(`Mining running... pool ${fmtEnergy(sharedTotalWh)} / ${fmtEnergy(energyPerBlockWh)}`);
              timer = setTimeout(tick, tickMs);
              return;
            }

            if (lastAttempt.id === roundId && nowAttemptMs - (lastAttempt.atMs || 0) < 5000) {
              setRealMineStatus('Shared round threshold reached, awaiting block...');
              timer = setTimeout(tick, tickMs);
              return;
            }

            lastRoundAttemptRef.current = { id: roundId, atMs: nowAttemptMs };
            const result = await mineOneRealBlock(sharedTotalWh);
            if (!cancelled && result !== 'NO_PEERS') {
              timer = setTimeout(tick, tickMs);
            }
            return;
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }

      if (peerDownRef.current) {
        setRealMineStatus('Waiting for peers...');
        return;
      }

      // Accumulate available mining energy from power over elapsed time.
      energyBudgetWhRef.current += (effectivePowerW * elapsedSeconds) / 3600;

      let blocksToMine = Math.floor(energyBudgetWhRef.current / energyPerBlockWh);
      if (blocksToMine <= 0) {
        setRealMineStatus('Mining running...');
        timer = setTimeout(tick, tickMs);
        return;
      }

      blocksToMine = Math.min(blocksToMine, maxBlocksPerTick);
      let minedCount = 0;
      for (let i = 0; i < blocksToMine && !cancelled; i++) {
        const result = await mineOneRealBlock(energyPerBlockWh);
        if (result === 'NO_PEERS') break;
        if (result === true) minedCount++;
      }
      // Only deduct budget for blocks that were actually mined.
      energyBudgetWhRef.current = Math.max(0, energyBudgetWhRef.current - minedCount * energyPerBlockWh);

      if (!cancelled && !peerDownRef.current) {
        timer = setTimeout(tick, tickMs);
      }
    };

    setRealMineStatus('Mining started...');
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    mining,
    miningAddress,
    powerW,
    tierEnergyPerCoinWh,
    tierRewardCoins,
    onBlockMined,
    mineOneRealBlock,
    peerDownToggle,
  ]);

  // NEW: lift powerW to parent
  React.useEffect(() => {
    if (typeof setPowerW === 'function') setPowerW(powerW);
  }, [powerW, setPowerW]);

  // Initialize WebGL on the hidden GPU load canvas once it mounts.
  // DISABLED: GPU load is now handled entirely by the native GPU binary
  // via the peer-probe path.  The WebGL burn did unsupervised GPU work
  // without coordinator seeds, which bypasses the seed proof system.
  React.useEffect(() => {
    // WebGL GPU burn disabled — peer-probe path handles GPU loading.
  }, [allowGpuWorkloads]);

  // GPU load loop: render heavy WebGL frames while mining is active (loads GPU like CPU workers load CPU).
  // Uses setTimeout (not requestAnimationFrame) so it continues when the window is minimized or another
  // app tab is shown -- rAF pauses in hidden pages but setTimeout keeps firing.
  // Controls GPU utilization via duty-cycle pacing: after each draw call, sleep for
  //   idleMs = ((1 - f) / f) * 16   (where f = loadFraction, 16 ms ~= one 60 fps frame)
  // so GPU busy-time / cycle-time ~= loadFraction regardless of the GPU's raw render speed.
  React.useEffect(() => {
    if (!allowGpuWorkloads) {
      if (gpuLoadRafRef.current) {
        clearTimeout(gpuLoadRafRef.current);
        gpuLoadRafRef.current = null;
      }
      return;
    }
    // When native gpu-miner.exe is running, skip the WebGL load loop to avoid double-loading the GPU.
    if (nativeGpuActive) {
      if (gpuLoadRafRef.current) {
        clearTimeout(gpuLoadRafRef.current);
        gpuLoadRafRef.current = null;
      }
      return;
    }
    // Intentionally NOT gated on isActive -- GPU mining continues when other app tabs are open.
    // Peer-down stops GPU load too so the hardware is not wasted while waiting.
    const gpuLoadActive = (mining && !peerDownRef.current) || benchmarkState.running;
    if (!gpuLoadActive || isHardwareOnHold || loadPercent <= 0) {
      if (gpuLoadRafRef.current) {
        clearTimeout(gpuLoadRafRef.current);
        gpuLoadRafRef.current = null;
      }
      return;
    }
    const { gl, seedLoc, syncBuf, measuredFrameMs, initialized } = gpuLoadGlStateRef.current;
    if (!initialized || !gl) return;

    let cancelled = false;
    // Duty-cycle pacing: target GPU utilisation = loadFraction.
    // currentRenderMs tracks actual GPU render time via EMA — updated every
    // NORMAL_CALIB_TICKS ticks on the normal path, and every 50 ticks on the
    // fast-GPU path, both via a single-frame readPixels calibration pulse.
    // Between calibrations gl.flush() submits GPU work non-blocking so the JS
    // thread is free during GPU execution and window dragging stays smooth.
    // The feedback controller corrects any duty-cycle drift from EMA imprecision.
    //
    // IMPORTANT: On Windows, setTimeout has a minimum resolution floor of ~4 ms even
    // for setTimeout(fn, 0).  For fast GPUs (idleMs < TIMER_FLOOR_MS), the
    // calculated idleMs is always rounded up to ~4 ms by the OS.
    //
    // Normal path (idleMs >= 4 ms): draw + flush (non-blocking), calib readPixels every 20 ticks.
    // Fast-GPU path (idleMs < 4 ms): render busyFrames per tick, sleep 0 (OS floor ~4 ms).
    const TIMER_FLOOR_MS = 4; // Windows minimum setTimeout resolution
    const NORMAL_CALIB_TICKS = 20; // readPixels sync once every N normal-path ticks
    // Seed from calibrated value; updated per-frame by EMA so boost/throttle shifts track.
    let currentRenderMs = Math.max(0.1, measuredFrameMs || 1);
    // RENDER_MS_FLOOR prevents the EMA from collapsing to near-zero when the app is minimized
    // and the GPU driver skips actual rasterization (frames complete in ~0 ms).  Without the
    // floor, currentRenderMs → 0 and the fast-GPU path pushes 1000 frames that take ~0 ms
    // total — duty cycle collapses to ~33% (1-2 ms busy / 4 ms OS floor).
    // Floor of 0.2 ms: still below any real GPU render time; just stops the EMA death spiral.
    const RENDER_MS_FLOOR = 0.2;
    // Use effectiveLoadPercent (trust-capped slider, 0-100) so GPU duty cycle matches the
    // same fraction used by the power formula and the CPU workers.
    // Old formula was loadPercent / MAX_HARDWARE_LOAD_PERCENT (e.g. 60/85 = 70.6%) which
    // over-drove the GPU by ~10 pp and pinned it at 100% when the slider was at max.
    const loadFraction = Math.max(0.01, Math.min(1, effectiveLoadPercent / 100));
    let fastCalibTick = 0; // counts ticks since last fast-path calibration pulse
    let normalCalibTick = 0; // counts ticks since last normal-path calibration pulse

    // -------------------------------------------------------------------------
    // Rolling-window proportional feedback controller (same design as CPU/DDR workers).
    // Measures actual GPU duty cycle over the last GPU_WINDOW ticks and applies a
    // proportional correction to each upcoming idle sleep so the target is always met.
    // Timer imprecision, GPU boost/throttle shifts, and occasional scheduling spikes
    // are all automatically corrected within ~6 cycles (~few hundred ms).
    // -------------------------------------------------------------------------
    const GPU_WINDOW = 16;
    const gpuBurnBuf = new Float64Array(GPU_WINDOW);
    const gpuTotalBuf = new Float64Array(GPU_WINDOW);
    let gpuWIdx = 0;
    let gpuWFull = false;

    function gpuFeedbackIdle(nominalIdle) {
      const n = gpuWFull ? GPU_WINDOW : gpuWIdx;
      if (n < 4) return nominalIdle;
      let sumBurn = 0,
        sumTotal = 0;
      for (let i = 0; i < n; i++) {
        sumBurn += gpuBurnBuf[i];
        sumTotal += gpuTotalBuf[i];
      }
      const measuredDuty = sumBurn / sumTotal;
      const error = loadFraction - measuredDuty; // positive = under-shooting
      const avgCycle = sumTotal / n;
      return Math.max(0, nominalIdle - error * avgCycle * 2);
    }

    function gpuRecordCycle(burnMs, totalMs) {
      gpuBurnBuf[gpuWIdx] = burnMs;
      gpuTotalBuf[gpuWIdx] = totalMs;
      gpuWIdx = (gpuWIdx + 1) % GPU_WINDOW;
      if (gpuWIdx === 0) gpuWFull = true;
      const n = gpuWFull ? GPU_WINDOW : gpuWIdx;
      if (n > 0) {
        let sumBurn = 0;
        let sumTotal = 0;
        for (let i = 0; i < n; i++) {
          sumBurn += gpuBurnBuf[i];
          sumTotal += gpuTotalBuf[i];
        }
        gpuMeasuredDutyRef.current = sumTotal > 0 ? Math.max(0, Math.min(1, sumBurn / sumTotal)) : 0;
      }
    }

    function frame() {
      if (cancelled) return;

      // Recompute nominal idleMs each frame using latest measured render time.
      const nominalIdle = ((1 - loadFraction) / loadFraction) * currentRenderMs;
      // Apply feedback correction to eliminate sustained under/over-shoot.
      const idleMs = gpuFeedbackIdle(nominalIdle);

      if (idleMs >= TIMER_FLOOR_MS) {
        // Normal path: draw + non-blocking flush so JS thread is free while GPU renders.
        // Every NORMAL_CALIB_TICKS ticks do one blocking readPixels to re-measure render
        // time and keep the EMA accurate.  GPU work runs concurrently with the JS sleep
        // (async), so: measuredDuty = burnMs / actualSleep.  Feedback drives idle until
        // burnMs / idle = loadFraction  →  true GPU duty ≈ loadFraction. ✓
        normalCalibTick++;
        const t0 = performance.now();
        gl.uniform1f(seedLoc, t0 * 0.001);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        let burnMs;
        if (normalCalibTick >= NORMAL_CALIB_TICKS) {
          normalCalibTick = 0;
          // Calibration pulse: block once to measure actual GPU render time.
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf);
          burnMs = Math.max(0.1, performance.now() - t0);
          currentRenderMs = Math.max(RENDER_MS_FLOOR, 0.85 * currentRenderMs + 0.15 * burnMs);
        } else {
          // Non-blocking: submit GPU work without stalling the JS thread.
          gl.flush();
          burnMs = currentRenderMs; // EMA estimate
        }
        const sleepT0 = performance.now();
        gpuLoadRafRef.current = setTimeout(() => {
          // GPU executes concurrently with JS sleep — record (burnMs, actualSleep) so
          // feedback measuredDuty = burnMs/sleep converges to loadFraction.
          if (!cancelled) gpuRecordCycle(burnMs, Math.max(burnMs, performance.now() - sleepT0));
          frame();
        }, Math.round(idleMs));
      } else {
        // Fast-GPU path: GPU render time is below the OS timer floor (~4 ms on Windows).
        // setTimeout(fn, 0) always waits ~TIMER_FLOOR_MS regardless of the requested delay,
        // so the "idle" portion of every cycle is fixed at ~TIMER_FLOOR_MS.  The correct
        // busyFrames to hit the target duty cycle is therefore:
        //   busyTime / (busyTime + TIMER_FLOOR_MS) = loadFraction
        //   busyFrames = TIMER_FLOOR_MS * loadFraction / (renderBaseMs * (1 - loadFraction))
        //
        // The feedback controller adjusts busyFrames by scaling via the duty error so the
        // window-measured actual duty converges to loadFraction each cycle.
        //
        // IMPORTANT: do NOT use readPixels every frame here — it synchronously drains the
        // entire GPU pipeline, blocking the JS thread for the full busyFrames render time
        // and making window dragging laggy.  Instead, every 50 ticks we render one frame,
        // readPixels-sync just that single frame to re-measure render time, then push the
        // remaining busyFrames non-blocking with gl.flush().  ~1% timing cost per 50 ticks.
        const n = gpuWFull ? GPU_WINDOW : gpuWIdx;
        let dutyScale = 1;
        if (n >= 4) {
          let sumBurn = 0,
            sumTotal = 0;
          for (let i = 0; i < n; i++) {
            sumBurn += gpuBurnBuf[i];
            sumTotal += gpuTotalBuf[i];
          }
          const measuredDuty = sumBurn / sumTotal;
          // Scale busyFrames proportionally to correct measured vs target duty.
          // Clamp to [0.25, 4] to avoid extreme oscillation on first few cycles.
          dutyScale = Math.max(0.25, Math.min(4, loadFraction / Math.max(0.001, measuredDuty)));
        }
        // Fast-GPU path: GPU renders concurrently with the CPU sleep, so the duty cycle is
        // busyTime / (busyTime + sleepTime).  When sleepTime is fixed at TIMER_FLOOR_MS, the
        // required busyTime = TIMER_FLOOR_MS × f / (1 - f) only holds for the BLOCKING normal
        // path.  In the async path the GPU works DURING the sleep, so the total cycle ≈ sleepMs
        // and the required busyTime = TIMER_FLOOR_MS × f  (no (1-f) denominator).
        const nominalFrames = (TIMER_FLOOR_MS * loadFraction) / currentRenderMs;
        const busyFrames = Math.min(1000, Math.max(1, Math.round(nominalFrames * dutyScale)));
        const seed0 = performance.now() * 0.001;
        fastCalibTick++;
        let burnMs = busyFrames * currentRenderMs; // estimate; overwritten on calib tick
        if (fastCalibTick >= 50) {
          fastCalibTick = 0;
          // Calibration pulse: drain all pending GPU work first so only ONE new frame
          // is timed — without this, readPixels drains the accumulated queue from the
          // previous non-calib busyFrames, inflating actualMs by Nx and causing
          // nominalFrames to shrink, which collapses real GPU duty to ~20-33%.
          gl.finish();
          const t0 = performance.now();
          gl.uniform1f(seedLoc, seed0);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf);
          const actualMs = Math.max(0.1, performance.now() - t0);
          currentRenderMs = Math.max(RENDER_MS_FLOOR, 0.85 * currentRenderMs + 0.15 * actualMs);
          burnMs = actualMs * busyFrames;
          // Push remaining busyFrames non-blocking.
          for (let i = 1; i < busyFrames; i++) {
            gl.uniform1f(seedLoc, seed0 + i * 0.0001);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          }
        } else {
          for (let i = 0; i < busyFrames; i++) {
            gl.uniform1f(seedLoc, seed0 + i * 0.0001);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          }
        }
        gl.flush(); // non-blocking: submit queued GPU work without waiting for completion
        const sleepT0 = performance.now();
        gpuLoadRafRef.current = setTimeout(() => {
          // In the async fast path the GPU executes concurrently with the CPU sleep, so the
          // total cycle time ≈ sleepMs, not burnMs + sleepMs.  Recording (burnMs, sleepMs)
          // gives measuredDuty = burnMs/sleepMs which correctly tracks actual GPU duty.
          if (!cancelled) gpuRecordCycle(burnMs, Math.max(burnMs, performance.now() - sleepT0));
          frame();
        }, 0);
      }
    }
    gpuLoadRafRef.current = setTimeout(frame, 0);

    return () => {
      cancelled = true;
      if (gpuLoadRafRef.current) {
        clearTimeout(gpuLoadRafRef.current);
        gpuLoadRafRef.current = null;
      }
      gpuMeasuredDutyRef.current = 0;
    };
  }, [
    allowGpuWorkloads,
    nativeGpuActive,
    mining,
    benchmarkState.running,
    loadPercent,
    effectiveLoadPercent,
    isHardwareOnHold,
    peerDownToggle,
  ]);

  // Hold countdown: tick holdSecondsLeft down every second; auto-clear when expired.
  React.useEffect(() => {
    if (!ENABLE_HARDWARE_HOLD) {
      setHoldSecondsLeft(0);
      return;
    }
    if (hardwareHoldUntilMs <= 0) {
      setHoldSecondsLeft(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((hardwareHoldUntilMs - Date.now()) / 1000));
      setHoldSecondsLeft(remaining);
      if (remaining <= 0) {
        setHardwareHoldUntilMs(0);
        try {
          localStorage.removeItem(HW_HOLD_STORAGE_KEY);
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
        }
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [hardwareHoldUntilMs]);

  // Safety net: if a hold is active while mining is true, force-stop mining and load.
  React.useEffect(() => {
    if (!isHardwareOnHold || !mining) return;
    let cancelled = false;

    (async () => {
      setMining(false);
      setRealMineStatus('Mining stopped: hardware on hold');
      try {
        if (window.wattcoinHardware && window.wattcoinHardware.stopHardwareLoad) {
          await window.wattcoinHardware.stopHardwareLoad();
        } else if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
          await window.wattcoinHardware.setHardwareLoad(0);
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
      if (!cancelled) {
        setLog((log) => [
          {
            time: now(),
            msg: 'Mining auto-stopped because hardware is currently on hold.',
            type: 'warn',
          },
          ...log,
        ]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isHardwareOnHold, mining, setMining, setLog, now]);

  // Poll peer count every 10 seconds while the dashboard is active.
  React.useEffect(() => {
    if (!isActive) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.getPeerCount) return;
    let cancelled = false;
    const fetch = async () => {
      try {
        const res = await hw.getPeerCount();
        if (!cancelled && res && res.ok) {
          setPeerCount(res.onlineCount ?? res.count ?? null);
          setConnectedPeerCount(Number(res.connectedCount ?? res.activeCount ?? res.tunnelCount) || 0);
          setPeerCountSource(res.source || null);
          setPeerDiscoveryInfo({
            configuredPeers: Number(res.configuredPeers) || 0,
            seedPeers: Number(res.seedPeers) || 0,
            discoveredPeers: Number(res.discoveredPeers) || 0,
          });
          setLastSyncInfo({
            trigger: String(res.lastSyncTrigger || ''),
            ok: Boolean(res.lastSyncOk),
          });
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    };
    fetch();
    const id = setInterval(fetch, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive]);

  // Poll live hardware power every 3 seconds.
  React.useEffect(() => {
    if (!isActive) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    let cancelled = false;
    const fetchPower = async () => {
      try {
        const res = await hw.invoke('wattcoin-get-live-power');
        if (!cancelled && res && res.ok) {
          if (res.init) console.warn('[LivePower renderer] init:', JSON.stringify(res.init, null, 2));
          if (res.cpuDiag) console.warn('[LivePower] emiDiag:', JSON.stringify(res.cpuDiag));
          console.warn(
            `[LivePower] ${res.cpuW || 0}W(cpu ${res.source}) + ${(res.gpus || []).reduce((s, g) => s + g.watts, 0)}W(gpu) = ${res.totalW || 0}W total`,
          );
          setLivePowerW(res.totalW || 0);
          setHasLivePower(true);
        } else if (!cancelled && res && !res.ok) {
          setHasLivePower(false);
        }
      } catch (_) {
        if (!cancelled) setHasLivePower(false);
      }
    };
    fetchPower();
    const id = setInterval(fetchPower, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive]);

  // Pause mining when the 5‑second peer poll reports 0 online peers.
  // Without this the tick loop's round‑summary path can spin indefinitely
  // (setting timeout → tick → setting timeout …) without ever calling
  // mineOneRealBlock, which is the only other code path that sets
  // peerDownRef.current = true.
  React.useEffect(() => {
    if (peerCount === 0) {
      peerDownRef.current = true;
      setPeerDownToggle((t) => t + 1);
    }
  }, [peerCount]);

  // Restart mining when a peer reconnects after all peers were offline.
  React.useEffect(() => {
    if (!isActive) return;
    if (peerDownRef.current && peerCount > 0) {
      peerDownRef.current = false;
      setRealMineStatus('Mining started...');
      setPeerDownToggle((t) => t + 1);
    }
  }, [isActive, peerCount]);

  // Poll wallet/chain readiness every 10 seconds while the dashboard is active.
  React.useEffect(() => {
    if (!isActive) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    let cancelled = false;
    const fetchReadiness = async () => {
      try {
        const res = await hw.invoke('wattcoin-get-wallet-readiness');
        if (!cancelled && res) setChainReadiness(res);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    };
    fetchReadiness();
    const id = setInterval(fetchReadiness, 10000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive]);

  React.useEffect(() => {
    if (!isActive) return;
    const hw = window.wattcoinHardware;
    if (!hw || !hw.invoke) return;
    let cancelled = false;
    const fetchRoundSummary = async () => {
      try {
        const res = await hw.invoke('wattcoin-ledger-get-round-summary');
        if (!cancelled && res && res.ok) {
          setSharedRoundTotalWh(Math.max(0, Number(res.totalWh) || 0));
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    };
    fetchRoundSummary();
    const id = setInterval(fetchRoundSummary, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isActive]);

  const hasConfiguredOrBundledPeerTargets = peerDiscoveryInfo.configuredPeers + peerDiscoveryInfo.seedPeers > 0;
  const hasAnyKnownPeerTargets = hasConfiguredOrBundledPeerTargets || peerDiscoveryInfo.discoveredPeers > 0;
  const peerCountZeroLabel = !hasConfiguredOrBundledPeerTargets
    ? '0 • no bundled public seeds configured'
    : !hasAnyKnownPeerTargets
      ? '0 • no peers known yet'
      : '0 • known peers unreachable';
  const readinessZeroLabel = !hasConfiguredOrBundledPeerTargets
    ? `Block height ${chainReadiness.blocks || 0} • Peers 0 • No bundled public seeds configured`
    : !hasAnyKnownPeerTargets
      ? `Block height ${chainReadiness.blocks || 0} • Peers 0 • Looking for peers...`
      : `Block height ${chainReadiness.blocks || 0} • Peers 0 • Known peers unreachable`;
  const lastSyncLabel = lastSyncInfo.trigger ? lastSyncInfo.trigger.replace(/^event:/, '').replace(/,/g, ', ') : '';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, width: '100%' }}>
      {hardwareUnknown && (
        <div
          style={{
            background: '#1e1b4b',
            border: '1px solid #6366f1',
            borderRadius: 8,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#c7d2fe',
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            Hardware not recognized — mining is unavailable. Please contact{' '}
            <a href="mailto:info@wattcoin.ee" style={{ color: '#a5b4fc', textDecoration: 'underline' }}>
              info@wattcoin.ee
            </a>{' '}
            to have your hardware added.
          </span>
        </div>
      )}
      {isHardwareOnHold && (
        <div
          style={{
            background: '#7f1d1d',
            border: '1px solid #ef4444',
            borderRadius: 8,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#fecaca',
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            Hardware on hold — consecutive benchmark drift detected. Mining and energy accounting paused. Resumes in{' '}
            {Math.floor(holdSecondsLeft / 60)}:{String(holdSecondsLeft % 60).padStart(2, '0')}
          </span>
        </div>
      )}
      {firewallBlocked && (
        <div
          style={{
            background: '#7f1d1d',
            border: '1px solid #ef4444',
            borderRadius: 8,
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#fecaca',
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 16,
          }}
        >
          <span style={{ fontSize: 16 }}>⚠</span>
          <span>
            No Windows Firewall rule was created during install — peer attestation cannot receive inbound connections.
            Mining is disabled.
          </span>
          {typeof onHealFirewall === 'function' && (
            <button
              onClick={onHealFirewall}
              disabled={firewallHealing}
              style={{
                marginLeft: 'auto',
                background: firewallHealing ? '#881337' : '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: 6,
                padding: '6px 14px',
                cursor: firewallHealing ? 'not-allowed' : 'pointer',
                fontWeight: 600,
                fontSize: 12,
                whiteSpace: 'nowrap',
                opacity: firewallHealing ? 0.6 : 1,
              }}
            >
              {firewallHealing ? 'Fixing...' : 'Fix Firewall'}
            </button>
          )}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'row', gap: 32, alignItems: 'stretch', width: '100%' }}>
        {/* Left column: Hardware recognition */}
        <div
          ref={hwCardRef}
          style={{
            flex: '0 0 auto',
            width: savedHwCardWidth ? `${savedHwCardWidth}px` : 'max-content',
            minWidth: `${HARDWARE_COLUMN_WIDTH_PX}px`,
            maxWidth: '420px',
            boxSizing: 'border-box',
            background: '#0d1a0d',
            border: '1px solid #1e3a1e',
            borderRadius: 12,
            padding: '32px 24px',
            minHeight: `${HARDWARE_CARD_HEIGHT_PX}px`,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
          }}
        >
          <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 15, color: '#4ade80', marginBottom: 12 }}>
            Hardware Recognition
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>Device Type:</b> {hardware.deviceType || 'Unknown'}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>Manufacturer:</b> {hardware.manufacturer || 'Unknown'}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>Version:</b> {hardware.version || 'Unknown'}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>CPU:</b> {hardware.cpu || 'Unknown'}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>GPU{allGpuModels.length > 1 ? `s (${allGpuModels.length})` : ''}:</b>{' '}
            {allGpuModels.length === 0
              ? 'Unknown'
              : (() => {
                  const details =
                    Array.isArray(hardware.gpuDetailsList) && hardware.gpuDetailsList.length > 0
                      ? hardware.gpuDetailsList
                      : allGpuModels.map((m) => ({ model: m, vramGb: 0, memType: '' }));
                  const fmt = (d) => {
                    let s = d.model;
                    let vramGb = d.vramGb;
                    let memType = d.memType;
                    // Fallback to static lookup table when systeminformation didn't populate these
                    if (!vramGb || !memType) {
                      const info = getGpuVramInfo(d.model);
                      if (!vramGb && info.vramGb) vramGb = info.vramGb;
                      if (!memType && info.memType) memType = info.memType;
                    }
                    if (vramGb > 0) s += ` ${vramGb} GB`;
                    if (memType) s += ` ${memType}`;
                    return s;
                  };
                  return details.length === 1
                    ? fmt(details[0])
                    : details.map((d, i) => (
                        <span key={i} style={{ display: 'block', paddingLeft: 8 }}>
                          {i + 1}. {fmt(d)}
                        </span>
                      ));
                })()}
          </div>
          <div style={{ color: '#e8f5e8', fontSize: 15, marginBottom: 8 }}>
            <b>Memory:</b> {hardware.memory || 'Unknown'}
          </div>
          <div
            style={{
              color: '#e8f5e8',
              fontSize: 15,
              marginBottom: 8,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <b>Operating System:</b> {hardware.osName || 'Unknown'}
          </div>

          <div style={{ marginTop: 8, borderTop: '1px solid #1e3a1e', paddingTop: 8 }}>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 15, color: '#4ade80', marginBottom: 12 }}>
              ASIC Recognition
            </div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <button
                onClick={async () => {
                  setAsicConfigStatus('Scanning...');
                  setScanning(true);
                  try {
                    const res = await window.wattcoinHardware.scanAsicNetwork();
                    if (res.ok) {
                      const asics = res.asics || [];
                      if (asics.length > 0) {
                        const config = asics.map((a) => ({
                          ip: a.ip,
                          apiPort: a.port || 4028,
                          stratumPort: 3333,
                          driverName: a.driverName || '',
                          driverConfig: a.driverConfig || null,
                        }));
                        await window.wattcoinHardware.setAsicConfig(config);
                        setDiscoveredAsics(asics);
                        setAsicConfigStatus(`Scan complete: ${asics.length} ASIC(s) configured`);
                      } else {
                        setDiscoveredAsics([]);
                        await window.wattcoinHardware.setAsicConfig([]);
                        setAsicConfigStatus('Scan complete: no ASICs found');
                      }
                    } else {
                      setAsicConfigStatus('Scan failed');
                    }
                  } catch (err) {
                    setAsicConfigStatus(`Scan error: ${String(err.message || err).slice(0, 80)}`);
                  }
                  setScanning(false);
                }}
                disabled={scanning}
                style={{
                  background: '#1e3a1e',
                  color: '#4ade80',
                  border: '1px solid #2a5a2a',
                  borderRadius: 4,
                  padding: '4px 10px',
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                {scanning ? 'Scanning...' : 'Scan Network'}
              </button>
            </div>
            {discoveredAsics.length > 0 && (
              <div style={{ marginBottom: 6 }}>
                {discoveredAsics.map((asic) => (
                  <div
                    key={asic.ip}
                    style={{
                      background: '#0f2a0f',
                      border: '1px solid #1e3a1e',
                      borderRadius: 4,
                      padding: '6px 8px',
                      marginBottom: 4,
                      fontSize: 11,
                      color: '#e8f5e8',
                    }}
                  >
                    <div>
                      <b>{asic.model}</b> @ {asic.ip}:{asic.port}
                    </div>
                    {asic.hashrateTHs > 0 && (
                      <div style={{ color: '#6aaa6a', marginTop: 2 }}>Hashrate: {asic.hashrateTHs.toFixed(3)} TH/s</div>
                    )}
                    {asic.telemetry && (asic.telemetry.tempInlet > 0 || asic.telemetry.fanSpeedRpm > 0) && (
                      <div style={{ color: '#888', marginTop: 1 }}>
                        {asic.telemetry.tempInlet > 0 &&
                          `${asic.telemetry.tempInlet}-${asic.telemetry.tempOutlet || '?'}-${asic.telemetry.tempChip || '?'} C`}
                        {asic.telemetry.fanSpeedRpm > 0 && ` | Fan: ${asic.telemetry.fanSpeedRpm} RPM`}
                        {asic.telemetry.chipCount > 0 && ` | Chips: ${asic.telemetry.chipCount}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
            {asicConfigStatus && <div style={{ color: '#facc15', fontSize: 11, marginTop: 4 }}>{asicConfigStatus}</div>}
            {asicLiveness.length > 0 && (
              <div style={{ marginTop: 6, borderTop: '1px solid #1e3a1e', paddingTop: 4 }}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#4ade80', marginBottom: 4 }}>
                  Live status
                </div>
                {asicLiveness.map((a) => (
                  <div
                    key={`${a.ip}:${a.port}`}
                    style={{
                      fontSize: 10,
                      color: a.isActive ? '#4ade80' : '#ef4444',
                      marginBottom: 2,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <span style={{ fontSize: 8 }}>{a.isActive ? '\u25CF' : '\u25CB'}</span>
                    {a.ip}:{a.port}
                    {a.isActive && a.totalShares > 0 && (
                      <span style={{ color: '#6aaa6a' }}>{a.totalShares} shares</span>
                    )}
                    {!a.isActive && <span style={{ color: '#ef4444' }}>idle</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div
            style={{
              marginTop: 'auto',
              width: '100%',
              borderTop: '1px solid #1e3a1e',
              paddingTop: 10,
              position: 'relative',
            }}
          >
            {!powerCurveBenchmarkPending && (
              <button
                onClick={rebenchPowerCurve}
                style={{
                  position: 'absolute',
                  top: 2,
                  right: -8,
                  fontSize: 9,
                  padding: '1px 5px',
                  border: '1px solid #4ade80',
                  borderRadius: 4,
                  background: 'transparent',
                  color: '#4ade80',
                  cursor: 'pointer',
                }}
                title="Re-run power curve benchmark"
              >
                re-bench
              </button>
            )}
            <div
              style={{
                color: '#6aaa6a',
                fontSize: 13,
                marginTop: 0,
                marginBottom: 4,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                width: '100%',
              }}
              title={powerCurveBenchmarkPending ? 'Power curve benchmark in progress' : hardwareCardPowerCalcBreakdown}
            >
              <b>Power calculation:</b>{' '}
              <span style={{ color: powerCurveBenchmarkPending ? '#facc15' : undefined }}>
                {powerCurveBenchmarkPending ? 'Calibrating...' : hardwareCardPowerCalcBreakdown}
              </span>
            </div>
            <div
              style={{ color: benchmarkState.running || startupBenchmarkPending ? '#facc15' : '#4ade80', fontSize: 12 }}
            >
              <b>Benchmark score:</b>{' '}
              {benchmarkState.running || startupBenchmarkPending
                ? 'running...'
                : benchmarkState.lastScore === null
                  ? clampedLoadPercent === 0
                    ? 'Set hardware load'
                    : 'pending'
                  : `${benchmarkState.lastScore}/100`}
            </div>
            {!benchmarkState.running &&
              !startupBenchmarkPending &&
              benchmarkState.lastScore !== null &&
              (benchmarkState.lastJitterPct !== null ||
                benchmarkState.lastAvgCpuPct !== null ||
                benchmarkState.lastAvgGpuPct !== null) && (
                <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                  {benchmarkState.lastJitterPct !== null && (
                    <div
                      style={{
                        fontSize: 11,
                        color:
                          benchmarkState.lastJitterPct <= 10
                            ? '#4ade80'
                            : benchmarkState.lastJitterPct <= 20
                              ? '#facc15'
                              : '#f97316',
                      }}
                    >
                      {(() => {
                        const j = benchmarkState.lastJitterPct;
                        const label = j <= 10 ? 'Low' : j <= 20 ? 'Moderate' : 'High';
                        return (
                          <span>
                            <b>Jitter:</b> {label}
                          </span>
                        );
                      })()}
                    </div>
                  )}
                  {(benchmarkState.lastAvgCpuPct !== null || benchmarkState.lastAvgGpuPct !== null) &&
                    (benchmarkState.lastWasBaseline ? (
                      <div style={{ fontSize: 11, color: '#6b7280' }}>
                        {(() => {
                          const p = benchmarkState.cpuPenaltyPct;
                          const label =
                            p < 0 ? 'Baseline' : p <= 10 ? 'Good' : p <= 20 ? 'Normal' : p <= 30 ? 'Poor' : 'Degraded';
                          const clr =
                            label === 'Good'
                              ? '#a7ffb0'
                              : label === 'Normal'
                                ? '#facc15'
                                : label === 'High'
                                  ? '#f97316'
                                  : label === 'Degraded'
                                    ? '#ef4444'
                                    : '#6b7280';
                          return <span style={{ color: clr, marginLeft: 0 }}>CPU: {label}</span>;
                        })()}
                        {benchmarkState.lastAvgGpuPct !== null &&
                          (() => {
                            const p = benchmarkState.gpuPenaltyPct;
                            const label =
                              p < 0
                                ? 'Baseline'
                                : p <= 10
                                  ? 'Good'
                                  : p <= 20
                                    ? 'Normal'
                                    : p <= 30
                                      ? 'Poor'
                                      : 'Degraded';
                            const clr =
                              label === 'Good'
                                ? '#a7ffb0'
                                : label === 'Normal'
                                  ? '#facc15'
                                  : label === 'High'
                                    ? '#f97316'
                                    : label === 'Degraded'
                                      ? '#ef4444'
                                      : '#6b7280';
                            return <span style={{ color: clr, marginLeft: 8 }}>GPU: {label}</span>;
                          })()}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                        avg
                        {[
                          benchmarkState.lastAvgCpuPct !== null &&
                            (() => {
                              const v = benchmarkState.lastAvgCpuPct;
                              const c =
                                Math.abs(v) <= 10
                                  ? '#a7ffb0'
                                  : Math.abs(v) <= 25
                                    ? '#facc15'
                                    : v > 0
                                      ? '#4ade80'
                                      : '#f87171';
                              return (
                                <span key="cpu" style={{ color: c, marginLeft: 8 }}>
                                  CPU {v > 0 ? `+${v}` : v}%
                                </span>
                              );
                            })(),
                          benchmarkState.lastAvgGpuPct !== null &&
                            (() => {
                              const v = benchmarkState.lastAvgGpuPct;
                              const c =
                                Math.abs(v) <= 10
                                  ? '#a7ffb0'
                                  : Math.abs(v) <= 25
                                    ? '#facc15'
                                    : v > 0
                                      ? '#4ade80'
                                      : '#f87171';
                              return (
                                <span key="gpu" style={{ color: c, marginLeft: 8 }}>
                                  GPU {v > 0 ? `+${v}` : v}%
                                </span>
                              );
                            })(),
                        ].filter(Boolean)}
                      </div>
                    ))}
                </div>
              )}
            {!benchmarkState.running && !startupBenchmarkPending && benchmarkState.lastScore !== null && (
              <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                {benchmarkState.lastTrustDelta !== null && (
                  <div
                    style={{
                      fontSize: 11,
                      color:
                        benchmarkState.lastTrustDelta > 0
                          ? '#4ade80'
                          : benchmarkState.lastTrustDelta < 0
                            ? '#f87171'
                            : '#a7ffb0',
                    }}
                  >
                    <b>Trust:</b>{' '}
                    {benchmarkState.lastTrustDelta > 0
                      ? `+${benchmarkState.lastTrustDelta}`
                      : benchmarkState.lastTrustDelta < 0
                        ? `${benchmarkState.lastTrustDelta}`
                        : 'no change'}
                    {benchmarkState.lastTrustChangeTime && (
                      <span style={{ color: '#64748b', marginLeft: 6 }}>{benchmarkState.lastTrustChangeTime}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {/* Hidden canvas for continuous GPU load during mining — 2048×2048 so
              modern discrete GPUs register measurable utilisation */}
          <canvas
            ref={gpuLoadCanvasRef}
            width={2048}
            height={2048}
            style={{ position: 'fixed', left: '-9999px', top: '-9999px', width: 1, height: 1, pointerEvents: 'none' }}
            aria-hidden="true"
          />
        </div>

        {/* Right top area: mining status + metric cards */}
        <div style={{ flex: '2 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              background: '#0d1a0d',
              border: '1px solid #1e3a1e',
              borderRadius: 12,
              padding: '16px 18px',
              height: `${STATUS_CARD_HEIGHT_PX}px`,
              boxSizing: 'border-box',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 10,
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  Mining Status
                </div>
                {electricityPrice !== null && (
                  <div
                    title={
                      electricityPriceSource === 'live'
                        ? 'Live global average — globalpetrolprices.com'
                        : electricityPriceSource === 'cache'
                          ? 'Cached (updates every 24 h)'
                          : 'Estimated global average (live fetch unavailable)'
                    }
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      background: '#0a1f0a',
                      border: '1px solid #1e3a1e',
                      borderRadius: 6,
                      padding: '2px 7px',
                      cursor: 'default',
                    }}
                  >
                    <span style={{ fontSize: 10, color: electricityPriceSource === 'live' ? '#4ade80' : '#6b9b6b' }}>
                      ⚡
                    </span>
                    <span
                      style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: 10,
                        color: '#a7ffb0',
                        letterSpacing: '0.03em',
                      }}
                    >
                      ${electricityPrice.toFixed(3)}
                      <span style={{ color: '#4a6a4a' }}>/kWh</span>
                    </span>
                    <span
                      style={{
                        fontSize: 8,
                        color: electricityPriceSource === 'live' ? '#4ade80' : '#4a6a4a',
                        marginLeft: 1,
                      }}
                    >
                      {electricityPriceSource === 'live' ? '●' : '○'}
                    </span>
                  </div>
                )}
                {electricityPrice !== null &&
                  (() => {
                    const wtcCostUsd = (electricityPrice * energyForTier(statusTier)) / 1000;
                    const fmt =
                      wtcCostUsd >= 1000
                        ? `$${(wtcCostUsd / 1000).toFixed(2)}k`
                        : wtcCostUsd >= 1
                          ? `$${wtcCostUsd.toFixed(2)}`
                          : wtcCostUsd >= 0.001
                            ? `$${wtcCostUsd.toFixed(4)}`
                            : `$${wtcCostUsd.toExponential(2)}`;
                    return (
                      <div
                        title={`Mining cost per WTC at current electricity price and Tier ${statusTier} energy requirement (${energyForTier(statusTier).toLocaleString()} Wh/coin × $${electricityPrice.toFixed(3)}/kWh)`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          background: '#0a1f0a',
                          border: '1px solid #1e3a1e',
                          borderRadius: 6,
                          padding: '2px 7px',
                          cursor: 'default',
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "'DM Mono', monospace",
                            fontSize: 10,
                            color: '#4ade80',
                            letterSpacing: '0.05em',
                            fontWeight: 600,
                          }}
                        >
                          WTC
                        </span>
                        <span
                          style={{
                            fontFamily: "'DM Mono', monospace",
                            fontSize: 10,
                            color: '#a7ffb0',
                            letterSpacing: '0.03em',
                          }}
                        >
                          {fmt}
                        </span>
                      </div>
                    );
                  })()}
                <div
                  title="Total pooled energy contributed by all miners in the current shared round."
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    background: '#0a1f0a',
                    border: '1px solid #1e3a1e',
                    borderRadius: 6,
                    padding: '2px 7px',
                    cursor: 'default',
                  }}
                >
                  <span style={{ fontSize: 10, color: '#4ade80' }}>Σ</span>
                  <span
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 10,
                      color: '#a7ffb0',
                      letterSpacing: '0.03em',
                    }}
                  >
                    {fmtEnergy(sharedRoundTotalWh, sharedRoundTotalWh >= 1000 ? 2 : 0)}
                  </span>
                  <span
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 9,
                      color: '#4a6a4a',
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase',
                    }}
                  >
                    round
                  </span>
                </div>
              </div>
              <div
                style={{ fontSize: 12, color: '#a7ffb0' }}
              >{`Tier ${statusTier} active · ${fmtEnergy(energyForTier(statusTier), 0)}/coin`}</div>
            </div>
            <div
              style={{
                height: 10,
                width: '100%',
                borderRadius: 999,
                background: '#122612',
                overflow: 'hidden',
                border: '1px solid #1e3a1e',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${minedPct}%`,
                  background: 'linear-gradient(90deg, #4ade80, #22c55e)',
                  transition: 'width 0.25s linear',
                }}
              />
            </div>
            <div style={{ marginTop: 8, display: 'flex', flex: 1, gap: 0 }}>
              {/* Left half: mined progress + mining address + peers */}
              <div
                style={{
                  flex: 1,
                  paddingRight: 14,
                  borderRight: '1px solid #1e3a1e',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 12, color: '#4a6a4a' }}>
                  {`${fmtNum(chainEmittedCoins, 4)} WTC / ${fmtNum(totalCoinSupply)} WTC node mined (${minedPct.toFixed(4)}%)`}
                </div>
                <div style={{ fontSize: 12, color: '#a7ffb0', wordBreak: 'break-all' }}>
                  <b>Mining Address:</b> {miningAddress || 'Loading...'}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color:
                      peerCountSource === 'standalone'
                        ? '#4a6a4a'
                        : peerCount === null
                          ? '#4a6a4a'
                          : peerCount === 0
                            ? '#f87171'
                            : '#a7ffb0',
                  }}
                >
                  {peerCountSource === 'standalone' ? (
                    <>
                      <b>Peers online:</b> — standalone mode <span style={{ color: '#4a6a4a' }}>•</span>{' '}
                      <b>Peers connected:</b> —
                    </>
                  ) : peerCount === null ? (
                    <>
                      <b>Peers online:</b> — waiting... <span style={{ color: '#4a6a4a' }}>•</span>{' '}
                      <b>Peers connected:</b> —
                    </>
                  ) : peerCount === 0 ? (
                    <>
                      <b>Peers online:</b> {peerCountZeroLabel} <span style={{ color: '#4a6a4a' }}>•</span>{' '}
                      <b>Peers connected:</b> {connectedPeerCount}
                    </>
                  ) : (
                    <>
                      <b>Peers online:</b> {peerCount} <span style={{ color: '#4a6a4a' }}>•</span>{' '}
                      <b>Peers connected:</b> {connectedPeerCount}
                    </>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: chainReadiness.spendReady
                      ? '#4ade80'
                      : chainReadiness.connections === 0
                        ? '#f87171'
                        : '#fbbf24',
                  }}
                >
                  {chainReadiness.spendReady
                    ? 'Wallet Ready'
                    : chainReadiness.connections === 0
                      ? 'Connecting to Network'
                      : chainReadiness.reachableButNotAhead
                        ? 'Peers Reachable, No Higher Chain'
                        : 'Wallet Syncing'}
                  {' • '}
                  {chainReadiness.connections === 0
                    ? readinessZeroLabel
                    : chainReadiness.reachableButNotAhead
                      ? `Local height ${chainReadiness.localBlocks || 0} • Reachable peers ${chainReadiness.connections} • No higher sync source yet`
                      : `Block height ${chainReadiness.blocks || 0} • Peers ${chainReadiness.connections}`}
                </div>
                {!chainReadiness.spendReady && chainReadiness.syncBlockedReason && (
                  <div style={{ fontSize: 11, color: '#f87171' }}>
                    <b>Sync blocked:</b> {chainReadiness.syncBlockedReason}
                  </div>
                )}
                {lastSyncLabel && (
                  <div style={{ fontSize: 11, color: lastSyncInfo.ok ? '#4ade80' : '#fbbf24' }}>
                    <b>Last sync:</b> {lastSyncInfo.ok ? 'synced via ' : 'triggered by '}
                    {lastSyncLabel}
                  </div>
                )}
              </div>
              {/* Right: trust meter */}
              <div
                style={{
                  flex: 1,
                  paddingLeft: 14,
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 10,
                      color: '#4ade80',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Trust Score
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: trustScore >= 70 ? '#4ade80' : trustScore >= 30 ? '#facc15' : '#f87171',
                    }}
                  >
                    {trustScore}/100
                  </div>
                </div>
                <div
                  style={{
                    height: 8,
                    width: '100%',
                    borderRadius: 999,
                    background: '#122612',
                    overflow: 'hidden',
                    border: '1px solid #1e3a1e',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${trustScore}%`,
                      background:
                        trustScore >= 70
                          ? 'linear-gradient(90deg, #4ade80, #22c55e)'
                          : trustScore >= 30
                            ? 'linear-gradient(90deg, #facc15, #eab308)'
                            : 'linear-gradient(90deg, #f87171, #ef4444)',
                      transition: 'width 0.5s ease',
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', gap: 16, width: '100%', alignItems: 'stretch' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  background: '#0d1a0d',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '20px 24px',
                  height: `${METRIC_CARD_HEIGHT_PX}px`,
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.1em',
                    marginBottom: 8,
                    textTransform: 'uppercase',
                  }}
                >
                  Power Used
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ color: '#a7ffb0', fontSize: 12 }}>Max hardware power</div>
                  <div
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: 24,
                      fontWeight: 700,
                      color: '#e8f5e8',
                      lineHeight: 1.1,
                    }}
                  >
                    {fmtNum(unitFullPowerW, 2)} W
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: trustScore >= 75 ? '#4ade80' : trustScore >= 50 ? '#facc15' : '#f87171',
                      marginTop: -4,
                    }}
                  >
                    {`Trust cap: ${trustLoadCap}% → ${fmtNum(basePowerW, 0)} W  (trust ${trustScore}/100)`}
                  </div>
                  <div style={{ color: '#a7ffb0', fontSize: 12 }}>Mining power</div>
                  <div
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: 24,
                      fontWeight: 700,
                      color: '#e8f5e8',
                      lineHeight: 1.1,
                    }}
                  >
                    {fmtNum(totalPowerUsedW, 2)} W
                  </div>
                  {hasLivePower && (
                    <>
                      <div style={{ color: '#a7ffb0', fontSize: 12 }}>Live power</div>
                      <div
                        style={{
                          fontFamily: "'Playfair Display', serif",
                          fontSize: 24,
                          fontWeight: 700,
                          color: '#e8f5e8',
                          lineHeight: 1.1,
                        }}
                      >
                        {fmtNum(livePowerW, 1)} W
                      </div>
                    </>
                  )}
                </div>
                <div style={{ marginTop: 'auto', borderTop: '1px solid #1e3a1e', paddingTop: 8 }}>
                  <div
                    style={{ fontSize: 12, color: '#a7ffb0', marginTop: 4 }}
                  >{`Base power ${fmtNum(basePowerW, 1)} W -> active mining power ${fmtNum(powerW, 1)} W`}</div>
                </div>
              </div>
            </div>
            <div
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                height: `${METRIC_CARD_HEIGHT_PX}px`,
                boxSizing: 'border-box',
              }}
            >
              {/* Energy Used — compact, auto height */}
              <div
                style={{
                  background: '#0d1a0d',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '14px 20px',
                  flex: '0 0 auto',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.1em',
                    marginBottom: 6,
                    textTransform: 'uppercase',
                  }}
                >
                  Energy Used
                </div>
                <div
                  style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: 26,
                    fontWeight: 700,
                    color: '#e8f5e8',
                    lineHeight: 1.1,
                  }}
                >
                  {fmtEnergy(energy, 2, 4)}
                </div>
                <div style={{ fontSize: 11, color: '#4a6a4a', marginTop: 5 }}>
                  {energy >= 1e3
                    ? `${fmtNum(energy, 0)} Wh total (${fmtEnergy(energy, 3)})`
                    : 'power × time integrated — upgrades to kWh at 1,000 Wh'}
                </div>
              </div>
              {/* Hardware Load — fills remaining height */}
              <div
                style={{
                  background: '#0d1a0d',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '14px 20px',
                  flex: 1,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11,
                      color: '#4ade80',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Hardware Load
                  </div>
                  <div style={{ color: '#e8f5e8', fontSize: 15, fontWeight: 700 }}>
                    {effectiveLoadPercent}%
                    <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 6 }}>(trust cap: {trustLoadCap}%)</span>
                  </div>
                </div>
                <input
                  type="range"
                  min="0"
                  max={String(MAX_HARDWARE_LOAD_PERCENT)}
                  step="1"
                  value={clampedLoadPercent}
                  onChange={(event) => {
                    setLoadPercent(Number(event.target.value));
                  }}
                  onMouseUp={() => {
                    const nowMs = Date.now();
                    if (nowMs - lastSliderCommitAtMsRef.current < 100) return;
                    lastSliderCommitAtMsRef.current = nowMs;
                    setSliderAdjustNonce((n) => n + 1);
                  }}
                  onTouchEnd={() => {
                    const nowMs = Date.now();
                    if (nowMs - lastSliderCommitAtMsRef.current < 100) return;
                    lastSliderCommitAtMsRef.current = nowMs;
                    setSliderAdjustNonce((n) => n + 1);
                  }}
                  onKeyUp={() => {
                    const nowMs = Date.now();
                    if (nowMs - lastSliderCommitAtMsRef.current < 100) return;
                    lastSliderCommitAtMsRef.current = nowMs;
                    setSliderAdjustNonce((n) => n + 1);
                  }}
                  // onBlur intentionally omitted: tab-switch would trigger it and
                  // cause a redundant slider-stop benchmark after adjusting the slider.
                  style={{ width: '100%', accentColor: '#4ade80', cursor: 'pointer' }}
                />
                <div
                  style={{
                    fontSize: 11,
                    color: '#4a6a4a',
                    marginTop: 'auto',
                    borderTop: '1px solid #1e3a1e',
                    paddingTop: 8,
                  }}
                >{`Applies ${effectiveLoadPercent}% of hardware power. Trust cap: ${trustLoadCap}%.`}</div>
                <div
                  style={{ fontSize: 11, color: '#4a6a4a', marginTop: 3 }}
                >{`Est. time for 1 coin: ${timePerCoinLabel}`}</div>
              </div>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
              <div
                style={{
                  background: '#0d1a0d',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '20px 24px',
                  height: `${METRIC_CARD_HEIGHT_PX}px`,
                  boxSizing: 'border-box',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11,
                      color: '#4ade80',
                      letterSpacing: '0.1em',
                      marginBottom: 8,
                      textTransform: 'uppercase',
                    }}
                  >
                    Coins Mined
                  </div>
                  <div
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: 28,
                      fontWeight: 700,
                      color: '#e8f5e8',
                      lineHeight: 1.1,
                    }}
                  >{`${fmtNum(nodeTotal, 2)} WTC`}</div>
                  <div
                    style={{ fontSize: 12, color: '#4a6a4a', marginTop: 6 }}
                  >{`Tier ${currentTier} · ${fmtEnergy(tierEnergyPerCoinWh, 0)}/coin · ${fmtNum(rewardForTier(currentTier), 2)} WTC/block`}</div>
                  <div
                    style={{ fontSize: 12, color: '#4a6a4a', marginTop: 3 }}
                  >{`${fmtNum(nodeTotal % COINS_PER_TIER, 2)} / ${fmtNum(COINS_PER_TIER)} coins this tier · ${fmtNum(totalCoinSupply)} WTC total supply`}</div>
                </div>
                <div style={{ marginTop: 10, borderTop: '1px solid #1e3a1e', paddingTop: 8 }}>
                  <div
                    style={{ fontSize: 12, color: '#a7ffb0', marginTop: 6 }}
                  >{`Matured: ${fmtNum(displayMatured, 2)} WTC | Unmatured: ${fmtNum(displayUnmatured, 2)} WTC`}</div>
                  <div
                    style={{ fontSize: 12, color: '#a7ffb0', marginTop: 4 }}
                  >{`Estimated mining rate: ${coinsRateLabel}`}</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'row', gap: 16, width: '100%', alignItems: 'stretch' }}>
            {showRebenchPrompt ? (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  background: '#78350f',
                  borderRadius: 8,
                  padding: '8px 12px',
                  fontSize: 12,
                  color: '#fed7aa',
                  fontWeight: 600,
                }}
              >
                <span style={{ flex: 1, lineHeight: 1.3 }}>
                  Startup benchmark shows degraded performance
                  {[
                    benchmarkState.cpuPenaltyPct > 30 && `CPU ${benchmarkState.cpuPenaltyPct}%`,
                    benchmarkState.gpuPenaltyPct > 30 && `GPU ${benchmarkState.gpuPenaltyPct}%`,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  . Re-benchmark?
                </span>
              </div>
            ) : (
              <div style={{ flex: 1 }} />
            )}
            <div style={{ flex: 1 }}>
              <button
                onClick={() => {
                  if (rebenchRef.current) {
                    rebenchRef.current = false;
                    setShowRebenchPrompt(false);
                    runBenchmark('startup');
                  } else {
                    if (showRebenchPrompt) return;
                    setMining(true);
                  }
                }}
                disabled={
                  mining ||
                  hardwareUnknown ||
                  !hardwareRecognitionFinished ||
                  benchmarkState.running ||
                  startupBenchmarkPending ||
                  powerCurveBenchmarkPending ||
                  needsPowerCurve ||
                  isHardwareOnHold ||
                  firewallBlocked ||
                  peerCount === null ||
                  peerCount === 0 ||
                  clampedLoadPercent === 0
                }
                style={{
                  width: '100%',
                  background:
                    mining ||
                    hardwareUnknown ||
                    !hardwareRecognitionFinished ||
                    benchmarkState.running ||
                    startupBenchmarkPending ||
                    powerCurveBenchmarkPending ||
                    needsPowerCurve ||
                    isHardwareOnHold ||
                    firewallBlocked ||
                    peerCount === null ||
                    peerCount === 0 ||
                    clampedLoadPercent === 0
                      ? '#7aa88a'
                      : showRebenchPrompt
                        ? '#ea580c'
                        : '#4ade80',
                  color: showRebenchPrompt ? '#fff' : '#0d1a0d',
                  border: 'none',
                  borderRadius: 8,
                  padding: '12px 32px',
                  fontWeight: 700,
                  fontSize: 20,
                  cursor:
                    mining ||
                    hardwareUnknown ||
                    !hardwareRecognitionFinished ||
                    benchmarkState.running ||
                    startupBenchmarkPending ||
                    powerCurveBenchmarkPending ||
                    needsPowerCurve ||
                    isHardwareOnHold ||
                    firewallBlocked ||
                    peerCount === null ||
                    peerCount === 0 ||
                    clampedLoadPercent === 0
                      ? 'not-allowed'
                      : 'pointer',
                }}
              >
                {hardwareUnknown
                  ? 'Hardware unknown'
                  : isHardwareOnHold
                    ? `On hold (${Math.floor(holdSecondsLeft / 60)}:${String(holdSecondsLeft % 60).padStart(2, '0')})`
                    : powerCurveBenchmarkPending
                      ? 'Calibrating curve'
                      : needsPowerCurve
                        ? 'Calibrating curve...'
                        : mining
                          ? 'Mining active'
                          : benchmarkState.running || startupBenchmarkPending
                            ? 'Benchmarking...'
                            : firewallBlocked
                              ? 'Firewall blocked'
                              : peerCount === null || peerCount === 0
                                ? 'No peers'
                                : showRebenchPrompt
                                  ? 'Re-Benchmark'
                                  : clampedLoadPercent === 0
                                    ? 'Set hardware load'
                                    : hardwareRecognitionFinished
                                      ? 'Start mining'
                                      : 'Detecting hardware...'}
              </button>
            </div>
            <div style={{ flex: 1 }}>
              <button
                onClick={async () => {
                  autoRebenchPendingRef.current = false;
                  setMining(false);
                  try {
                    if (window.wattcoinHardware && window.wattcoinHardware.stopHardwareLoad) {
                      await window.wattcoinHardware.stopHardwareLoad();
                    } else if (window.wattcoinHardware && window.wattcoinHardware.setHardwareLoad) {
                      await window.wattcoinHardware.setHardwareLoad(0);
                    }
                  } catch (_) {
                    if (process.env.WATTCOIN_DEBUG)
                      console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
                  }
                }}
                disabled={!mining}
                style={{
                  width: '100%',
                  background: !mining ? '#8a7a7a' : '#ef4444',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: 8,
                  padding: '12px 32px',
                  fontWeight: 700,
                  fontSize: 20,
                  cursor: !mining ? 'not-allowed' : 'pointer',
                }}
              >
                Stop
              </button>
            </div>
          </div>
          {coins >= totalCoinSupply && (
            <div style={{ color: '#4ade80', fontFamily: "'DM Mono', monospace" }}>Total supply cap reached (21M).</div>
          )}
        </div>
      </div>
    </div>
  );
}
