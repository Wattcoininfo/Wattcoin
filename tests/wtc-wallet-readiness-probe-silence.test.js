'use strict';
/**
 * Risk: probe failures inside getWalletReadiness() are caught by `catch (_)`
 * and silently discarded.  When every peer throws (timeout, network error,
 * etc.), `connections` drops to 0 and `spendReady` becomes false with no
 * log entry explaining why.  This makes diagnosing connectivity problems
 * harder because there is no warning — only the symptom (spendReady=false).
 *
 * Expected outcome: the test PASSES by confirming the silence.
 * If a future change adds per-peer failure logging, update the assertion
 * to reflect the new behaviour.
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { createWtcNode } = require('../wtc-node');
const { generateKeypair } = require('../wtc-address');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function rmrf(t) { try { fs.rmSync(t, { recursive: true, force: true }); } catch (_) {} }

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-readiness-probe-silence-'));
  try {
    const dir      = path.join(baseDir, 'node');
    ensureDir(dir);

    const peerUrls = [
      'http://10.0.0.1:39310',
      'http://10.0.0.2:39310',
      'http://10.0.0.3:39310',
    ];

    // Capture any console.warn / console.error emitted during the test.
    const warnMessages  = [];
    const errorMessages = [];
    const origWarn  = console.warn;
    const origError = console.error;
    console.warn  = (...args) => warnMessages.push(args.map(String).join(' '));
    console.error = (...args) => errorMessages.push(args.map(String).join(' '));

    try {
      const node = createWtcNode({
        dataDir:                 dir,
        signingSecret:           'probe-silence-test',
        allowPartialQuorumCommit: true,
        // All peers are "known" via getActivePeers / getPeerTargets.
        getActivePeers:          () => peerUrls,
        getPeerTargets:          () => peerUrls,
        // Every peer probe throws a network timeout.
        requestPeerJson: async (peerUrl) => {
          throw new Error(`simulated network timeout for ${peerUrl}`);
        },
      });

      const readiness = await node.getWalletReadiness();

      // The call must succeed — no unhandled exception.
      assert.strictEqual(readiness.ok, true,
        'getWalletReadiness() should not throw when all peer probes fail');

      // Connections = 0 because every probe threw.
      assert.strictEqual(readiness.connections, 0,
        'connections should be 0 when all peer probes throw');

      // spendReady requires connections > 0, so it must be false.
      assert.strictEqual(readiness.spendReady, false,
        'spendReady should be false when connections = 0');

      // RISK: No console.warn was emitted explaining why connections dropped to 0.
      // The catch(_) in probePeer swallows all failure details silently.
      const relevantWarnings = [
        ...warnMessages,
        ...errorMessages,
      ].filter((m) =>
        m.includes('simulated network timeout') ||
        m.includes('probe fail') ||
        m.includes('unreachable') ||
        m.includes('10.0.0')
      );

      assert.strictEqual(relevantWarnings.length, 0,
        'RISK CONFIRMED: all probe failures are silently swallowed by catch(_) — ' +
        `no warning emitted even though all ${peerUrls.length} peer probes threw`);

    } finally {
      console.warn  = origWarn;
      console.error = origError;
    }

    console.log(
      '[PASS] wallet-readiness probe silence confirmed — ' +
      'connections=0 with spendReady=false and no diagnostic log'
    );
  } finally {
    rmrf(baseDir);
  }
}

run().catch((err) => {
  console.error('[FAIL] wtc-wallet-readiness-probe-silence:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
