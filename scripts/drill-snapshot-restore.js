'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWtcNode } = require('../electron-main/wtc-node');

const SNAPSHOT_RPO_TARGET_BLOCKS = 1;

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    /* ignore */
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function mineN(node, count) {
  const addr = node.getPrimaryAddress();
  for (let i = 0; i < count; i++) {
    await node.mineBlock(addr, { energyWh: 10_000_000, proofCommitment: `snapshot-drill-${i}` });
  }
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-drill-snapshot-'));
  const nodeDir = path.join(base, 'node');
  const snapshotDir = path.join(base, 'snapshot');
  fs.mkdirSync(nodeDir, { recursive: true });

  const node = createWtcNode({
    dataDir: nodeDir,
    signingSecret: 'snapshot-drill-secret',
    getActivePeers: () => [],
    requestPeerJson: () => Promise.resolve({ ok: false }),
  });

  await mineN(node, 6);
  const snapshotHeight = node.getHeight();
  const snapshotTip = node.getTip() ? node.getTip().hash : '';

  copyDir(nodeDir, snapshotDir);
  await mineN(node, 1);
  const preRestoreHeight = node.getHeight();

  const t0 = Date.now();
  rmrf(nodeDir);
  copyDir(snapshotDir, nodeDir);
  const restored = createWtcNode({
    dataDir: nodeDir,
    signingSecret: 'snapshot-drill-secret',
    getActivePeers: () => [],
    requestPeerJson: () => Promise.resolve({ ok: false }),
  });
  const rtoMs = Date.now() - t0;

  const restoredHeight = restored.getHeight();
  const restoredTip = restored.getTip() ? restored.getTip().hash : '';
  const rpoBlocks = Math.max(0, preRestoreHeight - restoredHeight);

  if (restoredHeight !== snapshotHeight || restoredTip !== snapshotTip) {
    throw new Error('restored chain does not match snapshot baseline');
  }
  if (rpoBlocks > SNAPSHOT_RPO_TARGET_BLOCKS) {
    throw new Error(`snapshot restore RPO ${rpoBlocks} exceeds target ${SNAPSHOT_RPO_TARGET_BLOCKS}`);
  }

  console.log('[durability:snapshot] PASS');
  console.log(' baselineHeight:', snapshotHeight);
  console.log(' restoredHeight:', restoredHeight);
  console.log(' rtoMs:', rtoMs);
  console.log(' rpoBlocks:', rpoBlocks);
  console.log(' rpoTargetBlocks:', SNAPSHOT_RPO_TARGET_BLOCKS);

  rmrf(base);
}

main().catch((err) => {
  console.error('[durability:snapshot] FAIL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
