const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function optionalString(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function optionalBoolean(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function findSignTool() {
  const configured = optionalString('WATTCOIN_SIGNTOOL_PATH');
  if (configured) {
    return path.resolve(configured);
  }

  const lookup = spawnSync('where.exe', ['signtool.exe'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (lookup.error || lookup.status !== 0) return null;

  const candidate = String(lookup.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return candidate || null;
}

function hasSigningIdentity() {
  return Boolean(
    optionalString('WATTCOIN_WINDOWS_CERT_FILE') ||
    optionalString('WATTCOIN_WINDOWS_CERT_SUBJECT_NAME') ||
    optionalString('CSC_LINK') ||
    optionalString('WIN_CSC_LINK'),
  );
}

function buildSignArgs(filePath) {
  const args = ['sign', '/fd', 'SHA256'];
  const rfc3161Url = optionalString('WATTCOIN_RFC3161_TIMESTAMP_URL');
  const timestampUrl = optionalString('WATTCOIN_TIMESTAMP_URL');
  const certificateFile = optionalString('WATTCOIN_WINDOWS_CERT_FILE');
  const certificatePassword = optionalString('WATTCOIN_WINDOWS_CERT_PASSWORD', 'WIN_CSC_KEY_PASSWORD');
  const certificateSubjectName = optionalString('WATTCOIN_WINDOWS_CERT_SUBJECT_NAME');

  if (rfc3161Url) {
    args.push('/tr', rfc3161Url, '/td', 'SHA256');
  } else if (timestampUrl) {
    args.push('/t', timestampUrl);
  }

  if (certificateFile) {
    args.push('/f', path.resolve(certificateFile));
    if (certificatePassword) {
      args.push('/p', certificatePassword);
    }
  } else if (certificateSubjectName) {
    args.push('/n', certificateSubjectName);
  } else {
    return null;
  }

  args.push(filePath);
  return args;
}

function collectSignTargets(resourcesDir) {
  const targets = [];
  const candidateDirs = [path.join(resourcesDir, 'bin'), path.join(resourcesDir, 'native-gpu')];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const nextPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(nextPath);
          continue;
        }
        if (/\.(exe|dll)$/i.test(entry.name)) {
          targets.push(nextPath);
        }
      }
    }
  }

  return targets;
}

exports.default = function afterSign(context) {
  if (context.electronPlatformName !== 'win32') return;

  const resourcesDir = path.join(context.appOutDir, 'resources');
  if (!fs.existsSync(resourcesDir)) return;

  const requireSigning = optionalBoolean('WATTCOIN_REQUIRE_WINDOWS_SIGNING', false);
  const targets = collectSignTargets(resourcesDir);

  // ── Authenticode-sign all bundled binaries ─────────────────────────────────
  if (hasSigningIdentity()) {
    const signTool = findSignTool();
    if (!signTool) {
      if (requireSigning) {
        throw new Error('Windows signing is required but signtool.exe was not found.');
      }
      console.warn('[after-sign-windows] signtool.exe not found; skipping extra resource signing.');
    } else {
      for (const target of targets) {
        const args = buildSignArgs(target);
        if (!args) {
          if (requireSigning) {
            throw new Error(
              'Windows signing is required but certificate settings are incomplete for extra resource signing.',
            );
          }
          console.warn(
            `[after-sign-windows] skipping ${target} because no supported certificate settings were provided.`,
          );
          continue;
        }

        const result = spawnSync(signTool, args, {
          encoding: 'utf8',
          windowsHide: true,
        });

        if (result.error || result.status !== 0) {
          const stderr = String(result.stderr || '').trim();
          const stdout = String(result.stdout || '').trim();
          const detail =
            stderr ||
            stdout ||
            (result.error && result.error.message) ||
            `signtool exited with status ${result.status}`;
          throw new Error(`Failed to sign bundled Windows binary ${target}: ${detail}`);
        }
      }
    }
  } else if (requireSigning) {
    throw new Error('Windows signing is required but no signing identity is configured.');
  }

  // ── SHA-256 binary manifest ────────────────────────────────────────────────
  // Generated after signing so hashes reflect the final signed state.
  // Verified at startup by verifyBinaryManifest() in electron-main.js before
  // the node daemon is launched — catches post-install binary replacement.
  if (targets.length > 0) {
    const manifest = {};
    for (const target of targets) {
      try {
        const rel = path.relative(resourcesDir, target).replace(/\\/g, '/');
        manifest[rel] = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
      } catch (_) {
        /* ignore */
      }
    }
    const manifestPath = path.join(resourcesDir, 'binary-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`[after-sign-windows] binary-manifest.json written (${Object.keys(manifest).length} entries).`);
  }
};
