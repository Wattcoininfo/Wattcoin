// Usage: node scripts/sign-integrity-manifest.js [--private-key env:VAR|path/to/key.pem]
// Signs app-integrity-manifest.json and binary-manifest.json with an ED25519 key.
// If --private-key is omitted, uses the WATTCOIN_SIGN_KEY env var.
//
// The corresponding public key must match MANIFEST_SIGNING_PUBLIC_KEY in
// electron-main.js.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function getPrivateKey() {
  const arg = process.argv.find((a) => a.startsWith('--private-key='));
  if (arg) {
    const val = arg.split('=', 2)[1];
    if (val.startsWith('env:')) {
      const envVar = val.slice(4);
      const envVal = process.env[envVar];
      if (!envVal) throw new Error(`Environment variable ${envVar} is not set`);
      return envVal;
    }
    return fs.readFileSync(val, 'utf8');
  }
  if (process.env.WATTCOIN_SIGN_KEY) return process.env.WATTCOIN_SIGN_KEY;
  throw new Error(
    'No signing key provided. Use --private-key=path/to/key.pem, --private-key=env:VAR, or set WATTCOIN_SIGN_KEY.',
  );
}

function signManifest(manifestRelPath) {
  const manifestPath = path.join(ROOT, manifestRelPath);
  if (!fs.existsSync(manifestPath)) {
    console.warn(`[sign] ${manifestRelPath} not found — skipping.`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const canonical = Buffer.from(JSON.stringify(manifest), 'utf8');
  const key = crypto.createPrivateKey({ key: getPrivateKey(), format: 'pem', type: 'pkcs8' });
  const signature = crypto.sign(null, canonical, key);
  const sigPath = manifestPath + '.sig';
  fs.writeFileSync(sigPath, signature);
  console.log(`[sign] Signed ${manifestRelPath} -> ${path.basename(sigPath)} (${signature.length} bytes)`);
}

console.log('[sign] Integrity manifest signer');
signManifest('app-integrity-manifest.json');
signManifest('binary-manifest.json');
console.log('[sign] Done.');
