'use strict';
/**
 * Deploys elec-price-api/ to wattcoin.ee.
 *
 * Run once to install the electricity price proxy endpoint:
 *   npm run deploy:elec-price-api
 *
 * The endpoint at https://wattcoin.ee/elec-price-api/ fetches the global
 * average electricity price from globalpetrolprices.com server-side,
 * caches the result for 24 hours, and returns JSON.  The whitepaper page
 * calls this endpoint instead of a third-party CORS proxy.
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
    '[deploy-elec-price-api] Error: credentials not set. Export SFTP_USER and SFTP_PASSWORD (or WATTCOIN_DEPLOY_USER / WATTCOIN_DEPLOY_PASSWORD).',
  );
  process.exit(1);
}
if (!SFTP_HOST_FINGERPRINT_SHA256) {
  console.error('[deploy-elec-price-api] Error: SFTP_HOST_FINGERPRINT_SHA256 environment variable must be set.');
  process.exit(1);
}

function normalizeFingerprint(value) {
  return String(value || '')
    .trim()
    .replace(/^SHA256:/i, '');
}

const expectedFingerprint = normalizeFingerprint(SFTP_HOST_FINGERPRINT_SHA256);

const FILES = [
  { local: path.join(ROOT, 'server', 'elec-price', 'index.php'), remote: 'htdocs/elec-price-api/index.php' },
  { local: path.join(ROOT, 'server', 'elec-price', '.htaccess'), remote: 'htdocs/elec-price-api/.htaccess' },
];

const conn = new Client();

conn.on('error', (e) => {
  console.error('[deploy-elec-price-api] SSH error:', e.message);
  process.exit(1);
});

conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => SFTP_PASSWORD)));

conn.on('ready', () => {
  conn.sftp(async (err, sftp) => {
    if (err) {
      console.error('[deploy-elec-price-api] SFTP error:', err.message);
      conn.end();
      process.exit(1);
    }

    // Ensure remote directory exists
    await new Promise((resolve) => {
      sftp.mkdir('htdocs/elec-price-api', (_e) => {
        resolve();
      }); // ignore error if already exists
    });

    for (const f of FILES) {
      await new Promise((resolve, reject) => {
        sftp.fastPut(f.local, f.remote, (err2) => {
          if (err2) return reject(err2);
          console.log('[deploy-elec-price-api] Uploaded', f.remote);
          resolve();
        });
      });
    }

    conn.end();
    console.log('[deploy-elec-price-api] Done.');
    console.log('[deploy-elec-price-api] Endpoint live at https://wattcoin.ee/elec-price-api/');
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
      console.error('[deploy-elec-price-api] Host key fingerprint mismatch. Refusing to connect.');
      return false;
    }
    return true;
  },
  tryKeyboard: true,
  authHandler: ['password', 'keyboard-interactive'],
});
