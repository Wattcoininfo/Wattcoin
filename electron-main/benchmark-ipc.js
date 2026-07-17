'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');

const asicDrivers = require('../asic-drivers');
const {
  getBenchmarkCapabilities,
  runBackendBenchmark,
  setProbeHardwareSpec,
  getPendingProbe,
  submitProbeResult,
  getProbeHistory,
  getAttestHistory,
  clearProbeHistory,
  setAsicHardwareSpec,
} = require('./backend-benchmark');
const { getExpectedCpuSpeedOps, getAsicPowerW, getAsicHashrateTHs, getGpuTdpW } = require('./hardware-tables.cjs');
const { ensureGpu, getGpuInfo } = require('./gpu-load-controller');
const { getHardwareLoadState, setHardwareLoadPercent } = require('./hardware-load-controller');
const {
  normalizeGpuFingerprintValue,
  formatHardwareChangeList,
  appendBenchmarkSample,
  getPersonalReference,
  isPowerCpuOutlier,
  hardwareModelsMatch,
  getHostLanIp,
  getDataDir,
} = require('./main-utils');
const { getProbeLogFilePath } = require('./electron-utils');
const { startStratumServer, waitForFreshShares, injectCustomJob } = require('./local-stratum');
const {
  vdfEvaluate,
  vdfVerify,
  deriveVdfInput,
  DEFAULT_VDF_DIFFICULTY,
  DEFAULT_VDF_DISCRIMINANT_BITS,
} = require('./vdf');

// -- Internal state ---------------------------------------------------------
let _asicConfig = [];
let _stratumHandles = new Map();
let _declaredAsicModel = '';
const _asicLivenessState = new Map();
let _asicLivenessInterval = null;
const ASIC_LIVENESS_CHECK_MS = 30000;
const ASIC_IDLE_THRESHOLD = 1; // 1 missed check (30 s) → mark inactive
const FINGERPRINT_FILE_NAME = 'fingerprint.json';

function getWalletDataDir() {
  return getDataDir();
}

