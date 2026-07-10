'use strict';
/**
 * Deploys docs/seed-peers.mainnet.json to wattcoin.ee.
 *
 * The seed peer uses a DNS name (node.wattcoin.ee), so IP changes only
 * require updating the DNS A record — no code change or app rebuild needed.
 * This script is only needed to push manifest metadata changes (label, notes, etc.):
 *   npm run deploy:seed-manifest
 *
 * The remote manifest is fetched by all running clients every 5 minutes
 * (via ledgerSeedManifestUrls in wattcoin-beta-config.json), so existing
 * nodes pick up changes without reinstalling.
 *
 * Credentials (same as deploy-whitepaper):
 *   SFTP_USER / SFTP_PASSWORD
 *   or WATTCOIN_DEPLOY_USER / WATTCOIN_DEPLOY_PASSWORD
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
    '[deploy-seed-manifest] Error: credentials not set. Export SFTP_USER and SFTP_PASSWORD (or WATTCOIN_DEPLOY_USER / WATTCOIN_DEPLOY_PASSWORD).',
  );
  process.exit(1);
}
if (!SFTP_HOST_FINGERPRINT_SHA256) {
  console.error('[deploy-seed-manifest] Error: SFTP_HOST_FINGERPRINT_SHA256 environment variable must be set.');
  process.exit(1);
}

function normalizeFingerprint(value) {
  return String(value || '')
    .trim()
    .replace(/^SHA256:/i, '');
}

const expectedFingerprint = normalizeFingerprint(SFTP_HOST_FINGERPRINT_SHA256);

const localFile = path.join(ROOT, 'docs', 'seed-peers.mainnet.json');
const FILES = [{ local: localFile, remote: 'htdocs/seed-peers.mainnet.json' }];

const conn = new Client();

conn.on('error', (e) => {
  console.error('[deploy-seed-manifest] SSH error:', e.message);
  process.exit(1);
});

conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => SFTP_PASSWORD)));

conn.on('ready', () => {
  conn.sftp(async (err, sftp) => {
    if (err) {
      console.error('[deploy-seed-manifest] SFTP error:', err.message);
      conn.end();
      process.exit(1);
    }
    for (const f of FILES) {
      await new Promise((resolve, reject) => {
        sftp.fastPut(f.local, f.remote, (err2) => {
          if (err2) return reject(err2);
          console.log('[deploy-seed-manifest] Uploaded', f.remote);
          resolve();
        });
      });
    }
    conn.end();
    console.log('[deploy-seed-manifest] Done.');
    console.log('[deploy-seed-manifest] Existing clients will pick up the new seed peer within 5 minutes.');
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
      console.error('[deploy-seed-manifest] Host key fingerprint mismatch. Refusing to connect.');
      return false;
    }
    return true;
  },
  tryKeyboard: true,
  authHandler: ['password', 'keyboard-interactive'],
});
