const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const DEBUG_LOG = path.join(os.tmpdir(), 'wattcoin-gpu-debug.log');
function debugLog(...args) {
  try {
    fs.appendFileSync(
      DEBUG_LOG,
      new Date().toISOString() +
        ' ' +
        args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') +
        '\n',
    );
  } catch (_) {
    /* ignore file-log failures on worker machines */
  }
}

// Per-GPU process states
const gpuStates = new Map(); // deviceIndex -> { process, info, telemetry, pendingResolve, pendingTimeout, rawBuf }
let currentPercent = 0;
let targetPercent = 0;
let rampUpStartTime = 0;
let rampUpTimer = null;
const RAMP_UP_DURATION_MS = 3000;

const GPU_BINARY_NAME = 'gpu-miner.exe';

// Track recent GPU-PoW activity to account for probe time in GPU duty.
let lastPowActivity = { ts: 0, elapsedMs: 0, devices: 0 };

// Aggregated telemetry (merged from per-GPU processes)
let gpuTelemetry = {
  backend: '',
  adapter: '',
  discrete: 0,
  vramMb: 0,
  status: 'idle',
  duty: 0,
  targetPercent: 0,
  currentPercent: 0,
  ts: 0,
  frames: 0,
  benchScore: 0,
  error: null,
  lastPowTs: 0,
  lastPowElapsedMs: 0,
};

function findGpuBinary() {
  const isPackaged = !!process.resourcesPath;
  const candidates = [
    path.join(__dirname, 'native-gpu', 'build', GPU_BINARY_NAME),
    path.join(__dirname, '..', 'native-gpu', 'build', GPU_BINARY_NAME),
    ...(isPackaged ? [path.join(process.resourcesPath, 'native-gpu', GPU_BINARY_NAME)] : []),
    ...(isPackaged ? [path.join(process.resourcesPath, GPU_BINARY_NAME)] : []),
  ];
  for (const p of candidates) {
    try {
      require('fs').accessSync(p, require('fs').constants.F_OK);
      return p;
    } catch (_) {
      /* not found */
    }
  }
  return null;
}

function spawnGpuProcess(deviceIndex, adapterIndex) {
  const binaryPath = findGpuBinary();
  if (!binaryPath) {
    gpuTelemetry.error = 'GPU native binary not found';
    return false;
  }

  let process;
  try {
    // When no specific adapter index is given (first GPU on a filtered list),
    // omit --adapter so the native binary auto-selects the best discrete GPU.
    const args = adapterIndex !== undefined ? ['--adapter', String(adapterIndex)] : [];
    process = spawn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    gpuTelemetry.error = `spawn failed for device ${deviceIndex}: ${err.message}`;
    return false;
  }

  const state = {
    process,
    info: null,
    telemetry: {
      backend: '',
      adapter: '',
      discrete: 0,
      vramMb: 0,
      status: 'starting',
      duty: 0,
      targetPercent: 0,
      currentPercent: 0,
      ts: 0,
      frames: 0,
      benchScore: 0,
      error: null,
    },
    pendingResolve: null,
    pendingTimeout: null,
    cmdQueue: null,
    rawBuf: Buffer.alloc(0),
  };

  gpuStates.set(deviceIndex, state);

  process.stdout.on('data', (data) => {
    state.rawBuf = Buffer.concat([state.rawBuf, data]);
    processRawBuffer(state);
  });

  process.stderr.on('data', (data) => {
    if (process.env.WATTCOIN_DEBUG) {
      console.warn(`[GpuLoad:${deviceIndex}] stderr: ${data.toString('utf8').trim()}`);
    }
  });

  process.on('exit', (code) => {
    if (process.env.WATTCOIN_DEBUG) {
      console.warn(`[GpuLoad:${deviceIndex}] process exited code=${code}`);
    }
    const reason = code === 0 ? 'gpu process exited unexpectedly' : `gpu process crashed (code ${code})`;
    if (!state.telemetry.error) state.telemetry.error = reason;
    state.telemetry.status = 'exited';
    if (state.pendingResolve) {
      state.pendingResolve({ t: 'error', msg: reason });
      state.pendingResolve = null;
    }
    gpuStates.delete(deviceIndex);
    mergeTelemetry();
  });

  process.on('error', (err) => {
    state.telemetry.error = `process error: ${err.message}`;
    gpuStates.delete(deviceIndex);
    mergeTelemetry();
  });

  return true;
}

