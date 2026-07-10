'use strict';
/**
 * Deploys only the whitepaper to wattcoin.ee.
 * Uploads wattcoin-whitepaper.html to both:
 *   htdocs/wattcoin-whitepaper.html  (direct URL)
 *   htdocs/index.html                (served at wattcoin.ee/)
 *
 * Uses the same ssh2/SFTP connection setup as _sftp-deploy.js.
 * Reads credentials from env:  SFTP_USER / SFTP_PASSWORD
 *                          or: WATTCOIN_DEPLOY_USER / WATTCOIN_DEPLOY_PASSWORD
 */
const { Client } = require('ssh2');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SFTP_HOST = process.env.SFTP_HOST || process.env.WATTCOIN_DEPLOY_HOST || 'wattcoin.ee';
const SFTP_PORT = parseInt(process.env.SFTP_PORT || process.env.WATTCOIN_DEPLOY_PORT || '1022', 10);
const SFTP_USER = process.env.SFTP_USER || process.env.WATTCOIN_DEPLOY_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD || process.env.WATTCOIN_DEPLOY_PASSWORD;

const SFTP_HOST_FINGERPRINT_SHA256 = (process.env.SFTP_HOST_FINGERPRINT_SHA256 || '').trim();

if (!SFTP_USER || !SFTP_PASSWORD) {
  console.error(
    '[deploy-whitepaper] Error: credentials not set. Export SFTP_USER and SFTP_PASSWORD (or WATTCOIN_DEPLOY_USER / WATTCOIN_DEPLOY_PASSWORD).',
  );
  process.exit(1);
}
if (!SFTP_HOST_FINGERPRINT_SHA256) {
  console.error('[deploy-whitepaper] Error: SFTP_HOST_FINGERPRINT_SHA256 environment variable must be set.');
  process.exit(1);
}

function normalizeFingerprint(value) {
  return String(value || '')
    .trim()
    .replace(/^SHA256:/i, '');
}

const expectedFingerprint = normalizeFingerprint(SFTP_HOST_FINGERPRINT_SHA256);

const localFile = path.join(ROOT, 'website/wattcoin-whitepaper.html');
// NOTE: Only deploys the *whitepaper page*, NOT the homepage (index.html).
// Use _sftp-deploy.js for full site deployment.
const FILES = [
  { local: localFile, remote: 'htdocs/wattcoin-whitepaper.html' },
  { local: path.join(ROOT, 'assets', 'whitepaper.css'), remote: 'htdocs/assets/whitepaper.css' },
];

const conn = new Client();

conn.on('error', (e) => {
  console.error('[deploy-whitepaper] SSH error:', e.message);
  process.exit(1);
});

conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => SFTP_PASSWORD)));

conn.on('ready', () => {
  conn.sftp(async (err, sftp) => {
    if (err) {
      console.error('[deploy-whitepaper] SFTP error:', err.message);
      conn.end();
      process.exit(1);
    }
    for (const f of FILES) {
      await new Promise((resolve, reject) => {
        sftp.fastPut(f.local, f.remote, (err2) => {
          if (err2) return reject(err2);
          console.log('[deploy-whitepaper] Uploaded', f.remote);
          resolve();
        });
      });
    }
    conn.end();
    console.log('[deploy-whitepaper] Done.');
  });
});

conn.connect({
  host: SFTP_HOST,
  port: SFTP_PORT,
  username: SFTP_USER,
  password: SFTP_PASSWORD,
  hostHash: 'sha256',
  hostVerifier: (hash) => {
    const actual = normalizeFingerprint(hash);
    if (actual !== expectedFingerprint) {
      console.error('[deploy-whitepaper] Host key fingerprint mismatch. Refusing to connect.');
      return false;
    }
    return true;
  },
  tryKeyboard: true,
  authHandler: ['password', 'keyboard-interactive'],
});
