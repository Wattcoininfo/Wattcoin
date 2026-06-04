const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');

let gpuProcess = null;
let gpuInfo = null;
let pendingResolve = null;
let pendingTimeout = null;
let currentPercent = 0;
let targetPercent = 0;
let rampUpStartTime = 0;
let rampUpTimer = null;
const RAMP_UP_DURATION_MS = 3000;

let xorKey = null;
let xorKeyStr = '';
const EXPECTED_BIN_HASH = 'c37e889a753fb139fc4842869a9aece6b1bf87d0a50d32f0819d57cd89abd378'; // SHA-256 of gpu-miner.exe

const GPU_BINARY_NAME = 'gpu-miner.exe';

// Telemetry
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
};

// Accumulated encrypted byte buffer (per-line decryption)
let rawBuf = Buffer.alloc(0);

function xorEncrypt(buf) {
  if (!xorKey) return buf;
  const len = buf.length;
  const keyLen = xorKey.length;
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    out[i] = buf[i] ^ xorKey.charCodeAt(i % keyLen);
  }
  return out;
}

function xorDecrypt(buf) {
  return xorEncrypt(buf); // XOR is symmetric
}

function generateSessionKey() {
  const raw = crypto.randomBytes(32);
  xorKey = raw.toString('hex');
  xorKeyStr = 'key:' + xorKey;
}

function verifyBinaryHash(binaryPath) {
  try {
    const hash = crypto.createHash('sha256');
    const data = fs.readFileSync(binaryPath);
    hash.update(data);
    const digest = hash.digest('hex');
    if (digest !== EXPECTED_BIN_HASH) {
      gpuTelemetry.error = `Binary hash mismatch: expected ${EXPECTED_BIN_HASH}, got ${digest}`;
      return false;
    }
    return true;
  } catch (err) {
    gpuTelemetry.error = `Binary hash verification failed: ${err.message}`;
    return false;
  }
}

function findGpuBinary() {
  const isPackaged = !!process.resourcesPath;
  const candidates = [
    // Dev: from project root
    path.join(__dirname, 'native-gpu', 'build', GPU_BINARY_NAME),
    // Dev: from project root (alternative layout)
    path.join(__dirname, '..', 'native-gpu', 'build', GPU_BINARY_NAME),
    // Packaged: resourcesPath/native-gpu/
    ...(isPackaged ? [path.join(process.resourcesPath, 'native-gpu', GPU_BINARY_NAME)] : []),
    // Packaged: resourcesPath/ (flat)
    ...(isPackaged ? [path.join(process.resourcesPath, GPU_BINARY_NAME)] : []),
  ];
  for (const p of candidates) {
    try {
      require('fs').accessSync(p, require('fs').constants.F_OK);
      return p;
    } catch (_) {}
  }
  return null;
}

function spawnGpuProcess() {
  if (gpuProcess) return true;

  const binaryPath = findGpuBinary();
  if (!binaryPath) {
    gpuTelemetry.error = 'GPU native binary not found';
    return false;
  }

  // Anti-cheat: verify binary hash before spawning
  if (!verifyBinaryHash(binaryPath)) {
    return false;
  }

  // Generate session key for pipe encryption
  generateSessionKey();

  gpuTelemetry.error = null; // clear any previous error

  try {
    gpuProcess = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    gpuTelemetry.error = `spawn failed: ${err.message}`;
    xorKey = null;
    xorKeyStr = '';
    return false;
  }

  rawBuf = Buffer.alloc(0);

  // Send the XOR session key as the first message (unencrypted preamble)
  gpuProcess.stdin.write(xorKeyStr + '\n');

  gpuProcess.stdout.on('data', (data) => {
    rawBuf = Buffer.concat([rawBuf, data]);
    processRawBuffer();
  });

  gpuProcess.stderr.on('data', (data) => {
    if (process.env.WATTCOIN_DEBUG) {
      console.warn(`[GpuLoad] stderr: ${data.toString('utf8').trim()}`);
    }
  });

  gpuProcess.on('exit', (code) => {
    if (process.env.WATTCOIN_DEBUG) {
      console.warn(`[GpuLoad] process exited code=${code}`);
    }
    const reason = code === 0 ? 'gpu process exited unexpectedly' : `gpu process crashed (code ${code})`;
    if (!gpuTelemetry.error) gpuTelemetry.error = reason;
    gpuProcess = null;
    xorKey = null;
    xorKeyStr = '';
    gpuTelemetry.status = 'exited';
    // Reject any pending request
    if (pendingResolve) {
      pendingResolve({ t: 'error', msg: reason });
      pendingResolve = null;
    }
  });

  gpuProcess.on('error', (err) => {
    gpuTelemetry.error = `process error: ${err.message}`;
    gpuProcess = null;
    xorKey = null;
    xorKeyStr = '';
  });

  return true;
}

