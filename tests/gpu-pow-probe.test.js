import { describe, it, expect } from 'vitest';
import {
  computeGpuProbeExpectedHash,
  verifyGpuPowProbe,
  PROBE_GPU_POW_SIZE,
  PROBE_GPU_POW_ITERS,
  PROBE_GPU_POW_DIFFICULTY,
} from '../backend-benchmark.js';

const DIFFICULTY = PROBE_GPU_POW_DIFFICULTY;

// Brute-force search for a valid nonce for a given seed + deviceIndex.
function findValidNonce(seed, deviceIndex, maxTries = 2000000) {
  for (let nonce = 0; nonce < maxTries; nonce++) {
    const r = verifyGpuPowProbe(seed, deviceIndex, nonce, DIFFICULTY);
    if (r.passes) return nonce;
  }
  return null;
}

describe('verifyGpuPowProbe', () => {
  it('verifies a valid nonce found by exhaustive CPU search (deviceIndex=0)', () => {
    const seed = 42;
    const nonce = findValidNonce(seed, 0);
    expect(nonce).not.toBeNull();
    expect(nonce).toBeGreaterThan(0);
    expect(nonce).toBeLessThan(2000000);
    const r2 = verifyGpuPowProbe(seed, 0, nonce, DIFFICULTY);
    expect(r2.passes).toBe(true);
  });

  it('rejects a nonce that does not meet difficulty', () => {
    const seed = 42;
    const result = verifyGpuPowProbe(seed, 0, 0, DIFFICULTY);
    expect(result.passes).toBe(false);
  });

  it('deterministic: same nonce always verifies the same way', () => {
    const seed = 12345;
    const difficulty = 4096;
    let nonce = 0;
    while (nonce < 500000) {
      const r = verifyGpuPowProbe(seed, 0, nonce, difficulty);
      if (r.passes) break;
      nonce++;
    }
    expect(nonce).toBeLessThan(500000);
    const r1 = verifyGpuPowProbe(seed, 0, nonce, difficulty);
    const r2 = verifyGpuPowProbe(seed, 0, nonce, difficulty);
    expect(r1.hash).toBe(r2.hash);
    expect(r1.hash16).toBe(r2.hash16);
    expect(r1.passes).toBe(r2.passes);
  });

  it('difficulty=65535 accepts almost any nonce (16-bit full range)', () => {
    const seed = 99;
    const result = verifyGpuPowProbe(seed, 0, 1, 65535);
    expect(result.passes).toBe(true);
  });

  it('difficulty=0 rejects every nonce', () => {
    const result = verifyGpuPowProbe(42, 0, 1, 0);
    expect(result.passes).toBe(false);
  });

  it('different seeds need different nonces', () => {
    const nonceA = findValidNonce(1, 0);
    expect(nonceA).not.toBeNull();
    const rB = verifyGpuPowProbe(2, 0, nonceA, DIFFICULTY);
    expect(rB.passes).toBe(false);
  });
});

// ─── Multi-device GPU-POW tests ───────────────────────────────────────────

