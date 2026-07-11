// ─── Memory bandwidth expected values ─────────────────────────────────────────
// Returns expected sequential bandwidth in MB/s for the declared memory spec.
// Formula: channels × speedMhz × 8 bytes (64-bit bus) × efficiency_factor.
// Node.js sequential bench achieves ~55% of theoretical peak, so efficiency=0.55.
// Called with hardware.memType (DDR4/DDR5/LPDDR5…), memSpeedMhz, and memSticks.
export function getExpectedMemBandwidthMBps(memType, memSpeedMhz, memSticks) {
  if (!memSpeedMhz || memSpeedMhz <= 0) return 0;
  // Infer channel count: ≥2 sticks usually implies dual-channel for DDR4/DDR5.
  // LPDDR is always one "virtual channel" per package (spec-defined 128-bit bus treats as 2 ch).
  const isLPDDR = /LPDDR/i.test(memType || '');
  const _isDDR5 = /DDR5/i.test(memType || '');
  let channels = isLPDDR ? 2 : memSticks >= 2 ? 2 : 1;
  // DDR4/5: bus width = 64 bits = 8 bytes per transfer; speed in MT/s
  const theoreticalMBps = channels * memSpeedMhz * 8; // MT/s × 8 B = MB/s
  const efficiency = 0.25; // fraction of theoretical peak reported by this bench.
  // Stride-64 writes cause a read-for-ownership per cache line,
  // so actual DRAM traffic is 2× the buffer size, but we only
  // count bytes written.  V8 vs native adds further overhead.
  // Derivation: 65% peak × 50% RFO factor × 80% V8 ≈ 26%,
  // round down to 0.25 — applies universally across all DDR types.
  return Math.round(theoreticalMBps * efficiency);
}

