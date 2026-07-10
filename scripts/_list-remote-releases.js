'use strict';
const { Client } = require('ssh2');

const SFTP_HOST = process.env.SFTP_HOST || 'wattcoin.ee';
const SFTP_PORT = parseInt(process.env.SFTP_PORT || '1022', 10);
const SFTP_USER = process.env.SFTP_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD;
const SFTP_HOST_FINGERPRINT_SHA256 = (process.env.SFTP_HOST_FINGERPRINT_SHA256 || '').trim();

function normalizeFingerprint(value) {
  return String(value || '')
    .trim()
    .replace(/^SHA256:/i, '');
}

if (!SFTP_USER || !SFTP_PASSWORD) {
  console.error('Error: SFTP_USER and SFTP_PASSWORD must be set.');
  process.exit(1);
}
if (!SFTP_HOST_FINGERPRINT_SHA256) {
  console.error('Error: SFTP_HOST_FINGERPRINT_SHA256 environment variable must be set.');
  process.exit(1);
}

const expected = normalizeFingerprint(SFTP_HOST_FINGERPRINT_SHA256);

const conn = new Client();
conn.on('ready', () => {
  conn.sftp(async (err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      conn.end();
      return;
    }

    for (const dir of ['htdocs/releases', 'htdocs']) {
      console.log(`\n=== ${dir} ===`);
      await new Promise((resolve) => {
        sftp.readdir(dir, (e, list) => {
          if (e) {
            console.log('  (error reading dir:', e.message, ')');
            resolve();
            return;
          }
          const installers = list
            .filter((f) => /\.(exe|blockmap|yml)$/i.test(f.filename))
            .sort((a, b) => a.filename.localeCompare(b.filename));
          if (installers.length === 0) {
            console.log('  (no installer files)');
          }
          for (const f of installers) {
            const sizeMB = (f.attrs.size / 1024 / 1024).toFixed(1);
            console.log(`  ${f.filename}  (${sizeMB} MB)`);
          }
          resolve();
        });
      });
    }

    conn.end();
  });
});
conn.on('error', (e) => console.error('SSH error:', e.message));
conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => SFTP_PASSWORD)));
conn.connect({
  host: SFTP_HOST,
  port: SFTP_PORT,
  username: SFTP_USER,
  password: SFTP_PASSWORD,
  hostHash: 'sha256',
  hostVerifier: (hash) => {
    const actual = normalizeFingerprint(hash);
    if (actual !== expected) {
      console.error('Host key fingerprint mismatch. Refusing to connect.');
      return false;
    }
    return true;
  },
  tryKeyboard: true,
  authHandler: ['password', 'keyboard-interactive'],
});