function processRawBuffer() {
  if (!xorKey || xorKey.length === 0) {
    rawBuf = Buffer.alloc(0);
    return;
  }
  const keyLen = xorKey.length;
  let lineStart = 0;
  let i = 0;
  while (i < rawBuf.length) {
    const kIdx = (i - lineStart) % keyLen;
    const decrypted = rawBuf[i] ^ xorKey.charCodeAt(kIdx);
    if (decrypted === 0x0a) {
      const lineLen = i - lineStart + 1;
      const lineBuf_local = Buffer.alloc(lineLen);
      for (let j = 0; j < lineLen; j++) {
        lineBuf_local[j] = rawBuf[lineStart + j] ^ xorKey.charCodeAt(j % keyLen);
      }
      const line = lineBuf_local.toString('utf8').trim();
      if (line) {
        try {
          const msg = JSON.parse(line);
          handleMessage(msg);
        } catch (_) {}
      }
      lineStart = i + 1;
    }
    i++;
  }
  if (lineStart > 0) {
    rawBuf = rawBuf.slice(lineStart);
  }
}

function handleMessage(msg) {
  if (!msg || !msg.t) return;

  switch (msg.t) {
    case 'ready':
      gpuInfo = msg;
      gpuTelemetry.backend = msg.backend || '';
      gpuTelemetry.adapter = msg.adapter || '';
      gpuTelemetry.discrete = msg.discrete || 0;
      gpuTelemetry.vramMb = msg.vramMb || 0;
      gpuTelemetry.vendorId = msg.vendorId || 0;
      gpuTelemetry.deviceId = msg.deviceId || 0;
      gpuTelemetry.status = 'ready';
      // Don't resolve pendingResolve here — the 'info' command response
      // (sent by ensureGpu) will do that once the binary processes it.
      break;

    case 'enum':
    case 'trying':
      // Informational
      break;

    case 'ok':
      gpuTelemetry.duty = msg.duty || 0;
      gpuTelemetry.status = msg.run ? 'running' : 'idle';
      gpuTelemetry.ts = Date.now();
      if (pendingResolve) {
        pendingResolve(msg);
        pendingResolve = null;
      }
      break;

    case 'status':
      gpuTelemetry.duty = msg.duty || 0;
      gpuTelemetry.status = msg.run ? 'running' : 'idle';
      gpuTelemetry.ts = Date.now();
      // Don't consume pendingResolve — status is an unsolicited periodic
      // message that can arrive while waiting for a bench/proof response.
      break;

    case 'proof':
      if (pendingResolve) {
        pendingResolve(msg);
        pendingResolve = null;
      }
      break;

    case 'bench':
      gpuTelemetry.benchScore = msg.score || 0;
      gpuTelemetry.frames = msg.frames || 0;
      if (pendingResolve) {
        pendingResolve(msg);
        pendingResolve = null;
      }
      break;

    case 'info':
      if (pendingResolve) {
        pendingResolve(msg);
        pendingResolve = null;
      }
      break;

    case 'error':
      gpuTelemetry.error = msg.msg || 'unknown error';
      console.warn(`[GpuLoad] binary error: ${gpuTelemetry.error}`);
      if (pendingResolve) {
        pendingResolve(msg);
        pendingResolve = null;
      }
      break;
  }
}

function sendCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (!gpuProcess || !gpuProcess.stdin.writable) {
      return reject(new Error('GPU process not running'));
    }
    pendingResolve = (msg) => {
      cleanupPending();
      resolve(msg);
    };
    pendingTimeout = setTimeout(() => {
      pendingResolve = null;
      reject(new Error('GPU command timeout'));
    }, 30000);
    const payload = JSON.stringify(cmd) + '\n';
    gpuProcess.stdin.write(xorEncrypt(Buffer.from(payload, 'utf8')));
  });
}

function cleanupPending() {
  if (pendingTimeout) {
    clearTimeout(pendingTimeout);
    pendingTimeout = null;
  }
  pendingResolve = null;
}