// ─── WebGL GPU benchmark ───────────────────────────────────────────────────────
// Runs a compute-heavy fragment shader on a DOM canvas temporarily attached to
// document.body.  Attaching it ensures Chromium/Electron routes WebGL through the
// HW GPU compositor rather than SwiftShader (which OffscreenCanvas may use when
// the context is never composited).
// Returns { score, framesRendered, elapsedMs } or null when WebGL is unavailable.
// "score" = frames × SIZE² × C_OPS / elapsedMs — ALU-ops-per-ms metric.
export async function runWebGLBenchmark() {
  // Inner helper: runs the full shader benchmark on an already-created WebGL2 context.
  // Returns { score, framesRendered, elapsedMs } or { error } (shader compile/link fail or
  // calibMs < 0.1 — pipeline did not drain, context is no-op or software-rendered).
  function _bench(gl, SIZE) {
    const vsSource = `#version 300 es
      in vec2 aPos;
      void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
    `;
    // 256 dependent MAD iterations per pixel — hard to optimise away.
    const fsSource = `#version 300 es
      precision highp float;
      uniform float uSeed;
      out vec4 fragColor;
      void main() {
        vec4 c = vec4(gl_FragCoord.xy / ${SIZE}.0, uSeed, 1.0 - uSeed);
        for (int i = 0; i < 256; i++) {
          c.x = c.x * c.y + c.z * 0.00013;
          c.y = c.y * c.z + c.w * 0.00017;
          c.z = c.z * c.w + c.x * 0.00019;
          c.w = c.w * c.x + c.y * 0.00023;
        }
        fragColor = c;
      }
    `;

    const compileShader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        gl.deleteShader(s);
        return null;
      }
      return s;
    };
    const vs = compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return { error: 'GPU-E1: shader compile failed' };

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { error: 'GPU-E2: shader link failed' };
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const aPosLoc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(aPosLoc);
    gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, false, 0, 0);
    const uSeedLoc = gl.getUniformLocation(prog, 'uSeed');

    // GPU sync: full-framebuffer readPixels per frame.
    // readPixels on the full 512×512 render target MUST return real pixel data —
    // the driver cannot skip the GPU work without producing wrong pixel values.
    // Per-frame sync (not batched) ensures each frame's GPU work is individually
    // timed, giving a score that reflects real pipeline throughput.
    const SYNC_W = SIZE,
      SYNC_H = SIZE;
    const syncBuf = new Uint8Array(SYNC_W * SYNC_H * 4);
    function gpuSync() {
      gl.readPixels(0, 0, SYNC_W, SYNC_H, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf);
    }

    // Warmup: 5 frames with per-frame sync to JIT shaders and warm caches.
    for (let i = 0; i < 5; i++) {
      gl.uniform1f(uSeedLoc, i * 0.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gpuSync();
    }

    // Adaptive calibration: render frames one-at-a-time with per-frame sync
    // until at least MIN_CALIB_MS of real GPU wall-time has accumulated.
    // Cap at 200 frames to bound calibration time on slow GPUs.
    const MIN_CALIB_MS = 20;
    let calibFrames = 0;
    const tCalib0 = performance.now();
    do {
      gl.uniform1f(uSeedLoc, 0.5 + calibFrames * 0.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gpuSync();
      calibFrames++;
    } while (performance.now() - tCalib0 < MIN_CALIB_MS && calibFrames < 200);
    const calibMs = performance.now() - tCalib0;
    // Safety: if 200 frames finished in < 1 ms, readPixels is not stalling.
    if (calibMs < 1.0 && calibFrames >= 200) {
      console.warn('[GPU benchmark] readPixels not stalling (200 frames in ' + calibMs.toFixed(2) + 'ms)');
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      gl.deleteBuffer(buf);
      return { error: 'GPU-E3: readPixels not stalling (' + calibMs.toFixed(2) + 'ms / 200 frames)' };
    }
    const msPerFrame = Math.max(0.01, calibMs / calibFrames);

    // Choose frame count to target ~1000 ms of GPU work; clamp to 5–1000 frames.
    const targetFrames = Math.min(1000, Math.max(5, Math.round(1000 / msPerFrame)));

    // Benchmark pass: per-frame sync.
    const t0 = performance.now();
    for (let i = 0; i < targetFrames; i++) {
      gl.uniform1f(uSeedLoc, i * 0.001);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gpuSync();
    }
    const elapsedMs = Math.max(1, performance.now() - t0);

    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteBuffer(buf);

    // Score: ALU ops executed per ms (normalised).
    // 256 iterations × 4 MAD = 1024 effective FP32 ops per pixel per frame.
    const opsPerFrame = SIZE * SIZE * 1024;
    const score = Math.round((targetFrames * opsPerFrame) / elapsedMs); // ops/ms
    return { score, framesRendered: targetFrames, elapsedMs: Math.round(elapsedMs) };
  }

  const SIZE = 512; // larger render target → more work per draw call

  // DOM canvas only — routed via the hardware GPU compositor, same path as
  // runGpuBenchmarkProof (confirmed working on dedicated GPUs).
  // OffscreenCanvas is intentionally skipped: it bypasses the compositor, which
  // makes readPixels pipeline-sync unreliable on ANGLE/D3D11 drivers — the GPU
  // work may not stall the CPU even with a 16×16 read, causing 200-frame calibration
  // cap to trip and _bench to return null even on real discrete hardware.
  let domCanvas = null;
  let domAttached = false;
  try {
    domCanvas = document.createElement('canvas');
    domCanvas.width = SIZE;
    domCanvas.height = SIZE;
    domCanvas.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none;opacity:0.001;';
    try {
      document.body.appendChild(domCanvas);
      domAttached = true;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }
    const gl = domCanvas.getContext('webgl2');
    if (!gl) return { error: 'GPU-E5: no webgl2 context' };
    return await _bench(gl, SIZE);
  } catch (e) {
    console.warn('[GPU benchmark] failed:', e && e.message);
    return { error: 'GPU-E6: exception (' + ((e && e.message) || 'unknown') + ')' };
  } finally {
    if (domAttached && domCanvas) {
      try {
        document.body.removeChild(domCanvas);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  }
}

// ─── GPU probe ────────────────────────────────────────────────────────────────
// Single-frame WebGL render used by the mining probe system.
// Unlike runWebGLBenchmark (which uses gl.finish() to time many frames),
// this function uses gl.readPixels() which GUARANTEES synchronous GPU completion —
// the call blocks until all pending GPU work is done, giving an accurate elapsed time.
//
// Item 3: Uses a pure-integer XOR-shift shader (WebGL2 required) so the coordinator
// can recompute the expected pixelHash in pure Node.js — bit-identical to the GPU
// output because GLSL ES 3.0 `int` is defined two's-complement 32-bit, matching JS.
// Falls back to the original float shader on WebGL1 (timing-only verification then).
//
// Standalone CPU probe computation — module-level function so V8 can permanently optimize
// it with TurboFan, avoiding baseline-compiler-only execution inside async context.
// Synchronous CPU probe computation — module-level standalone function so V8 can
// permanently optimize it with TurboFan.  Called twice: first as warmup with
// a small iteration count to trigger compilation, then for the real measurement.
let _cpuProbeCallCount = 0;
export function getCpuProbeCallCount() {
  return _cpuProbeCallCount;
}
export function resetCpuProbeCallCount(v) {
  _cpuProbeCallCount = v;
}
export function runCpuProbe(seed, iterations, recordChunks) {
  _cpuProbeCallCount++;
  let x = seed | 0 || 1;
  const N = iterations | 0;
  const chunks = recordChunks ? [] : null;
  const CHUNK = 25000000;
  let prev = performance.now();
  for (let chunkStart = 0; chunkStart < N; chunkStart += CHUNK) {
    const chunkEnd = Math.min(chunkStart + CHUNK, N);
    for (let i = chunkStart; i < chunkEnd; i++) {
      x = (Math.imul(x, 48271) + 9973) | 0;
      x ^= x << 13;
      x ^= x >> 17;
      x ^= x << 5;
      x &= 0x7fffffff;
    }
    if (chunks) {
      const now = performance.now();
      chunks.push(Math.round((now - prev) * 10) / 10);
      prev = now;
    }
  }
  return { proof: (x >>> 0).toString(16).padStart(8, '0'), chunks };
}

// Returns { pixelHash, elapsedMs, integerShader } or null when WebGL unavailable.
export function runGpuProbe(seed, size, shaderIterations) {
  let canvas = null;
  let attached = false;
  try {
    canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none;opacity:0.001;';
    try {
      document.body.appendChild(canvas);
      attached = true;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }

    // Prefer WebGL2 for the integer-shader path (item 3).
    const gl2 = canvas.getContext('webgl2');
    const gl = gl2 || canvas.getContext('webgl');
    if (!gl) {
      console.error('[runGpuProbe] No WebGL context');
      return null;
    }
    const useIntShader = !!gl2;

    // Vertex shader MUST match the GLSL version of the fragment shader.
    // WebGL2 programs require both shaders to use the same GLSL version;
    // mixing a GLSL 1.00 vertex shader (no directive, `attribute`) with a
    // GLSL 3.00 fragment shader (`#version 300 es`, `out`) silently fails to
    // link — the root cause of "no pixel hash returned" on WebGL2 drivers.
    const vsSource = useIntShader
      ? `#version 300 es\nin vec2 aPos;\nvoid main() { gl_Position = vec4(aPos, 0.0, 1.0); }`
      : `attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

    // Integer shader (WebGL2): deterministic 32-bit XOR-shift per pixel.
    // Coordinator can verify in pure JS with computeGpuProbeExpectedHash().
    // uSeedInt is a uniform int; seed values are constrained to [1, 0x7FFFFFFF] at probe issuance.
    // Pack all 32 bits of x across RGBA so the GPU compiler cannot dead-eliminate
    // any XOR-shift iterations based on the observation that only low bits are used.
    // R=bits31-24, G=bits23-16, B=bits15-8, A=bits7-0. Hash loop reads all 4 channels.
    const fsSourceInt = `#version 300 es\n      precision highp int;\n      precision highp float;\n      uniform int uSeedInt;\n      out vec4 fragColor;\n      void main() {\n        int px = int(gl_FragCoord.x);\n        int py = int(gl_FragCoord.y);\n        int x = (px * 1000003) ^ (py * 7919) ^ uSeedInt;\n        x |= 1;\n        for (int i = 0; i < ${shaderIterations}; i++) {\n          x ^= x << 13;\n          x ^= x >> 17;\n          x ^= x << 5;\n        }\n        fragColor = vec4(\n          float((x >> 24) & 255) / 255.0,\n          float((x >> 16) & 255) / 255.0,\n          float((x >>  8) & 255) / 255.0,\n          float( x        & 255) / 255.0);\n      }\n    `;

    // Float shader fallback (WebGL1): original algorithm, timing-only verification.
    const fsSourceFloat = `\n      precision highp float;\n      uniform float uSeed;\n      void main() {\n        vec4 c = vec4(gl_FragCoord.xy / ${size}.0, uSeed, 1.0 - uSeed);\n        for (int i = 0; i < ${shaderIterations}; i++) {\n          c.x = c.x * c.y + c.z * 0.00013;\n          c.y = c.y * c.z + c.w * 0.00017;\n          c.z = c.z * c.w + c.x * 0.00019;\n          c.w = c.w * c.x + c.y * 0.00023;\n        }\n        gl_FragColor = c;\n      }\n    `;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const err = gl.getShaderInfoLog(sh);
        console.error('[runGpuProbe] Shader compile failed:', err, src);
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, useIntShader ? fsSourceInt : fsSourceFloat);
    if (!vs || !fs) {
      console.error('[runGpuProbe] Shader compile returned null');
      return null;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const err = gl.getProgramInfoLog(prog);
      console.error('[runGpuProbe] Program link failed:', err);
      return null;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    // WebGL2: bind an explicit VAO so vertex state is self-contained. On strict
    // ANGLE/D3D11 drivers, a deleted buffer still referenced by the default VAO can
    // silently corrupt subsequent draw calls (same issue noted in runGpuBenchmarkProof).
    let vao = null;
    if (useIntShader) {
      vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
    }
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    if (useIntShader) {
      // Pass seed as signed integer — constrained to [1, 0x7FFFFFFF] at probe issuance.
      gl.uniform1i(gl.getUniformLocation(prog, 'uSeedInt'), seed | 0 || 1);
    } else {
      gl.uniform1f(gl.getUniformLocation(prog, 'uSeed'), (seed >>> 0) / 0xffffffff);
    }
    gl.viewport(0, 0, size, size);

    // Render and force synchronous completion via readPixels.
    const pixels = new Uint8Array(size * size * 4);
    const t0 = performance.now();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels); // blocks until done
    if (gl.finish) gl.finish(); // Force GPU-CPU sync to prevent driver optimization
    const elapsed = performance.now() - t0;

    // Hash: every 4th pixel, all 4 channels (full 32-bit x packed as RGBA) through djb2.
    // Using all channels prevents GPU compiler from dead-eliminating high-bit shader work.
    // This EXACT loop must match computeGpuProbeExpectedHash in backend-benchmark.js.
    let h = 5381;
    let allZero = true;
    for (let i = 0; i < pixels.length; i += 16) {
      if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0 || pixels[i + 3] !== 0) allZero = false;
      h = ((h << 5) + h + pixels[i]) | 0; // R = bits 31–24
      h = ((h << 5) + h + pixels[i + 1]) | 0; // G = bits 23–16
      h = ((h << 5) + h + pixels[i + 2]) | 0; // B = bits 15–8
      h = ((h << 5) + h + pixels[i + 3]) | 0; // A = bits 7–0
    }
    // Clean up GL resources — prevents per-probe leaks on long-running sessions.
    // Matches the cleanup pattern in runGpuBenchmarkProof.
    if (vao) {
      gl.bindVertexArray(null);
      gl.deleteVertexArray(vao);
    }
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteBuffer(buf);

    if (allZero) {
      console.error('[runGpuProbe] All pixels zero after readPixels');
      return null;
    }
    return {
      pixelHash: (h >>> 0).toString(16).padStart(8, '0'),
      elapsedMs: Math.round(elapsed),
      integerShader: useIntShader,
    };
  } catch (err) {
    console.error('[runGpuProbe] Exception:', err);
    return null;
  } finally {
    if (attached && canvas && canvas.parentNode) {
      try {
        canvas.parentNode.removeChild(canvas);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  }
}

// ─── GPU benchmark proof ──────────────────────────────────────────────────────
// Runs a single deterministic integer-shader render keyed by `seed` and returns
// a proof hash that the Node process can independently verify using pure JS
// (computeGpuProbeExpectedHash in backend-benchmark.js — bit-identical to this hash
// because GLSL ES 3.0 `int` is defined two's-complement 32-bit, matching JS |0).
//
// Uses a DOM canvas (not OffscreenCanvas) so Chromium routes rendering through the
// hardware GPU compositor instead of the SwiftShader software rasteriser.
// Requires WebGL2 for the integer shader path; returns null on WebGL1 / no WebGL.
//
// The pixel hash algorithm is IDENTICAL to the hash loop in runGpuProbe — every 4th
// pixel, all 4 RGBA channels (full 32-bit x) fed into a djb2 accumulator — so both use the same verification.
export const GPU_PROOF_SIZE = 128; // 128×128 pixels — fast but sufficient for a unique hash
export const GPU_PROOF_ITERS = 32; // 32 XOR-shift iterations per pixel
export function runGpuBenchmarkProof(seed, size, shaderIterations) {
  let canvas = null;
  let attached = false;
  try {
    canvas = document.createElement('canvas');
    // Size to 512 up front so the post-proof MAD benchmark can use the full viewport
    // without resizing the canvas. Resizing canvas.width/height resets WebGL context
    // state (and causes context loss on some AMD/Intel drivers), which silently
    // discards all shader programs and makes the embedded benchmark return gpuScore=0.
    // The proof render uses gl.viewport(0, 0, size, size) so its hash is unaffected.
    canvas.width = 512;
    canvas.height = 512;
    canvas.style.cssText =
      'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;pointer-events:none;opacity:0.001;';
    try {
      document.body.appendChild(canvas);
      attached = true;
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }

    const gl = canvas.getContext('webgl2');
    if (!gl) return null; // integer shader requires WebGL2 for Node-verifiability

    // Both shaders MUST use the same GLSL ES version.  In WebGL 2, mixing a
    // no-directive (1.00) vertex shader with a '#version 300 es' fragment shader
    // causes the program to fail linking silently.
    const vsSource = `#version 300 es
      in vec2 aPos;
      void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
    `;
    // Integer XOR-shift shader — MUST match computeGpuProbeExpectedHash in backend-benchmark.js.
    const fsSource = `#version 300 es
      precision highp int;
      precision highp float;
      uniform int uSeedInt;
      out vec4 fragColor;
      void main() {
        int px = int(gl_FragCoord.x);
        int py = int(gl_FragCoord.y);
        int x = (px * 1000003) ^ (py * 7919) ^ uSeedInt;
        x |= 1;
        for (int i = 0; i < ${shaderIterations}; i++) {
          x ^= x << 13;
          x ^= x >> 17;
          x ^= x << 5;
        }
        fragColor = vec4(
          float((x >> 24) & 255) / 255.0,
          float((x >> 16) & 255) / 255.0,
          float((x >>  8) & 255) / 255.0,
          float( x        & 255) / 255.0);
      }
    `;

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    if (!vs || !fs) return null;

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(prog, 'uSeedInt'), seed | 0 || 1);
    gl.viewport(0, 0, size, size);

    const pixels = new Uint8Array(size * size * 4);
    const t0 = performance.now();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels); // blocks until done
    const elapsed = performance.now() - t0;

    // Reject all-zero results — render didn't actually execute on the GPU.
    // Check all 4 channels: R holds bits 31–24 which may legitimately be 0 for some seeds.
    let allZero = true;
    for (let i = 0; i < pixels.length; i += 64) {
      if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0 || pixels[i + 3] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) return null;

    // Unbind and delete the proof VAO before proceeding. The active VAO references
    // `buf` which is about to be deleted. On strict ANGLE/D3D11 drivers, keeping a
    // deleted buffer referenced by the active VAO causes all subsequent draw calls
    // to silently fail, making the embedded MAD benchmark produce gpuScore=0.
    gl.bindVertexArray(null);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteBuffer(buf);

    // Hash: every 4th pixel, all 4 channels (full 32-bit x) through djb2 — identical to runGpuProbe.
    let h = 5381;
    for (let i = 0; i < pixels.length; i += 16) {
      h = ((h << 5) + h + pixels[i]) | 0; // R = bits 31–24
      h = ((h << 5) + h + pixels[i + 1]) | 0; // G = bits 23–16
      h = ((h << 5) + h + pixels[i + 2]) | 0; // B = bits 15–8
      h = ((h << 5) + h + pixels[i + 3]) | 0; // A = bits 7–0
    }

    // Float MAD benchmark: run on this same canvas so GPU score is available even
    // when runWebGLBenchmark fails (e.g. OffscreenCanvas or readPixels drain issues).
    // Uses the identical shader and formula as runWebGLBenchmark._bench.
    const BENCH_SIZE = 512;
    let gpuScore = 0;
    let benchError = null;
    try {
      // Canvas is already 512×512 (sized at creation) — only reset the viewport.
      gl.viewport(0, 0, BENCH_SIZE, BENCH_SIZE);
      const vsBSrc = `#version 300 es\nin vec2 aPos;\nvoid main(){gl_Position=vec4(aPos,0.0,1.0);}`;
      const fsBSrc = `#version 300 es\nprecision highp float;\nuniform float uSeed;\nout vec4 fragColor;\nvoid main(){\n  vec4 c=vec4(gl_FragCoord.xy/${BENCH_SIZE}.0,uSeed,1.0-uSeed);\n  for(int i=0;i<256;i++){\n    c.x=c.x*c.y+c.z*0.00013;\n    c.y=c.y*c.z+c.w*0.00017;\n    c.z=c.z*c.w+c.x*0.00019;\n    c.w=c.w*c.x+c.y*0.00023;\n  }\n  fragColor=c;\n}`;
      const cmpB = (type, src) => {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        return gl.getShaderParameter(sh, gl.COMPILE_STATUS) ? sh : (gl.deleteShader(sh), null);
      };
      const vsB = cmpB(gl.VERTEX_SHADER, vsBSrc);
      const fsB = cmpB(gl.FRAGMENT_SHADER, fsBSrc);
      if (vsB && fsB) {
        const progB = gl.createProgram();
        gl.attachShader(progB, vsB);
        gl.attachShader(progB, fsB);
        gl.linkProgram(progB);
        if (gl.getProgramParameter(progB, gl.LINK_STATUS)) {
          gl.useProgram(progB);
          const bufB = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, bufB);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
          const vaoB = gl.createVertexArray();
          gl.bindVertexArray(vaoB);
          const aPosB = gl.getAttribLocation(progB, 'aPos');
          gl.enableVertexAttribArray(aPosB);
          gl.vertexAttribPointer(aPosB, 2, gl.FLOAT, false, 0, 0);
          const uSeedB = gl.getUniformLocation(progB, 'uSeed');
          // Per-frame readPixels sync — same approach as runWebGLBenchmark._bench.
          const SYNC_W = BENCH_SIZE,
            SYNC_H = BENCH_SIZE;
          const syncB = new Uint8Array(SYNC_W * SYNC_H * 4);
          const gpuSyncB = function () {
            gl.readPixels(0, 0, SYNC_W, SYNC_H, gl.RGBA, gl.UNSIGNED_BYTE, syncB);
          };
          // Warmup: 5 frames with per-frame sync
          for (let i = 0; i < 5; i++) {
            gl.uniform1f(uSeedB, i * 0.001);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gpuSyncB();
          }
          // Adaptive per-frame calibration: accumulate >= 20 ms, cap 200 frames
          let calibFrames = 0;
          const tCalib = performance.now();
          do {
            gl.uniform1f(uSeedB, 0.5 + calibFrames * 0.001);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            gpuSyncB();
            calibFrames++;
          } while (performance.now() - tCalib < 20 && calibFrames < 200);
          const calibMs = performance.now() - tCalib;
          if (calibMs < 1.0 && calibFrames >= 200) {
            benchError = 'GPU-E3p: proof-bench readPixels not stalling (' + calibMs.toFixed(2) + 'ms / 200 frames)';
          } else {
            const msPerFrame = Math.max(0.01, calibMs / calibFrames);
            const benchFrames = Math.min(1000, Math.max(5, Math.round(1000 / msPerFrame)));
            const tB = performance.now();
            for (let i = 0; i < benchFrames; i++) {
              gl.uniform1f(uSeedB, i * 0.001);
              gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
              gpuSyncB();
            }
            const benchMs = Math.max(1, performance.now() - tB);
            gpuScore = Math.round((benchFrames * BENCH_SIZE * BENCH_SIZE * 1024) / benchMs);
          }
          gl.bindVertexArray(null);
          gl.deleteVertexArray(vaoB);
          gl.deleteBuffer(bufB);
          gl.deleteProgram(progB);
        }
        gl.deleteShader(vsB);
        gl.deleteShader(fsB);
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
    }

    return { proofHash: (h >>> 0).toString(16).padStart(8, '0'), elapsedMs: Math.round(elapsed), gpuScore, benchError };
  } catch (e) {
    console.warn('[GPU proof] failed:', e && e.message);
    return null;
  } finally {
    if (attached && canvas && canvas.parentNode) {
      try {
        canvas.parentNode.removeChild(canvas);
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Miner] Caught:', String(_.message || _).slice(0, 80));
      }
    }
  }
}

