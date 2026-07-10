'use strict';
/**
 * drill-scheduler.js
 *
 * Runs durability drills on a schedule:
 *   - Snapshot/restore drill:    daily  (every 24 hours)
 *   - Corruption/replay drill:   weekly (every 7 days)
 *
 * Each run writes timestamped evidence under artifacts/drill-evidence/.
 *
 * Usage:
 *   node scripts/drill-scheduler.js
 *   node scripts/drill-scheduler.js --once          # run both drills once and exit
 *   node scripts/drill-scheduler.js --snapshot-only # run snapshot drill once and exit
 *   node scripts/drill-scheduler.js --corruption-only # run corruption drill once and exit
 *
 * Evidence file layout:
 *   artifacts/drill-evidence/
 *     YYYY-MM-DDTHH-MM-SS-mmmZ-snapshot.json
 *     YYYY-MM-DDTHH-MM-SS-mmmZ-corruption.json
 *
 * Each evidence file contains:
 *   { drillType, startedAt, finishedAt, ok, rtoMs, rpoBlocks?, baselineHeight,
 *     restoredHeight, tipHash, error? }
 *
 * Exit codes:
 *   0 — scheduled mode (never exits)
 *   0 — --once / --snapshot-only / --corruption-only all drills passed
 *   1 — one or more drills failed in --once mode
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const EVIDENCE_DIR = path.join(__dirname, '..', 'artifacts', 'drill-evidence');
const SNAPSHOT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CORRUPTION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ─── helpers ─────────────────────────────────────────────────────────────────

function isoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureEvidenceDir() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
}

function writeEvidence(drillType, payload) {
  ensureEvidenceDir();
  const filename = `${isoStamp()}-${drillType}.json`;
  const full = path.join(EVIDENCE_DIR, filename);
  fs.writeFileSync(full, JSON.stringify(payload, null, 2), 'utf8');
  return filename;
}

function runScript(scriptName) {
  const isWin = process.platform === 'win32';
  const executable = isWin ? process.env.ComSpec || 'cmd.exe' : 'npm';
  const args = isWin ? ['/c', 'npm', 'run', scriptName] : ['run', scriptName];

  const result = spawnSync(executable, args, {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: false,
  });

  const stdout = result.stdout ? result.stdout.toString('utf8') : '';
  const stderr = result.stderr ? result.stderr.toString('utf8') : '';
  const output = stdout + stderr;

  if (result.error) {
    throw new Error(`${scriptName} spawn error: ${result.error.message || result.error}`);
  }
  if (result.status !== 0) {
    throw Object.assign(new Error(`${scriptName} exited with code ${result.status}`), { output });
  }
  return output;
}

// ─── parse output for evidence metrics ───────────────────────────────────────

function parseSnapshotOutput(output) {
  const rto = output.match(/rtoMs:\s*(\d+)/);
  const rpo = output.match(/rpoBlocks:\s*(\d+)/);
  const base = output.match(/baselineHeight:\s*(\d+)/);
  const rest = output.match(/restoredHeight:\s*(\d+)/);
  return {
    rtoMs: rto ? Number(rto[1]) : null,
    rpoBlocks: rpo ? Number(rpo[1]) : null,
    baselineHeight: base ? Number(base[1]) : null,
    restoredHeight: rest ? Number(rest[1]) : null,
  };
}

function parseCorruptionOutput(output) {
  const rto = output.match(/rtoMs:\s*(\d+)/);
  const base = output.match(/baselineHeight:\s*(\d+)/);
  const rest = output.match(/restoredHeight:\s*(\d+)/);
  const deg = output.match(/degradedHeight:\s*(\d+)/);
  return {
    rtoMs: rto ? Number(rto[1]) : null,
    baselineHeight: base ? Number(base[1]) : null,
    restoredHeight: rest ? Number(rest[1]) : null,
    degradedHeight: deg ? Number(deg[1]) : null,
  };
}

// ─── drill runners ────────────────────────────────────────────────────────────

function runSnapshotDrill() {
  const startedAt = new Date().toISOString();
  console.log(`[drill-scheduler] [${startedAt}] Starting snapshot/restore drill`);
  const evidence = { drillType: 'snapshot', startedAt, finishedAt: null, ok: false };

  try {
    const output = runScript('mainnet:durability:snapshot');
    const metrics = parseSnapshotOutput(output);
    evidence.ok = true;
    evidence.finishedAt = new Date().toISOString();
    evidence.rtoMs = metrics.rtoMs;
    evidence.rpoBlocks = metrics.rpoBlocks;
    evidence.baselineHeight = metrics.baselineHeight;
    evidence.restoredHeight = metrics.restoredHeight;
    console.log(`[drill-scheduler] Snapshot drill PASS  rto=${metrics.rtoMs}ms rpo=${metrics.rpoBlocks}blk`);
  } catch (err) {
    evidence.ok = false;
    evidence.finishedAt = new Date().toISOString();
    evidence.error = err && err.message ? err.message : String(err);
    evidence.output = err && err.output ? err.output : '';
    console.error(`[drill-scheduler] Snapshot drill FAIL: ${evidence.error}`);
  }

  const filename = writeEvidence('snapshot', evidence);
  console.log(`[drill-scheduler] Evidence written: ${filename}`);
  return evidence.ok;
}

function runCorruptionDrill() {
  const startedAt = new Date().toISOString();
  console.log(`[drill-scheduler] [${startedAt}] Starting corruption/replay drill`);
  const evidence = { drillType: 'corruption', startedAt, finishedAt: null, ok: false };

  try {
    const output = runScript('mainnet:durability:corruption');
    const metrics = parseCorruptionOutput(output);
    evidence.ok = true;
    evidence.finishedAt = new Date().toISOString();
    evidence.rtoMs = metrics.rtoMs;
    evidence.baselineHeight = metrics.baselineHeight;
    evidence.restoredHeight = metrics.restoredHeight;
    evidence.degradedHeight = metrics.degradedHeight;
    console.log(
      `[drill-scheduler] Corruption drill PASS  rto=${metrics.rtoMs}ms degraded=${metrics.degradedHeight} restored=${metrics.restoredHeight}`,
    );
  } catch (err) {
    evidence.ok = false;
    evidence.finishedAt = new Date().toISOString();
    evidence.error = err && err.message ? err.message : String(err);
    evidence.output = err && err.output ? err.output : '';
    console.error(`[drill-scheduler] Corruption drill FAIL: ${evidence.error}`);
  }

  const filename = writeEvidence('corruption', evidence);
  console.log(`[drill-scheduler] Evidence written: ${filename}`);
  return evidence.ok;
}

// ─── scheduled loop ───────────────────────────────────────────────────────────

function startScheduler() {
  console.log('[drill-scheduler] Starting in scheduled mode');
  console.log(`  snapshot  interval: every ${SNAPSHOT_INTERVAL_MS / 3600000}h`);
  console.log(`  corruption interval: every ${CORRUPTION_INTERVAL_MS / 3600000}h`);
  console.log(`  evidence dir: ${EVIDENCE_DIR}`);

  // Run both immediately on start, then on schedule
  runSnapshotDrill();
  runCorruptionDrill();

  setInterval(() => {
    runSnapshotDrill();
  }, SNAPSHOT_INTERVAL_MS);

  setInterval(() => {
    runCorruptionDrill();
  }, CORRUPTION_INTERVAL_MS);
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--snapshot-only')) {
  const ok = runSnapshotDrill();
  process.exit(ok ? 0 : 1);
} else if (args.includes('--corruption-only')) {
  const ok = runCorruptionDrill();
  process.exit(ok ? 0 : 1);
} else if (args.includes('--once')) {
  const snapOk = runSnapshotDrill();
  const corrOk = runCorruptionDrill();
  process.exit(snapOk && corrOk ? 0 : 1);
} else {
  startScheduler();
}
