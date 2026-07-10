'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWtcNode } = require('../electron-main/wtc-node');

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
    await node.mineBlock(addr, { energyWh: 10_000_000, proofCommitment: `corruption-drill-${i}` });
  }
}

async function main() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-drill-corrupt-'));
  const goodDir = path.join(base, 'good');
  const badDir = path.join(base, 'bad');
  fs.mkdirSync(goodDir, { recursive: true });

  const node = createWtcNode({
    dataDir: goodDir,
    signingSecret: 'corruption-drill-secret',
    getActivePeers: () => [],
    requestPeerJson: () => Promise.resolve({ ok: false }),
  });

  await mineN(node, 8);
  const baselineHeight = node.getHeight();
  const baselineTip = node.getTip() ? node.getTip().hash : '';

  copyDir(goodDir, badDir);
  const chainFile = path.join(badDir, 'wtc-chain.ndjson');
  const raw = fs.readFileSync(chainFile, 'utf8');
  const cut = Math.max(0, raw.length - Math.floor(raw.length / 6));
  fs.writeFileSync(chainFile, raw.slice(0, cut) + '\n{"invalid":', 'utf8');

  const degraded = createWtcNode({
    dataDir: badDir,
    signingSecret: 'corruption-drill-secret',
    getActivePeers: () => [],
    requestPeerJson: () => Promise.resolve({ ok: false }),
  });
  const degradedHeight = degraded.getHeight();

  const t0 = Date.now();
  fs.copyFileSync(path.join(goodDir, 'wtc-chain.ndjson'), path.join(badDir, 'wtc-chain.ndjson'));
  fs.copyFileSync(path.join(goodDir, 'wtc-accounts.json'), path.join(badDir, 'wtc-accounts.json'));
  const restored = createWtcNode({
    dataDir: badDir,
    signingSecret: 'corruption-drill-secret',
    getActivePeers: () => [],
    requestPeerJson: () => Promise.resolve({ ok: false }),
  });
  const rtoMs = Date.now() - t0;

  const restoredHeight = restored.getHeight();
  const restoredTip = restored.getTip() ? restored.getTip().hash : '';
  if (restoredHeight !== baselineHeight || restoredTip !== baselineTip) {
    throw new Error('restored state is not deterministic with baseline chain');
  }

  console.log('[durability:corruption] PASS');
  console.log(' degradedHeight:', degradedHeight);
  console.log(' baselineHeight:', baselineHeight);
  console.log(' restoredHeight:', restoredHeight);
  console.log(' rtoMs:', rtoMs);

  rmrf(base);
}

main().catch((err) => {
  console.error('[durability:corruption] FAIL', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