// ─── GPU VRAM / memory-type lookup table ─────────────────────────────────────
// Returns { vramGb, memType } for a GPU model string.
// Used as fallback when systeminformation doesn't populate vram/memoryType
// (e.g. when hardware source is 'electron' or drivers don't expose it).
export function getGpuVramInfo(model) {
  if (!model) return { vramGb: 0, memType: '' };
  const m = model;
  // NVIDIA RTX 40-series
  if (/RTX\s*4090/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*4080\s*Super/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4080/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Ti\s*Super/i.test(m)) return { vramGb: 16, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Ti/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4070\s*Super/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4070/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*4060\s*Ti/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RTX\s*4060/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*4050/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  // NVIDIA RTX 30-series
  if (/RTX\s*3090\s*Ti/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*3090/i.test(m)) return { vramGb: 24, memType: 'GDDR6X' };
  if (/RTX\s*3080\s*Ti/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*3080\s*12/i.test(m)) return { vramGb: 12, memType: 'GDDR6X' };
  if (/RTX\s*3080/i.test(m)) return { vramGb: 10, memType: 'GDDR6X' };
  if (/RTX\s*3070\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR6X' };
  if (/RTX\s*3070/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*3060\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*3060/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RTX\s*3050/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // NVIDIA RTX 20-series
  if (/RTX\s*2080\s*Ti/i.test(m)) return { vramGb: 11, memType: 'GDDR6' };
  if (/RTX\s*2080\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2080/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2070\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2070/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2060\s*Super/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RTX\s*2060/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  // NVIDIA GTX 16-series
  if (/GTX\s*1660\s*Ti/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/GTX\s*1660\s*Super/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/GTX\s*1660/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1650\s*Super/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  if (/GTX\s*1650/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  // NVIDIA GTX 10-series
  if (/GTX\s*1080\s*Ti/i.test(m)) return { vramGb: 11, memType: 'GDDR5X' };
  if (/GTX\s*1080/i.test(m)) return { vramGb: 8, memType: 'GDDR5X' };
  if (/GTX\s*1070\s*Ti/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/GTX\s*1070/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/GTX\s*1060\s*6/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1060\s*3/i.test(m)) return { vramGb: 3, memType: 'GDDR5' };
  if (/GTX\s*1060/i.test(m)) return { vramGb: 6, memType: 'GDDR5' };
  if (/GTX\s*1050\s*Ti/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  if (/GTX\s*1050/i.test(m)) return { vramGb: 2, memType: 'GDDR5' };
  // AMD RX 9000-series (RDNA 4)
  if (/RX\s*9070\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*9070/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  // AMD RX 7000-series (RDNA 3)
  if (/RX\s*7900\s*XTX/i.test(m)) return { vramGb: 24, memType: 'GDDR6' };
  if (/RX\s*7900\s*GRE/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7900\s*XT/i.test(m)) return { vramGb: 20, memType: 'GDDR6' };
  if (/RX\s*7800\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7700\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*7600\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*7600/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*7500\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // AMD RX 6000-series (RDNA 2)
  if (/RX\s*6950\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6900\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6800\s*XT/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6800/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/RX\s*6750\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*6700\s*XT/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/RX\s*6700/i.test(m)) return { vramGb: 10, memType: 'GDDR6' };
  if (/RX\s*6650\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6600\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6600/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*6500\s*XT/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  if (/RX\s*6400/i.test(m)) return { vramGb: 4, memType: 'GDDR6' };
  // AMD RX 5000-series (RDNA 1)
  if (/RX\s*5700\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*5700/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/RX\s*5600\s*XT/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/RX\s*5500\s*XT/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  // AMD RX 500/400-series (Polaris)
  if (/RX\s*590/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*580/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*570/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  if (/RX\s*480/i.test(m)) return { vramGb: 8, memType: 'GDDR5' };
  if (/RX\s*470/i.test(m)) return { vramGb: 4, memType: 'GDDR5' };
  // AMD Vega
  if (/Vega\s*64/i.test(m)) return { vramGb: 8, memType: 'HBM2' };
  if (/Vega\s*56/i.test(m)) return { vramGb: 8, memType: 'HBM2' };
  if (/Radeon\s*VII/i.test(m)) return { vramGb: 16, memType: 'HBM2' };
  // Intel Arc
  if (/Arc\s*A770/i.test(m)) return { vramGb: 16, memType: 'GDDR6' };
  if (/Arc\s*A750/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/Arc\s*A580/i.test(m)) return { vramGb: 8, memType: 'GDDR6' };
  if (/Arc\s*A380/i.test(m)) return { vramGb: 6, memType: 'GDDR6' };
  if (/Arc\s*B580/i.test(m)) return { vramGb: 12, memType: 'GDDR6' };
  if (/Arc\s*B570/i.test(m)) return { vramGb: 10, memType: 'GDDR6' };
  return { vramGb: 0, memType: '' };
}

// ─── Expected WebGL score table ───────────────────────────────────────────────
// Returns expected WebGL ALU benchmark score (ops/ms) for a GPU model string.
// Values are tuned to the 256×256 / 128-MAD-iter shader above.
// Returns 0 for unknown GPUs (validation skipped).
export function getExpectedGpuScore(gpuModel) {
  if (!gpuModel) return 0;
  const m = gpuModel;

  // ── NVIDIA RTX 40-series ──────────────────────────────────────────────────────
  // All values calibrated for per-frame readPixels benchmark (×41 vs old fenceSync table).
  if (/RTX\s*4090/i.test(m)) return 1_150_000_000;
  if (/RTX\s*4080\s*Super/i.test(m)) return 900_000_000;
  if (/RTX\s*4080/i.test(m)) return 820_000_000;
  if (/RTX\s*4070\s*Ti\s*Super/i.test(m)) return 700_000_000;
  if (/RTX\s*4070\s*Ti/i.test(m)) return 655_000_000;
  if (/RTX\s*4070\s*Super/i.test(m)) return 595_000_000;
  if (/RTX\s*4070/i.test(m)) return 533_000_000;
  if (/RTX\s*4060\s*Ti/i.test(m)) return 430_000_000;
  if (/RTX\s*4060/i.test(m)) return 349_000_000;
  if (/RTX\s*4050/i.test(m)) return 287_000_000;

  // ── NVIDIA RTX 30-series ──────────────────────────────────────────────────────
  if (/RTX\s*3090\s*Ti/i.test(m)) return 738_000_000;
  if (/RTX\s*3090/i.test(m)) return 677_000_000;
  if (/RTX\s*3080\s*Ti/i.test(m)) return 656_000_000;
  if (/RTX\s*3080\s*12/i.test(m)) return 595_000_000;
  if (/RTX\s*3080/i.test(m)) return 554_000_000;
  if (/RTX\s*3070\s*Ti/i.test(m)) return 472_000_000;
  if (/RTX\s*3070/i.test(m)) return 451_000_000;
  if (/RTX\s*3060\s*Ti/i.test(m)) return 369_000_000;
  if (/RTX\s*3060/i.test(m)) return 308_000_000;
  if (/RTX\s*3050/i.test(m)) return 205_000_000;

  // ── NVIDIA RTX 20-series ──────────────────────────────────────────────────────
  if (/RTX\s*2080\s*Ti/i.test(m)) return 472_000_000;
  if (/RTX\s*2080\s*Super/i.test(m)) return 410_000_000;
  if (/RTX\s*2080/i.test(m)) return 390_000_000;
  if (/RTX\s*2070\s*Super/i.test(m)) return 369_000_000;
  if (/RTX\s*2070/i.test(m)) return 328_000_000;
  if (/RTX\s*2060\s*Super/i.test(m)) return 308_000_000;
  if (/RTX\s*2060/i.test(m)) return 267_000_000;

  // ── NVIDIA GTX 16-series ──────────────────────────────────────────────────────
  if (/GTX\s*1660\s*Ti/i.test(m)) return 226_000_000;
  if (/GTX\s*1660\s*Super/i.test(m)) return 205_000_000;
  if (/GTX\s*1660/i.test(m)) return 185_000_000;
  if (/GTX\s*1650\s*Super/i.test(m)) return 164_000_000;
  if (/GTX\s*1650/i.test(m)) return 123_000_000;

  // ── NVIDIA GTX 10-series ──────────────────────────────────────────────────────
  if (/GTX\s*1080\s*Ti/i.test(m)) return 308_000_000;
  if (/GTX\s*1080/i.test(m)) return 267_000_000;
  if (/GTX\s*1070\s*Ti/i.test(m)) return 226_000_000;
  if (/GTX\s*1070/i.test(m)) return 205_000_000;
  if (/GTX\s*1060\s*6/i.test(m)) return 144_000_000;
  if (/GTX\s*1060/i.test(m)) return 123_000_000;
  if (/GTX\s*1050\s*Ti/i.test(m)) return 90_000_000;
  if (/GTX\s*1050/i.test(m)) return 74_000_000;

  // ── NVIDIA Quadro / Professional ─────────────────────────────────────────────
  if (/RTX\s*[Aa]\s*6000/i.test(m)) return 738_000_000;
  if (/RTX\s*[Aa]\s*5000/i.test(m)) return 574_000_000;
  if (/RTX\s*[Aa]\s*4000/i.test(m)) return 369_000_000;
  if (/RTX\s*[Aa]\s*2000/i.test(m)) return 205_000_000;
  if (/Quadro\s*P[45][0-9]{3}/i.test(m)) return 205_000_000;
  if (/Quadro\s*P[12][0-9]{3}/i.test(m)) return 103_000_000;

  // ── AMD Radeon RX 7000-series ─────────────────────────────────────────────────
  if (/RX\s*7900\s*XTX/i.test(m)) return 902_000_000;
  if (/RX\s*7900\s*XT/i.test(m)) return 779_000_000;
  if (/RX\s*7800\s*XT/i.test(m)) return 574_000_000;
  if (/RX\s*7700\s*XT/i.test(m)) return 492_000_000;
  if (/RX\s*7600/i.test(m)) return 349_000_000;
  if (/RX\s*7500\s*XT/i.test(m)) return 246_000_000;

  // ── AMD Radeon RX 6000-series ─────────────────────────────────────────────────
  if (/RX\s*6950\s*XT/i.test(m)) return 759_000_000;
  if (/RX\s*6900\s*XT/i.test(m)) return 718_000_000;
  if (/RX\s*6800\s*XT/i.test(m)) return 677_000_000;
  if (/RX\s*6800/i.test(m)) return 615_000_000;
  if (/RX\s*6750\s*XT/i.test(m)) return 533_000_000;
  if (/RX\s*6700\s*XT/i.test(m)) return 492_000_000;
  if (/RX\s*6700/i.test(m)) return 451_000_000;
  if (/RX\s*6650\s*XT/i.test(m)) return 390_000_000;
  if (/RX\s*6600\s*XT/i.test(m)) return 369_000_000;
  if (/RX\s*6600/i.test(m)) return 328_000_000;
  if (/RX\s*6500\s*XT/i.test(m)) return 185_000_000;
  if (/RX\s*6400/i.test(m)) return 123_000_000;

  // ── AMD Radeon RX 5000-series ─────────────────────────────────────────────────
  if (/RX\s*5700\s*XT/i.test(m)) return 410_000_000;
  if (/RX\s*5700/i.test(m)) return 369_000_000;
  if (/RX\s*5600\s*XT/i.test(m)) return 308_000_000;
  if (/RX\s*5500\s*XT/i.test(m)) return 205_000_000;

  // ── AMD Radeon Vega / RX 400–580 ─────────────────────────────────────────────
  if (/Vega\s*64/i.test(m)) return 328_000_000;
  if (/Vega\s*56/i.test(m)) return 287_000_000;
  if (/RX\s*590/i.test(m)) return 205_000_000;
  if (/RX\s*580/i.test(m)) return 185_000_000;
  if (/RX\s*570/i.test(m)) return 164_000_000;
  if (/RX\s*480/i.test(m)) return 185_000_000;
  if (/RX\s*470/i.test(m)) return 164_000_000;

  // ── Intel Arc ─────────────────────────────────────────────────────────────────
  if (/Arc\s*A770/i.test(m)) return 451_000_000;
  if (/Arc\s*A750/i.test(m)) return 390_000_000;
  if (/Arc\s*A580/i.test(m)) return 308_000_000;
  if (/Arc\s*A380/i.test(m)) return 164_000_000;
  if (/Arc\s*A310/i.test(m)) return 103_000_000;

  // ── Intel Iris Xe (discrete / Evo) ───────────────────────────────────────────
  if (/Iris\s*Xe\s*Max/i.test(m)) return 74_000_000;
  if (/Iris\s*Xe/i.test(m)) return 37_000_000;

  // ── Intel UHD / HD integrated ────────────────────────────────────────────────
  if (/UHD\s*Graphics\s*770/i.test(m)) return 21_000_000;
  if (/UHD\s*Graphics\s*7[0-9]{2}/i.test(m)) return 20_000_000;
  if (/UHD\s*Graphics\s*6[0-9]{2}/i.test(m)) return 16_000_000;
  if (/UHD\s*Graphics/i.test(m)) return 16_000_000;
  if (/HD\s*Graphics\s*[6-9][3-9]0/i.test(m)) return 8_000_000;
  if (/HD\s*Graphics/i.test(m)) return 6_000_000;

  // ── AMD Radeon Graphics (integrated RDNA2/3) ──────────────────────────────────
  if (/Radeon\s*Graphics/i.test(m)) return 29_000_000; // Ryzen iGPU generic

  // ── Apple (Metal — GPU perf via system-reported model) ───────────────────────
  if (/M4\s*(Pro|Max|Ultra)/i.test(m)) return 369_000_000;
  if (/\bM4\b/i.test(m)) return 205_000_000;
  if (/M3\s*(Pro|Max|Ultra)/i.test(m)) return 287_000_000;
  if (/\bM3\b/i.test(m)) return 164_000_000;
  if (/M2\s*(Pro|Max|Ultra)/i.test(m)) return 226_000_000;
  if (/\bM2\b/i.test(m)) return 131_000_000;
  if (/M1\s*(Pro|Max|Ultra)/i.test(m)) return 164_000_000;
  if (/\bM1\b/i.test(m)) return 103_000_000;

  // Unknown GPU: conservative mid-range fallback (≈ GTX 1060 / RX 580 class).
  return 144_000_000;
}

// Returns the expected ops/s for runCpuSpeedBenchmark (fixed-N imul+XOR loop) for a
// given CPU model string.  Values are derived from: boostClockGHz × archFactor × 1e8.
// Used for (1) hardware-claim validation and (2) TDP calibration from measured throughput.
// Returns 0 for unrecognised CPUs (validation skipped).
export function getExpectedCpuSpeedOps(cpuModel) {
  if (!cpuModel) return 0;
  const m = cpuModel;

  // ── Intel 14th / 13th Gen Desktop (Raptor Lake / Refresh) ────────────────────
  if (/Core.*i9-1[34]900KS/i.test(m)) return 620_000_000;
  if (/Core.*i9-1[34]900KF?/i.test(m)) return 600_000_000;
  if (/Core.*i9-1[34]900[FT]?/i.test(m)) return 575_000_000;
  if (/Core.*i7-1[34]700KF?/i.test(m)) return 560_000_000;
  if (/Core.*i7-1[34]700[FT]?/i.test(m)) return 540_000_000;
  if (/Core.*i5-1[34]600KF?/i.test(m)) return 530_000_000;
  if (/Core.*i5-1[34][5-9]0{2}[FT]?/i.test(m)) return 510_000_000;
  if (/Core.*i5-1[34]400[FT]?/i.test(m)) return 480_000_000;
  if (/Core.*i3-1[34]1[0-9]0[FT]?/i.test(m)) return 460_000_000;
  if (/Core.*i3-133[0-9]0/i.test(m)) return 460_000_000;

  // ── Intel 12th Gen Desktop (Alder Lake P-core) ───────────────────────────────
  if (/Core.*i9-12900KS/i.test(m)) return 520_000_000;
  if (/Core.*i9-12900KF?/i.test(m)) return 500_000_000;
  if (/Core.*i9-12900[FT]?/i.test(m)) return 490_000_000;
  if (/Core.*i7-12700KF?/i.test(m)) return 490_000_000;
  if (/Core.*i7-12700[FT]?/i.test(m)) return 470_000_000;
  if (/Core.*i5-12600KF?/i.test(m)) return 470_000_000;
  if (/Core.*i5-12[56]0{2}[FT]?/i.test(m)) return 450_000_000;
  if (/Core.*i5-124[024]0[FT]?/i.test(m)) return 430_000_000;
  if (/Core.*i3-12[13][02][015][FT]?/i.test(m)) return 420_000_000;

  // ── Intel 11th Gen Desktop (Rocket Lake) ─────────────────────────────────────
  if (/Core.*i9-11900KF?/i.test(m)) return 490_000_000;
  if (/Core.*i9-11900[FT]?/i.test(m)) return 480_000_000;
  if (/Core.*i7-11700KF?/i.test(m)) return 480_000_000;
  if (/Core.*i7-11700[FT]?/i.test(m)) return 460_000_000;
  if (/Core.*i5-11[456][0-9]0[FKT]?[F]?/i.test(m)) return 440_000_000;

  // ── Intel 10th Gen Desktop (Comet Lake) ──────────────────────────────────────
  if (/Core.*i9-10900KF?S?/i.test(m)) return 470_000_000;
  if (/Core.*i9-10[89][0-9]0[FKST]?/i.test(m)) return 460_000_000;
  if (/Core.*i7-10700KF?/i.test(m)) return 450_000_000;
  if (/Core.*i7-10700[FT]?/i.test(m)) return 420_000_000;
  if (/Core.*i5-10[456][0-9]0[FKST]?/i.test(m)) return 400_000_000;
  if (/Core.*i3-10[1-9][0-9]0[FT]?/i.test(m)) return 390_000_000;

  // ── Intel 9th / 8th Gen Desktop (Coffee Lake / Refresh) ─────────────────────
  if (/Core.*i9-9900KF?S?/i.test(m)) return 430_000_000;
  if (/Core.*i9-9900[FT]?/i.test(m)) return 430_000_000;
  if (/Core.*i7-9700KF?/i.test(m)) return 420_000_000;
  if (/Core.*i7-9700[FT]?/i.test(m)) return 400_000_000;
  if (/Core.*i5-9[456][0-9]0[FKT]?/i.test(m)) return 380_000_000;
  if (/Core.*i3-9[1-9][0-9]0[FKT]?/i.test(m)) return 360_000_000;
  if (/Core.*i7-8700KF?/i.test(m)) return 400_000_000;
  if (/Core.*i7-8700[FT]?/i.test(m)) return 385_000_000;
  if (/Core.*i5-8[456][0-9]0[FKT]?/i.test(m)) return 360_000_000;
  if (/Core.*i3-8[1-4][0-9]0[FKT]?/i.test(m)) return 340_000_000;

  // ── Intel 7th Gen Desktop (Kaby Lake) ────────────────────────────────────────
  if (/Core.*i7-7700KF?/i.test(m)) return 375_000_000;
  if (/Core.*i7-7700[T]?/i.test(m)) return 350_000_000;
  if (/Core.*i5-7[456][0-9]0[KT]?/i.test(m)) return 335_000_000;
  if (/Core.*i3-73[0-9]0[KT]?/i.test(m)) return 330_000_000;
  if (/Core.*i3-71[0-9]0[T]?/i.test(m)) return 320_000_000;

  // ── Intel 6th Gen Desktop (Skylake) ──────────────────────────────────────────
  if (/Core.*i7-6700KF?/i.test(m)) return 340_000_000;
  if (/Core.*i7-6700[T]?/i.test(m)) return 320_000_000;
  if (/Core.*i5-6[456][0-9]0[KT]?/i.test(m)) return 310_000_000;
  if (/Core.*i3-6[1-3][0-9]0[T]?/i.test(m)) return 300_000_000;

  // ── Intel 5th Gen Desktop (Broadwell) ────────────────────────────────────────
  if (/Core.*i[57]-5[67][0-9]5C/i.test(m)) return 285_000_000;

  // ── Intel 4th Gen Desktop (Haswell) ──────────────────────────────────────────
  if (/Core.*i7-4790K/i.test(m)) return 330_000_000;
  if (/Core.*i7-47[0-9]0[T]?/i.test(m)) return 300_000_000;
  if (/Core.*i5-4[5-9][0-9]0[KT]?/i.test(m)) return 295_000_000;
  if (/Core.*i5-4[34][0-9]0[T]?/i.test(m)) return 270_000_000;
  if (/Core.*i3-4[1-4][0-9]0[T]?/i.test(m)) return 265_000_000;

  // ── Intel 3rd Gen Desktop (Ivy Bridge) ───────────────────────────────────────
  if (/Core.*i7-377[0-9]K?/i.test(m)) return 260_000_000;
  if (/Core.*i5-35[2-7]0[KT]?/i.test(m)) return 250_000_000;
  if (/Core.*i5-34[3-7]0[T]?/i.test(m)) return 240_000_000;
  if (/Core.*i3-3[1-3][0-9]0/i.test(m)) return 220_000_000;

  // ── Intel 2nd Gen Desktop (Sandy Bridge) ─────────────────────────────────────
  if (/Core.*i7-2[6-7]00K?/i.test(m)) return 240_000_000;
  if (/Core.*i7-2[5-9][0-9]0[S]?/i.test(m)) return 230_000_000;
  if (/Core.*i5-2[3-6][0-9]0K?/i.test(m)) return 220_000_000;
  if (/Core.*i3-2[1-3][0-9]0/i.test(m)) return 200_000_000;

  // ── Intel Core Ultra 200S (Arrow Lake Desktop) ───────────────────────────────
  if (/Core.*Ultra 9 2[0-9]{2}K/i.test(m)) return 560_000_000;
  if (/Core.*Ultra 7 2[0-9]{2}KF?/i.test(m)) return 540_000_000;
  if (/Core.*Ultra 5 2[0-9]{2}KF?/i.test(m)) return 510_000_000;

  // ── Intel Core Ultra 100H/U (Meteor Lake Mobile) ─────────────────────────────
  if (/Core.*Ultra 9 1[0-9]{2}H/i.test(m)) return 430_000_000;
  if (/Core.*Ultra 7 1[0-9]{2}H/i.test(m)) return 415_000_000;
  if (/Core.*Ultra 5 1[0-9]{2}H/i.test(m)) return 390_000_000;
  if (/Core.*Ultra [579] 1[0-9]{2}U/i.test(m)) return 350_000_000;

  // ── Intel 13th Gen Mobile (HX / H / U) ───────────────────────────────────────
  if (/Core.*i9-139[0-9]0HX/i.test(m)) return 520_000_000;
  if (/Core.*i9-139[0-9]0H/i.test(m)) return 490_000_000;
  if (/Core.*i7-137[0-9]0HX/i.test(m)) return 480_000_000;
  if (/Core.*i7-137[0-9]0H/i.test(m)) return 460_000_000;
  if (/Core.*i5-13[3-6][0-9]0H/i.test(m)) return 440_000_000;
  if (/Core.*i[37]-13[3-7][0-9]U/i.test(m)) return 420_000_000;
  if (/Core.*i[35]-13[1-5][0-9]U/i.test(m)) return 390_000_000;

  // ── Intel 12th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i9-129[0-9]0H[KX]?/i.test(m)) return 450_000_000;
  if (/Core.*i7-127[0-9]0H/i.test(m)) return 420_000_000;
  if (/Core.*i5-12[45][0-9]0H/i.test(m)) return 400_000_000;
  if (/Core.*i7-12[78][0-9]P/i.test(m)) return 390_000_000;
  if (/Core.*i[35]-12[34][0-9]P/i.test(m)) return 360_000_000;
  if (/Core.*i[37]-12[25][0-9]U/i.test(m)) return 380_000_000;
  if (/Core.*i5-12[23][0-9]U/i.test(m)) return 350_000_000;

  // ── Intel 11th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i9-11980HK/i.test(m)) return 420_000_000;
  if (/Core.*i9-119[0-9]0H/i.test(m)) return 390_000_000;
  if (/Core.*i7-118[0-9]0H/i.test(m)) return 380_000_000;
  if (/Core.*i5-115[0-9]0H/i.test(m)) return 360_000_000;
  if (/Core.*i7-118[56]G[47]/i.test(m)) return 350_000_000;
  if (/Core.*i7-116[56]G7/i.test(m)) return 340_000_000;
  if (/Core.*i5-1135G7/i.test(m)) return 320_000_000;
  if (/Core.*i3-11[12][0-9]G[47]/i.test(m)) return 290_000_000;

  // ── Intel 10th Gen Mobile ─────────────────────────────────────────────────────
  if (/Core.*i7-108[0-9]5H/i.test(m)) return 380_000_000;
  if (/Core.*i7-107[0-9]0H/i.test(m)) return 360_000_000;
  if (/Core.*i5-103[0-9]0H/i.test(m)) return 340_000_000;
  if (/Core.*i7-1065G7/i.test(m)) return 320_000_000; // Ice Lake
  if (/Core.*i5-1035G[14]/i.test(m)) return 290_000_000;
  if (/Core.*i3-1005G1/i.test(m)) return 260_000_000;

  // ── Intel Xeon ────────────────────────────────────────────────────────────────
  if (/Xeon.*w9-35[0-9]{2}X/i.test(m)) return 490_000_000;
  if (/Xeon.*w7-3[0-9]{3}X/i.test(m)) return 470_000_000;
  if (/Xeon.*w7-2[0-9]{3}X/i.test(m)) return 450_000_000;
  if (/Xeon.*W-3175X/i.test(m)) return 390_000_000;
  if (/Xeon.*W-2[2-9][0-9]{2}/i.test(m)) return 410_000_000;
  if (/Xeon.*Gold 6[12][0-9]{2}R?/i.test(m)) return 360_000_000;
  if (/Xeon.*Silver 4[23][0-9]{2}/i.test(m)) return 330_000_000;
  if (/Xeon.*E5-2[6-9][0-9]{2}/i.test(m)) return 260_000_000;

  // ── AMD Ryzen 9000 (Zen 5) ────────────────────────────────────────────────────
  if (/Ryzen 9 9950X/i.test(m)) return 580_000_000;
  if (/Ryzen 9 9900X/i.test(m)) return 570_000_000;
  if (/Ryzen 7 9800X3D/i.test(m)) return 520_000_000;
  if (/Ryzen 7 9700X/i.test(m)) return 560_000_000;
  if (/Ryzen 5 9600X/i.test(m)) return 540_000_000;
  if (/Ryzen 5 9600/i.test(m)) return 510_000_000;

  // ── AMD Ryzen 7000 (Zen 4) ────────────────────────────────────────────────────
  if (/Ryzen 9 7950X3D/i.test(m)) return 540_000_000;
  if (/Ryzen 9 7950X/i.test(m)) return 560_000_000;
  if (/Ryzen 9 7900X3D/i.test(m)) return 530_000_000;
  if (/Ryzen 9 7900X/i.test(m)) return 550_000_000;
  if (/Ryzen 9 7900/i.test(m)) return 530_000_000;
  if (/Ryzen 7 7800X3D/i.test(m)) return 490_000_000;
  if (/Ryzen 7 7700X/i.test(m)) return 530_000_000;
  if (/Ryzen 7 7700/i.test(m)) return 520_000_000;
  if (/Ryzen 5 7600X/i.test(m)) return 520_000_000;
  if (/Ryzen 5 7600/i.test(m)) return 500_000_000;
  if (/Ryzen 5 7500F/i.test(m)) return 490_000_000;

  // ── AMD Ryzen 5000 (Zen 3) ────────────────────────────────────────────────────
  if (/Ryzen 9 5950X/i.test(m)) return 470_000_000;
  if (/Ryzen 9 5900X/i.test(m)) return 460_000_000;
  if (/Ryzen 9 5900HX/i.test(m)) return 420_000_000;
  if (/Ryzen 9 5900/i.test(m)) return 450_000_000;
  if (/Ryzen 7 5800X3D/i.test(m)) return 430_000_000;
  if (/Ryzen 7 5800X/i.test(m)) return 450_000_000;
  if (/Ryzen 7 5800H/i.test(m)) return 410_000_000;
  if (/Ryzen 7 5800/i.test(m)) return 440_000_000;
  if (/Ryzen 7 5700[GX]?/i.test(m)) return 440_000_000;
  if (/Ryzen 5 5600X/i.test(m)) return 440_000_000;
  if (/Ryzen 5 5600H/i.test(m)) return 400_000_000;
  if (/Ryzen 5 5600[G]?/i.test(m)) return 420_000_000;
  if (/Ryzen 5 5500/i.test(m)) return 400_000_000;
  if (/Ryzen 3 5[13][0-9]{2}G?/i.test(m)) return 385_000_000;

  // ── AMD Ryzen 3000 (Zen 2) ────────────────────────────────────────────────────
  if (/Ryzen 9 3950X/i.test(m)) return 420_000_000;
  if (/Ryzen 9 3900X?T?/i.test(m)) return 415_000_000;
  if (/Ryzen 7 3800X?T?/i.test(m)) return 410_000_000;
  if (/Ryzen 7 3700X/i.test(m)) return 400_000_000;
  if (/Ryzen 5 3600X?T?/i.test(m)) return 400_000_000;
  if (/Ryzen 5 3600/i.test(m)) return 380_000_000;
  if (/Ryzen 5 3500X?/i.test(m)) return 360_000_000;
  if (/Ryzen 3 3[13][0-9]{2}X?/i.test(m)) return 370_000_000;

  // ── AMD Ryzen 2000 (Zen+) ─────────────────────────────────────────────────────
  if (/Ryzen 7 2700X/i.test(m)) return 330_000_000;
  if (/Ryzen 7 2700/i.test(m)) return 310_000_000;
  if (/Ryzen 5 2600X/i.test(m)) return 320_000_000;
  if (/Ryzen 5 2600/i.test(m)) return 300_000_000;
  if (/Ryzen 3 2[23][0-9]{2}[GX]?/i.test(m)) return 280_000_000;

  // ── AMD Threadripper ──────────────────────────────────────────────────────────
  if (/Threadripper PRO 79[0-9]{2}W/i.test(m)) return 490_000_000;
  if (/Threadripper PRO 59[0-9]{2}W/i.test(m)) return 440_000_000;
  if (/Threadripper PRO 59[0-9]{2}W/i.test(m)) return 440_000_000;
  if (/Threadripper 39[0-9]{2}X/i.test(m)) return 400_000_000;
  if (/Threadripper 29[0-9]{2}[WX]/i.test(m)) return 310_000_000;

  // ── AMD EPYC ──────────────────────────────────────────────────────────────────
  if (/EPYC 9[5-9][0-9]{2}/i.test(m)) return 390_000_000; // Zen4
  if (/EPYC 9[1-4][0-9]{2}/i.test(m)) return 375_000_000;
  if (/EPYC 7[6-9][0-9]{2}/i.test(m)) return 310_000_000; // Zen3
  if (/EPYC 7[3-5][0-9]{2}/i.test(m)) return 280_000_000; // Zen2
  if (/EPYC 7[0-2][0-9]{2}/i.test(m)) return 260_000_000;

  // ── Apple Silicon ─────────────────────────────────────────────────────────────
  if (/M4 (Pro|Max|Ultra)/i.test(m)) return 620_000_000;
  if (/\bM4\b/i.test(m)) return 590_000_000;
  if (/M3 Max/i.test(m)) return 560_000_000;
  if (/M3 (Pro|Ultra)/i.test(m)) return 550_000_000;
  if (/\bM3\b/i.test(m)) return 540_000_000;
  if (/M2 (Pro|Max|Ultra)/i.test(m)) return 500_000_000;
  if (/\bM2\b/i.test(m)) return 480_000_000;
  if (/M1 (Pro|Max|Ultra)/i.test(m)) return 440_000_000;
  if (/\bM1\b/i.test(m)) return 420_000_000;

  return 0; // unknown — skip validation
}