function registerBenchmarkIpcHandlers(deps) {
  const {
    ipcMain,
    walletAddressCache,
    hwAuthority,
    activeAttestationChallenges,
    resolveOsHardwareIdentity,
    loadHwFingerprint,
    saveHwFingerprint,
    clearBenchmarkHistory,
    loadBenchmarkHistory,
    saveBenchmarkHistory,
    verifyAsicLiveness,
    verifyAsicFirmware,
    recordMinerStats,
    networkMiningStats,
    saveHwAuthState,
    _closeBgProbeWs,
    _connectBgProbeWs,
    computeHwAuthSig,
    stopStratumServer,
  } = deps;

  ipcMain.handle('wattcoin-get-benchmark-capabilities', () => {
    return getBenchmarkCapabilities();
  });

  ipcMain.handle('wattcoin-run-backend-benchmark', async (_event, request) => {
    if (!walletAddressCache.address) {
      try {
        if (deps.wtcNode()) {
          const address = deps.wtcNode().getPrimaryAddress();
          if (address) {
            walletAddressCache.address = address;
            walletAddressCache.at = Date.now();
          }
        }
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    }
    const benchRequest = { ...(request || {}), walletAddress: walletAddressCache.address || '' };
    try {
      const _hwState = getHardwareLoadState();
      const _cpuWorkers = _hwState.cpuWorkers || 0;
      const _ramping = _hwState.rampingUp ? 'ramping' : 'settled';
      const _targetPct = _hwState.targetPercent ?? -1;
      const _currPct = _hwState.currentPercent ?? -1;
      const _duty = typeof _hwState.avgCpuWorkerDuty === 'number' ? (_hwState.avgCpuWorkerDuty * 100).toFixed(1) : '?';
      const _bgOps = typeof _hwState.cpuLoadOpsPerSec === 'number' ? Math.round(_hwState.cpuLoadOpsPerSec / 1e6) : '?';
    } catch (_) {
      /* hw state snapshot best-effort */
    }
    const _hwBeforeBench = getHardwareLoadState();
    const _prevPct = _hwBeforeBench.currentPercent || 0;
    const _gpuCount = Math.max(0, Number(request && request.declaredGpuCount) || 0);
    if (_gpuCount > 0) {
      ensureGpu(_gpuCount).catch(() => {});
    }
    // Stop CPU load workers before the benchmark so the SHA-256
    // measurement runs on a clean main thread without competing for cores.
    // The load is restarted at the previous level afterwards.
    if (_prevPct > 0) setHardwareLoadPercent(0);
    let result = await runBackendBenchmark(benchRequest);
    if (_prevPct > 0) setHardwareLoadPercent(_prevPct);
    if (result && result.ok) {
      setProbeHardwareSpec({
        measuredCpuOpsPerSec: result.cpuSpeedOpsPerSec || 0,
        allowGpuWorkloads: !!(request && request.allowGpuWorkloads),
      });

      const _minerAddr = walletAddressCache.address || '';
      if (_minerAddr) {
        for (const _ch of activeAttestationChallenges.values()) {
          if (_ch.minerId === _minerAddr || _ch.identityAddress === _minerAddr) {
            _ch.measuredCpuOpsPerSec = result.cpuSpeedOpsPerSec || 0;
          }
        }
      }

      const declaredCpuModel = String((request && request.declaredCpuModel) || '');
      const osCpuModel = ((os.cpus()[0] && os.cpus()[0].model) || '').trim();
      const cpuModelMismatch = osCpuModel && declaredCpuModel && !hardwareModelsMatch(osCpuModel, declaredCpuModel);
      const cpuModel = osCpuModel || declaredCpuModel;
      if (cpuModelMismatch) {
        const safeDeclaredCpu = String(declaredCpuModel || '')
          .normalize('NFKC')
          .replace(/\s+/g, ' ')
          .trim();
        console.warn(
          `[HW-Verify] CPU model mismatch: renderer="${safeDeclaredCpu}", OS="${osCpuModel}" - using OS model`,
        );
      }

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

      const declaredDeviceType = String((request && request.declaredDeviceType) || '');
      const deviceTypeMismatch =
        declaredDeviceType &&
        hwIdentity.deviceType &&
        declaredDeviceType.toLowerCase() !== hwIdentity.deviceType.toLowerCase() &&
        /^pc$/i.test(declaredDeviceType) &&
        /laptop/i.test(hwIdentity.deviceType);
      if (deviceTypeMismatch) {
        console.warn(
          `[HW-Verify] Device type mismatch: renderer="${declaredDeviceType}", OS="${hwIdentity.deviceType}"`,
        );
      }

      let anyHwMismatch = false;
      let benchmarkConsistencySignal = false;
      let mismatchSignalCount = 0;

      const isBaseline = !!(request && request.isBaselineBenchmark);
      const measuredCpu = result.cpuSpeedOpsPerSec || 0;
      const expectedCpu = getExpectedCpuSpeedOps(cpuModel);
      const expectedDeclaredCpu = getExpectedCpuSpeedOps(declaredCpuModel);

      const currentWallet = walletAddressCache.address || '';
      const hwDescriptor = {
        cpuModel,
        gpuModels: normalizeGpuFingerprintValue(hwIdentity.gpuModels),
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
          console.log('[hwFingerprint] Hardware change with new wallet - fingerprint updated, history cleared.');
          saveHwFingerprint({ ...hwDescriptor, walletAddress: currentWallet });
          clearBenchmarkHistory();
        } else if (storedFp.walletAddress && storedFp.walletAddress !== currentWallet) {
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

      const benchmarkHistory = loadBenchmarkHistory();
      if (isBaseline) {
        if (measuredCpu > 0)
          benchmarkHistory.cpuSamples = appendBenchmarkSample(benchmarkHistory.cpuSamples, measuredCpu);
      }
      if (!isBaseline) {
        if (measuredCpu > 0)
          benchmarkHistory.cpuSamples = appendBenchmarkSample(benchmarkHistory.cpuSamples, measuredCpu);
      }
      const measuredJitter = Math.min(1.0, Math.max(0, Number(result.jitterRatio) || 0));
      if (measuredJitter > 0) {
        benchmarkHistory.jitterSamples = appendBenchmarkSample(benchmarkHistory.jitterSamples, measuredJitter);
      }
      if (benchmarkHistory.jitterSamples.length >= 2) {
        hwAuthority.rollingJitterMean =
          benchmarkHistory.jitterSamples.reduce((a, b) => a + b, 0) / benchmarkHistory.jitterSamples.length;
      }

      const personalCpuMean =
        benchmarkHistory.cpuSamples.length >= 4
          ? benchmarkHistory.cpuSamples.reduce((a, b) => a + b, 0) / benchmarkHistory.cpuSamples.length
          : 0;
      const referenceCpu = Math.max(getPersonalReference(benchmarkHistory.cpuSamples, expectedCpu), personalCpuMean);

      let cpuDeclaredInconsistent = false;
      if (expectedDeclaredCpu > 0 && measuredCpu > 0) {
        const declaredCpuRatio = measuredCpu / expectedDeclaredCpu;
        cpuDeclaredInconsistent = declaredCpuRatio < 0.6 || declaredCpuRatio > 1.7;
      }
      benchmarkConsistencySignal = cpuDeclaredInconsistent;

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
        hwAuthority.benchmarkOpsCalibration = Math.min(hwAuthority.benchmarkOpsCalibration, 0.8);
      }
      if (result.sha256OpsPerMs > 0) {
        const prev = Number(hwAuthority.sha256OpsPerMs) || 0;
        if (prev <= 0) {
          hwAuthority.sha256OpsPerMs = Math.round(result.sha256OpsPerMs);
          console.log(
            `[Benchmark] SHA-256 initial: ${Math.round(result.sha256OpsPerMs)} ops/ms (${result.sha256TotalOps} ops in ${result.sha256ElapsedMs}ms)`,
          );
        } else {
          console.log(
            `[Benchmark] SHA-256 bench=${Math.round(result.sha256OpsPerMs)} ops/ms (keeping calibrated=${prev} ops/ms)`,
          );
        }
      }

      saveBenchmarkHistory(benchmarkHistory);

      const _declaredDeviceTypeForCap = String((request && request.declaredDeviceType) || '').toLowerCase();
      const _isAsicDevice = /asic/i.test(_declaredDeviceTypeForCap);
      const MAX_DECLARED_UNIT_POWER_W = _isAsicDevice ? 5000 : 600;
      let declaredUnitPowerW = Math.min(
        MAX_DECLARED_UNIT_POWER_W,
        Math.max(0, Number((request && request.declaredUnitPowerW) || 0)),
      );

      if (anyHwMismatch && !isBaseline) {
        const penaltyBefore = hwAuthority.trustScore;
        hwAuthority.trustScore = Math.max(0, hwAuthority.trustScore - 20);
        console.warn(
          `[HW-Verify] Hardware mismatch penalty: trust ${penaltyBefore} -> ${hwAuthority.trustScore}` +
            `${cpuModelMismatch ? ' [CPU]' : ''}${gpuModelMismatch ? ' [GPU]' : ''}${deviceTypeMismatch ? ' [DeviceType]' : ''}`,
        );
        if (deviceTypeMismatch && /laptop/i.test(hwIdentity.deviceType)) {
          if (declaredUnitPowerW > 35) {
            console.warn(
              `[HW-Verify] Laptop TDP clamp: declared=${declaredUnitPowerW}W -> capped to 35W (device is laptop)`,
            );
            declaredUnitPowerW = 35;
          }
        }
        if (_isAsicDevice) {
          const declaredGpuModel = String((request && request.declaredGpuModel) || '');
          if (declaredGpuModel) {
            const tablePower = getAsicPowerW(declaredGpuModel);
            if (tablePower > 0 && declaredUnitPowerW !== tablePower) {
              console.warn(
                `[HW-Verify] ASIC TDP table: declared=${declaredUnitPowerW}W, table=${tablePower}W -> set to ${tablePower}W`,
              );
              declaredUnitPowerW = tablePower;
            }
          }
        }
        saveHwAuthState();
      }

      if (_isAsicDevice) {
        _declaredAsicModel = String((request && request.declaredGpuModel) || '');
        if (!_declaredAsicModel) {
          console.warn(`[HW-Verify] ASIC declared but no model specified - rejecting`);
          return {
            ok: false,
            unknownAsic: true,
            message:
              'ASIC declared but no model name provided. Please specify the ASIC miner model (e.g. Antminer S21).',
          };
        }
        const tablePower = getAsicPowerW(_declaredAsicModel);
        if (tablePower === 0) {
          console.warn(`[HW-Verify] Unknown ASIC model "${_declaredAsicModel}" - no power data available, rejecting`);
          return {
            ok: false,
            unknownAsic: true,
            asicModel: _declaredAsicModel,
            message: `Unknown ASIC model "${_declaredAsicModel}". This miner is not recognised by the Wattcoin hardware database. Mining is blocked until the model is added. Please contact support.`,
          };
        }
      }

      if (hwIdentity.isVM) {
        console.warn(`[HW-Verify] VM detected (${hwIdentity.vmType}) -- mining blocked.`);
        return {
          ok: false,
          vmDetected: true,
          vmType: hwIdentity.vmType,
          message: 'Mining is not supported in virtual machines. Please run Wattcoin on bare-metal hardware.',
        };
      }

      let powerVsCpuOverride = false;
      if (_isAsicDevice && measuredCpu > 150_000_000) {
        const previousCap = declaredUnitPowerW;
        const realDesktopPowerW = Math.round(measuredCpu / 2_000_000);
        declaredUnitPowerW = Math.min(Math.max(realDesktopPowerW, 65), 600);
        powerVsCpuOverride = true;
        console.warn(
          `[HW-Verify] Power/CPU override: declared ASIC with CPU=${(measuredCpu / 1e6).toFixed(0)}M ops/sec ` +
            `> 150M - reclassified as non-ASIC, actual desktop power estimated as ${declaredUnitPowerW}W from ${previousCap}W declared`,
        );
      }

      let asicLivenessFailed = false;
      let asicModelMismatch = false;
      let asicHashrateLow = false;
      let asicFirmwareIssue = false;
      if (_isAsicDevice) {
        const livenessResult = await verifyAsicLiveness(_declaredAsicModel);
        if (!livenessResult.ok) {
          asicLivenessFailed = true;
          console.warn(
            `[HW-Verify] ASIC liveness check failed for ${_declaredAsicModel || 'unknown'}` +
              ` - no cgminer API response on ports 4028-4030`,
          );
        } else if (livenessResult.elapsedMs > 500) {
          asicLivenessFailed = true;
          console.warn(
            `[HW-Verify] ASIC liveness check too slow: ${livenessResult.elapsedMs}ms for ` +
              `${livenessResult.bytesTotal} bytes (threshold 500ms)`,
          );
        } else {
          console.log(`[HW-Verify] ASIC liveness OK: ${livenessResult.elapsedMs}ms on port ${livenessResult.port}`);
          if (livenessResult.shareDelta !== null) {
            if (livenessResult.shareDelta > 0) {
              console.log(
                `[HW-Verify] ASIC share validation PASSED: ${livenessResult.shareDelta} valid ` +
                  `X11 shares during check (${(livenessResult.shareRatePerSec || 0).toFixed(1)}/sec)`,
              );
            } else {
              console.warn(
                `[HW-Verify] ASIC share validation WARNING: 0 valid X11 shares during check. ` +
                  `ASIC may not be connected to local stratum server.`,
              );
            }
          }
          const reportedModel = (livenessResult.asicType || '').trim();
          if (reportedModel && _declaredAsicModel && !hardwareModelsMatch(reportedModel, _declaredAsicModel)) {
            asicModelMismatch = true;
            const tableTdp = getAsicPowerW(reportedModel);
            if (tableTdp > 0 && declaredUnitPowerW > tableTdp) {
              console.warn(
                `[HW-Verify] ASIC model mismatch: declared="${_declaredAsicModel}", ` +
                  `API reports="${reportedModel}" - clamping TDP from ${declaredUnitPowerW}W to ${tableTdp}W`,
              );
              declaredUnitPowerW = tableTdp;
            } else {
              const penalty = Math.round(declaredUnitPowerW * 0.8);
              console.warn(
                `[HW-Verify] ASIC model mismatch: declared="${_declaredAsicModel}", ` +
                  `API reports="${reportedModel}" - no TDP data, applying 20% penalty: ${declaredUnitPowerW}W - ${penalty}W`,
              );
              declaredUnitPowerW = penalty;
            }
          }
          let measuredHashrateTHs = 0;
          const _expectedHashrateTHs = getAsicHashrateTHs(_declaredAsicModel);
          const livenessIp = livenessResult.ip || '127.0.0.1';
          const livenessPort = livenessResult.port;
          if (_expectedHashrateTHs > 0) {
            try {
              const hashDriver = asicDrivers.getDriver(livenessResult.driverName);
              if (hashDriver) {
                measuredHashrateTHs = await hashDriver.getHashrate(
                  livenessIp,
                  livenessPort,
                  livenessResult.driverConfig,
                );
              }
            } catch (_e) {
              /* asic hashrate measurement best-effort */
            }
          }
          const ASIC_MIN_HASHRATE_RATIO = 0.85;
          if (measuredHashrateTHs > 0 && measuredHashrateTHs < _expectedHashrateTHs * ASIC_MIN_HASHRATE_RATIO) {
            asicHashrateLow = true;
            console.warn(
              `[HW-Verify] ASIC hashrate too low: ${measuredHashrateTHs.toFixed(1)} TH/s measured, ` +
                `expected >= ${(_expectedHashrateTHs * ASIC_MIN_HASHRATE_RATIO).toFixed(1)} TH/s ` +
                `for "${_declaredAsicModel}" - hash boards may be underperforming or misidentified`,
            );
          } else if (measuredHashrateTHs > 0) {
            console.log(
              `[HW-Verify] ASIC hashrate OK: ${measuredHashrateTHs.toFixed(1)} TH/s ` +
                `(expected ${_expectedHashrateTHs} TH/s for "${_declaredAsicModel}")`,
            );
          }
          setAsicHardwareSpec({
            asicHashrateTHs: _expectedHashrateTHs || measuredHashrateTHs || 0,
            asicModel: _declaredAsicModel || livenessResult.asicType || 'unknown',
          });
          const firmwareAttest = await verifyAsicFirmware(
            livenessIp,
            livenessPort,
            livenessResult.asicType,
            _declaredAsicModel,
            livenessResult.driverName,
            livenessResult.driverConfig,
          );
          if (!firmwareAttest.ok) {
            asicFirmwareIssue = true;
            console.warn(`[HW-Verify] ASIC firmware attestation failed: ${firmwareAttest.issues.join(', ')}`);
          }
          if (livenessResult.telemetry) {
            const t = livenessResult.telemetry;
            if (t.signalRatio < 0.6) {
              asicFirmwareIssue = true;
              console.warn(
                `[HW-Verify] ASIC telemetry signal score low: ${t.signalScore}/${t.maxSignals}` +
                  ` (ratio ${t.signalRatio.toFixed(2)}) < 0.6 threshold - ` +
                  `temperatures, fans, chips, or voltage values are not consistent with real ASIC hardware`,
              );
            } else {
              console.log(
                `[HW-Verify] ASIC telemetry OK: ${t.signalScore}/${t.maxSignals}` +
                  ` (ratio ${t.signalRatio.toFixed(2)}), ` +
                  `temps ${t.tempInlet}->${t.tempOutlet}->${t.tempChip} C, ` +
                  `fan ${t.fanSpeedRpm} RPM, ` +
                  `chips ${t.chipCount}, chains ${t.chainNum}, voltage ${t.voltage}V`,
              );
            }
          }
          if (!asicLivenessFailed) {
            try {
              const tCtrl = new AbortController();
              const tTo = setTimeout(() => tCtrl.abort(), 10000);
              let tRes;
              try {
                tRes = await fetch(`http://${livenessIp}:${livenessPort}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ command: 'stats' }),
                  signal: tCtrl.signal,
                });
              } finally {
                clearTimeout(tTo);
              }
              const tJson = await tRes.json();
              const tRecords = tJson && tJson.STATS;
              const allTemps = [];
              if (Array.isArray(tRecords)) {
                for (const rec of tRecords) {
                  if (!rec || rec.id === 0) continue;
                  for (const key of Object.keys(rec)) {
                    if (/^temp\d*$/i.test(key)) {
                      const val = Number(rec[key]);
                      if (Number.isFinite(val) && val > 0) allTemps.push(val);
                    }
                  }
                }
              }
              if (allTemps.length > 0) {
                const avgTemp = allTemps.reduce((a, b) => a + b, 0) / allTemps.length;
                const minTemp = Math.min(...allTemps);
                const maxTemp = Math.max(...allTemps);
                if (avgTemp < 30 || avgTemp > 95) {
                  asicFirmwareIssue = true;
                  console.warn(
                    `[HW-Verify] ASIC temperature range suspicious: avg=${avgTemp.toFixed(0)}-C (range ${minTemp.toFixed(0)}-${maxTemp.toFixed(0)}-C) - expected 30-95-C`,
                  );
                }
                if (allTemps.length >= 3) {
                  const uniqueTemps = new Set(allTemps.map((t) => Math.round(t)));
                  if (uniqueTemps.size <= 1) {
                    asicFirmwareIssue = true;
                    console.warn(
                      `[HW-Verify] ASIC temperature consistency suspicious: all ${allTemps.length} sensors report ~${Math.round(allTemps[0])}-C - expected variation across chips`,
                    );
                  }
                }
              } else {
                console.warn(`[HW-Verify] ASIC temperature data not available - may indicate fake cgminer responder`);
              }
            } catch (_e) {
              console.warn(`[HW-Verify] ASIC temperature check failed: ${String(_e.message || _e).slice(0, 80)}`);
            }
          }
        }
      }

      if (declaredUnitPowerW > 0) {
        const _allowGpuCalib = !!(request && request.allowGpuWorkloads);
        hwAuthority.nativeGpuTdpW = 0;
        if (_allowGpuCalib) {
          try {
            const gpuNativeInfo = getGpuInfo();
            if (gpuNativeInfo && gpuNativeInfo.adapter) {
              const nativeTdp = getGpuTdpW(gpuNativeInfo.adapter);
              const gpuCount = Math.max(1, Number(gpuNativeInfo.gpuCount) || 1);
              if (nativeTdp > 0) {
                if (hwIdentity.gpuModels.length > 0) {
                  const binaryMatchesOs = hwIdentity.gpuModels.some((osGpu) =>
                    hardwareModelsMatch(osGpu, gpuNativeInfo.adapter),
                  );
                  if (!binaryMatchesOs) {
                    console.warn(
                      `[HW-Verify] Native binary adapter "${gpuNativeInfo.adapter}" does not match ` +
                        `any OS-detected GPU [${hwIdentity.gpuModels.join(', ')}] - GPU mining blocked`,
                    );
                    hwAuthority.nativeGpuTdpW = 0;
                  } else {
                    hwAuthority.nativeGpuTdpW = nativeTdp * gpuCount;
                  }
                } else {
                  console.warn(
                    `[HW-Verify] OS GPU detection returned no models - binary adapter "${gpuNativeInfo.adapter}" ` +
                      `cannot be cross-checked, GPU TDP set to 0 (CPU fallback)`,
                  );
                  hwAuthority.nativeGpuTdpW = 0;
                }
                console.log(
                  `[HW-Verify] Native GPU TDP: ${nativeTdp}W x ${gpuCount} GPU(s) = ${hwAuthority.nativeGpuTdpW}W` +
                    ` (${gpuNativeInfo.adapter}) declared total=${declaredUnitPowerW}W`,
                );
                const plausibleMax = hwAuthority.nativeGpuTdpW + 300;
                if (declaredUnitPowerW > plausibleMax) {
                  console.warn(
                    `[HW-Verify] Declared power ${declaredUnitPowerW}W exceeds plausible ` +
                      `max ${plausibleMax}W (${gpuCount} GPU(s) x ${nativeTdp}W + 300W CPU/mem) - capping`,
                  );
                  declaredUnitPowerW = plausibleMax;
                }
              }
            }
          } catch (_) {
            /* best-effort power capping */
          }
        }
        if (_allowGpuCalib && hwAuthority.nativeGpuTdpW === 0 && measuredCpu > 0) {
          const cpuBasedPower = Math.round(measuredCpu / 2_000_000);
          const plausibleMax = Math.min(Math.max(cpuBasedPower, 65), 300);
          if (declaredUnitPowerW > plausibleMax) {
            console.warn(
              `[HW-Verify] Native GPU info unavailable - capping declared ` +
                `${declaredUnitPowerW}W to CPU-based estimate ${plausibleMax}W (measuredCpu=${(measuredCpu / 1e6).toFixed(0)}M ops/s)`,
            );
            declaredUnitPowerW = plausibleMax;
          }
        }
        let totalActiveAsicPowerW = 0;
        let totalAsicPowerW = 0;
        if (_asicConfig.length > 0 && _declaredAsicModel) {
          const perAsicPower = getAsicPowerW(_declaredAsicModel);
          for (const entry of _asicConfig) {
            if (perAsicPower <= 0) continue;
            const handle = _stratumHandles.get(entry.stratumPort);
            const shares = handle ? handle.getShareCount() : 0;
            totalAsicPowerW += perAsicPower;
            if (shares > 0) totalActiveAsicPowerW += perAsicPower;
          }
          const asicPowerToRemove = totalAsicPowerW - totalActiveAsicPowerW;
          if (asicPowerToRemove > 0) {
            const before = declaredUnitPowerW;
            declaredUnitPowerW = Math.max(0, declaredUnitPowerW - asicPowerToRemove);
            const inactiveCount = _asicConfig.length - totalActiveAsicPowerW / perAsicPower;
            console.warn(
              `[HW-Verify] ASIC share gate: ${Math.round(inactiveCount)} ASIC(s) with 0 valid ` +
                `X11 shares - subtracting ${asicPowerToRemove}W ` +
                `(declared ${before}W - ${declaredUnitPowerW}W)`,
            );
          }
        }
        const pcDeclaredPowerW = Math.max(0, declaredUnitPowerW - totalActiveAsicPowerW);
        const calibFactor = Math.min(
          hwAuthority.benchmarkOpsCalibration,
          1.0,
          _allowGpuCalib ? hwAuthority.benchmarkGpuCalibration : 1.0,
        );
        const pcCalibratedPowerW = Math.round(pcDeclaredPowerW * calibFactor);
        hwAuthority.asicPowerW = Math.round(totalActiveAsicPowerW);
        hwAuthority.calibratedUnitPowerW = pcCalibratedPowerW + hwAuthority.asicPowerW;
      }

      const _minerAddrForStats = walletAddressCache.address || '';
      if (_minerAddrForStats && !isBaseline && measuredCpu > 0 && declaredUnitPowerW > 0) {
        recordMinerStats(_minerAddrForStats, declaredUnitPowerW, measuredCpu);
      }
      const minerIsOutlier =
        _minerAddrForStats &&
        !isBaseline &&
        measuredCpu > 0 &&
        declaredUnitPowerW > 0 &&
        isPowerCpuOutlier(_minerAddrForStats, declaredUnitPowerW, measuredCpu, networkMiningStats);

      if (benchmarkHistory.cpuSamples.length === 0) {
        hwAuthority.trustScore = Math.min(hwAuthority.trustScore, 50);
      }

      const trustScoreBefore = hwAuthority.trustScore;
      if (!isBaseline) {
        const rendererIssues = Array.isArray(result.issues) ? result.issues : [];
        const backendFail = result.cpuSpeedProofVerified === false;
        const allIssues = [
          ...rendererIssues,
          ...(backendFail ? ['backend proof integrity failed'] : []),
          ...(anyHwMismatch ? ['hardware identity mismatch (OS ? renderer)'] : []),
          ...(powerVsCpuOverride ? ['power/cpu mismatch - fake ASIC declaration'] : []),
          ...(asicLivenessFailed ? ['asic liveness check failed - hash boards unresponsive'] : []),
          ...(asicModelMismatch ? ['asic model mismatch - declared model does not match hash board'] : []),
          ...(asicHashrateLow ? ['asic hashrate too low - hash boards underperforming or misidentified'] : []),
          ...(asicFirmwareIssue
            ? [
                'asic firmware attestation or temperature consistency check failed - hash board identity or thermal behavior does not match expected values',
              ]
            : []),
          ...(minerIsOutlier ? ['network outlier - power/cpu ratio >3s from mean'] : []),
        ];
        if (allIssues.length > 0) {
          hwAuthority.consecutiveCleanBenchmarks = 0;
          const alreadyPenalised = new Set(['hardware identity mismatch (OS ? renderer)']);
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
      const _cpuSamples = benchmarkHistory.cpuSamples;
      result = Object.assign({}, result, {
        trustScoreBefore,
        trustScoreAfter: hwAuthority.trustScore,
        historySamples: _cpuSamples.length,
        personalMeanCpu: _cpuSamples.length >= 1 ? _cpuSamples.reduce((a, b) => a + b, 0) / _cpuSamples.length : 0,
      });
    }
    return result;
  });

  async function configureAsicPool(asicIp, apiPort, stratumPort, hostIp, driverName, driverConfig) {
    const driver = asicDrivers.getDriver(driverName || 'cgminer');
    if (!driver) return false;
    const poolHost = hostIp || getHostLanIp();
    const poolUrl = `stratum+tcp://${poolHost}:${stratumPort}`;
    try {
      return await driver.configurePool(asicIp, apiPort, poolUrl, driverConfig);
    } catch (_) {
      return false;
    }
  }

  async function disableAsicPool(asicIp, apiPort, driverName, driverConfig) {
    const driver = asicDrivers.getDriver(driverName || 'cgminer');
    if (!driver) return false;
    try {
      return await driver.disablePool(asicIp, apiPort, driverConfig);
    } catch (_) {
      return false;
    }
  }

  function _checkAsicLiveness() {
    for (const entry of _asicConfig) {
      const key = `${entry.ip}:${entry.apiPort}:${entry.stratumPort}`;
      const handle = _stratumHandles.get(entry.stratumPort);
      if (!handle) {
        const state = _asicLivenessState.get(key);
        if (state) state.isActive = false;
        continue;
      }
      const currentShares = handle.getShareCount();
      const state = _asicLivenessState.get(key) || {
        lastShareCount: -1,
        lastActiveMs: 0,
        isActive: true,
        consecutiveIdleChecks: 0,
      };
      if (currentShares > state.lastShareCount) {
        state.isActive = true;
        state.lastShareCount = currentShares;
        state.lastActiveMs = Date.now();
        state.consecutiveIdleChecks = 0;
      } else {
        state.consecutiveIdleChecks++;
        if (state.consecutiveIdleChecks >= ASIC_IDLE_THRESHOLD) {
          state.isActive = false;
        }
      }
      _asicLivenessState.set(key, state);
    }
    _recalculateAsicPower();
  }

  function _startAsicLivenessChecks() {
    _stopAsicLivenessChecks();
    _checkAsicLiveness();
    _asicLivenessInterval = setInterval(_checkAsicLiveness, ASIC_LIVENESS_CHECK_MS);
  }

  function _stopAsicLivenessChecks() {
    if (_asicLivenessInterval) {
      clearInterval(_asicLivenessInterval);
      _asicLivenessInterval = null;
    }
  }

  function _recalculateAsicPower() {
    const prevAsicPowerW = hwAuthority.asicPowerW || 0;
    let activeCount = 0;
    for (const entry of _asicConfig) {
      const key = `${entry.ip}:${entry.apiPort}:${entry.stratumPort}`;
      const state = _asicLivenessState.get(key);
      if (state && state.isActive === false) continue;
      activeCount++;
    }
    const totalAsicPowerW = activeCount > 0 && _declaredAsicModel ? activeCount * getAsicPowerW(_declaredAsicModel) : 0;
    const delta = totalAsicPowerW - prevAsicPowerW;
    if (delta !== 0) {
      hwAuthority.asicPowerW = totalAsicPowerW;
      hwAuthority.calibratedUnitPowerW = Math.max(0, hwAuthority.calibratedUnitPowerW + delta);
    }
    return { asicPowerW: hwAuthority.asicPowerW, calibratedUnitPowerW: hwAuthority.calibratedUnitPowerW };
  }

  ipcMain.handle('wattcoin-asic-set-config', async (_event, config) => {
    if (!Array.isArray(config)) return { ok: false, message: 'config must be an array' };
    const validated = [];
    for (const entry of config) {
      const ip = String(entry.ip || '').trim();
      const apiPort = Math.max(1, Math.min(65535, Number(entry.apiPort) || 4028));
      const stratumPort = Math.max(1024, Math.min(65535, Number(entry.stratumPort) || 3333));
      if (!ip || !net.isIPv4(ip)) return { ok: false, message: `invalid IP: ${ip}` };
      validated.push({
        ip,
        apiPort,
        stratumPort,
        driverName: String(entry.driverName || '').trim(),
        driverConfig: entry.driverConfig || null,
      });
    }
    for (const prev of _asicConfig) stopStratumServer(prev.stratumPort);
    _stratumHandles.clear();
    for (const entry of validated) {
      const handle = await startStratumServer(entry.stratumPort);
      if (handle) _stratumHandles.set(entry.stratumPort, handle);
    }
    _asicConfig = validated;
    _asicLivenessState.clear();
    for (const entry of validated) {
      const key = `${entry.ip}:${entry.apiPort}:${entry.stratumPort}`;
      _asicLivenessState.set(key, {
        lastShareCount: 0,
        lastActiveMs: Date.now(),
        isActive: true,
        consecutiveIdleChecks: 0,
      });
    }
    _closeBgProbeWs();
    _connectBgProbeWs();
    return { ok: true, count: validated.length };
  });

  ipcMain.handle('wattcoin-asic-get-config', () => {
    return { ok: true, config: _asicConfig };
  });

  ipcMain.handle('wattcoin-asic-scan', async () => {
    const results = [];
    const interfaces = os.networkInterfaces();
    const subnets = new Set();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          const parts = iface.address.split('.');
          parts[3] = '0';
          subnets.add(parts.join('.'));
        }
      }
    }
    if (subnets.size === 0) return { ok: true, asics: [] };
    const probedIps = new Set();
    const allIps = [];
    for (const subnet of subnets) {
      for (let i = 1; i <= 254; i++) {
        const ip = `${subnet.slice(0, subnet.lastIndexOf('.'))}.${i}`;
        if (probedIps.has(ip)) continue;
        probedIps.add(ip);
        allIps.push(ip);
      }
    }
    async function probeIp(ip) {
      try {
        const detections = await asicDrivers.tryDetectAll(ip);
        for (const det of detections) {
          const driver = asicDrivers.getDriver(det.driverName);
          const driverConfig = det.preset ? { preset: det.preset } : null;
          const telemetry = driver ? await driver.getTelemetry(ip, det.apiPort, driverConfig).catch(() => null) : null;
          const hashrateTHs = driver ? await driver.getHashrate(ip, det.apiPort, driverConfig).catch(() => 0) : 0;
          results.push({
            ip,
            port: det.apiPort,
            model: det.model,
            version: det.version || '',
            hashrateTHs,
            telemetry,
            driverName: det.driverName,
            driverConfig,
          });
        }
      } catch (_) {
        /* best-effort ASIC detection */
      }
    }
    const CONCURRENCY = 20;
    for (let i = 0; i < allIps.length; i += CONCURRENCY) {
      const chunk = allIps.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map((ip) => probeIp(ip)));
    }
    return { ok: true, asics: results };
  });

  ipcMain.handle('wattcoin-asic-wait-fresh-shares', async (_event, count = 3) => {
    const sinceMs = Date.now();
    const result = await waitForFreshShares(count, sinceMs);
    return { ok: true, ...result };
  });

  ipcMain.handle('wattcoin-asic-inject-custom-job', (_event, prevHashHex) => {
    const results = [];
    for (const entry of _asicConfig) {
      const jobId = injectCustomJob(entry.stratumPort, prevHashHex);
      results.push({ port: entry.stratumPort, jobId });
    }
    return { ok: true, results };
  });

  ipcMain.handle('wattcoin-asic-start-mining', async () => {
    if (_asicConfig.length === 0) return { ok: true, started: 0, failures: 0 };
    const results = await Promise.allSettled(
      _asicConfig.map((a) =>
        configureAsicPool(a.ip, a.apiPort, a.stratumPort, undefined, a.driverName, a.driverConfig),
      ),
    );
    const failures = results.filter((r) => r.status === 'rejected' || r.value === false).length;
    _recalculateAsicPower();
    _startAsicLivenessChecks();
    return { ok: true, started: _asicConfig.length - failures, failures };
  });

  ipcMain.handle('wattcoin-asic-stop-mining', async () => {
    if (_asicConfig.length === 0) return { ok: true, stopped: 0, failures: 0 };
    const results = await Promise.allSettled(
      _asicConfig.map((a) => disableAsicPool(a.ip, a.apiPort, a.driverName, a.driverConfig)),
    );
    const failures = results.filter((r) => r.status === 'rejected' || r.value === false).length;
    _recalculateAsicPower();
    _stopAsicLivenessChecks();
    return { ok: true, stopped: _asicConfig.length - failures, failures };
  });

  ipcMain.handle('wattcoin-asic-liveness-status', () => {
    const status = [];
    for (const entry of _asicConfig) {
      const key = `${entry.ip}:${entry.apiPort}:${entry.stratumPort}`;
      const state = _asicLivenessState.get(key) || { isActive: true, lastShareCount: 0, lastActiveMs: 0 };
      status.push({
        ip: entry.ip,
        port: entry.apiPort,
        stratumPort: entry.stratumPort,
        isActive: state.isActive,
        lastActiveMs: state.lastActiveMs,
        totalShares: state.lastShareCount,
        driverName: entry.driverName,
      });
    }
    return { ok: true, status };
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

  ipcMain.handle('wattcoin-clear-probe-history', () => {
    clearProbeHistory();
  });

  ipcMain.handle('wattcoin-vdf-evaluate', async (_event, opts = {}) => {
    try {
      const challengeHex = typeof opts.challenge === 'string' ? opts.challenge : '';
      const challenge = challengeHex ? Buffer.from(challengeHex, 'hex') : Uint8Array.from([0]);
      const difficulty = typeof opts.difficulty === 'number' ? opts.difficulty : DEFAULT_VDF_DIFFICULTY;
      const discriminantSizeBits =
        typeof opts.discriminantSizeBits === 'number' ? opts.discriminantSizeBits : DEFAULT_VDF_DISCRIMINANT_BITS;
      const result = await vdfEvaluate({ challenge, difficulty, discriminantSizeBits });
      return { ok: true, ...result };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('wattcoin-vdf-verify', (_event, opts = {}) => {
    try {
      const challengeHex = typeof opts.challenge === 'string' ? opts.challenge : '';
      const challenge = challengeHex ? Buffer.from(challengeHex, 'hex') : Uint8Array.from([0]);
      const ok = vdfVerify({
        challenge,
        difficulty: opts.difficulty,
        discriminantSizeBits: opts.discriminantSizeBits,
        proof: opts.proof,
      });
      return { ok };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('wattcoin-vdf-derive-input', (_event, { probeId, workerId, chainIndex } = {}) => {
    try {
      const input = deriveVdfInput(probeId || '', workerId || '', chainIndex || 0);
      return { ok: true, challenge: input.toString('hex') };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  // -- Probe log persistence ------------------------------------------------------
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
      const MAX_STR_LEN = 512;
      const sanitised = entries
        .slice(0, 500)
        .map((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
          const clean = {};
          for (const [k, v] of Object.entries(entry)) {
            if (typeof v === 'string') clean[k] = v.slice(0, MAX_STR_LEN);
            else if (typeof v === 'number' || typeof v === 'boolean') clean[k] = v;
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

  // -- Wallet-bound fingerprint (item 6) -----------------------------------------
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
      const dataStr = JSON.stringify({ ...data, sig: undefined });
      const sig = computeHwAuthSig({ _fpData: dataStr });
      fs.writeFileSync(filePath, JSON.stringify({ ...data, sig }, null, 2), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e && e.message ? e.message : 'write failed' };
    }
  });
}

function moduleGetAsicConfig() {
  return _asicConfig;
}
function moduleGetStratumHandles() {
  return _stratumHandles;
}

module.exports = {
  registerBenchmarkIpcHandlers,
  getAsicConfig: moduleGetAsicConfig,
  getStratumHandles: moduleGetStratumHandles,
};