// ── Public API ─────────────────────────────────────────────────────────

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

async function ensureGpu() {
  if (gpuProcess && gpuInfo) return true;
  if (!spawnGpuProcess()) return false;
  // Wait for 'ready' message from the binary (gpuInfo is set in handleMessage)
  const deadline = Date.now() + 30000;
  while (!gpuInfo && Date.now() < deadline) {
    if (!gpuProcess) break; // process crashed/exited before sending ready
    await new Promise((r) => setTimeout(r, 10));
  }
  if (!gpuInfo) {
    // Surface any backend-specific error collected during the wait
    if (gpuTelemetry.error) {
      gpuTelemetry.gpuBenchError = gpuTelemetry.error;
    }
    return false;
  }
  if (!gpuInfo) return false;
  // Verify binary is responsive
  try {
    const resp = await sendCommand({ info: true });
    return resp && resp.t === 'info';
  } catch (_) {
    return false;
  }
}

async function startGpuLoad(percent) {
  if (!(await ensureGpu())) return false;
  try {
    const res = await sendCommand({ start: true, loadPercent: clampPercent(percent) });
    return res && res.t === 'ok';
  } catch (_) {
    return false;
  }
}

async function setGpuLoad(percent) {
  if (!gpuProcess) return false;
  try {
    const res = await sendCommand({ set: true, loadPercent: clampPercent(percent) });
    return res && res.t === 'ok';
  } catch (_) {
    return false;
  }
}

async function stopGpuLoad() {
  if (!gpuProcess) return;
  try {
    await sendCommand({ stop: true });
  } catch (_) {}
}

async function runGpuProof(seed, size, iters) {
  if (!(await ensureGpu())) return null;
  try {
    const res = await sendCommand({ proof: true, seed, size, iters });
    if (res && res.t === 'proof') {
      return {
        hash: String(res.hash),
        elapsedMs: res.ms,
        seed: res.seed,
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function runGpuBenchmark() {
  if (!(await ensureGpu())) {
    const errMsg = gpuTelemetry.error || 'GPU unavailable';
    console.warn(`[GpuLoad] benchmark failed: ${errMsg}`);
    return { score: 0, error: errMsg };
  }
  try {
    const res = await sendCommand({ bench: true });
    if (res && res.t === 'bench') {
      return {
        score: res.score || 0,
        frames: res.frames || 0,
        elapsedMs: res.elapsedMs || 0,
        opsPerMs: res.opsPerMs || 0,
      };
    }
    return { score: 0, error: 'bench failed' };
  } catch (err) {
    return { score: 0, error: err.message };
  }
}

function getGpuInfo() {
  return gpuInfo ? { ...gpuInfo } : null;
}

function getGpuLoadState() {
  return {
    ...gpuTelemetry,
    currentPercent,
    targetPercent,
    available: !!gpuProcess,
    hasGpu: gpuTelemetry.status !== 'idle' || gpuTelemetry.status !== 'exited',
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
      await setGpuLoad(nextPercent).catch(() => {});
    }

    if (rampFactor >= 1) {
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

async function setGpuLoadPercent(percent) {
  const next = clampPercent(percent);

  if (next <= 0) {
    stopRampUp();
    await stopGpuLoad();
    currentPercent = 0;
    targetPercent = 0;
    return currentPercent;
  }

  // Start GPU process if needed
  if (!(await ensureGpu())) {
    gpuTelemetry.error = 'GPU binary unavailable';
    return 0;
  }

  startRampUp(next);
  return currentPercent;
}

function stopGpuHardwareLoad() {
  stopRampUp();
  currentPercent = 0;
  targetPercent = 0;
  stopGpuLoad().catch(() => {});
}

function shutdownGpu() {
  stopRampUp();
  if (gpuProcess) {
    try {
      const payload = JSON.stringify({ quit: true }) + '\n';
      gpuProcess.stdin.write(xorEncrypt(Buffer.from(payload, 'utf8')));
    } catch (_) {}
    setTimeout(() => {
      if (gpuProcess) {
        gpuProcess.kill();
        gpuProcess = null;
      }
    }, 500);
  }
}

module.exports = {
  ensureGpu,
  getGpuInfo,
  getGpuLoadState,
  setGpuLoadPercent,
  stopGpuHardwareLoad,
  shutdownGpu,
  runGpuProof,
  runGpuBenchmark,
  startGpuLoad,
  setGpuLoad,
  stopGpuLoad,
  clampPercent,
};