function processRawBuffer(state) {
  let lineStart = 0;
  for (let i = 0; i < state.rawBuf.length; i++) {
    if (state.rawBuf[i] === 0x0a) {
      const line = state.rawBuf.toString('utf8', lineStart, i).trim();
      if (line) {
        try {
          const msg = JSON.parse(line);
          handleMessage(state, msg);
        } catch (_) {
          /* ignore malformed */
        }
      }
      lineStart = i + 1;
    }
  }
  if (lineStart > 0) {
    state.rawBuf = state.rawBuf.slice(lineStart);
  }
}

function handleMessage(state, msg) {
  if (!msg || !msg.t) return;

  // Find the device index for this state
  let deviceIndex = -1;
  for (const [idx, s] of gpuStates) {
    if (s === state) {
      deviceIndex = idx;
      break;
    }
  }

  switch (msg.t) {
    case 'ready':
      state.info = msg;
      state.telemetry.backend = msg.backend || '';
      state.telemetry.adapter = msg.adapter || '';
      state.telemetry.discrete = msg.discrete || 0;
      state.telemetry.vramMb = msg.vramMb || 0;
      state.telemetry.vendorId = msg.vendorId || 0;
      state.telemetry.deviceId = msg.deviceId || 0;
      state.telemetry.status = 'ready';
      mergeTelemetry();
      break;

    case 'enum':
    case 'trying':
      break;

    case 'ok':
      state.telemetry.duty = msg.duty || 0;
      state.telemetry.status = msg.run ? 'running' : 'idle';
      state.telemetry.ts = Date.now();
      if (state.pendingResolve) {
        state.pendingResolve(msg);
      }
      mergeTelemetry();
      break;

    case 'status':
      state.telemetry.duty = msg.duty || 0;
      state.telemetry.status = msg.run ? 'running' : 'idle';
      state.telemetry.ts = Date.now();
      mergeTelemetry();
      break;

    case 'proof':
      if (state.pendingResolve) {
        state.pendingResolve(msg);
      }
      break;

    case 'pow':
      debugLog(`[GpuLoad:${deviceIndex}] received pow response nonce=${msg.nonce} ms=${msg.ms}`);
      lastPowActivity = { ts: Date.now(), elapsedMs: Math.max(0, Number(msg.ms) || 0), devices: gpuStates.size };
      state.telemetry.lastPowTs = lastPowActivity.ts;
      state.telemetry.lastPowElapsedMs = lastPowActivity.elapsedMs;
      if (state.pendingResolve) {
        state.pendingResolve(msg);
      } else {
        debugLog(`[GpuLoad:${deviceIndex}] pow response with no pendingResolve!`);
      }
      mergeTelemetry();
      break;

    case 'bench':
      state.telemetry.benchScore = msg.score || 0;
      state.telemetry.frames = msg.frames || 0;
      if (state.pendingResolve) {
        state.pendingResolve(msg);
      }
      mergeTelemetry();
      break;

    case 'info':
      if (state.pendingResolve) {
        state.pendingResolve(msg);
      }
      break;

    case 'error':
      state.telemetry.error = msg.msg || 'unknown error';
      console.warn(`[GpuLoad:${deviceIndex}] binary error: ${state.telemetry.error}`);
      if (state.pendingResolve) {
        state.pendingResolve(msg);
      }
      mergeTelemetry();
      break;
  }
}

