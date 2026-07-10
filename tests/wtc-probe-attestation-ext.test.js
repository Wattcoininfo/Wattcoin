'use strict';
/**
 * wtc-probe-attestation-ext.test.js
 *
 * Extended probe attestation tests covering gaps from the audit:
 *   - Probe receipt minimum verifier requirement
 *   - Bootstrap verifier requirement
 *   - Chain index bounds (replay prevention)
 *   - Energy-per-probe limit enforcement
 *   - Attested power uses minimum across verifiers
 */

const assert = require('assert');

// Inline validation logic matching electron-main.js validateContributionProbe
function validateContributionProbe({
  address,
  totalWh,
  chainIndex,
  witnessedProbeReceipts,
  bootstrapPeerAddresses,
  MIN_PROBE_VERIFIERS,
  PROBE_INTERVAL_MS,
}) {
  let attestedPowerW = 0;

  if (witnessedProbeReceipts.has(address)) {
    const verifiedEntry = witnessedProbeReceipts.get(address);
    const receiptsForClaimedIndex = verifiedEntry.receipts.get(chainIndex) || new Map();

    const hasBootstrapVerifier = [...receiptsForClaimedIndex.keys()].some((vAddr) => bootstrapPeerAddresses.has(vAddr));

    if (receiptsForClaimedIndex.size < MIN_PROBE_VERIFIERS) {
      if (!(hasBootstrapVerifier && receiptsForClaimedIndex.size >= 1)) {
        return {
          ok: false,
          code: 'INSUFFICIENT_PROBE_ATTESTATIONS',
          message: `chainIndex ${chainIndex} has only ${receiptsForClaimedIndex.size} verifiers, requires ${MIN_PROBE_VERIFIERS}`,
        };
      }
    }

    if (!hasBootstrapVerifier) {
      return {
        ok: false,
        code: 'MISSING_BOOTSTRAP_VERIFIER',
        message: 'no bootstrap verifier',
      };
    }

    const verifiedMax = Math.max(0, verifiedEntry.maxChainIndex || 0);
    if (chainIndex > verifiedMax + 1) {
      return {
        ok: false,
        code: 'PROBE_CHAIN_EXCEEDS_VERIFIED',
        message: `chainIndex ${chainIndex} exceeds verified max ${verifiedMax} by more than 1`,
      };
    }

    const powerValues = [];
    for (const receipt of receiptsForClaimedIndex.values()) {
      if (receipt.hwPowerW > 0) powerValues.push(receipt.hwPowerW);
    }
    if (powerValues.length > 0) {
      attestedPowerW = Math.min(...powerValues);
    }
    if (attestedPowerW <= 0) {
      return { ok: false, code: 'CONTRIBUTION_NO_VERIFIED_POWER', message: 'no verified power' };
    }

    const MAX_WH_PER_PROBE = (attestedPowerW * PROBE_INTERVAL_MS) / 3600000;
    const maxWhForChainIndex = chainIndex * MAX_WH_PER_PROBE;
    if (totalWh > maxWhForChainIndex) {
      return {
        ok: false,
        code: 'CONTRIBUTION_EXCEEDS_PROBE_LIMIT',
        message: `totalWh ${totalWh} exceeds max ${maxWhForChainIndex.toFixed(2)}`,
      };
    }
  } else if (chainIndex > 0) {
    return { ok: false, code: 'INSUFFICIENT_PROBE_ATTESTATIONS', message: 'No attestations' };
  } else if (totalWh > 0) {
    return { ok: false, code: 'CONTRIBUTION_EXCEEDS_PROBE_LIMIT', message: 'No attestations' };
  }

  return { ok: true, attestedPowerW };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReceipt(verifierAddr, hwPowerW) {
  return { verifierAddress: verifierAddr, hwPowerW, type: 'cpu', wallClockMs: 500 };
}

/**
 * Create a witnessed entry with attestations for a single chainIndex.
 */
function makeWitnessedEntry(chainIndex, verifiersByAddr) {
  const receipts = new Map();
  for (const [vAddr, hwPowerW] of Object.entries(verifiersByAddr)) {
    receipts.set(vAddr, makeReceipt(vAddr, hwPowerW));
  }
  const receiptsByChain = new Map();
  receiptsByChain.set(chainIndex, receipts);
  return { receipts: receiptsByChain, maxChainIndex: chainIndex };
}

let passed = 0,
  failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}

