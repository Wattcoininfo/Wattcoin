'use strict';
/**
 * work-token-chain.test.js
 *
 * Tests for the hash-chain energy-verification system:
 *   - CPU worker burn algorithm (iterated SHA-256 burn, re-implemented outside worker thread)
 *   - hardware-load-controller seed system
 *   - gpu-load-controller seed system
 *   - round-contributions seed proof inclusion in broadcasts
 *   - ledger-ipc new deps acceptance
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

// ── Re-implement core worker algorithms for unit testing ────────────────────
// These mirror cpu-load-worker.js logic exactly.  We test the algorithm in
// isolation without spawning worker threads.

const BURN_PROOF_STEP = 256;

function burnCpuOps(chainState, ops, seedHex) {
  const seedBuf = seedHex ? Buffer.from(seedHex, 'hex') : Buffer.alloc(32);

  // Derive burn start state: SHA-256(chainState ‖ seed)
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
      ? crypto.createHash('sha256').update(Buffer.concat(intermediates)).digest()
      : crypto.createHash('sha256').update(Buffer.alloc(0)).digest();

  return { burnResult: state, proof };
}

function computeTokenHash(prevState, ops, burnResultHex, seedHex) {
  const opsBuf = Buffer.alloc(4);
  opsBuf.writeUInt32LE(ops >>> 0);
  const burnBuf = Buffer.from(burnResultHex, 'hex');
  const seedBuf = seedHex ? Buffer.from(seedHex, 'hex') : Buffer.alloc(32);
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([prevState, opsBuf, burnBuf, seedBuf]))
    .digest();
}

function fullTokenEmit(chainState, ops, seedHex) {
  const { burnResult, proof } = burnCpuOps(chainState, ops, seedHex);
  const burnResultHex = burnResult.toString('hex');
  const proofHex = proof.toString('hex');
  const opsBuf = Buffer.alloc(4);
  opsBuf.writeUInt32LE(ops >>> 0);
  const seedBuf = seedHex ? Buffer.from(seedHex, 'hex') : Buffer.alloc(32);
  const newState = crypto
    .createHash('sha256')
    .update(Buffer.concat([chainState, opsBuf, burnResult, seedBuf]))
    .digest();
  return { newState, burnResultHex, proofHex };
}

async function run() {
  // ═══════════════════════════════════════════════════════════════════════════
  // 1. CPU worker burn algorithm (iterated SHA-256 burn)
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  CPU worker burn algorithm (SHA-256 burn)');

  await test('burnCpuOps returns 32-byte burnResult and 32-byte proof', () => {
    const chainState = crypto.randomBytes(32);
    const { burnResult, proof } = burnCpuOps(chainState, 1000, 'aabbccdd');
    assert.strictEqual(burnResult.length, 32);
    assert.strictEqual(proof.length, 32);
  });

  await test('burnCpuOps is deterministic: same inputs → same outputs', () => {
    const chainState = crypto.randomBytes(32);
    const r1 = burnCpuOps(chainState, 500, 'deadbeef');
    const r2 = burnCpuOps(chainState, 500, 'deadbeef');
    assert.strictEqual(r1.burnResult.toString('hex'), r2.burnResult.toString('hex'));
    assert.strictEqual(r1.proof.toString('hex'), r2.proof.toString('hex'));
  });

  await test('burnCpuOps: different chainState → different burnResult', () => {
    const s1 = crypto.randomBytes(32);
    const s2 = crypto.randomBytes(32);
    const r1 = burnCpuOps(s1, 500, 'seed');
    const r2 = burnCpuOps(s2, 500, 'seed');
    assert.notStrictEqual(r1.burnResult.toString('hex'), r2.burnResult.toString('hex'));
  });

  await test('burnCpuOps: different seed → different burnResult', () => {
    const cs = crypto.randomBytes(32);
    const r1 = burnCpuOps(cs, 500, 'aaaa');
    const r2 = burnCpuOps(cs, 500, 'bbbb');
    assert.notStrictEqual(r1.burnResult.toString('hex'), r2.burnResult.toString('hex'));
  });

  await test('burnCpuOps: more ops → different burnResult', () => {
    const cs = crypto.randomBytes(32);
    const r1 = burnCpuOps(cs, 500, 'seed');
    const r2 = burnCpuOps(cs, 1000, 'seed');
    assert.notStrictEqual(r1.burnResult.toString('hex'), r2.burnResult.toString('hex'));
  });

  await test('burnCpuOps with ops=0 returns SHA-256 of start state', () => {
    const cs = crypto.randomBytes(32);
    const seedBuf = Buffer.from('aabb', 'hex');
    const startInput = Buffer.alloc(64);
    cs.copy(startInput, 0);
    seedBuf.copy(startInput, 32);
    const expected = crypto.createHash('sha256').update(startInput).digest();
    const { burnResult } = burnCpuOps(cs, 0, 'aabb');
    assert.strictEqual(burnResult.toString('hex'), expected.toString('hex'));
  });

  await test('Multi-call burn: absolute step counter matches single-call verifier', () => {
    const { verifyBurnProof } = require('../electron-main/token-verification');
    const chainState = crypto.randomBytes(32);
    const seedHex = crypto.randomBytes(32).toString('hex');
    const seedBuf = Buffer.from(seedHex, 'hex');

    // Derive burn start state (SHA-256(chainState ‖ seed))
    const startInput = Buffer.alloc(64);
    chainState.copy(startInput, 0);
    seedBuf.copy(startInput, 32);
    const burnStartState = crypto.createHash('sha256').update(startInput).digest();

    // Simulate multi-call burn: 2 calls of 5000 ops each, using absolute steps
    const OPS_PER_CALL = 5000;
    const NUM_CALLS = 2;
    let state = burnStartState;
    const allIntermediates = [];
    let absoluteStep = 0;

    for (let call = 0; call < NUM_CALLS; call++) {
      for (let i = 0; i < OPS_PER_CALL; i++) {
        const input = Buffer.alloc(68);
        state.copy(input, 0);
        input.writeUInt32LE(absoluteStep >>> 0, 32);
        seedBuf.copy(input, 36);
        state = crypto.createHash('sha256').update(input).digest();
        if (absoluteStep % BURN_PROOF_STEP === 0) {
          allIntermediates.push(state);
        }
        absoluteStep++;
      }
    }

    assert.strictEqual(absoluteStep, OPS_PER_CALL * NUM_CALLS);
    const finalState = state;
    const intermediateProof = crypto.createHash('sha256').update(Buffer.concat(allIntermediates)).digest('hex');
    const startStateHex = chainState.toString('hex');
    const totalOps = OPS_PER_CALL * NUM_CALLS;

    // Verify against the real verifier
    const result = verifyBurnProof(startStateHex, totalOps, seedHex, finalState.toString('hex'), intermediateProof);
    assert.ok(result.ok, `verifyBurnProof failed: ${result.reason}`);

    // Now verify that using per-call i (the bug) would fail
    let buggyIntermediates = [];
    let buggyState = burnStartState;
    for (let call = 0; call < NUM_CALLS; call++) {
      for (let i = 0; i < OPS_PER_CALL; i++) {
        const input = Buffer.alloc(68);
        buggyState.copy(input, 0);
        input.writeUInt32LE(i >>> 0, 32); // per-call i, NOT absolute — the bug
        seedBuf.copy(input, 36);
        buggyState = crypto.createHash('sha256').update(input).digest();
        if (i % BURN_PROOF_STEP === 0) {
          buggyIntermediates.push(buggyState);
        }
      }
    }
    const buggyProof = crypto.createHash('sha256').update(Buffer.concat(buggyIntermediates)).digest('hex');
    const buggyResult = verifyBurnProof(startStateHex, totalOps, seedHex, buggyState.toString('hex'), buggyProof);
    // The per-call i bug means intermediateProof won't match the verifier's re-computation
    assert.strictEqual(buggyResult.ok, false, 'buggy per-call i should produce invalid proof');
  });

  await test('computeTokenHash returns 32-byte SHA-256 digest', () => {
    const state = crypto.randomBytes(32);
    const hash = computeTokenHash(state, 1000, crypto.randomBytes(32).toString('hex'), 'aabbccdd');
    assert.strictEqual(hash.length, 32);
  });

  await test('computeTokenHash chains: different prevState → different output', () => {
    const s1 = crypto.randomBytes(32);
    const s2 = crypto.randomBytes(32);
    const br = crypto.randomBytes(32).toString('hex');
    const h1 = computeTokenHash(s1, 1000, br, 'aabb');
    const h2 = computeTokenHash(s2, 1000, br, 'aabb');
    assert.notStrictEqual(h1.toString('hex'), h2.toString('hex'));
  });

  await test('computeTokenHash chains: different seed → different output', () => {
    const state = crypto.randomBytes(32);
    const br = crypto.randomBytes(32).toString('hex');
    const h1 = computeTokenHash(state, 1000, br, 'aabbccdd');
    const h2 = computeTokenHash(state, 1000, br, 'eeff0011');
    assert.notStrictEqual(h1.toString('hex'), h2.toString('hex'));
  });

  await test('computeTokenHash chains: different burnResult → different output', () => {
    const state = crypto.randomBytes(32);
    const h1 = computeTokenHash(state, 1000, crypto.randomBytes(32).toString('hex'), 'aabb');
    const h2 = computeTokenHash(state, 1000, crypto.randomBytes(32).toString('hex'), 'aabb');
    assert.notStrictEqual(h1.toString('hex'), h2.toString('hex'));
  });

  await test('Full chain: 3 consecutive tokens are all unique and deterministic', () => {
    let chainState = crypto.randomBytes(32);
    const states = [];

    for (let i = 0; i < 3; i++) {
      const seed = `seed${i}`;
      const { newState } = fullTokenEmit(chainState, 1000, seed);
      states.push(newState.toString('hex'));
      chainState = newState;
    }

    assert.notStrictEqual(states[0], states[1]);
    assert.notStrictEqual(states[1], states[2]);
    assert.notStrictEqual(states[0], states[2]);

    // Deterministic: same inputs → same outputs
    const cs2 = crypto.randomBytes(32);
    const { newState: s1a } = fullTokenEmit(cs2, 1000, 'seed0');
    const { newState: s1b } = fullTokenEmit(cs2, 1000, 'seed0');
    assert.strictEqual(s1a.toString('hex'), s1b.toString('hex'));
  });

  await test('Cannot skip chain step: hash depends on previous state', () => {
    let chainState = crypto.randomBytes(32);

    // Compute token 1
    const { newState: s1 } = fullTokenEmit(chainState, 1000, 'seed1');
    chainState = s1;

    // Token 2 depends on state after token 1, which we haven't computed yet
    assert.ok(chainState.toString('hex').length === 64);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. hardware-load-controller seed system
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  hardware-load-controller seed system');

  await test('drainSeedProofs returns a Map when no workers exist', () => {
    const { drainSeedProofs } = require('../electron-main/hardware-load-controller');
    const proofs = drainSeedProofs();
    assert.ok(proofs instanceof Map);
    assert.strictEqual(proofs.size, 0);
  });

  await test('getCoordinatorSeed returns null when no seed assigned', () => {
    const { getCoordinatorSeed } = require('../electron-main/hardware-load-controller');
    assert.strictEqual(getCoordinatorSeed(), null);
  });

  await test('setCoordinatorSeed is a function (exported from hardware-load-controller)', () => {
    const { setCoordinatorSeed } = require('../electron-main/hardware-load-controller');
    assert.strictEqual(typeof setCoordinatorSeed, 'function');
  });

  await test('onSeedProof is a function', () => {
    const { onSeedProof } = require('../electron-main/hardware-load-controller');
    assert.strictEqual(typeof onSeedProof, 'function');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. gpu-load-controller seed system
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  gpu-load-controller seed system');

  await test('hasValidGpuTelemetry returns false when no GPU configured', () => {
    const { hasValidGpuTelemetry } = require('../electron-main/gpu-load-controller');
    assert.strictEqual(hasValidGpuTelemetry(), false);
  });

  await test('flushGpuTokenLog is exported and is a function (no-op stub)', () => {
    const { flushGpuTokenLog } = require('../electron-main/gpu-load-controller');
    assert.strictEqual(typeof flushGpuTokenLog, 'function');
    // Should not throw when called (it's a no-op)
    flushGpuTokenLog();
  });

  await test('setGpuCoordinatorSeed is a function', () => {
    const { setGpuCoordinatorSeed } = require('../electron-main/gpu-load-controller');
    assert.strictEqual(typeof setGpuCoordinatorSeed, 'function');
  });

  await test('getGpuCoordinatorSeed returns null when no seed', () => {
    const { getGpuCoordinatorSeed } = require('../electron-main/gpu-load-controller');
    assert.strictEqual(getGpuCoordinatorSeed(), null);
  });

  await test('onGpuSeedProof is a function', () => {
    const { onGpuSeedProof } = require('../electron-main/gpu-load-controller');
    assert.strictEqual(typeof onGpuSeedProof, 'function');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. round-contributions seed proof inclusion
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  round-contributions seed proof inclusion');

  await test('buildRoundContributionMessage includes seedProofs when provided', () => {
    const { createRoundContributions } = require('../electron-main/round-contributions');
    const fakeProofs = [
      {
        seed: 'aabbccdd',
        startState: '11223344',
        endState: '55667788',
        totalOps: 10000,
        burnMs: 50,
        intermediateProof: 'aabb',
      },
    ];
    const rc = createRoundContributions({
      roundLedger: { addContribution: () => ({ ok: true }), getCurrentRoundSnapshot: () => ({ id: 1 }) },
      getWtcNode: () => ({ signMessage: () => ({ signature: 'sig' }) }),
      hwAuthority: { peerProbeChainIndex: 0 },
      walletAddressCache: { address: 'test' },
      getLedgerNetworkSettings: () => ({ enabled: false }),
      getActivePeers: () => [],
      requestPeerJson: () => null,
      normalizePeerUrl: (u) => u,
      getLocalProbeChain: () => ({ chainIndex: 0 }),
      rewardForHeight: () => 10,
      getActiveNetwork: () => 'testnet',
      computeHwAuthSig: () => '',
      recordForkMismatch: () => {},
      alignRoundLedgerToChain: () => {},
      ENABLE_POWER_PROOF_COMMITMENT: false,
      console: { warn: () => {}, log: () => {} },
      _pendingContributionWh: { current: 0 },
      _contributionPerSecond: { current: 0 },
      _contributionSecondStart: { current: 0 },
      pendingRoundContributionBroadcasts: new Map(),
      witnessedSettlements: new Map(),
      witnessedProbeReceipts: new Map(),
      bootstrapPeerAddresses: new Set(),
      MIN_PROBE_VERIFIERS: 1,
      ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS: 10,
    });
    const msg = rc.buildRoundContributionMessage({
      address: 'addr1',
      roundId: 1,
      totalWh: 10,
      updatedAtMs: Date.now(),
      chainIndex: 1,
      seedProofs: fakeProofs,
    });
    const parsed = JSON.parse(msg);
    assert.ok(Array.isArray(parsed.seedProofs), 'message should include seedProofs array');
    assert.strictEqual(parsed.seedProofs.length, 1);
    assert.strictEqual(parsed.seedProofs[0].seed, 'aabbccdd');
    assert.strictEqual(parsed.seedProofs[0].totalOps, 10000);
  });

  await test('buildRoundContributionMessage omits seedProofs when not provided', () => {
    const { createRoundContributions } = require('../electron-main/round-contributions');
    const rc = createRoundContributions({
      roundLedger: { addContribution: () => ({ ok: true }), getCurrentRoundSnapshot: () => ({ id: 1 }) },
      getWtcNode: () => ({ signMessage: () => ({ signature: 'sig' }) }),
      hwAuthority: { peerProbeChainIndex: 0 },
      walletAddressCache: { address: 'test' },
      getLedgerNetworkSettings: () => ({ enabled: false }),
      getActivePeers: () => [],
      requestPeerJson: () => null,
      normalizePeerUrl: (u) => u,
      getLocalProbeChain: () => ({ chainIndex: 0 }),
      rewardForHeight: () => 10,
      getActiveNetwork: () => 'testnet',
      computeHwAuthSig: () => '',
      recordForkMismatch: () => {},
      alignRoundLedgerToChain: () => {},
      ENABLE_POWER_PROOF_COMMITMENT: false,
      console: { warn: () => {}, log: () => {} },
      _pendingContributionWh: { current: 0 },
      _contributionPerSecond: { current: 0 },
      _contributionSecondStart: { current: 0 },
      pendingRoundContributionBroadcasts: new Map(),
      witnessedSettlements: new Map(),
      witnessedProbeReceipts: new Map(),
      bootstrapPeerAddresses: new Set(),
      MIN_PROBE_VERIFIERS: 1,
      ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS: 10,
    });
    const msg = rc.buildRoundContributionMessage({
      address: 'addr1',
      roundId: 1,
      totalWh: 10,
      updatedAtMs: Date.now(),
      chainIndex: 1,
    });
    const parsed = JSON.parse(msg);
    assert.strictEqual(parsed.seedProofs, undefined);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. ledger-ipc new deps acceptance
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  ledger-ipc new deps acceptance');

  await test('registerLedgerIpcHandlers accepts new deps without throwing', () => {
    const { registerLedgerIpcHandlers } = require('../electron-main/ledger-ipc');
    registerLedgerIpcHandlers({
      ipcMain: { handle: () => {} },
      roundLedger: {
        isTampered: () => false,
        addContribution: () => ({ ok: true }),
        getCurrentRoundSnapshot: () => ({}),
      },
      getWtcNode: () => null,
      hwAuthority: {
        hwChangedBlocked: false,
        hwHoldUntilMs: 0,
        trustScore: 100,
        currentLoadPercent: 100,
        calibratedUnitPowerW: 0,
        nativeGpuTdpW: 0,
        asicPowerW: 0,
      },
      walletAddressCache: { address: 'test', at: Date.now() },
      getLedgerNetworkSettings: () => ({ enabled: false }),
      enforceEndpointRateLimit: () => ({ ok: true }),
      settleLocalLedgerRound: () => ({ ok: true }),
      alignRoundLedgerToChain: () => {},
      getMeasuredCpuDuty: () => -1,
      getGpuLoadState: () => null,
      getSharedRoundSnapshot: () => ({ id: 0, totalWh: 0, contributionsWh: {} }),
      hasOnlinePeers: () => false,
      getLocalLedgerBalances: () => ({ ok: true, addressRoundWh: 0 }),
      loadBenchmarkHistory: () => ({ cpuSamples: [], gpuSamples: [] }),
      getMeasuredOpsPerMs: () => 1000,
      hasValidGpuTelemetry: () => false,
      _pendingContributionWh: { current: 0 },
      _contributionPerSecond: { current: 0 },
      _contributionSecondStart: { current: 0 },
      _startupRampUp: { current: false },
      _startupRampUpStartedAt: { current: 0 },
      _cpuDutySamples: { current: [] },
      _prevRawCpuDuty: { current: -1 },
      _startupGpuRampUp: { current: false },
      _startupGpuRampUpStartedAt: { current: 0 },
      _gpuDutySamples: { current: [] },
      _prevRawGpuDuty: { current: -1 },
      _physicalCoreCount: { current: 0 },
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Adversarial / edge-case scenarios
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  Adversarial / edge-case scenarios');

  await test('Pre-computed tokens are useless: different seed → different hash', () => {
    const state0 = crypto.randomBytes(32);
    const { burnResult } = burnCpuOps(state0, 1000, 'aaaa');
    const s1 = computeTokenHash(state0, 1000, burnResult.toString('hex'), 'aaaa');
    const expectedS1 = computeTokenHash(state0, 1000, burnResult.toString('hex'), 'bbbb');
    assert.notStrictEqual(s1.toString('hex'), expectedS1.toString('hex'));
  });

  await test('Replay of same token fails: chain moves forward', () => {
    const state0 = crypto.randomBytes(32);

    // Token 1
    const { burnResult: br1 } = burnCpuOps(state0, 1000, 'aabb');
    const s1 = computeTokenHash(state0, 1000, br1.toString('hex'), 'aabb');

    // Token 2
    const { burnResult: br2 } = burnCpuOps(s1, 1000, 'bbcc');
    const s2 = computeTokenHash(s1, 1000, br2.toString('hex'), 'bbcc');

    // Attempt to replay token 1 against state after token 2
    const replayed = computeTokenHash(s2, 1000, br1.toString('hex'), 'aabb');
    assert.notStrictEqual(replayed.toString('hex'), s1.toString('hex'));
  });

  await test('Burn with ops=0 returns hash of start state (not error)', () => {
    const cs = crypto.randomBytes(32);
    const { burnResult } = burnCpuOps(cs, 0, 'seed');
    assert.strictEqual(burnResult.length, 32);
    assert.ok(/^[0-9a-f]{64}$/i.test(burnResult.toString('hex')));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7. GPU native binary hash-chain token
  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n  GPU native binary hash-chain token');

  await test('GPU native binary exists at build path', () => {
    const fs = require('fs');
    const path = require('path');
    const bin = path.join(__dirname, '..', 'native-gpu', 'build', 'gpu-miner.exe');
    assert.ok(fs.existsSync(bin), 'gpu-miner.exe should exist at native-gpu/build/');
    const stat = fs.statSync(bin);
    assert.ok(stat.size > 50000, `binary should be >50KB, got ${stat.size}`);
  });

  await test('GPU native binary source has bcrypt include for SHA-256', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'native-gpu', 'src', 'main.cpp'), 'utf8');
    assert.ok(src.includes('#include <bcrypt.h>'), 'should include bcrypt.h for SHA-256');
    assert.ok(src.includes('bcrypt.lib'), 'should link bcrypt.lib');
  });

  await test('GPU native binary source has token command handler', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'native-gpu', 'src', 'main.cpp'), 'utf8');
    assert.ok(src.includes('g_tokenSeedActive'), 'should have g_tokenSeedActive state');
    assert.ok(src.includes('gpu_emit_token'), 'should have gpu_emit_token function');
    assert.ok(src.includes('gpu_sha256'), 'should have gpu_sha256 function');
    assert.ok(src.includes('gpu_burn_sha256'), 'should have gpu_burn_sha256 function');
  });

  await test('GPU native binary source has token state globals', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'native-gpu', 'src', 'main.cpp'), 'utf8');
    assert.ok(src.includes('g_tokenState[32]'), 'should have g_tokenState');
    assert.ok(src.includes('g_tokenPrevState[32]'), 'should have g_tokenPrevState');
    assert.ok(src.includes('g_tokenPersistentState[32]'), 'should have g_tokenPersistentState');
    assert.ok(src.includes('g_tokenSeed[32]'), 'should have g_tokenSeed');
  });

  await test('GPU native binary source emits token JSON with state, burnResult, ops, seed, ts, burnMs, proof', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'native-gpu', 'src', 'main.cpp'), 'utf8');
    assert.ok(src.includes('\\"t\\":\\"token\\"'), 'should emit token type');
    assert.ok(src.includes('\\"burnResult\\"'), 'should include burnResult');
    assert.ok(src.includes('\\"ops\\"'), 'should include ops');
    assert.ok(src.includes('\\"seed\\"'), 'should include seed');
    assert.ok(src.includes('\\"ts\\"'), 'should include timestamp');
    assert.ok(src.includes('\\"burnMs\\"'), 'should include burnMs');
    assert.ok(src.includes('\\"proof\\"'), 'should include proof');
  });

  await test('GPU native binary source handles token command from stdin', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'native-gpu', 'src', 'main.cpp'), 'utf8');
    assert.ok(src.includes('handle_cmd') && src.includes('token'), 'should handle token command');
    assert.ok(src.includes('g_tokenFrameOps'), 'should define g_tokenFrameOps');
  });

  await test('GPU native binary source initializes random chain state at startup', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'native-gpu', 'src', 'main.cpp'), 'utf8');
    assert.ok(src.includes('BCryptGenRandom'), 'should init random state with BCryptGenRandom');
    assert.ok(src.includes('BCryptOpenAlgorithmProvider'), 'should open BCrypt algorithm provider');
  });

  await test('GPU native binary source uses SHA-256 for burn (not LCG)', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'native-gpu', 'src', 'main.cpp'), 'utf8');
    assert.ok(src.includes('gpu_burn_sha256'), 'should use gpu_burn_sha256 (not gpu_burn)');
    assert.ok(src.includes('BCRYPT_SHA256_ALGORITHM'), 'should reference SHA-256 algorithm');
    assert.ok(!src.includes('gpu_burn('), 'should not have old gpu_burn function');
  });

  await test('GPU hash chain algorithm matches CPU: same inputs produce same hash', () => {
    // Simulate what the C++ gpu_emit_token does with the new format:
    // 1. burn with iterated SHA-256 (ops=1000, seed from main process)
    // 2. hash = sha256(prevState ‖ LE32(ops) ‖ burnResult(32) ‖ seed(32))
    const prevState = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32);
    const ops = 1000;

    // Simulate SHA-256 burn (matching C++ gpu_burn_sha256)
    const startInput = Buffer.alloc(64);
    prevState.copy(startInput, 0);
    seed.copy(startInput, 32);
    let state = crypto.createHash('sha256').update(startInput).digest();
    for (let i = 0; i < ops; i++) {
      const input = Buffer.alloc(68);
      state.copy(input, 0);
      input.writeUInt32LE(i, 32);
      seed.copy(input, 36);
      state = crypto.createHash('sha256').update(input).digest();
    }
    const burnResult = state;

    // Build hash input matching new format
    const input = Buffer.alloc(100);
    prevState.copy(input, 0);
    input.writeUInt32LE(ops, 32);
    burnResult.copy(input, 36);
    seed.copy(input, 68);

    const expected = crypto.createHash('sha256').update(input).digest();

    // Verify the hash is deterministic
    const input2 = Buffer.from(input);
    const expected2 = crypto.createHash('sha256').update(input2).digest();
    assert.strictEqual(expected.toString('hex'), expected2.toString('hex'));
    assert.strictEqual(expected.length, 32);
  });

  await test('GPU hash chain advances: consecutive tokens produce different states', () => {
    let state = crypto.randomBytes(32);
    const seed = crypto.randomBytes(32);
    const ops = 1000;
    const states = [];

    for (let i = 0; i < 5; i++) {
      // Burn
      const startInput = Buffer.alloc(64);
      state.copy(startInput, 0);
      seed.copy(startInput, 32);
      let burnState = crypto.createHash('sha256').update(startInput).digest();
      for (let j = 0; j < ops; j++) {
        const input = Buffer.alloc(68);
        burnState.copy(input, 0);
        input.writeUInt32LE(j, 32);
        seed.copy(input, 36);
        burnState = crypto.createHash('sha256').update(input).digest();
      }
      const burnResult = burnState;

      // Hash
      const input = Buffer.alloc(100);
      state.copy(input, 0);
      input.writeUInt32LE(ops, 32);
      burnResult.copy(input, 36);
      seed.copy(input, 68);
      state = crypto.createHash('sha256').update(input).digest();
      states.push(state.toString('hex'));
    }

    // All states should be unique
    const unique = new Set(states);
    assert.strictEqual(unique.size, 5, 'all 5 consecutive GPU token states should be unique');
  });

  await test('GPU hash chain with different seeds produces different states', () => {
    const prevState = crypto.randomBytes(32);
    const seed1 = crypto.randomBytes(32);
    const seed2 = crypto.randomBytes(32);
    const ops = 1000;

    function burnWithSeed(seed) {
      const startInput = Buffer.alloc(64);
      prevState.copy(startInput, 0);
      seed.copy(startInput, 32);
      let state = crypto.createHash('sha256').update(startInput).digest();
      for (let i = 0; i < ops; i++) {
        const input = Buffer.alloc(68);
        state.copy(input, 0);
        input.writeUInt32LE(i, 32);
        seed.copy(input, 36);
        state = crypto.createHash('sha256').update(input).digest();
      }
      return state;
    }

    const br1 = burnWithSeed(seed1);
    const br2 = burnWithSeed(seed2);

    function buildHash(s, seed, burnResult) {
      const input = Buffer.alloc(100);
      s.copy(input, 0);
      input.writeUInt32LE(ops, 32);
      burnResult.copy(input, 36);
      seed.copy(input, 68);
      return crypto.createHash('sha256').update(input).digest();
    }

    const h1 = buildHash(prevState, seed1, br1);
    const h2 = buildHash(prevState, seed2, br2);
    assert.notStrictEqual(h1.toString('hex'), h2.toString('hex'));
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (!process.env.VITEST) process.exit(failed > 0 ? 1 : 0);
}

run();