function mergeTelemetry() {
  let totalDuty = 0;
  let totalVramMb = 0;
  let totalDiscrete = 0;
  let totalFrames = 0;
  let totalBenchScore = 0;
  let anyRunning = false;
  let anyReady = false;
  let firstBackend = '';
  let firstAdapter = '';
  let firstError = null;
  let firstStatus = 'idle';
  let firstTs = 0;

  for (const state of gpuStates.values()) {
    const t = state.telemetry;
    totalDuty += t.duty || 0;
    totalVramMb += t.vramMb || 0;
    totalDiscrete += t.discrete || 0;
    totalFrames += t.frames || 0;
    totalBenchScore += t.benchScore || 0;
    if (t.status === 'running') anyRunning = true;
    if (t.status === 'ready' || t.status === 'running') anyReady = true;
    if (!firstBackend) firstBackend = t.backend || '';
    if (!firstAdapter) firstAdapter = t.adapter || '';
    if (!firstError && t.error) firstError = t.error;
    if (t.ts > firstTs) firstTs = t.ts;
  }

  if (anyRunning) firstStatus = 'running';
  else if (anyReady) firstStatus = 'ready';
  else firstStatus = 'idle';

  gpuTelemetry = {
    backend: firstBackend,
    adapter: firstAdapter,
    discrete: totalDiscrete,
    vramMb: totalVramMb,
    status: firstStatus,
    duty: totalDuty,
    targetPercent,
    currentPercent,
    ts: firstTs || Date.now(),
    frames: totalFrames,
    benchScore: totalBenchScore,
    error: firstError,
    gpuCount: gpuStates.size,
    lastPowTs: lastPowActivity.ts,
    lastPowElapsedMs: lastPowActivity.elapsedMs,
  };
}

function getState(deviceIndex) {
  return gpuStates.get(deviceIndex) || null;
}

function sendCommand(deviceIndex, cmd) {
  return new Promise((resolve, reject) => {
    const state = getState(deviceIndex);
    if (!state || !state.process || !state.process.stdin.writable) {
      return reject(new Error(`GPU process ${deviceIndex} not running`));
    }

    // Queue this command if another is already in-flight.
    if (state.pendingResolve) {
      if (!state.cmdQueue) state.cmdQueue = [];
      state.cmdQueue.push({ cmd, resolve, reject });
      return;
    }

    sendQueuedOrDirect(state, deviceIndex, cmd, resolve, reject);
  });
}

function sendQueuedOrDirect(state, deviceIndex, cmd, resolve, reject) {
  const cmdStr = JSON.stringify(cmd);
  debugLog(`[GpuLoad] sendCommand device=${deviceIndex} cmd=${cmdStr}`);
  state.pendingResolve = (msg) => {
    clearTimeout(state.pendingTimeout);
    state.pendingTimeout = null;
    state.pendingResolve = null;
    debugLog(`[GpuLoad] sendCommand device=${deviceIndex} resolved with t=${msg.t}`);
    resolve(msg);

    // Dispatch next queued command, if any.
    if (state.cmdQueue && state.cmdQueue.length > 0) {
      const next = state.cmdQueue.shift();
      sendQueuedOrDirect(state, deviceIndex, next.cmd, next.resolve, next.reject);
    }
  };
  state.pendingTimeout = setTimeout(() => {
    debugLog(`[GpuLoad] TIMEOUT on device ${deviceIndex} after 30s for command ${JSON.stringify(cmd)}`);
    state.pendingResolve = null;
    state.cmdQueue = null;
    reject(new Error(`GPU command timeout on device ${deviceIndex}`));
  }, 30000);
  const payload = JSON.stringify(cmd) + '\n';
  state.process.stdin.write(payload, 'utf8');
}

function broadcastCommand(cmd) {
  const promises = [];
  for (const deviceIndex of gpuStates.keys()) {
    promises.push(sendCommand(deviceIndex, cmd).catch(() => null));
  }
  return Promise.all(promises);
}

