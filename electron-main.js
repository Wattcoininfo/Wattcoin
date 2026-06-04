const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
// Keep the GPU compositor active even when the window is minimized or occluded.
// backgroundThrottling:false (set on the BrowserWindow) stops JS timer throttling but
// Chromium's GPU process still pauses WebGL rasterisation for invisible windows.
// These switches disable that optimisation so the GPU load loop runs at full duty cycle
// whether the window is visible, minimised, or covered by another application.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.setAppUserModelId('com.wattcoin.miner');
const { spawnSync: _spawnSync } = require('child_process');
const http = require('http');
const _dns = require('dns').promises;
const https = require('https');
const net = require('net');
const dgram = require('dgram');
const { EventEmitter } = require('events');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const {
  getBenchmarkCapabilities,
  runBackendBenchmark,
  setProbeHardwareSpec,
  getPendingProbe,
  submitProbeResult,
  getProbeHistory,
  getAttestHistory,
  issuePeerProbe,
  submitPeerProbeResult,
  getPeerProbeHistory: _getPeerProbeHistory,
  verifyCpuSpeedProof,
  verifyMemProof,
  computeGpuProbeExpectedHash,
  setCoordinatorIdentityKey,
  PROBE_INTERVAL_MS,
  getLocalProbeChain,
  setAsicHardwareSpec,
} = require('./backend-benchmark');
const {
  getExpectedCpuSpeedOps,
  getExpectedMemBandwidthMBps,
  getAsicPowerW,
  getAsicHashrateTHs,
  getGpuTdpW,
} = require('./hardware-tables.cjs');
const {
  setHardwareLoadPercent,
  stopHardwareLoad,
  getHardwareLoadState,
  configurePhysicalCores,
} = require('./hardware-load-controller');
const {
  ensureGpu,
  getGpuInfo,
  getGpuLoadState,
  setGpuLoadPercent: setGpuLoadPercentFn,
  stopGpuHardwareLoad,
  shutdownGpu,
  runGpuProof,
  runGpuBenchmark,
} = require('./gpu-load-controller');
const si = require('systeminformation');
const { createRoundLedger } = require('./round-ledger');
const { buildOpsHealthResponse, checkLedgerNetworkAuth } = require('./ops-health');
const { createRemoteSeedManifestManager } = require('./remote-seed-manifest');
const { maybeRegisterReachableRequester: maybeRegisterReachableRequesterHelper } = require('./requester-registration');
function getDataDir() {
  return path.join(os.homedir(), 'WattcoinMinerUserData');
}
function getActiveNetwork() {
  return 'wtc-mainnet';
}
function refreshCoordinatorIdentityKey() {
  try {
    const address = String(
      wtcNode && typeof wtcNode.getPrimaryAddress === 'function' ? wtcNode.getPrimaryAddress() : '',
    ).trim();
    if (address) {
      walletAddressCache = { address, at: Date.now() };
      setCoordinatorIdentityKey(address);
    }
    return address;
  } catch (_) {
    return '';
  }
}
function getAppDisplayVersion() {
  let packageVersion = '';
  try {
    packageVersion = String(require('./package.json').version || '').trim();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  if (!app.isPackaged) {
    return packageVersion || '?';
  }

  try {
    const packagedVersion = String(app.getVersion() || '').trim();
    return packagedVersion || packageVersion || '?';
  } catch (_) {
    return packageVersion || '?';
  }
}
const { getRuntimeConfig } = require('./runtime-config');
const { autoUpdater } = require('electron-updater');
const { createWtcNode } = require('./wtc-node');
const { countLiveReverseTunnelPeers, summarizeDisplayedPeerCounts } = require('./peer-count-observability');
const { buildPeerDiscoverySnapshot } = require('./peer-discovery-observability');
const { filterAdvertisedPeerUrls, obfuscatePeerUrl, resolvePeerPrivacySecret } = require('./peer-privacy');
const { isSelfPeerUrlCandidate, filterExternalPeerUrls } = require('./peer-self-filter');
const {
  getLocalSubnetProbeCandidates,
  selectDiscoveryPeerUrl,
  selectPreferredPeerUrl,
  sortPeerUrlsByPreference,
  checkHasKnownPrivateLanPeer,
} = require('./local-subnet-discovery');
const {
  normalizeProbeReceipt,
  getProbeReceiptSigningPayload,
  attachProbeReceiptSignature,
} = require('./probe-attestation');
const saleQueue = require('./wtc-sale-queue');
const stakingQueue = require('./wtc-staking-queue');
const { isValidAddress: isValidWtcAddress, verifyWalletMessagePureJS } = require('./wtc-address');
const { rewardForHeight } = require('./wtc-chain');

const BACKUP_FILE_EXTENSION = 'wcbak';
const BACKUP_FORMAT_VERSION = 1;
const ABUSE_LOG_FILE_NAME = 'abuse-events.jsonl';
const STARTUP_TRACE_FILE_NAME = 'wattcoin-startup-trace.log';
const BUNDLED_SEED_PEER_FILE_NAMES = ['seed-peers.mainnet.json', 'bootstrap-peers.mainnet.json'];
const _CLI_DEFAULT_TIMEOUT_MS = 6000;
const _WALLET_READINESS_REFRESH_INTERVAL_MS = 12000;
const _WALLET_READINESS_DETAILED_REFRESH_INTERVAL_MS = 5 * 60_000;
// While syncing, re-run getblockchaininfo on every UI poll (5 s) so block count visibly advances.
const _WALLET_READINESS_DETAILED_RETRY_INTERVAL_MS = 5_000;
const _WALLET_ADDRESS_CACHE_MS = 30000;
const WALLET_SYNC_STATE_REFRESH_INTERVAL_MS = 5000;

const { ALLOWED_SENDER_ADDRESSES } = require('./protocol-constants');
const ENDPOINT_RATE_LIMITS = {
  'wattcoin-mine-block': { windowMs: 60_000, max: 12, lockMs: 5 * 60_000 },
  'wattcoin-ledger-add-contribution': { windowMs: 60_000, max: 240, lockMs: 2 * 60_000 },
  'wattcoin-ledger-settle-round': { windowMs: 60_000, max: 30, lockMs: 5 * 60_000 },
  'wattcoin-ledger-get-balances': { windowMs: 60_000, max: 180, lockMs: 60_000 },
  'wtc-peer-chain-headers': { windowMs: 60_000, max: 120, lockMs: 2 * 60_000 },
  'wtc-peer-chain-blocks': { windowMs: 60_000, max: 120, lockMs: 2 * 60_000 },
  'wtc-peer-chain-block-hash': { windowMs: 60_000, max: 120, lockMs: 2 * 60_000 },
  'wattcoin-send': { windowMs: 10 * 60_000, max: 3, lockMs: 30 * 60_000 },
  'wattcoin-list-transactions': { windowMs: 60_000, max: 90, lockMs: 60_000 },
  // GPU calibration is called once per benchmark run; cap at 10 per 10 min to
  // prevent a compromised renderer from flooding the personal-mean sample buffer.
  'wattcoin-report-gpu-calibration': { windowMs: 10 * 60_000, max: 10, lockMs: 10 * 60_000 },
  // Probe endpoints are unauthenticated (peer tokens differ per machine) so rate-limit by IP.
  'peer-probe-issue': { windowMs: 60_000, max: 60, lockMs: 5 * 60_000 }, // max 1/s per peer
  'peer-probe-submit': { windowMs: 60_000, max: 60, lockMs: 5 * 60_000 },
};

const endpointRateState = new Map();

// ── Rate-lock persistence ─────────────────────────────────────────────────────
// Active locks are written to disk so a restart cannot circumvent a punishment
// window.  Only the lock expiry timestamps are persisted (not hit counts) since
// those would be stale after a restart anyway.
const RATE_LOCK_FILE_NAME = 'rate-locks.json';
function getRateLockFilePath() {
  return path.join(app.getPath('userData'), RATE_LOCK_FILE_NAME);
}

function loadRateLocks() {
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
    // Prune expired entries while saving.
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

// ── Hardware-authority state ─────────────────────────────────────────────────────
// Owned by the main process only.  Calibrations, trust score, and hw-hold are
// persisted to a userData file so they cannot be reset by patching the renderer
// or clearing localStorage.  The renderer reads these values back via IPC and
// uses them for display only.

// Bump this string to force a one-time trust-score reset to 50 for every user
// on their next launch.  Change it whenever a network-wide reset is needed.
const TRUST_RESET_EPOCH = '2026-04-23-v1';

let hwAuthority = {
  trustScore: 50,
  hwHoldUntilMs: 0,
  benchmarkOpsCalibration: 1.0,
  benchmarkMemCalibration: 1.0,
  benchmarkGpuCalibration: 1.0,
  consecutiveCleanBenchmarks: 0,
  peerProbeVerifiedForRound: false, // set by wattcoin-submit-peer-probe-result; reset by settle
  // Commitment stored at mine time; verified at settle time to prevent swapping
  // a fake contribution in between mine and settle.
  pendingProofCommitment: '',
  // Power ceiling — set at benchmark time, used to clamp addContribution calls.
  // Stores the calibration-adjusted declared TDP; trust factor applied at contribution time.
  calibratedUnitPowerW: 0,
  // Last load percentage actually applied via wattcoin-set-hardware-load.
  currentLoadPercent: 100,
  // Set when hardware fingerprint changes but the wallet address hasn't changed.
  // Blocks addContribution until the user creates a new wallet.
  hwChangedBlocked: false,
  // Unix ms timestamp of the last successful hardware reset.
  // Enforces a 7-day cooldown so the button cannot be abused to repeatedly
  // clear hardware holds or reset the jitter calibration baseline.
  lastHwResetAtMs: 0,
  // Unix ms timestamp of the last successful search-cache clear.
  // Enforces a 3-day cooldown so TDP lookup data cannot be repeatedly wiped.
  lastSearchCacheClearAtMs: 0,
  // GPU TDP reported by the native binary (gpu-miner.exe) via DXGI.
  // Set when the main process reads getGpuInfo().adapter and looks it up
  // in getGpuTdpW(). Overrides the renderer-supplied GPU power component.
  nativeGpuTdpW: 0,
  // Rolling mean jitter derived from persistent jitterSamples history.
  // Used to widen the attestation threshold for machines that legitimately
  // run with higher OS-scheduler variance (e.g. background load, slow CPUs).
  rollingJitterMean: 0,
};

// ── Network anomaly detection: per-address mining stats ──────────────────────
// Tracks declared power vs measured CPU for every miner seen by this node.
// Used to detect outliers — a miner claiming 5000W with CPU benchmark far
// outside the network norm is likely cheating.
// Entries are evicted after 24h of inactivity; capped at 10,000 entries.
const networkMiningStats = new Map();

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

// Returns true if this miner's power/cpu ratio is an outlier (>3σ from network mean).
function isPowerCpuOutlier(address, powerW, cpuOps) {
  if (networkMiningStats.size < 3) return false;
  let sumRatio = 0,
    count = 0;
  for (const [addr, stats] of networkMiningStats) {
    if (addr === address || stats.count === 0) continue;
    const ratio = stats.totalCpuOps > 0 ? stats.totalPowerW / stats.totalCpuOps : 0;
    sumRatio += ratio;
    count++;
  }
  if (count < 2) return false;
  const mean = sumRatio / count;
  let sumSq = 0;
  for (const [addr, stats] of networkMiningStats) {
    if (addr === address || stats.count === 0) continue;
    const ratio = stats.totalCpuOps > 0 ? stats.totalPowerW / stats.totalCpuOps : 0;
    sumSq += (ratio - mean) ** 2;
  }
  const stdDev = Math.sqrt(sumSq / count);
  if (stdDev === 0) return false;
  const myRatio = cpuOps > 0 ? powerW / cpuOps : 0;
  return (myRatio - mean) / stdDev > 3;
}

function getHwAuthStatePath() {
  return path.join(app.getPath('userData'), 'hw-auth-state.json');
}

// True until hw-auth-state.json is created for the first time.  Renderer can
// send a one-shot seed message so legacy localStorage trust scores survive the
// migration to the backend-authoritative store.
let hwAuthStateIsNew = false;

function computeHwAuthSig(data) {
  // attestationState is always fully loaded (app.whenReady) before this is called.
  return crypto
    .createHmac('sha256', Buffer.from(attestationState.secret, 'utf8'))
    .update(JSON.stringify(data))
    .digest('hex');
}

function loadHwAuthState() {
  try {
    const raw = fs.readFileSync(getHwAuthStatePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid format');
    // Verify HMAC integrity.  Missing sig (legacy file) is accepted once; on next
    // save the file will be re-written with a valid signature.
    const { sig, ...data } = parsed;
    if (sig) {
      const expected = computeHwAuthSig(data);
      if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
        // Signature mismatch — file was tampered with.  Reset to defaults and flag.
        hwAuthStateIsNew = true;
        console.warn('[hwAuth] hw-auth-state.json signature invalid - resetting to defaults.');
        return;
      }
    }
    // Trust-reset epoch check — if the saved epoch doesn't match TRUST_RESET_EPOCH,
    // discard the stored trust score and reset to 50 (neutral) for this user.
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
    // If a 24-hour hold has naturally expired, restore trust to 25 (probationary restart).
    if (hwAuthority.hwHoldUntilMs > 0 && hwAuthority.hwHoldUntilMs <= Date.now() && hwAuthority.trustScore === 0) {
      hwAuthority.trustScore = 25;
      hwAuthority.hwHoldUntilMs = 0;
    }
  } catch (_) {
    // hw-auth-state.json is missing or corrupt.  Before falling back to defaults,
    // attempt to recover from the DPAPI-encrypted backup stored inside
    // attestation-state.json.  This prevents an attacker from deleting the file
    // to clear a hw-hold or artificially reset the trust score.
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
              // Recreate the signed file so subsequent launches load normally.
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
      // Genuinely new install -- let the renderer seed the legacy localStorage value.
      hwAuthStateIsNew = true;
    }
  }
}

function saveHwAuthState() {
  try {
    const p = getHwAuthStatePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const data = {
      trustScore: hwAuthority.trustScore,
      hwHoldUntilMs: hwAuthority.hwHoldUntilMs,
      lastHwResetAtMs: hwAuthority.lastHwResetAtMs,
      lastSearchCacheClearAtMs: hwAuthority.lastSearchCacheClearAtMs,
      trustResetEpoch: TRUST_RESET_EPOCH,
    };
    fs.writeFileSync(p, JSON.stringify({ ...data, sig: computeHwAuthSig(data) }), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  // Write a DPAPI-encrypted backup of trust state into attestation-state.json so
  // that deleting hw-auth-state.json cannot be used to reset or clear trust / hw-hold.
  if (safeStorage && safeStorage.isEncryptionAvailable()) {
    try {
      const backupJson = JSON.stringify({
        trustScore: hwAuthority.trustScore,
        hwHoldUntilMs: hwAuthority.hwHoldUntilMs,
        lastHwResetAtMs: hwAuthority.lastHwResetAtMs,
        lastSearchCacheClearAtMs: hwAuthority.lastSearchCacheClearAtMs,
      });
      const encrypted = safeStorage.encryptString(backupJson).toString('base64');
      const atPath = getAttestationDbFilePath();
      const atRaw = fs.existsSync(atPath) ? JSON.parse(fs.readFileSync(atPath, 'utf8')) : {};
      atRaw.encryptedTrustBackup = encrypted;
      fs.writeFileSync(atPath, JSON.stringify(atRaw, null, 2), 'utf8');
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }
}

// ── OS-level hardware identity (authoritative — renderer cannot influence) ────
// These values are read once at startup from Node / Electron / systeminformation
// APIs in the main process.  They are used to cross-check the renderer's hardware
// declarations; any mismatch triggers a trust penalty and a Brave-sourced TDP cap.
let osHardwareIdentity = null; // { cpuModel, gpuModels[], chassisType, deviceType, isVM, vmType }

function isUnusableGpuIdentity(value) {
  const s = String(value || '').trim();
  if (!s) return true;
  if (/^unknown/i.test(s)) return true;
  if (/^0x[0-9a-f]+$/i.test(s)) return true;
  if (/^[0-9\s,./-]+$/.test(s)) return true;
  if (/Microsoft Basic (Render|Display) Driver/i.test(s)) return true;
  if (/Microsoft Hyper-V/i.test(s)) return true;
  return !/[a-z]/i.test(s);
}

async function resolveOsHardwareIdentity() {
  if (osHardwareIdentity) return osHardwareIdentity;
  const cpuModel = ((os.cpus()[0] && os.cpus()[0].model) || '').trim();

  // GPU: Electron's app.getGPUInfo('basic') returns renderer-independent GPU data.
  let gpuModels = [];
  try {
    const gpuInfo = await app.getGPUInfo('basic');
    if (gpuInfo && Array.isArray(gpuInfo.gpuDevice)) {
      gpuModels = gpuInfo.gpuDevice
        .map((d) => {
          const vendor = String(d.vendorString || d.driverVendor || d.vendor || '').trim();
          const model = String(d.deviceString || d.deviceName || d.name || '').trim();
          const named = `${vendor} ${model}`.replace(/\s+/g, ' ').trim();
          if (named && /[a-z]/i.test(named)) return named;
          const fallbackId = String(d.deviceId || d.vendorId || '').trim();
          return fallbackId;
        })
        .map((s) => String(s || '').trim())
        .filter(Boolean);
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  // If Electron GPU info didn't return useful model names, try systeminformation.
  if (!gpuModels.length || gpuModels.every((g) => isUnusableGpuIdentity(g))) {
    try {
      const graphics = await si.graphics();
      if (graphics && Array.isArray(graphics.controllers)) {
        gpuModels = graphics.controllers.map((c) => (c.model || c.name || '').trim()).filter(Boolean);
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  // Filter out software/fallback renderers that are not real physical GPUs.
  gpuModels = gpuModels.filter((g) => !isUnusableGpuIdentity(g));

  // Chassis / device-type detection via systeminformation (main-process only).
  let chassisType = '';
  let deviceType = 'PC';
  const LAPTOP_CHASSIS_CODES = ['8', '9', '10', '14'];
  try {
    const chassis = await si.chassis();
    chassisType = String((chassis && chassis.type) || '').trim();
    if (/notebook|laptop|portable/i.test(chassisType) || LAPTOP_CHASSIS_CODES.includes(chassisType))
      deviceType = 'Laptop';
    else if (/server/i.test(chassisType)) deviceType = 'Server';
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  // Additional laptop detection: battery presence is a strong signal.
  if (deviceType === 'PC') {
    try {
      const battery = await si.battery();
      if (battery && battery.hasBattery) deviceType = 'Laptop';
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }

  // ── VM detection (multi-signal) ──────────────────────────────────────────
  // A VM allows spoofing CPUID + SMBIOS tables, bypassing all OS-level checks.
  // We use multiple independent signals — any single one is sufficient to flag.
  let isVM = false;
  let vmType = '';
  try {
    const sysInfo = await si.system();
    // si.system().virtual returns the hypervisor name or '' if bare metal.
    if (sysInfo && sysInfo.virtual) {
      isVM = true;
      vmType = String(sysInfo.virtual);
    }
    // Secondary: manufacturer / model strings that indicate virtualisation.
    const mfr = String((sysInfo && sysInfo.manufacturer) || '').toLowerCase();
    const model = String((sysInfo && sysInfo.model) || '').toLowerCase();
    const vmHints = /virtualbox|vmware|qemu|kvm|xen|hyper-v|parallels|bhyve|bochs|innotek|virtual machine/i;
    if (vmHints.test(mfr) || vmHints.test(model)) {
      isVM = true;
      if (!vmType) vmType = mfr || model;
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  // Tertiary: CPU model string hints (some hypervisors leave traces).
  if (!isVM) {
    const cpuLower = cpuModel.toLowerCase();
    if (/qemu|virtual|kvm/i.test(cpuLower)) {
      isVM = true;
      vmType = 'cpu-string-hint';
    }
  }

  // Quaternary: GPU model hints — virtual display adapters.
  if (!isVM && gpuModels.length > 0) {
    const vmGpuHints = /virtualbox|vmware|microsoft basic|hyper-v|qxl|virtio|red hat|bochs/i;
    if (gpuModels.some((g) => vmGpuHints.test(g))) {
      isVM = true;
      vmType = 'virtual-gpu';
    }
  }

  osHardwareIdentity = { cpuModel, gpuModels, chassisType, deviceType, isVM, vmType };
  console.log(
    `[HW-Identity] OS-level: cpu="${cpuModel}", gpus=[${gpuModels.join(', ')}], chassis="${chassisType}", type="${deviceType}", vm=${isVM}${isVM ? ' (' + vmType + ')' : ''}`,
  );
  return osHardwareIdentity;
}

// ── Wattage parsing (shared with Miner.jsx — authoritative copy) ────────────
function normalizeWattageText(text) {
  return String(text || '')
    .replace(/\$\$/g, ' ')
    .replace(/\\[,;!:\s]*\\(?:text|mathrm)\{\s*([Ww])\s*\}/g, ' $1')
    .replace(/\\(?:text|mathrm)\{\s*[Ww]\s*\}/g, 'W')
    .replace(/\{\s*[Ww]\s*\}/g, 'W')
    .replace(/\\[,;!:\s]*/g, ' ')
    .replace(/\s+/g, ' ');
}

function parseBestWattage(text) {
  const normalized = normalizeWattageText(text);
  const re = /\b(\d{1,4}(?:\.\d{1,2})?)\s*[Ww](?:atts?)?(?!\d)/g;
  let best = null,
    bestScore = -Infinity;
  let m;
  while ((m = re.exec(normalized)) !== null) {
    const w = parseFloat(m[1]);
    const ctx = normalized.substring(Math.max(0, m.index - 80), m.index + m[0].length + 80).toLowerCase();
    let score = 0;
    if (/\btdp\b/.test(ctx)) score += 3;
    if (/consumption|under load|max.{0,10}power|full load|power draw|stress/i.test(ctx)) score += 2;
    if (/rated|maximum|peak/i.test(ctx)) score += 1;
    if (/adapter|charger|power supply|ac adapter|psu/i.test(ctx)) score -= 3;
    if (/idle|sleep|standby/i.test(ctx)) score -= 2;
    if (score > bestScore || (score === bestScore && best === null)) {
      best = Math.round(w);
      bestScore = score;
    }
  }
  return best;
}

// ── Main-process TDP lookup (via server-side proxy) ─────────────────────────
// The Brave AI subscription key lives server-side only.  The app calls
// wattcoin.ee/api/tdp-lookup which forwards to Brave and returns the raw
// answer text.  parseBestWattage() still runs locally for extraction.
const BRAVE_TDP_PROXY_URL = 'https://wattcoin.ee/api/tdp-lookup';
const _mainTdpCache = new Map(); // model → { tdpW, ts }
const _MAIN_TDP_CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function fetchTdpFromBrave(modelString) {
  const clean = modelString
    .replace(/\(R\)|\(TM\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return Promise.resolve(null);

  // Check cache.
  const cached = _mainTdpCache.get(clean);
  if (cached && Date.now() - cached.ts < _MAIN_TDP_CACHE_TTL_MS) return Promise.resolve(cached.tdpW);

  return new Promise((resolve) => {
    try {
      const proxyUrl = new URL(BRAVE_TDP_PROXY_URL);
      proxyUrl.searchParams.set('gpu', clean);
      const req = https.request(
        proxyUrl,
        {
          method: 'GET',
          timeout: 15000,
          agent: false,
          headers: {
            'User-Agent': 'wattcoin-miner/1.0 (power-lookup)',
            Accept: 'application/json',
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              const answer = data && data.ok && data.answer ? data.answer : null;
              const tdpW = answer ? parseBestWattage(answer) : null;
              if (tdpW !== null) _mainTdpCache.set(clean, { tdpW, ts: Date.now() });
              resolve(tdpW);
            } catch (_) {
              resolve(null);
            }
          });
          res.on('error', () => resolve(null));
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    } catch (_) {
      resolve(null);
    }
  });
}

// ── ASIC liveness check: hash challenge via cgminer API ──────────────────────
// Connects to the ASIC's local API (standard ports 4028-4030) and sends a
// hashing challenge.  Real ASIC chips complete near-instantly via their hash
// boards; software fakes (or absent hardware) take orders of magnitude longer.
// We send 8 rounds of 1 KB chunks, expecting < 500 ms total for any real ASIC.
function doubleSha256(buf) {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest('hex');
}

async function verifyAsicLiveness(_modelName) {
  const PORTS = [4028, 4029, 4030];
  const ROUNDS = 8;
  const CHUNK_BYTES = 1024;

  for (const port of PORTS) {
    try {
      const startMs = Date.now();
      let asicType = '';
      for (let i = 0; i < ROUNDS; i++) {
        const data = crypto.randomBytes(CHUNK_BYTES);
        const expected = doubleSha256(data);
        const hex = data.toString('hex');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        let res;
        try {
          res = await fetch(`http://127.0.0.1:${port}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'check', parameter: hex }),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeout);
        }
        const json = await res.json();
        const record = json && json.check && json.check[0];
        const actual = record && record.Hash;
        if (!actual || String(actual).toLowerCase() !== expected) {
          throw new Error(`hash mismatch at round ${i}`);
        }
        // Capture the ASIC model from the first response round.
        if (i === 0) {
          asicType = String(record.Type || record.Miner || record.Description || '').trim();
        }
      }
      const elapsedMs = Date.now() - startMs;
      return { ok: true, elapsedMs, rounds: ROUNDS, bytesTotal: ROUNDS * CHUNK_BYTES, port, asicType };
    } catch (_) {
      // Port unreachable or check failed — try next port.
    }
  }
  return { ok: false, elapsedMs: 0, asicType: '' };
}

// Compare two hardware model strings — returns true if they refer to the same
// component.  Strips OEM decoration ((R), (TM), '@ X.XXGHz', gen-prefix) and
// uses case-insensitive includes in both directions (OS strings may be shorter
// or longer than renderer strings).
function hardwareModelsMatch(osModel, declaredModel) {
  const normalize = (s) =>
    String(s || '')
      .normalize('NFKC')
      // Handle common mojibake variants of trademark symbols from mixed encodings.
      .replace(/Γäó|â„¢|™/g, ' ')
      // Handle collapsed trademark text forms (e.g. CoreTM).
      .replace(/([a-z])tm\b/gi, '$1')
      .replace(/\b(tm|trademark|registered)\b/gi, ' ')
      .replace(/\(R\)|\(TM\)/gi, '')
      .replace(/@.*$/i, '')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const strip = (s) => s.replace(/\s+/g, ' ').trim();
  const a = normalize(strip(osModel));
  const b = normalize(strip(declaredModel));
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;

  // CPU/GPU model token fallback: if both contain the same key model token
  // (e.g. i5-3320m, rtx-4090), treat as equivalent despite vendor/prefix noise.
  const tokenRe = /\b(?:[a-z]+-)?[a-z]?\d[\w-]{2,}\b/gi;
  const aTokens = new Set((a.match(tokenRe) || []).map((t) => t.toLowerCase()));
  const bTokens = (b.match(tokenRe) || []).map((t) => t.toLowerCase());
  return bTokens.some((t) => aTokens.has(t));
}

// ── ASIC firmware attestation: verify the device's firmware across multiple ──
// independent API commands to detect modified firmware.
// A patched firmware must consistently lie across all of: check, version, stats.
// If any endpoint reports a different model identity, the firmware is modified.
// Also checks compile time and firmware version for consistency.
async function verifyAsicFirmware(port, checkModel, _modelName) {
  const result = {
    ok: true,
    identities: [], // model strings reported by each API command
    compileTimes: [], // compile timestamps from each API command
    issues: [],
  };

  // Include the check command's reported model as the baseline identity.
  if (checkModel) {
    result.identities.push({ source: 'check.Type', value: checkModel });
  }

  // 1. Query the version command.
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'version' }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(to);
    }
    const json = await r.json();
    const versionRecord = json && json.VERSION && json.VERSION[0];
    if (versionRecord) {
      const type = String(versionRecord.Type || '').trim();
      const miner = String(versionRecord.Miner || '').trim();
      const compileTime = String(versionRecord.CompileTime || '').trim();
      if (type) result.identities.push({ source: 'version.Type', value: type });
      if (miner) result.identities.push({ source: 'version.Miner', value: miner });
      if (compileTime) result.compileTimes.push(compileTime);
    }
  } catch (_) {
    result.issues.push('version command failed');
  }

  // 2. Query the stats command.
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 10000);
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'stats' }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(to);
    }
    const json = await r.json();
    const statsRecords = json && json.STATS;
    if (Array.isArray(statsRecords) && statsRecords.length > 0) {
      // Skip the "STATS" summary record (id=0) — look at individual miner records.
      for (const rec of statsRecords) {
        if (rec && rec.id !== 0) {
          const type = String(rec.Type || '').trim();
          const miner = String(rec.Miner || '').trim();
          const compileTime = String(rec.CompileTime || '').trim();
          if (type) result.identities.push({ source: 'stats.Type', value: type });
          if (miner) result.identities.push({ source: 'stats.Miner', value: miner });
          if (compileTime) result.compileTimes.push(compileTime);
        }
      }
    }
  } catch (_) {
    result.issues.push('stats command failed');
  }

  // 3. Cross-reference identities across all sources.
  // If we have at least 2 identity reports, check they all agree.
  const identityValues = result.identities.map((i) => i.value);
  const uniqueIdentities = new Set(identityValues.map((v) => v.toLowerCase().replace(/\s+/g, ' ').trim()));
  if (identityValues.length >= 2 && uniqueIdentities.size > 1) {
    result.issues.push(
      `firmware model mismatch: conflicting identities [${[...new Set(identityValues)].join(', ')}]` +
        ` across check/version/stats API commands — firmware may be modified`,
    );
  }

  // 4. Check compile time is present.
  if (result.compileTimes.length === 0) {
    result.issues.push('no compile time reported — firmware info may be suppressed');
  }

  result.ok = result.issues.length === 0;
  return result;
}

// ── Hardware fingerprint & per-wallet benchmark history ──────────────────────
// The fingerprint records the CPU+memory descriptor from the first calibrated
// benchmark.  If the descriptor changes but the wallet stays the same,
// contributions are blocked until the user creates a new wallet — ensuring each
// wallet's benchmark history always belongs to exactly one physical machine.
//
// Benchmark history stores a rolling window of measured CPU/mem/GPU values per
// wallet address.  Once HISTORY_ENROLL_COUNT samples are collected, the personal
// mean replaces the generic hardware-table reference for calibration, giving each
// machine tighter and more accurate per-session tolerances.
const HW_FINGERPRINT_FILE_NAME = 'hw-fingerprint.json';
const BENCHMARK_HISTORY_FILE_NAME = 'benchmark-history.json';
const HISTORY_ENROLL_COUNT = 8; // samples before personal mean starts blending in
const HISTORY_MAX_SAMPLES = 20; // rolling window size

function getHwFingerprintPath() {
  return path.join(app.getPath('userData'), HW_FINGERPRINT_FILE_NAME);
}

function getBenchmarkHistoryPath() {
  return path.join(app.getPath('userData'), BENCHMARK_HISTORY_FILE_NAME);
}

function loadHwFingerprint() {
  try {
    const raw = fs.readFileSync(getHwFingerprintPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { sig, ...data } = parsed;
    if (sig) {
      const expected = computeHwAuthSig(data);
      if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
        console.warn('[hwFingerprint] Tampered fingerprint detected - ignoring.');
        return null;
      }
    }
    return data;
  } catch (_) {
    return null;
  }
}

function saveHwFingerprint(data) {
  try {
    const p = getHwFingerprintPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...data, sig: computeHwAuthSig(data) }), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function clearHwFingerprint() {
  try {
    fs.unlinkSync(getHwFingerprintPath());
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function normalizeGpuFingerprintValue(gpuModels) {
  if (!Array.isArray(gpuModels)) return [];
  return gpuModels
    .map((gpu) => String(gpu || '').trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function formatHardwareChangeList(previousDescriptor, nextDescriptor) {
  const changes = [];
  const previousCpu = String((previousDescriptor && previousDescriptor.cpuModel) || '').trim();
  const nextCpu = String((nextDescriptor && nextDescriptor.cpuModel) || '').trim();
  if (previousCpu !== nextCpu) {
    changes.push(`CPU: ${previousCpu || 'unknown'} -> ${nextCpu || 'unknown'}`);
  }

  const previousGpu = normalizeGpuFingerprintValue(previousDescriptor && previousDescriptor.gpuModels).filter(
    (g) => !isUnusableGpuIdentity(g),
  );
  const nextGpu = normalizeGpuFingerprintValue(nextDescriptor && nextDescriptor.gpuModels).filter(
    (g) => !isUnusableGpuIdentity(g),
  );
  if (previousGpu.join(' | ') !== nextGpu.join(' | ')) {
    changes.push(`GPU: ${previousGpu.join(', ') || 'unknown'} -> ${nextGpu.join(', ') || 'unknown'}`);
  }

  const previousMemType = String((previousDescriptor && previousDescriptor.memType) || '').trim();
  const nextMemType = String((nextDescriptor && nextDescriptor.memType) || '').trim();
  if (previousMemType !== nextMemType) {
    changes.push(`Memory type: ${previousMemType || 'unknown'} -> ${nextMemType || 'unknown'}`);
  }

  const previousMemSpeed = Number((previousDescriptor && previousDescriptor.memSpeedMhz) || 0);
  const nextMemSpeed = Number((nextDescriptor && nextDescriptor.memSpeedMhz) || 0);
  if (previousMemSpeed !== nextMemSpeed) {
    changes.push(`Memory speed: ${previousMemSpeed || 0} MHz -> ${nextMemSpeed || 0} MHz`);
  }

  const previousMemSticks = Number((previousDescriptor && previousDescriptor.memSticks) || 0);
  const nextMemSticks = Number((nextDescriptor && nextDescriptor.memSticks) || 0);
  if (previousMemSticks !== nextMemSticks) {
    changes.push(`Memory modules: ${previousMemSticks || 0} -> ${nextMemSticks || 0}`);
  }

  return changes;
}

function loadBenchmarkHistory() {
  const empty = { cpuSamples: [], memSamples: [], gpuSamples: [], jitterSamples: [] };
  try {
    const raw = fs.readFileSync(getBenchmarkHistoryPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return empty;
    const { sig, ...data } = parsed;
    if (sig) {
      const expected = computeHwAuthSig(data);
      if (!crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))) {
        console.warn('[benchmarkHistory] Tampered history - resetting.');
        return empty;
      }
    }
    return {
      cpuSamples: Array.isArray(data.cpuSamples) ? data.cpuSamples.map(Number).filter((v) => isFinite(v) && v > 0) : [],
      memSamples: Array.isArray(data.memSamples) ? data.memSamples.map(Number).filter((v) => isFinite(v) && v > 0) : [],
      gpuSamples: Array.isArray(data.gpuSamples) ? data.gpuSamples.map(Number).filter((v) => isFinite(v) && v > 0) : [],
      jitterSamples: Array.isArray(data.jitterSamples)
        ? data.jitterSamples.map(Number).filter((v) => isFinite(v) && v >= 0)
        : [],
    };
  } catch (_) {
    return empty;
  }
}

function saveBenchmarkHistory(history) {
  try {
    const p = getBenchmarkHistoryPath();
    const data = {
      cpuSamples: history.cpuSamples,
      memSamples: history.memSamples,
      gpuSamples: history.gpuSamples,
      jitterSamples: history.jitterSamples,
    };
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ ...data, sig: computeHwAuthSig(data) }), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function clearBenchmarkHistory() {
  try {
    fs.unlinkSync(getBenchmarkHistoryPath());
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

// Append a new sample to a rolling window, rejecting clear outliers.
// With fewer than 4 existing samples any value is accepted (insufficient history).
// Outlier rule: reject if > 2.5× or < 0.40× the current mean.
function appendBenchmarkSample(samples, newValue) {
  if (samples.length >= 4) {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    if (newValue > mean * 2.5 || newValue < mean * 0.4) {
      return samples; // outlier — reject without adding
    }
  }
  const updated = [...samples, newValue];
  return updated.length > HISTORY_MAX_SAMPLES ? updated.slice(updated.length - HISTORY_MAX_SAMPLES) : updated;
}

// Return a blended reference: before enrollment the hardware-table value dominates;
// at full enrollment (HISTORY_MAX_SAMPLES) the personal mean dominates entirely.
function getPersonalReference(samples, tableValue) {
  if (samples.length < HISTORY_ENROLL_COUNT || samples.length === 0) return tableValue;
  const personalMean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const blendFactor = Math.min(1.0, samples.length / HISTORY_MAX_SAMPLES);
  return tableValue > 0 ? tableValue * (1 - blendFactor) + personalMean * blendFactor : personalMean;
}

let startupTraceEnabled = false;
let startupTraceWindowMs = 180_000;
let startupTraceUntilMs = 0;

function getWalletDataDir() {
  return getDataDir();
}

function getStartupTraceFilePath() {
  return path.join(getWalletDataDir(), STARTUP_TRACE_FILE_NAME);
}

function isStartupTraceActive() {
  return startupTraceEnabled && Date.now() <= startupTraceUntilMs;
}

const STARTUP_TRACE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap to prevent unbounded growth

function writeStartupTrace(event, details = {}) {
  if (!startupTraceEnabled) return;
  const allowedOutsideWindow = event.startsWith('app.') || event.startsWith('startup.');
  if (!allowedOutsideWindow && !isStartupTraceActive()) return;
  try {
    const filePath = getStartupTraceFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Rotate (truncate) the file if it has grown past the size cap.
    try {
      const stat = fs.statSync(filePath);
      if (stat.size >= STARTUP_TRACE_MAX_BYTES) {
        fs.writeFileSync(filePath, '', 'utf8');
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      details,
    });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function beginStartupTrace(reason) {
  if (!startupTraceEnabled) return;
  startupTraceUntilMs = Date.now() + startupTraceWindowMs;
  writeStartupTrace('startup.trace-window-started', {
    reason,
    windowMs: startupTraceWindowMs,
  });
}

function _getCliCommandName(args = []) {
  for (const raw of args) {
    const token = String(raw || '').trim();
    if (!token || token.startsWith('-')) continue;
    if (token.includes('=')) continue;
    return token;
  }
  return '';
}

const roundLedger = createRoundLedger({
  baseDir: getWalletDataDir(),
  signingSecret: () => {
    try {
      return attestationState && attestationState.secret;
    } catch (_) {
      return null;
    }
  },
});
const LEDGER_NETWORK_BODY_MAX_BYTES = 64 * 1024;
const ROUND_CONTRIBUTION_MESSAGE_PREFIX = 'wtc-round-contribution-v1';
let ledgerNetworkServer = null;
let wtcNode = null; // WTC native chain node (initialized in app.whenReady)
let mineBlockBusy = false; // prevents concurrent mineBlock calls (IPC + flush loop)
let bundledSeedPeersCache = null;
let remoteSeedPeerRefreshTimer = null;

// ── Peer-mode UDP discovery ───────────────────────────────────────────────────
// Peers send a UDP beacon on PEER_DISCOVERY_PORT every 2 min so that nodes
// on the same subnet find each other without a hand-written peer list.
// Uses link-local multicast (TTL=1) instead of 255.255.255.255 broadcast
// to avoid triggering AV behaviour detection.
// Legacy `ledgerPeers` entries are treated as bootstrap seed peers, not as
// a separate static active-peer bucket.
const PEER_DISCOVERY_PORT = 39311;
const PEER_DISCOVERY_MCAST = '239.0.52.67'; // administratively-scoped multicast, LAN-only
const PEER_BEACON_INTERVAL_MS = 120_000; // 2 min — low-rate discovery
const PEER_STALE_THRESHOLD_MS = 5 * 60_000; // 5 min without beacon â†’ evict
const PEER_EXCHANGE_TARGET_LIMIT = 4;
const PEER_REACHABILITY_RETRY_MS = 2 * 60_000;
const PEER_REACHABILITY_SUCCESS_TTL_MS = 10 * 60_000;
const PEER_REACHABILITY_TIMEOUT_MS = 12_000;
const PEER_CHAIN_TIP_TIMEOUT_MS = 12_000;
const PEER_CHAIN_TIP_CACHE_MS = 3_000;
const PEER_LOCAL_SUBNET_DISCOVERY_TIMEOUT_MS = 1_200;
const PEER_LOCAL_SUBNET_DISCOVERY_CONCURRENCY = 24;
const PEER_LOCAL_SUBNET_DISCOVERY_MIN_INTERVAL_MS = 60_000;
const REVERSE_TUNNEL_CONNECT_TIMEOUT_MS = 30_000;
const REVERSE_TUNNEL_REQUEST_TIMEOUT_MS = 20_000;
const REVERSE_TUNNEL_MAX_PENDING = 64;
const ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS = 1_000;
const MIN_PROBE_VERIFIERS = 3;
const REVERSE_TUNNEL_RECONNECT_BASE_MS = 3_000;
const REVERSE_TUNNEL_RECONNECT_MAX_MS = 60_000;
const REVERSE_TUNNEL_PING_INTERVAL_MS = 20_000;
const REVERSE_TUNNEL_LIVE_THRESHOLD_MS = 90_000;
const AUTO_PUBLIC_IP_LOOKUP_TIMEOUT_MS = 4_000;
const AUTO_PUBLIC_IP_REFRESH_INTERVAL_MS = 60_000;
const REMOTE_SEED_MANIFEST_REFRESH_INTERVAL_MS = 5 * 60_000;
const REMOTE_SEED_MANIFEST_FETCH_TIMEOUT_MS = 5_000;
const DEFAULT_REMOTE_SEED_MANIFEST_URLS = [];
const AUTO_PUBLIC_IP_SERVICES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://ident.me'];
const DEPRECATED_PEER_ENDPOINTS = [
  { hostParts: ['91', '95', '15', '55'], port: 39310 },
  { hostParts: ['62', '65', '200', '145'], port: 39310 },
];
const DEPRECATED_PEER_URLS = new Set(
  DEPRECATED_PEER_ENDPOINTS.map(({ hostParts, port }) =>
    normalizePeerUrl(`http://${(hostParts || []).join('.')}:${port}`),
  ).filter(Boolean),
);
const DISCOVERED_SEED_PEER_CACHE_FILE_NAME = 'discovered-seed-peer-cache.json';
let peerDiscoverySocket = null;
let peerDiscoveryInterval = null;
let discoveredPeerCacheSaveTimer = null;
let peerLocalSubnetDiscoveryLastRunAt = 0;
let peerLocalSubnetDiscoveryPromise = null;
const discoveredPeers = new Map(); // url -> { lastSeenMs, source, sources, peerIdentity?, seenThisSession?, restoredFromCache? }
const peerReachabilityCache = new Map(); // url -> { lastAttemptAtMs, lastSuccessAtMs, ok }
const peerChainTipCache = new Map(); // peerUrl -> { expiresAtMs, value }
const peerChainTipInflight = new Map(); // peerUrl -> Promise
const pendingRoundContributionBroadcasts = new Map(); // key -> { peerUrl, payload, timer }
const witnessedProbeReceipts = new Map(); // workerAddress -> { maxChainIndex: number, receipts: Map<chainIndex, Map<verifierAddress, receipt>> }
const peerAttestationHistory = new Map(); // peerIdentity -> Map<otherPeerIdentity, lastAttestedMs>
const PEER_ATTESTATION_RECIPROCITY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
let peerCountInspectionPromise = null; // concurrency guard for wattcoin-get-peer-count
let peerCountCachedResult = null; // { expiresAtMs, value }
const PEER_COUNT_CACHE_TTL_MS = 8_000; // re-use recent inspection result for 8 s
const PEER_COUNT_PROBE_CONCURRENCY = 5; // probe up to 5 peers in parallel
const PEER_COUNT_PROBE_TIMEOUT_MS = 6_000; // shorter timeout for peer-count probes
const PEER_ATTESTATION_SELECTION_TIMEOUT_MS = 6_000; // attestation peer must be online now
const PEER_ATTESTATION_SELECTION_CONCURRENCY = 5;
let reverseTunnelWss = null;
const reverseTunnelSessions = new Map(); // tunnelId -> session
const reverseTunnelSessionsByPeerIdentity = new Map(); // peerIdentity -> session
const reverseTunnelPendingResponses = new Map(); // requestId -> { res, timer }
const reverseTunnelClientState = {
  socket: null,
  coordinatorUrl: '',
  publicUrl: '',
  tunnelId: '',
  connectedAtMs: 0,
  lastSeenAtMs: 0,
  reconnectDelayMs: REVERSE_TUNNEL_RECONNECT_BASE_MS,
  reconnectTimer: null,
  pingTimer: null,
  connecting: false,
  rotateCoordinatorOnNextAttempt: false,
};
let autoDetectedPublicPeerUrl = '';
let autoDetectedPublicPeerLookupPromise = null;
let autoPublicPeerRefreshTimer = null;
// blockHash â†’ { minedAddress, totalWh, rewardCoins, settledAtMs, sig, fromPeer }
const witnessedSettlements = new Map();

function getDiscoveredSeedPeerCachePath() {
  return path.join(app.getPath('userData'), DISCOVERED_SEED_PEER_CACHE_FILE_NAME);
}

function getRemoteSeedPeerCachePath() {
  return path.join(app.getPath('userData'), 'remote-seed-peers-cache.json');
}

const remoteSeedManifestManager = createRemoteSeedManifestManager({
  fs,
  getRuntimeConfig,
  getCachePath: getRemoteSeedPeerCachePath,
  normalizePeerUrl,
  isDeprecatedPeerUrl,
  requestExternalResponse,
  fetchTimeoutMs: REMOTE_SEED_MANIFEST_FETCH_TIMEOUT_MS,
  defaultRemoteSeedManifestUrls: DEFAULT_REMOTE_SEED_MANIFEST_URLS,
  schedulePeerSync: scheduleWtcPeerSync,
  logger: console,
});

function normalizePeerUrl(candidate) {
  try {
    const parsed = new URL(String(candidate || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port <= 1023) return '';
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
    return `${parsed.protocol}//${parsed.hostname}:${port}${pathname}`;
  } catch (_) {
    return '';
  }
}

function isDeprecatedPeerUrl(candidate) {
  const normalized = normalizePeerUrl(candidate);
  return normalized ? DEPRECATED_PEER_URLS.has(normalized) : false;
}

function normalizeIpLiteral(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutZone = raw.split('%')[0];
  if (withoutZone.startsWith('::ffff:')) {
    const mapped = withoutZone.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return mapped;
  }
  return withoutZone;
}

function isPrivateIpv4(host) {
  const normalized = normalizeIpLiteral(host);
  if (net.isIP(normalized) !== 4) return false;
  const octets = normalized.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  if (octets[0] === 0) return true;
  return false;
}

function isPrivateIpv6(host) {
  const normalized = normalizeIpLiteral(host).toLowerCase();
  if (net.isIP(normalized) !== 6) return false;
  return (
    normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')
  );
}

function isPublicPeerHost(host) {
  const normalized = normalizeIpLiteral(host).toLowerCase();
  if (!normalized || normalized === 'localhost') return false;
  const family = net.isIP(normalized);
  if (family === 4) return !isPrivateIpv4(normalized);
  if (family === 6) return !isPrivateIpv6(normalized);
  return false;
}

function isLoopbackPeerHost(host) {
  const normalized = normalizeIpLiteral(host).toLowerCase();
  if (!normalized) return false;
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function formatPeerHostForUrl(host) {
  const normalized = normalizeIpLiteral(host);
  if (!normalized) return '';
  return net.isIP(normalized) === 6 ? `[${normalized}]` : normalized;
}

function requestExternalResponse(url, timeoutMs = AUTO_PUBLIC_IP_LOOKUP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'wattcoin-miner/1.0 (public-ip-detect)',
          Accept: 'text/plain',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: Number(res.statusCode) || 0,
            contentType: String((res.headers && res.headers['content-type']) || '').trim(),
            body: Buffer.concat(chunks).toString('utf8').trim(),
          });
        });
        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      },
    );
    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('public ip lookup timeout'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function requestExternalText(url, timeoutMs = AUTO_PUBLIC_IP_LOOKUP_TIMEOUT_MS) {
  const response = await requestExternalResponse(url, timeoutMs);
  return response.body;
}

function _getRemoteSeedManifestUrls(settings = getLedgerNetworkSettings()) {
  return remoteSeedManifestManager.getRemoteSeedManifestUrls(settings);
}

function loadCachedRemoteSeedPeers() {
  return remoteSeedManifestManager.loadCachedRemoteSeedPeers();
}

function _saveCachedRemoteSeedPeers(peers) {
  return remoteSeedManifestManager.saveCachedRemoteSeedPeers(peers);
}

function _fetchRemoteSeedManifest(url) {
  return remoteSeedManifestManager.fetchRemoteSeedManifest(url);
}

function refreshRemoteSeedPeers(settings = getLedgerNetworkSettings(), { force = false } = {}) {
  return remoteSeedManifestManager.refreshRemoteSeedPeers(settings, { force });
}

function startRemoteSeedPeerRefresh(settings = getLedgerNetworkSettings()) {
  stopRemoteSeedPeerRefresh();
  if (!settings || getRuntimeConfig().network !== 'wtc-mainnet') return;
  // Fetch immediately on startup so fresh installs don't wait up to 5 minutes
  // for the remote manifest before getting valid seed peers.
  refreshRemoteSeedPeers(getLedgerNetworkSettings(), { force: true }).catch(() => {});
  remoteSeedPeerRefreshTimer = setInterval(() => {
    refreshRemoteSeedPeers(getLedgerNetworkSettings(), { force: true }).catch(() => {});
  }, REMOTE_SEED_MANIFEST_REFRESH_INTERVAL_MS);
}

function stopRemoteSeedPeerRefresh() {
  if (!remoteSeedPeerRefreshTimer) return;
  clearInterval(remoteSeedPeerRefreshTimer);
  remoteSeedPeerRefreshTimer = null;
}

function detectAutoPublicPeerUrl(settings = getLedgerNetworkSettings(), { force = false } = {}) {
  if (!settings || !settings.enabled || settings.mode !== 'peer') {
    autoDetectedPublicPeerUrl = '';
    return '';
  }
  if (getExplicitAdvertisedPeerUrls(settings).length > 0) {
    autoDetectedPublicPeerUrl = '';
    return '';
  }
  if (!force && autoDetectedPublicPeerUrl) {
    try {
      const cached = new URL(autoDetectedPublicPeerUrl);
      if (Number(cached.port) === Number(settings.listenPort)) return autoDetectedPublicPeerUrl;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    autoDetectedPublicPeerUrl = '';
  }
  if (autoDetectedPublicPeerLookupPromise) return autoDetectedPublicPeerLookupPromise;

  const previousUrl = autoDetectedPublicPeerUrl;

  autoDetectedPublicPeerLookupPromise = (async () => {
    for (const serviceUrl of AUTO_PUBLIC_IP_SERVICES) {
      try {
        const ipText = normalizeIpLiteral(await requestExternalText(serviceUrl));
        if (!isPublicPeerHost(ipText)) continue;
        const host = formatPeerHostForUrl(ipText);
        const peerUrl = normalizePeerUrl(`http://${host}:${settings.listenPort}`);
        if (!peerUrl) continue;
        autoDetectedPublicPeerUrl = peerUrl;
        return peerUrl;
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }
    return previousUrl || '';
  })().finally(() => {
    autoDetectedPublicPeerLookupPromise = null;
  });

  return autoDetectedPublicPeerLookupPromise;
}

async function refreshAutoPublicPeerUrl(settings = getLedgerNetworkSettings()) {
  if (!settings || !settings.enabled || settings.mode !== 'peer') return '';
  const previousUrl = autoDetectedPublicPeerUrl;
  const nextUrl = await detectAutoPublicPeerUrl(settings, { force: true });
  if (nextUrl && nextUrl !== previousUrl) {
    console.log(`[Wattcoin] Auto-detected public peer URL changed: ${nextUrl}`);
  }
  return nextUrl;
}

function startAutoPublicPeerUrlRefresh(settings = getLedgerNetworkSettings()) {
  stopAutoPublicPeerUrlRefresh();
  if (!settings || !settings.enabled || settings.mode !== 'peer') return;
  if (getExplicitAdvertisedPeerUrls(settings).length > 0) return;
  autoPublicPeerRefreshTimer = setInterval(() => {
    refreshAutoPublicPeerUrl(getLedgerNetworkSettings()).catch(() => {});
  }, AUTO_PUBLIC_IP_REFRESH_INTERVAL_MS);
}

function stopAutoPublicPeerUrlRefresh() {
  if (!autoPublicPeerRefreshTimer) return;
  clearInterval(autoPublicPeerRefreshTimer);
  autoPublicPeerRefreshTimer = null;
}

function buildPeerUrlFromSocket(remoteAddress, listenPort, protocol = 'http:') {
  const port = Math.max(1, Number(listenPort) || 0);
  const host = formatPeerHostForUrl(remoteAddress);
  if (!host || !port) return '';
  return normalizePeerUrl(`${protocol}//${host}:${port}`);
}

function getLocalPeerHosts() {
  const hosts = new Set(['127.0.0.1', 'localhost']);
  try {
    const interfaces = os.networkInterfaces() || {};
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry && entry.family === 'IPv4' && entry.address) {
          hosts.add(String(entry.address));
        }
      }
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  return hosts;
}

function getLocalPeerIpv4Interfaces() {
  const addresses = new Set();
  for (const entry of getLocalPeerIpv4InterfaceEntries()) {
    addresses.add(entry.address);
  }
  return Array.from(addresses);
}

function getLocalPeerIpv4InterfaceEntries() {
  const entries = [];
  try {
    const interfaces = os.networkInterfaces() || {};
    for (const interfaceEntries of Object.values(interfaces)) {
      for (const entry of interfaceEntries || []) {
        if (!entry || entry.family !== 'IPv4' || !entry.address || entry.internal) continue;
        entries.push({
          address: String(entry.address),
          netmask: String(entry.netmask || ''),
          internal: !!entry.internal,
        });
      }
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  return entries;
}

function isSelfPeerUrl(candidate) {
  const normalized = normalizePeerUrl(candidate);
  if (!normalized) return false;
  try {
    const settings = getLedgerNetworkSettings();
    const selfAdvertisedUrls = getConfiguredAdvertisedPeerUrls(settings);
    return isSelfPeerUrlCandidate(normalized, {
      selfAdvertisedUrls,
      listenPort: settings.listenPort,
      localHosts: Array.from(getLocalPeerHosts()),
    });
  } catch (_) {
    return false;
  }
}

function isPeerIdentitySelfReference(peerIdentity, peerUrl) {
  const normalizedIdentity = String(peerIdentity || '').trim();
  const localPeerIdentity = getLocalPeerIdentity();
  if (!normalizedIdentity || !localPeerIdentity || normalizedIdentity !== localPeerIdentity) {
    return false;
  }
  return isSelfPeerUrl(peerUrl);
}

function isLocallyServedReverseTunnelPeerUrl(candidate, settings = getLedgerNetworkSettings()) {
  const normalized = normalizePeerUrl(candidate);
  if (!normalized || !isReverseTunnelPeerUrl(normalized)) return false;
  try {
    const parsed = new URL(normalized);
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (port !== Number(settings && settings.listenPort)) return false;
    const segments = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean);
    const tunnelId = segments.length >= 4 ? String(segments[3] || '').trim() : '';
    if (!tunnelId) return false;
    const session = reverseTunnelSessions.get(tunnelId);
    if (!session || !session.publicUrl) return false;
    return normalizePeerUrl(session.publicUrl) === normalized;
  } catch (_) {
    return false;
  }
}

function resolvePeerRequestBaseUrl(baseUrl, settings = getLedgerNetworkSettings()) {
  try {
    const normalized = normalizePeerUrl(baseUrl && baseUrl.href ? baseUrl.href : baseUrl);
    if (!normalized || !isLocallyServedReverseTunnelPeerUrl(normalized, settings)) {
      return baseUrl;
    }
    const localBase = new URL(normalized);
    localBase.protocol = 'http:';
    localBase.hostname = '127.0.0.1';
    localBase.port = String(Math.max(1, Number(settings && settings.listenPort) || 0));
    return localBase;
  } catch (_) {
    return baseUrl;
  }
}

function getConfiguredAdvertisedPeerUrls(settings = getLedgerNetworkSettings()) {
  const candidates = [
    reverseTunnelClientState.publicUrl,
    settings && settings.tunnelPublicUrl,
    settings && settings.publicUrl,
    autoDetectedPublicPeerUrl,
    ...((settings && settings.advertiseUrls) || []),
  ];
  return filterAdvertisedPeerUrls(candidates);
}

function getPrimaryAdvertisedPeerUrl(settings = getLedgerNetworkSettings()) {
  const urls = getConfiguredAdvertisedPeerUrls(settings);
  return urls.length > 0 ? urls[0] : '';
}

function getExplicitAdvertisedPeerUrls(settings = getLedgerNetworkSettings()) {
  const candidates = [
    settings && settings.publicUrl,
    settings && settings.tunnelPublicUrl,
    ...((settings && settings.advertiseUrls) || []),
  ];
  return filterAdvertisedPeerUrls(candidates);
}

function buildPeerAnnouncementHeaders(settings = getLedgerNetworkSettings()) {
  const advertisedUrls = getConfiguredAdvertisedPeerUrls(settings);
  return {
    'x-wtc-peer-port': String(Math.max(1, Number(settings && settings.listenPort) || 39310)),
    'x-wtc-peer-urls': advertisedUrls.join(','),
  };
}

function extractReachablePeerCandidates(req, settings = getLedgerNetworkSettings()) {
  const announcedUrls = String(req.headers['x-wtc-peer-urls'] || '')
    .split(',')
    .map((entry) => normalizePeerUrl(entry))
    .filter(Boolean);
  const declaredPort = Math.max(
    1,
    Number(req.headers['x-wtc-peer-port']) || Number(settings && settings.listenPort) || 0,
  );
  const inferredSocketUrl = buildPeerUrlFromSocket(req.socket && req.socket.remoteAddress, declaredPort);
  return sortPeerUrlsByPreference(
    [...announcedUrls, inferredSocketUrl].filter((candidate) => candidate && !isSelfPeerUrl(candidate)),
  );
}

function shouldAttemptPeerReachability(candidate, nowMs = Date.now()) {
  const normalized = normalizePeerUrl(candidate);
  if (!normalized || isPeerUrlBanned(normalized) || isSelfPeerUrl(normalized)) return false;
  const cached = peerReachabilityCache.get(normalized);
  if (!cached) return true;
  if (cached.ok && nowMs - Number(cached.lastSuccessAtMs || 0) < PEER_REACHABILITY_SUCCESS_TTL_MS) return false;
  return nowMs - Number(cached.lastAttemptAtMs || 0) >= PEER_REACHABILITY_RETRY_MS;
}

function scheduleDiscoveredSeedPeerCacheSave() {
  if (!app.isReady()) return;
  if (discoveredPeerCacheSaveTimer) clearTimeout(discoveredPeerCacheSaveTimer);
  discoveredPeerCacheSaveTimer = setTimeout(() => {
    discoveredPeerCacheSaveTimer = null;
    try {
      const now = Date.now();
      const peers = [];
      for (const [url, info] of discoveredPeers.entries()) {
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

function rememberDiscoveredPeer(
  peerUrl,
  { source = 'peer-exchange', seenAtMs = Date.now(), quiet = false, peerIdentity = '' } = {},
) {
  const normalized = normalizePeerUrl(peerUrl);
  if (!normalized || isDeprecatedPeerUrl(normalized) || isSelfPeerUrl(normalized) || isPeerUrlBanned(normalized))
    return false;

  const existing = discoveredPeers.get(normalized);
  const effectiveSource = String(source || (existing && existing.source) || 'peer-exchange');
  const effectivePeerIdentity = String(peerIdentity || (existing && existing.peerIdentity) || '').trim();
  const seenThisSession = effectiveSource !== 'seed-cache';
  const sources = new Set(Array.isArray(existing && existing.sources) ? existing.sources : []);
  sources.add(effectiveSource);

  const next = {
    lastSeenMs: Math.max(Number(seenAtMs) || 0, existing && existing.lastSeenMs ? existing.lastSeenMs : 0),
    source: effectiveSource,
    ...(effectivePeerIdentity ? { peerIdentity: effectivePeerIdentity } : {}),
    seenThisSession: Boolean((existing && existing.seenThisSession) || seenThisSession),
    restoredFromCache: Boolean(existing && existing.restoredFromCache) && !seenThisSession,
    sources: Array.from(sources).sort(),
  };
  const isNew = !existing;
  const changed =
    isNew ||
    next.lastSeenMs !== existing.lastSeenMs ||
    next.source !== existing.source ||
    String(next.peerIdentity || '') !== String((existing && existing.peerIdentity) || '') ||
    Boolean(next.seenThisSession) !== Boolean(existing && existing.seenThisSession) ||
    Boolean(next.restoredFromCache) !== Boolean(existing && existing.restoredFromCache) ||
    JSON.stringify(next.sources) !== JSON.stringify(existing.sources || []);

  discoveredPeers.set(normalized, next);
  if (isNew && !quiet) {
    console.log(`[PeerDiscovery] Found peer via ${next.source}: ${obfuscatePublicPeerUrl(normalized)}`);
  }
  if (changed) scheduleDiscoveredSeedPeerCacheSave();
  if (isNew && effectiveSource !== 'seed-cache') scheduleWtcPeerSync(`new-peer:${effectiveSource}`);
  return isNew;
}

function forgetDiscoveredPeer(peerUrl) {
  const normalized = normalizePeerUrl(peerUrl);
  if (!normalized) return false;
  const removed = discoveredPeers.delete(normalized);
  if (removed) scheduleDiscoveredSeedPeerCacheSave();
  return removed;
}

function forgetPeerUrlState(peerUrl) {
  const normalized = normalizePeerUrl(peerUrl);
  if (!normalized) return false;
  const removed = forgetDiscoveredPeer(normalized);
  peerReachabilityCache.delete(normalized);
  peerChainTipCache.delete(normalized);
  peerChainTipInflight.delete(normalized);
  peerUrlFailures.delete(normalized);
  return removed;
}

function forgetDiscoveredPeersByIdentity(peerIdentity, { keepUrl = '' } = {}) {
  const normalizedIdentity = String(peerIdentity || '').trim();
  if (!normalizedIdentity) return 0;
  const normalizedKeepUrl = normalizePeerUrl(keepUrl);
  let removed = 0;
  for (const [peerUrl, info] of discoveredPeers.entries()) {
    if (String((info && info.peerIdentity) || '').trim() !== normalizedIdentity) continue;
    if (normalizedKeepUrl && peerUrl === normalizedKeepUrl) continue;
    discoveredPeers.delete(peerUrl);
    removed += 1;
  }
  if (removed > 0) scheduleDiscoveredSeedPeerCacheSave();
  return removed;
}

function isReverseTunnelPeerUrl(peerUrl) {
  const normalized = normalizePeerUrl(peerUrl);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    return parsed.pathname.startsWith('/api/v1/tunnel/');
  } catch (_) {
    return false;
  }
}

function extractTunnelIdFromUrl(peerUrl) {
  try {
    const parsed = new URL(peerUrl);
    const segments = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean);
    // URL pattern: /api/v1/tunnel/<tunnelId>
    return segments.length >= 4 ? decodeURIComponent(segments[3]) : '';
  } catch (_) {
    return '';
  }
}

/**
 * Returns liveness info for a locally-served reverse-tunnel peer,
 * or null if the URL is not a live local tunnel peer.
 * Passed to WtcNode so readiness / sync queries can skip HTTP round-trips.
 */
function getLocalTunnelPeerLiveness(peerUrl) {
  const settings = getLedgerNetworkSettings();
  if (!isLocallyServedReverseTunnelPeerUrl(peerUrl, settings)) return null;
  const tunnelId = extractTunnelIdFromUrl(peerUrl);
  const session = tunnelId ? reverseTunnelSessions.get(tunnelId) : null;
  if (
    session &&
    session.socket &&
    session.socket.readyState === WebSocket.OPEN &&
    Date.now() - Number(session.lastSeenAtMs || 0) <= REVERSE_TUNNEL_LIVE_THRESHOLD_MS
  ) {
    return { live: true, peerIdentity: String(session.peerIdentity || '').trim() };
  }
  return null;
}

async function getOnlineAttestationPeers(settings = getLedgerNetworkSettings(), localWorkerId = '') {
  const localWorkerKey = String(localWorkerId || '').trim();
  const peers = getActivePeers(settings);
  const distinctPeerKeys = new Set();
  const onlinePeers = [];
  const httpPeers = [];

  for (const peerUrl of peers) {
    const liveTunnel = getLocalTunnelPeerLiveness(peerUrl);
    if (liveTunnel && liveTunnel.live) {
      const peerIdentity = String(liveTunnel.peerIdentity || '').trim();
      if (isPeerIdentitySelfReference(peerIdentity, peerUrl)) continue;
      if (localWorkerKey && peerIdentity && hasRecentPeerAttestationRelation(localWorkerKey, peerIdentity)) continue;
      const peerKey = peerIdentity || normalizePeerUrl(peerUrl);
      if (distinctPeerKeys.has(peerKey)) continue;
      distinctPeerKeys.add(peerKey);
      onlinePeers.push(peerUrl);
      continue;
    }

    httpPeers.push(peerUrl);
  }

  const probePeer = async (peerUrl) => {
    try {
      const tip = await requestPeerJson(peerUrl, 'GET', '/api/v1/chain/tip', undefined, undefined, {
        timeoutMs: PEER_ATTESTATION_SELECTION_TIMEOUT_MS,
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'peer-probe-select',
      });
      if (!tip || !tip.ok) return;
      const peerIdentity = String((tip && tip.peerIdentity) || '').trim();
      if (isPeerIdentitySelfReference(peerIdentity, peerUrl)) return;
      if (localWorkerKey && peerIdentity && hasRecentPeerAttestationRelation(localWorkerKey, peerIdentity)) return;
      const peerKey = getPeerIdentityKey(peerUrl, tip);
      if (distinctPeerKeys.has(peerKey)) return;
      distinctPeerKeys.add(peerKey);
      onlinePeers.push(peerUrl);
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  };

  for (let index = 0; index < httpPeers.length; index += PEER_ATTESTATION_SELECTION_CONCURRENCY) {
    const batch = httpPeers.slice(index, index + PEER_ATTESTATION_SELECTION_CONCURRENCY);
    await Promise.all(batch.map(probePeer));
  }

  return onlinePeers;
}

function pruneDiscoveredPeers(nowMs = Date.now()) {
  let changed = false;
  for (const [url, info] of discoveredPeers.entries()) {
    if (!info || nowMs - Number(info.lastSeenMs || 0) > PEER_STALE_THRESHOLD_MS || isPeerUrlBanned(url)) {
      discoveredPeers.delete(url);
      changed = true;
    }
  }
  if (changed) scheduleDiscoveredSeedPeerCacheSave();
  return changed;
}

function clearStalePeerAttestationHistory(nowMs = Date.now()) {
  for (const [peerIdentity, relations] of peerAttestationHistory.entries()) {
    if (!relations || relations.size === 0) {
      peerAttestationHistory.delete(peerIdentity);
      continue;
    }
    for (const [otherIdentity, ts] of relations.entries()) {
      if (nowMs - Number(ts || 0) > PEER_ATTESTATION_RECIPROCITY_WINDOW_MS) {
        relations.delete(otherIdentity);
      }
    }
    if (!relations.size) peerAttestationHistory.delete(peerIdentity);
  }
}

function recordPeerAttestation(verifierAddress, workerId) {
  const verifierIdentity = String(verifierAddress || '').trim();
  const workerIdentity = String(workerId || '').trim();
  if (!verifierIdentity || !workerIdentity || verifierIdentity === workerIdentity) return;
  const nowMs = Date.now();
  if (!peerAttestationHistory.has(verifierIdentity)) {
    peerAttestationHistory.set(verifierIdentity, new Map());
  }
  peerAttestationHistory.get(verifierIdentity).set(workerIdentity, nowMs);
}

function hasRecentPeerAttestationRelation(peerA, peerB, nowMs = Date.now()) {
  const a = String(peerA || '').trim();
  const b = String(peerB || '').trim();
  if (!a || !b || a === b) return false;
  clearStalePeerAttestationHistory(nowMs);
  const aRelations = peerAttestationHistory.get(a);
  if (aRelations && aRelations.has(b)) return true;
  const bRelations = peerAttestationHistory.get(b);
  if (bRelations && bRelations.has(a)) return true;
  return false;
}

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
          if (normalized && discoveredPeers.has(normalized)) {
            const current = discoveredPeers.get(normalized);
            discoveredPeers.set(normalized, {
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
        if (normalized && discoveredPeers.has(normalized)) {
          const current = discoveredPeers.get(normalized);
          discoveredPeers.set(normalized, {
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

function buildAdvertisedPeerList(settings) {
  const peers = [];
  const seen = new Set();
  const localPeerIdentity = getLocalPeerIdentity();
  const addPeer = (peerUrl, source, lastSeenMs = Date.now(), { allowSelf = false, peerIdentity = '' } = {}) => {
    const normalized = normalizePeerUrl(peerUrl);
    if (!normalized || seen.has(normalized) || (!allowSelf && isSelfPeerUrl(normalized)) || isPeerUrlBanned(normalized))
      return;
    seen.add(normalized);
    const normalizedIdentity = String(peerIdentity || '').trim();
    peers.push({
      url: normalized,
      source,
      lastSeenMs,
      ...(normalizedIdentity ? { peerIdentity: normalizedIdentity } : {}),
    });
  };

  for (const peerUrl of getConfiguredAdvertisedPeerUrls(settings)) {
    addPeer(peerUrl, 'public', Date.now(), { allowSelf: true, peerIdentity: localPeerIdentity });
  }
  for (const peerUrl of (settings && settings.configuredPeers) || []) addPeer(peerUrl, 'configured');
  for (const peerUrl of (settings && settings.seedPeers) || []) addPeer(peerUrl, 'seed');
  for (const [peerUrl, info] of discoveredPeers.entries()) {
    addPeer(peerUrl, (info && info.source) || 'peer-exchange', (info && info.lastSeenMs) || Date.now(), {
      peerIdentity: String((info && info.peerIdentity) || '').trim(),
    });
  }
  return peers.slice(0, 64);
}

function getLedgerListenUrls(settings) {
  const explicitUrls = getConfiguredAdvertisedPeerUrls(settings);
  if (explicitUrls.length > 0) {
    return explicitUrls;
  }

  const { networkInterfaces } = require('os');
  const ifaces = networkInterfaces();
  const addresses = Object.values(ifaces)
    .flat()
    .filter((info) => info && info.family === 'IPv4' && !info.internal)
    .map((info) => `http://${info.address}:${settings.listenPort}`);

  if (addresses.length === 0) {
    addresses.push(`http://127.0.0.1:${settings.listenPort}`);
  }

  return Array.from(new Set(addresses.map(normalizePeerUrl).filter(Boolean)));
}

async function verifyReachablePeerCandidate(candidate, source = 'peer-contact') {
  const normalized = normalizePeerUrl(candidate);
  if (!normalized) return { ok: false, reason: 'invalid-url' };
  const nowMs = Date.now();
  if (!shouldAttemptPeerReachability(normalized, nowMs)) {
    const cached = peerReachabilityCache.get(normalized);
    // Even when returning a cached result, refresh the peer's lastSeenMs while we
    // know it is reachable.  Without this, a LAN peer whose keepalive beacons are
    // filtered (same-NAT shared public IP) would silently expire after the
    // PEER_STALE_THRESHOLD_MS window even though connectivity is fine.
    if (cached && cached.ok) {
      rememberDiscoveredPeer(normalized, { source, quiet: true });
    }
    return {
      ok: Boolean(cached && cached.ok),
      cached: true,
      source,
    };
  }

  peerReachabilityCache.set(normalized, {
    lastAttemptAtMs: nowMs,
    lastSuccessAtMs: 0,
    ok: false,
  });

  try {
    const tip = await requestPeerJson(normalized, 'GET', '/api/v1/chain/tip', undefined, undefined, {
      timeoutMs: PEER_REACHABILITY_TIMEOUT_MS,
      suppressPeerDiscovery: true,
      source,
    });
    const localHeight = wtcNode && typeof wtcNode.getHeight === 'function' ? Number(wtcNode.getHeight()) : Number.NaN;
    const remoteHeight = Number(tip && tip.height);
    peerReachabilityCache.set(normalized, {
      lastAttemptAtMs: nowMs,
      lastSuccessAtMs: Date.now(),
      ok: true,
    });
    rememberDiscoveredPeer(normalized, { source, quiet: true });
    if (Number.isFinite(remoteHeight) && Number.isFinite(localHeight) && remoteHeight > localHeight) {
      scheduleWtcPeerSync(`${source}-higher-tip`, 150);
    }
    return { ok: true, remoteHeight, source };
  } catch (error) {
    peerReachabilityCache.set(normalized, {
      lastAttemptAtMs: nowMs,
      lastSuccessAtMs: 0,
      ok: false,
    });
    return {
      ok: false,
      source,
      reason: error && error.message ? error.message : 'reachability-check-failed',
    };
  }
}

function maybeRegisterReachableRequester(req, settings, source = 'peer-contact') {
  return maybeRegisterReachableRequesterHelper(req, settings, source, {
    isReverseTunnelForwardedRequest,
    rememberObservedRequester,
    extractReachablePeerCandidates,
    isPublicPeerHost,
    verifyReachablePeerCandidate,
  });
}

function rememberObservedRequester(req, settings, source = 'peer-presence') {
  const candidates = extractReachablePeerCandidates(req, settings);
  const peerIdentity = getTrustedRequesterPeerIdentity(req, settings);
  let observed = false;
  let preferredPeerUrl = '';
  for (const candidate of candidates) {
    preferredPeerUrl = selectPreferredPeerUrl(preferredPeerUrl, candidate);
    observed =
      rememberDiscoveredPeer(candidate, {
        source,
        quiet: true,
        peerIdentity,
      }) || observed;
  }
  if (peerIdentity && preferredPeerUrl) {
    forgetDiscoveredPeersByIdentity(peerIdentity, { keepUrl: preferredPeerUrl });
  }
  return observed;
}

function readRequestBodyBuffer(req, maxBytes = LEDGER_NETWORK_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function buildReverseTunnelPublicUrl(baseUrl, tunnelId) {
  try {
    const base = new URL(baseUrl);
    const prefix = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/+$/, '') : '';
    return normalizePeerUrl(`${base.origin}${prefix}/api/v1/tunnel/${encodeURIComponent(tunnelId)}`);
  } catch (_) {
    return '';
  }
}

function getReverseTunnelCoordinatorBaseUrl(req, settings = getLedgerNetworkSettings()) {
  const advertisedUrls = getConfiguredAdvertisedPeerUrls(settings);
  const publicAdvertisedUrl = advertisedUrls.find((candidate) => {
    try {
      const parsed = new URL(candidate);
      return isPublicPeerHost(parsed.hostname) && !parsed.pathname.startsWith('/api/v1/tunnel/');
    } catch (_) {
      return false;
    }
  });
  if (publicAdvertisedUrl) return publicAdvertisedUrl;
  const host = String((req && req.headers && req.headers.host) || '').trim();
  if (!host) return '';
  return normalizePeerUrl(`http://${host}`);
}

function buildReverseTunnelCoordinatorCandidates(settings = getLedgerNetworkSettings()) {
  const candidates = [];
  for (const peerUrl of getPeerDirectoryTargets(settings)) {
    try {
      const parsed = new URL(peerUrl);
      if (!isPublicPeerHost(parsed.hostname)) continue;
      if (parsed.pathname && parsed.pathname !== '/') continue;
      candidates.push(normalizePeerUrl(peerUrl));
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function chooseReverseTunnelCoordinator(settings = getLedgerNetworkSettings()) {
  const configuredCoordinator = normalizePeerUrl(settings && settings.coordinatorUrl);
  if (configuredCoordinator) return configuredCoordinator;
  const candidates = buildReverseTunnelCoordinatorCandidates(settings);
  if (candidates.length === 0) return '';
  if (!reverseTunnelClientState.rotateCoordinatorOnNextAttempt) {
    return candidates[0];
  }
  const previousCoordinator = normalizePeerUrl(reverseTunnelClientState.coordinatorUrl);
  const previousIndex = previousCoordinator ? candidates.indexOf(previousCoordinator) : -1;
  if (previousIndex < 0) return candidates[0];
  return candidates[(previousIndex + 1) % candidates.length];
}

function shouldUseManagedReverseTunnel(settings = getLedgerNetworkSettings()) {
  if (!settings || !settings.enabled || settings.mode !== 'peer') return false;
  return getExplicitAdvertisedPeerUrls(settings).length === 0;
}

function cleanupReverseTunnelPendingRequest(requestId) {
  const pending = reverseTunnelPendingResponses.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  reverseTunnelPendingResponses.delete(requestId);
}

function failReverseTunnelPendingRequestsForSession(session, reason = 'Reverse tunnel disconnected.') {
  for (const [requestId, pending] of reverseTunnelPendingResponses.entries()) {
    if (!pending || pending.tunnelId !== session.tunnelId) continue;
    cleanupReverseTunnelPendingRequest(requestId);
    if (!pending.res.headersSent) {
      sendJson(pending.res, 502, { ok: false, code: 'REVERSE_TUNNEL_DOWN', message: reason });
    }
  }
}

function destroyReverseTunnelSession(session, reason = 'closed') {
  if (!session) return;
  reverseTunnelSessions.delete(session.tunnelId);
  if (session.peerIdentity) {
    const mapped = reverseTunnelSessionsByPeerIdentity.get(session.peerIdentity);
    if (mapped === session) {
      reverseTunnelSessionsByPeerIdentity.delete(session.peerIdentity);
    }
  }
  if (reason === 'replaced' || reason === 'stopped') {
    forgetDiscoveredPeer(session.publicUrl);
  } else if (session.publicUrl) {
    rememberDiscoveredPeer(session.publicUrl, {
      source: 'managed-tunnel',
      quiet: true,
      seenAtMs: Math.max(0, Number(session.lastSeenAtMs) || Date.now()),
      peerIdentity: session.peerIdentity || '',
    });
    scheduleWtcPeerSync(`managed-reverse-tunnel-${reason}`, 150);
  }
  failReverseTunnelPendingRequestsForSession(session, `Reverse tunnel ${reason}.`);
  try {
    clearInterval(session.pingTimer);
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  try {
    session.socket.close();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function getReverseTunnelPeerIdentity(req) {
  const headerValue = String(req && req.headers ? req.headers['x-wtc-peer-identity'] || '' : '').trim();
  return isValidPeerIdentity(headerValue) ? headerValue : '';
}

function isReverseTunnelForwardedRequest(req) {
  const marker = String(req && req.headers ? req.headers['x-wtc-via-tunnel'] || '' : '').trim();
  if (marker !== '1') return false;
  return isLoopbackPeerHost(req && req.socket ? req.socket.remoteAddress : '');
}

function handleReverseTunnelResponseMessage(session, message) {
  const requestId = String((message && message.requestId) || '').trim();
  const pending = reverseTunnelPendingResponses.get(requestId);
  if (!pending || pending.tunnelId !== session.tunnelId) return;
  cleanupReverseTunnelPendingRequest(requestId);
  const statusCode = Math.max(100, Number(message && message.statusCode) || 500);
  const headers =
    message && typeof message.headers === 'object' && message.headers
      ? message.headers
      : { 'content-type': 'application/json; charset=utf-8' };
  const bodyBuffer =
    message && message.bodyBase64 ? Buffer.from(String(message.bodyBase64), 'base64') : Buffer.alloc(0);
  pending.res.writeHead(statusCode, headers);
  pending.res.end(bodyBuffer);
}

function handleReverseTunnelSocketMessage(session, rawMessage) {
  let message = null;
  try {
    message = JSON.parse(String(rawMessage || ''));
  } catch (_) {
    return;
  }
  if (!message || typeof message !== 'object') return;
  session.lastSeenAtMs = Date.now();
  if (session.publicUrl) {
    // Aggressively refresh lastSeenMs for tunnel peers on every tunnel message
    rememberDiscoveredPeer(session.publicUrl, {
      source: 'managed-tunnel',
      quiet: true,
      seenAtMs: session.lastSeenAtMs,
      peerIdentity: session.peerIdentity || '',
    });
  }
  if (message.type === 'pong' || message.type === 'ping' || message.type === 'tunnel-ready') {
    // Also refresh on tunnel-ready and ping
    if (session.publicUrl) {
      rememberDiscoveredPeer(session.publicUrl, {
        source: 'managed-tunnel',
        quiet: true,
        seenAtMs: Date.now(),
        peerIdentity: session.peerIdentity || '',
      });
    }
    return;
  }
  if (message.type === 'http-response') {
    handleReverseTunnelResponseMessage(session, message);
  }
}

async function handleReverseTunnelHttpRequest(req, res, _settings) {
  const segments = String(req.url || '')
    .split('?')[0]
    .split('/')
    .filter(Boolean);
  const tunnelId = segments[3] ? decodeURIComponent(segments[3]) : '';
  const session = reverseTunnelSessions.get(tunnelId);
  if (!session || session.socket.readyState !== WebSocket.OPEN) {
    sendJson(res, 502, { ok: false, code: 'REVERSE_TUNNEL_UNAVAILABLE', message: 'Tunnel session unavailable.' });
    return true;
  }
  if (reverseTunnelPendingResponses.size >= REVERSE_TUNNEL_MAX_PENDING) {
    sendJson(res, 503, { ok: false, code: 'REVERSE_TUNNEL_BUSY', message: 'Tunnel is temporarily busy.' });
    return true;
  }
  const proxiedPath = `/${segments.slice(4).join('/')}${new URL(req.url || '/', 'http://127.0.0.1').search}`;
  if (!proxiedPath.startsWith('/api/v1/')) {
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Ledger endpoint not found.' });
    return true;
  }
  const requestId = crypto.randomBytes(12).toString('hex');
  const bodyBuffer = await readRequestBodyBuffer(req);
  const forwardedHeaders = {
    'content-type': String(req.headers['content-type'] || 'application/json; charset=utf-8'),
    'x-wtc-network-id': String(req.headers['x-wtc-network-id'] || ''),
    'x-wtc-protocol-version': String(req.headers['x-wtc-protocol-version'] || ''),
    'x-wtc-genesis-hash': String(req.headers['x-wtc-genesis-hash'] || ''),
    'x-wtc-peer-identity': String(req.headers['x-wtc-peer-identity'] || ''),
    'x-wtc-peer-port': String(req.headers['x-wtc-peer-port'] || ''),
    'x-wtc-peer-urls': String(req.headers['x-wtc-peer-urls'] || ''),
    'x-wtc-via-tunnel': '1',
    'x-wattcoin-ledger-token': String(req.headers['x-wattcoin-ledger-token'] || ''),
  };
  reverseTunnelPendingResponses.set(requestId, {
    tunnelId,
    res,
    timer: setTimeout(() => {
      cleanupReverseTunnelPendingRequest(requestId);
      if (!res.headersSent) {
        sendJson(res, 504, { ok: false, code: 'REVERSE_TUNNEL_TIMEOUT', message: 'Reverse tunnel request timed out.' });
      }
    }, REVERSE_TUNNEL_REQUEST_TIMEOUT_MS),
  });
  session.socket.send(
    JSON.stringify({
      type: 'http-request',
      requestId,
      method: String(req.method || 'GET').toUpperCase(),
      path: proxiedPath,
      headers: forwardedHeaders,
      bodyBase64: bodyBuffer.toString('base64'),
    }),
  );
  return true;
}

function startReverseTunnelCoordinator(settings = getLedgerNetworkSettings()) {
  if (!ledgerNetworkServer || reverseTunnelWss) return;
  reverseTunnelWss = new WebSocketServer({ noServer: true });
  reverseTunnelWss.on('connection', (socket, req) => {
    const tunnelId = crypto.randomBytes(16).toString('hex');
    const coordinatorBaseUrl = getReverseTunnelCoordinatorBaseUrl(req, settings);
    const publicUrl = buildReverseTunnelPublicUrl(coordinatorBaseUrl, tunnelId);
    const peerIdentity = getReverseTunnelPeerIdentity(req);
    // Reject self-connecting tunnels — the seed peer should not tunnel to itself.
    const localPeerIdentity = getLocalPeerIdentity();
    if (peerIdentity && localPeerIdentity && peerIdentity === localPeerIdentity) {
      console.log(`[ReverseTunnel] Rejecting self-connecting tunnel from ${peerIdentity}`);
      try {
        socket.close();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      return;
    }
    if (peerIdentity) {
      const previousSession = reverseTunnelSessionsByPeerIdentity.get(peerIdentity);
      if (previousSession) {
        console.log(`[ReverseTunnel] Replacing stale tunnel session for ${peerIdentity}`);
        destroyReverseTunnelSession(previousSession, 'replaced');
      }
    }
    const session = {
      tunnelId,
      publicUrl,
      peerIdentity,
      socket,
      connectedAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
      pingTimer: setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        try {
          socket.send(JSON.stringify({ type: 'ping', nowMs: Date.now() }));
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
      }, REVERSE_TUNNEL_PING_INTERVAL_MS),
    };
    reverseTunnelSessions.set(tunnelId, session);
    if (peerIdentity) {
      reverseTunnelSessionsByPeerIdentity.set(peerIdentity, session);
    }
    rememberDiscoveredPeer(publicUrl, {
      source: 'managed-tunnel',
      quiet: true,
      peerIdentity,
    });
    if (peerIdentity) {
      forgetDiscoveredPeersByIdentity(peerIdentity, { keepUrl: publicUrl });
    }
    socket.on('message', (message) => handleReverseTunnelSocketMessage(session, message));
    socket.on('close', () => destroyReverseTunnelSession(session, 'closed'));
    socket.on('error', () => destroyReverseTunnelSession(session, 'errored'));
    socket.send(JSON.stringify({ type: 'tunnel-ready', tunnelId, publicUrl }));
    // Immediately query the new tunnel peer for its peer directory so the seed
    // peer discovers the rest of the network faster.
    refreshPeerDirectory(getLedgerNetworkSettings()).catch(() => {});
  });
  ledgerNetworkServer.on('upgrade', (req, socket, head) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      if (reqUrl.pathname !== '/api/v1/tunnel/connect') {
        socket.destroy();
        return;
      }
      const compat = verifyChainPeerCompatibility(req);
      if (!compat.ok) {
        console.warn(
          `[ReverseTunnel] Rejected upgrade from ${(req.socket && req.socket.remoteAddress) || 'unknown'}: ${compat.reason}`,
        );
        socket.destroy();
        return;
      }
      reverseTunnelWss.handleUpgrade(req, socket, head, (ws) => {
        reverseTunnelWss.emit('connection', ws, req);
      });
    } catch (_) {
      try {
        socket.destroy();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  });
}

function stopReverseTunnelCoordinator() {
  for (const session of reverseTunnelSessions.values()) {
    destroyReverseTunnelSession(session, 'stopped');
  }
  reverseTunnelSessions.clear();
  for (const requestId of Array.from(reverseTunnelPendingResponses.keys())) {
    cleanupReverseTunnelPendingRequest(requestId);
  }
  if (reverseTunnelWss) {
    try {
      reverseTunnelWss.close();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    reverseTunnelWss = null;
  }
}

function stopManagedReverseTunnelClient() {
  reverseTunnelClientState.connecting = false;
  reverseTunnelClientState.publicUrl = '';
  reverseTunnelClientState.tunnelId = '';
  reverseTunnelClientState.coordinatorUrl = '';
  reverseTunnelClientState.connectedAtMs = 0;
  reverseTunnelClientState.lastSeenAtMs = 0;
  reverseTunnelClientState.reconnectDelayMs = REVERSE_TUNNEL_RECONNECT_BASE_MS;
  if (reverseTunnelClientState.reconnectTimer) {
    clearTimeout(reverseTunnelClientState.reconnectTimer);
    reverseTunnelClientState.reconnectTimer = null;
  }
  if (reverseTunnelClientState.pingTimer) {
    clearInterval(reverseTunnelClientState.pingTimer);
    reverseTunnelClientState.pingTimer = null;
  }
  if (reverseTunnelClientState.socket) {
    try {
      reverseTunnelClientState.socket.close();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    reverseTunnelClientState.socket = null;
  }
}

function scheduleManagedReverseTunnelReconnect() {
  if (reverseTunnelClientState.reconnectTimer) return;
  const delayMs = reverseTunnelClientState.reconnectDelayMs;
  reverseTunnelClientState.rotateCoordinatorOnNextAttempt = true;
  reverseTunnelClientState.reconnectTimer = setTimeout(() => {
    reverseTunnelClientState.reconnectTimer = null;
    ensureManagedReverseTunnelClient();
  }, delayMs);
  reverseTunnelClientState.reconnectDelayMs = Math.min(
    REVERSE_TUNNEL_RECONNECT_MAX_MS,
    Math.max(REVERSE_TUNNEL_RECONNECT_BASE_MS, delayMs * 2),
  );
}

function buildReverseTunnelConnectUrl(coordinatorUrl) {
  try {
    const base = new URL(coordinatorUrl);
    const prefix = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/+$/, '') : '';
    return `${base.origin}${prefix}/api/v1/tunnel/connect`;
  } catch (_) {
    return '';
  }
}

function sanitizeForwardedTunnelHeaders(headers = {}) {
  const nextHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === '') continue;
    if (/^(content-type|x-wtc-|x-wattcoin-ledger-token)/i.test(key)) {
      nextHeaders[key] = String(value);
    }
  }
  return nextHeaders;
}

async function forwardReverseTunnelRequestToLocalNode(socket, message) {
  const settings = getLedgerNetworkSettings();
  const targetPath = String((message && message.path) || '/').trim() || '/';
  const method = String((message && message.method) || 'GET').toUpperCase();
  const requestId = String((message && message.requestId) || '').trim();
  const bodyBuffer =
    message && message.bodyBase64 ? Buffer.from(String(message.bodyBase64), 'base64') : Buffer.alloc(0);
  const forwardedHeaders = sanitizeForwardedTunnelHeaders(message && message.headers);
  const protocolInfo = getPeerProtocolInfo();
  const requestOptions = {
    method,
    hostname: '127.0.0.1',
    port: settings.listenPort,
    path: targetPath,
    timeout: REVERSE_TUNNEL_REQUEST_TIMEOUT_MS,
    headers: {
      ...forwardedHeaders,
      'Content-Length': Buffer.byteLength(bodyBuffer),
      'x-wtc-network-id': forwardedHeaders['x-wtc-network-id'] || protocolInfo.networkId,
      'x-wtc-protocol-version': forwardedHeaders['x-wtc-protocol-version'] || String(protocolInfo.protocolVersion),
      ...(protocolInfo.genesisHash && !forwardedHeaders['x-wtc-genesis-hash']
        ? { 'x-wtc-genesis-hash': protocolInfo.genesisHash }
        : {}),
    },
  };
  const responsePayload = await new Promise((resolve) => {
    const request = http.request(requestOptions, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          statusCode: Number(response.statusCode) || 500,
          headers: { 'content-type': String(response.headers['content-type'] || 'application/json; charset=utf-8') },
          bodyBase64: Buffer.concat(chunks).toString('base64'),
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('Local reverse tunnel request timed out.')));
    request.on('error', (error) => {
      resolve({
        statusCode: 502,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        bodyBase64: Buffer.from(
          JSON.stringify({
            ok: false,
            code: 'REVERSE_TUNNEL_LOCAL_ERROR',
            message: error && error.message ? error.message : 'Local reverse tunnel request failed.',
          }),
          'utf8',
        ).toString('base64'),
      });
    });
    request.write(bodyBuffer);
    request.end();
  });
  try {
    socket.send(JSON.stringify({ type: 'http-response', requestId, ...responsePayload }));
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function handleManagedReverseTunnelMessage(socket, rawMessage) {
  let message = null;
  try {
    message = JSON.parse(String(rawMessage || ''));
  } catch (_) {
    return;
  }
  if (!message || typeof message !== 'object') return;
  reverseTunnelClientState.lastSeenAtMs = Date.now();
  if (message.type === 'ping') {
    try {
      socket.send(JSON.stringify({ type: 'pong', nowMs: Date.now() }));
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    return;
  }
  if (message.type === 'tunnel-ready') {
    const previousPublicUrl = normalizePeerUrl(reverseTunnelClientState.publicUrl);
    reverseTunnelClientState.tunnelId = String(message.tunnelId || '');
    reverseTunnelClientState.publicUrl = normalizePeerUrl(message.publicUrl);
    if (previousPublicUrl && previousPublicUrl !== reverseTunnelClientState.publicUrl) {
      forgetPeerUrlState(previousPublicUrl);
    }
    reverseTunnelClientState.connectedAtMs = Date.now();
    reverseTunnelClientState.lastSeenAtMs = Date.now();
    reverseTunnelClientState.reconnectDelayMs = REVERSE_TUNNEL_RECONNECT_BASE_MS;
    writeStartupTrace('reverse-tunnel.ready', {
      tunnelId: reverseTunnelClientState.tunnelId,
      publicUrl: obfuscatePublicPeerUrl(reverseTunnelClientState.publicUrl),
      coordinatorUrl: obfuscatePublicPeerUrl(reverseTunnelClientState.coordinatorUrl),
    });
    console.log(
      `[ReverseTunnel] Reachable via ${obfuscatePublicPeerUrl(reverseTunnelClientState.publicUrl) || 'managed tunnel'}; awaiting a higher compatible peer chain before sync import.`,
    );
    scheduleWtcPeerSync('managed-reverse-tunnel-ready', 150);
    return;
  }
  if (message.type === 'http-request') {
    forwardReverseTunnelRequestToLocalNode(socket, message).catch(() => {});
  }
}

function connectManagedReverseTunnelClient(coordinatorUrl, settings = getLedgerNetworkSettings()) {
  const connectUrl = buildReverseTunnelConnectUrl(coordinatorUrl);
  if (!connectUrl) {
    writeStartupTrace('reverse-tunnel.connect-skipped', {
      reason: 'missing-connect-url',
      coordinatorUrl,
    });
    return false;
  }
  const protocolInfo = getPeerProtocolInfo();
  const localPeerIdentity = getLocalPeerIdentity();
  const headers = {
    ...buildPeerAnnouncementHeaders(settings),
    'x-wtc-network-id': protocolInfo.networkId,
    'x-wtc-protocol-version': String(protocolInfo.protocolVersion),
    ...(localPeerIdentity ? { 'x-wtc-peer-identity': localPeerIdentity } : {}),
    ...(protocolInfo.genesisHash ? { 'x-wtc-genesis-hash': protocolInfo.genesisHash } : {}),
  };
  writeStartupTrace('reverse-tunnel.connecting', {
    coordinatorUrl,
    connectUrl,
    peerIdentity: localPeerIdentity,
    networkId: protocolInfo.networkId,
    protocolVersion: protocolInfo.protocolVersion,
    genesisHash: protocolInfo.genesisHash,
    peerUrls: String(headers['x-wtc-peer-urls'] || ''),
  });
  reverseTunnelClientState.connecting = true;
  reverseTunnelClientState.coordinatorUrl = coordinatorUrl;
  let socket;
  try {
    socket = new WebSocket(connectUrl, { headers, handshakeTimeout: REVERSE_TUNNEL_CONNECT_TIMEOUT_MS });
  } catch (_) {
    reverseTunnelClientState.connecting = false;
    writeStartupTrace('reverse-tunnel.connect-failed', {
      coordinatorUrl,
      connectUrl,
      reason: 'websocket-constructor-failed',
    });
    scheduleManagedReverseTunnelReconnect();
    return false;
  }
  reverseTunnelClientState.socket = socket;
  socket.on('open', () => {
    reverseTunnelClientState.connecting = false;
    writeStartupTrace('reverse-tunnel.open', {
      coordinatorUrl,
      connectUrl,
    });
    reverseTunnelClientState.pingTimer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify({ type: 'pong', nowMs: Date.now() }));
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }, REVERSE_TUNNEL_PING_INTERVAL_MS);
  });
  socket.on('message', (message) => handleManagedReverseTunnelMessage(socket, message));
  socket.on('close', () => {
    writeStartupTrace('reverse-tunnel.closed', {
      coordinatorUrl,
      connectUrl,
    });
    if (reverseTunnelClientState.socket === socket) {
      stopManagedReverseTunnelClient();
      scheduleManagedReverseTunnelReconnect();
    }
  });
  socket.on('error', (error) => {
    writeStartupTrace('reverse-tunnel.error', {
      coordinatorUrl,
      connectUrl,
      message: error && error.message ? error.message : String(error || ''),
    });
    if (reverseTunnelClientState.socket === socket) {
      stopManagedReverseTunnelClient();
      scheduleManagedReverseTunnelReconnect();
    }
  });
  return true;
}

function ensureManagedReverseTunnelClient(settings = getLedgerNetworkSettings()) {
  if (!shouldUseManagedReverseTunnel(settings)) {
    writeStartupTrace('reverse-tunnel.disabled', {
      enabled: Boolean(settings && settings.enabled),
      mode: settings && settings.mode,
      explicitAdvertisedPeerUrls: getExplicitAdvertisedPeerUrls(settings),
    });
    stopManagedReverseTunnelClient();
    return;
  }
  if (reverseTunnelClientState.socket || reverseTunnelClientState.connecting) return;
  const coordinatorUrl = chooseReverseTunnelCoordinator(settings);
  if (!coordinatorUrl) {
    writeStartupTrace('reverse-tunnel.connect-skipped', {
      reason: 'missing-coordinator-url',
    });
    scheduleManagedReverseTunnelReconnect();
    return;
  }
  // Do not tunnel to ourselves — seed peer is its own coordinator.
  if (isSelfPeerUrl(coordinatorUrl) || isLocallyServedReverseTunnelPeerUrl(coordinatorUrl, settings)) {
    writeStartupTrace('reverse-tunnel.connect-skipped', {
      reason: 'coordinator-is-self',
      coordinatorUrl: obfuscatePublicPeerUrl(coordinatorUrl),
    });
    return;
  }
  // Also skip if the coordinator resolves to a local interface IP + our listen port,
  // which covers the case where autoDetectedPublicPeerUrl is not yet resolved.
  try {
    const coordParsed = new URL(coordinatorUrl);
    const coordPort = Number(coordParsed.port || (coordParsed.protocol === 'https:' ? 443 : 80));
    if (coordPort === Number(settings.listenPort) && getLocalPeerHosts().has(coordParsed.hostname)) {
      writeStartupTrace('reverse-tunnel.connect-skipped', {
        reason: 'coordinator-is-local',
        coordinatorUrl: obfuscatePublicPeerUrl(coordinatorUrl),
      });
      return;
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  writeStartupTrace('reverse-tunnel.enabled', {
    coordinatorUrl: obfuscatePublicPeerUrl(coordinatorUrl),
  });
  reverseTunnelClientState.rotateCoordinatorOnNextAttempt = false;
  connectManagedReverseTunnelClient(coordinatorUrl, settings);
}

function getPeerDiscoverySnapshot(settings = getLedgerNetworkSettings()) {
  return buildPeerDiscoverySnapshot({
    settings,
    discoveredEntries: Array.from(discoveredPeers.entries()).map(([url, info]) => ({ url, info })),
    staleThresholdMs: PEER_STALE_THRESHOLD_MS,
    isPeerUrlBanned,
    transformUrl: obfuscatePublicPeerUrl,
  });
}

function getPeerPrivacySecret() {
  try {
    const secret = getDeviceIdentitySecret();
    if (secret) return resolvePeerPrivacySecret(secret);
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  try {
    const identity = loadOrCreateDeviceIdentity();
    return resolvePeerPrivacySecret(getDeviceIdentitySecret(), identity && identity.deviceId);
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  return '';
}

function obfuscatePublicPeerUrl(peerUrl) {
  return obfuscatePeerUrl(peerUrl, getPeerPrivacySecret());
}

function pickPeerExchangeTargets(peerUrls, limit = PEER_EXCHANGE_TARGET_LIMIT) {
  const candidates = Array.from(new Set((peerUrls || []).map(normalizePeerUrl).filter(Boolean)));
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  return candidates.slice(0, Math.max(0, Number(limit) || 0));
}

async function refreshPeerDirectory(settings = getLedgerNetworkSettings()) {
  if (!settings || !settings.enabled || settings.mode !== 'peer') return;
  const peers = pickPeerExchangeTargets(getPeerDirectoryTargets(settings));
  for (const peerUrl of peers) {
    try {
      const response = await requestPeerJson(peerUrl, 'GET', '/api/v1/network/peers', undefined, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'peer-directory',
      });
      rememberDiscoveredPeer(peerUrl, { source: 'peer-directory', quiet: true });
      const advertised = Array.isArray(response && response.peers) ? response.peers : [];
      const preferredPeerUrlsByIdentity = new Map();
      for (const entry of advertised) {
        const candidate = typeof entry === 'string' ? entry : String(entry && entry.url ? entry.url : '');
        const peerIdentity = typeof entry === 'string' ? '' : String((entry && entry.peerIdentity) || '').trim();
        rememberDiscoveredPeer(candidate, { source: 'peer-directory', quiet: true, peerIdentity });
        if (peerIdentity) {
          const preferredPeerUrl = preferredPeerUrlsByIdentity.get(peerIdentity) || '';
          preferredPeerUrlsByIdentity.set(peerIdentity, selectPreferredPeerUrl(preferredPeerUrl, candidate));
        }
      }
      for (const [peerIdentity, keepUrl] of preferredPeerUrlsByIdentity.entries()) {
        forgetDiscoveredPeersByIdentity(peerIdentity, { keepUrl });
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }
}

const OPS_METRICS_FILE_NAME = 'ops-metrics.json';
const OPS_METRICS_SAMPLE_MS = 30_000;
const OPS_ALERT_COOLDOWN_MS = 5 * 60_000;
const OPS_WINDOW_MS = 60 * 60_000;
const CHAIN_STALL_ALERT_MS = 20 * 60_000;
const PEER_FAILURE_WINDOW_MS = 10 * 60_000;
const PEER_FAILURE_BAN_THRESHOLD = 8;
const PEER_IDENTITY_BAN_MS = 30 * 60_000;
const PEER_URL_BAN_MS = 30 * 60_000;

const bannedPeerIdentities = new Map(); // identity -> { untilMs, reason }
const bannedPeerUrls = new Map(); // peerUrl -> { untilMs, reason }
const peerIdentityFailures = new Map(); // identity -> number[] timestamps
const peerUrlFailures = new Map(); // peerUrl -> number[] timestamps

let opsMetricsTimer = null;
const opsState = {
  lastTipHash: '',
  lastTipTimestamp: 0,
  blockIntervalsSec: [],
  rollbackDepths: [],
  forkMismatchTimestamps: [],
  syncLagSamples: [],
  lastSyncResult: null,
  lastSyncAttemptAt: 0,
  peerRequestOkTimestamps: [],
  peerRequestFailTimestamps: [],
  alerts: [],
  alertCooldownUntil: new Map(),
  latestSnapshot: null,
};

const ATTESTATION_DB_FILE_NAME = 'attestation-state.json';
const ATTESTATION_PROFILE_CACHE_FILE_NAME = 'attestation-profile-cache.json';
const ATTESTATION_CHALLENGE_TTL_MS = 2 * 60_000;
const ATTESTATION_REPLAY_WINDOW_MS = 12 * 60 * 60_000;
const ATTESTATION_MAX_LEVEL = 10;
const ATTESTATION_REATTEST_MIN_MS = 2 * 60 * 60_000;
const ATTESTATION_REATTEST_MAX_MS = 4 * 60 * 60_000;
const ATTESTATION_SPOTCHECK_MIN_GAP_MS = 30 * 60_000;
const ATTESTATION_SPOTCHECK_DURATION_MS = 20 * 60_000;
const POLICY_FEED_REFRESH_MS = 15 * 60_000;
const ENABLE_NODE_ATTESTATION = true;
const ENABLE_POWER_PROOF_COMMITMENT = true;
// OP_RETURN prefix for on-chain policy anchors — 'WTCP1:' + 64-char SHA-256 hex = 70 bytes.
const _POLICY_OPRETURN_PREFIX = 'WTCP1:';

const LOCAL_HARDWARE_PROFILE_DB = [
  {
    id: 'desktop-high',
    match: (descriptor) =>
      /4090|4080|3090|3080|7900|6900|6800/i.test(descriptor.gpu) ||
      /i9|ryzen\s*9|threadripper|epyc|xeon/i.test(descriptor.cpu),
    conservativeCapW: 130,
    maxCapW: 520,
    stepW: 35,
    minCpuOpsPerSec: 260_000,
    minMemoryMBps: 800,
    requireGpuProof: true,
    spotCheckProbability: 0.08,
  },
  {
    id: 'desktop-mid',
    match: (descriptor) => /desktop|pc|server/i.test(descriptor.deviceType),
    conservativeCapW: 95,
    maxCapW: 360,
    stepW: 25,
    minCpuOpsPerSec: 170_000,
    minMemoryMBps: 650,
    requireGpuProof: true,
    spotCheckProbability: 0.06,
  },
  {
    id: 'laptop',
    match: (descriptor) => /laptop|notebook/i.test(descriptor.deviceType),
    conservativeCapW: 45,
    maxCapW: 130,
    stepW: 10,
    minCpuOpsPerSec: 120_000,
    minMemoryMBps: 500,
    requireGpuProof: false,
    spotCheckProbability: 0.04,
  },
  {
    id: 'fallback',
    match: () => true,
    conservativeCapW: 70,
    maxCapW: 220,
    stepW: 15,
    minCpuOpsPerSec: 100_000,
    minMemoryMBps: 450,
    requireGpuProof: false,
    spotCheckProbability: 0.05,
  },
];

const activeAttestationChallenges = new Map();
const consumedBenchmarkProofs = new Map();

const CONSUMED_PROOFS_FILE_NAME = 'consumed-proofs.json';
function getConsumedProofsFilePath() {
  return path.join(app.getPath('userData'), CONSUMED_PROOFS_FILE_NAME);
}

function loadConsumedProofs() {
  try {
    const raw = fs.readFileSync(getConsumedProofsFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    // Verify HMAC integrity — same pattern as hw-auth-state.json and benchmark-history.json.
    const { _sig, ...data } = parsed;
    if (_sig) {
      const expected = computeHwAuthSig(data);
      if (!crypto.timingSafeEqual(Buffer.from(String(_sig), 'utf8'), Buffer.from(expected, 'utf8'))) {
        console.warn('[ConsumedProofs] Tampered consumed-proofs.json detected - resetting replay cache.');
        return;
      }
    }
    const cutoff = Date.now() - ATTESTATION_REPLAY_WINDOW_MS;
    for (const [key, atMs] of Object.entries(data)) {
      if (typeof atMs === 'number' && atMs > cutoff) {
        consumedBenchmarkProofs.set(key, atMs);
      }
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function saveConsumedProofs() {
  try {
    const filePath = getConsumedProofsFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const obj = {};
    for (const [key, atMs] of consumedBenchmarkProofs.entries()) {
      obj[key] = atMs;
    }
    // HMAC-sign before writing so tampering (e.g. clearing the file to bypass replay
    // detection) is caught on the next load.
    const sig = computeHwAuthSig(obj);
    fs.writeFileSync(filePath, JSON.stringify({ ...obj, _sig: sig }), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}
let remoteProfileFeed = {
  profiles: null,
  rawProfiles: null,
  source: 'local',
  fetchedAtMs: 0,
  expiresAtMs: 0,
  version: 0,
};
let remoteProfileFeedRefreshTimer = null;

// ── On-chain policy anchor state ─────────────────────────────────────────────
// Persisted across restarts so the app doesn't rescan the full chain every launch.
const POLICY_ANCHOR_CACHE_FILE = 'policy-anchor-cache.json';
let policyAnchorState = { latestAnchor: null, lastScannedHeight: -1, scannedAtMs: 0 };

function getPolicyAnchorCacheFilePath() {
  return path.join(getWalletDataDir(), POLICY_ANCHOR_CACHE_FILE);
}

function loadPolicyAnchorState() {
  try {
    const raw = fs.readFileSync(getPolicyAnchorCacheFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      policyAnchorState = {
        latestAnchor: parsed.latestAnchor || null,
        lastScannedHeight: Number(parsed.lastScannedHeight) || -1,
        scannedAtMs: Number(parsed.scannedAtMs) || 0,
      };
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function _savePolicyAnchorState() {
  try {
    const fp = getPolicyAnchorCacheFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(policyAnchorState, null, 2), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function getAttestationDbFilePath() {
  return path.join(getWalletDataDir(), ATTESTATION_DB_FILE_NAME);
}

function getAttestationProfileCacheFilePath() {
  return path.join(getWalletDataDir(), ATTESTATION_PROFILE_CACHE_FILE_NAME);
}

function getEffectiveHardwareProfiles() {
  return Array.isArray(remoteProfileFeed.profiles) && remoteProfileFeed.profiles.length > 0
    ? remoteProfileFeed.profiles
    : LOCAL_HARDWARE_PROFILE_DB;
}

function parseRegexSafe(pattern) {
  if (!pattern || typeof pattern !== 'string') return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (_) {
    return null;
  }
}

function normalizeRemoteProfile(entry = {}) {
  const id = String(entry.id || '').trim();
  if (!id) return null;
  const deviceTypeRe = parseRegexSafe(String(entry.deviceTypeRegex || ''));
  const cpuRe = parseRegexSafe(String(entry.cpuRegex || ''));
  const gpuRe = parseRegexSafe(String(entry.gpuRegex || ''));
  const conservativeCapW = Math.max(10, Number(entry.conservativeCapW) || 0);
  const maxCapW = Math.max(conservativeCapW, Number(entry.maxCapW) || conservativeCapW);
  const stepW = Math.max(1, Number(entry.stepW) || 10);
  const minCpuOpsPerSec = Math.max(10_000, Number(entry.minCpuOpsPerSec) || 100_000);
  const minMemoryMBps = Math.max(100, Number(entry.minMemoryMBps) || 400);
  const requireGpuProof = !!entry.requireGpuProof;
  const spotCheckProbability = Math.min(0.5, Math.max(0, Number(entry.spotCheckProbability) || 0.05));

  return {
    id,
    match: (descriptor) => {
      const typeOk = !deviceTypeRe || deviceTypeRe.test(String(descriptor.deviceType || ''));
      const cpuOk = !cpuRe || cpuRe.test(String(descriptor.cpu || ''));
      const gpuOk = !gpuRe || gpuRe.test(String(descriptor.gpu || ''));
      return typeOk && cpuOk && gpuOk;
    },
    conservativeCapW,
    maxCapW,
    stepW,
    minCpuOpsPerSec,
    minMemoryMBps,
    requireGpuProof,
    spotCheckProbability,
  };
}

function verifyPolicyFeedEnvelope(envelope, publicKeyPem) {
  if (!envelope || typeof envelope !== 'object') return false;
  const policy = envelope.policy && typeof envelope.policy === 'object' ? envelope.policy : null;
  const signatureBase64 = String(envelope.signature || '');
  if (!policy || !signatureBase64 || !publicKeyPem) return false;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(JSON.stringify(policy));
    verifier.end();
    return verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch (_) {
    return false;
  }
}

function _fetchJsonWithTimeout(url, timeoutMs = 5000) {
  return fetchTextWithTimeout(url, timeoutMs).then((text) => JSON.parse(text));
}

function fetchTextWithTimeout(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    try {
      const client = String(url).toLowerCase().startsWith('https:') ? https : http;
      const req = client.get(url, { timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
        const chunks = [];
        let totalBytes = 0;
        const FETCH_MAX_BYTES = 1 * 1024 * 1024; // 1 MB cap — policy feeds should never exceed this
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > FETCH_MAX_BYTES) {
            req.destroy(new Error('policy feed response exceeded 1 MB size limit'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            const status = Number(res.statusCode) || 0;
            const raw = Buffer.concat(chunks).toString('utf8');
            if (status < 200 || status >= 300) {
              reject(new Error(`policy feed HTTP ${status}`));
              return;
            }
            resolve(raw);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('policy feed timeout'));
      });
    } catch (e) {
      reject(e);
    }
  });
}

// IPC proxy — routes renderer fetch() calls through Node's https module.
// Renderer-process fetch() uses Chromium's networking stack which enforces CORS.
// TechPowerUp spec pages, NotebookCheck HTML, and Reddit JSON don't send
// Access-Control-Allow-Origin headers, so every response body is blocked by CORS
// before the renderer can read it.  This handler has no CORS restrictions.
// Security: only the three whitelisted domains below are accepted; responses are
// capped at 5 MB; only https is allowed.
ipcMain.handle('wattcoin-fetch-url', (_event, payload) => {
  const ALLOWED_HOSTNAMES = new Set(['api.search.brave.com']);
  // Only these header names may be forwarded from the renderer to an external host.
  // Prevents a compromised renderer from injecting Host, Authorization, Cookie, etc.
  const ALLOWED_HEADER_NAMES = new Set(['accept', 'x-subscription-token', 'content-type']);
  const rawUrl = String((payload && payload.url) || '');
  const timeoutMs = Math.min(30_000, Math.max(1000, Number(payload && payload.timeoutMs) || 10_000));
  const rawHeaders = payload && typeof payload.headers === 'object' ? payload.headers : {};
  const customHeaders = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (ALLOWED_HEADER_NAMES.has(k.toLowerCase())) customHeaders[k] = String(v);
  }
  const method = payload && payload.method === 'POST' ? 'POST' : 'GET';
  const rawBody = method === 'POST' && payload && typeof payload.body === 'string' ? payload.body : null;

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (_) {
    return { ok: false, error: 'invalid url' };
  }
  if (parsedUrl.protocol !== 'https:') return { ok: false, error: 'only https allowed' };
  if (!ALLOWED_HOSTNAMES.has(parsedUrl.hostname)) {
    return { ok: false, error: `domain not allowed: ${parsedUrl.hostname}` };
  }

  return new Promise((resolve) => {
    try {
      const headers = {
        Accept: 'application/json',
        'User-Agent': 'wattcoin-miner/1.0 (power-lookup)',
        ...customHeaders,
      };
      if (rawBody) headers['Content-Length'] = Buffer.byteLength(rawBody);
      const reqOptions = {
        method,
        timeout: timeoutMs,
        headers,
      };
      const req = https.request(rawUrl, reqOptions, (res) => {
        const chunks = [];
        let totalBytes = 0;
        const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap
        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_BYTES) {
            req.destroy(new Error('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const status = Number(res.statusCode) || 0;
          if (status < 200 || status >= 300) {
            resolve({ ok: false, error: `HTTP ${status}` });
            return;
          }
          resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e && e.message ? e.message : 'request error' }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ ok: false, error: 'timeout' });
      });
      if (rawBody) req.write(rawBody);
      req.end();
    } catch (e) {
      resolve({ ok: false, error: e && e.message ? e.message : 'unexpected error' });
    }
  });
});

function loadCachedRemoteProfiles() {
  const filePath = getAttestationProfileCacheFilePath();
  try {
    if (!fs.existsSync(filePath)) return;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const profiles = Array.isArray(parsed && parsed.profiles)
      ? parsed.profiles.map(normalizeRemoteProfile).filter(Boolean)
      : [];
    const expiresAtMs = Number(parsed && parsed.expiresAtMs) || 0;
    if (profiles.length > 0 && expiresAtMs > Date.now()) {
      remoteProfileFeed = {
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

// Scan the local chain for the most recent WTCP1: OP_RETURN policy anchor.
// Incremental: on subsequent calls only scans new blocks since last scan.
function scanChainForPolicyAnchor() {
  loadPolicyAnchorState();
  return policyAnchorState.latestAnchor
    ? { ok: true, cached: true, ...policyAnchorState.latestAnchor }
    : { ok: false, code: 'POLICY_ANCHOR_NOT_FOUND' };
}

async function refreshRemoteProfilesFromPolicyFeed() {
  const runtime = getRuntimeConfig();
  const url = String(runtime.attestationPolicyFeedUrl || '').trim();
  const publicKeyPem = String(runtime.attestationPolicyFeedPublicKey || '').trim();
  if (!url) return { ok: false, code: 'POLICY_FEED_DISABLED' };

  try {
    // Download the policy JSON and its text (we hash the raw text for on-chain verification).
    const policyText = await fetchTextWithTimeout(url, 6000);
    let policyObj;
    try {
      policyObj = JSON.parse(policyText);
    } catch (_) {
      return { ok: false, code: 'POLICY_FEED_INVALID_JSON' };
    }

    // The policy object is either the raw policy (new format, used for on-chain hashing)
    // or wrapped in an envelope { policy, signature } (RSA format).
    // Detect envelope by checking for a .policy sub-object.
    const isEnvelope = policyObj && typeof policyObj.policy === 'object' && !Array.isArray(policyObj.policy);
    const policy = isEnvelope ? policyObj.policy : policyObj;
    if (!policy || !Array.isArray(policy.profiles)) {
      return { ok: false, code: 'POLICY_FEED_INVALID_JSON' };
    }

    // ── Tier 1: On-chain anchor verification (primary) ───────────────────────
    // Hash = SHA-256 of the canonical policy object (JSON.stringify without spaces).
    // For envelopes, hash the inner policy; for raw policy files, hash the whole thing.
    const hashTarget = isEnvelope ? JSON.stringify(policy) : policyText;
    const downloadedHash = crypto.createHash('sha256').update(hashTarget, 'utf8').digest('hex');
    const anchor = await scanChainForPolicyAnchor();
    if (anchor.ok) {
      if (anchor.hash !== downloadedHash) {
        console.warn(
          `[PolicyFeed] On-chain hash mismatch! Chain: ${anchor.hash.slice(0, 12)}... Downloaded: ${downloadedHash.slice(0, 12)}...`,
        );
        return { ok: false, code: 'POLICY_FEED_CHAIN_HASH_MISMATCH' };
      }
      console.log(`[PolicyFeed] Policy verified against on-chain anchor (block ${anchor.blockHeight}).`);
    } else {
      // ── Tier 2: RSA signature fallback (when no chain anchor published yet) ──
      if (publicKeyPem) {
        if (!isEnvelope || !verifyPolicyFeedEnvelope(policyObj, publicKeyPem)) {
          return { ok: false, code: 'POLICY_FEED_SIGNATURE_INVALID' };
        }
        console.log('[PolicyFeed] Policy verified via RSA signature (no chain anchor found).');
      } else {
        // Neither chain anchor nor RSA key — can't verify. Refuse and use local DB.
        console.warn('[PolicyFeed] No on-chain anchor and no RSA public key configured - using local profile DB.');
        return { ok: false, code: 'POLICY_FEED_UNVERIFIABLE' };
      }
    }

    const expiresAtMs = Math.max(Date.now() + 30 * 60_000, Number(policy.expiresAtMs) || 0);
    const normalizedProfiles = policy.profiles.map(normalizeRemoteProfile).filter(Boolean);
    if (normalizedProfiles.length === 0) {
      return { ok: false, code: 'POLICY_FEED_EMPTY' };
    }

    remoteProfileFeed = {
      profiles: normalizedProfiles,
      rawProfiles: Array.isArray(policy.profiles) ? policy.profiles : [],
      source: 'remote',
      fetchedAtMs: Date.now(),
      expiresAtMs,
      version: Number(policy.version) || 0,
    };
    saveRemoteProfilesToCache(remoteProfileFeed);
    return { ok: true, source: 'remote', count: normalizedProfiles.length };
  } catch (e) {
    return { ok: false, code: 'POLICY_FEED_FETCH_FAILED', message: e && e.message ? e.message : String(e) };
  }
}

function ensurePolicyFeedRefreshLoop() {
  if (remoteProfileFeedRefreshTimer) return;
  loadCachedRemoteProfiles();
  loadPolicyAnchorState();
  refreshRemoteProfilesFromPolicyFeed().catch(() => {});
  remoteProfileFeedRefreshTimer = setInterval(() => {
    refreshRemoteProfilesFromPolicyFeed().catch(() => {});
  }, POLICY_FEED_REFRESH_MS);
}

// ── Publish a policy anchor on-chain via OP_RETURN ────────────────────────────
// Operator usage: window.wattcoinHardware.invoke('wattcoin-publish-policy-anchor', jsonText)
// jsonText = the policy JSON string (same content that will be hosted at the feed URL).
ipcMain.handle('wattcoin-publish-policy-anchor', (_event, _policyText) => {
  return {
    ok: false,
    code: 'NOT_SUPPORTED',
    message: 'Policy anchor publishing is not supported on WTC native chain.',
  };
});

function defaultAttestationState() {
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString('hex'),
    miners: {},
  };
}

function loadAttestationState() {
  const filePath = getAttestationDbFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const parsed = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : null;
    let secret;
    if (parsed && typeof parsed.encryptedSecret === 'string' && parsed.encryptedSecret.length > 0) {
      // New format: decrypt using the OS secure store (DPAPI on Windows, Keychain on macOS).
      try {
        secret = safeStorage.decryptString(Buffer.from(parsed.encryptedSecret, 'base64'));
        if (!secret || secret.length < 32) throw new Error('decrypted secret too short');
      } catch (_) {
        // DPAPI failed (key rotation, different OS user/session, or headless env).
        // Try machine-derived fallback encryption before generating a brand-new secret,
        // so that reinstalling the OS user account does not lose the attestation state
        // as long as the device-identity.json secret is intact.
        let recovered = false;
        if (parsed && typeof parsed.fallbackEncryptedSecret === 'string') {
          try {
            const deviceSecret = getDeviceIdentitySecret();
            if (!deviceSecret || deviceSecret.length < 32) throw new Error('no device secret');
            const fbKey = crypto
              .createHash('sha256')
              .update(deviceSecret + ':attestation-fallback')
              .digest();
            const fbBuf = Buffer.from(parsed.fallbackEncryptedSecret, 'base64');
            const fbIv = fbBuf.slice(0, 12);
            const fbTag = fbBuf.slice(12, 28);
            const fbEnc = fbBuf.slice(28);
            const decipher = crypto.createDecipheriv('aes-256-gcm', fbKey, fbIv);
            decipher.setAuthTag(fbTag);
            secret = decipher.update(fbEnc).toString('utf8') + decipher.final('utf8');
            if (!secret || secret.length < 32) throw new Error('fallback secret too short');
            recovered = true;
          } catch (_fb) {
            console.warn('[AttestationState] Fallback decryption failed - generating new secret.');
          }
        }
        if (!recovered) {
          console.warn('[AttestationState] safeStorage decryption failed - generating new secret.');
          secret = crypto.randomBytes(32).toString('hex');
        }
      }
    } else if (parsed && typeof parsed.secret === 'string' && parsed.secret.length >= 32) {
      // Legacy plaintext secret — accepted once; re-saved encrypted on next saveAttestationState().
      secret = parsed.secret;
    } else {
      secret = crypto.randomBytes(32).toString('hex');
    }
    return {
      version: 1,
      secret,
      miners: parsed && parsed.miners && typeof parsed.miners === 'object' ? parsed.miners : {},
    };
  } catch (_) {
    return defaultAttestationState();
  }
}

// Replaced inside app.whenReady() once safeStorage is available for decryption.
let attestationState = defaultAttestationState();

function saveAttestationState() {
  const filePath = getAttestationDbFilePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = { version: attestationState.version, miners: attestationState.miners };
    if (safeStorage.isEncryptionAvailable()) {
      // Encrypt with OS secure store — plaintext secret never written to disk.
      payload.encryptedSecret = safeStorage.encryptString(attestationState.secret).toString('base64');
    }
    // Always write a machine-derived AES-256-GCM fallback (keyed by device-identity secret)
    // so the attestation secret can survive DPAPI key rotation or a headless session where
    // safeStorage is unavailable.  The secret is never written in plaintext.
    try {
      const deviceSecret = getDeviceIdentitySecret();
      if (deviceSecret && deviceSecret.length >= 32) {
        const fbKey = crypto
          .createHash('sha256')
          .update(deviceSecret + ':attestation-fallback')
          .digest();
        const fbIv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', fbKey, fbIv);
        const fbEnc = Buffer.concat([cipher.update(attestationState.secret, 'utf8'), cipher.final()]);
        const fbTag = cipher.getAuthTag();
        payload.fallbackEncryptedSecret = Buffer.concat([fbIv, fbTag, fbEnc]).toString('base64');
      }
    } catch (_fb) {
      /* non-fatal — primary DPAPI path is sufficient */
    }
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function normalizeMinerIdentity(minerId) {
  if (typeof minerId === 'string' && minerId.trim()) return minerId.trim().slice(0, 128);
  return 'local-client';
}

function normalizeHardwareDescriptor(summary = {}) {
  return {
    deviceType: String(summary && summary.deviceType ? summary.deviceType : '').trim(),
    cpu: String(summary && summary.cpu ? summary.cpu : '').trim(),
    gpu: String(summary && summary.gpu ? summary.gpu : '').trim(),
    memory: String(summary && summary.memory ? summary.memory : '').trim(),
  };
}

function shouldAllowGpuWorkloadsForSummary(summary = {}) {
  const descriptor = normalizeHardwareDescriptor(summary);
  if (/laptop|notebook|mini\s*pc/i.test(descriptor.deviceType)) return false;
  if (!descriptor.gpu) return true;
  if (/RTX|GTX|MX\d|Arc\s*(?:A|B)|Quadro|Tesla|Titan|GeForce|Radeon\s*(?:RX|Pro|VII)|FirePro/i.test(descriptor.gpu)) {
    return true;
  }
  if (
    /Intel.*(?:HD|UHD|Iris(?!\s*(?:Xe\s*Max|Pro))|Xe(?!\s*Max))|Radeon\(TM\)\s+Graphics|Radeon\s+Graphics|Vega\s*(?:3|5|6|7|8|10|11)|Mali|Adreno/i.test(
      descriptor.gpu,
    )
  ) {
    return false;
  }
  return true;
}

function resolveHardwareProfile(summary = {}) {
  const descriptor = normalizeHardwareDescriptor(summary);
  const profiles = getEffectiveHardwareProfiles();
  return profiles.find((profile) => profile.match(descriptor)) || profiles[profiles.length - 1];
}

function cleanupReplayCache() {
  const cutoff = Date.now() - ATTESTATION_REPLAY_WINDOW_MS;
  let changed = false;
  for (const [key, atMs] of consumedBenchmarkProofs.entries()) {
    if (atMs < cutoff) {
      consumedBenchmarkProofs.delete(key);
      changed = true;
    }
  }
  if (changed) saveConsumedProofs();
}

function cleanupExpiredChallenges() {
  const nowMs = Date.now();
  for (const [challengeId, challenge] of activeAttestationChallenges.entries()) {
    if (!challenge || challenge.expiresAtMs < nowMs) activeAttestationChallenges.delete(challengeId);
  }
}

function getMinerRecord(minerId) {
  const key = normalizeMinerIdentity(minerId);
  if (!attestationState.miners[key]) {
    attestationState.miners[key] = {
      level: 0,
      goodStreak: 0,
      badStreak: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      lastSeenAtMs: 0,
      lastProfileId: 'fallback',
      lastAcceptedAtMs: 0,
      nextRequiredAtMs: 0,
      forcedReattestUntilMs: 0,
      lastSpotCheckEvalAtMs: 0,
      lastIdentityAddress: '',
    };
  }
  return attestationState.miners[key];
}

function buildChallengeSignature(challengePayload) {
  const hmac = crypto.createHmac('sha256', Buffer.from(attestationState.secret, 'utf8'));
  hmac.update(JSON.stringify(challengePayload));
  return hmac.digest('hex');
}

function computeNextReattestDueAt(nowMs = Date.now()) {
  const range = Math.max(1, ATTESTATION_REATTEST_MAX_MS - ATTESTATION_REATTEST_MIN_MS);
  const jitter = crypto.randomInt(0, range + 1);
  return nowMs + ATTESTATION_REATTEST_MIN_MS + jitter;
}

function evaluateReattestationNeed(record, profile, options = {}) {
  const nowMs = Date.now();
  const reasons = [];
  const allowSpotCheck = !!(options && options.allowSpotCheck);
  const requiredBySchedule =
    (Number(record.nextRequiredAtMs) || 0) > 0 && nowMs >= Number(record.nextRequiredAtMs || 0);
  const requiredByForcedWindow = (Number(record.forcedReattestUntilMs) || 0) > nowMs;
  const hasAcceptedAttestation = (Number(record.lastAcceptedAtMs) || 0) > 0;

  if (!hasAcceptedAttestation) reasons.push('initial-attestation-required');
  if (requiredBySchedule) reasons.push('periodic-reattest-window');
  if (requiredByForcedWindow) reasons.push('spot-check-required');

  if (allowSpotCheck && hasAcceptedAttestation && !requiredBySchedule && !requiredByForcedWindow) {
    const lastEval = Number(record.lastSpotCheckEvalAtMs) || 0;
    if (nowMs - lastEval >= ATTESTATION_SPOTCHECK_MIN_GAP_MS) {
      record.lastSpotCheckEvalAtMs = nowMs;
      const probability = Math.min(0.5, Math.max(0, Number(profile.spotCheckProbability) || 0.05));
      if (Math.random() < probability) {
        record.forcedReattestUntilMs = nowMs + ATTESTATION_SPOTCHECK_DURATION_MS;
        reasons.push('spot-check-required');
        saveAttestationState();
      }
    }
  }

  return {
    requiredNow: reasons.length > 0,
    reasons,
    nextRequiredAtMs: Number(record.nextRequiredAtMs) || 0,
    forcedReattestUntilMs: Number(record.forcedReattestUntilMs) || 0,
  };
}

function computePolicyForMiner(minerId, summary = {}, options = {}) {
  const profile = resolveHardwareProfile(summary);
  const allowGpuWorkloads = shouldAllowGpuWorkloadsForSummary(summary);
  const record = getMinerRecord(minerId);
  const level = Math.max(0, Math.min(ATTESTATION_MAX_LEVEL, Number(record.level) || 0));
  const capW = Math.min(profile.maxCapW, profile.conservativeCapW + profile.stepW * level);
  const reattestation = evaluateReattestationNeed(record, profile, {
    allowSpotCheck: !!(options && options.allowSpotCheck),
  });
  return {
    profileId: profile.id,
    profileSource: remoteProfileFeed.source || 'local',
    conservativeCapW: profile.conservativeCapW,
    maxCapW: profile.maxCapW,
    currentCapW: capW,
    level,
    nextLevelCapW: Math.min(
      profile.maxCapW,
      profile.conservativeCapW + profile.stepW * Math.min(ATTESTATION_MAX_LEVEL, level + 1),
    ),
    requireGpuProof: allowGpuWorkloads && !!profile.requireGpuProof,
    minimums: {
      cpuOpsPerSec: profile.minCpuOpsPerSec,
      memoryMBps: profile.minMemoryMBps,
      jitterRatioMax: 0.45,
    },
    reattestation: {
      requiredNow: reattestation.requiredNow,
      reasons: reattestation.reasons,
      nextRequiredAtMs: reattestation.nextRequiredAtMs,
      forcedReattestUntilMs: reattestation.forcedReattestUntilMs,
      minWindowMs: ATTESTATION_REATTEST_MIN_MS,
      maxWindowMs: ATTESTATION_REATTEST_MAX_MS,
      spotCheckProbability: Math.min(0.5, Math.max(0, Number(profile.spotCheckProbability) || 0.05)),
    },
  };
}

function buildAttestationMessage(challenge) {
  return `WATTCOIN_ATTEST:${challenge.id}:${challenge.challengeSeed}:${challenge.expiresAtMs}:${challenge.minerId}`;
}

function verifyIdentityWithWalletSignature(identity = {}, expectedMessage = '') {
  const _walletName = 'wattminer';
  const address = String(identity.address || '').trim();
  const signature = String(identity.signature || '').trim();
  const message = String(identity.message || '').trim();
  if (!address || !signature || !message) {
    return { ok: false, code: 'IDENTITY_SIGNATURE_MISSING', reason: 'address/signature/message missing' };
  }
  if (message !== expectedMessage) {
    return { ok: false, code: 'IDENTITY_MESSAGE_MISMATCH', reason: 'signed message does not match challenge message' };
  }
  const isOwned = !!(wtcNode && wtcNode.getAddresses().includes(address));
  if (!isOwned) {
    return { ok: false, code: 'IDENTITY_ADDRESS_NOT_OWNED', reason: 'address is not owned by local wallet' };
  }
  const verified = wtcNode ? wtcNode.verifyMessage(address, signature, message) : false;
  if (verified) return { ok: true, address };
  return { ok: false, code: 'IDENTITY_SIGNATURE_INVALID', reason: 'wallet signature verification failed' };
}

// verifyWalletMessagePureJS moved to wtc-address.js

// Verifies a remotely-supplied wallet signature for HTTP ledger endpoints.
// Unlike verifyIdentityWithWalletSignature this does NOT check wallet ownership
// (the signer is a remote worker whose address isn't in the coordinator wallet).
// Message format: "<prefix>:<address>:<2-minute-time-window>"
// Accepts the current window and the previous one for clock-skew tolerance.
// Primary: pure JS offline verification (no node required).
// Fallback: RPC verifymessage (used if pure JS throws unexpectedly).
function _verifyContributionSignature(address, signature, message, expectedPrefix) {
  if (!address || !signature || !message || !expectedPrefix) {
    return { ok: false, reason: 'address, signature, message, or prefix missing' };
  }
  const expectedStart = `${expectedPrefix}:${address}:`;
  if (!message.startsWith(expectedStart)) {
    return { ok: false, reason: 'message format invalid or address mismatch' };
  }
  const windowStr = message.slice(expectedStart.length);
  const windowNum = Number(windowStr);
  if (!Number.isFinite(windowNum) || windowNum <= 0) {
    return { ok: false, reason: 'message time window invalid' };
  }
  // Each window is 2 minutes wide; accepting currentWindow and currentWindow-1 provides
  // ~4 minutes of maximum replay tolerance (clock-skew / polling lag between worker and
  // coordinator).  This is a deliberate trade-off: a captured signature is replayable for
  // at most one full additional 2-minute window before it expires.
  const currentWindow = Math.floor(Date.now() / 120_000);
  if (windowNum !== currentWindow && windowNum !== currentWindow - 1) {
    return { ok: false, reason: 'contribution signature expired or from the future' };
  }
  // Pure JS verification — works offline, no node dependency.
  try {
    const valid = verifyWalletMessagePureJS(address, signature, message, getActiveNetwork());
    if (valid) return { ok: true };
    // Pure JS says invalid — try RPC as a secondary check in case of network/address edge case.
  } catch (pureJsErr) {
    console.warn('[SigVerify] Pure JS verification threw, falling back to RPC:', pureJsErr && pureJsErr.message);
  }
  return { ok: false, reason: 'signature verification failed' };
}

function issueBenchmarkChallenge(minerId, hardwareSummary = {}, identityAddress = '') {
  if (!ENABLE_NODE_ATTESTATION) {
    return { ok: false, code: 'ATTESTATION_DISABLED', message: 'Node attestation is disabled.' };
  }
  cleanupReplayCache();
  cleanupExpiredChallenges();
  if (remoteProfileFeed.expiresAtMs > 0 && remoteProfileFeed.expiresAtMs <= Date.now()) {
    refreshRemoteProfilesFromPolicyFeed().catch(() => {});
  }
  const identity = normalizeMinerIdentity(minerId);
  const policy = computePolicyForMiner(identity, hardwareSummary);
  const issuedAtMs = Date.now();
  const challengePayload = {
    id: crypto.randomBytes(16).toString('hex'),
    minerId: identity,
    issuedAtMs,
    expiresAtMs: issuedAtMs + ATTESTATION_CHALLENGE_TTL_MS,
    challengeSeed: crypto.randomInt(1, 2_147_483_647),
    workloadProfile: {
      phaseCount: 4,
      phaseDurationMs: 120,
      memBytes: 8 * 1024 * 1024,
      allowGpuWorkloads: !!policy.requireGpuProof,
    },
    minimums: policy.minimums,
    requireGpuProof: !!policy.requireGpuProof,
    profileId: policy.profileId,
    identityAddress: String(identityAddress || '').trim(),
  };
  challengePayload.attestationMessage = buildAttestationMessage(challengePayload);
  const signature = buildChallengeSignature(challengePayload);
  const challenge = { ...challengePayload, signature };
  activeAttestationChallenges.set(challenge.id, challenge);
  return {
    ok: true,
    challenge,
    policy,
  };
}

function rejectAttestation(minerId, summary, code, message, reasons = []) {
  const identity = normalizeMinerIdentity(minerId);
  const record = getMinerRecord(identity);
  record.level = Math.max(0, (Number(record.level) || 0) - 1);
  record.badStreak = Math.max(1, (Number(record.badStreak) || 0) + 1);
  record.goodStreak = 0;
  record.rejectedCount = (Number(record.rejectedCount) || 0) + 1;
  record.lastSeenAtMs = Date.now();
  const profile = resolveHardwareProfile(summary);
  record.lastProfileId = profile.id;
  saveAttestationState();
  return {
    ok: false,
    code,
    message,
    reasons,
    policy: computePolicyForMiner(identity, summary),
  };
}

function enforceReattestationGateForMiner(minerId, hardwareSummary = {}, options = {}) {
  if (!ENABLE_NODE_ATTESTATION) {
    return {
      ok: true,
      policy: {
        currentCapW: 0,
        reattestation: { requiredNow: false, reasons: [] },
      },
    };
  }
  const identity = normalizeMinerIdentity(minerId);
  const record = getMinerRecord(identity);
  const profile = resolveHardwareProfile(hardwareSummary);
  const check = evaluateReattestationNeed(record, profile, { allowSpotCheck: !!(options && options.allowSpotCheck) });
  if (!check.requiredNow) {
    return {
      ok: true,
      policy: computePolicyForMiner(identity, hardwareSummary),
    };
  }
  saveAttestationState();
  return {
    ok: false,
    code: 'ATTESTATION_REQUIRED',
    message: 'Re-attestation required by node policy before mining can continue.',
    reasons: check.reasons,
    policy: computePolicyForMiner(identity, hardwareSummary),
  };
}

async function submitBenchmarkProof(payload = {}) {
  if (!ENABLE_NODE_ATTESTATION) {
    return { ok: false, code: 'ATTESTATION_DISABLED', message: 'Node attestation is disabled.', reasons: [] };
  }
  cleanupReplayCache();
  cleanupExpiredChallenges();

  const minerId = normalizeMinerIdentity(payload.minerId);
  const challenge = payload && payload.challenge && typeof payload.challenge === 'object' ? payload.challenge : null;
  const proof = payload && payload.proof && typeof payload.proof === 'object' ? payload.proof : null;
  const summary =
    payload && payload.hardwareSummary && typeof payload.hardwareSummary === 'object' ? payload.hardwareSummary : {};
  const identity = payload && payload.identity && typeof payload.identity === 'object' ? payload.identity : {};

  if (!challenge || !proof || !challenge.id) {
    return rejectAttestation(
      minerId,
      summary,
      'ATTESTATION_PAYLOAD_INVALID',
      'Attestation payload missing challenge or proof.',
      ['missing challenge/proof payload'],
    );
  }

  const expected = activeAttestationChallenges.get(String(challenge.id));
  if (!expected) {
    return rejectAttestation(
      minerId,
      summary,
      'ATTESTATION_CHALLENGE_UNKNOWN',
      'Challenge not active or already consumed.',
      ['challenge unknown or already used'],
    );
  }

  if (expected.minerId !== minerId) {
    activeAttestationChallenges.delete(expected.id);
    return rejectAttestation(minerId, summary, 'ATTESTATION_MINER_MISMATCH', 'Challenge miner identity mismatch.', [
      'challenge miner mismatch',
    ]);
  }

  const nowMs = Date.now();
  if (expected.expiresAtMs < nowMs) {
    activeAttestationChallenges.delete(expected.id);
    return rejectAttestation(minerId, summary, 'ATTESTATION_CHALLENGE_EXPIRED', 'Challenge expired.', [
      'challenge expired',
    ]);
  }

  const signedPayload = {
    id: expected.id,
    minerId: expected.minerId,
    issuedAtMs: expected.issuedAtMs,
    expiresAtMs: expected.expiresAtMs,
    challengeSeed: expected.challengeSeed,
    workloadProfile: expected.workloadProfile,
    minimums: expected.minimums,
    requireGpuProof: expected.requireGpuProof,
    profileId: expected.profileId,
    identityAddress: expected.identityAddress,
    attestationMessage: expected.attestationMessage,
  };
  const expectedSignature = buildChallengeSignature(signedPayload);
  if (!secureStringEquals(expectedSignature, String(challenge.signature || ''))) {
    activeAttestationChallenges.delete(expected.id);
    return rejectAttestation(
      minerId,
      summary,
      'ATTESTATION_SIGNATURE_INVALID',
      'Challenge signature verification failed.',
      ['challenge signature invalid'],
    );
  }

  const challengeSeed = Math.max(0, Math.floor(Number(proof.challengeSeed) || 0));
  if (challengeSeed !== expected.challengeSeed) {
    activeAttestationChallenges.delete(expected.id);
    return rejectAttestation(minerId, summary, 'ATTESTATION_SEED_MISMATCH', 'Proof challenge seed mismatch.', [
      'proof challenge seed mismatch',
    ]);
  }

  // Reject if the backend benchmark was not run after this challenge was issued.
  // This prevents a modified renderer from skipping the Node benchmark and submitting
  // inflated throughput numbers directly.
  if (expected.measuredCpuOpsPerSec == null) {
    activeAttestationChallenges.delete(expected.id);
    return rejectAttestation(
      minerId,
      summary,
      'ATTESTATION_PROOF_REJECTED',
      'Backend benchmark was not run before submitting this proof.',
      ['main-process benchmark missing for this challenge'],
    );
  }
  // Use main-process-measured values; renderer-supplied values are ignored for gating decisions.
  const cpuOpsPerSec = expected.measuredCpuOpsPerSec;
  const memoryMBps = expected.measuredMemoryMBps;
  const jitterRatio = Math.max(0, Number(proof.jitterRatio) || 0);
  const gpuProofHash = String(proof.gpuProofHash || '').trim();
  const gpuBenchAvailable = !!proof.gpuBenchAvailable;

  const failures = [];

  const identityCheck = await verifyIdentityWithWalletSignature(identity, expected.attestationMessage || '');
  if (!identityCheck.ok) {
    failures.push(`identity check failed: ${identityCheck.code || identityCheck.reason || 'unknown'}`);
  } else if (expected.identityAddress && expected.identityAddress !== identityCheck.address) {
    failures.push('identity address mismatch against challenge envelope');
  }

  if (cpuOpsPerSec < Number((expected.minimums && expected.minimums.cpuOpsPerSec) || 0)) {
    failures.push('cpu throughput below node minimum');
  }
  if (memoryMBps < Number((expected.minimums && expected.minimums.memoryMBps) || 0)) {
    failures.push('memory bandwidth below node minimum');
  }
  if (jitterRatio > Number((expected.minimums && expected.minimums.jitterRatioMax) || 0.45)) {
    // Adapt the threshold to this machine's rolling jitter history: if the device
    // consistently runs at moderate jitter (e.g. 0.25 rolling mean), allow up to
    // 2× that rolling mean before rejecting — so a single noisy run doesn't cause
    // a false failure.  The hard cap of 0.70 prevents a pathologically jittery
    // machine from bypassing the check entirely.
    const adaptiveMax =
      hwAuthority.rollingJitterMean > 0 ? Math.min(0.7, Math.max(0.45, hwAuthority.rollingJitterMean * 2.0)) : 0.45;
    if (jitterRatio > adaptiveMax) {
      failures.push('benchmark jitter above node maximum');
    }
  }
  if (expected.requireGpuProof && (!gpuBenchAvailable || !gpuProofHash)) {
    failures.push('gpu proof required but missing');
  }

  const replayKey = sha256Hex(
    JSON.stringify({
      minerId,
      challengeId: expected.id,
      challengeSeed,
      cpuOpsPerSec: Math.round(cpuOpsPerSec),
      memoryMBps: Math.round(memoryMBps),
      gpuProofHash,
    }),
  );
  if (consumedBenchmarkProofs.has(replayKey)) {
    failures.push('replay detected for benchmark proof');
  }

  activeAttestationChallenges.delete(expected.id);
  consumedBenchmarkProofs.set(replayKey, nowMs);
  saveConsumedProofs();

  if (failures.length > 0) {
    return rejectAttestation(
      minerId,
      summary,
      'ATTESTATION_PROOF_REJECTED',
      'Benchmark proof rejected by node policy.',
      failures,
    );
  }

  const profile = resolveHardwareProfile(summary);
  const record = getMinerRecord(minerId);
  record.level = Math.min(ATTESTATION_MAX_LEVEL, (Number(record.level) || 0) + 1);
  record.goodStreak = (Number(record.goodStreak) || 0) + 1;
  record.badStreak = 0;
  record.acceptedCount = (Number(record.acceptedCount) || 0) + 1;
  record.lastSeenAtMs = nowMs;
  record.lastProfileId = profile.id;
  record.lastAcceptedAtMs = nowMs;
  record.nextRequiredAtMs = computeNextReattestDueAt(nowMs);
  record.forcedReattestUntilMs = 0;
  record.lastIdentityAddress = identityCheck.ok ? identityCheck.address : String(identity.address || '').trim();
  saveAttestationState();

  return {
    ok: true,
    accepted: true,
    message: 'Benchmark proof accepted by node attestation policy.',
    policy: computePolicyForMiner(minerId, summary),
    reasons: [],
  };
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function validatePassphrase(passphrase) {
  return typeof passphrase === 'string' && passphrase.length >= 8;
}

function isBetaModeEnabled() {
  return Boolean(getRuntimeConfig().betaMode);
}

function getBetaPolicy() {
  const betaMode = isBetaModeEnabled();
  return {
    betaMode,
    withdrawalsEnabled: !betaMode,
    rewardsConvertible: !betaMode,
    resetWipePolicy: betaMode,
    policyMessage: betaMode
      ? 'Closed beta mode active: balances are test-only, withdrawals are disabled, and balances may be reset or wiped.'
      : 'Standard mode active.',
  };
}

function getAbuseLogFilePath() {
  return path.join(getWalletDataDir(), ABUSE_LOG_FILE_NAME);
}

async function logAbuseEvent(event) {
  const payload = {
    timestamp: new Date().toISOString(),
    app: 'Wattcoin',
    ...event,
  };
  try {
    await fsp.mkdir(path.dirname(getAbuseLogFilePath()), { recursive: true });
    await fsp.appendFile(getAbuseLogFilePath(), `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function getOpsMetricsFilePath() {
  return path.join(getWalletDataDir(), OPS_METRICS_FILE_NAME);
}

function pruneOldTimestamps(timestamps, windowMs) {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter((ts) => ts >= cutoff);
}

function pushTimestampWindow(target, windowMs, maxLen = 5000) {
  const now = Date.now();
  target.push(now);
  const pruned = pruneOldTimestamps(target, windowMs);
  if (pruned.length > maxLen) return pruned.slice(pruned.length - maxLen);
  return pruned;
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function recordOpsAlert(code, severity, message, details = {}) {
  const cooldownUntil = opsState.alertCooldownUntil.get(code) || 0;
  const now = Date.now();
  if (now < cooldownUntil) return;
  const entry = {
    ts: new Date(now).toISOString(),
    code,
    severity,
    message,
    details,
  };
  opsState.alerts.push(entry);
  if (opsState.alerts.length > 200) {
    opsState.alerts = opsState.alerts.slice(opsState.alerts.length - 200);
  }
  opsState.alertCooldownUntil.set(code, now + OPS_ALERT_COOLDOWN_MS);
  logAbuseEvent({ type: 'ops-alert', ...entry }).catch(() => {});
}

function getPeerNetworkSegment(peerUrl) {
  try {
    const host = new URL(peerUrl).hostname;
    const parts = host.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return host;
  } catch (_) {
    return '';
  }
}

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

function isPinnedPeerUrl(peerUrl, settings = getLedgerNetworkSettings()) {
  const normalized = normalizePeerUrl(peerUrl);
  if (!normalized) return false;
  const persistentPeers = [
    ...((settings && settings.peers) || []),
    ...((settings && settings.configuredPeers) || []),
    ...((settings && settings.seedPeers) || []),
  ];
  return persistentPeers.some((entry) => normalizePeerUrl(entry) === normalized);
}

function isPeerUrlBanned(peerUrl) {
  const key = String(peerUrl || '').trim();
  if (!key) return false;
  if (isPinnedPeerUrl(key)) {
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
  if (isPinnedPeerUrl(key)) return;
  const untilMs = Date.now() + durationMs;
  bannedPeerUrls.set(key, { untilMs, reason: String(reason || 'policy') });
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
  opsState.peerRequestFailTimestamps = pushTimestampWindow(opsState.peerRequestFailTimestamps, OPS_WINDOW_MS, 5000);
  const hits = peerUrlFailures.get(key) || [];
  const updated = pushTimestampWindow(hits, PEER_FAILURE_WINDOW_MS, 200);
  peerUrlFailures.set(key, updated);
  if (updated.length >= PEER_FAILURE_BAN_THRESHOLD) {
    banPeerUrl(key, reason || 'excessive failures');
    peerUrlFailures.set(key, []);
  }
}

function recordPeerUrlSuccess(peerUrl) {
  const key = String(peerUrl || '').trim();
  if (!key) return;
  opsState.peerRequestOkTimestamps = pushTimestampWindow(opsState.peerRequestOkTimestamps, OPS_WINDOW_MS, 5000);
  const hits = peerUrlFailures.get(key) || [];
  if (hits.length <= 1) {
    peerUrlFailures.delete(key);
  } else {
    peerUrlFailures.set(key, hits.slice(-1));
  }
}

function recordForkMismatch(details = {}) {
  opsState.forkMismatchTimestamps = pushTimestampWindow(opsState.forkMismatchTimestamps, OPS_WINDOW_MS, 5000);
  recordOpsAlert('chain.fork.mismatch', 'warn', 'Settlement mismatch detected across peers', details);
}

function recordRollbackDepth(depth, details = {}) {
  const n = Math.max(0, Number(depth) || 0);
  if (n <= 0) return;
  opsState.rollbackDepths.push(n);
  opsState.rollbackDepths = opsState.rollbackDepths.slice(-500);
  if (n >= 3) {
    recordOpsAlert('chain.rollback.depth', 'warn', `Rollback depth ${n} observed`, details);
  }
}

function getPeerIdentityKey(peerUrl, tipResponse) {
  const peerIdentity =
    tipResponse && typeof tipResponse.peerIdentity === 'string' ? tipResponse.peerIdentity.trim() : '';
  if (peerIdentity) return `id:${peerIdentity}`;
  const normalized = normalizePeerUrl(peerUrl);
  return normalized ? `url:${normalized}` : `url:${String(peerUrl || '').trim()}`;
}

function _getDiscoveredPeerPresenceCount(settings = getLedgerNetworkSettings()) {
  const now = Date.now();
  const selfAdvertisedUrls = new Set(getConfiguredAdvertisedPeerUrls(settings).map(normalizePeerUrl).filter(Boolean));
  const presenceKeys = new Set();
  for (const [peerUrl, info] of discoveredPeers.entries()) {
    if (!info || now - Number(info.lastSeenMs || 0) > PEER_STALE_THRESHOLD_MS || isPeerUrlBanned(peerUrl)) continue;
    if (!info.seenThisSession) continue;
    const peerIdentity = String(info.peerIdentity || '').trim();
    if (isPeerIdentitySelfReference(peerIdentity, peerUrl)) continue;
    // Skip self even when our public IP is not in the local interfaces (NAT).
    if (selfAdvertisedUrls.has(normalizePeerUrl(peerUrl))) continue;
    presenceKeys.add(peerIdentity ? `id:${peerIdentity}` : `url:${peerUrl}`);
  }
  return presenceKeys.size;
}

function inspectPeerConnectivity(settings = getLedgerNetworkSettings(), { source = 'peer-contact' } = {}) {
  const peers = getActivePeers(settings);
  return inspectPeerConnectivityForTargets(peers, {
    source,
    initialBestPeerHeight: Number(wtcNode && typeof wtcNode.getHeight === 'function' ? wtcNode.getHeight() : 0) || 0,
    concurrency: PEER_COUNT_PROBE_CONCURRENCY,
    probeTimeoutMs: PEER_COUNT_PROBE_TIMEOUT_MS,
  });
}

async function inspectPeerConnectivityForTargets(
  peerUrls = [],
  {
    source = 'peer-contact',
    initialBestPeerHeight = Number(wtcNode && typeof wtcNode.getHeight === 'function' ? wtcNode.getHeight() : 0) || 0,
    concurrency = 0,
    probeTimeoutMs = 0,
  } = {},
) {
  const peers = Array.from(new Set((peerUrls || []).map(normalizePeerUrl).filter(Boolean)));
  const distinctPeerKeys = new Set();
  const healthyPeerKeys = new Set();
  const healthyTunnelPeerKeys = new Set();
  let bestPeerHeight = initialBestPeerHeight;
  const effectiveTimeout = Math.max(1000, Number(probeTimeoutMs) || PEER_CHAIN_TIP_TIMEOUT_MS);
  const maxConcurrency = Math.max(1, Number(concurrency) || peers.length);
  const settings = getLedgerNetworkSettings();
  const nowMs = Date.now();
  const getFallbackPeerKey = (peerUrl) => {
    const normalizedPeerUrl = normalizePeerUrl(peerUrl);
    const discoveredInfo = normalizedPeerUrl ? discoveredPeers.get(normalizedPeerUrl) : null;
    const peerIdentity = String((discoveredInfo && discoveredInfo.peerIdentity) || '').trim();
    if (peerIdentity) return `id:${peerIdentity}`;
    return getPeerIdentityKey(peerUrl, null);
  };

  // Partition peers: locally-served tunnel peers use WebSocket session liveness
  // (avoids a redundant HTTP round-trip through our own tunnel proxy that can
  // timeout under load), all others are probed via HTTP as before.
  const httpPeers = [];
  for (const peerUrl of peers) {
    if (isLocallyServedReverseTunnelPeerUrl(peerUrl, settings)) {
      // Tunnel peer whose session lives on this coordinator — derive health
      // from the WebSocket session rather than probing through the tunnel.
      const tunnelId = extractTunnelIdFromUrl(peerUrl);
      const session = tunnelId ? reverseTunnelSessions.get(tunnelId) : null;
      if (
        session &&
        session.socket &&
        session.socket.readyState === WebSocket.OPEN &&
        nowMs - Number(session.lastSeenAtMs || 0) <= REVERSE_TUNNEL_LIVE_THRESHOLD_MS
      ) {
        const identity = String(session.peerIdentity || '').trim();
        if (isPeerIdentitySelfReference(identity, peerUrl)) continue;
        const peerKey = identity || `tunnel:${tunnelId}`;
        distinctPeerKeys.add(peerKey);
        healthyPeerKeys.add(peerKey);
        healthyTunnelPeerKeys.add(peerKey);
      } else {
        // Session dead or gone — still count as distinct but unhealthy.
        distinctPeerKeys.add(getFallbackPeerKey(peerUrl));
      }
    } else {
      httpPeers.push(peerUrl);
    }
  }

  const probePeer = async (peerUrl) => {
    const fallbackKey = getFallbackPeerKey(peerUrl);
    try {
      const tip = await requestPeerJson(peerUrl, 'GET', '/api/v1/chain/tip', undefined, undefined, {
        source,
        timeoutMs: effectiveTimeout,
        trackReachability: false,
      });
      if (!tip || !tip.ok) {
        distinctPeerKeys.add(fallbackKey);
        return;
      }
      const peerIdentity = String((tip && tip.peerIdentity) || '').trim();
      if (isPeerIdentitySelfReference(peerIdentity, peerUrl)) {
        return;
      }
      const peerKey = getPeerIdentityKey(peerUrl, tip);
      distinctPeerKeys.add(peerKey);
      healthyPeerKeys.add(peerKey);
      if (isReverseTunnelPeerUrl(peerUrl)) {
        healthyTunnelPeerKeys.add(peerKey);
      }
      const height = Number(tip.height);
      if (Number.isFinite(height) && height > bestPeerHeight) bestPeerHeight = height;
    } catch (_) {
      distinctPeerKeys.add(fallbackKey);
    }
  };

  // Probe non-tunnel peers with bounded concurrency.
  for (let i = 0; i < httpPeers.length; i += maxConcurrency) {
    const batch = httpPeers.slice(i, i + maxConcurrency);
    await Promise.all(batch.map(probePeer));
  }

  return {
    peers,
    totalDistinct: distinctPeerKeys.size,
    healthyDistinct: healthyPeerKeys.size,
    healthyTunnelDistinct: healthyTunnelPeerKeys.size,
    bestPeerHeight,
  };
}

function getActiveReverseTunnelPeerConnectionCount() {
  const now = Date.now();
  return countLiveReverseTunnelPeers({
    sessions: reverseTunnelSessions.values(),
    nowMs: now,
    liveThresholdMs: REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
    openState: WebSocket.OPEN,
  });
}

let opsSnapshotInFlight = false;

async function collectOpsSnapshot() {
  // Prevent overlapping ops probes: if a previous snapshot is still in flight
  // (e.g. slow tunnel probes), skip this cycle rather than stacking requests.
  if (opsSnapshotInFlight) return opsState.latestSnapshot || {};
  opsSnapshotInFlight = true;
  try {
    return await collectOpsSnapshotInner();
  } finally {
    opsSnapshotInFlight = false;
  }
}

async function collectOpsSnapshotInner() {
  const localTip = wtcNode && typeof wtcNode.getTip === 'function' ? wtcNode.getTip() : null;
  const localHeight = wtcNode && typeof wtcNode.getHeight === 'function' ? Number(wtcNode.getHeight()) : -1;
  const mempoolSize = wtcNode && typeof wtcNode.getMempoolSize === 'function' ? Number(wtcNode.getMempoolSize()) : 0;

  if (localTip && localTip.hash && opsState.lastTipHash && localTip.hash !== opsState.lastTipHash) {
    const prevTs = Number(opsState.lastTipTimestamp) || 0;
    const currTs = Number(localTip.timestamp) || 0;
    if (prevTs > 0 && currTs > prevTs) {
      const deltaSec = (currTs - prevTs) / 1000;
      if (deltaSec > 0 && deltaSec < 24 * 60 * 60) {
        opsState.blockIntervalsSec.push(deltaSec);
        opsState.blockIntervalsSec = opsState.blockIntervalsSec.slice(-500);
      }
    }
  }
  if (localTip && localTip.hash) {
    opsState.lastTipHash = localTip.hash;
    opsState.lastTipTimestamp = Number(localTip.timestamp) || opsState.lastTipTimestamp;
  }

  const settings = getLedgerNetworkSettings();
  const connectivity = await inspectPeerConnectivity(settings, { source: 'ops-peer-snapshot' });
  const peers = connectivity.peers;
  let bestPeerHeight = Math.max(localHeight, connectivity.bestPeerHeight);
  const healthyPeers = connectivity.healthyDistinct;

  const lag = Math.max(0, bestPeerHeight - localHeight);
  opsState.syncLagSamples.push(lag);
  opsState.syncLagSamples = opsState.syncLagSamples.slice(-500);

  const now = Date.now();
  if (lag > 0 && healthyPeers > 0 && now - (Number(opsState.lastSyncAttemptAt) || 0) >= WTC_PEER_SYNC_INTERVAL_MS) {
    await runWtcPeerSync('ops-fallback');
  }

  const latestBlockAgeMs = opsState.lastTipTimestamp > 0 ? Math.max(0, now - opsState.lastTipTimestamp) : 0;
  if (latestBlockAgeMs >= CHAIN_STALL_ALERT_MS) {
    recordOpsAlert('chain.stall', 'critical', 'No new block observed within stall threshold', {
      latestBlockAgeMs,
      thresholdMs: CHAIN_STALL_ALERT_MS,
    });
  }

  const peerSegments = new Set(peers.map(getPeerNetworkSegment).filter(Boolean));
  if (peers.length >= 3 && peerSegments.size < 3) {
    recordOpsAlert('peer.diversity.low', 'warn', 'Peer diversity below recommended threshold', {
      peerCount: peers.length,
      uniqueSegments: peerSegments.size,
    });
  }

  const forkRatePerHour = pruneOldTimestamps(opsState.forkMismatchTimestamps, OPS_WINDOW_MS).length;
  const rollbackMedian = median(opsState.rollbackDepths.slice(-100));
  const blockIntervalMedianSec = median(opsState.blockIntervalsSec.slice(-100));
  const lagMedian = median(opsState.syncLagSamples.slice(-100));
  const peerOkPerHour = pruneOldTimestamps(opsState.peerRequestOkTimestamps, OPS_WINDOW_MS).length;
  const peerFailPerHour = pruneOldTimestamps(opsState.peerRequestFailTimestamps, OPS_WINDOW_MS).length;
  const mempoolPressure = mempoolSize / 5000;
  if (mempoolPressure >= 0.85) {
    recordOpsAlert('mempool.pressure.high', 'warn', 'Mempool pressure is above 85%', { mempoolSize, capacity: 5000 });
  }

  const snapshot = {
    timestamp: new Date(now).toISOString(),
    chain: {
      localHeight,
      bestPeerHeight,
      nodeLagBlocks: lag,
      latestBlockAgeMs,
      blockIntervalMedianSec,
      forkRatePerHour,
      rollbackMedianDepth: rollbackMedian,
    },
    peers: {
      total: connectivity.totalDistinct,
      healthy: healthyPeers,
      bannedUrls: bannedPeerUrls.size,
      bannedIdentities: bannedPeerIdentities.size,
      uniqueNetworkSegments: peerSegments.size,
      requestOkPerHour: peerOkPerHour,
      requestFailPerHour: peerFailPerHour,
    },
    mempool: {
      size: mempoolSize,
      capacity: 5000,
      pressure: Number(mempoolPressure.toFixed(4)),
    },
    alerts: opsState.alerts.slice(-50),
    sync: {
      lagMedianBlocks: lagMedian,
      lastSyncResult: opsState.lastSyncResult,
    },
  };

  opsState.latestSnapshot = snapshot;
  try {
    await fsp.mkdir(path.dirname(getOpsMetricsFilePath()), { recursive: true });
    await fsp.writeFile(getOpsMetricsFilePath(), JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  return snapshot;
}

function startOpsMetricsLoop() {
  if (opsMetricsTimer) return;
  setImmediate(() => collectOpsSnapshot().catch(() => {}));
  opsMetricsTimer = setInterval(() => {
    collectOpsSnapshot().catch(() => {});
  }, OPS_METRICS_SAMPLE_MS);
}

function stopOpsMetricsLoop() {
  if (!opsMetricsTimer) return;
  clearInterval(opsMetricsTimer);
  opsMetricsTimer = null;
}

function getEndpointActorKey(endpointName, actorId = 'local-client') {
  return `${endpointName}:${String(actorId || 'local-client')}`;
}

function shouldEscalateRateLimitToIdentityFailure(endpointName) {
  const normalized = String(endpointName || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('wtc-peer-')) return false;
  if (normalized.startsWith('peer-probe-')) return false;
  return true;
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

function getMinerBetaPassword() {
  const candidate = getRuntimeConfig().minerPassword || '';
  return typeof candidate === 'string' ? candidate : '';
}

function isMinerPasswordRequired() {
  return getMinerBetaPassword().trim().length > 0;
}

function secureStringEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function formatBackupTimestampForFilename(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('') +
    '-' +
    [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
  );
}

function encryptBackupPayload(payloadObject, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObject), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptBackupPayload(encryptedObject, passphrase) {
  const salt = Buffer.from(encryptedObject.salt || '', 'base64');
  const iv = Buffer.from(encryptedObject.iv || '', 'base64');
  const tag = Buffer.from(encryptedObject.tag || '', 'base64');
  const ciphertext = Buffer.from(encryptedObject.ciphertext || '', 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function parseBackupContainer(raw) {
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('Invalid backup file format (JSON parsing failed).');
  }

  const format = parsed && parsed.format;
  const version = parsed && parsed.version;
  if (format !== 'WATTCOIN_WALLET_BACKUP' || version !== BACKUP_FORMAT_VERSION) {
    throw new Error('Unsupported backup format version.');
  }

  if (!parsed.encrypted || typeof parsed.encrypted !== 'object') {
    throw new Error('Backup is missing encrypted payload.');
  }

  return parsed;
}

function getFocusedWindow() {
  return BrowserWindow.getFocusedWindow() || null;
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _walletReadinessCache = null;
let _walletReadinessCacheAt = 0;
let walletAddressCache = { address: '', at: 0 };
let updateInstallInProgress = false;
const walletSyncEmitter = new EventEmitter();
let walletSyncRefreshPromise = null;
let walletSyncStateTimer = null;
let walletSyncState = {
  ok: false,
  nodeReady: false,
  rpcReachable: false,
  selectedAddress: '',
  addresses: [],
  walletReadiness: {
    ok: false,
    status: 'syncing',
    message: 'Node is starting up. Please wait...',
    spendReady: false,
    blocks: 0,
    headers: 0,
    connections: 0,
    verificationProgress: 0,
  },
  updatedAt: 0,
  reason: 'startup',
};

function cloneWalletSyncState() {
  return JSON.parse(JSON.stringify(walletSyncState));
}

function broadcastWalletSyncState() {
  const snapshot = cloneWalletSyncState();
  walletSyncEmitter.emit('changed', snapshot);
}

async function computeWalletSyncState(reason = 'refresh') {
  if (!wtcNode) {
    return {
      ok: false,
      nodeReady: false,
      rpcReachable: false,
      selectedAddress: '',
      addresses: [],
      walletReadiness: {
        ok: false,
        status: 'syncing',
        message: 'Node is starting up. Please wait...',
        spendReady: false,
        blocks: 0,
        headers: 0,
        connections: 0,
        verificationProgress: 0,
      },
      updatedAt: Date.now(),
      reason,
    };
  }

  const readiness = await wtcNode.getWalletReadiness();
  const addresses = Array.isArray(wtcNode.getAddresses()) ? wtcNode.getAddresses() : [];
  const selectedAddress =
    typeof wtcNode.getPrimaryAddress === 'function' ? String(wtcNode.getPrimaryAddress() || '').trim() : '';
  if (selectedAddress) {
    walletAddressCache = { address: selectedAddress, at: Date.now() };
    setCoordinatorIdentityKey(selectedAddress);
  }

  return {
    ok: true,
    nodeReady: true,
    rpcReachable: readiness && readiness.rpcReachable !== false,
    selectedAddress,
    addresses,
    walletReadiness:
      readiness && typeof readiness === 'object'
        ? {
            ok: readiness.ok !== false,
            status: readiness.status || 'syncing',
            message: readiness.message || 'Checking wallet sync status...',
            spendReady: !!readiness.spendReady,
            blocks: Math.max(0, Number(readiness.blocks) || 0),
            headers: Math.max(0, Number(readiness.headers) || 0),
            connections: Math.max(0, Number(readiness.connections) || 0),
            verificationProgress: Math.max(0, Math.min(1, Number(readiness.verificationProgress) || 0)),
            localBlocks: Math.max(-1, Number(readiness.localBlocks) || 0),
            bestPeerHeight: Math.max(-1, Number(readiness.bestPeerHeight) || 0),
            lagBlocks: Math.max(0, Number(readiness.lagBlocks) || 0),
            bestPeer: typeof readiness.bestPeer === 'string' ? readiness.bestPeer : '',
            scanning: !!readiness.scanning,
            initialBlockDownload: !!readiness.initialBlockDownload,
            lastSyncResult: readiness.lastSyncResult || null,
            syncBlockedReason: typeof readiness.syncBlockedReason === 'string' ? readiness.syncBlockedReason : '',
          }
        : walletSyncState.walletReadiness,
    updatedAt: Date.now(),
    reason,
  };
}

function refreshWalletSyncState(reason = 'refresh', { force = false } = {}) {
  if (walletSyncRefreshPromise && !force) return walletSyncRefreshPromise;
  walletSyncRefreshPromise = (async () => {
    const next = await computeWalletSyncState(reason);
    const previousSerialized = JSON.stringify(walletSyncState);
    const nextSerialized = JSON.stringify(next);
    walletSyncState = next;
    if (previousSerialized !== nextSerialized || force) {
      broadcastWalletSyncState();
    }
    return cloneWalletSyncState();
  })().finally(() => {
    walletSyncRefreshPromise = null;
  });
  return walletSyncRefreshPromise;
}

function startWalletSyncStateLoop() {
  if (walletSyncStateTimer) return;
  refreshWalletSyncState('loop-start', { force: true }).catch(() => {});
  walletSyncStateTimer = setInterval(() => {
    refreshWalletSyncState('periodic').catch(() => {});
  }, WALLET_SYNC_STATE_REFRESH_INTERVAL_MS);
}

function stopWalletSyncStateLoop() {
  if (!walletSyncStateTimer) return;
  clearInterval(walletSyncStateTimer);
  walletSyncStateTimer = null;
}

walletSyncEmitter.on('changed', (snapshot) => {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      win.webContents.send('wattcoin-wallet-state', snapshot);
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }
});

function getCurrentBlockHeight() {
  if (wtcNode) return wtcNode.getHeight();
  return 0;
}
function normalizeWalletError(e) {
  const code = e && e.code ? e.code : 'UNKNOWN';
  const message = e && e.message ? e.message : 'Unknown wallet error';
  return { ok: false, code, message };
}

function _parseGeneratedBlockHash(minedOutput) {
  const raw = typeof minedOutput === 'string' ? minedOutput.trim() : '';
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
      return parsed[0];
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  return raw;
}

function computeMinedCoinsFromHeight(height) {
  const halvingInterval = 210000;
  let remainingBlocks = Math.max(0, Math.floor(Number(height) || 0));
  let subsidy = 50;
  let total = 0;

  while (remainingBlocks > 0 && subsidy > 0) {
    const blocksThisEra = Math.min(remainingBlocks, halvingInterval);
    total += blocksThisEra * subsidy;
    remainingBlocks -= blocksThisEra;
    subsidy /= 2;
  }

  return total;
}

function _computeMaturedMinedCoinsFromHeight(height) {
  // Coinbase maturity: rewards are spendable only after 100 confirmations.
  const maturityDepth = 100;
  const maturedHeight = Math.max(0, Math.floor(Number(height) || 0) - maturityDepth);
  return computeMinedCoinsFromHeight(maturedHeight);
}

function _computeWattcoinFromMinedBlocks(blockCount) {
  let remainingBlocks = Math.max(0, Math.floor(Number(blockCount) || 0));
  let totalCoins = 0;

  for (let tier = 0; tier < 21 && remainingBlocks > 0; tier++) {
    const reward = 1000 / Math.pow(2, tier);
    const blocksThisTier = Math.round(1000000 / reward);
    const minedThisTier = Math.min(remainingBlocks, blocksThisTier);
    totalCoins += minedThisTier * reward;
    remainingBlocks -= minedThisTier;
  }

  return Number(totalCoins.toFixed(8));
}

ipcMain.handle('wattcoin-get-wallet-address', () => {
  if (!wtcNode) return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up. Please wait...' };
  const address = wtcNode.getPrimaryAddress();
  walletAddressCache = { address, at: Date.now() };
  setCoordinatorIdentityKey(address);
  refreshWalletSyncState('get-wallet-address').catch(() => {});
  return { ok: true, address };
});

ipcMain.handle('wattcoin-get-wallet-state', () => {
  return refreshWalletSyncState('snapshot');
});

ipcMain.handle('wattcoin-set-primary-address', async (_, targetAddress) => {
  const address = typeof targetAddress === 'string' ? targetAddress.trim() : '';
  if (!wtcNode) {
    return { ok: false, code: 'NODE_NOT_READY', message: 'Node not initialised yet.' };
  }
  if (!address) {
    return { ok: false, code: 'INVALID_ADDRESS', message: 'Address is required.' };
  }
  try {
    wtcNode.setPrimaryAddress(address);
    walletAddressCache = { address, at: Date.now() };
    setCoordinatorIdentityKey(address);
    const snapshot = await refreshWalletSyncState('set-primary-address', { force: true });
    return { ok: true, address, snapshot };
  } catch (e) {
    return {
      ok: false,
      code: 'SET_PRIMARY_FAILED',
      message: e && e.message ? e.message : 'Failed to set primary address.',
    };
  }
});

ipcMain.handle('wattcoin-get-benchmark-capabilities', () => {
  return getBenchmarkCapabilities();
});

ipcMain.handle('wattcoin-run-backend-benchmark', async (_event, request) => {
  // Inject the authoritative wallet address as the memory-proof seed so the proof
  // is unique per miner and cannot be hardcoded without knowing the wallet address.
  // If the cache is stale/empty, do a live lookup before running the benchmark so
  // the proof is never computed with an empty salt (which produces the same hash
  // for every user).
  if (!walletAddressCache.address) {
    try {
      if (wtcNode) {
        const address = wtcNode.getPrimaryAddress();
        if (address) walletAddressCache = { address, at: Date.now() };
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }
  const benchRequest = { ...(request || {}), walletAddress: walletAddressCache.address || '' };
  let result = await runBackendBenchmark(benchRequest);
  // Initialise probe scheduler with freshly measured values so probes use real
  // hardware-specific timing thresholds rather than spec-table estimates.
  if (result && result.ok) {
    setProbeHardwareSpec({
      measuredCpuOpsPerSec: result.cpuSpeedOpsPerSec || 0,
      measuredMemLatencyNs: result.memLatencyNs || 0,
      allowGpuWorkloads: !!(request && request.allowGpuWorkloads),
    });

    // ── Pin throughput to pending attestation challenges ──────────────────────
    // Store main-process-measured values on active challenges for this miner so
    // submitBenchmarkProof uses authoritative numbers, not renderer-reported ones.
    const _minerAddr = walletAddressCache.address || '';
    if (_minerAddr) {
      for (const _ch of activeAttestationChallenges.values()) {
        if (_ch.minerId === _minerAddr || _ch.identityAddress === _minerAddr) {
          _ch.measuredCpuOpsPerSec = result.cpuSpeedOpsPerSec || 0;
          _ch.measuredMemoryMBps = result.memoryMBps || 0;
        }
      }
    }

    // ── Calibration (authoritative — uses main-process copy of hardware tables) ─
    // The renderer sends the hardware description strings; main performs its own
    // expected-value lookup so the renderer cannot manipulate expected ops/s.
    // SECURITY: CPU model is overridden with os.cpus()[0].model (kernel-level)
    // so a patched renderer cannot lie about its CPU to inflate the TDP ceiling.
    const declaredCpuModel = String((request && request.declaredCpuModel) || '');
    const osCpuModel = ((os.cpus()[0] && os.cpus()[0].model) || '').trim();
    const cpuModelMismatch = osCpuModel && declaredCpuModel && !hardwareModelsMatch(osCpuModel, declaredCpuModel);
    const cpuModel = osCpuModel || declaredCpuModel; // prefer OS truth
    if (cpuModelMismatch) {
      const safeDeclaredCpu = String(declaredCpuModel || '')
        .normalize('NFKC')
        .replace(/\s+/g, ' ')
        .trim();
      console.warn(
        `[HW-Verify] CPU model mismatch: renderer="${safeDeclaredCpu}", OS="${osCpuModel}" - using OS model`,
      );
    }

    // GPU verification: compare renderer's GPU claim against OS-level GPU list.
    const hwIdentity = await resolveOsHardwareIdentity();
    const declaredGpuModel = String((request && request.declaredGpuModel) || '');
    const gpuModelMismatch =
      declaredGpuModel &&
      hwIdentity.gpuModels.length > 0 &&
      !hwIdentity.gpuModels.some((osGpu) => hardwareModelsMatch(osGpu, declaredGpuModel));
    if (gpuModelMismatch) {
      console.warn(
        `[HW-Verify] GPU model mismatch: renderer="${declaredGpuModel}", OS=[${hwIdentity.gpuModels.join(', ')}]`,
      );
    }

    // Device-type verification (desktop vs laptop).
    const declaredDeviceType = String((request && request.declaredDeviceType) || '');
    const deviceTypeMismatch =
      declaredDeviceType &&
      hwIdentity.deviceType &&
      declaredDeviceType.toLowerCase() !== hwIdentity.deviceType.toLowerCase() &&
      // Only flag clear contradictions: claiming "PC" when OS says "Laptop".
      /^pc$/i.test(declaredDeviceType) &&
      /laptop/i.test(hwIdentity.deviceType);
    if (deviceTypeMismatch) {
      console.warn(`[HW-Verify] Device type mismatch: renderer="${declaredDeviceType}", OS="${hwIdentity.deviceType}"`);
    }

    // Multi-signal gate: avoid false positives from naming/driver quirks.
    // We only flag a hardware mismatch when at least two independent signals
    // agree, with benchmark consistency as one of the possible signals.
    let anyHwMismatch = false;
    let benchmarkConsistencySignal = false;
    let mismatchSignalCount = 0;

    const memType = String((request && request.declaredMemType) || '');
    const memSpeedMhz = Number((request && request.declaredMemSpeedMhz) || 0);
    const memSticks = Number((request && request.declaredMemSticks) || 1);
    const isBaseline = !!(request && request.isBaselineBenchmark);
    const measuredCpu = result.cpuSpeedOpsPerSec || 0;
    const measuredMem = result.memoryMBps || 0;
    const expectedCpu = getExpectedCpuSpeedOps(cpuModel);
    const expectedDeclaredCpu = getExpectedCpuSpeedOps(declaredCpuModel);
    const expectedMem = getExpectedMemBandwidthMBps(memType, memSpeedMhz, memSticks);

    // ── Hardware fingerprint: detect machine swap with same wallet ────────────
    const currentWallet = walletAddressCache.address || '';
    const hwDescriptor = {
      cpuModel,
      gpuModels: normalizeGpuFingerprintValue(hwIdentity.gpuModels),
      memType,
      memSpeedMhz,
      memSticks,
    };
    const storedFp = loadHwFingerprint();
    if (storedFp && currentWallet) {
      const changeDetails = formatHardwareChangeList(storedFp, hwDescriptor);
      const fpChanged = changeDetails.length > 0;
      if (fpChanged && storedFp.walletAddress === currentWallet) {
        const detailText = changeDetails.join('; ');
        hwAuthority.hwChangedBlocked = true;
        console.warn(`[hwFingerprint] Hardware change on same wallet - contributions blocked. ${detailText}`);
        return {
          ok: false,
          hwChanged: true,
          hwChangedBlocked: true,
          changeDetails,
          message: `Hardware changed on this wallet: ${detailText}. Use Reset Hardware to accept the new hardware and rebuild the local benchmark baseline.`,
        };
      }
      if (fpChanged) {
        // Hardware changed and wallet also changed — accept as a new installation.
        // Clear benchmark history so the new hardware starts accumulating fresh samples.
        console.log('[hwFingerprint] Hardware change with new wallet - fingerprint updated, history cleared.');
        saveHwFingerprint({ ...hwDescriptor, walletAddress: currentWallet });
        clearBenchmarkHistory();
      } else if (storedFp.walletAddress && storedFp.walletAddress !== currentWallet) {
        // Wallet changed on same hardware — update fingerprint. No penalty: users
        // are permitted to use multiple wallet addresses on the same machine.
        saveHwFingerprint({ ...hwDescriptor, walletAddress: currentWallet });
        console.log(
          `[hwFingerprint] Wallet changed on same hardware. ` +
            `Previous: ${storedFp.walletAddress} -> Current: ${currentWallet}`,
        );
      }
      hwAuthority.hwChangedBlocked = false;
    } else if (!storedFp && currentWallet) {
      saveHwFingerprint({ ...hwDescriptor, walletAddress: currentWallet });
    }

    // ── Per-device benchmark history (personal mean calibration) ────────────
    // Stored in userData (device-scoped), not keyed by wallet address.
    // History is cleared when hardware changes (fingerprint detects new device).
    const benchmarkHistory = loadBenchmarkHistory();
    if (measuredCpu > 0) benchmarkHistory.cpuSamples = appendBenchmarkSample(benchmarkHistory.cpuSamples, measuredCpu);
    if (measuredMem > 0) benchmarkHistory.memSamples = appendBenchmarkSample(benchmarkHistory.memSamples, measuredMem);
    // Jitter history: accumulate per-device jitter samples (rolling 20) so the attestation
    // handler can adapt the threshold to this machine's natural OS-scheduler variance.
    // Jitter is [0,1]; outlier rejection reuses the same logic as cpu/mem but with
    // a tighter upper cap (jitter > 1.0 is nonsensical, so we clamp to 1.0 first).
    const measuredJitter = Math.min(1.0, Math.max(0, Number(result.jitterRatio) || 0));
    if (measuredJitter > 0) {
      benchmarkHistory.jitterSamples = appendBenchmarkSample(benchmarkHistory.jitterSamples, measuredJitter);
    }
    if (benchmarkHistory.jitterSamples.length >= 2) {
      hwAuthority.rollingJitterMean =
        benchmarkHistory.jitterSamples.reduce((a, b) => a + b, 0) / benchmarkHistory.jitterSamples.length;
    }

    // Use personal mean (blended with table value) as reference once enrolled.
    // Before HISTORY_ENROLL_COUNT samples the table value is used unchanged.
    // Anti-spoofing floor: once ≥ 4 personal samples exist the reference is always
    // at least the personal mean — a renderer declaring a weaker CPU/mem model to
    // inflate the ratio cannot gain more than the machine actually measured.
    const personalCpuMean =
      benchmarkHistory.cpuSamples.length >= 4
        ? benchmarkHistory.cpuSamples.reduce((a, b) => a + b, 0) / benchmarkHistory.cpuSamples.length
        : 0;
    const personalMemMean =
      benchmarkHistory.memSamples.length >= 4
        ? benchmarkHistory.memSamples.reduce((a, b) => a + b, 0) / benchmarkHistory.memSamples.length
        : 0;
    const referenceCpu = Math.max(getPersonalReference(benchmarkHistory.cpuSamples, expectedCpu), personalCpuMean);
    const referenceMem = Math.max(getPersonalReference(benchmarkHistory.memSamples, expectedMem), personalMemMean);

    // Benchmark consistency signal against declared profile.
    // If declared model is much weaker/stronger than measured throughput,
    // this contributes an additional anti-spoofing signal.
    let cpuDeclaredInconsistent = false;
    if (expectedDeclaredCpu > 0 && measuredCpu > 0) {
      const declaredCpuRatio = measuredCpu / expectedDeclaredCpu;
      cpuDeclaredInconsistent = declaredCpuRatio < 0.6 || declaredCpuRatio > 1.7;
    }
    let memDeclaredInconsistent = false;
    if (expectedMem > 0 && measuredMem > 0) {
      const declaredMemRatio = measuredMem / expectedMem;
      memDeclaredInconsistent = declaredMemRatio < 0.5 || declaredMemRatio > 1.9;
    }
    benchmarkConsistencySignal = cpuDeclaredInconsistent || memDeclaredInconsistent;

    const identitySignalCount = [cpuModelMismatch, gpuModelMismatch, deviceTypeMismatch].filter(Boolean).length;
    mismatchSignalCount = identitySignalCount + (benchmarkConsistencySignal ? 1 : 0);
    anyHwMismatch = identitySignalCount >= 2 || (identitySignalCount >= 1 && benchmarkConsistencySignal);

    if (identitySignalCount > 0 && !anyHwMismatch) {
      console.warn(
        `[HW-Verify] Identity mismatch not confirmed (signals=${mismatchSignalCount}): ` +
          `cpu=${cpuModelMismatch}, gpu=${gpuModelMismatch}, device=${deviceTypeMismatch}, benchmark=${benchmarkConsistencySignal}`,
      );
    } else if (anyHwMismatch) {
      console.warn(
        `[HW-Verify] Multi-signal hardware mismatch confirmed (signals=${mismatchSignalCount}): ` +
          `cpu=${cpuModelMismatch}, gpu=${gpuModelMismatch}, device=${deviceTypeMismatch}, benchmark=${benchmarkConsistencySignal}`,
      );
    }

    if (referenceCpu > 0 && measuredCpu > 0) {
      const ratio = measuredCpu / referenceCpu;
      hwAuthority.benchmarkOpsCalibration = Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * ratio));
    } else if (referenceCpu === 0) {
      // Unknown CPU and no personal history — conservative fallback.
      hwAuthority.benchmarkOpsCalibration = Math.min(hwAuthority.benchmarkOpsCalibration, 0.8);
    }
    if (referenceMem > 0 && measuredMem > 0) {
      const ratio = measuredMem / referenceMem;
      hwAuthority.benchmarkMemCalibration = Math.min(1.2, Math.max(0.2, 0.5 + 0.5 * ratio));
    } else if (referenceMem === 0) {
      // Unknown memory and no personal history — conservative fallback.
      hwAuthority.benchmarkMemCalibration = Math.min(hwAuthority.benchmarkMemCalibration, 0.8);
    }

    saveBenchmarkHistory(benchmarkHistory);

    // ── Contribution power ceiling (authoritative) ────────────────────────────
    // Renderer declares its hardware unit TDP; main applies the calibration factor
    // it independently verified.  Trust factor is applied at addContribution time
    // so trust changes take effect immediately without re-running the benchmark.
    // Using min(opsCalib, memCalib) penalises hardware that underperforms on either
    // dimension — a high GPU machine with slow CPU still gets a conservative cap.
    //
    // Hard cap: 600 W covers even the most power-hungry consumer GPU (RTX 4090 ≈ 450 W)
    // with headroom for future hardware.  This prevents a patched renderer from
    // sending arbitrary large values (e.g. 1 000 000 W) to inflate the ceiling.
    // ASICs can draw 3000–4000 W, so allow up to 5000 W when the device is an ASIC.
    const _declaredDeviceTypeForCap = String((request && request.declaredDeviceType) || '').toLowerCase();
    const _isAsicDevice = /asic/i.test(_declaredDeviceTypeForCap);
    const MAX_DECLARED_UNIT_POWER_W = _isAsicDevice ? 5000 : 600;
    let declaredUnitPowerW = Math.min(
      MAX_DECLARED_UNIT_POWER_W,
      Math.max(0, Number((request && request.declaredUnitPowerW) || 0)),
    );

    // ── Hardware mismatch: trust penalty + authoritative TDP re-lookup ───────
    // If the OS-level hardware identity doesn't match what the renderer declared,
    // apply a -20 trust penalty (once per mismatch detection) and fetch the real
    // TDP from Brave Answers to clamp the declared power.
    if (anyHwMismatch && !isBaseline) {
      const penaltyBefore = hwAuthority.trustScore;
      hwAuthority.trustScore = Math.max(0, hwAuthority.trustScore - 20);
      console.warn(
        `[HW-Verify] Hardware mismatch penalty: trust ${penaltyBefore} -> ${hwAuthority.trustScore}` +
          `${cpuModelMismatch ? ' [CPU]' : ''}${gpuModelMismatch ? ' [GPU]' : ''}${deviceTypeMismatch ? ' [DeviceType]' : ''}`,
      );

      // Fetch real TDP for the OS-identified components via Brave and clamp.
      // No tolerance margin: mismatch already proves dishonesty — no OC headroom.
      try {
        // CPU TDP clamp.
        if (cpuModelMismatch && osCpuModel) {
          const realCpuTdp = await fetchTdpFromBrave(osCpuModel);
          if (realCpuTdp !== null) {
            if (declaredUnitPowerW > realCpuTdp) {
              console.warn(
                `[HW-Verify] CPU TDP clamp: declared=${declaredUnitPowerW}W, real(Brave)=${realCpuTdp}W -> capped to ${realCpuTdp}W`,
              );
              declaredUnitPowerW = realCpuTdp;
            }
          } else {
            console.warn(
              `[HW-Verify] Brave TDP lookup failed for CPU "${osCpuModel}" -- using calibration-only fallback`,
            );
          }
        }

        // GPU TDP clamp (if GPU was misrepresented and we have an OS-level model).
        if (gpuModelMismatch && hwIdentity.gpuModels.length > 0) {
          const primaryGpu = hwIdentity.gpuModels[0];
          const realGpuTdp = await fetchTdpFromBrave(primaryGpu);
          if (realGpuTdp !== null) {
            if (declaredUnitPowerW > realGpuTdp) {
              console.warn(
                `[HW-Verify] GPU TDP clamp: declared=${declaredUnitPowerW}W, real(Brave)=${realGpuTdp}W -> capped to ${realGpuTdp}W`,
              );
              declaredUnitPowerW = realGpuTdp;
            }
          } else {
            console.warn(
              `[HW-Verify] Brave TDP lookup failed for GPU "${primaryGpu}" -- using calibration-only fallback`,
            );
          }
        }

        // Laptop TDP clamp: if the device is really a laptop but declared as PC,
        // fetch the real system TDP from Brave using the OS-reported CPU model.
        // Falls back to the laptop profile maxCapW (130 W) only if Brave fails.
        if (deviceTypeMismatch && /laptop/i.test(hwIdentity.deviceType)) {
          let laptopCap = null;
          if (osCpuModel) {
            const laptopTdp = await fetchTdpFromBrave(osCpuModel);
            if (laptopTdp !== null) laptopCap = laptopTdp;
          }
          if (laptopCap === null) laptopCap = 35; // conservative laptop fallback
          if (declaredUnitPowerW > laptopCap) {
            console.warn(
              `[HW-Verify] Laptop TDP clamp: declared=${declaredUnitPowerW}W -> capped to ${laptopCap}W (device is laptop${laptopCap !== 130 ? ', Brave lookup' : ', fallback'})`,
            );
            declaredUnitPowerW = laptopCap;
          }
        }

        // ASIC TDP lookup: if the renderer declared an ASIC model, look up its
        // real power via Brave and clamp the declared value to the lookup result.
        // Also fall back to the local ASIC power table if Brave is unavailable.
        if (_isAsicDevice) {
          const declaredGpuModel = String((request && request.declaredGpuModel) || '');
          if (declaredGpuModel) {
            const realAsicPower = await fetchTdpFromBrave(declaredGpuModel);
            if (realAsicPower !== null) {
              if (declaredUnitPowerW !== realAsicPower) {
                console.warn(
                  `[HW-Verify] ASIC TDP clamp: declared=${declaredUnitPowerW}W, real(Brave)=${realAsicPower}W -> set to ${realAsicPower}W`,
                );
                declaredUnitPowerW = realAsicPower;
              }
            } else {
              // Brave lookup failed — fall back to local ASIC power table.
              const tablePower = getAsicPowerW(declaredGpuModel);
              if (tablePower > 0 && declaredUnitPowerW !== tablePower) {
                console.warn(
                  `[HW-Verify] ASIC TDP table fallback: declared=${declaredUnitPowerW}W, table=${tablePower}W -> set to ${tablePower}W`,
                );
                declaredUnitPowerW = tablePower;
              }
            }
          }
        }
      } catch (e) {
        console.warn(`[HW-Verify] TDP re-lookup error: ${e && e.message}`);
      }
      saveHwAuthState();
    }

    // ── VM detection: block mining entirely ─────────────────────────────────
    // VMs can spoof CPUID, SMBIOS, and GPU identity — all OS-level checks
    // become unreliable.  A VM has no physical power draw (the host bears the
    // energy cost), so allowing VM mining undermines the entire energy model.
    if (hwIdentity.isVM) {
      console.warn(`[HW-Verify] VM detected (${hwIdentity.vmType}) -- mining blocked.`);
      return {
        ok: false,
        vmDetected: true,
        vmType: hwIdentity.vmType,
        message: 'Mining is not supported in virtual machines. Please run Wattcoin on bare-metal hardware.',
      };
    }

    // ── Power vs CPU cross-check: catch fake ASIC declarations ──────────────
    // A genuine ASIC miner has a weak embedded ARM controller (<150M ops/sec CPU
    // benchmark).  If a device claims to be an ASIC (5000W ceiling) but its CPU
    // benchmarks like a desktop processor (>150M ops/sec), it is almost certainly
    // a regular PC pretending to be an ASIC to inflate its power ceiling.
    // Recalculate the actual desktop power from the real CPU + GPU TDP instead
    // of clamping to an arbitrary ceiling.
    let powerVsCpuOverride = false;
    if (_isAsicDevice && measuredCpu > 150_000_000) {
      const previousCap = declaredUnitPowerW;
      let realDesktopPowerW = 0;
      // Look up CPU TDP from the OS-detected model.
      if (osCpuModel) {
        const cpuTdp = await fetchTdpFromBrave(osCpuModel);
        if (cpuTdp !== null) realDesktopPowerW += cpuTdp;
      }
      // Look up GPU TDP from OS-detected GPU models.
      if (hwIdentity.gpuModels.length > 0) {
        for (const gpuModel of hwIdentity.gpuModels) {
          const gpuTdp = await fetchTdpFromBrave(gpuModel);
          if (gpuTdp !== null) realDesktopPowerW += gpuTdp;
        }
      }
      // If both lookups failed, estimate from CPU benchmark (≈ 1 W per 1M ops/sec sustained).
      if (realDesktopPowerW === 0) {
        realDesktopPowerW = Math.round(measuredCpu / 2_000_000);
      }
      // Clamp to a realistic desktop maximum as safety floor.
      declaredUnitPowerW = Math.min(Math.max(realDesktopPowerW, 65), 600);
      powerVsCpuOverride = true;
      console.warn(
        `[HW-Verify] Power/CPU override: declared ASIC with CPU=${(measuredCpu / 1e6).toFixed(0)}M ops/sec ` +
          `> 150M — reclassified as non-ASIC, actual desktop power calculated as ${declaredUnitPowerW}W (Brave)${realDesktopPowerW === 0 ? ', fallback estimate' : ''} from ${previousCap}W declared`,
      );
    }

    // ── ASIC API liveness check: verify the hash boards exist and respond ────
    // Only run when the device claims ASIC.  We connect to the cgminer-compatible
    // API (localhost:4028-4030) and send a multi-round hash challenge.  Real hash
    // boards return correct results in < 500 ms; absent or faked hardware fails
    // or takes orders of magnitude longer.
    let asicLivenessFailed = false;
    let asicModelMismatch = false;
    let asicHashrateLow = false;
    let asicFirmwareIssue = false;
    const _declaredAsicModel = String((request && request.declaredGpuModel) || '');
    if (_isAsicDevice) {
      const livenessResult = await verifyAsicLiveness(_declaredAsicModel);
      if (!livenessResult.ok) {
        asicLivenessFailed = true;
        // Liveness failure alone doesn't override the ceiling — the CPU bench
        // already provides calibration.  But it IS a trust issue.
        console.warn(
          `[HW-Verify] ASIC liveness check failed for ${_declaredAsicModel || 'unknown'}` +
            ` — no cgminer API response on ports 4028-4030`,
        );
      } else if (livenessResult.elapsedMs > 500) {
        // Responded but too slow for real hash boards — likely software hashing.
        asicLivenessFailed = true;
        console.warn(
          `[HW-Verify] ASIC liveness check too slow: ${livenessResult.elapsedMs}ms for ` +
            `${livenessResult.bytesTotal} bytes (threshold 500ms)`,
        );
      } else {
        console.log(`[HW-Verify] ASIC liveness OK: ${livenessResult.elapsedMs}ms on port ${livenessResult.port}`);
        // ── ASIC model verification: compare API-reported model against declared ─
        // A miner declaring a high-end ASIC (e.g. S21 XP, 3800W) while running
        // a low-end unit (e.g. S9, 1350W) would inflate their power ceiling.
        // The cgminer API returns the actual device type — verify it matches.
        const reportedModel = (livenessResult.asicType || '').trim();
        if (reportedModel && _declaredAsicModel && !hardwareModelsMatch(reportedModel, _declaredAsicModel)) {
          asicModelMismatch = true;
          // Look up the real model's TDP and clamp the ceiling.
          const realTdp = await fetchTdpFromBrave(reportedModel);
          if (realTdp !== null && declaredUnitPowerW > realTdp) {
            console.warn(
              `[HW-Verify] ASIC model mismatch: declared="${_declaredAsicModel}", ` +
                `API reports="${reportedModel}" — clamping TDP from ${declaredUnitPowerW}W to ${realTdp}W`,
            );
            declaredUnitPowerW = realTdp;
          } else {
            const tableTdp = getAsicPowerW(reportedModel);
            if (tableTdp > 0 && declaredUnitPowerW > tableTdp) {
              console.warn(
                `[HW-Verify] ASIC model mismatch: declared="${_declaredAsicModel}", ` +
                  `API reports="${reportedModel}" — clamping TDP from ${declaredUnitPowerW}W to ${tableTdp}W (table)`,
              );
              declaredUnitPowerW = tableTdp;
            } else {
              // No TDP data for the real model — apply a conservative 20% penalty.
              const penalty = Math.round(declaredUnitPowerW * 0.8);
              console.warn(
                `[HW-Verify] ASIC model mismatch: declared="${_declaredAsicModel}", ` +
                  `API reports="${reportedModel}" — no TDP data, applying 20% penalty: ${declaredUnitPowerW}W → ${penalty}W`,
              );
              declaredUnitPowerW = penalty;
            }
          }
        }
        // ── ASIC hashrate benchmark: query summary command and compare ───────────
        // Query the cgminer summary command for the actual hashrate and verify it
        // is consistent with the declared model.  A large deficit indicates either
        // a model mismatch or severe undervolting.
        let measuredHashrateTHs = 0;
        const _expectedHashrateTHs = getAsicHashrateTHs(_declaredAsicModel);
        const livenessPort = livenessResult.port;
        if (_expectedHashrateTHs > 0) {
          try {
            const ctrl = new AbortController();
            const to = setTimeout(() => ctrl.abort(), 10000);
            let r;
            try {
              r = await fetch(`http://127.0.0.1:${livenessPort}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: 'summary' }),
                signal: ctrl.signal,
              });
            } finally {
              clearTimeout(to);
            }
            const json = await r.json();
            const summary = json && json.SUMMARY && json.SUMMARY[0];
            if (summary) {
              const ghsAv = parseFloat(summary['GHS av'] || 0);
              const ghs5s = parseFloat(summary['GHS 5s'] || 0);
              const mhsAv = parseFloat(summary['MHS av'] || 0);
              const mhs5s = parseFloat(summary['MHS 5s'] || 0);
              measuredHashrateTHs = Math.max(ghsAv, ghs5s) / 1000 || Math.max(mhsAv, mhs5s) / 1_000_000;
            }
          } catch (_e) {
            // Summary command failed — non-fatal, probes will re-check.
          }
          const ASIC_MIN_HASHRATE_RATIO = 0.85;
          if (measuredHashrateTHs > 0 && measuredHashrateTHs < _expectedHashrateTHs * ASIC_MIN_HASHRATE_RATIO) {
            asicHashrateLow = true;
            console.warn(
              `[HW-Verify] ASIC hashrate too low: ${measuredHashrateTHs.toFixed(1)} TH/s measured, ` +
                `expected >= ${(_expectedHashrateTHs * ASIC_MIN_HASHRATE_RATIO).toFixed(1)} TH/s ` +
                `for "${_declaredAsicModel}" — hash boards may be underperforming or misidentified`,
            );
          } else if (measuredHashrateTHs > 0) {
            console.log(
              `[HW-Verify] ASIC hashrate OK: ${measuredHashrateTHs.toFixed(1)} TH/s ` +
                `(expected ${_expectedHashrateTHs} TH/s for "${_declaredAsicModel}")`,
            );
          }
        }
        // Set the hardware spec for the periodic ASIC probe system so subsequent
        // probes can verify the hashrate is still consistent with the model.
        setAsicHardwareSpec({
          asicHashrateTHs: _expectedHashrateTHs || measuredHashrateTHs || 0,
          asicModel: _declaredAsicModel || livenessResult.asicType || 'unknown',
        });
        // ── ASIC firmware attestation: cross-reference multiple API commands ──────
        // Query version and stats commands and verify they all report the same model
        // identity.  A patched firmware must consistently lie across every endpoint.
        const firmwareAttest = await verifyAsicFirmware(livenessPort, livenessResult.asicType, _declaredAsicModel);
        if (!firmwareAttest.ok) {
          asicFirmwareIssue = true;
          console.warn(`[HW-Verify] ASIC firmware attestation failed: ${firmwareAttest.issues.join(', ')}`);
        }
      }
    }

    if (declaredUnitPowerW > 0) {
      const _allowGpuCalib = !!(request && request.allowGpuWorkloads);

      // ── GPU TDP from native binary (authoritative — renderer cannot forge) ─
      // The native gpu-miner.exe reports the GPU adapter name from DXGI.
      // We look up its TDP from hardware-tables.cjs and use it to cap the
      // GPU component of declaredUnitPowerW, ignoring whatever the renderer
      // claimed.
      hwAuthority.nativeGpuTdpW = 0;
      if (_allowGpuCalib) {
        try {
          const gpuNativeInfo = getGpuInfo();
          if (gpuNativeInfo && gpuNativeInfo.adapter) {
            const nativeTdp = getGpuTdpW(gpuNativeInfo.adapter);
            if (nativeTdp > 0) {
              hwAuthority.nativeGpuTdpW = nativeTdp;
              console.log(
                `[HW-Verify] Native GPU TDP: ${nativeTdp}W (${gpuNativeInfo.adapter}) ` +
                  `declared total=${declaredUnitPowerW}W`,
              );
              // If declared total exceeds a plausible CPU+GPU+memory overhead,
              // cap it. Plausible max = native GPU TDP + 300W (generous CPU+mem).
              const plausibleMax = nativeTdp + 300;
              if (declaredUnitPowerW > plausibleMax) {
                console.warn(
                  `[HW-Verify] Declared power ${declaredUnitPowerW}W exceeds plausible ` +
                    `max ${plausibleMax}W (GPU ${nativeTdp}W + 300W CPU/mem) — capping`,
                );
                declaredUnitPowerW = plausibleMax;
              }
            }
          }
        } catch (_) {
          // Native binary not available — ignore
        }
      }

      // All devices including ASICs use the same benchmark-based calibration factor.
      // ASIC controllers have limited compute, so the calibration naturally reflects
      // the hardware's proven capability. Unknown ASICs get a conservative 0.8× cap
      // until personal history builds.
      const calibFactor = Math.min(
        hwAuthority.benchmarkOpsCalibration,
        hwAuthority.benchmarkMemCalibration,
        _allowGpuCalib ? hwAuthority.benchmarkGpuCalibration : 1.0,
      );
      hwAuthority.calibratedUnitPowerW = Math.round(declaredUnitPowerW * calibFactor);
    }

    // ── Network anomaly detection ──────────────────────────────────────────
    // Record this miner's stats and check if they are a statistical outlier
    // compared to all other miners seen by this node.
    const _minerAddrForStats = walletAddressCache.address || '';
    if (_minerAddrForStats && !isBaseline && measuredCpu > 0 && declaredUnitPowerW > 0) {
      recordMinerStats(_minerAddrForStats, declaredUnitPowerW, measuredCpu);
    }
    const minerIsOutlier =
      _minerAddrForStats &&
      !isBaseline &&
      measuredCpu > 0 &&
      declaredUnitPowerW > 0 &&
      isPowerCpuOutlier(_minerAddrForStats, declaredUnitPowerW, measuredCpu);

    // ── Trust cap: no benchmark history → max trust 50 ───────────────────────
    // A device that has never completed a full CPU benchmark cannot earn trust
    // beyond the neutral default.  This prevents someone from accumulating trust
    // through contributions alone without proving their hardware capability.
    if (benchmarkHistory.cpuSamples.length === 0) {
      hwAuthority.trustScore = Math.min(hwAuthority.trustScore, 50);
    }

    // ── Trust score (authoritative — main process owns, not localStorage) ──────
    // Backend proof flags are checked here in addition to any renderer-reported issues.
    const trustScoreBefore = hwAuthority.trustScore;
    if (!isBaseline) {
      const rendererIssues = Array.isArray(result.issues) ? result.issues : [];
      const backendFail = result.cpuSpeedProofVerified === false || result.memProofVerified === false;
      const _allowGpu = !!(request && request.allowGpuWorkloads);
      const gpuProofFail = _allowGpu && result.gpuProofVerified === false && result.gpuProofHash;
      const allIssues = [
        ...rendererIssues,
        ...(backendFail ? ['backend proof integrity failed'] : []),
        ...(gpuProofFail ? ['gpu proof failed verification'] : []),
        ...(anyHwMismatch ? ['hardware identity mismatch (OS ≠ renderer)'] : []),
        ...(powerVsCpuOverride ? ['power/cpu mismatch — fake ASIC declaration'] : []),
        ...(asicLivenessFailed ? ['asic liveness check failed — hash boards unresponsive'] : []),
        ...(asicModelMismatch ? ['asic model mismatch — declared model does not match hash board'] : []),
        ...(asicHashrateLow ? ['asic hashrate too low — hash boards underperforming or misidentified'] : []),
        ...(asicFirmwareIssue
          ? ['asic firmware attestation failed — multiple API endpoints report conflicting device identity']
          : []),
        ...(minerIsOutlier ? ['network outlier — power/cpu ratio >3σ from mean'] : []),
      ];
      if (allIssues.length > 0) {
        hwAuthority.consecutiveCleanBenchmarks = 0;
        // Note: the -20 mismatch penalty was already applied above; normal
        // per-issue penalty only covers the remaining issues to avoid double-counting.
        const alreadyPenalised = new Set(['hardware identity mismatch (OS ≠ renderer)']);
        const nonMismatchIssues = allIssues.filter((i) => !alreadyPenalised.has(i));
        if (nonMismatchIssues.length > 0) {
          hwAuthority.trustScore = Math.max(0, hwAuthority.trustScore - nonMismatchIssues.length);
        }
      } else {
        hwAuthority.consecutiveCleanBenchmarks += 1;
        if (hwAuthority.consecutiveCleanBenchmarks >= 5) {
          hwAuthority.consecutiveCleanBenchmarks = 0;
          hwAuthority.trustScore = Math.min(100, hwAuthority.trustScore + 1);
        }
      }
      if (hwAuthority.trustScore <= 0 && hwAuthority.hwHoldUntilMs <= Date.now()) {
        hwAuthority.hwHoldUntilMs = Date.now() + 24 * 60 * 60 * 1000;
      }
      saveHwAuthState();
    }
    // Include trust snapshot in the result so the renderer can display the delta
    // without duplicating the trust computation.
    const _cpuSamples = benchmarkHistory.cpuSamples;
    const _memSamples = benchmarkHistory.memSamples;
    result = Object.assign({}, result, {
      trustScoreBefore,
      trustScoreAfter: hwAuthority.trustScore,
      historySamples: _cpuSamples.length,
      personalMeanCpu: _cpuSamples.length >= 2 ? _cpuSamples.reduce((a, b) => a + b, 0) / _cpuSamples.length : 0,
      personalMeanMem: _memSamples.length >= 2 ? _memSamples.reduce((a, b) => a + b, 0) / _memSamples.length : 0,
    });
  }
  return result;
});

ipcMain.handle('wattcoin-get-pending-probe', () => {
  return getPendingProbe();
});

ipcMain.handle('wattcoin-submit-probe-result', (_event, result = {}) => {
  return submitProbeResult(result || {});
});

ipcMain.handle('wattcoin-get-probe-history', () => {
  return getProbeHistory();
});

ipcMain.handle('wattcoin-get-attest-history', () => {
  return getAttestHistory();
});

// ── Probe log persistence ──────────────────────────────────────────────────────
// The renderer probe log is persisted to userData so entries survive restarts.
// Capped at 500 entries on save; renderer may further cap at 150 for display.
const PROBE_LOG_FILE_NAME = 'probe-log.json';
function getProbeLogFilePath() {
  return path.join(app.getPath('userData'), PROBE_LOG_FILE_NAME);
}

ipcMain.handle('wattcoin-get-probe-log', () => {
  try {
    const raw = fs.readFileSync(getProbeLogFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (_) {
    return { ok: true, entries: [] };
  }
});

ipcMain.handle('wattcoin-save-probe-log', (_event, entries) => {
  try {
    if (!Array.isArray(entries)) return { ok: false };
    // Sanitise each entry: only allow plain objects with string/number/boolean values,
    // clamping any string field to 512 characters to prevent unbounded memory/disk use.
    const MAX_STR_LEN = 512;
    const sanitised = entries
      .slice(0, 500)
      .map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
        const clean = {};
        for (const [k, v] of Object.entries(entry)) {
          if (typeof v === 'string') clean[k] = v.slice(0, MAX_STR_LEN);
          else if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
          // drop nested objects, arrays, null — keep the log flat and safe
        }
        return clean;
      })
      .filter(Boolean);
    fs.writeFileSync(getProbeLogFilePath(), JSON.stringify({ entries: sanitised }), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// ── Wallet-bound fingerprint (item 6) ─────────────────────────────────────────
// Fingerprint is stored in userData (not localStorage) so clearing browser storage
// cannot reset cross-session drift detection.  The file is HMAC-signed using the
// wallet address as key so tampering is detectable.
const FINGERPRINT_FILE_NAME = 'fingerprint.json';
function getFingerprintFilePath() {
  return path.join(getWalletDataDir(), FINGERPRINT_FILE_NAME);
}

ipcMain.handle('wattcoin-read-fingerprint', () => {
  try {
    const filePath = getFingerprintFilePath();
    if (!fs.existsSync(filePath)) return { ok: true, data: null };
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return { ok: true, data: parsed };
  } catch (_) {
    return { ok: true, data: null };
  }
});

ipcMain.handle('wattcoin-write-fingerprint', (_event, payload = {}) => {
  try {
    const filePath = getFingerprintFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data = payload && typeof payload === 'object' ? payload : {};
    // HMAC-sign using the per-install DPAPI-encrypted secret (same key as computeHwAuthSig).
    // Previously used the public wallet address as the key, which allowed an attacker who
    // knows the on-chain address to forge a valid sig — fixed to use the private secret.
    const dataStr = JSON.stringify({ ...data, sig: undefined }); // exclude sig before signing
    const sig = computeHwAuthSig({ _fpData: dataStr });
    fs.writeFileSync(filePath, JSON.stringify({ ...data, sig }, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'write failed' };
  }
});

// ── Hardware-bound device identity ────────────────────────────────────────────
// On first launch a 32-byte random secret is generated and stored in userData.
// The secret never leaves the device.  The publicaly shareable deviceId is
// SHA-256(secret) — 64 hex chars.  It is linked to the Wattcoin wallet address
// (which is the on-chain identity) at runtime so the binding is cryptographically
// provable without requiring any extra transaction.
const DEVICE_IDENTITY_FILE = 'device-identity.json';
function getDeviceIdentityFilePath() {
  return path.join(getWalletDataDir(), DEVICE_IDENTITY_FILE);
}
let _deviceIdentity = null; // in-memory cache after first load
let _deviceIdentitySecret = '';

function getDeviceIdentitySecret() {
  if (_deviceIdentitySecret) return _deviceIdentitySecret;
  const filePath = getDeviceIdentityFilePath();
  try {
    if (!fs.existsSync(filePath)) return '';
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && typeof raw.secret === 'string' && raw.secret.length >= 32) {
      _deviceIdentitySecret = raw.secret;
      return _deviceIdentitySecret;
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  return '';
}

/**
 * Get or create the wallet encryption key.
 * The key is a 32-byte value stored in the OS secure store (safeStorage).
 * On platforms where safeStorage is unavailable, falls back to a machine-derived
 * AES-256 key (same pattern as attestation-state encryption).
 */
let _walletEncryptionKey = null;

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

  // Generate a new key
  const newKey = crypto.randomBytes(32);
  const keyHex = newKey.toString('hex');

  // Primary: store via safeStorage
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

  // Fallback: derive from device-identity secret (same pattern as attestation fallback)
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

  // Last resort — random key, lost on restart (wallet will be re-created). Still better than plaintext.
  _walletEncryptionKey = newKey;
  return _walletEncryptionKey;
}

function loadOrCreateDeviceIdentity() {
  if (_deviceIdentity) return _deviceIdentity;
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
  _deviceIdentitySecret = typeof identity.secret === 'string' ? identity.secret : '';
  _deviceIdentity = {
    deviceId: identity.deviceId,
    createdAt: identity.createdAt,
    version: identity.version || 1,
    isNew,
  };
  return _deviceIdentity;
}

function persistDevPeerPrivacyRecoveryKey() {
  if (app.isPackaged) return '';
  const { buildPeerPrivacyRecoveryPayload, writePeerPrivacyRecoveryFile } = require('./peer-privacy-dev');
  const secret = getDeviceIdentitySecret();
  if (!secret) return '';
  const identity = loadOrCreateDeviceIdentity();
  const payload = buildPeerPrivacyRecoveryPayload({
    secret,
    deviceId: identity && identity.deviceId,
    createdAt: identity && identity.createdAt,
  });
  if (!payload) return '';
  return writePeerPrivacyRecoveryFile({ fs, baseDir: __dirname, payload });
}

ipcMain.handle('wattcoin-get-device-identity', () => {
  try {
    const id = loadOrCreateDeviceIdentity();
    // Attach wallet address as the on-chain link (available once wallet loads).
    const walletAddress = walletAddressCache.address || '';
    return { ok: true, deviceId: id.deviceId, createdAt: id.createdAt, isNew: id.isNew, walletAddress };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'Failed to read device identity.' };
  }
});

// ── Peer probe IPC (worker mode) ──────────────────────────────────────────────
// Renderer calls this to fetch a probe from the coordinator. Peer attestation is
// required and local fallback is disabled.
ipcMain.handle('wattcoin-request-peer-probe', async (_event, opts = {}) => {
  const settings = getLedgerNetworkSettings();
  if (!settings.enabled || settings.mode !== 'peer') {
    return { ok: false, error: 'Peer attestation is required but peer mode is not enabled.' };
  }

  const workerId = String((opts && opts.workerId) || walletAddressCache.address || 'unknown');
  const peers = await getOnlineAttestationPeers(settings, workerId);
  if (!peers || peers.length === 0) {
    return { ok: false, error: 'No online attestation peers available.' };
  }

  const candidatePeers = [...peers];
  const allowGpu = !!(opts && opts.allowGpuWorkloads);
  while (candidatePeers.length > 0) {
    const index = Math.floor(Math.random() * candidatePeers.length);
    const [peerUrl] = candidatePeers.splice(index, 1);
    try {
      const result = await requestPeerJson(
        peerUrl,
        'GET',
        '/api/v1/probe/issue',
        undefined,
        {
          workerId,
          allowGpu: String(allowGpu),
        },
        {
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'peer-probe-issue',
        },
      );
      const probe = result && result.probe ? result.probe : null;
      if (probe) probe._peerUrl = peerUrl;
      return { ok: true, source: 'peer', probe };
    } catch (e) {
      console.warn('[PeerProbe] Attestation peer unavailable, trying another peer:', e.message);
    }
  }

  return { ok: false, error: 'Online attestation peers became unavailable.' };
});

// Renderer calls this after completing a peer probe.
// Coordinator verification via /api/v1/probe/submit is required; local fallback is disabled.
ipcMain.handle('wattcoin-submit-peer-probe-result', async (_event, payload = {}) => {
  const settings = getLedgerNetworkSettings();
  const source = String((payload && payload.source) || 'peer');
  const result = payload && payload.result ? payload.result : {};
  const hardwareSpec = payload && typeof payload.hardwareSpec === 'object' ? payload.hardwareSpec : null;

  if (source === 'peer' && settings.enabled && settings.mode === 'peer') {
    const peerUrl = result._peerUrl ? String(result._peerUrl) : null;
    if (peerUrl) {
      try {
        const body = {
          probeId: result.id || '',
          proof: result.proof || '',
          pixelHash: result.pixelHash || '',
          hardwareSpec: hardwareSpec,
        };
        const verdict = await requestPeerJson(peerUrl, 'POST', '/api/v1/probe/submit', body, undefined, {
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'peer-probe-submit',
        });
        if (verdict && verdict.ok) {
          hwAuthority.peerProbeVerifiedForRound = true;
        }
        return verdict;
      } catch (e) {
        console.warn('[PeerProbe] Could not submit peer probe result:', e.message);
        return { ok: false, transient: true, issues: ['peer unreachable: ' + e.message] };
      }
    }
  }

  return {
    ok: false,
    error: 'Peer probe result submission requires peer mode and a valid attestation peer URL.',
  };
});

// ── Hardware-authority read-back (renderer uses for display only) ─────────────
const HW_RESET_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SEARCH_CACHE_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

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
    // True the very first time the app runs (no hw-auth-state.json exists yet).
    // Renderer should send its legacy localStorage trust value so it is migrated.
    isFirstRun: hwAuthStateIsNew,
  };
});

ipcMain.handle('wattcoin-clear-search-cache', () => {
  const now = Date.now();
  const cooldownRemainingMs = Math.max(0, hwAuthority.lastSearchCacheClearAtMs + SEARCH_CACHE_COOLDOWN_MS - now);
  if (cooldownRemainingMs > 0) {
    const remainingDays = Math.ceil(cooldownRemainingMs / (24 * 60 * 60 * 1000));
    console.warn(`[searchCache] Clear blocked — cooldown active, ${remainingDays}d remaining.`);
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
    console.warn(`[hwReset] Reset blocked — cooldown active, ${remainingDays}d remaining.`);
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

// One-shot migration: renderer sends its localStorage trust score the first time
// the app runs so legacy values survive the transition to the backend authority.
ipcMain.handle('wattcoin-seed-authority-state', (_event, payload = {}) => {
  if (!hwAuthStateIsNew) {
    // File already exists — ignore to prevent the renderer overwriting real data.
    return { ok: false, reason: 'not first run' };
  }
  const legacyTrust = Number(payload && payload.trustScore);
  const legacyHold = Number((payload && payload.hwHoldUntilMs) || 0);
  // Cap seeded value at 50 (the neutral default) — prevents an attacker from deleting
  // hw-auth-state.json and seeding an inflated trust score via a modified localStorage.
  if (Number.isFinite(legacyTrust) && legacyTrust >= 0 && legacyTrust <= 50) {
    hwAuthority.trustScore = legacyTrust;
  }
  if (legacyHold > Date.now()) {
    hwAuthority.hwHoldUntilMs = legacyHold;
  }
  hwAuthStateIsNew = false;
  saveHwAuthState();
  return { ok: true, trustScore: hwAuthority.trustScore };
});

// GPU calibration cannot be computed in the main process (WebGL requires renderer);
// renderer reports the raw score and this handler stores the ratio securely.
ipcMain.handle('wattcoin-report-gpu-calibration', async (_event, payload = {}) => {
  // Rate-limit: a compromised renderer must not be able to flood the personal-mean
  // sample buffer (capped at HISTORY_MAX_SAMPLES=20) with chosen values.
  const gpuActorId = walletAddressCache.address || 'local-client';
  const gpuRateLimit = await enforceEndpointRateLimit('wattcoin-report-gpu-calibration', gpuActorId, {});
  if (!gpuRateLimit.ok) {
    return { ok: gpuRateLimit.ok, personalMeanGpuRatio: 0 };
  }
  const gpuScore = Number((payload && payload.gpuScore) || 0);
  // Hard bounds on renderer-supplied maxExpectedScore.
  // Lower bound (300 K ops/ms): below any real GPU in the table — prevents a patched
  // renderer sending maxExpectedScore=1 to inflate the ratio to 10× (discard threshold).
  // Upper bound (5 B ops/ms): well above RTX 4090 table value (1.15 B) — prevents sending
  // an impossibly large value to deflate the ratio and claim calibration credit for nothing.
  const GPU_MAX_EXPECTED_SCORE_MIN = 300_000;
  const GPU_MAX_EXPECTED_SCORE_MAX = 5_000_000_000;
  const rawMaxExpected = Number((payload && payload.maxExpectedScore) || 0);
  const maxExpectedScore =
    rawMaxExpected > 0 ? Math.min(GPU_MAX_EXPECTED_SCORE_MAX, Math.max(GPU_MAX_EXPECTED_SCORE_MIN, rawMaxExpected)) : 0;
  if (maxExpectedScore > 0 && gpuScore > 0) {
    const rawRatio = gpuScore / maxExpectedScore;
    if (rawRatio <= 10.0) {
      // Per-device GPU history: store the raw ratio (gpuScore / maxExpectedScore).
      // The personal mean replaces 1.0 as the baseline once enough samples exist.
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

// Verify a GPU benchmark proof submitted by the renderer.
// computeGpuProbeExpectedHash runs the same XOR-shift algorithm in pure JS — bit-identical
// to the WebGL integer shader — so no GPU is needed on the main-process side.
ipcMain.handle('wattcoin-verify-gpu-proof', (_event, payload = {}) => {
  // Match the shader's seed guard: gl.uniform1i uses (seed | 0) || 1, so seed=0 → 1.
  const seed = Number(payload && payload.seed) | 0 || 1;
  const size = Math.max(1, Math.min(512, Number(payload && payload.size) || 128));
  const shaderIters = Math.max(1, Math.min(256, Number(payload && payload.shaderIterations) || 32));
  const submittedHash = String((payload && payload.proofHash) || '')
    .trim()
    .toLowerCase();
  if (!submittedHash || submittedHash.length !== 8) return { verified: false };
  const expectedHash = computeGpuProbeExpectedHash(seed, size, shaderIters);
  return { verified: submittedHash === expectedHash };
});

// Renderer signals a hardware hold should be activated (e.g. on extreme drift).
// Main process validates and records it so the hold persists across renderer reloads.
const HARDWARE_HOLD_MAX_DURATION_MS = 48 * 60 * 60_000; // 48-hour absolute cap
ipcMain.handle('wattcoin-activate-hardware-hold', (_event, payload = {}) => {
  // Hard cap: a compromised renderer cannot set an infinite or multi-year hold.
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

ipcMain.handle('wattcoin-attestation-issue-challenge', (_event, payload = {}) => {
  const minerId = payload && payload.minerId ? String(payload.minerId) : 'local-client';
  const hardwareSummary =
    payload && payload.hardwareSummary && typeof payload.hardwareSummary === 'object' ? payload.hardwareSummary : {};
  const identityAddress = payload && payload.identityAddress ? String(payload.identityAddress) : '';
  return issueBenchmarkChallenge(minerId, hardwareSummary, identityAddress);
});

ipcMain.handle('wattcoin-attestation-submit-proof', async (_event, payload = {}) => {
  return await submitBenchmarkProof(payload || {});
});

ipcMain.handle('wattcoin-attestation-get-policy', (_event, payload = {}) => {
  const minerId = payload && payload.minerId ? String(payload.minerId) : 'local-client';
  const hardwareSummary =
    payload && payload.hardwareSummary && typeof payload.hardwareSummary === 'object' ? payload.hardwareSummary : {};
  return {
    ok: true,
    policy: computePolicyForMiner(minerId, hardwareSummary, { allowSpotCheck: true }),
  };
});

ipcMain.handle('wattcoin-sign-attestation-message', (_event, payload = {}) => {
  const _walletName = 'wattminer';
  const address = String(payload && payload.address ? payload.address : '').trim();
  const message = String(payload && payload.message ? payload.message : '').trim();
  if (!address || !message) {
    return { ok: false, code: 'SIGN_INPUT_INVALID', message: 'Address and message are required.' };
  }
  if (wtcNode) {
    const isOwned = wtcNode.getAddresses().includes(address);
    if (!isOwned) {
      return { ok: false, code: 'ADDRESS_NOT_OWNED', message: 'Selected address is not owned by wallet.' };
    }
    try {
      const result = wtcNode.signMessage(address, message);
      return { ok: true, address, message, signature: result.signature };
    } catch (e) {
      return {
        ok: false,
        code: 'SIGN_FAILED',
        message: e && e.message ? e.message : 'Failed to sign attestation message.',
      };
    }
  }
  return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
});

ipcMain.handle('wattcoin-get-miner-access-policy', () => {
  const passwordRequired = isMinerPasswordRequired();
  return {
    ok: true,
    passwordRequired,
    mode: passwordRequired ? 'password' : 'open',
    message: passwordRequired
      ? 'Miner beta password is required before mining can start.'
      : 'No miner password is configured.',
  };
});

ipcMain.handle('wattcoin-get-beta-policy', () => {
  return {
    ok: true,
    ...getBetaPolicy(),
  };
});

ipcMain.handle('wattcoin-verify-miner-password', async (_event, passwordAttempt) => {
  const passwordRequired = isMinerPasswordRequired();
  if (!passwordRequired) {
    return { ok: true, passwordRequired: false, authorized: true, message: 'Password not required.' };
  }

  const expected = getMinerBetaPassword();
  const provided = typeof passwordAttempt === 'string' ? passwordAttempt : '';
  const authorized = secureStringEquals(provided, expected);
  if (!authorized) {
    await logAbuseEvent({
      type: 'auth-failure',
      endpoint: 'wattcoin-verify-miner-password',
      actorId: 'local-client',
      metadata: { reason: 'invalid-password' },
    });
  }
  return {
    ok: true,
    passwordRequired: true,
    authorized,
    message: authorized ? 'Miner unlocked.' : 'Invalid miner password.',
  };
});

ipcMain.handle('wattcoin-get-network-info', () => {
  return {
    ok: true,
    network: 'wtc-mainnet',
    chainSubdir: '',
    rpcPort: 0,
    explorerBaseUrl: '',
  };
});

// Safe external URL opener.
// Allows:
//   1. ethereum: EIP-681 payment request URIs (opened by the OS-registered wallet app)
//   2. https:// to known WTC explorer origins
const ALLOWED_EXTERNAL_ORIGINS = new Set([
  // Add your block explorer hostname(s) here when deployed.
  // e.g. 'explorer.wattcoin.io'
]);
// Known USDC token contract addresses we accept EIP-681 URIs for.
const ALLOWED_EIP681_CONTRACTS = new Set([
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC Ethereum mainnet
]);
ipcMain.handle('wattcoin-open-external-url', (_event, url) => {
  try {
    if (typeof url !== 'string') return { ok: false, reason: 'not a string' };
    const parsed = new URL(url);
    // Allow EIP-681 payment request URIs (ethereum:{contract}@{chain}/transfer?...)
    if (parsed.protocol === 'ethereum:') {
      // Validate it targets a known USDC contract to prevent arbitrary URI injection.
      // URL parses "ethereum:0xABC@1/transfer" with pathname "0xABC@1/transfer"
      const contractAddr = parsed.pathname.split('@')[0].toLowerCase();
      if (!ALLOWED_EIP681_CONTRACTS.has(contractAddr)) return { ok: false, reason: 'unknown contract' };
      shell.openExternal(url);
      return { ok: true };
    }
    if (parsed.protocol !== 'https:') return { ok: false, reason: 'only https or ethereum allowed' };
    if (!ALLOWED_EXTERNAL_ORIGINS.has(parsed.hostname)) return { ok: false, reason: 'hostname not in allowlist' };
    // Strip any fragment/query that isn't part of the expected path to reduce phishing surface.
    const safe = `https://${parsed.hostname}${parsed.pathname}`;
    shell.openExternal(safe);
    return { ok: true };
  } catch (_) {
    return { ok: false, reason: 'invalid url' };
  }
});

// Opens a temporary localhost payment page in the system browser.
// Chrome/Edge with MetaMask, Trust Wallet, Coinbase Wallet etc. will inject
// window.ethereum into the page and the user can approve the USDC transfer
// directly from their browser extension without leaving their wallet.
ipcMain.handle('wattcoin-open-pay-page', (_event, { usdcRequired, wtcAmount, sellerAddress }) => {
  try {
    if (typeof usdcRequired !== 'number' || typeof sellerAddress !== 'string') {
      return { ok: false, reason: 'invalid params' };
    }
    const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const safeAddr = sellerAddress.replace(/[^0-9a-fA-Fx]/g, '').toLowerCase();
    const amountUnits = Math.round(usdcRequired * 1_000_000);
    const eip681 = `ethereum:${USDC_CONTRACT}@1/transfer?address=${safeAddr}&uint256=${amountUnits}`;

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Pay with USDC \u2014 Wattcoin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#060d06;color:#e8f5e8;font-family:'Segoe UI',system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#0a1a0a;border:1px solid #2d4a2d;border-radius:18px;padding:32px 28px;max-width:420px;width:100%}
h1{color:#4ade80;font-size:18px;font-weight:700;margin-bottom:6px}
.sub{color:#6b9b6b;font-size:13px;margin-bottom:22px}
.amount{background:#0d1a0d;border:1px solid #1e3a1e;border-radius:10px;padding:14px 16px;font-size:20px;font-weight:700;color:#fcd34d;text-align:center;margin-bottom:20px}
.amount span{color:#a7ffb0}
.wallets{font-size:11px;color:#4a6a4a;text-align:center;margin-bottom:18px}
.btn{display:block;width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;margin-bottom:10px;transition:background .15s}
.btn-primary{background:#4ade80;color:#000}
.btn-primary:hover{background:#22c55e}
.btn-secondary{background:#1e3a1e;color:#a7ffb0;border:1px solid #2d4a2d}
.btn-secondary:hover{background:#253a25}
.status{margin-top:16px;padding:12px;border-radius:8px;font-size:13px;text-align:center;display:none;line-height:1.5}
.ok{display:block;background:#0d2a0d;border:1px solid #2d5a2d;color:#4ade80}
.err{display:block;background:#1a0a0a;border:1px solid #4a1a1a;color:#fca5a5}
</style></head>
<body><div class="card">
  <h1>Pay with USDC</h1>
  <p class="sub">Complete your Wattcoin purchase</p>
  <div class="amount">$${usdcRequired.toFixed(2)} USDC <span>&rarr; ${Number(wtcAmount).toLocaleString()} WTC</span></div>
  <p class="wallets">MetaMask &middot; Trust Wallet &middot; Coinbase Wallet &middot; Base &middot; any EIP-681 wallet</p>
  <button class="btn btn-primary" id="btn-ext">Pay with Wallet Extension</button>
  <div id="status"></div>
</div>
<script>
const SELLER='${safeAddr}';
const CONTRACT='${USDC_CONTRACT}';
const USDC=${usdcRequired};
const EIP681='${eip681}';
function show(type,msg){const s=document.getElementById('status');s.className='status '+type;s.textContent=msg;}
function showSuccess(hash){const s=document.getElementById('status');s.className='status ok';s.textContent='';const t=document.createElement('div');t.textContent='\u2713 Transaction submitted!';const h=document.createElement('small');h.style.wordBreak='break-all';h.style.color='#a7ffb0';h.textContent=hash.replace(/[^0-9a-fA-Fx]/g,'');const d=document.createElement('small');d.textContent='WTC will be delivered to your wallet once queued.';s.appendChild(t);s.appendChild(h);s.appendChild(d);}
function encData(to,amt){
  const data='0xa9059cbb'+to.replace(/^0x/,'').toLowerCase().padStart(64,'0')+BigInt(Math.round(amt*1000000)).toString(16).padStart(64,'0');
  return data;
}
async function pay(){
  if(!window.ethereum){
    window.location.href=EIP681;
    return;
  }
  const btn=document.getElementById('btn-ext');
  btn.disabled=true;btn.textContent='Connecting\u2026';
  try{
    const accounts=await window.ethereum.request({method:'eth_requestAccounts'});
    if(!accounts||!accounts[0])throw new Error('No account returned');
    btn.textContent='Check wallet\u2026';
    const chainId=await window.ethereum.request({method:'eth_chainId'});
    if(chainId!=='0x1'){
      show('err','Please switch your wallet to Ethereum Mainnet first, then try again.');
      btn.disabled=false;btn.textContent='Pay with Wallet Extension';return;
    }
    btn.textContent='Confirm in wallet\u2026';
    const hash=await window.ethereum.request({method:'eth_sendTransaction',params:[{from:accounts[0],to:CONTRACT,value:'0x0',data:encData(SELLER,USDC)}]});
    showSuccess(hash);
    btn.textContent='Payment Submitted';
  }catch(e){
    if(e&&e.code===4001){show('err','Transaction cancelled.');btn.disabled=false;btn.textContent='Pay with Wallet Extension';}
    else{show('err',e&&e.message?String(e.message).slice(0,200):'Unknown error');btn.disabled=false;btn.textContent='Pay with Wallet Extension';}
  }
}
document.getElementById('btn-ext').addEventListener('click',pay);
</script></body></html>`;

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      // Shut down after serving once (allow a second request for favicon etc.)
      setTimeout(() => {
        try {
          server.close();
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
      }, 3000);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      shell.openExternal(`http://127.0.0.1:${port}/`);
    });
    server.on('error', () => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-validate-address', (_event, addr) => {
  if (typeof addr !== 'string') return { ok: false, valid: false, reason: 'not a string' };
  const trimmed = addr.trim();
  if (!trimmed) return { ok: true, valid: false, reason: 'empty' };
  if (!trimmed.startsWith('wtc1q')) return { ok: true, valid: false, reason: 'must start with wtc1q' };
  if (trimmed.length !== 43) return { ok: true, valid: false, reason: `expected 43 chars, got ${trimmed.length}` };
  try {
    const valid = isValidWtcAddress(trimmed);
    return { ok: true, valid, reason: valid ? null : 'invalid checksum' };
  } catch (e) {
    return { ok: true, valid: false, reason: String(e && e.message) };
  }
});

// ── WTC Sale IPC handlers ─────────────────────────────────────────────────────

// Get sale status: sold WTC, tier info, seller USDC address
ipcMain.handle('wattcoin-sale-status', async (_event) => {
  const soldRaw = await saleQueue.refreshSoldWTC();
  const sold = Math.max(0, Math.min(saleQueue.SALE_TOTAL, Number(soldRaw) || 0));
  const poll = saleQueue.getLastPollStatus();
  return {
    ok: true,
    sellerUsdcAddress: saleQueue.SELLER_USDC_ADDRESS,
    saleWtcAddress: saleQueue.SALE_WTC_ADDRESS,
    sold: sold,
    remaining: Math.max(0, saleQueue.SALE_TOTAL - sold),
    total: saleQueue.SALE_TOTAL,
    tierSize: saleQueue.SALE_TIER_SIZE,
    tiers: saleQueue.SALE_TIERS,
    minBuy: saleQueue.MIN_BUY_WTC,
    lastEtherscanPoll: poll,
  };
});

// Compute USDC required for a given WTC amount at current electricity price
ipcMain.handle('wattcoin-sale-compute-price', async (_event, { wtcAmount, electricityPricePerKwh }) => {
  const amount = Number(wtcAmount);
  const elPrice = Number(electricityPricePerKwh);
  if (!Number.isFinite(amount) || amount < saleQueue.MIN_BUY_WTC) {
    return { ok: false, error: `Minimum ${saleQueue.MIN_BUY_WTC} WTC` };
  }
  if (!Number.isFinite(elPrice) || elPrice <= 0) {
    return { ok: false, error: 'Invalid electricity price' };
  }
  await saleQueue.refreshSoldWTC();
  const usdcRequired = saleQueue.computeUsdcRequired(amount, elPrice);
  return { ok: true, usdcRequired: Math.round(usdcRequired * 1e6) / 1e6 };
});

// Place an order (buyer is the logged-in WTC address)
ipcMain.handle('wattcoin-sale-place-order', (_event, { wtcAddress, wtcAmount, usdcRequired, buyerEthAddress }) => {
  // Basic input sanitisation
  const addr = typeof wtcAddress === 'string' ? wtcAddress.trim() : '';
  const amount = Number(wtcAmount);
  const usdc = Number(usdcRequired);

  if (!addr || !addr.startsWith('wtc1q') || addr.length !== 43) {
    return { ok: false, error: 'Invalid WTC address' };
  }
  return saleQueue.placeSaleOrder({
    wtcAddress: addr,
    wtcAmount: amount,
    usdcRequired: usdc,
    buyerEthAddress: typeof buyerEthAddress === 'string' ? buyerEthAddress.trim() : null,
  });
});

// Get a specific order status
ipcMain.handle('wattcoin-sale-get-order', (_event, orderId) => {
  const order = saleQueue.getOrder(String(orderId || ''));
  if (!order) return { ok: false, error: 'Order not found' };
  return { ok: true, order };
});

// Cancel a pending_payment order
ipcMain.handle('wattcoin-sale-cancel-order', (_event, orderId) => {
  return saleQueue.cancelOrder(String(orderId || ''));
});

// Get active orders (pending_payment + queued) for a WTC address
ipcMain.handle('wattcoin-sale-get-my-orders', (_event, wtcAddress) => {
  const addr = typeof wtcAddress === 'string' ? wtcAddress.trim() : '';
  return { ok: true, orders: saleQueue.getOrdersForAddress(addr) };
});

// Get total WTC purchased (fulfilled+queued+delivery_pending+payment_submitted) for an address
ipcMain.handle('wattcoin-sale-get-purchase-total', (_event, wtcAddress) => {
  const addr = typeof wtcAddress === 'string' ? wtcAddress.trim() : '';
  return { ok: true, total: saleQueue.getPurchaseTotalForAddress(addr) };
});

// Record the on-chain tx hash submitted via in-app wallet connect
ipcMain.handle('wattcoin-sale-confirm-payment', (_event, payload) => {
  const orderId = typeof (payload && payload.orderId) === 'string' ? payload.orderId.trim() : '';
  const txHash = typeof (payload && payload.txHash) === 'string' ? payload.txHash.trim() : '';
  if (!orderId || !txHash) return { ok: false, error: 'orderId and txHash required' };
  return saleQueue.setOrderTxHash(orderId, txHash);
});

// ── Staking queue IPC handlers ────────────────────────────────────────────────

// Status: pool balance, total pending staked, current APY
ipcMain.handle('wattcoin-staking-status', (_event) => {
  return {
    ok: true,
    poolAddress: stakingQueue.STAKING_POOL_ADDRESS,
    poolBalance: stakingQueue.poolBalance(),
    totalStaked: stakingQueue.totalPendingWtc(),
    currentApy: stakingQueue.currentApy(),
    flushThreshold: stakingQueue.FLUSH_THRESHOLD_WTC,
    minStake: stakingQueue.MIN_STAKE_WTC,
  };
});

// Place a staking entry
ipcMain.handle('wattcoin-staking-stake', (_event, { fromAddress, wtcAmount }) => {
  const addr = typeof fromAddress === 'string' ? fromAddress.trim() : '';
  const amount = Number(wtcAmount);
  if (!addr || !addr.startsWith('wtc1q') || addr.length !== 43) {
    return { ok: false, error: 'Invalid WTC address' };
  }
  if (!Number.isFinite(amount)) {
    return { ok: false, error: 'Invalid WTC amount' };
  }
  // Verify the user actually holds this WTC on-chain before allowing staking
  if (wtcNode) {
    try {
      const bal = wtcNode.getBalance(addr);
      const available = (bal.confirmed || 0) + (bal.unmatured || 0);
      if (Math.floor(amount) > available) {
        return { ok: false, error: `Insufficient balance. You have ${available.toLocaleString()} WTC in your wallet.` };
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }
  return stakingQueue.stakeWtc({ fromAddress: addr, wtcAmount: amount });
});

// Get a single entry by id
ipcMain.handle('wattcoin-staking-get-entry', (_event, entryId) => {
  const entry = stakingQueue.getEntry(String(entryId || ''));
  if (!entry) return { ok: false, error: 'Entry not found' };
  return { ok: true, entry };
});

// Get all staking entries for a wallet address
ipcMain.handle('wattcoin-staking-get-my-entries', (_event, address) => {
  const addr = typeof address === 'string' ? address.trim() : '';
  return { ok: true, entries: stakingQueue.getEntryForAddress(addr) };
});

// Cancel a pending staking entry
ipcMain.handle('wattcoin-staking-cancel', (_event, entryId) => {
  return stakingQueue.cancelEntry(String(entryId || ''));
});

// ── Vortex NFT IPC handlers ─────────────────────────────────────────────────────────

// List NFTs owned by an address
ipcMain.handle('wattcoin-nft-list', (_event, address) => {
  try {
    if (!wtcNode) return { ok: false, nfts: [] };
    const addr = typeof address === 'string' ? address.trim() : '';
    return { ok: true, nfts: wtcNode.getNftsForAddress(addr) };
  } catch (e) {
    return { ok: false, nfts: [], error: String(e && e.message) };
  }
});

// Get a single NFT by id
ipcMain.handle('wattcoin-nft-get', (_event, nftId) => {
  try {
    if (!wtcNode) return { ok: false, nft: null };
    const nft = wtcNode.getNft(String(nftId || ''));
    if (!nft) return { ok: false, error: 'NFT not found' };
    return { ok: true, nft };
  } catch (e) {
    return { ok: false, nft: null, error: String(e && e.message) };
  }
});

// Get the full 60-token collection with current ownership
ipcMain.handle('wattcoin-nft-collection', (_event) => {
  try {
    if (!wtcNode) return { ok: false, nfts: [] };
    return { ok: true, nfts: wtcNode.getAllNfts() };
  } catch (e) {
    return { ok: false, nfts: [], error: String(e && e.message) };
  }
});

// Transfer an NFT to another address
ipcMain.handle('wattcoin-nft-transfer', (_event, { nftId, fromAddress, toAddress }) => {
  try {
    if (!wtcNode) return { ok: false, error: 'Node not ready' };
    const id = typeof nftId === 'string' ? nftId.trim() : '';
    const from = typeof fromAddress === 'string' ? fromAddress.trim() : '';
    const to = typeof toAddress === 'string' ? toAddress.trim() : '';
    if (!id || !from || !to) return { ok: false, error: 'nftId, fromAddress, toAddress required' };
    return wtcNode.transferNft({ nftId: id, fromAddress: from, toAddress: to });
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
});

// ── Governance IPC handlers ──────────────────────────────────────────────────────────

ipcMain.handle('wattcoin-governance-status', (_event) => {
  try {
    if (!wtcNode) return { ok: false, distributedPower: 0, passThreshold: 0, totalPossible: 140 };
    const status = wtcNode.getGovernanceStatus();
    // Include governance wallet balance
    const walletBal = wtcNode.getGovernanceWalletBalance();
    return {
      ok: true,
      ...status,
      governanceWallet: walletBal,
      governanceWalletAddress: 'wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw',
    };
  } catch (e) {
    return { ok: false, distributedPower: 0, passThreshold: 0, totalPossible: 140, error: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-governance-list', (_event) => {
  try {
    if (!wtcNode) return { ok: false, proposals: [] };
    return { ok: true, proposals: wtcNode.getGovernanceProposals() };
  } catch (e) {
    return { ok: false, proposals: [], error: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-governance-get-vote', (_event, pipId, address) => {
  try {
    if (!wtcNode) return { ok: false, vote: null };
    return { ok: true, vote: wtcNode.getGovernanceVote(pipId, address) };
  } catch (e) {
    return { ok: false, vote: null, error: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-governance-get-tallies', (_event, pipId) => {
  try {
    if (!wtcNode) return { ok: false, tallies: { for: 0, against: 0, totalPower: 0 } };
    return { ok: true, tallies: wtcNode.getGovernanceTallies(pipId) };
  } catch (e) {
    return { ok: false, tallies: { for: 0, against: 0, totalPower: 0 }, error: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-governance-propose', (_event, proposal) => {
  try {
    if (!wtcNode) return { ok: false, error: 'Node not ready' };

    // Auto-determine creator address and NFT — never trust the renderer.
    const addrs = wtcNode.getAddresses();
    let creator = addrs[0] || '';
    let creatorNftId = '';
    let creatorTier = 'bronze';
    for (const addr of addrs) {
      const nfts = wtcNode.getNftsForAddress(addr);
      if (nfts && nfts.length > 0) {
        creator = addr;
        // Pick the highest-tier NFT
        const best = wtcNode.getGovernanceVotingPower(addr);
        // Find the specific NFT ID for the best tier
        for (const nft of nfts) {
          const t = (nft.metadata && nft.metadata.tier) || 'bronze';
          if (t === best.bestTier) {
            creatorNftId = nft.nftId;
            creatorTier = best.bestTier;
            break;
          }
        }
        break;
      }
    }

    const votingDurationWeeks = Math.max(2, Math.min(10, Math.floor(Number(proposal.votingDurationWeeks) || 2)));
    const commentPeriodWeeks = Math.max(1, Math.min(4, Math.floor(Number(proposal.commentPeriodWeeks) || 2)));
    const pipId = wtcNode.generateGovernancePipId();
    const enriched = {
      title: proposal.title,
      description: proposal.description || '',
      creator,
      creatorNftId,
      creatorTier,
      pipId,
      createdAt: Date.now(),
      votingDurationWeeks,
      commentPeriodWeeks,
    };

    // Governance transfer fields — only accepted if the governance wallet key is in this node
    if (proposal.transferTo && proposal.transferAmount) {
      const govKey = wtcNode.hasAddress('wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw');
      if (!govKey) {
        return {
          ok: false,
          error: 'Governance wallet key not available on this node — cannot submit treasury transfer proposals.',
        };
      }
      // Validate minimum reserve at node level (needs balance info)
      const bal = wtcNode.getGovernanceWalletBalance();
      const minReserve = 10000;
      if (bal.confirmed - Number(proposal.transferAmount) < minReserve) {
        return {
          ok: false,
          error: `Governance treasury must retain at least ${minReserve.toLocaleString()} WTC. Current balance: ${bal.confirmed.toLocaleString()} WTC.`,
        };
      }
      enriched.transferTo = String(proposal.transferTo).trim();
      enriched.transferAmount = Number(proposal.transferAmount);
      enriched.transferPurpose = String(proposal.transferPurpose || '').trim();
    }

    const result = wtcNode.addGovernanceProposal(enriched);
    if (!result.ok) return result;
    return { ok: true, pipId };
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-governance-vote', (_event, pipId, voteData) => {
  try {
    if (!wtcNode) return { ok: false, error: 'Node not ready' };

    // Step 1: compute real voting power from NFT store (never trust self-reported)
    const vp = wtcNode.getGovernanceVotingPower(voteData.voter);
    if (!vp.hasNft) return { ok: false, error: `${voteData.voter.slice(0, 12)}... does not own any Vortex NFTs` };

    // Step 2: sign the vote WITH the computed power and tier so both are
    // cryptographically committed and can't be tampered with in transit.
    const timestamp = Date.now();
    const message = `${pipId}|${voteData.voter}|${voteData.vote}|${vp.bestPower}|${vp.bestTier}|${timestamp}`;
    const signed = wtcNode.signMessage(voteData.voter, message);

    // Step 3: store vote with signature and verified power
    const result = wtcNode.addGovernanceVote(pipId, {
      voter: voteData.voter,
      vote: voteData.vote,
      power: vp.bestPower,
      nftTier: vp.bestTier,
      timestamp,
      signature: signed.signature,
    });
    return result;
  } catch (e) {
    return { ok: false, error: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-explorer-get-blocks', (_event, { offset = 0, limit = 20 } = {}) => {
  try {
    if (!wtcNode) return { ok: false, blocks: [], total: 0 };
    const height = wtcNode.getHeight();
    if (height < 0) return { ok: true, blocks: [], total: 0 };
    const total = height + 1;
    const start = Math.max(0, height - offset - limit + 1);
    const end = Math.max(-1, height - offset);
    const blocks = [];
    for (let h = end; h >= start; h--) {
      const b = wtcNode.getBlock(h);
      if (!b) continue;
      blocks.push({
        height: b.height,
        hash: b.hash,
        prevHash: b.prevHash,
        timestamp: b.timestamp,
        proposer: b.proposer,
        energyWh: b.energyWh,
        rewardTotal: b.rewardTotal,
        txCount: (b.transactions || []).length,
        voterCount: b.votes ? Object.keys(b.votes).length : 0,
      });
    }
    return { ok: true, blocks, total };
  } catch (e) {
    return { ok: false, blocks: [], total: 0, error: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-explorer-get-block', (_event, { height } = {}) => {
  try {
    if (!wtcNode) return { ok: false, block: null };
    const b = wtcNode.getBlock(height);
    if (!b) return { ok: false, block: null };
    return { ok: true, block: b };
  } catch (e) {
    return { ok: false, block: null, error: String(e && e.message) };
  }
});

ipcMain.handle('wattcoin-get-peer-count', async () => {
  try {
    // Return cached result if still fresh (avoids stacking slow inspections).
    if (peerCountCachedResult && peerCountCachedResult.expiresAtMs > Date.now()) {
      return peerCountCachedResult.value;
    }
    // If another inspection is already in flight, wait for it instead of starting a parallel one.
    if (peerCountInspectionPromise) {
      return await peerCountInspectionPromise;
    }
    const doInspection = async () => {
      const settings = getLedgerNetworkSettings();
      pruneDiscoveredPeers();
      const discovery = getPeerDiscoverySnapshot(settings);
      const lastSync = opsState.lastSyncResult || null;
      if (settings.enabled && settings.mode === 'peer') {
        // Single merged peer list — avoids double sequential probing.
        const mergedTargets = Array.from(new Set([...getActivePeers(settings), ...getPeerDirectoryTargets(settings)]));
        const activeConnectivity = await inspectPeerConnectivityForTargets(mergedTargets, {
          source: 'peer-count-active',
          concurrency: PEER_COUNT_PROBE_CONCURRENCY,
          probeTimeoutMs: PEER_COUNT_PROBE_TIMEOUT_MS,
        });
        const tunnelCount = getActiveReverseTunnelPeerConnectionCount();
        const counts = summarizeDisplayedPeerCounts({
          healthyDistinct: activeConnectivity.healthyDistinct,
          reverseTunnelDistinct: tunnelCount,
        });
        return {
          ok: true,
          count: counts.onlineCount,
          onlineCount: counts.onlineCount,
          connectedCount: counts.activeCount,
          tunnelCount: counts.tunnelCount,
          activeCount: counts.activeCount,
          source: 'peer',
          configuredPeers: Number(discovery && discovery.configuredPeers) || 0,
          seedPeers: Number(discovery && discovery.seedPeers) || 0,
          discoveredPeers: Number(discovery && discovery.discoveredPeers) || 0,
          lastSyncTrigger: lastSync && lastSync.trigger ? String(lastSync.trigger) : '',
          lastSyncOk: Boolean(lastSync && (lastSync.synced || lastSync.ok)),
        };
      }
      return {
        ok: true,
        count: null,
        onlineCount: null,
        connectedCount: 0,
        tunnelCount: 0,
        activeCount: 0,
        source: 'standalone',
        configuredPeers: 0,
        seedPeers: 0,
        discoveredPeers: 0,
        lastSyncTrigger: '',
        lastSyncOk: false,
      };
    };
    peerCountInspectionPromise = doInspection();
    try {
      const result = await peerCountInspectionPromise;
      peerCountCachedResult = { expiresAtMs: Date.now() + PEER_COUNT_CACHE_TTL_MS, value: result };
      return result;
    } finally {
      peerCountInspectionPromise = null;
    }
  } catch (_) {
    return {
      ok: false,
      count: null,
      onlineCount: null,
      connectedCount: 0,
      tunnelCount: 0,
      activeCount: 0,
      configuredPeers: 0,
      seedPeers: 0,
      discoveredPeers: 0,
      lastSyncTrigger: '',
      lastSyncOk: false,
    };
  }
});

ipcMain.handle('wattcoin-get-ops-metrics', async () => {
  try {
    const snapshot = opsState.latestSnapshot || (await collectOpsSnapshot());
    return { ok: true, snapshot };
  } catch (e) {
    return { ok: false, message: e && e.message ? e.message : 'failed to read ops metrics' };
  }
});

ipcMain.handle('wattcoin-get-wallet-readiness', async () => {
  if (wtcNode) {
    const readiness = await wtcNode.getWalletReadiness();
    const lastSyncResult = opsState.lastSyncResult || null;
    const lastReason = lastSyncResult && typeof lastSyncResult.reason === 'string' ? lastSyncResult.reason.trim() : '';
    const syncBlockedReason =
      !readiness.spendReady &&
      lastReason &&
      lastReason !== 'already best chain' &&
      lastReason !== 'sync already in progress'
        ? lastReason
        : '';
    return {
      ...readiness,
      lastSyncResult,
      syncBlockedReason,
    };
  }
  return { ok: false, spendReady: false, code: 'NODE_NOT_READY', message: 'Node is starting up. Please wait...' };
});

ipcMain.handle('wattcoin-set-hardware-load', (_, percent) => {
  try {
    const appliedPercent = setHardwareLoadPercent(percent);
    hwAuthority.currentLoadPercent = typeof appliedPercent === 'number' ? appliedPercent : Number(percent) || 0;
    return {
      ok: true,
      appliedPercent,
      ...getHardwareLoadState(),
      note: 'CPU and memory are actively controlled. GPU load control is not available in generic mode.',
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Failed to set hardware load' };
  }
});

ipcMain.handle('wattcoin-stop-hardware-load', () => {
  try {
    stopHardwareLoad();
    hwAuthority.currentLoadPercent = 0;
    return { ok: true, ...getHardwareLoadState() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Failed to stop hardware load' };
  }
});

// ── Native GPU load control (gpu-miner.exe) ────────────────────────────────
ipcMain.handle('wattcoin-gpu-info', async () => {
  try {
    const available = await ensureGpu();
    if (!available) return { ok: false, error: 'GPU binary unavailable' };
    const info = getGpuInfo();
    return { ok: true, ...info, ...getGpuLoadState() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'GPU info failed' };
  }
});

ipcMain.handle('wattcoin-set-gpu-load', async (_event, percent) => {
  try {
    const appliedPercent = typeof setGpuLoadPercentFn === 'function' ? await setGpuLoadPercentFn(percent) : 0;
    hwAuthority.currentLoadPercent = typeof appliedPercent === 'number' ? appliedPercent : Number(percent) || 0;
    return { ok: true, appliedPercent, ...getGpuLoadState() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Failed to set GPU load' };
  }
});

ipcMain.handle('wattcoin-stop-gpu-load', () => {
  try {
    stopGpuHardwareLoad();
    hwAuthority.currentLoadPercent = 0;
    return { ok: true, ...getGpuLoadState() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Failed to stop GPU load' };
  }
});

ipcMain.handle('wattcoin-get-gpu-load-state', () => {
  try {
    return { ok: true, ...getGpuLoadState() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Failed to read GPU load state' };
  }
});

ipcMain.handle('wattcoin-gpu-benchmark', async () => {
  try {
    const result = await runGpuBenchmark();
    if (!result || result.error) {
      return { ok: false, error: (result && result.error) || 'GPU benchmark failed' };
    }
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'GPU benchmark exception' };
  }
});

ipcMain.handle('wattcoin-gpu-proof', async (_event, payload = {}) => {
  try {
    const seed = Number(payload && payload.seed) | 0 || 1;
    const size = Math.max(1, Math.min(1024, Number(payload && payload.size) || 128));
    const iters = Math.max(1, Math.min(256, Number(payload && payload.shaderIterations) || 32));
    const result = await runGpuProof(seed, size, iters);
    if (!result) return { ok: false, error: 'GPU proof failed' };
    // Convert native binary's uint32 hash (decimal) to 8-char hex to match computeGpuProbeExpectedHash
    const hash = (Number(result.hash) >>> 0).toString(16).padStart(8, '0');
    return { ok: true, hash, elapsedMs: result.elapsedMs, seed: result.seed };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'GPU proof exception' };
  }
});

ipcMain.handle('wattcoin-get-hardware-load-state', () => {
  try {
    return { ok: true, ...getHardwareLoadState() };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : 'Failed to read hardware load state' };
  }
});

// ---------------------------------------------------------------------------
// Power-proof on-chain commitment
// ---------------------------------------------------------------------------
// Before mining each block we broadcast a zero-value OP_RETURN transaction that
// encodes a SHA-256 commitment of the energy+benchmark proof supplied by the
// renderer.  The miner's `generatetoaddress` call then picks up that mempool
// transaction and includes it in the block, making the proof auditable on-chain.
// The commitment is: SHA-256(JSON.stringify(sortedProofFields))  â†’ 32 bytes â†’ 64 hex chars.
// Format on-chain (80-byte OP_RETURN payload limit):
//   WTC1:<32-byte-hex-commitment>  (37 bytes)
// ---------------------------------------------------------------------------
function buildPowerProofCommitment(proofData) {
  if (!proofData || typeof proofData !== 'object') return null;
  // Canonicalise: only include fields we care about, sorted.
  // cpuSpeedInitialSeed + cpuSpeedProof allow any peer to independently verify the
  // computation: re-run cpuSpeedStep(initialSeed) × CPU_SPEED_N and confirm the hash.
  // memProof is unique per wallet address (derived salt); a peer verifies it by
  // re-running the deterministic traversal seeded with the submitting miner's address.
  const canonical = {
    benchmarkTs: Number(proofData.benchmarkTs) || 0,
    challengeSeed: Number(proofData.challengeSeed) || 0,
    cpuOpsPerSec: Number(proofData.cpuOpsPerSec) || 0,
    cpuSpeedInitialSeed: Number(proofData.cpuSpeedInitialSeed) || 0,
    cpuSpeedProof: String(proofData.cpuSpeedProof || ''),
    cpuSpeedTier: Number(proofData.cpuSpeedTier) || 0, // item 2: measurement-derived tier
    energyWh: Number(proofData.energyWh) || 0,
    gpuFps: Number(proofData.gpuFps) || 0,
    gpuProofHash: String(proofData.gpuProofHash || ''),
    gpuProofWorkload: String(proofData.gpuProofWorkload || 'none'),
    issues: Array.isArray(proofData.issues) ? [...proofData.issues].sort() : [],
    jitterRatio: Number(proofData.jitterRatio) || 0,
    memoryMBps: Number(proofData.memoryMBps) || 0,
    memLatencyTier: Number(proofData.memLatencyTier) || 0, // item 2: measurement-derived tier
    memProof: String(proofData.memProof || ''),
    miningAddress: String(proofData.miningAddress || ''),
    peerProbeVerified: !!proofData.peerProbeVerified, // item 4: peer probe flag
    probeReceipt:
      proofData.probeReceipt && typeof proofData.probeReceipt === 'object' // item 5
        ? normalizeProbeReceipt(proofData.probeReceipt)
        : null,
    proofTs: Number(proofData.proofTs) || 0,
    score: Number(proofData.score) || 0,
    sensorTier: String(proofData.sensorTier || ''),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

ipcMain.handle('wattcoin-mine-block', async (_, selectedAddress, proofData) => {
  const _walletName = 'wattminer';
  // Use the main-process-verified wallet address as the rate-limit actor so the
  // renderer cannot bypass per-miner limits by rotating submitted address strings.
  const verifiedAddr = walletAddressCache.address || '';
  const actorId =
    verifiedAddr ||
    (typeof selectedAddress === 'string' && selectedAddress.trim() ? selectedAddress.trim() : 'local-client');
  const rateLimit = await enforceEndpointRateLimit('wattcoin-mine-block', actorId, { selectedAddress: actorId });
  if (!rateLimit.ok) {
    return {
      address: '',
      mined: '',
      error: rateLimit.message,
      code: rateLimit.code,
      lockedUntil: rateLimit.lockedUntil || 0,
    };
  }
  const reattestationGate = enforceReattestationGateForMiner(actorId, {}, { allowSpotCheck: true });
  if (!reattestationGate.ok) {
    return {
      address: '',
      mined: '',
      error: reattestationGate.message,
      code: reattestationGate.code,
      reasons: reattestationGate.reasons || [],
      policy: reattestationGate.policy || null,
    };
  }

  // ── WTC native chain path ─────────────────────────────────────────────────
  if (wtcNode) {
    if (mineBlockBusy) {
      return { address: '', mined: '', error: 'A block is already being mined — please wait.', code: 'MINE_BUSY' };
    }
    // At least one peer must be online to mine. This ensures every block carries
    // a probe receipt secp256k1-signed by a live verifier peer (typically the
    // bootstrap node). A patched client cannot forge that signature, so solo
    // mining with fabricated energy values is not possible on the real network.
    const activePeersForProbeCheck = getActivePeers(getLedgerNetworkSettings());
    if (activePeersForProbeCheck.length === 0) {
      return {
        address: '',
        mined: '',
        error: 'At least one peer must be connected before mining. Waiting for peer connection...',
        code: 'NO_PEERS',
      };
    }
    // Probe receipt required — the verifier peer measures timing independently
    // and signs the receipt. Cannot be forged without the verifier's private key.
    if (!(proofData && proofData.peerProbeVerified)) {
      return {
        address: '',
        mined: '',
        error: 'A peer probe is required before mining. Complete a peer probe first.',
        code: 'PEER_PROBE_REQUIRED',
      };
    }
    const probeReceipt =
      proofData && proofData.probeReceipt && typeof proofData.probeReceipt === 'object'
        ? normalizeProbeReceipt(proofData.probeReceipt)
        : null;
    if (
      probeReceipt &&
      probeReceipt.verifierAddress &&
      probeReceipt.workerId &&
      hasRecentPeerAttestationRelation(probeReceipt.verifierAddress, probeReceipt.workerId)
    ) {
      return {
        address: '',
        mined: '',
        error:
          'Peer receipt comes from a peer with recent reciprocal attestation activity. Select a different verifier peer.',
        code: 'RECIPROCAL_PEER_ATTESTATION',
      };
    }
    mineBlockBusy = true;
    try {
      const preferred = typeof selectedAddress === 'string' ? selectedAddress.trim() : '';
      const addr = preferred && wtcNode.getAddresses().includes(preferred) ? preferred : wtcNode.getPrimaryAddress();
      const commitment = buildPowerProofCommitment(proofData);
      const sharedRoundSnapshot = getSharedRoundSnapshot();
      const rewardMap = buildRewardMapFromRoundSnapshot(sharedRoundSnapshot, addr);
      const effectiveEnergyWh = Math.max(
        Number(proofData && proofData.energyWh) || 0,
        Number(sharedRoundSnapshot.totalWh) || 0,
      );
      hwAuthority.pendingProofCommitment = commitment || '';
      const result = await wtcNode.mineBlock(
        addr,
        {
          energyWh: effectiveEnergyWh,
          proofCommitment: commitment || '',
          peerProbeVerified: !!(proofData && proofData.peerProbeVerified),
          probeReceipt:
            proofData && proofData.probeReceipt && typeof proofData.probeReceipt === 'object'
              ? normalizeProbeReceipt(proofData.probeReceipt)
              : null,
          probesAnswered: Math.max(0, Math.floor(Number(proofData && proofData.probesAnswered) || 0)),
        },
        rewardMap,
      );
      announceTipToPeers({ height: result.height, hash: result.hash });
      pushChainToPeers({ windowSize: 200 });
      // Block mined — promote any delivery_pending orders that got confirmed,
      // then flush queued orders into the mempool for natural confirmation.
      saleQueue.onBlockConfirmed();
      saleQueue.flushSaleQueue().catch((e) => console.warn('[SaleQueue] post-mine flush error:', e && e.message));
      stakingQueue
        .flushStakingQueue()
        .catch((e) => console.warn('[StakingQueue] post-mine flush error:', e && e.message));
      return {
        walletName: 'wtc-native',
        address: result.address,
        mined: result.hash,
        blockHash: result.hash,
        proofCommitment: commitment || null,
        proofTxid: null,
        height: result.height,
        reward: result.reward,
        energyWh: effectiveEnergyWh,
        contributionsWh: sharedRoundSnapshot.contributionsWh,
        roundId: sharedRoundSnapshot.id,
      };
    } catch (e) {
      return { address: '', mined: '', error: e && e.message ? e.message : 'Mine failed' };
    } finally {
      mineBlockBusy = false;
    }
  }
});

function getLedgerNetworkSettings() {
  const runtime = getRuntimeConfig();
  const mode = String(runtime.ledgerNetworkMode || 'standalone')
    .trim()
    .toLowerCase();
  const bootstrapPeers = Array.isArray(runtime.ledgerPeers) ? runtime.ledgerPeers.filter(Boolean) : [];
  const seedPeers =
    runtime.network === 'wtc-mainnet'
      ? [...bootstrapPeers, ...loadBundledSeedPeers(), ...loadCachedRemoteSeedPeers()]
      : [...bootstrapPeers];
  const normalizedConfiguredPeers = Array.from(
    new Set(bootstrapPeers.map(normalizePeerUrl).filter((peer) => peer && !isDeprecatedPeerUrl(peer))),
  );
  const normalizedSeedPeers = Array.from(
    new Set(seedPeers.map(normalizePeerUrl).filter((peer) => peer && !isDeprecatedPeerUrl(peer))),
  );
  const normalizedAdvertiseUrls = Array.from(
    new Set(
      (Array.isArray(runtime.ledgerNetworkAdvertiseUrls) ? runtime.ledgerNetworkAdvertiseUrls : [])
        .map(normalizePeerUrl)
        .filter(Boolean),
    ),
  );
  return {
    enabled: Boolean(runtime.ledgerNetworkEnabled),
    mode,
    configuredPeers: normalizedConfiguredPeers,
    seedPeers: normalizedSeedPeers,
    // Seed/bootstrap peers are directory/sync candidates. The active peer set is
    // built from discovered peers at runtime instead of a separate static bucket.
    peers: normalizedConfiguredPeers,
    coordinatorUrl: normalizePeerUrl(runtime.ledgerCoordinatorUrl),
    authToken: String(runtime.ledgerNetworkAuthToken || '').trim(),
    listenHost: String(runtime.ledgerNetworkListenHost || '0.0.0.0').trim() || '0.0.0.0',
    listenPort: Math.max(1, Number(runtime.ledgerNetworkListenPort) || 39310),
    requestTimeoutMs: Math.max(1000, Number(runtime.ledgerNetworkRequestTimeoutMs) || 7000),
    publicUrl: normalizePeerUrl(runtime.ledgerNetworkPublicUrl),
    tunnelPublicUrl: normalizePeerUrl(runtime.ledgerNetworkTunnelPublicUrl),
    advertiseUrls: normalizedAdvertiseUrls,
  };
}

function getBundledSeedPeerCandidates() {
  const candidates = [];
  for (const fileName of BUNDLED_SEED_PEER_FILE_NAMES) {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, fileName));
    }
    candidates.push(path.join(__dirname, 'docs', fileName), path.join(__dirname, 'resources', fileName));
  }
  return Array.from(new Set(candidates));
}

function loadBundledSeedPeers() {
  if (bundledSeedPeersCache) return bundledSeedPeersCache;

  for (const candidate of getBundledSeedPeerCandidates()) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const peerEntries = Array.isArray(parsed && parsed.seedPeers)
        ? parsed.seedPeers
        : Array.isArray(parsed && parsed.peers)
          ? parsed.peers
          : [];
      const peers = peerEntries
        .map((peer) => {
          const rawUrl = (peer && peer.url) || peer || '';
          // If the entry has a base64-encoded IP, decode it and build the URL
          if (peer && peer.ipB64 && typeof peer.ipB64 === 'string') {
            try {
              const decoded = Buffer.from(peer.ipB64, 'base64').toString('utf8').trim();
              if (decoded) return normalizePeerUrl(`http://${decoded}`);
            } catch (_) {
              if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
            }
          }
          return normalizePeerUrl(rawUrl);
        })
        .filter((peer) => peer && !isDeprecatedPeerUrl(peer));
      bundledSeedPeersCache = peers;
      console.log(`[Bootstrap] Loaded ${peers.length} bundled peers from ${candidate}`);
      return bundledSeedPeersCache;
    } catch (err) {
      console.warn('[Bootstrap] Failed to load bundled peers:', err && err.message ? err.message : err);
    }
  }

  bundledSeedPeersCache = [];
  return bundledSeedPeersCache;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload || {});
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = LEDGER_NETWORK_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {});
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function getTrustedRequesterPeerIdentity(req, settings = getLedgerNetworkSettings()) {
  const declaredPeerIdentity = String(req && req.headers ? req.headers['x-wtc-peer-identity'] || '' : '').trim();
  if (!isValidPeerIdentity(declaredPeerIdentity)) return '';
  if (isReverseTunnelForwardedRequest(req)) return declaredPeerIdentity;
  if (isLedgerNetworkAuthorized(req, settings)) return declaredPeerIdentity;
  return '';
}

function getRequesterIdentity(req, settings = getLedgerNetworkSettings()) {
  const trustedPeerIdentity = getTrustedRequesterPeerIdentity(req, settings);
  if (trustedPeerIdentity) {
    return trustedPeerIdentity;
  }
  return String(req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'remote-client');
}

function isLedgerNetworkAuthorized(req, settings) {
  const supplied = String(req.headers['x-wattcoin-ledger-token'] || '').trim();
  if (!supplied) return false;
  const requiredToken = String(settings && settings.authToken ? settings.authToken : '').trim();
  if (!requiredToken) {
    // Fail closed: if no token has been configured the peer server must not accept any
    // request rather than accepting everything.  The startup routine generates a random
    // token on first launch; a missing token here means something went wrong.
    console.error('[Auth] SECURITY: authToken not configured - rejecting all peer requests.');
    return false;
  }
  return checkLedgerNetworkAuth(supplied, requiredToken);
}

function getPeerProtocolInfo() {
  const tip = wtcNode && typeof wtcNode.handleGetTip === 'function' ? wtcNode.handleGetTip() : null;
  return {
    networkId: (tip && tip.networkId) || getActiveNetwork(),
    protocolVersion: String((tip && tip.protocolVersion) || 1),
    genesisHash: (tip && tip.genesisHash) || '',
  };
}

function getLocalPeerIdentity() {
  try {
    if (wtcNode && typeof wtcNode.getPeerIdentity === 'function') {
      return String(wtcNode.getPeerIdentity() || '').trim();
    }
    const identity = loadOrCreateDeviceIdentity();
    return String((identity && identity.deviceId) || '').trim();
  } catch (_) {
    return '';
  }
}

function isValidPeerIdentity(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  if (isValidWtcAddress(normalized)) return true;
  return /^[a-f0-9]{64}$/i.test(normalized);
}

function verifyChainPeerCompatibility(req) {
  const expected = getPeerProtocolInfo();
  const suppliedNetwork = String(req.headers['x-wtc-network-id'] || '').trim();
  const suppliedVersion = String(req.headers['x-wtc-protocol-version'] || '').trim();
  const suppliedGenesis = String(req.headers['x-wtc-genesis-hash'] || '').trim();

  if (!suppliedNetwork || suppliedNetwork !== expected.networkId) {
    return { ok: false, reason: 'network mismatch' };
  }
  if (!suppliedVersion || suppliedVersion !== String(expected.protocolVersion)) {
    return { ok: false, reason: 'protocol version mismatch' };
  }
  if (expected.genesisHash && (!suppliedGenesis || suppliedGenesis !== expected.genesisHash)) {
    return { ok: false, reason: 'genesis hash mismatch' };
  }
  return { ok: true };
}

// requestPeerJson targets an explicit peer URL rather than the
function requestPeerJson(peerUrl, method, routePath, payload, query = {}, options = {}) {
  return new Promise((resolve, reject) => {
    if (isPeerUrlBanned(peerUrl)) {
      reject(new Error(`Peer is temporarily banned: ${peerUrl}`));
      return;
    }
    const settings = getLedgerNetworkSettings();
    let base;
    try {
      base = new URL(peerUrl);
      if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('bad protocol');
    } catch (_) {
      reject(new Error(`Invalid peer URL: ${peerUrl}`));
      return;
    }

    const relativeRoutePath = String(routePath || '').replace(/^\/+/, '');
    const normalizedRoutePath = `/${relativeRoutePath}`;
    const basePath = base.pathname && base.pathname !== '/' ? `${base.pathname.replace(/\/+$/, '')}/` : '/';
    const resolvedBase = resolvePeerRequestBaseUrl(base, settings);
    const fullUrl = new URL(relativeRoutePath, `${resolvedBase.origin}${basePath}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      fullUrl.searchParams.set(key, String(value));
    }

    const normalizedPeerUrl = normalizePeerUrl(peerUrl);
    const trackReachability = options && options.trackReachability !== false;
    const isChainTipProbe =
      method === 'GET' &&
      normalizedRoutePath === '/api/v1/chain/tip' &&
      Object.keys(query || {}).length === 0 &&
      payload === undefined;
    if (isChainTipProbe && normalizedPeerUrl) {
      const cached = peerChainTipCache.get(normalizedPeerUrl);
      if (cached && Number(cached.expiresAtMs || 0) > Date.now() && cached.value) {
        if (trackReachability) {
          recordPeerUrlSuccess(normalizedPeerUrl);
        }
        resolve(cached.value);
        return;
      }
      const inflight = peerChainTipInflight.get(normalizedPeerUrl);
      if (inflight) {
        inflight.then(resolve).catch(reject);
        return;
      }
    }

    const isHttps = fullUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const body = payload !== undefined ? JSON.stringify(payload) : '';
    const protocolInfo = getPeerProtocolInfo();
    const announcementHeaders = buildPeerAnnouncementHeaders(settings);
    const localPeerIdentity = getLocalPeerIdentity();
    const requestPromise = new Promise((requestResolve, requestReject) => {
      const request = transport.request(
        {
          method,
          protocol: fullUrl.protocol,
          hostname: fullUrl.hostname,
          port: fullUrl.port || (isHttps ? 443 : 80),
          path: `${fullUrl.pathname}${fullUrl.search}`,
          timeout: Math.max(1000, Number(options && options.timeoutMs) || settings.requestTimeoutMs),
          // Disable keep-alive pooling: Node.js v19+ uses keep-alive by default,
          // which causes "socket hang up" (ECONNRESET) when the server closes a
          // pooled socket just as a new request starts on it.
          agent: false,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'x-wtc-network-id': protocolInfo.networkId,
            'x-wtc-protocol-version': String(protocolInfo.protocolVersion),
            ...(protocolInfo.genesisHash ? { 'x-wtc-genesis-hash': protocolInfo.genesisHash } : {}),
            ...(localPeerIdentity ? { 'x-wtc-peer-identity': localPeerIdentity } : {}),
            ...(settings.authToken ? { 'x-wattcoin-ledger-token': settings.authToken } : {}),
            ...announcementHeaders,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (res.statusCode >= 400) {
                const msg = parsed && parsed.message ? parsed.message : `HTTP ${res.statusCode}`;
                const isUnavailableReverseTunnel =
                  normalizedPeerUrl &&
                  isReverseTunnelPeerUrl(normalizedPeerUrl) &&
                  parsed &&
                  parsed.code === 'REVERSE_TUNNEL_UNAVAILABLE';
                if (isUnavailableReverseTunnel) {
                  forgetPeerUrlState(normalizedPeerUrl);
                }
                if (trackReachability) {
                  if (!isUnavailableReverseTunnel) {
                    recordPeerUrlFailure(peerUrl, `http-${res.statusCode}`);
                  }
                }
                requestReject(new Error(msg));
              } else {
                if (trackReachability) {
                  recordPeerUrlSuccess(peerUrl);
                }
                if (trackReachability && (!options || options.suppressPeerDiscovery !== true)) {
                  rememberDiscoveredPeer(peerUrl, {
                    source: String((options && options.source) || 'peer-contact'),
                    quiet: true,
                  });
                }
                requestResolve(parsed);
              }
            } catch (_) {
              if (trackReachability) {
                recordPeerUrlFailure(peerUrl, 'invalid-json');
              }
              requestReject(new Error('Invalid JSON from peer'));
            }
          });
        },
      );
      request.on('timeout', () => {
        request.destroy(new Error('Peer request timed out.'));
      });
      request.on('error', (err) => {
        if (trackReachability) {
          recordPeerUrlFailure(peerUrl, err && err.message ? err.message : 'request-error');
        }
        requestReject(err);
      });
      request.write(body);
      request.end();
    });

    if (isChainTipProbe && normalizedPeerUrl) {
      peerChainTipInflight.set(normalizedPeerUrl, requestPromise);
      requestPromise
        .then((value) => {
          peerChainTipCache.set(normalizedPeerUrl, {
            expiresAtMs: Date.now() + PEER_CHAIN_TIP_CACHE_MS,
            value,
          });
          peerChainTipInflight.delete(normalizedPeerUrl);
        })
        .catch(() => {
          peerChainTipCache.delete(normalizedPeerUrl);
          peerChainTipInflight.delete(normalizedPeerUrl);
        });
    }

    requestPromise.then(resolve).catch(reject);
  });
}

function getCurrentNetworkRoundId() {
  try {
    return wtcNode && typeof wtcNode.getHeight === 'function'
      ? Math.max(1, wtcNode.getHeight() + 1)
      : Math.max(1, Number(roundLedger.getCurrentRoundSnapshot().id) || 1);
  } catch (_) {
    return 1;
  }
}

function alignRoundLedgerToChain(roundId = getCurrentNetworkRoundId()) {
  try {
    const prevRoundId = roundLedger.getCurrentRoundSnapshot().id;
    const result = roundLedger.beginRound(roundId, 0);
    if (prevRoundId && prevRoundId !== roundId) {
      // Round boundary crossed — purge witnessed probe receipts from prior round.
      witnessedProbeReceipts.clear();
    }
    return result;
  } catch (_) {
    return roundLedger.getCurrentRoundSnapshot();
  }
}

function getSharedRoundSnapshot() {
  alignRoundLedgerToChain();
  return roundLedger.getCurrentRoundSnapshot();
}

function buildRoundContributionMessage({ address, roundId, totalWh, updatedAtMs, chainIndex }) {
  return JSON.stringify({
    prefix: ROUND_CONTRIBUTION_MESSAGE_PREFIX,
    network: getActiveNetwork(),
    address: String(address || '').trim(),
    roundId: Math.max(1, Math.floor(Number(roundId) || 0)),
    totalWh: Number(Math.max(0, Number(totalWh) || 0).toFixed(8)),
    updatedAtMs: Math.max(0, Math.floor(Number(updatedAtMs) || 0)),
    chainIndex: Math.max(0, Math.floor(Number(chainIndex) || 0)),
  });
}

function buildRewardMapFromRoundSnapshot(roundSnapshot, fallbackAddress = '') {
  const roundId = Math.max(1, Math.floor(Number(roundSnapshot && roundSnapshot.id) || getCurrentNetworkRoundId()));
  const rewardTotal = rewardForHeight(roundId);
  if (rewardTotal <= 0) return {};

  const contributionEntries = Object.entries((roundSnapshot && roundSnapshot.contributionsWh) || {})
    .map(([address, amount]) => [String(address || '').trim(), Math.max(0, Number(amount) || 0)])
    .filter(([address, amount]) => address && amount > 0);
  const totalWh = contributionEntries.reduce((sum, [, amount]) => sum + amount, 0);

  if (totalWh <= 0) {
    return fallbackAddress ? { [fallbackAddress]: rewardTotal } : {};
  }

  const rewardMap = {};
  let allocated = 0;
  contributionEntries.forEach(([address, amount], index) => {
    const isLast = index === contributionEntries.length - 1;
    let share = isLast
      ? Number((rewardTotal - allocated).toFixed(8))
      : Number(((rewardTotal * amount) / totalWh).toFixed(8));
    if (share < 0) share = 0;
    allocated = Number((allocated + share).toFixed(8));
    rewardMap[address] = Number(((rewardMap[address] || 0) + share).toFixed(8));
  });
  return rewardMap;
}

function broadcastRoundContributionToPeers({ address, roundId, totalWh }) {
  const normalizedAddress = String(address || '').trim();
  if (!normalizedAddress || !wtcNode || typeof wtcNode.signMessage !== 'function') return;

  const settings = getLedgerNetworkSettings();
  if (!settings.enabled) return;
  const peers = getActivePeers(settings);

  const updatedAtMs = Date.now();
  const chainIndex = Math.max(0, Math.floor(Number((getLocalProbeChain && getLocalProbeChain().chainIndex) || 0)));
  const message = buildRoundContributionMessage({
    address: normalizedAddress,
    roundId,
    totalWh,
    updatedAtMs,
    chainIndex,
  });

  let signature = '';
  try {
    signature = String((wtcNode.signMessage(normalizedAddress, message) || {}).signature || '').trim();
  } catch (_) {
    return;
  }
  if (!signature) return;

  const payload = {
    address: normalizedAddress,
    roundId,
    totalWh: Number(Math.max(0, Number(totalWh) || 0).toFixed(8)),
    updatedAtMs,
    chainIndex,
    message,
    signature,
  };
  for (const peerUrl of peers) {
    queueRoundContributionBroadcast(peerUrl, payload);
  }
}

function broadcastProbeReceiptToPeers(receipt) {
  if (!receipt || !receipt.workerId) return;
  const settings = getLedgerNetworkSettings();
  if (!settings || !settings.enabled) return;
  const peers = getActivePeers(settings);
  if (!peers || peers.length === 0) return;
  const payload = { receipt };
  for (const peerUrl of peers) {
    requestPeerJson(peerUrl, 'POST', '/api/v1/probe/receipt', payload, undefined, {
      trackReachability: false,
      suppressPeerDiscovery: true,
      source: 'probe-receipt',
      timeout: 5000,
    }).catch(() => {});
  }
}

function queueRoundContributionBroadcast(peerUrl, payload) {
  const normalizedPeerUrl = normalizePeerUrl(peerUrl);
  if (!normalizedPeerUrl || !payload || typeof payload !== 'object') return;

  const roundId = Math.max(1, Math.floor(Number(payload.roundId) || 0));
  const normalizedAddress = String(payload.address || '').trim();
  if (!normalizedAddress || !roundId) return;

  const key = `${normalizedPeerUrl}|${normalizedAddress}`;
  const existing = pendingRoundContributionBroadcasts.get(key);
  if (existing) {
    existing.payload = payload;
    return;
  }

  const entry = {
    peerUrl: normalizedPeerUrl,
    payload,
    timer: setTimeout(() => {
      const latest = pendingRoundContributionBroadcasts.get(key);
      pendingRoundContributionBroadcasts.delete(key);
      if (!latest || !latest.payload) return;
      requestPeerJson(latest.peerUrl, 'POST', '/api/v1/round/contribution', latest.payload, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'round-contribution',
      }).catch(() => {});
    }, ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS),
  };
  pendingRoundContributionBroadcasts.set(key, entry);
}

async function getLocalLedgerBalances(selectedAddress) {
  alignRoundLedgerToChain();
  const address = typeof selectedAddress === 'string' ? selectedAddress.trim() : '';
  const blockHeight = await getCurrentBlockHeight();
  roundLedger.syncMaturity(blockHeight);
  const snapshot = roundLedger.getAddressSnapshot(address);
  const currentRoundWh = roundLedger.getRoundContribution(address);
  const maturityDepth = typeof roundLedger.getMaturityDepth === 'function' ? roundLedger.getMaturityDepth() : 100;
  return {
    ok: true,
    address: snapshot.address,
    balanceSource: 'backend-round-ledger',
    accountingModel: 'proportional-energy-rounds',
    balanceSemanticsVersion: 2,
    isAddressSpecific: true,
    totalMinedCoins: snapshot.total,
    maturedMinedCoins: snapshot.matured,
    unmaturedMinedCoins: snapshot.pending,
    currentRoundContributionWh: currentRoundWh,
    blockHeight,
    maturityDepth,
  };
}

async function settleLocalLedgerRound(payload = {}) {
  // Tier 5: reject settlement when no power-proof commitment was attached to this block.
  const proofCommitment = payload && payload.proofCommitment ? String(payload.proofCommitment).trim() : '';
  if (ENABLE_POWER_PROOF_COMMITMENT && !proofCommitment) {
    console.warn('[Ledger] Settlement rejected: missing power-proof commitment.');
    return {
      ok: false,
      code: 'PROOF_MISSING',
      message: 'Settlement rejected: no power-proof commitment was present for this block.',
    };
  }

  // Tier 5b: verify commitment matches what was recorded at mine time to prevent
  // a patched renderer from swapping in a fake contribution between mine and settle.
  if (ENABLE_POWER_PROOF_COMMITMENT && proofCommitment) {
    const expected = hwAuthority.pendingProofCommitment;
    if (!expected || proofCommitment !== expected) {
      console.warn('[Ledger] Settlement rejected: proof commitment mismatch.');
      hwAuthority.pendingProofCommitment = '';
      return {
        ok: false,
        code: 'PROOF_COMMITMENT_MISMATCH',
        message: 'Settlement rejected: proof commitment does not match mined block.',
      };
    }
  }
  hwAuthority.pendingProofCommitment = '';

  const minedAddress = payload && payload.minedAddress ? String(payload.minedAddress) : '';

  // Tier 4: forfeit current-round contributions when device fingerprint changed.
  const proofIssues = Array.isArray(payload && payload.proofIssues) ? payload.proofIssues : [];
  if (proofIssues.includes('device fingerprint changed unexpectedly') && minedAddress) {
    const forfeited = roundLedger.forfeitContribution(minedAddress);
    console.warn(
      `[Ledger] Tier 4 forfeiture: zeroed ${forfeited.forfeited} Wh for ${minedAddress} due to fingerprint change.`,
    );
  }

  // Tier 4b: forfeit when benchmark proof hash verification failed inside Node.
  const cpuProofFailed = proofIssues.some((i) => i.includes('cpu speed proof failed verification'));
  const memProofFailed = proofIssues.some((i) => i.includes('memory proof failed verification'));
  if ((cpuProofFailed || memProofFailed) && minedAddress) {
    const forfeited = roundLedger.forfeitContribution(minedAddress);
    const which = [cpuProofFailed && 'cpu', memProofFailed && 'memory'].filter(Boolean).join('+');
    console.warn(
      `[Ledger] Tier 4b forfeiture: zeroed ${forfeited.forfeited} Wh for ${minedAddress} due to ${which} proof mismatch.`,
    );
  }

  // Tier 4c (item 1): main process independently re-verifies the CPU and memory proof hashes.
  // The renderer already verified these in the same process (weak), but here we do it in the
  // main process (strong cross-process check — a patched renderer cannot fake this).
  const cpuSpeedInitialSeed = Number(payload && payload.cpuSpeedInitialSeed) || 0;
  const cpuSpeedProof = String((payload && payload.cpuSpeedProof) || '');
  const memProof = String((payload && payload.memProof) || '');
  if (cpuSpeedInitialSeed > 0 && cpuSpeedProof) {
    const coordCpuOk = verifyCpuSpeedProof(cpuSpeedInitialSeed, cpuSpeedProof);
    if (!coordCpuOk && minedAddress) {
      const forfeited = roundLedger.forfeitContribution(minedAddress);
      console.warn(
        `[Ledger] Tier 4c forfeiture (cpu): main-process re-run returned different hash for ${minedAddress} (forfeited ${forfeited.forfeited} Wh).`,
      );
    }
  }
  if (memProof) {
    const coordMemOk = verifyMemProof(memProof, minedAddress);
    if (!coordMemOk && minedAddress) {
      const forfeited = roundLedger.forfeitContribution(minedAddress);
      console.warn(
        `[Ledger] Tier 4c forfeiture (mem): main-process re-run returned different hash for ${minedAddress} (forfeited ${forfeited.forfeited} Wh).`,
      );
    }
  }

  // Tier 4d (item 4): standalone nodes (no peer probe) get 50% contribution credit.
  // Peer probes are the only external timing verification; without one, we can't
  // confirm the CPU/memory claims with independent wall-clock measurement.
  // The main process tracks peerProbeVerifiedForRound via IPC — the renderer
  // cannot self-certify this flag.
  const peerProbeVerified = hwAuthority.peerProbeVerifiedForRound;
  hwAuthority.peerProbeVerifiedForRound = false; // reset for next round
  if (!peerProbeVerified && minedAddress) {
    const partial = roundLedger.partialForfeit(minedAddress, 0.5);
    console.log(
      `[Ledger] Tier 4d: no peer probe for ${minedAddress} - halved contribution to ${partial.remaining} Wh.`,
    );
  }

  // Tier 4e: coverage-ratio penalty based on chained-probe continuity.
  // A node that was offline during part of the round answered fewer probes than
  // expected.  We scale their contribution proportionally so going offline is
  // self-penalising — the energy credit reflects only the verified-online fraction.
  //
  //   expectedProbeCount = floor(roundDurationMs / PROBE_INTERVAL_MS)   (min 1)
  //   coverageRatio      = min(1, chainIndex / expectedProbeCount)
  //   forfeitFraction    = 1 - coverageRatio   (0 = full credit, 1 = full forfeit)
  //
  // A chain break (probe timeout or failed proof) adds an additional 20% penalty on
  // top of the coverage shortfall, capped at a total forfeit of 1.0.
  // The backend-measured probeState is used directly (cannot be spoofed by the renderer).
  const probeChain = getLocalProbeChain();
  if (probeChain && peerProbeVerified && minedAddress) {
    const chainIndex = Math.max(0, Number(probeChain.chainIndex) || 0);
    const chainBroken = !!probeChain.chainBroken;
    const roundDurationMs = Math.max(0, Date.now() - (roundLedger.getCurrentRoundStartMs() || 0));
    // Guard: if round duration is unknown (< 1s) skip the check to avoid false penalties.
    if (roundDurationMs >= 1000) {
      const expectedProbeCount = Math.max(1, Math.floor(roundDurationMs / PROBE_INTERVAL_MS));
      const coverageRatio = Math.min(1, chainIndex / expectedProbeCount);
      const breakPenalty = chainBroken ? 0.2 : 0;
      const forfeitFraction = Math.min(1, 1 - coverageRatio + breakPenalty);
      if (forfeitFraction > 0.01) {
        // skip negligible rounding noise
        const partial = roundLedger.partialForfeit(minedAddress, forfeitFraction);
        console.log(
          `[Ledger] Tier 4e: coverage=${(coverageRatio * 100).toFixed(0)}% ` +
            `(${chainIndex}/${expectedProbeCount} probes, roundDuration=${Math.round(roundDurationMs / 1000)}s)` +
            `${chainBroken ? ', chain broken (+20%)' : ''} — ` +
            `forfeited ${(forfeitFraction * 100).toFixed(0)}% for ${minedAddress}, remaining=${partial.remaining} Wh.`,
        );
      }
    }
  }

  // Tier 4f: probe-rate energy capping.
  // Each answered probe represents at most PROBE_INTERVAL_MS of online mining.
  // The maximum credible energy for that interval is hardware TDP × interval.
  // If claimed Wh exceeds this, the excess is forfeited — prevents injecting
  // fake energy even after passing the one-time peer probe.
  // The GPU TDP comes from the native binary (gpu-miner.exe via DXGI) so the
  // renderer cannot lie about which GPU is installed or its power ceiling.
  if (probeChain && minedAddress) {
    const chainIndex = Math.max(0, Number(probeChain.chainIndex) || 0);
    if (chainIndex > 0) {
      // Hardware power: prefer native GPU TDP, fall back to CPU-calibrated power
      const gpuPowerW = Math.max(0, Number(hwAuthority.nativeGpuTdpW) || 0);
      const cpuPowerW = Math.max(0, Number(hwAuthority.calibratedUnitPowerW) || 100);
      const hwPowerW = gpuPowerW > 0 ? gpuPowerW : cpuPowerW;
      // Max Wh per probe: hwPowerW × (PROBE_INTERVAL_MS / 3600000)
      const maxWhThisRound = chainIndex * hwPowerW * (PROBE_INTERVAL_MS / 3600000);
      const currentWh = roundLedger.getRoundContribution(minedAddress);
      if (currentWh > maxWhThisRound && maxWhThisRound > 0) {
        const excessFraction = 1 - maxWhThisRound / currentWh;
        const cappedFraction = Math.min(1, Math.max(0, excessFraction));
        if (cappedFraction > 0.01) {
          const partial = roundLedger.partialForfeit(minedAddress, cappedFraction);
          console.warn(
            `[Ledger] Tier 4f: energy cap — ${currentWh.toFixed(4)} Wh exceeds ` +
              `${maxWhThisRound.toFixed(4)} Wh (${chainIndex} probes × ${hwPowerW}W) ` +
              `for ${minedAddress} — forfeited ${(cappedFraction * 100).toFixed(0)}%, ` +
              `remaining=${partial.remaining} Wh.`,
          );
        }
      }
    }
  }

  const blockHeight = await getCurrentBlockHeight();
  const round = roundLedger.settleCurrentRound({
    blockHash: payload && payload.blockHash ? String(payload.blockHash) : '',
    minedAddress,
    blockHeight,
    rewardCoins: Number(payload && payload.rewardCoins) || 0,
    contributionsWh:
      payload && payload.contributionsWh && typeof payload.contributionsWh === 'object'
        ? payload.contributionsWh
        : null,
  });
  const maturedRounds = roundLedger.syncMaturity(blockHeight);
  // Fire-and-forget broadcast to peers for cross-node audit trail.
  if (round && !round.idempotent) broadcastSettlementToPeers(round).catch(() => {});
  return { ok: true, round, maturedRounds, blockHeight };
}

// Returns the union of statically configured peers and dynamically discovered ones.
function getActivePeers(settings) {
  const staticPeers = settings && settings.peers ? settings.peers : [];
  const seedPeers = settings && settings.seedPeers ? settings.seedPeers : [];
  const now = Date.now();
  const dynamic = [];
  for (const [url, info] of discoveredPeers.entries()) {
    if (now - info.lastSeenMs > PEER_STALE_THRESHOLD_MS || isPeerUrlBanned(url)) continue;
    dynamic.push(url);
  }
  const preferredPeers = sortPeerUrlsByPreference(
    Array.from(new Set([...staticPeers, ...dynamic])).filter((url) => !isPeerUrlBanned(url)),
  );
  const bootstrapPeers =
    preferredPeers.length > 0
      ? preferredPeers
      : sortPeerUrlsByPreference(
          Array.from(new Set([...staticPeers, ...seedPeers, ...dynamic])).filter((url) => !isPeerUrlBanned(url)),
        );
  return filterExternalPeerUrls(bootstrapPeers, {
    selfAdvertisedUrls: getConfiguredAdvertisedPeerUrls(settings),
    listenPort: settings && settings.listenPort,
    localHosts: Array.from(getLocalPeerHosts()),
  });
}

function getPeerDirectoryTargets(settings) {
  const configuredPeers = settings && settings.configuredPeers ? settings.configuredPeers : [];
  const seedPeers = settings && settings.seedPeers ? settings.seedPeers : [];
  return filterExternalPeerUrls(
    sortPeerUrlsByPreference(
      Array.from(new Set([...configuredPeers, ...seedPeers, ...getActivePeers(settings)])).filter(
        (peerUrl) => !isPeerUrlBanned(peerUrl),
      ),
    ),
    {
      selfAdvertisedUrls: getConfiguredAdvertisedPeerUrls(settings),
      listenPort: settings && settings.listenPort,
      localHosts: Array.from(getLocalPeerHosts()),
    },
  );
}

function getTrustedPeerTargets(settings) {
  const seedPeers = settings && settings.seedPeers ? settings.seedPeers : [];
  const managedTunnelPeers = [];
  for (const [peerUrl, info] of discoveredPeers.entries()) {
    const sources = Array.isArray(info && info.sources) ? info.sources : [];
    if (!sources.includes('managed-tunnel')) continue;
    if (isPeerUrlBanned(peerUrl)) continue;
    managedTunnelPeers.push(peerUrl);
  }
  return filterExternalPeerUrls(
    Array.from(new Set([...managedTunnelPeers, ...seedPeers])).filter((peerUrl) => !isPeerUrlBanned(peerUrl)),
    {
      selfAdvertisedUrls: getConfiguredAdvertisedPeerUrls(settings),
      listenPort: settings && settings.listenPort,
      localHosts: Array.from(getLocalPeerHosts()),
    },
  );
}

function sendPeerBeacon(httpPort, publicUrl = '') {
  if (!peerDiscoverySocket) return;
  const normalizedPublicUrl = normalizePeerUrl(publicUrl) || getPrimaryAdvertisedPeerUrl(getLedgerNetworkSettings());
  const msg = Buffer.from(
    JSON.stringify({
      type: 'wattcoin-peer-beacon',
      httpPort,
      ...(normalizedPublicUrl ? { publicUrl: normalizedPublicUrl } : {}),
    }),
  );
  const interfaceAddresses = getLocalPeerIpv4Interfaces();
  const sendBeacon = () => {
    peerDiscoverySocket.send(msg, 0, msg.length, PEER_DISCOVERY_PORT, PEER_DISCOVERY_MCAST, (err) => {
      if (err) console.warn('[PeerDiscovery] Beacon send error:', err.message);
    });
  };
  if (interfaceAddresses.length === 0) {
    sendBeacon();
    return;
  }
  for (const address of interfaceAddresses) {
    try {
      peerDiscoverySocket.setMulticastInterface(address);
      sendBeacon();
    } catch (err) {
      console.warn(
        `[PeerDiscovery] Failed to select multicast interface ${address}:`,
        err && err.message ? err.message : err,
      );
    }
  }
}

function hasKnownPrivateLanPeer(settings = getLedgerNetworkSettings()) {
  return checkHasKnownPrivateLanPeer(getActivePeers(settings), {
    discoveredPeers,
    peerReachabilityCache,
    normalizePeerUrl,
    isSelfPeerUrl,
    staleThresholdMs: PEER_STALE_THRESHOLD_MS,
    reachabilitySuccessTtlMs: PEER_REACHABILITY_SUCCESS_TTL_MS,
    now: Date.now(),
  });
}

async function discoverPeersOnLocalSubnets(httpPort, settings = getLedgerNetworkSettings()) {
  if (!settings || !settings.enabled || settings.mode !== 'peer') return;
  if (hasKnownPrivateLanPeer(settings)) return;
  if (peerLocalSubnetDiscoveryPromise) return peerLocalSubnetDiscoveryPromise;
  const now = Date.now();
  if (now - peerLocalSubnetDiscoveryLastRunAt < PEER_LOCAL_SUBNET_DISCOVERY_MIN_INTERVAL_MS) return;
  const candidates = getLocalSubnetProbeCandidates(getLocalPeerIpv4InterfaceEntries(), {
    selfHosts: Array.from(getLocalPeerHosts()),
  });
  if (candidates.length === 0) return;

  peerLocalSubnetDiscoveryLastRunAt = now;
  peerLocalSubnetDiscoveryPromise = (async () => {
    let found = 0;
    let nextIndex = 0;
    const workerCount = Math.min(PEER_LOCAL_SUBNET_DISCOVERY_CONCURRENCY, candidates.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < candidates.length) {
        const candidateAddress = candidates[nextIndex];
        nextIndex += 1;
        const peerUrl = normalizePeerUrl(`http://${candidateAddress}:${httpPort}`);
        if (!peerUrl || isSelfPeerUrl(peerUrl) || isPeerUrlBanned(peerUrl)) continue;
        try {
          const tip = await requestPeerJson(peerUrl, 'GET', '/api/v1/chain/tip', undefined, undefined, {
            timeoutMs: PEER_LOCAL_SUBNET_DISCOVERY_TIMEOUT_MS,
            source: 'subnet-probe',
          });
          rememberDiscoveredPeer(peerUrl, {
            source: 'subnet-probe',
            quiet: true,
            peerIdentity: String((tip && tip.peerIdentity) || '').trim(),
          });
          found += 1;
        } catch (_) {
          if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
        }
      }
    });
    await Promise.all(workers);
    if (found > 0) {
      console.log(`[PeerDiscovery] Local subnet probe found ${found} peer(s).`);
    }
  })();

  try {
    await peerLocalSubnetDiscoveryPromise;
  } finally {
    peerLocalSubnetDiscoveryPromise = null;
  }
}

function startPeerDiscovery(httpPort, publicUrl = '') {
  if (peerDiscoverySocket) return;

  const selfIps = getLocalPeerHosts();

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('message', (msg, rinfo) => {
    try {
      const data = JSON.parse(msg.toString('utf8'));
      if (data && data.type === 'wattcoin-peer-beacon' && data.httpPort > 0) {
        const advertisedPeerUrl = normalizePeerUrl(data.publicUrl);
        const directLanPeerUrl = buildPeerUrlFromSocket(rinfo && rinfo.address, data.httpPort);
        // Skip our own beacon.
        // When the advertised public URL looks like ours, two LAN peers behind the same NAT
        // router share the same public IP, so we must NOT return early — the direct LAN URL
        // from the socket may still be a valid non-self peer.  Only bail out when both the
        // advertised URL and the direct LAN URL point at this machine.
        if (
          advertisedPeerUrl &&
          isSelfPeerUrl(advertisedPeerUrl) &&
          (!directLanPeerUrl || isSelfPeerUrl(directLanPeerUrl))
        )
          return;
        if (!advertisedPeerUrl && !directLanPeerUrl) return;
        if (!advertisedPeerUrl && selfIps.has(rinfo.address) && data.httpPort === httpPort) return;
        if (directLanPeerUrl && isSelfPeerUrl(directLanPeerUrl)) return;
        // Reject well-known system ports (≤ 1023) to prevent SSRF against local
        // services (HTTP :80, etc.) via a crafted multicast beacon.
        if (data.httpPort <= 1023) {
          console.warn(`[PeerDiscovery] Ignoring beacon from ${rinfo.address} with reserved port ${data.httpPort}`);
          return;
        }
        // When advertisedPeerUrl is a self URL (same-NAT scenario) exclude it from the
        // candidate list so the direct LAN URL is always chosen as the stored peer URL.
        const beaconCandidates = [
          advertisedPeerUrl && !isSelfPeerUrl(advertisedPeerUrl) ? advertisedPeerUrl : '',
          directLanPeerUrl,
        ].filter(Boolean);
        const peerUrl = selectDiscoveryPeerUrl(beaconCandidates) || directLanPeerUrl;
        rememberDiscoveredPeer(peerUrl, { source: 'beacon', seenAtMs: Date.now() });
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  });

  sock.on('error', (err) => {
    console.warn('[PeerDiscovery] UDP socket error:', err.message);
  });

  sock.bind(PEER_DISCOVERY_PORT, '0.0.0.0', () => {
    let joinedGroups = 0;
    try {
      // Join the multicast group so we receive beacons from other nodes.
      // TTL=1 keeps all traffic on the local subnet — does not route to internet.
      const interfaceAddresses = getLocalPeerIpv4Interfaces();
      if (interfaceAddresses.length > 0) {
        for (const address of interfaceAddresses) {
          try {
            sock.addMembership(PEER_DISCOVERY_MCAST, address);
            joinedGroups += 1;
          } catch (err) {
            console.warn(
              `[PeerDiscovery] Failed to join multicast group on ${address}:`,
              err && err.message ? err.message : err,
            );
          }
        }
      }
      if (joinedGroups === 0) {
        sock.addMembership(PEER_DISCOVERY_MCAST);
        joinedGroups = 1;
      }
      sock.setMulticastTTL(1);
      sock.setMulticastLoopback(true); // receive own beacons (useful for single-machine testing)
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    console.log(
      `[PeerDiscovery] Listening for peers on UDP ${PEER_DISCOVERY_PORT}${joinedGroups > 0 ? ` across ${joinedGroups} interface(s)` : ''}`,
    );
    sendPeerBeacon(httpPort, getPrimaryAdvertisedPeerUrl(getLedgerNetworkSettings()) || publicUrl);
    discoverPeersOnLocalSubnets(httpPort, getLedgerNetworkSettings()).catch(() => {});
    refreshPeerDirectory(getLedgerNetworkSettings()).catch(() => {});
  });

  peerDiscoverySocket = sock;

  // Fast startup burst: refresh the peer directory more frequently during the
  // first 2 minutes so the seed peer (which has no external bootstrap targets)
  // picks up peers that connect to it via tunnels as quickly as possible.
  const FAST_REFRESH_INTERVAL_MS = 15_000; // 15 s
  const FAST_REFRESH_DURATION_MS = 120_000; // 2 min
  const fastRefreshEnd = Date.now() + FAST_REFRESH_DURATION_MS;
  const fastRefreshTimer = setInterval(() => {
    if (Date.now() >= fastRefreshEnd) {
      clearInterval(fastRefreshTimer);
      return;
    }
    refreshPeerDirectory(getLedgerNetworkSettings()).catch(() => {});
  }, FAST_REFRESH_INTERVAL_MS);

  peerDiscoveryInterval = setInterval(() => {
    pruneDiscoveredPeers();
    sendPeerBeacon(httpPort, getPrimaryAdvertisedPeerUrl(getLedgerNetworkSettings()) || publicUrl);
    discoverPeersOnLocalSubnets(httpPort, getLedgerNetworkSettings()).catch(() => {});
    refreshPeerDirectory(getLedgerNetworkSettings()).catch(() => {});
  }, PEER_BEACON_INTERVAL_MS);
}

function stopPeerDiscovery() {
  if (peerDiscoveryInterval) {
    clearInterval(peerDiscoveryInterval);
    peerDiscoveryInterval = null;
  }
  if (peerDiscoverySocket) {
    try {
      peerDiscoverySocket.close();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    peerDiscoverySocket = null;
  }
  peerLocalSubnetDiscoveryPromise = null;
  discoveredPeers.clear();
}

function recordWitnessedSettlement(summary, fromPeer) {
  if (!summary || !summary.blockHash) return;
  const blockHash = String(summary.blockHash).trim();
  if (!blockHash) return;
  const entry = {
    blockHash,
    minedAddress: String(summary.minedAddress || ''),
    totalWh: Number(summary.totalWh) || 0,
    rewardCoins: Number(summary.rewardCoins) || 0,
    settledAtMs: Number(summary.settledAtMs) || Date.now(),
    sig: String(summary.sig || ''),
    fromPeer: String(fromPeer || 'self'),
  };
  const existing = witnessedSettlements.get(blockHash);
  if (existing && fromPeer !== 'self') {
    if (
      Math.abs(existing.totalWh - entry.totalWh) > 0.0001 ||
      Math.abs(existing.rewardCoins - entry.rewardCoins) > 1e-8
    ) {
      recordForkMismatch({ blockHash, fromPeer, localTotalWh: existing.totalWh, peerTotalWh: entry.totalWh });
      console.warn(
        `[SettlementGossip] MISMATCH for block ${blockHash}: ` +
          `local totalWh=${existing.totalWh} vs peer=${entry.totalWh}, ` +
          `local coins=${existing.rewardCoins} vs peer=${entry.rewardCoins} (from ${fromPeer})`,
      );
    }
  } else {
    witnessedSettlements.set(blockHash, entry);
    if (witnessedSettlements.size > 500) {
      witnessedSettlements.delete(witnessedSettlements.keys().next().value);
    }
  }
}

function broadcastSettlementToPeers(round) {
  const settings = getLedgerNetworkSettings();
  if (!settings.enabled) return;
  const peers = getActivePeers(settings);
  if (!peers || peers.length === 0) return;
  const summary = {
    blockHash: round.blockHash,
    minedAddress: round.minedAddress,
    totalWh: round.totalWh,
    rewardCoins: round.rewardCoins,
    settledAtMs: Date.now(),
  };
  summary.sig = computeHwAuthSig(summary);
  recordWitnessedSettlement(summary, 'self');
  for (const peerUrl of peers) {
    requestPeerJson(peerUrl, 'POST', '/api/v1/settlement/seen', summary, undefined, {
      trackReachability: false,
      suppressPeerDiscovery: true,
      source: 'settlement-gossip',
    }).catch(() => {});
  }
}

// ── Governance P2P gossip ─────────────────────────────────────────────────────

/** Cache of peer governance capability: Map<peerUrl, { hasNfts, cachedAtMs }> */
function _nodeHasGovernanceNfts() {
  if (!wtcNode) return false;
  const addrs = wtcNode.getAddresses();
  for (const addr of addrs) {
    const nfts = wtcNode.getNftsForAddress(addr);
    if (nfts && nfts.length > 0) return true;
  }
  return false;
}

/** Fetch governance snapshots from all peers and merge locally.
 *  Only runs on NFT-holding nodes — non-NFT nodes never receive governance data. */
async function syncGovernanceFromPeers() {
  if (!wtcNode) return;
  if (!_nodeHasGovernanceNfts()) return;
  // Close any expired proposals before syncing
  wtcNode.closeExpiredProposals();
  const settings = getLedgerNetworkSettings();
  if (!settings.enabled) return;
  const peers = getActivePeers(settings);
  if (!peers || peers.length === 0) return;

  const results = await Promise.allSettled(
    peers.map((peerUrl) =>
      requestPeerJson(peerUrl, 'GET', '/api/v1/governance/snapshot', undefined, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'governance-pull',
        timeoutMs: 10000,
      }).catch(() => null),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status !== 'fulfilled') continue;
    const snapshot = results[i].value;
    if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.proposals)) continue;

    for (const proposal of snapshot.proposals) {
      // Security: verify the creator's NFT holdings — never trust peer-supplied
      // creatorNftId / creatorTier.  Strip them if they don't match local truth.
      let creatorNftId = '';
      let creatorTier = '';
      if (proposal.creator) {
        const creatorNfts = wtcNode.getNftsForAddress(proposal.creator);
        if (creatorNfts && creatorNfts.length > 0) {
          const TIER_RANK = { gold: 3, silver: 2, bronze: 1 };
          let bestTier = 'bronze';
          let bestNftId = '';
          for (const nft of creatorNfts) {
            const tier = (nft.metadata && nft.metadata.tier) || 'bronze';
            if ((TIER_RANK[tier] || 0) > (TIER_RANK[bestTier] || 0)) {
              bestTier = tier;
              bestNftId = nft.nftId;
            }
          }
          creatorNftId = bestNftId;
          creatorTier = bestTier;
        }
      }

      // Merge proposal metadata
      const propResult = wtcNode.addGovernanceProposal({
        pipId: proposal.pipId,
        title: proposal.title,
        description: proposal.description || '',
        creator: proposal.creator || '',
        createdAt: proposal.createdAt || Date.now(),
        creatorNftId,
        creatorTier,
        votingDurationWeeks: Math.max(2, Math.min(10, Math.floor(Number(proposal.votingDurationWeeks) || 2))),
        commentPeriodWeeks: Math.max(1, Math.min(4, Math.floor(Number(proposal.commentPeriodWeeks) || 2))),
      });

      // Merge votes if the proposal was new or we already have it
      if (propResult.ok && proposal.votes) {
        for (const voterAddr of Object.keys(proposal.votes)) {
          const v = proposal.votes[voterAddr];
          if (!v || !v.signature) continue;

          // Verify the vote signature — the message includes power AND nftTier
          // so neither can be tampered with in transit.
          const msg = `${proposal.pipId}|${v.voter}|${v.vote}|${v.power}|${v.nftTier}|${v.timestamp}`;
          if (!wtcNode.verifyMessage(v.voter, v.signature, msg)) continue;

          // Security: always verify the voter's current NFT holdings.
          // The local NftStore determines real power — never trust peer-supplied
          // power or nftTier.  This prevents vote replay after NFT transfer.
          wtcNode.addGovernanceVote(proposal.pipId, {
            voter: v.voter,
            vote: v.vote,
            power: v.power,
            nftTier: v.nftTier,
            timestamp: v.timestamp,
            signature: v.signature,
          });
        }
      }
    }
  }
}

/** Schedule periodic governance sync. */
let _govSyncInterval = null;
function startGovernanceSync() {
  stopGovernanceSync();
  // Initial sync after a short delay to let the node settle
  setTimeout(() => syncGovernanceFromPeers().catch(() => {}), 5000);
  _govSyncInterval = setInterval(() => syncGovernanceFromPeers().catch(() => {}), 30_000);
}
function stopGovernanceSync() {
  if (_govSyncInterval) {
    clearInterval(_govSyncInterval);
    _govSyncInterval = null;
  }
}

function startLedgerNetworkServer() {
  if (ledgerNetworkServer) return;
  const settings = getLedgerNetworkSettings();
  if (!settings.enabled || settings.mode !== 'peer') return;

  ledgerNetworkServer = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const requesterIdentity = getRequesterIdentity(req);
      if (isPeerIdentityBanned(requesterIdentity)) {
        sendJson(res, 403, { ok: false, code: 'PEER_BANNED', message: 'Peer identity is temporarily banned.' });
        return;
      }

      if (reqUrl.pathname.startsWith('/api/v1/tunnel/')) {
        const handled = await handleReverseTunnelHttpRequest(req, res, settings);
        if (handled) return;
      }

      // GET /api/v1/probe/issue — unauthenticated: every peer must be able to request a
      // probe challenge without knowing the coordinator's machine-specific token.
      // Rate-limited by remote IP to prevent DoS.
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/probe/issue') {
        refreshCoordinatorIdentityKey();
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('peer-probe-issue', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const workerId = String(reqUrl.searchParams.get('workerId') || identity || 'unknown');
        if (workerId === 'unknown') {
          // No usable workerId and no IP fallback — issuing a probe here would create
          // an entry that can never be resolved, polluting the attest history.
          sendJson(res, 400, { ok: false, code: 'MISSING_WORKER_ID', message: 'workerId is required.' });
          return;
        }
        const allowGpu = reqUrl.searchParams.get('allowGpu') === 'true';
        const probe = issuePeerProbe(workerId, allowGpu);
        sendJson(res, 200, { ok: true, probe });
        return;
      }

      // POST /api/v1/probe/submit — unauthenticated: results are cryptographically verified;
      // a wrong proof is simply rejected.  Rate-limited by remote IP.
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/probe/submit') {
        refreshCoordinatorIdentityKey();
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('peer-probe-submit', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const body = await readJsonBody(req);
        const probeResult = {
          id: body && body.probeId ? String(body.probeId) : '',
          proof: body && body.proof ? String(body.proof) : '',
          pixelHash: body && body.pixelHash ? String(body.pixelHash) : '',
        };
        const hardwareSpec = body && typeof body.hardwareSpec === 'object' ? body.hardwareSpec : null;
        const verdict = submitPeerProbeResult(probeResult, hardwareSpec);
        if (verdict && verdict.receipt && wtcNode && typeof wtcNode.signMessage === 'function') {
          const verifierAddress = String(verdict.receipt.verifierAddress || '').trim();
          const workerId = String(verdict.receipt.workerId || '').trim();
          if (verifierAddress && workerId && verifierAddress === workerId) {
            console.warn('[PeerProbe] Self-verification attempt detected: verifierAddress equals workerId.');
            verdict.ok = false;
            verdict.issues = [
              ...(Array.isArray(verdict.issues) ? verdict.issues : []),
              'self-verification is not allowed',
            ];
            verdict.receipt = null;
          } else {
            const signingPayload = getProbeReceiptSigningPayload(verdict.receipt);
            if (verifierAddress && signingPayload) {
              try {
                const signed = wtcNode.signMessage(verifierAddress, signingPayload);
                verdict.receipt = attachProbeReceiptSignature(verdict.receipt, signed && signed.signature);
                if (verdict.receipt) {
                  recordPeerAttestation(verifierAddress, workerId);
                  broadcastProbeReceiptToPeers(verdict.receipt);
                }
              } catch (error) {
                console.warn(
                  '[PeerProbe] Failed to sign probe receipt:',
                  error && error.message ? error.message : error,
                );
                verdict.ok = false;
                verdict.issues = [
                  ...(Array.isArray(verdict.issues) ? verdict.issues : []),
                  'peer probe receipt signing failed',
                ];
                verdict.receipt = null;
              }
            }
          }
        }
        sendJson(res, 200, verdict);
        return;
      }

      // POST /api/v1/probe/receipt — receives a probe receipt broadcast from a
      // verifier peer.  The receipt is signed by the verifier and attests to a
      // worker having answered a specific probe.  Stores it so the worker's
      // contribution chainIndex can be cross-checked.
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/probe/receipt') {
        const body = await readJsonBody(req);
        const receipt = body && body.receipt && typeof body.receipt === 'object' ? body.receipt : null;
        if (!receipt || !receipt.workerId || !receipt.chainIndex || !receipt.verifierAddress) {
          sendJson(res, 400, { ok: false, code: 'INVALID_RECEIPT', message: 'Invalid probe receipt.' });
          return;
        }
        // Verify the receipt signature — must be signed by the claimed verifier.
        const normalizedReceipt = normalizeProbeReceipt(receipt);
        if (!normalizedReceipt) {
          sendJson(res, 400, { ok: false, code: 'INVALID_RECEIPT', message: 'Could not normalize receipt.' });
          return;
        }
        if (normalizedReceipt.verifierAddress === normalizedReceipt.workerId) {
          sendJson(res, 400, {
            ok: false,
            code: 'SELF_VERIFICATION',
            message: 'Verifier cannot attest to its own worker receipt.',
          });
          return;
        }
        if (
          !normalizedReceipt.signature ||
          typeof normalizedReceipt.signature !== 'string' ||
          normalizedReceipt.signature.length < 130
        ) {
          sendJson(res, 400, {
            ok: false,
            code: 'INVALID_SIGNATURE',
            message: 'Missing or invalid receipt signature.',
          });
          return;
        }
        const payload_no_sig = getProbeReceiptSigningPayload(normalizedReceipt);
        if (!payload_no_sig) {
          sendJson(res, 400, { ok: false, code: 'INVALID_PAYLOAD', message: 'Invalid receipt payload.' });
          return;
        }
        const verified = wtcNode.verifyMessage(
          normalizedReceipt.verifierAddress,
          normalizedReceipt.signature,
          payload_no_sig,
        );
        if (!verified) {
          sendJson(res, 403, {
            ok: false,
            code: 'SIGNATURE_MISMATCH',
            message: 'Receipt signature verification failed.',
          });
          return;
        }
        recordPeerAttestation(normalizedReceipt.verifierAddress, normalizedReceipt.workerId);
        // Store the receipt keyed by worker address + chainIndex.
        const workerAddr = normalizedReceipt.workerId;
        const chainIdx = Math.max(0, Math.floor(Number(normalizedReceipt.chainIndex) || 0));
        if (!witnessedProbeReceipts.has(workerAddr)) {
          witnessedProbeReceipts.set(workerAddr, { maxChainIndex: 0, receipts: new Map() });
        }
        const entry = witnessedProbeReceipts.get(workerAddr);
        if (chainIdx > (entry.maxChainIndex || 0)) {
          entry.maxChainIndex = chainIdx;
        }
        const receiptsForIndex = entry.receipts.get(chainIdx) || new Map();
        receiptsForIndex.set(String(normalizedReceipt.verifierAddress || '').trim(), normalizedReceipt);
        entry.receipts.set(chainIdx, receiptsForIndex);
        // Evict old entries to prevent unbounded growth (keep last 500 chain indexes per worker).
        if (entry.receipts.size > 500) {
          const oldest = [...entry.receipts.keys()].sort((a, b) => a - b).slice(0, 100);
          for (const k of oldest) entry.receipts.delete(k);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // ── Governance capability probe ──────────────────────────────────────────
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/governance/capability') {
        const rl = await enforceEndpointRateLimit('governance-capability', requesterIdentity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        sendJson(res, 200, { ok: true, hasNfts: _nodeHasGovernanceNfts() });
        return;
      }

      // ── Governance snapshot (pull-based sync) ────────────────────────────
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/governance/snapshot') {
        const rl = await enforceEndpointRateLimit('governance-snapshot', requesterIdentity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, error: 'Node not ready' });
          return;
        }
        try {
          const proposals = wtcNode.getGovernanceProposals();
          sendJson(res, 200, { ok: true, proposals });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e && e.message) });
        }
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/ops/metrics') {
        if (!isLedgerNetworkAuthorized(req, settings)) {
          recordPeerIdentityFailure(requesterIdentity, 'unauthorized-request');
          sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Missing or invalid ledger network token.' });
          return;
        }
        const snapshot = opsState.latestSnapshot || (await collectOpsSnapshot());
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/network/peers') {
        rememberObservedRequester(req, settings, 'peer-directory-presence');
        // Fire-and-forget: do NOT await the reachability probe.  Blocking the
        // response while probing back to the requester causes callers behind
        // NAT to time out (12 s probe vs 7 s caller timeout) → 0 peers.
        maybeRegisterReachableRequester(req, settings, 'peer-directory').catch(() => {});
        sendJson(res, 200, {
          ok: true,
          network: getActiveNetwork(),
          peers: buildAdvertisedPeerList(settings),
        });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/ops/health') {
        if (!isLedgerNetworkAuthorized(req, settings)) {
          recordPeerIdentityFailure(requesterIdentity, 'unauthorized-request');
          sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Missing or invalid ledger network token.' });
          return;
        }
        const snapshot = opsState.latestSnapshot || (await collectOpsSnapshot());
        sendJson(
          res,
          200,
          buildOpsHealthResponse(snapshot, {
            chainStallAlertMs: CHAIN_STALL_ALERT_MS,
          }),
        );
        return;
      }

      // POST /api/v1/settlement/seen  body: { blockHash, minedAddress, totalWh, rewardCoins, settledAtMs, sig }
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/settlement/seen') {
        const body = await readJsonBody(req);
        // Verify the HMAC sig before recording — prevents a malicious LAN peer from
        // injecting fake settlement records (e.g. inflated totalWh or rewardCoins).
        const { sig: receivedSig, ...bodyWithoutSig } = body || {};
        const expectedSig = computeHwAuthSig(bodyWithoutSig);
        if (!receivedSig || !secureStringEquals(String(receivedSig), expectedSig)) {
          sendJson(res, 403, { ok: false, code: 'INVALID_SETTLEMENT_SIG', message: 'Settlement signature invalid.' });
          return;
        }
        const fromPeer = getRequesterIdentity(req) || req.socket.remoteAddress || 'unknown';
        recordWitnessedSettlement(body, fromPeer);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/round/contribution') {
        if (!wtcNode || typeof wtcNode.verifyMessage !== 'function') {
          sendJson(res, 503, { ok: false, code: 'NODE_NOT_READY', message: 'Node not ready.' });
          return;
        }
        const body = await readJsonBody(req);
        const address = String((body && body.address) || '').trim();
        const roundId = Math.max(1, Math.floor(Number(body && body.roundId) || 0));
        const totalWh = Number(Math.max(0, Number(body && body.totalWh) || 0).toFixed(8));
        const updatedAtMs = Math.max(0, Math.floor(Number(body && body.updatedAtMs) || 0));
        const chainIndex = Math.max(-1, Math.floor(Number(body && body.chainIndex) || -1));
        const message = String((body && body.message) || '');
        const signature = String((body && body.signature) || '').trim();
        const expectedRoundId = getCurrentNetworkRoundId();
        if (!address || !isValidWtcAddress(address)) {
          sendJson(res, 400, { ok: false, code: 'INVALID_ADDRESS', message: 'Contribution address invalid.' });
          return;
        }
        if (roundId !== expectedRoundId) {
          sendJson(res, 409, {
            ok: false,
            code: 'ROUND_MISMATCH',
            message: `Expected round ${expectedRoundId}, got ${roundId}.`,
          });
          return;
        }
        const expectedMessage = buildRoundContributionMessage({ address, roundId, totalWh, updatedAtMs, chainIndex });
        if (!message || message !== expectedMessage) {
          sendJson(res, 400, { ok: false, code: 'INVALID_MESSAGE', message: 'Contribution message invalid.' });
          return;
        }
        if (!signature || !wtcNode.verifyMessage(address, signature, message)) {
          sendJson(res, 403, { ok: false, code: 'INVALID_SIGNATURE', message: 'Contribution signature invalid.' });
          return;
        }

        // Cross-check chainIndex against verifier-witnessed probe receipts.
        // The worker's claimed chainIndex must be attested by multiple verifiers,
        // and it must not exceed the highest verified chain index by more than 1.
        const MAX_WH_PER_PROBE = (500 * 5 * 60 * 1000) / 3600000; // ~41.7 Wh
        if (chainIndex >= 0 && witnessedProbeReceipts.has(address)) {
          const verifiedEntry = witnessedProbeReceipts.get(address);
          const receiptsForClaimedIndex = verifiedEntry.receipts.get(chainIndex) || new Map();
          if (receiptsForClaimedIndex.size < MIN_PROBE_VERIFIERS) {
            sendJson(res, 409, {
              ok: false,
              code: 'INSUFFICIENT_PROBE_ATTESTATIONS',
              message: `chainIndex ${chainIndex} has only ${receiptsForClaimedIndex.size} verifier attestations, requires ${MIN_PROBE_VERIFIERS}`,
            });
            return;
          }
          const verifiedMax = Math.max(0, verifiedEntry.maxChainIndex || 0);
          if (chainIndex > verifiedMax + 1) {
            sendJson(res, 409, {
              ok: false,
              code: 'PROBE_CHAIN_EXCEEDS_VERIFIED',
              message: `claimed chainIndex (${chainIndex}) exceeds verified max (${verifiedMax}) by more than 1`,
            });
            return;
          }
          const maxWhForChainIndex = chainIndex * MAX_WH_PER_PROBE;
          if (totalWh > maxWhForChainIndex) {
            sendJson(res, 409, {
              ok: false,
              code: 'CONTRIBUTION_EXCEEDS_PROBE_LIMIT',
              message: `totalWh (${totalWh}) exceeds max (${maxWhForChainIndex.toFixed(2)}) for chainIndex ${chainIndex}`,
            });
            return;
          }
        }

        alignRoundLedgerToChain(roundId);
        const applied = roundLedger.setRoundContribution(address, totalWh, updatedAtMs, chainIndex);
        if (!applied || applied.ok === false) {
          sendJson(res, 409, {
            ok: false,
            code: applied && applied.code ? applied.code : 'STALE_CONTRIBUTION',
            message:
              applied && applied.reason
                ? applied.reason
                : 'Contribution update is older than the latest accepted total for this round.',
            roundId,
            addressRoundWh: applied && typeof applied.addressRoundWh === 'number' ? applied.addressRoundWh : 0,
            updatedAtMs: applied && typeof applied.updatedAtMs === 'number' ? applied.updatedAtMs : 0,
          });
          return;
        }
        const snapshot = roundLedger.getCurrentRoundSnapshot();
        sendJson(res, 200, {
          ok: true,
          roundId: applied.roundId,
          addressRoundWh: applied.addressRoundWh,
          totalWh: snapshot.totalWh,
        });
        return;
      }

      // ── WTC native chain endpoints (unauthenticated — proofs are self-verifying) ──
      // GET /api/v1/chain/tip
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/chain/tip') {
        // Fire-and-forget: do NOT await the reachability probe.  The probe can
        // take up to PEER_REACHABILITY_TIMEOUT_MS (12 s) when the requester is
        // behind NAT, which exceeds the caller's own request timeout (6–7 s)
        // and causes them to see 0 peers.
        maybeRegisterReachableRequester(req, settings, 'tip-probe').catch(() => {});
        const tip = wtcNode ? wtcNode.handleGetTip() : { ok: false, reason: 'node not ready' };
        sendJson(res, 200, tip);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chain/tip') {
        const body = await readJsonBody(req);
        handlePeerTipSignal(getRequesterIdentity(req), body, 'tip-announce');
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chain/push') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const body = await readJsonBody(req);
        const fromPeer = getRequesterIdentity(req) || req.socket.remoteAddress || 'unknown';
        const pushResult = wtcNode.handlePushBlocks({
          ancestorHeight: body && body.ancestorHeight,
          blocks: body && body.blocks,
          peer: fromPeer,
        });
        if (pushResult && pushResult.synced) {
          handlePeerTipSignal(fromPeer, { height: pushResult.toHeight }, 'push-chain');
        }
        sendJson(res, 200, pushResult);
        return;
      }

      if (reqUrl.pathname.startsWith('/api/v1/chain/')) {
        const compat = verifyChainPeerCompatibility(req);
        if (!compat.ok) {
          recordPeerIdentityFailure(requesterIdentity, `chain-compat:${compat.reason}`);
          sendJson(res, 409, { ok: false, code: 'CHAIN_INCOMPATIBLE', message: compat.reason });
          return;
        }
      }

      // GET /api/v1/chain/headers?fromHeight=&limit=
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/chain/headers') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('wtc-peer-chain-headers', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const fromHeight = Number(reqUrl.searchParams.get('fromHeight')) || 0;
        const limit = Number(reqUrl.searchParams.get('limit')) || 200;
        sendJson(res, 200, wtcNode.handleGetHeaders(fromHeight, limit));
        return;
      }

      // GET /api/v1/chain/blocks?fromHeight=&limit=
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/chain/blocks') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('wtc-peer-chain-blocks', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const fromHeight = Number(reqUrl.searchParams.get('fromHeight')) || 0;
        const limit = Number(reqUrl.searchParams.get('limit')) || 100;
        sendJson(res, 200, wtcNode.handleGetBlocks(fromHeight, limit));
        return;
      }

      // GET /api/v1/chain/block/{hash}
      if (req.method === 'GET' && reqUrl.pathname.startsWith('/api/v1/chain/block/')) {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('wtc-peer-chain-block-hash', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const hash = reqUrl.pathname.slice('/api/v1/chain/block/'.length);
        sendJson(res, 200, wtcNode.handleGetBlockByHash(hash));
        return;
      }

      // POST /api/v1/chain/propose
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chain/propose') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const body = await readJsonBody(req);
        const fromPeer = getRequesterIdentity(req) || req.socket.remoteAddress || 'unknown';
        const voteReply = await wtcNode.handleProposal(body, fromPeer);
        sendJson(res, 200, voteReply);
        return;
      }

      // POST /api/v1/chain/vote
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chain/vote') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const body = await readJsonBody(req);
        const result = wtcNode.handleVote(body);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Ledger endpoint not found.' });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        code: 'LEDGER_NETWORK_ERROR',
        message: error && error.message ? error.message : 'Peer request failed.',
      });
    }
  });

  startReverseTunnelCoordinator(settings);

  ledgerNetworkServer.listen(settings.listenPort, settings.listenHost, async () => {
    await refreshAutoPublicPeerUrl(settings);
    await refreshRemoteSeedPeers(settings);
    const effectiveSettings = getLedgerNetworkSettings();
    const listenUrls = getLedgerListenUrls(effectiveSettings);
    const advertisedUrls = getConfiguredAdvertisedPeerUrls(effectiveSettings);
    const configuredPeers = (effectiveSettings.configuredPeers || []).join(', ');
    const seedPeers = (effectiveSettings.seedPeers || []).join(', ');
    console.log(`[Wattcoin] Ledger ${effectiveSettings.mode} listening on this node: ${listenUrls.join(', ')}`);
    if (advertisedUrls.length > 0) {
      console.log(`[Wattcoin] Ledger ${effectiveSettings.mode} advertising as: ${advertisedUrls.join(', ')}`);
    } else if (effectiveSettings.mode === 'peer') {
      console.log(
        '[Wattcoin] Ledger peer public advertise URL: none configured; using seed/bootstrap peers, discovery, and managed tunnel when available.',
      );
    }
    if (configuredPeers) {
      console.log(`[Wattcoin] Explicit static ledger peers: ${configuredPeers}`);
    }
    if (seedPeers) {
      console.log(`[Wattcoin] Seed/bootstrap peers: ${seedPeers}`);
    }
    startPeerDiscovery(effectiveSettings.listenPort, getPrimaryAdvertisedPeerUrl(effectiveSettings));
    startAutoPublicPeerUrlRefresh(effectiveSettings);
    startRemoteSeedPeerRefresh(effectiveSettings);
    ensureManagedReverseTunnelClient(effectiveSettings);
  });
}

function stopLedgerNetworkServer() {
  stopGovernanceSync();
  stopRemoteSeedPeerRefresh();
  stopAutoPublicPeerUrlRefresh();
  stopPeerDiscovery();
  stopManagedReverseTunnelClient();
  stopReverseTunnelCoordinator();
  if (!ledgerNetworkServer) return;
  try {
    ledgerNetworkServer.close();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  ledgerNetworkServer = null;
}

ipcMain.handle('wattcoin-ledger-add-contribution', async (_, address, deltaWh) => {
  // ── Address: use verified wallet cache; renderer-supplied is only a fallback ─
  // Once the wallet is known to main, we ignore the renderer-supplied address so
  // a patched renderer cannot credit energy to an arbitrary wallet.
  const verifiedAddress =
    walletAddressCache.address || (typeof address === 'string' && address.trim() ? address.trim() : 'local-client');

  // Block if hardware changed but wallet hasn't been regenerated yet.
  if (hwAuthority.hwChangedBlocked) {
    return {
      ok: false,
      code: 'HW_CHANGED',
      message: 'Hardware changed. Please create a new wallet to continue mining.',
    };
  }

  // Block contributions if no CPU benchmark has ever been completed.
  // Without at least one benchmark there is no verified hardware capability,
  // so any claimed energy is unverifiable.  A patched renderer cannot bypass
  // this because the benchmark history is HMAC-signed in userData — the main
  // process owns it, not the renderer.
  const _contributionBenchHistory = loadBenchmarkHistory();
  if (_contributionBenchHistory.cpuSamples.length === 0) {
    return {
      ok: false,
      code: 'NEVER_BENCHMARKED',
      message: 'No benchmark data on record. Complete a full hardware benchmark before mining.',
    };
  }

  // ── deltaWh ceiling: clamp to one second of trust-capped calibrated power ───
  // This prevents a patched renderer from injecting arbitrarily large energy
  // values.  At the normal 0.25s tick rate the legitimate value is 4× smaller.
  let clampedDeltaWh = Math.max(0, Number(deltaWh) || 0);
  if (hwAuthority.calibratedUnitPowerW > 0) {
    const tf = Math.min(1.0, 0.6 + Math.max(0, (hwAuthority.trustScore - 50) / 50) * 0.4);
    // 0.5 s of max power: twice the normal 0.25 s tick interval as jitter headroom.
    // At the 240-calls/min rate limit this caps injection at ≤2× the legitimate rate.
    const maxDeltaWh = (hwAuthority.calibratedUnitPowerW * tf * 0.5) / 3600;
    if (clampedDeltaWh > maxDeltaWh) {
      console.warn(
        `[Ledger] deltaWh clamped ${clampedDeltaWh.toFixed(6)} â†’ ${maxDeltaWh.toFixed(6)} Wh` +
          ` for ${verifiedAddress} (calibratedUnitPowerW=${hwAuthority.calibratedUnitPowerW} W, trust=${hwAuthority.trustScore})`,
      );
      clampedDeltaWh = maxDeltaWh;
    }
  }

  const actorId = verifiedAddress;
  const rateLimit = await enforceEndpointRateLimit('wattcoin-ledger-add-contribution', actorId, {
    address: actorId,
    deltaWh: clampedDeltaWh,
  });
  if (!rateLimit.ok) {
    return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
  }
  try {
    alignRoundLedgerToChain();
    const added = roundLedger.addContribution(verifiedAddress, clampedDeltaWh);
    const snapshot = roundLedger.getCurrentRoundSnapshot();
    broadcastRoundContributionToPeers({
      address: verifiedAddress,
      roundId: snapshot.id,
      totalWh: added.addressRoundWh,
    }).catch(() => {});
    return { ...added, roundTotalWh: snapshot.totalWh };
  } catch (e) {
    return {
      ok: false,
      code: 'LEDGER_ADD_FAILED',
      message: e && e.message ? e.message : 'Failed to add contribution.',
    };
  }
});

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
    return { ok: false, code: 'LEDGER_SETTLE_FAILED', message: e && e.message ? e.message : 'Failed to settle round.' };
  }
});

ipcMain.handle('wattcoin-ledger-get-balances', async (_, selectedAddress) => {
  const actorId =
    typeof selectedAddress === 'string' && selectedAddress.trim() ? selectedAddress.trim() : 'local-client';
  const rateLimit = await enforceEndpointRateLimit('wattcoin-ledger-get-balances', actorId, {
    selectedAddress: actorId,
  });
  if (!rateLimit.ok) {
    return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
  }
  // ── WTC native chain balance ───────────────────────────────────────────────
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
    return { ok: false, code: 'LEDGER_READ_FAILED', message: e && e.message ? e.message : 'Failed to read balances.' };
  }
});

// Get WTC balances reconstructed from mined block history for a specific mining address.
ipcMain.handle('wattcoin-get-node-mined-coins', (_, selectedAddress) => {
  // ── WTC native chain fast-path ───────────────────────────────────────
  if (wtcNode) {
    try {
      const addr =
        typeof selectedAddress === 'string' && selectedAddress.trim()
          ? selectedAddress.trim()
          : wtcNode.getPrimaryAddress();
      const bal = wtcNode.getBalance(addr);
      const stats = wtcNode.getMinedStats(addr);
      return {
        ok: true,
        address: addr,
        blocks: wtcNode.getHeight(),
        minedCoins: stats.totalWTC,
        maturedMinedCoins: bal.confirmed,
        unmaturedMinedCoins: bal.unmatured,
        totalMinedCoins: stats.totalWTC,
        totalMinedBlocks: stats.totalBlocks,
        maturedMinedBlocks: stats.maturedBlocks,
        unmaturedMinedBlocks: Math.max(0, stats.totalBlocks - stats.maturedBlocks),
        maturityDepth: 100,
      };
    } catch (e) {
      return { ok: false, code: 'BALANCE_READ_FAILED', message: e && e.message ? e.message : 'Failed' };
    }
  }
});

ipcMain.handle('wattcoin-send', async (_, payload = {}) => {
  const _walletName = 'wattminer';
  const betaPolicy = getBetaPolicy();
  if (!betaPolicy.withdrawalsEnabled) {
    await logAbuseEvent({
      type: 'withdrawal-blocked-beta',
      endpoint: 'wattcoin-send',
      actorId: 'local-client',
      metadata: {
        selectedAddress: payload && payload.selectedAddress ? String(payload.selectedAddress) : '',
      },
    });
    return { ok: false, code: 'BETA_WITHDRAWALS_DISABLED', message: betaPolicy.policyMessage };
  }

  // ── Sender whitelist (hardcoded — cannot be overridden by config) ─────────
  const fromAddr = payload && typeof payload.selectedAddress === 'string' ? payload.selectedAddress.trim() : '';
  if (!fromAddr || !ALLOWED_SENDER_ADDRESSES.has(fromAddr)) {
    return { ok: false, code: 'SENDER_NOT_ALLOWED', message: 'Withdrawals are not available for this address.' };
  }
  const actorId =
    payload && typeof payload.selectedAddress === 'string' && payload.selectedAddress.trim()
      ? payload.selectedAddress.trim()
      : 'local-client';
  const rateLimit = await enforceEndpointRateLimit('wattcoin-send', actorId, {
    toAddress: payload && payload.toAddress ? String(payload.toAddress) : '',
    amount: Number(payload && payload.amount) || 0,
  });
  if (!rateLimit.ok) {
    return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
  }
  const toAddress = typeof payload.toAddress === 'string' ? payload.toAddress.trim() : '';
  const amount = Number(payload.amount);
  const subtractFeeFromAmount = !!(payload && payload.subtractFeeFromAmount);

  if (!toAddress) {
    return { ok: false, code: 'INVALID_ADDRESS', message: 'Recipient address is required.' };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'Amount must be greater than 0.' };
  }

  // ── WTC native chain path ─────────────────────────────────────────────────
  if (wtcNode) {
    try {
      const fromAddress =
        payload && typeof payload.selectedAddress === 'string'
          ? payload.selectedAddress.trim()
          : wtcNode.getPrimaryAddress();
      const result = wtcNode.send({ fromAddress, toAddress, amount, subtractFeeFromAmount });
      // Transaction is now in the mempool — it will be included in the next
      // naturally mined block. No flush block is triggered here.
      return { ok: true, txid: result.txid, toAddress, amount: result.amount, subtractFeeFromAmount };
    } catch (e) {
      return { ok: false, code: 'SEND_FAILED', message: e && e.message ? e.message : 'Send failed' };
    }
  }
});

ipcMain.handle('wattcoin-get-tx-status', (_, payload = {}) => {
  const txid = typeof payload.txid === 'string' ? payload.txid.trim() : '';
  if (!txid) return { ok: false, code: 'MISSING_TXID', message: 'txid required' };
  if (wtcNode) {
    const { status } = wtcNode.getTxStatus(txid);
    return { ok: true, txid, status };
  }
  return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
});

ipcMain.handle('wattcoin-list-transactions', async (_, payload = {}) => {
  const _walletName = 'wattminer';
  const actorId =
    payload && typeof payload.selectedAddress === 'string' && payload.selectedAddress.trim()
      ? payload.selectedAddress.trim()
      : 'local-client';
  const rateLimit = await enforceEndpointRateLimit('wattcoin-list-transactions', actorId, { selectedAddress: actorId });
  if (!rateLimit.ok) {
    return { ok: false, code: rateLimit.code, message: rateLimit.message, lockedUntil: rateLimit.lockedUntil || 0 };
  }
  const countRaw = Number(payload && payload.count);
  const count = Math.min(200, Math.max(1, Number.isFinite(countRaw) ? Math.floor(countRaw) : 50));
  const selectedAddress = typeof payload.selectedAddress === 'string' ? payload.selectedAddress.trim() : '';

  // ── WTC native chain path ─────────────────────────────────────────────────
  if (wtcNode) {
    const txs = wtcNode.listTransactions(selectedAddress || wtcNode.getPrimaryAddress(), count);
    return { ok: true, selectedAddress, count: txs.length, transactions: txs };
  }
  return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
});

// Get all addresses with their labels
ipcMain.handle('wattcoin-get-addresses', () => {
  if (wtcNode) {
    const addresses = wtcNode.getAddresses();
    return { ok: true, addresses };
  }
  return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
});

// Create a new mining address
ipcMain.handle('wattcoin-create-address', () => {
  if (wtcNode) {
    try {
      const { address } = wtcNode.createAddress();
      wtcNode.setPrimaryAddress(address);
      walletAddressCache = { address, at: Date.now() };
      const allAddresses = wtcNode.getAddresses();
      refreshWalletSyncState('create-address', { force: true }).catch(() => {});
      return { ok: true, address, allAddresses };
    } catch (e) {
      return { ok: false, code: 'CREATE_FAILED', message: e && e.message ? e.message : 'Failed to create address' };
    }
  }
  return { ok: false, code: 'NODE_NOT_READY', message: 'Node not initialised yet.' };
});

ipcMain.handle('wattcoin-delete-address', (_, targetAddress) => {
  const address = typeof targetAddress === 'string' ? targetAddress.trim() : '';
  if (!address) {
    return { ok: false, code: 'INVALID_ADDRESS', message: 'No address selected for deletion.' };
  }
  if (wtcNode) {
    try {
      if (wtcNode.getPrimaryAddress() === address) {
        const remaining = wtcNode.getAddresses().filter((entry) => entry !== address);
        if (remaining.length === 0) {
          return { ok: false, code: 'DELETE_FAILED', message: 'Cannot delete the only wallet address.' };
        }
        wtcNode.setPrimaryAddress(remaining[0]);
      }
      wtcNode.deleteAddress(address);
      const nextPrimary = wtcNode.getPrimaryAddress();
      walletAddressCache = { address: nextPrimary || '', at: nextPrimary ? Date.now() : 0 };
      refreshWalletSyncState('delete-address', { force: true }).catch(() => {});
      return { ok: true, deletedAddress: address, allAddresses: wtcNode.getAddresses() };
    } catch (e) {
      return { ok: false, code: 'DELETE_FAILED', message: e && e.message ? e.message : 'Delete failed' };
    }
  }
  return { ok: false, code: 'NODE_NOT_READY', message: 'Node is starting up.' };
});

// Get wallet seed phrase or backup guidance.
ipcMain.handle('wattcoin-get-seed', () => {
  return { ok: false, code: 'NOT_SUPPORTED', message: 'Seed phrases are not available for WTC native wallets.' };
});

ipcMain.handle('wattcoin-export-wallet-backup', async (_, options = {}) => {
  const passphrase = options && typeof options.passphrase === 'string' ? options.passphrase : '';
  if (!validatePassphrase(passphrase)) {
    return { ok: false, code: 'INVALID_PASSPHRASE', message: 'Passphrase must be at least 8 characters.' };
  }
  try {
    const walletFilePath = path.join(getWalletDataDir(), 'wtc-wallet.json');
    if (!fs.existsSync(walletFilePath)) {
      return { ok: false, code: 'WALLET_FILE_MISSING', message: 'WTC wallet file not found.' };
    }
    const backupTimestamp = formatBackupTimestampForFilename();
    const saveResult = await dialog.showSaveDialog(getFocusedWindow(), {
      title: 'Export Encrypted Wallet Backup',
      defaultPath: `wattcoin-wtc-${backupTimestamp}.${BACKUP_FILE_EXTENSION}`,
      filters: [{ name: 'Wattcoin Wallet Backup', extensions: [BACKUP_FILE_EXTENSION] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (saveResult.canceled || !saveResult.filePath) {
      return { ok: false, code: 'CANCELED', message: 'Backup export canceled.' };
    }
    const walletBytes = await fsp.readFile(walletFilePath);
    const createdAt = new Date().toISOString();
    const walletHash = sha256Hex(walletBytes);
    const payload = {
      metadata: { walletName: 'wtc-native', network: getActiveNetwork(), createdAt, app: 'Wattcoin' },
      walletDatBase64: walletBytes.toString('base64'),
      integrity: { algorithm: 'sha256', walletDatHex: walletHash },
    };
    const encrypted = encryptBackupPayload(payload, passphrase);
    const container = {
      format: 'WATTCOIN_WALLET_BACKUP',
      version: BACKUP_FORMAT_VERSION,
      kdf: { name: 'scrypt', keyLength: 32 },
      cipher: { name: 'aes-256-gcm' },
      encrypted,
    };
    await fsp.writeFile(saveResult.filePath, JSON.stringify(container, null, 2), 'utf8');
    return { ok: true, filePath: saveResult.filePath, walletName: 'wtc-native', createdAt, checksum: walletHash };
  } catch (e) {
    return normalizeWalletError(e);
  }
});

ipcMain.handle('wattcoin-restore-wallet-backup', async (_, options = {}) => {
  const defaultWalletName = 'wattminer';
  const passphrase = options && typeof options.passphrase === 'string' ? options.passphrase : '';
  const allowOverwrite = !!(options && options.allowOverwrite);
  if (!validatePassphrase(passphrase)) {
    return { ok: false, code: 'INVALID_PASSPHRASE', message: 'Passphrase must be at least 8 characters.' };
  }
  try {
    const openResult = await dialog.showOpenDialog(getFocusedWindow(), {
      title: 'Restore Encrypted Wallet Backup',
      filters: [{ name: 'Wattcoin Wallet Backup', extensions: [BACKUP_FILE_EXTENSION] }],
      properties: ['openFile'],
    });
    if (openResult.canceled || !openResult.filePaths || openResult.filePaths.length === 0) {
      return { ok: false, code: 'CANCELED', message: 'Backup restore canceled.' };
    }
    const backupPath = openResult.filePaths[0];
    if (!backupPath) {
      return { ok: false, code: 'CANCELED', message: 'Backup restore canceled.' };
    }
    if (!fs.existsSync(backupPath)) {
      return { ok: false, code: 'BACKUP_FILE_MISSING', message: `Backup file not found: ${backupPath}` };
    }
    const raw = await fsp.readFile(backupPath, 'utf8');
    const container = parseBackupContainer(raw);
    let payload = null;
    try {
      payload = decryptBackupPayload(container.encrypted, passphrase);
    } catch (_) {
      return { ok: false, code: 'DECRYPT_FAILED', message: 'Failed to decrypt backup. Check your passphrase.' };
    }
    const metadata = payload && payload.metadata ? payload.metadata : {};
    const _walletName =
      typeof metadata.walletName === 'string' && metadata.walletName ? metadata.walletName : defaultWalletName;
    const expectedNetwork = getActiveNetwork();
    const network = metadata && metadata.network ? metadata.network : 'unknown';
    if (network !== expectedNetwork) {
      return {
        ok: false,
        code: 'NETWORK_MISMATCH',
        message: `Backup network is ${network}, expected ${expectedNetwork}.`,
      };
    }
    const walletDataBase64 = payload && payload.walletDatBase64 ? payload.walletDatBase64 : '';
    const walletDat = Buffer.from(walletDataBase64, 'base64');
    if (!walletDat || walletDat.length === 0) {
      return { ok: false, code: 'INVALID_BACKUP', message: 'Backup payload does not contain wallet data.' };
    }
    const expectedHash = payload && payload.integrity ? payload.integrity.walletDatHex : '';
    const actualHash = sha256Hex(walletDat);
    if (!expectedHash || expectedHash !== actualHash) {
      return { ok: false, code: 'INTEGRITY_CHECK_FAILED', message: 'Backup checksum verification failed.' };
    }
    const walletFilePath = path.join(getWalletDataDir(), 'wtc-wallet.json');
    const walletDir = path.dirname(walletFilePath);
    if (!allowOverwrite && fs.existsSync(walletFilePath)) {
      return {
        ok: false,
        code: 'WALLET_EXISTS',
        backupPath,
        message: `Wallet already exists at ${walletFilePath}. Confirm overwrite in the UI.`,
      };
    }
    try {
      stopHardwareLoad();
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    await fsp.mkdir(walletDir, { recursive: true });
    await fsp.writeFile(walletFilePath, walletDat);
    try {
      const wtcSecret = (() => {
        try {
          const raw = JSON.parse(fs.readFileSync(getDeviceIdentityFilePath(), 'utf8'));
          return raw && raw.secret ? raw.secret : '';
        } catch (_) {
          return '';
        }
      })();
      wtcNode = createWtcNode({
        dataDir: getWalletDataDir(),
        signingSecret: wtcSecret || crypto.randomBytes(32).toString('hex'),
        peerIdentity: String(loadOrCreateDeviceIdentity().deviceId || '').trim(),
        walletKey: getOrCreateWalletEncryptionKey(),
        getActivePeers: () => getActivePeers(getLedgerNetworkSettings()),
        getConnectedPeerCount: () => getActiveReverseTunnelPeerConnectionCount(),
        getPeerTargets: () => getPeerDirectoryTargets(getLedgerNetworkSettings()),
        getTrustedPeerTargets: () => getTrustedPeerTargets(getLedgerNetworkSettings()),
        requestPeerJson,
        isSelfPeerUrl,
        onPeerTip: (peerUrl, tip) => handlePeerTipSignal(peerUrl, tip, 'tip-probe'),
        allowPartialQuorumCommit: !(getLedgerNetworkSettings().enabled && getLedgerNetworkSettings().mode === 'peer'),
        isLiveLocalTunnelPeer: getLocalTunnelPeerLiveness,
        getEnergyContributions: () => roundLedger.getCurrentRoundSnapshot().contributionsWh,
      });
      startGovernanceSync();
      try {
        const restoredPrimary = wtcNode.getPrimaryAddress();
        walletAddressCache = { address: restoredPrimary || '', at: restoredPrimary ? Date.now() : 0 };
        if (restoredPrimary) setCoordinatorIdentityKey(restoredPrimary);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    } catch (reinitErr) {
      console.error('[RestoreBackup] Failed to re-init WTC node:', reinitErr && reinitErr.message);
    }
    const allAddresses = wtcNode ? wtcNode.getAddresses() : [];
    refreshWalletSyncState('restore-wallet-backup', { force: true }).catch(() => {});
    return {
      ok: true,
      walletName: 'wtc-native',
      filePath: backupPath,
      restoredTo: walletFilePath,
      checksum: actualHash,
      restartedNode: true,
      allAddresses,
    };
  } catch (e) {
    return normalizeWalletError(e);
  }
});

// ── Binary integrity verification ──────────────────────────────────────────────
// Reads binary-manifest.json (written by scripts/after-sign-windows.js afterSign
// hook) and verifies the SHA-256 of every bundled binary before the node daemon
// is launched.  Only runs in packaged builds; dev mode always passes.
function verifyBinaryManifest() {
  if (!app.isPackaged) return { ok: true, checked: 0, skipped: 'dev-mode' };
  const manifestPath = path.join(process.resourcesPath, 'binary-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn('[BinaryIntegrity] binary-manifest.json not found - integrity check skipped.');
    return { ok: true, checked: 0, skipped: 'no-manifest' };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const failures = [];
    let checked = 0;
    for (const [rel, expectedHash] of Object.entries(manifest)) {
      if (typeof expectedHash !== 'string' || expectedHash.length !== 64) continue;
      const absPath = path.join(process.resourcesPath, rel.split('/').join(path.sep));
      checked++;
      if (!fs.existsSync(absPath)) {
        failures.push({ rel, reason: 'missing' });
        console.error(`[BinaryIntegrity] MISSING: ${rel}`);
        continue;
      }
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      if (actualHash !== expectedHash) {
        failures.push({ rel, reason: 'hash-mismatch' });
        console.error(`[BinaryIntegrity] TAMPER DETECTED: ${rel}`);
      }
    }
    if (failures.length > 0) return { ok: false, checked, failures };
    console.log(`[BinaryIntegrity] ${checked} bundled binaries verified OK.`);
    return { ok: true, checked, failures: [] };
  } catch (e) {
    console.error('[BinaryIntegrity] manifest read error:', e && e.message);
    return { ok: false, checked: 0, failures: [{ rel: 'manifest', reason: e && e.message }] };
  }
}

// ── App JS integrity verification ─────────────────────────────────────────────
// Manifest is generated during release build (scripts/release-build.js) and
// packaged into the app. Verifies critical JS modules inside app.asar.
function verifyAppIntegrityManifest() {
  if (!app.isPackaged) return { ok: true, checked: 0, skipped: 'dev-mode' };
  const manifestPath = path.join(__dirname, 'app-integrity-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.warn('[AppIntegrity] app-integrity-manifest.json not found - integrity check skipped.');
    return { ok: true, checked: 0, skipped: 'no-manifest' };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const failures = [];
    let checked = 0;
    for (const [rel, expectedHash] of Object.entries(manifest)) {
      if (typeof expectedHash !== 'string' || expectedHash.length !== 64) continue;
      const absPath = path.join(__dirname, rel.split('/').join(path.sep));
      checked++;
      if (!fs.existsSync(absPath)) {
        failures.push({ rel, reason: 'missing' });
        console.error(`[AppIntegrity] MISSING: ${rel}`);
        continue;
      }
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
      if (actualHash !== expectedHash) {
        failures.push({ rel, reason: 'hash-mismatch' });
        console.error(`[AppIntegrity] TAMPER DETECTED: ${rel}`);
      }
    }
    if (failures.length > 0) return { ok: false, checked, failures };
    console.log(`[AppIntegrity] ${checked} app modules verified OK.`);
    return { ok: true, checked, failures: [] };
  } catch (e) {
    console.error('[AppIntegrity] manifest read error:', e && e.message);
    return { ok: false, checked: 0, failures: [{ rel: 'manifest', reason: e && e.message }] };
  }
}

// ── Anti-debug friction (release only) ───────────────────────────────────────
// Lightweight checks that block obvious debugger-enabled launches in packaged builds.
function verifyReleaseDebuggerFriction() {
  if (!app.isPackaged) return { ok: true, skipped: 'dev-mode' };
  if (process.env.WATTCOIN_ALLOW_DEBUGGER === '1') return { ok: true, skipped: 'override' };

  const suspectArgs = [];
  const argv = [...process.execArgv, ...process.argv];
  for (const arg of argv) {
    const v = String(arg || '').toLowerCase();
    if (v.includes('--inspect') || v.includes('--remote-debugging-port') || v.includes('--debug-brk')) {
      suspectArgs.push(arg);
    }
  }
  const nodeOptions = String(process.env.NODE_OPTIONS || '').toLowerCase();
  if (nodeOptions.includes('inspect') || nodeOptions.includes('debug')) {
    suspectArgs.push(`NODE_OPTIONS=${process.env.NODE_OPTIONS}`);
  }
  if (suspectArgs.length > 0) {
    return { ok: false, reasons: suspectArgs };
  }
  return { ok: true };
}

// Force cache and userData to a writable location (user's home directory)
const userDataPath = getWalletDataDir();
app.setPath('userData', userDataPath);
app.setPath('cache', path.join(userDataPath, 'Cache'));

const LEDGER_RECONCILE_INTERVAL_MS = 10 * 60_000;
let ledgerReconcileTimer = null;
const WTC_PEER_SYNC_INTERVAL_MS = 60_000;
let wtcPeerSyncTimer = null;
const WTC_PEER_SYNC_DEBOUNCE_MS = 1500;
let wtcPeerSyncDebounceTimer = null;
let wtcPeerSyncPendingReason = '';

function startLedgerReconcileLoop() {
  if (ledgerReconcileTimer) return;
  ledgerReconcileTimer = setInterval(async () => {
    try {
      const blockHeight = await getCurrentBlockHeight();
      roundLedger.syncMaturity(blockHeight);
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
  }, LEDGER_RECONCILE_INTERVAL_MS);
}

function stopLedgerReconcileLoop() {
  if (!ledgerReconcileTimer) return;
  clearInterval(ledgerReconcileTimer);
  ledgerReconcileTimer = null;
}

async function runWtcPeerSync(triggerLabel) {
  const label = String(triggerLabel || 'unknown');
  opsState.lastSyncAttemptAt = Date.now();

  if (!wtcNode) {
    opsState.lastSyncResult = { ok: false, reason: 'wtcNode unavailable', trigger: label };
    console.warn(`[WtcSync] ${label}: wtcNode unavailable`);
    return opsState.lastSyncResult;
  }
  if (typeof wtcNode.syncWithPeers !== 'function') {
    opsState.lastSyncResult = { ok: false, reason: 'syncWithPeers unavailable', trigger: label };
    console.warn(`[WtcSync] ${label}: syncWithPeers unavailable`);
    return opsState.lastSyncResult;
  }

  try {
    const res = await wtcNode.syncWithPeers();
    opsState.lastSyncResult = res || null;
    if (res && res.synced) {
      console.log(
        `[WtcSync] ${label}: synced ${res.fromHeight}->${res.toHeight} from ${res.peer} (${res.imported} blocks)`,
      );
    } else if (res && !res.ok) {
      console.warn(`[WtcSync] ${label}: sync failed: ${res.reason}`);
    }
    if (res && typeof res.rollbackDepth === 'number') {
      recordRollbackDepth(res.rollbackDepth, { peer: res.peer || '', ancestor: res.ancestor, trigger: label });
    }
    return res;
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    opsState.lastSyncResult = { ok: false, reason, trigger: label };
    console.warn(`[WtcSync] ${label}: peer sync threw: ${reason}`);
    return opsState.lastSyncResult;
  }
}

function scheduleWtcPeerSync(reason, delayMs = WTC_PEER_SYNC_DEBOUNCE_MS) {
  const settings = getLedgerNetworkSettings();
  if (!settings || !settings.enabled || settings.mode !== 'peer') return;
  const normalizedReason = String(reason || 'scheduled');
  wtcPeerSyncPendingReason = wtcPeerSyncPendingReason
    ? `${wtcPeerSyncPendingReason},${normalizedReason}`
    : normalizedReason;
  if (wtcPeerSyncDebounceTimer) return;
  wtcPeerSyncDebounceTimer = setTimeout(
    async () => {
      const pendingReason = wtcPeerSyncPendingReason || normalizedReason;
      wtcPeerSyncPendingReason = '';
      wtcPeerSyncDebounceTimer = null;
      await runWtcPeerSync(`debounced:${pendingReason}`);
    },
    Math.max(0, Number(delayMs) || 0),
  );
}

function handlePeerTipSignal(peerUrl, tip = null, source = 'tip-probe') {
  rememberDiscoveredPeer(peerUrl, { source, quiet: true });
  const remoteHeight = Number(tip && tip.height);
  const localHeight = wtcNode && typeof wtcNode.getHeight === 'function' ? Number(wtcNode.getHeight()) : Number.NaN;
  if (Number.isFinite(remoteHeight) && Number.isFinite(localHeight) && remoteHeight > localHeight) {
    scheduleWtcPeerSync(`${source}-higher-tip`, 250);
  }
}

function buildPushChainPayload(windowSize = 200) {
  if (!wtcNode || typeof wtcNode.handleGetBlocks !== 'function' || typeof wtcNode.getHeight !== 'function') {
    return null;
  }
  const tipHeight = Number(wtcNode.getHeight());
  if (!Number.isFinite(tipHeight) || tipHeight < 0) return null;
  const fromHeight = Math.max(0, tipHeight - Math.max(1, Number(windowSize) || 1) + 1);
  const response = wtcNode.handleGetBlocks(fromHeight, windowSize);
  const blocks = response && Array.isArray(response.blocks) ? response.blocks : [];
  if (blocks.length === 0) return null;
  return {
    ancestorHeight: fromHeight - 1,
    blocks,
  };
}

function pushChainToPeers({ windowSize = 200 } = {}) {
  const settings = getLedgerNetworkSettings();
  if (!settings || !settings.enabled || settings.mode !== 'peer') return;
  const payload = buildPushChainPayload(windowSize);
  if (!payload) return;
  const peers = Array.from(new Set(getPeerDirectoryTargets(settings).filter((peerUrl) => !isSelfPeerUrl(peerUrl))));
  for (const peerUrl of peers) {
    requestPeerJson(peerUrl, 'POST', '/api/v1/chain/push', payload, undefined, {
      trackReachability: false,
      suppressPeerDiscovery: true,
      source: 'chain-push',
    }).catch(() => {});
  }
}

function announceTipToPeers({ height, hash }) {
  const settings = getLedgerNetworkSettings();
  if (!settings || !settings.enabled || settings.mode !== 'peer') return;
  const payload = {
    height: Number(height) || 0,
    hash: String(hash || '').trim(),
    announcedAtMs: Date.now(),
  };
  const peers = Array.from(new Set(getPeerDirectoryTargets(settings).filter((peerUrl) => !isSelfPeerUrl(peerUrl))));
  for (const peerUrl of peers) {
    requestPeerJson(peerUrl, 'POST', '/api/v1/chain/tip', payload, undefined, {
      trackReachability: false,
      suppressPeerDiscovery: true,
      source: 'tip-announcement',
    }).catch(() => {});
  }
}

function startWtcPeerSyncLoop() {
  if (wtcPeerSyncTimer) return;
  setTimeout(async () => {
    await runWtcPeerSync('initial');
    await refreshWalletSyncState('peer-sync-initial', { force: true });
  }, 5_000);
  wtcPeerSyncTimer = setInterval(async () => {
    await runWtcPeerSync('periodic');
    await refreshWalletSyncState('peer-sync-periodic');
  }, WTC_PEER_SYNC_INTERVAL_MS);
}

function stopWtcPeerSyncLoop() {
  if (!wtcPeerSyncTimer) return;
  clearInterval(wtcPeerSyncTimer);
  wtcPeerSyncTimer = null;
}

function createWindow() {
  // ── Content Security Policy ───────────────────────────────────────────────
  // Set before the window is created so it applies from the very first navigation.
  // Restricts script, style, and connection sources to 'self' (the local app bundle).
  // In dev mode we also allow localhost:5173 for the Vite dev server.
  const devMode = process.env.NODE_ENV === 'development';
  const externalApiHosts = [].join(' ');
  const connectSrc = devMode
    ? `'self' http://localhost:5173 ws://localhost:5173 ${externalApiHosts}`
    : `'self' ${externalApiHosts}`;
  const cspValue = `default-src 'self'; script-src 'self'${devMode ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ${connectSrc}; object-src 'none'; base-uri 'none'; form-action 'none';`;
  require('electron').session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspValue],
      },
    });
  });

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'assets', 'icons', 'icon.ico'),
    title: `Wattcoin Miner v${getAppDisplayVersion()}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Must be false so setTimeout-driven GPU load loop keeps firing when the
      // window is minimized.  true (the Electron default) throttles all timers
      // in hidden pages, which drops GPU utilisation to 0%.
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  // Uncomment to debug: win.webContents.openDevTools();
  // Keep the versioned title even after the page's <title> tag loads.
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  // Block all new-window openings and external navigations.
  // The renderer is a local single-page app; it should never open popups or
  // navigate away from the local file:// bundle.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = devMode
      ? url.startsWith('http://localhost:5173') || url.startsWith('file://')
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      console.warn('[Security] Blocked renderer navigation to:', url);
    }
  });

  ipcMain.on('wattcoin-get-app-version', (event) => {
    event.returnValue = getAppDisplayVersion();
  });
  // Load the Vite dev server in development, or the built miner.html in production
  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173/miner.html');
  } else {
    win.loadFile(path.join(__dirname, 'dist', 'miner.html'));
  }
}

app.setAppPath(__dirname);

// ── Single-instance lock ───────────────────────────────────────────────────────
// Prevent a second instance from running alongside, which would let an attacker
// double contribution throughput under a different wallet address on the same machine.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another instance is already running — bring its window to front and quit this one.
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance — focus the existing window.
    const wins = require('electron').BrowserWindow.getAllWindows();
    const main = wins.find((w) => !w.isDestroyed());
    if (main) {
      if (main.isMinimized()) main.restore();
      main.focus();
    }
  });
}

app.whenReady().then(() => {
  // Query physical CPU core count so hardware-load workers are limited to physical
  // cores only.  On HT CPUs (2 logical per physical) spawning workers on all logical
  // cores doubles the duty-cycle pressure on each physical core, causing actual power
  // draw that is ~2× the intended %.  One worker per physical core makes N% duty = N% TDP.
  si.cpu()
    .then((cpu) => {
      try {
        const logical = Math.max(1, (os.cpus() || []).length || 1);
        let physical = Math.max(0, Number(cpu && cpu.physicalCores) || 0);
        // Some Windows/laptop environments occasionally report physicalCores=1
        // despite multiple logical cores. That under-provisions workers and can make
        // a 20% target look like ~0-1% total system load. Use HT-style fallback.
        if (logical >= 4 && physical === 1) {
          physical = Math.max(1, Math.floor(logical / 2));
        }
        if (physical <= 0) {
          physical = logical;
        }
        configurePhysicalCores(physical);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    })
    .catch(() => {}); // best-effort; controller falls back to logical core count

  // Load and decrypt attestation state now that safeStorage is available.
  // Re-save immediately to migrate any legacy plaintext secret to encrypted form.
  attestationState = loadAttestationState();
  saveAttestationState();
  loadRateLocks();
  loadConsumedProofs();
  loadHwAuthState();
  loadDiscoveredSeedPeerCache();
  // Restore rolling jitter mean from persistent benchmark history so the attestation
  // threshold is correct immediately after restart (before the first benchmark run).
  try {
    const _hist = loadBenchmarkHistory();
    if (_hist.jitterSamples.length >= 2) {
      hwAuthority.rollingJitterMean = _hist.jitterSamples.reduce((a, b) => a + b, 0) / _hist.jitterSamples.length;
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  // Generate unique per-machine RPC credentials on first launch.
  // The bundled config ships with defaults (user/pass); if we still see those,
  // create a local override file in the user-data dir with random credentials.
  // This file takes priority in getConfigCandidates() so it wins from this
  // launch onward — without touching the ASAR or the shipped config.
  (() => {
    try {
      const { getLocalOverrideConfigPath } = require('./runtime-config');
      const localPath = getLocalOverrideConfigPath();
      let localCfg = {};
      try {
        localCfg = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      const currentUser = String(localCfg.rpcUser || getRuntimeConfig().rpcUser || '');
      const currentPass = String(localCfg.rpcPassword || getRuntimeConfig().rpcPassword || '');
      const currentToken = String(localCfg.ledgerNetworkAuthToken || getRuntimeConfig().ledgerNetworkAuthToken || '');
      const DEFAULT_TOKEN = '218d99ff7cdd8c67f38a983e00e0850e5b0821b42ee57b0c';
      const runtime = getRuntimeConfig();
      const shouldUseSharedPeerToken = runtime.ledgerNetworkEnabled && runtime.ledgerNetworkMode === 'peer';
      let dirty = false;
      if (currentUser === 'user' || currentPass === 'pass' || !currentUser || !currentPass) {
        localCfg.rpcUser = 'wtc_' + crypto.randomBytes(8).toString('hex');
        localCfg.rpcPassword = crypto.randomBytes(24).toString('hex');
        dirty = true;
      }
      if (shouldUseSharedPeerToken) {
        if (currentToken !== DEFAULT_TOKEN) {
          localCfg.ledgerNetworkAuthToken = DEFAULT_TOKEN;
          dirty = true;
        }
      } else if (!currentToken || currentToken === DEFAULT_TOKEN) {
        localCfg.ledgerNetworkAuthToken = crypto.randomBytes(24).toString('hex');
        dirty = true;
      }
      const shippedPublicUrl = normalizePeerUrl(runtime.ledgerNetworkPublicUrl);
      const bundledPeerUrls = Array.from(
        new Set(
          [...(Array.isArray(runtime.ledgerPeers) ? runtime.ledgerPeers : []), ...loadBundledSeedPeers()]
            .map(normalizePeerUrl)
            .filter(Boolean),
        ),
      );
      if (
        !Object.prototype.hasOwnProperty.call(localCfg, 'ledgerNetworkPublicUrl') &&
        shippedPublicUrl &&
        bundledPeerUrls.includes(shippedPublicUrl)
      ) {
        localCfg.ledgerNetworkPublicUrl = '';
        dirty = true;
      }
      if (dirty) {
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(localPath, JSON.stringify(localCfg, null, 2), 'utf8');
        console.log(
          shouldUseSharedPeerToken
            ? '[startup] Normalized peer-network credentials.'
            : '[startup] Generated unique per-machine credentials.',
        );
      }
    } catch (e) {
      console.error('[startup] Failed to generate RPC credentials:', e);
    }
  })();

  // Generate (or load) the hardware-bound device identity on every launch so it
  // is always available before the first renderer IPC call arrives.
  try {
    loadOrCreateDeviceIdentity();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  try {
    persistDevPeerPrivacyRecoveryKey();
  } catch (e) {
    console.warn('[PeerPrivacy] Failed to write dev recovery key:', e && e.message ? e.message : e);
  }

  // Ensure the canonical genesis file is in userData before the node initialises.
  // The file is bundled as an extraResource so every user gets an identical genesis
  // block (same timestamp + team wallet).  Without it the fallback in _initGenesis()
  // premines to the user's own local address, giving each installer 1M WTC and a
  // divergent chain incompatible with every other peer.
  // Always overwrite from the bundled copy so upgrades from pre-1.0.124 installs
  // (which may have created a local-address genesis) get the canonical config.
  try {
    const genesisDestPath = path.join(getWalletDataDir(), 'wtc-genesis.json');
    const genesisSourcePath = [
      process.resourcesPath ? path.join(process.resourcesPath, 'wtc-genesis.json') : '',
      path.join(__dirname, 'resources', 'wtc-genesis.json'),
    ].find((candidate) => candidate && fs.existsSync(candidate));
    if (genesisSourcePath && fs.existsSync(genesisSourcePath)) {
      fs.mkdirSync(path.dirname(genesisDestPath), { recursive: true });
      fs.copyFileSync(genesisSourcePath, genesisDestPath);
      console.log('[WtcNode] Canonical wtc-genesis.json copied to userData.');
    } else {
      console.warn('[WtcNode] Bundled wtc-genesis.json not found -- genesis will fall back to local address.');
    }
  } catch (genesisErr) {
    console.warn('[WtcNode] Could not install wtc-genesis.json:', genesisErr && genesisErr.message);
  }

  // ── WTC native chain node ─────────────────────────────────────────────────
  try {
    const wtcSecret = (() => {
      try {
        const raw = JSON.parse(fs.readFileSync(getDeviceIdentityFilePath(), 'utf8'));
        return raw && raw.secret ? raw.secret : '';
      } catch (_) {
        return '';
      }
    })();
    wtcNode = createWtcNode({
      dataDir: getWalletDataDir(),
      signingSecret: wtcSecret || crypto.randomBytes(32).toString('hex'),
      peerIdentity: String(loadOrCreateDeviceIdentity().deviceId || '').trim(),
      walletKey: getOrCreateWalletEncryptionKey(),
      getActivePeers: () => getActivePeers(getLedgerNetworkSettings()),
      getConnectedPeerCount: () => getActiveReverseTunnelPeerConnectionCount(),
      getPeerTargets: () => getPeerDirectoryTargets(getLedgerNetworkSettings()),
      getTrustedPeerTargets: () => getTrustedPeerTargets(getLedgerNetworkSettings()),
      requestPeerJson,
      isSelfPeerUrl,
      onPeerTip: (peerUrl, tip) => handlePeerTipSignal(peerUrl, tip, 'tip-probe'),
      allowPartialQuorumCommit: !(getLedgerNetworkSettings().enabled && getLedgerNetworkSettings().mode === 'peer'),
      isLiveLocalTunnelPeer: getLocalTunnelPeerLiveness,
      getEnergyContributions: () => roundLedger.getCurrentRoundSnapshot().contributionsWh,
    });
    startGovernanceSync();
    refreshCoordinatorIdentityKey();
  } catch (e) {
    console.error('[WtcNode] Failed to initialize:', e && e.message ? e.message : e);
  }

  const runtime = getRuntimeConfig();
  startupTraceEnabled = runtime.enableStartupTraceLogging !== false;
  startupTraceWindowMs = Math.max(10_000, Number(runtime.startupTraceWindowMs) || 180_000);
  beginStartupTrace('app.ready');
  writeStartupTrace('app.ready', {
    autoLaunchNode: !!runtime.autoLaunchNode,
    autoLaunchNodeDelayMs: Math.max(0, Number(runtime.autoLaunchNodeDelayMs) || 0),
    startupTraceWindowMs,
  });

  // Verify bundled binary integrity before starting the node daemon.
  // If the manifest exists and any hash mismatches, show an error and refuse to start.
  const debugFrictionResult = verifyReleaseDebuggerFriction();
  if (!debugFrictionResult.ok) {
    dialog.showErrorBox(
      'Wattcoin Miner — Debugger Blocked',
      `Debugger launch flags were detected in this release build.\n\n${(debugFrictionResult.reasons || []).join('\n')}\n\nTo run with debugger for support, set WATTCOIN_ALLOW_DEBUGGER=1.`,
    );
    app.quit();
    return;
  }

  const appIntegrityResult = verifyAppIntegrityManifest();
  if (!appIntegrityResult.ok) {
    const failedList = (appIntegrityResult.failures || []).map((f) => `  • ${f.rel} (${f.reason})`).join('\n');
    dialog.showErrorBox(
      'Wattcoin Miner — Integrity Check Failed',
      `One or more application modules have been modified or are missing.\n\n${failedList}\n\nThe application cannot start safely. Please reinstall Wattcoin Miner.`,
    );
    app.quit();
    return;
  }

  const binaryIntegrityResult = verifyBinaryManifest();
  if (!binaryIntegrityResult.ok) {
    const failedList = (binaryIntegrityResult.failures || []).map((f) => `  \u2022 ${f.rel} (${f.reason})`).join('\n');
    dialog.showErrorBox(
      'Wattcoin Miner \u2014 Integrity Check Failed',
      `One or more bundled binaries have been modified or are missing.\n\n${failedList}\n\nThe application cannot start safely. Please reinstall Wattcoin Miner.`,
    );
    app.quit();
    return;
  }

  // Load signed remote profile policy feed (with local fallback) and keep it fresh.
  if (ENABLE_NODE_ATTESTATION) {
    ensurePolicyFeedRefreshLoop();
  }
  startLedgerReconcileLoop();
  startLedgerNetworkServer();
  startWtcPeerSyncLoop();
  startWalletSyncStateLoop();
  startOpsMetricsLoop();

  // ── WTC Sale queue ───────────────────────────────────────────────────────
  // Init only after wtcNode is ready so balance reads work immediately.
  if (wtcNode) {
    saleQueue.init(getDataDir(), wtcNode);

    // Configure sale API endpoint for order sync on all clients.
    // Optional key (WattcoinMinerUserData/sale-api-key.txt) enables write/update calls.
    // Without a key, clients still perform read-only order sync from GET /orders.
    try {
      let apiKey = '';
      const apiKeyFile = path.join(getDataDir(), 'sale-api-key.txt');
      if (fs.existsSync(apiKeyFile)) {
        apiKey = fs.readFileSync(apiKeyFile, 'utf8');
        // Strip UTF-8 BOM if present (e.g., from PowerShell Set-Content -Encoding UTF8)
        if (apiKey.charCodeAt(0) === 0xfeff) apiKey = apiKey.slice(1);
        apiKey = apiKey.trim();
      }

      saleQueue.setServerApi('https://wattcoin.ee/api', apiKey || null);
      if (apiKey) {
        console.log('[SaleQueue] Server API configured with key (key length:', apiKey.length, ')');
      } else if (fs.existsSync(apiKeyFile)) {
        console.warn('[SaleQueue] sale-api-key.txt exists but is empty - running read-only order sync');
      } else {
        console.log('[SaleQueue] No sale-api-key.txt found - running read-only order sync');
      }
    } catch (e) {
      console.warn('[SaleQueue] Failed to load sale-api-key.txt:', e && e.message);
    }

    // ── WTC Staking queue ─────────────────────────────────────────────────
    stakingQueue.init(getDataDir(), wtcNode);
    // Share the same API key so staking processes website entries in the same flush
    // and pushes combined stats (APY, totalStaked) back to the website.
    try {
      let stakingApiKey = '';
      const stakingKeyFile = path.join(getDataDir(), 'sale-api-key.txt');
      if (fs.existsSync(stakingKeyFile)) {
        stakingApiKey = fs.readFileSync(stakingKeyFile, 'utf8');
        if (stakingApiKey.charCodeAt(0) === 0xfeff) stakingApiKey = stakingApiKey.slice(1);
        stakingApiKey = stakingApiKey.trim();
      }
      if (stakingApiKey) {
        stakingQueue.setWebApi('https://wattcoin.ee/api', stakingApiKey);
      }
    } catch (e) {
      console.warn('[StakingQueue] Failed to configure web API:', e && e.message);
    }
  }

  createWindow(); // Open window immediately; UI handles "node connecting" state
});

app.on('window-all-closed', () => {
  if (updateInstallInProgress) {
    if (process.platform !== 'darwin') app.quit();
    return;
  }

  // Stop the node before quitting
  stopLedgerReconcileLoop();
  stopWtcPeerSyncLoop();
  stopWalletSyncStateLoop();
  stopOpsMetricsLoop();
  stopLedgerNetworkServer();
  if (remoteProfileFeedRefreshTimer) {
    clearInterval(remoteProfileFeedRefreshTimer);
    remoteProfileFeedRefreshTimer = null;
  }
  try {
    stopHardwareLoad();
  } catch (e) {
    console.error('Failed to stop hardware load controller:', e);
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Auto-updater ──────────────────────────────────────────────────────────────
// Only runs in a packaged app (app.isPackaged). In dev mode autoUpdater is a
// no-op so it never interferes with the development workflow.
// Flow: check automatically on startup â†’ download silently in background â†’
// notify renderer via 'wattcoin-update-downloaded' â†’ user clicks Restart â†’
// renderer calls 'wattcoin-install-update' â†’ quitAndInstall.
// ─────────────────────────────────────────────────────────────────────────────
function normalizeUpdateFeedUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.replace(/\/+$/, '');
}

function readConfiguredUpdateFeedUrl() {
  try {
    const appUpdatePath = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(appUpdatePath)) return '';
    const raw = fs.readFileSync(appUpdatePath, 'utf8');
    const m = raw.match(/^url:\s*(.+)$/m);
    return normalizeUpdateFeedUrl(m ? m[1] : '');
  } catch (_) {
    return '';
  }
}

function buildUpdateFeedOrder() {
  const configured = readConfiguredUpdateFeedUrl();
  const defaults = ['https://wattcoin.ee/releases', 'https://wattcoin.ee'];

  const ordered = [];
  const seen = new Set();
  [configured, ...defaults].forEach((u) => {
    const n = normalizeUpdateFeedUrl(u);
    if (!n || seen.has(n)) return;
    seen.add(n);
    ordered.push(n);
  });
  return ordered;
}

if (app.isPackaged) {
  const updateFeeds = buildUpdateFeedOrder();
  let activeUpdateFeed = updateFeeds[0] || 'https://wattcoin.ee/releases';

  const setUpdateFeed = (url) => {
    const normalized = normalizeUpdateFeedUrl(url);
    if (!normalized) return false;
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: normalized });
      activeUpdateFeed = normalized;
      console.log('[auto-update] feed set:', normalized);
      return true;
    } catch (e) {
      console.warn('[auto-update] failed to set feed:', normalized, e && e.message ? e.message : e);
      return false;
    }
  };

  const checkForUpdatesWithFallback = async () => {
    const feeds = updateFeeds.length > 0 ? updateFeeds : [activeUpdateFeed];
    const startIndex = Math.max(0, feeds.indexOf(activeUpdateFeed));
    let lastError = null;

    for (let offset = 0; offset < feeds.length; offset += 1) {
      const idx = (startIndex + offset) % feeds.length;
      const feed = feeds[idx];
      if (!setUpdateFeed(feed)) continue;
      try {
        return await autoUpdater.checkForUpdates();
      } catch (e) {
        lastError = e;
        console.warn('[auto-update] check failed on feed:', feed, e && e.message ? e.message : e);
      }
    }

    if (lastError) {
      throw lastError;
    }
    return null;
  };

  // Set preferred feed at startup so downloaded update metadata and logs are clear.
  setUpdateFeed(activeUpdateFeed);

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Dev builds use a self-signed cert ("Wattcoin Dev Root CA") which is not in
  // Windows' Trusted Root store, so Get-AuthenticodeSignature returns NotTrusted
  // and rejects the update.  Set WATTCOIN_WINDOWS_SIGNING_ON_HOLD=1 in dev to
  // skip publisher-name verification.  In production the installer is signed with
  // a trusted cert, so autoUpdater's built-in verification runs normally.
  if (process.env.WATTCOIN_WINDOWS_SIGNING_ON_HOLD === '1') {
    autoUpdater._verifyUpdateCodeSignature = () => Promise.resolve(null);
  }

  autoUpdater.on('before-quit-for-update', () => {
    updateInstallInProgress = true;
  });

  autoUpdater.on('update-downloaded', (info) => {
    const wins = BrowserWindow.getAllWindows();
    wins.forEach((w) => {
      try {
        w.webContents.send('wattcoin-update-downloaded', { version: info.version });
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[auto-update] error:', err && err.message ? err.message : err);
  });

  ipcMain.handle('wattcoin-check-for-update', async () => {
    try {
      return await checkForUpdatesWithFallback();
    } catch (_) {
      return null;
    }
  });

  ipcMain.handle('wattcoin-install-update', () => {
    updateInstallInProgress = true;

    const wins = BrowserWindow.getAllWindows();
    wins.forEach((win) => {
      try {
        win.removeAllListeners('close');
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      try {
        win.close();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    });

    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (err) {
        updateInstallInProgress = false;
        console.warn('[auto-update] install failed:', err && err.message ? err.message : err);
      }
    });

    return { ok: true };
  });

  // Check ~30 s after ready so the node has time to start,
  // then re-check every 4 h so long-running miners don't miss updates.
  app.whenReady().then(() => {
    setTimeout(() => {
      checkForUpdatesWithFallback().catch(() => undefined);
      setInterval(() => checkForUpdatesWithFallback().catch(() => undefined), 4 * 60 * 60_000);
    }, 30_000);
  });

  // Clean up native GPU process on exit
  process.on('exit', () => {
    try {
      shutdownGpu();
    } catch (_) {
      return undefined;
    }
  });
  app.on('before-quit', () => {
    try {
      shutdownGpu();
    } catch (_) {
      return undefined;
    }
  });
}

// ─── Global average electricity price (USD/kWh) ──────────────────────────────
// Fetches from GlobalPetrolPrices.com. Cached for 24 h. Falls back to the
// widely-cited 2024 global average of $0.165/kWh if the fetch or parse fails.
const ELECTRICITY_PRICE_FALLBACK = 0.174; // USD/kWh — Q1 2026 world average
const ELECTRICITY_PRICE_CACHE_MS = 24 * 60 * 60 * 1000; // 24 h
let _electricityCache = { price: null, fetchedAt: 0 };

ipcMain.handle('wattcoin-get-electricity-price', () => {
  if (_electricityCache.price !== null && Date.now() - _electricityCache.fetchedAt < ELECTRICITY_PRICE_CACHE_MS) {
    saleQueue.setElectricityPrice(_electricityCache.price);
    return Promise.resolve({ ok: true, price: _electricityCache.price, source: 'cache' });
  }

  return new Promise((resolve) => {
    const fallback = (source) => {
      const price = _electricityCache.price || ELECTRICITY_PRICE_FALLBACK;
      saleQueue.setElectricityPrice(price);
      resolve({ ok: true, price, source });
    };

    try {
      const req = https.get(
        'https://www.globalpetrolprices.com/electricity_prices/',
        {
          timeout: 12_000,
          headers: {
            Accept: 'text/html,application/xhtml+xml,*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        },
        (res) => {
          const chunks = [];
          let total = 0;
          res.on('data', (chunk) => {
            total += chunk.length;
            if (total > 3 * 1024 * 1024) {
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              const html = Buffer.concat(chunks).toString('utf8');
              // GlobalPetrolPrices embeds a JS data array.  The world-average row
              // typically looks like: ["World","…","0.165",…]
              // Try several patterns in order of reliability.
              const patterns = [
                // prose text in article body
                /electricity price in the world is USD ([0-9]+\.[0-9]+)/i,
                // JS data array formats
                /"World"\s*,\s*"[^"]*"\s*,\s*"([0-9]+\.[0-9]+)"/i,
                /'World'\s*,\s*([0-9]+\.[0-9]+)/i,
                /"World"\s*,\s*([0-9]+\.[0-9]+)/i,
                /arrData\.push\(\["World"[^\]]*?,(\d+\.\d+)/,
                // HTML table cell
                /World[^<]{0,120}<\/td>\s*<td[^>]*>\s*([0-9]+\.[0-9]+)/i,
              ];
              for (const re of patterns) {
                const m = html.match(re);
                if (m) {
                  const p = parseFloat(m[1]);
                  if (p > 0.01 && p < 5) {
                    _electricityCache = { price: p, fetchedAt: Date.now() };
                    saleQueue.setElectricityPrice(p);
                    return resolve({ ok: true, price: p, source: 'live' });
                  }
                }
              }
              fallback('fallback-parse');
            } catch (_) {
              fallback('fallback-error');
            }
          });
        },
      );
      req.on('error', () => fallback('fallback-network'));
      req.on('timeout', () => {
        req.destroy();
        fallback('fallback-timeout');
      });
    } catch (_) {
      fallback('fallback-exception');
    }
  });
});
