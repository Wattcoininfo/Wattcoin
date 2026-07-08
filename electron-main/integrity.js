'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function createIntegrityVerifier(deps) {
  const { app, verifyManifestSignature } = deps;

  function verifyBinaryManifest() {
    if (!app.isPackaged) return { ok: true, checked: 0, skipped: 'dev-mode' };
    const manifestPath = path.join(process.resourcesPath, 'binary-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.warn('[BinaryIntegrity] binary-manifest.json not found - integrity check skipped.');
      return { ok: true, checked: 0, skipped: 'no-manifest' };
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const failures = [];
      let checked = 0;
      for (const [rel, expectedHash] of Object.entries(manifest)) {
        if (typeof expectedHash !== 'string' || expectedHash.length !== 64) continue;
        const absPath = path.join(process.resourcesPath, rel.split('/').join(path.sep));
        checked++;
        if (!fs.existsSync(absPath)) {
          failures.push({ rel, reason: 'missing' });
          console.error(`[BinaryIntegrity] MISSING: ${rel}`);
          continue;
        }
        const actualHash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
        if (actualHash !== expectedHash) {
          failures.push({ rel, reason: 'hash-mismatch' });
          console.error(`[BinaryIntegrity] TAMPER DETECTED: ${rel}`);
        }
      }
      if (failures.length > 0) return { ok: false, checked, failures };
      const sigOk = verifyManifestSignature(manifestPath, manifest);
      if (!sigOk) {
        console.warn(
          '[BinaryIntegrity] manifest signature invalid or missing - proceeding anyway (graceful fallback).',
        );
      }
      console.log(`[BinaryIntegrity] ${checked} bundled binaries verified OK.`);
      return { ok: true, checked, failures: [] };
    } catch (e) {
      console.error('[BinaryIntegrity] manifest read error:', e && e.message);
      return { ok: false, checked: 0, failures: [{ rel: 'manifest', reason: e && e.message }] };
    }
  }

  function verifyAppIntegrityManifest() {
    if (!app.isPackaged) return { ok: true, checked: 0, skipped: 'dev-mode' };
    const manifestPath = path.join(__dirname, 'app-integrity-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.warn('[AppIntegrity] app-integrity-manifest.json not found - integrity check skipped.');
      return { ok: true, checked: 0, skipped: 'no-manifest' };
    }
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const failures = [];
      let checked = 0;
      for (const [rel, expectedHash] of Object.entries(manifest)) {
        if (typeof expectedHash !== 'string' || expectedHash.length !== 64) continue;
        const absPath = path.join(__dirname, rel.split('/').join(path.sep));
        checked++;
        if (!fs.existsSync(absPath)) {
          failures.push({ rel, reason: 'missing' });
          console.error(`[AppIntegrity] MISSING: ${rel}`);
          continue;
        }
        const actualHash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
        if (actualHash !== expectedHash) {
          failures.push({ rel, reason: 'hash-mismatch' });
          console.error(`[AppIntegrity] TAMPER DETECTED: ${rel}`);
        }
      }
      if (failures.length > 0) return { ok: false, checked, failures };
      const sigOk = verifyManifestSignature(manifestPath, manifest);
      if (!sigOk) {
        console.warn('[AppIntegrity] manifest signature invalid or missing - proceeding anyway (graceful fallback).');
      }
      console.log(`[AppIntegrity] ${checked} app modules verified OK.`);
      return { ok: true, checked, failures: [] };
    } catch (e) {
      console.error('[AppIntegrity] manifest read error:', e && e.message);
      return { ok: false, checked: 0, failures: [{ rel: 'manifest', reason: e && e.message }] };
    }
  }

  function verifyReleaseDebuggerFriction() {
    if (!app.isPackaged) return { ok: true, skipped: 'dev-mode' };
    if (process.env.WATTCOIN_ALLOW_DEBUGGER === '1') return { ok: true, skipped: 'override' };

    const suspectArgs = [];
    const argv = [...process.execArgv, ...process.argv];
    for (const arg of argv) {
      const v = String(arg || '').toLowerCase();
      if (v.includes('--inspect') || v.includes('--remote-debugging-port') || v.includes('--debug-brk')) {
        suspectArgs.push(arg);
      }
    }
    const nodeOptions = String(process.env.NODE_OPTIONS || '').toLowerCase();
    if (nodeOptions.includes('inspect') || nodeOptions.includes('debug')) {
      suspectArgs.push(`NODE_OPTIONS=${process.env.NODE_OPTIONS}`);
    }
    if (suspectArgs.length > 0) {
      return { ok: false, reasons: suspectArgs };
    }
    return { ok: true };
  }

  return {
    verifyBinaryManifest,
    verifyAppIntegrityManifest,
    verifyReleaseDebuggerFriction,
  };
}

module.exports = { createIntegrityVerifier };