// ── Public API ─────────────────────────────────────────────────────────

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

async function ensureGpu(numGpus) {
  const count = Math.max(1, Number(numGpus) || 1);
  if (gpuStates.size >= count && count > 0) {
    // All requested GPUs already running
    for (const state of gpuStates.values()) {
      if (state.info) continue;
      debugLog(`[GpuLoad] ensureGpu waiting for device info (up to 30s)...`);
      const deadline = Date.now() + 30000;
      while (!state.info && Date.now() < deadline) {
        if (!state.process) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      if (!state.info) {
        debugLog(`[GpuLoad] ensureGpu: device info not ready after 30s`);
        return false;
      }
    }
    debugLog(`[GpuLoad] ensureGpu: all devices responsive`);
    return true;
  }

  // Spawn missing processes.
  // For the first GPU, omit --adapter so the native binary auto-selects the
  // best (discrete-first) adapter.  Additional GPUs pass their sequential
  // index — this works when all remaining adapters are discrete and DXGI
  // enumerates them contiguously after the integrated one.
  for (let i = gpuStates.size; i < count; i++) {
    const adapterIndex = i === 0 ? undefined : i;
    if (!spawnGpuProcess(i, adapterIndex)) {
      gpuTelemetry.error = `Failed to spawn GPU process for device ${i}`;
      return false;
    }
  }

  // Wait for all to be ready
  for (const [, state] of gpuStates) {
    if (state.info) continue;
    const deadline = Date.now() + 30000;
    while (!state.info && Date.now() < deadline) {
      if (!state.process) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    if (!state.info) return false;
  }

  // Verify each GPU is responsive
  for (const deviceIndex of gpuStates.keys()) {
    try {
      const resp = await sendCommand(deviceIndex, { info: true });
      if (!resp || resp.t !== 'info') return false;
    } catch (_) {
      return false;
    }
  }

  mergeTelemetry();
  return true;
}

async function startGpuLoad(percent, gpuCountPer) {
  if (!(await ensureGpu(gpuCountPer))) return false;
  try {
    const results = await broadcastCommand({ start: true, loadPercent: clampPercent(percent) });
    return results.some((r) => r && r.t === 'ok');
  } catch (_) {
    return false;
  }
}

async function setGpuLoad(percent) {
  if (gpuStates.size === 0) return false;
  try {
    const results = await broadcastCommand({ set: true, loadPercent: clampPercent(percent) });
    return results.some((r) => r && r.t === 'ok');
  } catch (_) {
    return false;
  }
}

async function stopGpuLoad() {
  if (gpuStates.size === 0) return;
  try {
    await broadcastCommand({ stop: true });
  } catch (_) {
    /* ignore */
  }
}

async function runGpuPowProbe(seed, difficulty) {
  const count = Math.max(1, gpuStates.size || 1);
  if (!(await ensureGpu(count))) return null;

  const results = [];
  for (const deviceIndex of gpuStates.keys()) {
    try {
      // Partition nonce space per device by deriving a unique seed for each.
      const deviceSeed = (seed ^ (deviceIndex * 7919)) >>> 0;
      const res = await sendCommand(deviceIndex, { pow: true, seed: deviceSeed, difficulty });
      if (res && res.t === 'pow') {
        results.push({
          deviceIndex,
          nonce: Number(res.nonce),
          elapsedMs: res.ms,
        });
      } else if (res && res.t === 'error') {
        results.push({ deviceIndex, nonce: null, elapsedMs: 0, error: res.msg || 'pow failed' });
      } else {
        results.push({ deviceIndex, nonce: null, elapsedMs: 0, error: 'pow response missing' });
      }
    } catch (err) {
      debugLog(`[GpuLoad] runGpuPowProbe device ${deviceIndex} error: ${err.message}`);
      results.push({ deviceIndex, nonce: null, elapsedMs: 0, error: err.message });
    }
  }

  if (results.length === 0) return null;
  return results;
}

function getGpuInfo() {
  if (gpuStates.size === 0) return null;
  const firstState = gpuStates.values().next().value;
  return firstState.info ? { ...firstState.info, gpuCount: gpuStates.size } : null;
}

function getGpuLoadState() {
  return {
    ...gpuTelemetry,
    currentPercent,
    targetPercent,
    available: gpuStates.size > 0,
    hasGpu: gpuStates.size > 0,
    gpuCount: gpuStates.size,
  };
}

function startRampUp(targetLoad) {
  stopRampUp();
  const startPercent = currentPercent;
  rampUpStartTime = Date.now();
  targetPercent = targetLoad;

  rampUpTimer = setInterval(async () => {
    const elapsedMs = Date.now() - rampUpStartTime;
    const rampFactor = Math.min(1, elapsedMs / RAMP_UP_DURATION_MS);
    const nextPercent = Math.round(startPercent + (targetLoad - startPercent) * rampFactor);

    if (nextPercent !== currentPercent) {
      currentPercent = nextPercent;
      debugLog(`[GpuLoad] ramp-up: setting load to ${nextPercent} (target=${targetLoad})`);
      await setGpuLoad(nextPercent).catch(() => {});
    }

    if (rampFactor >= 1) {
      debugLog(`[GpuLoad] ramp-up: complete at ${currentPercent}`);
      stopRampUp();
    }
  }, 50);
}

function stopRampUp() {
  if (rampUpTimer) {
    clearInterval(rampUpTimer);
    rampUpTimer = null;
  }
  rampUpStartTime = 0;
}

async function setGpuLoadPercent(percent, ...args) {
  const next = clampPercent(percent);
  debugLog(
    `[GpuLoad] setGpuLoadPercent called percent=${percent} next=${next} currentPercent=${currentPercent} targetPercent=${targetPercent} rampUpTimer=${!!rampUpTimer}`,
  );

  // Support both setGpuLoadPercent(percent, gpuCount) and setGpuLoadPercent(percent)
  const numGpus = args.length > 0 ? Math.max(1, Number(args[0]) || 1) : Math.max(1, gpuStates.size || 1);

  if (next <= 0) {
    debugLog(`[GpuLoad] setGpuLoadPercent -> stop (next<=0)`);
    stopRampUp();
    await stopGpuLoad();
    currentPercent = 0;
    targetPercent = 0;
    return currentPercent;
  }

  if (!(await ensureGpu(numGpus))) {
    debugLog(`[GpuLoad] setGpuLoadPercent -> ensureGpu failed`);
    gpuTelemetry.error = 'GPU binary unavailable';
    return 0;
  }

  debugLog(`[GpuLoad] setGpuLoadPercent -> startRampUp(${next}) from currentPercent=${currentPercent}`);
  startRampUp(next);
  return next;
}

function stopGpuHardwareLoad() {
  debugLog(`[GpuLoad] stopGpuHardwareLoad called`);
  stopRampUp();
  currentPercent = 0;
  targetPercent = 0;
  stopGpuLoad().catch(() => {});
}

function shutdownGpu() {
  stopRampUp();
  for (const [, state] of gpuStates) {
    try {
      const payload = JSON.stringify({ quit: true }) + '\n';
      state.process.stdin.write(payload, 'utf8');
    } catch (_) {
      /* write may fail if pipe closed */
    }
  }
  setTimeout(() => {
    for (const [, state] of gpuStates) {
      try {
        state.process.kill();
      } catch (_) {
        /* already dead */
      }
    }
    gpuStates.clear();
  }, 500);
}

module.exports = {
  ensureGpu,
  getGpuInfo,
  getGpuLoadState,
  setGpuLoadPercent,
  stopGpuHardwareLoad,
  shutdownGpu,
  runGpuPowProbe,
  startGpuLoad,
  setGpuLoad,
  stopGpuLoad,
  clampPercent,
  findGpuBinary,
};
