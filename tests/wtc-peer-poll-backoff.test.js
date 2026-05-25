'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWtcNode } = require('../wtc-node');

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    // Best effort cleanup.
  }
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-peer-poll-backoff-'));
  const unreachablePeer = 'http://192.168.0.21:39310';
  let requestCount = 0;
  const warnings = [];
  const originalWarn = console.warn;

  const node = createWtcNode({
    dataDir: baseDir,
    signingSecret: 'peer-poll-backoff-test',
    allowPartialQuorumCommit: false,
    getActivePeers: () => [unreachablePeer],
    getPeerTargets: () => [unreachablePeer],
    requestPeerJson: async () => {
      requestCount += 1;
      throw new Error('Peer request timed out.');
    },
  });

  console.warn = (...args) => {
    warnings.push(args.map((value) => String(value)).join(' '));
  };

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await node.syncWithPeers();
      assert.strictEqual(result.ok, true, 'sync should degrade to a skipped result when peers are unreachable');
    }
  } finally {
    console.warn = originalWarn;
    rmrf(baseDir);
  }

  assert.strictEqual(requestCount, 4, 'unreachable peers should stop being polled once backoff is entered');
  assert.ok(warnings.every((entry) => entry.includes(unreachablePeer)), 'warning messages should identify the failing peer');

  console.log('wtc peer poll backoff tests passed');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});