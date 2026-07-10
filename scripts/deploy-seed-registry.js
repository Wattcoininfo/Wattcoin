'use strict';
const { Client } = require('ssh2');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SFTP_HOST = process.env.SFTP_HOST || process.env.WATTCOIN_DEPLOY_HOST || 'wattcoin.ee';
const SFTP_PORT = parseInt(process.env.SFTP_PORT || process.env.WATTCOIN_DEPLOY_PORT || '1022', 10);
const SFTP_USER = process.env.SFTP_USER || process.env.WATTCOIN_DEPLOY_USER;
const SFTP_PASSWORD = process.env.SFTP_PASSWORD || process.env.WATTCOIN_DEPLOY_PASSWORD;

const SFTP_HOST_FINGERPRINT_SHA256 = (process.env.SFTP_HOST_FINGERPRINT_SHA256 || '').trim();

if (!SFTP_USER || !SFTP_PASSWORD) {
  console.error('[deploy-seed-registry] Error: credentials not set.');
  process.exit(1);
}
if (!SFTP_HOST_FINGERPRINT_SHA256) {
  console.error('[deploy-seed-registry] Error: SFTP_HOST_FINGERPRINT_SHA256 environment variable must be set.');
  process.exit(1);
}

function normalizeFingerprint(value) {
  return String(value || '')
    .trim()
    .replace(/^SHA256:/i, '');
}

const expectedFingerprint = normalizeFingerprint(SFTP_HOST_FINGERPRINT_SHA256);

const FILES = [
  { local: path.join(ROOT, 'scripts', 'seed-registry-server.js'), remote: 'seed-registry/seed-registry-server.js' },
  { local: path.join(ROOT, 'scripts', 'seed-registry.service'), remote: 'seed-registry/seed-registry.service' },
  {
    local: path.join(ROOT, 'server', 'seed-registry', 'seed-registry-proxy.php'),
    remote: 'htdocs/api/seed-registry-proxy.php',
  },
];

function runCommand(conn, command) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (data) => {
        stdout += data.toString();
      });
      stream.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      stream.on('close', (code) => {
        if (code === 0) return resolve(stdout.trim());
        reject(new Error(`exit ${code}: ${(stderr || stdout).trim()}`));
      });
    });
  });
}

const conn = new Client();

conn.on('error', (e) => {
  console.error('[deploy-seed-registry] SSH error:', e.message);
  process.exit(1);
});

conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => SFTP_PASSWORD)));

