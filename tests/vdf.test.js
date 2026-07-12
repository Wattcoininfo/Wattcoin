'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function _assertThrows(fn, expectedMsg) {
  try {
    fn();
    throw new Error('expected an error but none was thrown');
  } catch (e) {
    if (e.message === 'expected an error but none was thrown') throw e;
    if (expectedMsg && !e.message.includes(expectedMsg)) {
      throw new Error(`expected error containing "${expectedMsg}" but got: ${e.message}`);
    }
  }
}

async function run() {
  const {
    deriveVdfInput,
    vdfEvaluate,
    vdfVerify,
    estimateVdfTimingMs,
    DEFAULT_VDF_DIFFICULTY,
    DEFAULT_VDF_DISCRIMINANT_BITS,
    SUPPORTED_DISCRIMINANT_BITS,
  } = require('../electron-main/vdf');
  const {
    normalizeProbeReceipt,
    PROBE_RECEIPT_VERSION,
    getProbeReceiptSigningPayload,
  } = require('../electron-main/probe-attestation');

  // ── VDF module exports ──────────────────────────────────────────────────

  await test('vdf module exports all required functions', () => {
    assert.strictEqual(typeof deriveVdfInput, 'function');
    assert.strictEqual(typeof vdfEvaluate, 'function');
    assert.strictEqual(typeof vdfVerify, 'function');
    assert.strictEqual(typeof estimateVdfTimingMs, 'function');
  });

  await test('DEFAULT_VDF_DIFFICULTY is a positive integer', () => {
    assert.ok(Number.isInteger(DEFAULT_VDF_DIFFICULTY));
    assert.ok(DEFAULT_VDF_DIFFICULTY > 0);
  });

  await test('DEFAULT_VDF_DISCRIMINANT_BITS is 512', () => {
    assert.strictEqual(DEFAULT_VDF_DISCRIMINANT_BITS, 512);
  });

  await test('SUPPORTED_DISCRIMINANT_BITS includes 256, 512, 1024, 2048', () => {
    assert.ok(SUPPORTED_DISCRIMINANT_BITS.has(256));
    assert.ok(SUPPORTED_DISCRIMINANT_BITS.has(512));
    assert.ok(SUPPORTED_DISCRIMINANT_BITS.has(1024));
    assert.ok(SUPPORTED_DISCRIMINANT_BITS.has(2048));
  });

  // ── deriveVdfInput ──────────────────────────────────────────────────────

  await test('deriveVdfInput returns a Buffer of 32 bytes', () => {
    const input = deriveVdfInput('probe-1', 'worker-a', 5);
    assert.ok(Buffer.isBuffer(input));
    assert.strictEqual(input.length, 32);
  });

  await test('deriveVdfInput is deterministic', () => {
    const a = deriveVdfInput('probe-1', 'worker-a', 5);
    const b = deriveVdfInput('probe-1', 'worker-a', 5);
    assert.deepStrictEqual(a, b);
  });

  await test('deriveVdfInput changes with different probeId', () => {
    const a = deriveVdfInput('probe-1', 'worker-a', 5);
    const b = deriveVdfInput('probe-2', 'worker-a', 5);
    assert.notDeepStrictEqual(a, b);
  });

  await test('deriveVdfInput changes with different workerId', () => {
    const a = deriveVdfInput('probe-1', 'worker-a', 5);
    const b = deriveVdfInput('probe-1', 'worker-b', 5);
    assert.notDeepStrictEqual(a, b);
  });

  await test('deriveVdfInput changes with different chainIndex', () => {
    const a = deriveVdfInput('probe-1', 'worker-a', 5);
    const b = deriveVdfInput('probe-1', 'worker-a', 6);
    assert.notDeepStrictEqual(a, b);
  });

  await test('deriveVdfInput handles empty strings', () => {
    const input = deriveVdfInput('', '', 0);
    assert.ok(Buffer.isBuffer(input));
    assert.strictEqual(input.length, 32);
  });

  // ── vdfEvaluate / vdfVerify round-trip ──────────────────────────────────

  await test('vdfEvaluate returns valid structure', async () => {
    const challenge = deriveVdfInput('test-probe', 'test-worker', 1);
    const result = await vdfEvaluate({ challenge, difficulty: 100, discriminantSizeBits: 512 });
    assert.ok(result && typeof result === 'object');
    assert.strictEqual(typeof result.proof, 'string');
    assert.ok(result.proof.length > 0);
    assert.strictEqual(typeof result.output, 'string');
    assert.ok(result.output.length > 0);
    assert.strictEqual(result.steps, 100);
    assert.strictEqual(result.discriminantSizeBits, 512);
  });

  await test('vdfEvaluate proof is valid hex', async () => {
    const challenge = deriveVdfInput('test-probe', 'test-worker', 1);
    const result = await vdfEvaluate({ challenge, difficulty: 100, discriminantSizeBits: 512 });
    assert.ok(/^[0-9a-f]+$/i.test(result.proof), 'proof should be hex');
    assert.ok(/^[0-9a-f]+$/i.test(result.output), 'output should be hex');
  });

  await test('vdfVerify returns true for a valid proof', async () => {
    const challenge = deriveVdfInput('test-probe', 'test-worker', 1);
    const result = await vdfEvaluate({ challenge, difficulty: 100, discriminantSizeBits: 512 });
    const ok = vdfVerify({ challenge, difficulty: 100, discriminantSizeBits: 512, proof: result.proof });
    assert.strictEqual(ok, true);
  });

  await test('vdfVerify returns false for a bogus proof', () => {
    const challenge = deriveVdfInput('test-probe', 'test-worker', 1);
    const ok = vdfVerify({
      challenge,
      difficulty: 100,
      discriminantSizeBits: 512,
      proof: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    assert.strictEqual(ok, false);
  });

  await test('vdfVerify returns false for wrong difficulty', async () => {
    const challenge = deriveVdfInput('test-probe', 'test-worker', 1);
    const result = await vdfEvaluate({ challenge, difficulty: 100, discriminantSizeBits: 512 });
    const ok = vdfVerify({ challenge, difficulty: 200, discriminantSizeBits: 512, proof: result.proof });
    assert.strictEqual(ok, false);
  });

  await test('vdfVerify returns false for wrong discriminant size', async () => {
    const challenge = deriveVdfInput('test-probe', 'test-worker', 1);
    const result = await vdfEvaluate({ challenge, difficulty: 100, discriminantSizeBits: 512 });
    const ok = vdfVerify({ challenge, difficulty: 100, discriminantSizeBits: 256, proof: result.proof });
    assert.strictEqual(ok, false);
  });

  await test('vdfVerify returns false for empty proof', () => {
    const challenge = deriveVdfInput('test-probe', 'test-worker', 1);
    const ok = vdfVerify({ challenge, difficulty: 100, discriminantSizeBits: 512, proof: '' });
    assert.strictEqual(ok, false);
  });

  await test('vdfVerify returns false for unsupported discriminant size', () => {
    const challenge = deriveVdfInput('test-probe', 'test-worker', 1);
    const ok = vdfVerify({ challenge, difficulty: 100, discriminantSizeBits: 1024, proof: 'deadbeef' });
    // 1024 is supported but the proof is bogus
    assert.strictEqual(ok, false);
  });

  await test('vdfVerify handles missing/undefined inputs gracefully', () => {
    assert.strictEqual(vdfVerify({}), false);
    assert.strictEqual(vdfVerify(null), false);
    assert.strictEqual(vdfVerify({ challenge: null, difficulty: 0, discriminantSizeBits: 0, proof: '' }), false);
  });

  await test('vdfEvaluate handles missing inputs gracefully', async () => {
    // Should use defaults
    const result = await vdfEvaluate({});
    assert.ok(result && result.proof);
    assert.strictEqual(result.steps, DEFAULT_VDF_DIFFICULTY);
    assert.strictEqual(result.discriminantSizeBits, DEFAULT_VDF_DISCRIMINANT_BITS);
  });

  await test('vdfEvaluate throws on invalid discriminant size', async () => {
    try {
      await vdfEvaluate({ challenge: Uint8Array.from([1]), difficulty: 100, discriminantSizeBits: 999 });
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e.message.includes('Unsupported'));
    }
  });

  // ── estimateVdfTimingMs ─────────────────────────────────────────────────

  await test('estimateVdfTimingMs returns positive value for valid input', () => {
    const ms = estimateVdfTimingMs(2000, 512);
    assert.ok(ms > 0);
  });

  await test('estimateVdfTimingMs scales linearly with difficulty', () => {
    const ms1 = estimateVdfTimingMs(1000, 512);
    const ms2 = estimateVdfTimingMs(2000, 512);
    assert.ok(Math.abs(ms2 - ms1 * 2) < 1, 'should be roughly 2x');
  });

  await test('estimateVdfTimingMs returns 0 for zero steps', () => {
    assert.strictEqual(estimateVdfTimingMs(0, 512), 0);
  });

  await test('estimateVdfTimingMs returns 0 for negative steps', () => {
    assert.strictEqual(estimateVdfTimingMs(-10, 512), 0);
  });

  await test('estimateVdfTimingMs returns 0 for NaN', () => {
    assert.strictEqual(estimateVdfTimingMs(NaN, 512), 0);
  });

  await test('estimateVdfTimingMs applies discriminant multiplier for 1024-bit', () => {
    const ms512 = estimateVdfTimingMs(2000, 512);
    const ms1024 = estimateVdfTimingMs(2000, 1024);
    assert.ok(ms1024 > ms512, '1024-bit should be slower than 512-bit');
  });

  // ── Receipt v2 format ───────────────────────────────────────────────────

  await test('PROBE_RECEIPT_VERSION is 2', () => {
    assert.strictEqual(PROBE_RECEIPT_VERSION, 2);
  });

  await test('normalizeProbeReceipt includes VDF fields when present', () => {
    const receipt = {
      version: 2,
      probeId: 'probe-1',
      verifierAddress: 'wtc1qtest',
      workerId: 'wtc1qworker',
      type: 'cpu',
      ok: true,
      wallClockMs: 1000,
      ts: 1000,
      roundId: 1,
      chainIndex: 1,
      hwPowerW: 100,
      vdfSteps: 2000,
      vdfDiscriminantSize: 512,
      vdfInput: 'aabbccdd',
      vdfOutput: 'eeff0011',
      vdfProof: 'deadbeef',
    };
    const normalized = normalizeProbeReceipt(receipt, { includeSignature: false });
    assert.strictEqual(normalized.vdfSteps, 2000);
    assert.strictEqual(normalized.vdfDiscriminantSize, 512);
    assert.strictEqual(normalized.vdfInput, 'aabbccdd');
    assert.strictEqual(normalized.vdfOutput, 'eeff0011');
    assert.strictEqual(normalized.vdfProof, 'deadbeef');
  });

  await test('normalizeProbeReceipt omits VDF fields when not present', () => {
    const receipt = {
      version: 1,
      probeId: 'probe-1',
      verifierAddress: 'wtc1qtest',
      workerId: 'wtc1qworker',
      type: 'cpu',
      ok: true,
      wallClockMs: 1000,
      ts: 1000,
      roundId: 1,
      chainIndex: 1,
      hwPowerW: 100,
    };
    const normalized = normalizeProbeReceipt(receipt, { includeSignature: false });
    assert.strictEqual(normalized.vdfSteps, undefined);
    assert.strictEqual(normalized.vdfDiscriminantSize, undefined);
    assert.strictEqual(normalized.vdfInput, undefined);
    assert.strictEqual(normalized.vdfOutput, undefined);
    assert.strictEqual(normalized.vdfProof, undefined);
  });

  await test('normalizeProbeReceipt handles v1 receipt gracefully (backward compat)', () => {
    const receipt = {
      version: 1,
      probeId: 'probe-old',
      verifierAddress: 'wtc1qtest',
      workerId: 'wtc1qworker',
      type: 'gpu',
      ok: true,
      wallClockMs: 500,
      ts: 2000,
      roundId: 2,
      chainIndex: 3,
      hwPowerW: 200,
    };
    const normalized = normalizeProbeReceipt(receipt, { includeSignature: false });
    assert.strictEqual(normalized.version, 2); // bumped to current
    assert.strictEqual(normalized.probeId, 'probe-old');
    assert.strictEqual(normalized.vdfSteps, undefined);
  });

  await test('getProbeReceiptSigningPayload includes VDF fields', () => {
    const receipt = {
      version: 2,
      probeId: 'probe-1',
      verifierAddress: 'wtc1qtest',
      workerId: 'wtc1qworker',
      type: 'cpu',
      ok: true,
      wallClockMs: 1000,
      ts: 1000,
      roundId: 1,
      chainIndex: 1,
      hwPowerW: 100,
      vdfSteps: 2000,
      vdfDiscriminantSize: 512,
      vdfInput: 'aabb',
      vdfOutput: 'ccdd',
      vdfProof: 'eeff',
    };
    const payload = getProbeReceiptSigningPayload(receipt);
    assert.ok(typeof payload === 'string');
    const parsed = JSON.parse(payload);
    assert.strictEqual(parsed.vdfSteps, 2000);
    assert.strictEqual(parsed.vdfDiscriminantSize, 512);
  });

  // ── End-to-end: VDF in receipt flow ─────────────────────────────────────

  await test('VDF evaluate → verify → normalize into receipt', async () => {
    const challenge = deriveVdfInput('e2e-probe', 'e2e-worker', 10);
    const result = await vdfEvaluate({ challenge, difficulty: 100, discriminantSizeBits: 512 });
    const ok = vdfVerify({ challenge, difficulty: 100, discriminantSizeBits: 512, proof: result.proof });
    assert.strictEqual(ok, true);

    const receipt = normalizeProbeReceipt(
      {
        version: PROBE_RECEIPT_VERSION,
        probeId: 'e2e-probe',
        verifierAddress: 'wtc1qverifier',
        workerId: 'e2e-worker',
        type: 'cpu',
        ok: true,
        wallClockMs: 1500,
        ts: Date.now(),
        roundId: 1,
        chainIndex: 10,
        hwPowerW: 150,
        vdfSteps: result.steps,
        vdfDiscriminantSize: result.discriminantSizeBits,
        vdfInput: challenge.toString('hex'),
        vdfOutput: result.output,
        vdfProof: result.proof,
      },
      { includeSignature: false },
    );
    assert.strictEqual(receipt.vdfSteps, 100);
    assert.strictEqual(receipt.vdfDiscriminantSize, 512);
    assert.strictEqual(typeof receipt.vdfProof, 'string');
    assert.ok(receipt.vdfProof.length > 0);

    // Verify the VDF from the normalized receipt
    const challengeFromReceipt = Buffer.from(receipt.vdfInput, 'hex');
    const reVerified = vdfVerify({
      challenge: challengeFromReceipt,
      difficulty: receipt.vdfSteps,
      discriminantSizeBits: receipt.vdfDiscriminantSize,
      proof: receipt.vdfProof,
    });
    assert.strictEqual(reVerified, true);
  });

  // ── 256-bit discriminant (faster, for edge case testing) ────────────────

  await test('VDF works with 256-bit discriminant', async () => {
    const challenge = deriveVdfInput('small-probe', 'small-worker', 0);
    const result = await vdfEvaluate({ challenge, difficulty: 50, discriminantSizeBits: 256 });
    assert.ok(result.proof.length > 0);
    const ok = vdfVerify({ challenge, difficulty: 50, discriminantSizeBits: 256, proof: result.proof });
    assert.strictEqual(ok, true);
  });

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log(`\nVDF tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
