'use strict';
/**
 * token-verification.test.js
 *
 * Tests for peer-verifiable proof verification:
 *   - isValidHex32, isValidOps (validation helpers)
 *   - verifyBurnProof (iterated SHA-256 burn loop verification)
 *   - verifyBurnMs (burn timing bounds)
 *   - verifySeedProof (coordinator-side seed proof verification)
 *   - checkProofPlausibility (ops vs hardware capability)
 *   - computeEnergyWh (energy credit calculation)
 *   - constants sanity
 */

const assert = require('assert');
const crypto = require('crypto');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    if (e.stack) console.error(`    ${e.stack.split('\n').slice(1, 3).join('\n    ')}`);
    failed++;
  }
}

const {
  verifyBurnProof,
  verifyBurnMs,
  verifySeedProof,
  checkProofPlausibility,
  computeEnergyWh,
  isValidHex32,
  isValidOps,
  BURN_PROOF_STEP,
  MIN_BURN_NS_PER_OP,
  MAX_BURN_NS_PER_OP,
  PLAUSIBILITY_LOW_FACTOR,
  PLAUSIBILITY_HIGH_FACTOR,
  MIN_BURN_MS,
} = require('../electron-main/token-verification');

// ── Helper: compute SHA-256 burn + proof ───────────────────────────────────
function computeBurn(chainState, ops, seedHex) {
  const seedBuf = seedHex ? Buffer.from(seedHex, 'hex') : Buffer.alloc(32);
  const startInput = Buffer.alloc(64);
  chainState.copy(startInput, 0);
  seedBuf.copy(startInput, 32);
  let state = crypto.createHash('sha256').update(startInput).digest();

  const intermediates = [];
  for (let i = 0; i < ops; i++) {
    const input = Buffer.alloc(68);
    state.copy(input, 0);
    input.writeUInt32LE(i >>> 0, 32);
    seedBuf.copy(input, 36);
    state = crypto.createHash('sha256').update(input).digest();
    if (i % BURN_PROOF_STEP === 0) {
      intermediates.push(state);
    }
  }
  const proof =
    intermediates.length > 0
      ? crypto.createHash('sha256').update(Buffer.concat(intermediates)).digest('hex')
      : crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

  return { burnResult: state.toString('hex'), proof };
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. isValidHex32
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  isValidHex32');

  await test('accepts valid 64-char hex string', () => {
    const hex = crypto.randomBytes(32).toString('hex');
    assert.strictEqual(isValidHex32(hex), true);
  });

  await test('rejects short string', () => {
    assert.strictEqual(isValidHex32('abc'), false);
  });

  await test('rejects non-hex chars', () => {
    const bad = 'z'.repeat(64);
    assert.strictEqual(isValidHex32(bad), false);
  });

  await test('rejects non-string (number, null, undefined)', () => {
    assert.strictEqual(isValidHex32(123), false);
    assert.strictEqual(isValidHex32(null), false);
    assert.strictEqual(isValidHex32(undefined), false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. isValidOps
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  isValidOps');

  await test('accepts >= 1000', () => {
    assert.strictEqual(isValidOps(1000), true);
    assert.strictEqual(isValidOps(50000), true);
  });

  await test('rejects < 1000', () => {
    assert.strictEqual(isValidOps(999), false);
    assert.strictEqual(isValidOps(0), false);
    assert.strictEqual(isValidOps(-1), false);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. verifyBurnProof
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  verifyBurnProof');

  await test('accepts valid burn proof', () => {
    const cs = crypto.randomBytes(32).toString('hex');
    const seed = crypto.randomBytes(32).toString('hex');
    const ops = 1000;
    const { burnResult, proof } = computeBurn(Buffer.from(cs, 'hex'), ops, seed);
    const r = verifyBurnProof(cs, ops, seed, burnResult, proof);
    assert.strictEqual(r.ok, true);
  });

  await test('rejects when final state does not match burnResult', () => {
    const cs = crypto.randomBytes(32).toString('hex');
    const seed = crypto.randomBytes(32).toString('hex');
    const ops = 1000;
    const { proof } = computeBurn(Buffer.from(cs, 'hex'), ops, seed);
    const tamperedBr = crypto.randomBytes(32).toString('hex');
    const r = verifyBurnProof(cs, ops, seed, tamperedBr, proof);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'burn_result_mismatch');
  });

  await test('rejects when proof is wrong', () => {
    const cs = crypto.randomBytes(32).toString('hex');
    const seed = crypto.randomBytes(32).toString('hex');
    const ops = 1000;
    const { burnResult } = computeBurn(Buffer.from(cs, 'hex'), ops, seed);
    const fakeProof = crypto.randomBytes(32).toString('hex');
    const r = verifyBurnProof(cs, ops, seed, burnResult, fakeProof);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'burn_proof_invalid');
  });

  await test('rejects invalid prev state', () => {
    const r = verifyBurnProof('invalid', 1000, 'aabb', 'ccdd', 'eeff');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_prev_state');
  });

  await test('rejects invalid ops', () => {
    const cs = crypto.randomBytes(32).toString('hex');
    const seed = crypto.randomBytes(32).toString('hex');
    const r = verifyBurnProof(cs, 100, seed, 'aa'.repeat(32), 'bb'.repeat(32));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_ops');
  });

  await test('rejects invalid seed', () => {
    const cs = crypto.randomBytes(32).toString('hex');
    const r = verifyBurnProof(cs, 1000, 'invalid', 'aa'.repeat(32), 'bb'.repeat(32));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_seed');
  });

  await test('accepts valid burn proof with small ops', () => {
    const cs = crypto.randomBytes(32).toString('hex');
    const seed = crypto.randomBytes(32).toString('hex');
    const ops = 1000;
    const { burnResult, proof } = computeBurn(Buffer.from(cs, 'hex'), ops, seed);
    const r = verifyBurnProof(cs, ops, seed, burnResult, proof);
    assert.strictEqual(r.ok, true);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. verifyBurnMs
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  verifyBurnMs');

  await test('accepts plausible burn time for 1000 ops', () => {
    const r = verifyBurnMs(1, 1000);
    assert.strictEqual(r.ok, true);
  });

  await test('rejects burn time that is too fast (skipped iterations)', () => {
    const r = verifyBurnMs(0, 10000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'burn_too_fast');
  });

  await test('rejects burn time that is too slow (padded with Sleep)', () => {
    const r = verifyBurnMs(1000, 1000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'burn_too_slow');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. verifySeedProof
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  verifySeedProof');

  await test('accepts valid seed proof with correct chain', () => {
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seed, 'hex');
    const startState = crypto
      .createHash('sha256')
      .update(Buffer.concat([prevState, seedBuf]))
      .digest('hex');
    const ops = 1000;
    const { burnResult, proof: intermediateProof } = computeBurn(Buffer.from(startState, 'hex'), ops, seed);
    const burnMs = 1;
    const proof = { startState, endState: burnResult, totalOps: ops, burnMs, intermediateProof };
    const r = verifySeedProof(proof, seed);
    assert.strictEqual(r.ok, true);
  });

  await test('rejects null/undefined proof', () => {
    assert.strictEqual(verifySeedProof(null, 'a'.repeat(64)).ok, false);
    assert.strictEqual(verifySeedProof(undefined, 'a'.repeat(64)).ok, false);
  });

  await test('rejects invalid seed (non-hex)', () => {
    const proof = {
      startState: 'a'.repeat(64),
      endState: 'a'.repeat(64),
      totalOps: 1000,
      burnMs: 1,
      intermediateProof: 'a'.repeat(64),
    };
    const r = verifySeedProof(proof, 'invalid-seed');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_seed');
  });

  await test('rejects proof with invalid startState', () => {
    const proof = {
      startState: 'invalid',
      endState: 'a'.repeat(64),
      totalOps: 1000,
      burnMs: 1,
      intermediateProof: 'a'.repeat(64),
    };
    const r = verifySeedProof(proof, 'a'.repeat(64));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_start_state');
  });

  await test('rejects proof with invalid endState', () => {
    const proof = {
      startState: 'a'.repeat(64),
      endState: 'invalid',
      totalOps: 1000,
      burnMs: 1,
      intermediateProof: 'a'.repeat(64),
    };
    const r = verifySeedProof(proof, 'a'.repeat(64));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_end_state');
  });

  await test('rejects proof with invalid totalOps (< 1000)', () => {
    const proof = {
      startState: 'a'.repeat(64),
      endState: 'a'.repeat(64),
      totalOps: 999,
      burnMs: 1,
      intermediateProof: 'a'.repeat(64),
    };
    const r = verifySeedProof(proof, 'a'.repeat(64));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_ops');
  });

  await test('rejects proof with invalid intermediateProof', () => {
    const proof = {
      startState: 'a'.repeat(64),
      endState: 'a'.repeat(64),
      totalOps: 1000,
      burnMs: 1,
      intermediateProof: 'invalid',
    };
    const r = verifySeedProof(proof, 'a'.repeat(64));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'invalid_intermediate_proof');
  });

  await test('rejects proof when burnMs is too fast', () => {
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seed, 'hex');
    const startState = crypto
      .createHash('sha256')
      .update(Buffer.concat([prevState, seedBuf]))
      .digest('hex');
    const ops = 10000;
    const { burnResult, proof: intermediateProof } = computeBurn(Buffer.from(startState, 'hex'), ops, seed);
    const proof = { startState, endState: burnResult, totalOps: ops, burnMs: 0, intermediateProof };
    const r = verifySeedProof(proof, seed);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'burn_too_fast');
  });

  await test('rejects proof when burnMs is too slow', () => {
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seed, 'hex');
    const startState = crypto
      .createHash('sha256')
      .update(Buffer.concat([prevState, seedBuf]))
      .digest('hex');
    const ops = 1000;
    const { burnResult, proof: intermediateProof } = computeBurn(Buffer.from(startState, 'hex'), ops, seed);
    const proof = { startState, endState: burnResult, totalOps: ops, burnMs: 1000, intermediateProof };
    const r = verifySeedProof(proof, seed);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'burn_too_slow');
  });

  await test('rejects proof when chain does not match (wrong endState)', () => {
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seed, 'hex');
    const startState = crypto
      .createHash('sha256')
      .update(Buffer.concat([prevState, seedBuf]))
      .digest('hex');
    const ops = 1000;
    const { proof: intermediateProof } = computeBurn(Buffer.from(startState, 'hex'), ops, seed);
    const proof = {
      startState,
      endState: crypto.randomBytes(32).toString('hex'),
      totalOps: ops,
      burnMs: 1,
      intermediateProof,
    };
    const r = verifySeedProof(proof, seed);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'burn_result_mismatch');
  });

  await test('rejects proof when intermediateProof does not match', () => {
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seed, 'hex');
    const startState = crypto
      .createHash('sha256')
      .update(Buffer.concat([prevState, seedBuf]))
      .digest('hex');
    const ops = 1000;
    const { burnResult } = computeBurn(Buffer.from(startState, 'hex'), ops, seed);
    const proof = {
      startState,
      endState: burnResult,
      totalOps: ops,
      burnMs: 1,
      intermediateProof: crypto.randomBytes(32).toString('hex'),
    };
    const r = verifySeedProof(proof, seed);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'burn_proof_invalid');
  });

  await test('accepts proof with expectedMinOps/expectedMaxOps range', () => {
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seed, 'hex');
    const startState = crypto
      .createHash('sha256')
      .update(Buffer.concat([prevState, seedBuf]))
      .digest('hex');
    const ops = 1000;
    const { burnResult, proof: intermediateProof } = computeBurn(Buffer.from(startState, 'hex'), ops, seed);
    const proof = { startState, endState: burnResult, totalOps: ops, burnMs: 1, intermediateProof };
    const r = verifySeedProof(proof, seed, 500, 2000);
    assert.strictEqual(r.ok, true);
  });

  await test('rejects proof below expectedMinOps', () => {
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seed, 'hex');
    const startState = crypto
      .createHash('sha256')
      .update(Buffer.concat([prevState, seedBuf]))
      .digest('hex');
    const ops = 1000;
    const { burnResult, proof: intermediateProof } = computeBurn(Buffer.from(startState, 'hex'), ops, seed);
    const proof = { startState, endState: burnResult, totalOps: ops, burnMs: 1, intermediateProof };
    const r = verifySeedProof(proof, seed, 2000, 5000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'ops_below_minimum');
  });

  await test('rejects proof above expectedMaxOps', () => {
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seed, 'hex');
    const startState = crypto
      .createHash('sha256')
      .update(Buffer.concat([prevState, seedBuf]))
      .digest('hex');
    const ops = 1000;
    const { burnResult, proof: intermediateProof } = computeBurn(Buffer.from(startState, 'hex'), ops, seed);
    const proof = { startState, endState: burnResult, totalOps: ops, burnMs: 1, intermediateProof };
    const r = verifySeedProof(proof, seed, 100, 500);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'ops_above_maximum');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. checkProofPlausibility
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  checkProofPlausibility');

  await test('rejects when no hardware spec provided', () => {
    const r = checkProofPlausibility(1000, 100, null, 1.0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_hardware_spec');
  });

  await test('accepts plausible ops at 100% load', () => {
    const r = checkProofPlausibility(1000, 100, { opsPerMs: 10, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, true);
  });

  await test('rejects ops below plausibility threshold (ops_too_low)', () => {
    // opsPerMs=100, load=1.0 → desiredBurnMs=max(8, 100*1)=100, expected=max(1000, 100*100)=10000
    // 1000 < 10000*0.15=1500 → ops_too_low
    const r = checkProofPlausibility(1000, 100, { opsPerMs: 100, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'ops_too_low');
  });

  await test('rejects ops above high factor (ops_too_high)', () => {
    // opsPerMs=1, load=1.0 → expected=max(1000, round(100*1))=1000, high=1000*1.2=1200
    const r = checkProofPlausibility(5000, 100, { opsPerMs: 1, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'ops_too_high');
  });

  await test('accepts ops at low load', () => {
    // opsPerMs=1, load=0.1 → desiredBurnMs=max(8, 100*0.1)=10, expected=max(1000, 10)=1000
    const r = checkProofPlausibility(1000, 100, { opsPerMs: 1, tdpW: 65 }, 0.1);
    assert.strictEqual(r.ok, true);
  });

  await test('rejects ops below minimum (< 1000)', () => {
    const r = checkProofPlausibility(999, 100, { opsPerMs: 10, tdpW: 65 }, 0.5);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'ops_below_minimum');
  });

  await test('rejects when opsPerMs is 0 (unrecognized hardware)', () => {
    const r = checkProofPlausibility(1000, 100, { opsPerMs: 0, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no_hardware_spec');
  });

  await test('tolerance: accepts 70% of expected (low bound)', () => {
    // opsPerMs=100, load=1.0 → expected=max(1000, 100*100)=10000, low=10000*0.7=7000
    const r = checkProofPlausibility(7000, 100, { opsPerMs: 100, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, true);
  });

  await test('tolerance: rejects below 70% of expected', () => {
    // opsPerMs=100, load=1.0 → expected=10000, low=7000
    const r = checkProofPlausibility(6999, 100, { opsPerMs: 100, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, false);
  });

  await test('tolerance: accepts 120% of expected (high bound)', () => {
    // opsPerMs=100, load=1.0 → expected=max(1000, 100*100)=10000, high=10000*1.2=12000
    const r = checkProofPlausibility(12000, 100, { opsPerMs: 100, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, true);
  });

  await test('tolerance: rejects above 120% of expected', () => {
    // opsPerMs=100, load=1.0 → expected=10000, high=12000
    const r = checkProofPlausibility(12001, 100, { opsPerMs: 100, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'ops_too_high');
  });

  await test('creditedOps caps at expectedOps when totalOps exceeds it', () => {
    // opsPerMs=100, load=1.0 → expected=10000, totalOps=11000 (within 120% band)
    const r = checkProofPlausibility(11000, 100, { opsPerMs: 100, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.creditedOps, 10000);
  });

  await test('creditedOps equals totalOps when below expectedOps', () => {
    // opsPerMs=100, load=1.0 → expected=10000, totalOps=8000
    const r = checkProofPlausibility(8000, 100, { opsPerMs: 100, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.creditedOps, 8000);
  });

  await test('creditedOps is 0 when proof rejected', () => {
    const r = checkProofPlausibility(100, 100, { opsPerMs: 100, tdpW: 65 }, 1.0);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.creditedOps, 0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. computeEnergyWh
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  computeEnergyWh');

  await test('returns 0 when powerW is 0', () => {
    assert.strictEqual(computeEnergyWh('cpu', 10000, 0), 0);
  });

  await test('returns 0 when elapsedMs is 0', () => {
    assert.strictEqual(computeEnergyWh('cpu', 0, 10), 0);
  });

  await test('CPU: energy = powerW * elapsedMs / 3600000', () => {
    // 10W × 30s = 0.0833 Wh
    const expected = (10 * 30000) / 3600000;
    assert.strictEqual(computeEnergyWh('cpu', 30000, 10), expected);
  });

  await test('GPU: energy = powerW * elapsedMs / 3600000', () => {
    // 200W × 60s = 3.333 Wh
    const expected = (200 * 60000) / 3600000;
    assert.strictEqual(computeEnergyWh('gpu', 60000, 200), expected);
  });

  await test('ASIC: energy = powerW * elapsedMs / 3600000', () => {
    // 150W × 3600s = 150 Wh
    const expected = (150 * 3600000) / 3600000;
    assert.strictEqual(computeEnergyWh('asic', 3600000, 150), expected);
  });

  await test('returns 0 when powerW is negative', () => {
    assert.strictEqual(computeEnergyWh('cpu', 10000, -5), 0);
  });

  await test('returns 0 when elapsedMs is negative', () => {
    assert.strictEqual(computeEnergyWh('cpu', -1000, 10), 0);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8. Constants
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  Constants');

  await test('PLAUSIBILITY_LOW_FACTOR is 0.7', () => {
    assert.strictEqual(PLAUSIBILITY_LOW_FACTOR, 0.7);
  });

  await test('PLAUSIBILITY_HIGH_FACTOR is 1.2', () => {
    assert.strictEqual(PLAUSIBILITY_HIGH_FACTOR, 1.2);
  });

  await test('BURN_PROOF_STEP is 256', () => {
    assert.strictEqual(BURN_PROOF_STEP, 256);
  });

  await test('MIN_BURN_NS_PER_OP is 200', () => {
    assert.strictEqual(MIN_BURN_NS_PER_OP, 200);
  });

  await test('MAX_BURN_NS_PER_OP is 15000', () => {
    assert.strictEqual(MAX_BURN_NS_PER_OP, 15000);
  });

  await test('MIN_BURN_MS is 8', () => {
    assert.strictEqual(MIN_BURN_MS, 8);
  });
}

run().then(() => {
  console.log(`\n  token-verification: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
});