async function run() {
  // ─── Valid probe attestation passes ──────────────────────────────────────
  await test('Valid probe attestation with 3 verifiers including bootstrap passes', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'bootstrap-peer': 100,
        'peer-2': 100,
        'peer-3': 100,
      }),
    );

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 1,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.ok(result.ok, 'valid probe attestation must pass');
    assert.ok(result.attestedPowerW > 0);
  });

  // ─── Single bootstrap verifier is sufficient ────────────────────────────
  await test('Single bootstrap verifier passes even below MIN_PROBE_VERIFIERS', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'bootstrap-peer': 100,
      }),
    );

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 1,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.ok(result.ok, 'single bootstrap verifier must be accepted');
    assert.ok(result.attestedPowerW > 0);
  });

  // ─── Single non-bootstrap verifier rejected ────────────────────────────
  await test('Single non-bootstrap verifier rejected below MIN_PROBE_VERIFIERS', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'random-peer': 100,
      }),
    );

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 1,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INSUFFICIENT_PROBE_ATTESTATIONS');
  });

  // ─── Insufficient verifiers without bootstrap rejected ──────────────────
  await test('2 non-bootstrap verifiers rejected', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'peer-1': 100,
        'peer-2': 100,
      }),
    );

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 1,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INSUFFICIENT_PROBE_ATTESTATIONS');
  });

  // ─── Missing bootstrap verifier rejected ─────────────────────────────────
  await test('Missing bootstrap verifier rejected', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'peer-1': 100,
        'peer-2': 100,
        'peer-3': 100,
      }),
    );

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 1,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'MISSING_BOOTSTRAP_VERIFIER');
  });

  // ─── Chain index gap > 1 rejected (replay prevention) ────────────────────
  await test('Chain index gap > 1 rejected (no attestations for claimed index)', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'bootstrap-peer': 100,
        'peer-2': 100,
        'peer-3': 100,
      }),
    );

    // chainIndex=3 has no attestations in the map → insufficient attestations
    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 3,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    // Without attestations for chainIndex=3, it fails at the attestation check
    assert.ok(
      result.code === 'INSUFFICIENT_PROBE_ATTESTATIONS',
      `expected INSUFFICIENT_PROBE_ATTESTATIONS, got ${result.code}`,
    );
  });

  // ─── Chain index above maxVerified+1 rejected ────────────────────────────
  await test('Chain index above maxVerified+1 rejected when attestations exist', () => {
    const witnessedProbeReceipts = new Map();
    // Attestations exist for chainIndex 1 and 2 (maxChainIndex=2)
    const entry = makeWitnessedEntry(2, {
      'bootstrap-peer': 100,
      'peer-2': 100,
      'peer-3': 100,
    });
    // Also add chainIndex 3 attestations to pass the initial check
    const receiptsFor3 = new Map();
    receiptsFor3.set('bootstrap-peer', makeReceipt('bootstrap-peer', 100));
    receiptsFor3.set('peer-2', makeReceipt('peer-2', 100));
    receiptsFor3.set('peer-3', makeReceipt('peer-3', 100));
    entry.receipts.set(3, receiptsFor3);
    witnessedProbeReceipts.set('miner-addr', entry); // maxChainIndex=2

    // chainIndex=4 has attestations (passes count check) but exceeds maxVerified+1
    const receiptsFor4 = new Map();
    receiptsFor4.set('bootstrap-peer', makeReceipt('bootstrap-peer', 100));
    receiptsFor4.set('peer-2', makeReceipt('peer-2', 100));
    receiptsFor4.set('peer-3', makeReceipt('peer-3', 100));
    entry.receipts.set(4, receiptsFor4);

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 4,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'PROBE_CHAIN_EXCEEDS_VERIFIED');
  });

  // ─── Adjacent chain index accepted ───────────────────────────────────────
  await test('Adjacent chain index (maxVerified+1) accepted when attestations exist', () => {
    const witnessedProbeReceipts = new Map();
    const entry = makeWitnessedEntry(2, {
      'bootstrap-peer': 100,
      'peer-2': 100,
      'peer-3': 100,
    }); // maxChainIndex=2
    const receiptsFor3 = new Map();
    receiptsFor3.set('bootstrap-peer', makeReceipt('bootstrap-peer', 100));
    receiptsFor3.set('peer-2', makeReceipt('peer-2', 100));
    receiptsFor3.set('peer-3', makeReceipt('peer-3', 100));
    entry.receipts.set(3, receiptsFor3);
    witnessedProbeReceipts.set('miner-addr', entry);

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 3,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.ok(result.ok, 'adjacent chain index (3 when max=2) must be accepted');
  });

  // ─── Contribution exceeds probe power limit rejected ─────────────────────
  await test('Contribution exceeding probe power limit rejected', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'bootstrap-peer': 100,
        'peer-2': 100,
        'peer-3': 100,
      }),
    );

    // attested 100W, PROBE_INTERVAL_MS=60000
    // MAX_WH_PER_PROBE = 100 * 60000 / 3600000 = 1.666...
    // maxWhForChainIndex = 1 * 1.666... = 1.666...
    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 100,
      chainIndex: 1,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'CONTRIBUTION_EXCEEDS_PROBE_LIMIT');
  });

  // ─── No attestations with chainIndex > 0 rejected ────────────────────────
  await test('No attestations with chainIndex > 0 rejected', () => {
    const result = validateContributionProbe({
      address: 'new-miner',
      totalWh: 10,
      chainIndex: 1,
      witnessedProbeReceipts: new Map(),
      bootstrapPeerAddresses: new Set(['bootstrap']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'INSUFFICIENT_PROBE_ATTESTATIONS');
  });

  // ─── No attestations with chainIndex=0 and totalWh>0 rejected ────────────
  await test('No attestations with chainIndex=0 and totalWh>0 rejected', () => {
    const result = validateContributionProbe({
      address: 'new-miner',
      totalWh: 5,
      chainIndex: 0,
      witnessedProbeReceipts: new Map(),
      bootstrapPeerAddresses: new Set(['bootstrap']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'CONTRIBUTION_EXCEEDS_PROBE_LIMIT');
  });

  // ─── Attested power uses min across verifiers ────────────────────────────
  await test('Attested power takes minimum across verifier reports', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'bootstrap-peer': 500,
        'peer-2': 300,
        'peer-3': 400,
      }),
    );

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 1,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.ok(result.ok);
    assert.strictEqual(result.attestedPowerW, 300, 'attested power = min(500, 300, 400)');
  });

  // ─── Attested power 0 rejected even with 3 verifiers ─────────────────────
  await test('All verifiers report zero power → CONTRIBUTION_NO_VERIFIED_POWER', () => {
    const witnessedProbeReceipts = new Map();
    witnessedProbeReceipts.set(
      'miner-addr',
      makeWitnessedEntry(1, {
        'bootstrap-peer': 0,
        'peer-2': 0,
        'peer-3': 0,
      }),
    );

    const result = validateContributionProbe({
      address: 'miner-addr',
      totalWh: 1,
      chainIndex: 1,
      witnessedProbeReceipts,
      bootstrapPeerAddresses: new Set(['bootstrap-peer']),
      MIN_PROBE_VERIFIERS: 3,
      PROBE_INTERVAL_MS: 60000,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'CONTRIBUTION_NO_VERIFIED_POWER');
  });

  console.log('');
  console.log(`  Probe attestation: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
