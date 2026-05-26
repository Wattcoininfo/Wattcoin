// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const { computeGpuProbeExpectedHash } = require('../backend-benchmark');

// ─── describe / it helpers ────────────────────────────────────────────────

function describe(name, fn) { fn(); }

function it(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => console.log(`  ✓ ${name}`),
        (e) => { console.error(`  ✗ ${name}: ${e.message}`); throw e; },
      );
    }
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    throw e;
  }
}

// ─── computeGpuProbeExpectedHash ──────────────────────────────────────────

describe('computeGpuProbeExpectedHash', () => {
  it('returns deterministic 8-char hex for known seed/size/iterations', () => {
    const hash = computeGpuProbeExpectedHash(42, 64, 3);
    // Same inputs must always produce same output
    const hash2 = computeGpuProbeExpectedHash(42, 64, 3);
    assert.strictEqual(hash, hash2);
  });

  it('returns different hash for different seed', () => {
    const h1 = computeGpuProbeExpectedHash(1, 64, 3);
    const h2 = computeGpuProbeExpectedHash(2, 64, 3);
    assert.notStrictEqual(h1, h2);
  });

  it('returns different hash for different size', () => {
    const h1 = computeGpuProbeExpectedHash(42, 32, 3);
    const h2 = computeGpuProbeExpectedHash(42, 64, 3);
    assert.notStrictEqual(h1, h2);
  });

  it('returns different hash for different shader iterations', () => {
    const h1 = computeGpuProbeExpectedHash(42, 64, 1);
    const h2 = computeGpuProbeExpectedHash(42, 64, 10);
    assert.notStrictEqual(h1, h2);
  });

  it('handles seed=0 (maps to 1 internally)', () => {
    const h1 = computeGpuProbeExpectedHash(0, 64, 3);
    const h2 = computeGpuProbeExpectedHash(1, 64, 3);
    assert.strictEqual(h1, h2);
  });

  it('returns 8-character hex string', () => {
    const hash = computeGpuProbeExpectedHash(42, 64, 3);
    assert.strictEqual(typeof hash, 'string');
    assert.strictEqual(hash.length, 8);
    assert.ok(/^[0-9a-f]{8}$/.test(hash), `Expected 8-char hex, got ${hash}`);
  });

  it('handles minimum size (1x1 grid)', () => {
    const hash = computeGpuProbeExpectedHash(42, 1, 3);
    assert.strictEqual(hash.length, 8);
  });

  it('handles larger size (256x256)', () => {
    // 256*256 grid = 65536 pixels; should produce consistent hash
    const h1 = computeGpuProbeExpectedHash(42, 256, 3);
    const h2 = computeGpuProbeExpectedHash(42, 256, 3);
    assert.strictEqual(h1, h2);
  });

  it('produces at least 10 unique outputs for 20 diverse seeds', () => {
    const results = new Set();
    for (let s = 1; s <= 20; s++) {
      results.add(computeGpuProbeExpectedHash(s, 64, 3));
    }
    assert.ok(results.size >= 10, `Expected >=10 unique hashes for 20 seeds, got ${results.size}`);
  });
});

describe('computeGpuProbeExpectedHash — edge cases', () => {
  it('handles negative seed', () => {
    const hash = computeGpuProbeExpectedHash(-42, 64, 3);
    assert.strictEqual(hash.length, 8);
  });

  it('handles very large seed', () => {
    const hash = computeGpuProbeExpectedHash(2147483647, 64, 3);
    assert.strictEqual(hash.length, 8);
  });
});