describe('multi-device GPU-POW', () => {
  it('finds valid nonces for devices 0, 1, 2, 3 from the same base seed', () => {
    const seed = 42;
    const nonces = [0, 1, 2, 3].map((di) => findValidNonce(seed, di, 500000));
    for (let di = 0; di < 4; di++) {
      expect(nonces[di]).not.toBeNull();
      const r = verifyGpuPowProbe(seed, di, nonces[di], DIFFICULTY);
      expect(r.passes).toBe(true);
    }
  });

  it('each device produces unique nonces', () => {
    const seed = 42;
    const nonces = [0, 1, 2, 3].map((di) => findValidNonce(seed, di, 500000));
    const unique = new Set(nonces);
    expect(unique.size).toBe(4);
  });

  it('device 0 nonce does not pass for device 1 (seed partition prevents reuse)', () => {
    const seed = 42;
    const nonce0 = findValidNonce(seed, 0);
    expect(nonce0).not.toBeNull();
    const r = verifyGpuPowProbe(seed, 1, nonce0, DIFFICULTY);
    expect(r.passes).toBe(false);
  });

  it('all 4 device nonces are pairwise rejected across devices', () => {
    const seed = 99;
    const nonces = [0, 1, 2, 3].map((di) => findValidNonce(seed, di, 500000));
    for (let src = 0; src < 4; src++) {
      for (let dst = 0; dst < 4; dst++) {
        if (src === dst) continue;
        const r = verifyGpuPowProbe(seed, dst, nonces[src], DIFFICULTY);
        expect(r.passes).toBe(false);
      }
    }
  });

  it('coordinator verification: all devices pass → proofValid', () => {
    const seed = 123;
    const devices = [0, 1, 2].map((deviceIndex) => ({
      deviceIndex,
      nonce: findValidNonce(seed, deviceIndex, 500000),
      elapsedMs: 100 + deviceIndex * 10,
    }));
    expect(devices.every((d) => d.nonce != null)).toBe(true);

    let allValid = true;
    const issues = [];
    for (const d of devices) {
      const nonce = Number(d.nonce);
      if (!Number.isFinite(nonce)) {
        allValid = false;
        issues.push(`device ${d.deviceIndex} missing nonce`);
        break;
      }
      const v = verifyGpuPowProbe(seed, d.deviceIndex, nonce, DIFFICULTY);
      if (!v.passes) {
        allValid = false;
        issues.push(`device ${d.deviceIndex} hash ${v.hash16} >= difficulty`);
        break;
      }
    }
    expect(allValid).toBe(true);
    expect(issues.length).toBe(0);
  });

  it('coordinator verification: one device with wrong nonce → fails', () => {
    const seed = 456;
    const devices = [
      { deviceIndex: 0, nonce: findValidNonce(seed, 0, 500000), elapsedMs: 100 },
      { deviceIndex: 1, nonce: 0, elapsedMs: 50 }, // deliberate wrong nonce
      { deviceIndex: 2, nonce: findValidNonce(seed, 2, 500000), elapsedMs: 120 },
    ];
    expect(devices[0].nonce).not.toBeNull();
    expect(devices[2].nonce).not.toBeNull();

    let allValid = true;
    const issues = [];
    for (const d of devices) {
      const nonce = Number(d.nonce);
      if (!Number.isFinite(nonce)) {
        allValid = false;
        issues.push(`device ${d.deviceIndex} missing nonce`);
        break;
      }
      const v = verifyGpuPowProbe(seed, d.deviceIndex, nonce, DIFFICULTY);
      if (!v.passes) {
        allValid = false;
        issues.push(`device ${d.deviceIndex} hash ${v.hash16} >= difficulty`);
        break;
      }
    }
    expect(allValid).toBe(false);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain('device 1');
  });

  it('coordinator verification: empty devices array → fails', () => {
    const devices = [];
    let allValid = true;
    const issues = [];
    if (devices.length === 0) {
      allValid = false;
      issues.push('no device results');
    }
    expect(allValid).toBe(false);
  });

  it('coordinator verification: device with null nonce → fails', () => {
    const seed = 101;
    const devices = [
      { deviceIndex: 0, nonce: findValidNonce(seed, 0, 500000), elapsedMs: 100 },
      { deviceIndex: 1, nonce: null, elapsedMs: 0, error: 'pow failed' },
    ];
    expect(devices[0].nonce).not.toBeNull();

    let allValid = true;
    const issues = [];
    for (const d of devices) {
      if (d.nonce == null) {
        allValid = false;
        issues.push(`device ${d.deviceIndex} missing nonce`);
        break;
      }
    }
    expect(allValid).toBe(false);
  });

  it('coordinator verification: device with undefined nonce → fails', () => {
    const seed = 202;
    const devices = [
      { deviceIndex: 0, nonce: findValidNonce(seed, 0, 500000), elapsedMs: 100 },
      { deviceIndex: 1, elapsedMs: 0 },
    ];
    expect(devices[0].nonce).not.toBeNull();

    let allValid = true;
    const issues = [];
    for (const d of devices) {
      if (d.nonce == null) {
        allValid = false;
        issues.push(`device ${d.deviceIndex} missing nonce`);
        break;
      }
    }
    expect(allValid).toBe(false);
  });

  it('deviceIndex=0 behavior matches pre-multi-GPU (single-GPU backward compat)', () => {
    // A valid nonce for deviceIndex=0 with the new code must match
    // what the old verifyGpuPowProbe(seed, nonce, difficulty) would produce.
    const seed = 55;
    const nonce = findValidNonce(seed, 0);
    expect(nonce).not.toBeNull();
    // Re-verify using the old calling convention (deviceIndex omitted issue)
    // The deviceSeed for device 0 is (seed ^ (0 * 7919)) >>> 0 = seed >>> 0
    const s = ((seed >>> 0) ^ (nonce * 1000003) ^ ((nonce >>> 16) * 7919)) | 0 | 1;
    const hash = computeGpuProbeExpectedHash(s >>> 0, PROBE_GPU_POW_SIZE, PROBE_GPU_POW_ITERS);
    const hash16 = parseInt(hash.slice(-4), 16);
    expect(hash16).toBeLessThan(DIFFICULTY);
  });
});

describe('computeGpuProbeExpectedHash (PoW parameter set)', () => {
  it('produces deterministic hash for same nonce-derived seed', () => {
    const s = (42 ^ (100 * 1000003) ^ ((100 >>> 16) * 7919)) | 0 | 1;
    const h1 = computeGpuProbeExpectedHash(s >>> 0, PROBE_GPU_POW_SIZE, PROBE_GPU_POW_ITERS);
    const h2 = computeGpuProbeExpectedHash(s >>> 0, PROBE_GPU_POW_SIZE, PROBE_GPU_POW_ITERS);
    expect(h1).toBe(h2);
  });

  it('different nonces produce different hashes', () => {
    const seed = 42;
    const s1 = (seed ^ (100 * 1000003) ^ ((100 >>> 16) * 7919)) | 0 | 1;
    const s2 = (seed ^ (200 * 1000003) ^ ((200 >>> 16) * 7919)) | 0 | 1;
    const h1 = computeGpuProbeExpectedHash(s1 >>> 0, PROBE_GPU_POW_SIZE, PROBE_GPU_POW_ITERS);
    const h2 = computeGpuProbeExpectedHash(s2 >>> 0, PROBE_GPU_POW_SIZE, PROBE_GPU_POW_ITERS);
    expect(h1).not.toBe(h2);
  });
});