conn.on('ready', async () => {
  try {
    // Step 1: SFTP upload files
    await new Promise((resolve, reject) => {
      conn.sftp(async (err, sftp) => {
        if (err) return reject(err);
        try {
          await new Promise((res, rej) => {
            sftp.mkdir('seed-registry', (err2) => {
              if (err2 && err2.code !== 4) return rej(err2);
              res();
            });
          });
          for (const f of FILES) {
            await new Promise((res, rej) => {
              sftp.fastPut(f.local, f.remote, (err2) => {
                if (err2) return rej(err2);
                console.log('[deploy-seed-registry] Uploaded', f.remote);
                res();
              });
            });
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });

    // Step 2: Detect process manager and start the service
    let pmAvailable = false;
    try {
      await runCommand(conn, 'command -v systemctl 2>/dev/null');
      pmAvailable = 'systemd';
    } catch (_) {
      /* ignore */
    }
    if (!pmAvailable) {
      try {
        await runCommand(conn, 'command -v pm2 2>/dev/null');
        pmAvailable = 'pm2';
      } catch (_) {
        /* ignore */
      }
    }

    if (pmAvailable === 'systemd') {
      console.log('[deploy-seed-registry] Installing systemd service...');
      await runCommand(conn, 'cp seed-registry/seed-registry.service /etc/systemd/system/');
      await runCommand(conn, 'systemctl daemon-reload');
      await runCommand(conn, 'systemctl enable seed-registry');
      await runCommand(conn, 'systemctl restart seed-registry');
      const status = await runCommand(conn, 'systemctl is-active seed-registry');
      console.log(`[deploy-seed-registry] Service status: ${status}`);
    } else if (pmAvailable === 'pm2') {
      console.log('[deploy-seed-registry] Starting via PM2...');
      // Stop any existing instance, then start fresh
      try {
        await runCommand(conn, 'pm2 delete seed-registry 2>/dev/null');
      } catch (_) {
        /* ignore */
      }
      await runCommand(
        conn,
        'pm2 start seed-registry/seed-registry-server.js --name seed-registry --interpreter /usr/local/bin/node',
      );
      await runCommand(conn, 'pm2 save');
      const status = await runCommand(conn, "pm2 show seed-registry 2>/dev/null | grep status | awk '{print $4}'");
      console.log(`[deploy-seed-registry] PM2 status: ${status || 'unknown'}`);
    } else {
      console.log('[deploy-seed-registry] No process manager found, starting with nohup...');
      try {
        await runCommand(conn, 'pkill -f seed-registry-server 2>/dev/null');
      } catch (_) {
        /* ignore */
      }
      await runCommand(
        conn,
        'nohup /usr/local/bin/node seed-registry/seed-registry-server.js > seed-registry/server.log 2>&1 &',
      );
      console.log('[deploy-seed-registry] Started seed-registry with nohup (PID in seed-registry/server.log)');
    }
    console.log('[deploy-seed-registry] Seed registry started.');

    // Step 3: Auto-configure reverse proxy
    await setupReverseProxy(conn);
  } catch (err) {
    console.error('[deploy-seed-registry] Error:', err.message);
  }
  conn.end();
});

// ── Reverse proxy auto-configuration ────────────────────────────────────
async function setupReverseProxy(conn) {
  let detected = null;
  for (const [name, probes] of [
    ['nginx', ['nginx -v']],
    ['caddy', ['caddy version']],
    ['apache', ['apache2ctl -v', 'httpd -v']],
  ]) {
    for (const cmd of probes) {
      try {
        await runCommand(conn, `${cmd} 2>/dev/null`);
        detected = name;
        break;
      } catch (_) {
        /* ignore */
      }
    }
    if (detected) break;
  }

  if (!detected) {
    console.warn('[deploy-seed-registry] No web server detected (nginx/caddy/apache).');
    console.warn('[deploy-seed-registry] Add reverse proxy manually: /api/seed-registry -> http://127.0.0.1:4901');
    return;
  }

  console.log(`[deploy-seed-registry] Detected web server: ${detected}`);

  if (detected === 'nginx') {
    await setupNginxProxy(conn);
  } else if (detected === 'apache') {
    await setupApacheProxy(conn);
  } else if (detected === 'caddy') {
    await setupCaddyProxy(conn);
  }
}

async function setupNginxProxy(conn) {
  const hostname = SFTP_HOST.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Find active site config containing the server_name
  let file;
  for (const dir of ['/etc/nginx/sites-enabled', '/etc/nginx/conf.d']) {
    try {
      file = await runCommand(conn, `grep -rl 'server_name.*${hostname}\\b' ${dir}/ 2>/dev/null | head -1`);
      if (file) break;
    } catch (_) {
      /* ignore */
    }
  }
  if (!file) {
    console.warn('[deploy-seed-registry] Could not find nginx server block for', SFTP_HOST);
    printManualConfig();
    return;
  }
  file = file.trim();

  // Write location snippet via heredoc
  await runCommand(
    conn,
    [
      "cat > /etc/nginx/seed-registry-location.conf << 'CONF'",
      'location /api/seed-registry {',
      '    proxy_pass http://127.0.0.1:4901;',
      '    proxy_http_version 1.1;',
      '    proxy_set_header Host $host;',
      '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '    proxy_set_header X-Forwarded-Proto $scheme;',
      '}',
      'CONF',
    ].join('\n'),
  );

  // Write the include directive as a separate file, then use sed 'r' to
  // insert it before the closing } of the server block.  This avoids the
  // tricky quoting that sed's i\ command requires when } is on the same line.
  const includeLine = '    include /etc/nginx/seed-registry-location.conf;';
  await runCommand(conn, `echo '${includeLine}' > /etc/nginx/seed-registry-include.conf`);

  const sedCmd = `sed -i '/server_name.*${hostname}/,/^}/ { /^}/r /etc/nginx/seed-registry-include.conf }' "${file}"`;

  try {
    await runCommand(conn, sedCmd);
    await runCommand(conn, 'nginx -t');
    await runCommand(conn, 'systemctl reload nginx 2>/dev/null || nginx -s reload');
    console.log('[deploy-seed-registry] nginx proxy configured: /api/seed-registry -> http://127.0.0.1:4901');
  } catch (err) {
    console.warn('[deploy-seed-registry] nginx config failed:', err.message);
    try {
      await runCommand(conn, `sed -i '/seed-registry-location\\.conf/d' "${file}"`);
    } catch (_) {
      /* ignore */
    }
    printManualConfig();
  }
}

async function setupApacheProxy(conn) {
  // For shared hosting (no root): deploy PHP proxy + .htaccess rewrite
  try {
    const htaccess = [
      'Options -Indexes',
      'RewriteEngine On',
      'RewriteBase /api/',
      'RewriteRule ^seed-registry seed-registry-proxy.php [L,QSA]',
      'RewriteCond %{REQUEST_FILENAME} !-f',
      'RewriteRule ^ index.php [L,QSA]',
    ].join('\n');
    await runCommand(conn, `cat > htdocs/api/.htaccess << 'HTA'\n${htaccess}\nHTA`);
    console.log(
      '[deploy-seed-registry] Apache proxy configured (PHP proxy + .htaccess): /api/seed-registry -> http://127.0.0.1:4901',
    );
  } catch (err) {
    console.warn('[deploy-seed-registry] Apache config failed:', err.message);
    printManualConfig();
  }
}

async function setupCaddyProxy(conn) {
  let caddyfile = null;
  for (const f of ['/etc/caddy/Caddyfile', '/etc/caddy/Caddyfile.json']) {
    try {
      await runCommand(conn, `test -f ${f}`);
      caddyfile = f;
      break;
    } catch (_) {
      /* ignore */
    }
  }
  if (!caddyfile) {
    try {
      const out = await runCommand(conn, 'caddy environ 2>/dev/null | grep -i CADDYFILE || true');
      if (out) {
        const parts = out.split('=');
        if (parts.length > 1) caddyfile = parts.slice(1).join('=').trim();
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!caddyfile) {
    console.warn('[deploy-seed-registry] Could not find Caddyfile.');
    printManualConfig();
    return;
  }

  // Only append to plain-text Caddyfile, not JSON config
  if (caddyfile.endsWith('.json')) {
    console.warn(
      '[deploy-seed-registry] Caddy uses JSON config. Add manual route: /api/seed-registry -> 127.0.0.1:4901',
    );
    printManualConfig();
    return;
  }

  try {
    await runCommand(
      conn,
      [
        `cat >> "${caddyfile}" << 'CADDY'`,
        '',
        'handle_path /api/seed-registry* {',
        '    reverse_proxy 127.0.0.1:4901',
        '}',
        'CADDY',
      ].join('\n'),
    );
    await runCommand(
      conn,
      'systemctl reload caddy 2>/dev/null || caddy reload --config "' + caddyfile + '" 2>/dev/null',
    );
    console.log('[deploy-seed-registry] Caddy proxy configured: /api/seed-registry -> http://127.0.0.1:4901');
  } catch (err) {
    console.warn('[deploy-seed-registry] Caddy config failed:', err.message);
    try {
      await runCommand(conn, `sed -i '/reverse_proxy 127\\.0\\.0\\.1:4901/d' "${caddyfile}"`);
    } catch (_) {
      /* ignore */
    }
    printManualConfig();
  }
}

function printManualConfig() {
  console.log('[deploy-seed-registry] Add manually: /api/seed-registry -> http://127.0.0.1:4901');
  console.log('[deploy-seed-registry] (handles GET manifest + POST heartbeat)');
}

conn.connect({
  host: SFTP_HOST,
  port: SFTP_PORT,
  username: SFTP_USER,
  password: SFTP_PASSWORD,
  hostHash: 'sha256',
  hostVerifier: (hash) => {
    const actual = normalizeFingerprint(hash);
    if (actual !== expectedFingerprint) {
      console.error('[deploy-seed-registry] Host key fingerprint mismatch.');
      return false;
    }
    return true;
  },
  tryKeyboard: true,
  authHandler: ['password', 'keyboard-interactive'],
});
