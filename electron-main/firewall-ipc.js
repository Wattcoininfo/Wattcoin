const path = require('path');
const os = require('os');
const fs = require('fs');

const FIREWALL_SENTINEL = path.join(os.homedir(), 'WattcoinMinerUserData', 'firewall-consented.sentinel');

function registerFirewallIpcHandlers(ipcMain, deps) {
  const { app } = deps;

  ipcMain.handle('wattcoin-get-network-info', () => {
    return {
      ok: true,
      network: 'wtc-mainnet',
      chainSubdir: '',
      rpcPort: 0,
      explorerBaseUrl: '',
    };
  });

  ipcMain.handle('wattcoin-check-firewall-rule', () => {
    if (process.platform !== 'win32') return { windows: false };
    const { spawnSync } = require('child_process');
    const errors = [];

    try {
      const FW_RULE_NAME = 'Wattcoin Miner Ledger Network (TCP 39310)';
      const result = spawnSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FW_RULE_NAME}`, 'dir=in'], {
        timeout: 10000,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 512 * 1024,
      });
      if (result.status === 0 && result.stdout) {
        for (const line of result.stdout.split(/\r?\n/)) {
          if (line.includes('LocalPort:') && line.includes('39310')) {
            return { windows: true, exists: true };
          }
        }
      }
      const all = spawnSync('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in'], {
        timeout: 15000,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      if (all.status === 0 && all.stdout) {
        for (const line of all.stdout.split(/\r?\n/)) {
          if (line.includes('LocalPort:') && line.includes('39310')) {
            return { windows: true, exists: true };
          }
        }
      }
      errors.push('no rule matched port 39310');
    } catch (e) {
      const stderr = e.stderr ? String(e.stderr).slice(0, 200) : '';
      errors.push(String(e.message || e).slice(0, 200) + (stderr ? ' | ' + stderr : ''));
    }
    console.warn('[Firewall check] No inbound rule found for port 39310:', errors.join(' | '));
    return { windows: true, exists: false, errors };
  });

  ipcMain.handle('wattcoin-was-updated', () => {
    return !!global._appWasUpdated;
  });

  ipcMain.handle('wattcoin-firewall-consented', () => {
    try {
      return fs.existsSync(FIREWALL_SENTINEL);
    } catch (_) {
      return false;
    }
  });

  ipcMain.handle('wattcoin-heal-firewall', () => {
    if (process.platform !== 'win32') return { ok: false, reason: 'not windows' };
    try {
      if (!fs.existsSync(FIREWALL_SENTINEL)) {
        return { ok: false, reason: 'user did not consent during install' };
      }
      const exePath = app.getPath('exe');
      const ruleName = 'Wattcoin Miner Ledger Network (TCP 39310)';
      const tmpFile = path.join(os.tmpdir(), `wc-fw-${Date.now()}.ps1`);
      const scriptContent = `
Remove-NetFirewallRule -DisplayName "${ruleName}" -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "${ruleName}" -Direction Inbound -Protocol TCP -LocalPort 39310 -Program "${exePath}" -Action Allow -Profile Any -Description "Allows Wattcoin peer nodes to attest mining hardware over the peer-to-peer network (peer-to-peer proof verification)."
      `.trim();
      fs.writeFileSync(tmpFile, scriptContent, 'utf8');
      const { spawnSync } = require('child_process');
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"' -Wait`,
        ],
        { timeout: 120000, windowsHide: true },
      );
      try {
        fs.unlinkSync(tmpFile);
      } catch (_) {
        /* ignore */
      }
      const ok = result.status === 0;
      if (!ok) {
        const msg = result.stderr ? String(result.stderr).slice(0, 300) : `exit code ${result.status}`;
        console.warn('[Firewall heal] failed:', msg);
      }
      return { ok };
    } catch (e) {
      console.warn('[Firewall heal] error:', e && e.message ? e.message : e);
      return { ok: false, reason: String((e && e.message) || e).slice(0, 200) };
    }
  });
}

module.exports = { registerFirewallIpcHandlers };
