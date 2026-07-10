'use strict';
// One-time script: deletes all old installer .exe and .exe.blockmap files from the server,
// keeping only the current version (from package.json).
const { Client } = require('ssh2');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const currentExe = `Wattcoin Miner Setup ${version}.exe`;
const currentBlockmap = `${currentExe}.blockmap`;

console.log(`Current version: ${version}`);
console.log(`Keeping: "${currentExe}" and "${currentBlockmap}"`);

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

function isInstallerFile(filename) {
  return /\.(exe|exe\.blockmap)$/i.test(filename) && /wattcoin.miner.setup/i.test(filename);
}

const conn = new Client();
conn.on('ready', () => {
  conn.sftp(async (err, sftp) => {
    if (err) {
      console.error('SFTP error:', err.message);
      conn.end();
      return;
    }

    let totalDeleted = 0;

    for (const dir of ['htdocs/releases', 'htdocs']) {
      console.log(`\nScanning ${dir}...`);
      const keepSet = new Set([`${dir}/${currentExe}`, `${dir}/${currentBlockmap}`]);

      const entries = await new Promise((resolve) => {
        sftp.readdir(dir, (e, list) => {
          if (e) {
            console.log(`  (error reading: ${e.message})`);
            resolve([]);
          } else resolve(list);
        });
      });

      const toDelete = entries.filter((e) => isInstallerFile(e.filename) && !keepSet.has(`${dir}/${e.filename}`));
      console.log(`  Found ${toDelete.length} old installer(s) to delete.`);

      for (const entry of toDelete) {
        const remotePath = `${dir}/${entry.filename}`;
        await new Promise((resolve) => {
          sftp.unlink(remotePath, (e) => {
            if (e) console.warn(`  Could not delete ${remotePath}: ${e.message}`);
            else {
              console.log(`  Deleted: ${entry.filename}`);
              totalDeleted++;
            }
            resolve();
          });
        });
      }
    }

    conn.end();
    console.log(`\nDone. Deleted ${totalDeleted} old installer file(s).`);
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
