const path = require('path');
const fs = require('fs');
const { normalizeUpdateFeedUrl } = require('./main-utils');

function readConfiguredUpdateFeedUrl() {
  try {
    const appUpdatePath = path.join(process.resourcesPath, 'app-update.yml');
    if (!fs.existsSync(appUpdatePath)) return '';
    const raw = fs.readFileSync(appUpdatePath, 'utf8');
    const m = raw.match(/^url:\s*(.+)$/m);
    return normalizeUpdateFeedUrl(m ? m[1] : '');
  } catch (_) {
    return '';
  }
}

function buildUpdateFeedOrder() {
  const configured = readConfiguredUpdateFeedUrl();
  const defaults = ['https://wattcoin.ee/releases', 'https://wattcoin.ee'];

  const ordered = [];
  const seen = new Set();
  [configured, ...defaults].forEach((u) => {
    const n = normalizeUpdateFeedUrl(u);
    if (!n || seen.has(n)) return;
    seen.add(n);
    ordered.push(n);
  });
  return ordered;
}

function initUpdater({ app, autoUpdater, BrowserWindow, ipcMain, updateInstallInProgressRef }) {
  if (!app.isPackaged) return;

  const updateFeeds = buildUpdateFeedOrder();
  let activeUpdateFeed = updateFeeds[0] || 'https://wattcoin.ee/releases';

  const setUpdateFeed = (url) => {
    const normalized = normalizeUpdateFeedUrl(url);
    if (!normalized) return false;
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: normalized });
      activeUpdateFeed = normalized;
      console.log('[auto-update] feed set:', normalized);
      return true;
    } catch (e) {
      console.warn('[auto-update] failed to set feed:', normalized, e && e.message ? e.message : e);
      return false;
    }
  };

  const checkForUpdatesWithFallback = async () => {
    const feeds = updateFeeds.length > 0 ? updateFeeds : [activeUpdateFeed];
    const startIndex = Math.max(0, feeds.indexOf(activeUpdateFeed));
    let lastError = null;

    for (let offset = 0; offset < feeds.length; offset += 1) {
      const idx = (startIndex + offset) % feeds.length;
      const feed = feeds[idx];
      if (!setUpdateFeed(feed)) continue;
      try {
        return await autoUpdater.checkForUpdates();
      } catch (e) {
        lastError = e;
        console.warn('[auto-update] check failed on feed:', feed, e && e.message ? e.message : e);
      }
    }

    if (lastError) {
      throw lastError;
    }
    return null;
  };

  setUpdateFeed(activeUpdateFeed);

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;

  if (process.env.WATTCOIN_WINDOWS_SIGNING_ON_HOLD === '1') {
    autoUpdater._verifyUpdateCodeSignature = () => Promise.resolve(null);
  }

  autoUpdater.on('before-quit-for-update', () => {
    updateInstallInProgressRef.value = true;
  });

  autoUpdater.on('update-downloaded', (info) => {
    const wins = BrowserWindow.getAllWindows();
    wins.forEach((w) => {
      try {
        w.webContents.send('wattcoin-update-downloaded', { version: info.version });
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.warn('[auto-update] error:', err && err.message ? err.message : err);
  });

  ipcMain.handle('wattcoin-check-for-update', async () => {
    try {
      return await checkForUpdatesWithFallback();
    } catch (_) {
      return null;
    }
  });

  ipcMain.handle('wattcoin-install-update', () => {
    updateInstallInProgressRef.value = true;

    const wins = BrowserWindow.getAllWindows();
    wins.forEach((win) => {
      try {
        win.removeAllListeners('close');
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
      try {
        win.close();
      } catch (_) {
        if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
      }
    });

    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      updateInstallInProgressRef.value = false;
      console.warn('[auto-update] install failed:', err && err.message ? err.message : err);
    }

    return { ok: true };
  });

  app.whenReady().then(() => {
    setTimeout(() => {
      checkForUpdatesWithFallback().catch(() => undefined);
      setInterval(() => checkForUpdatesWithFallback().catch(() => undefined), 4 * 60 * 60_000);
    }, 30_000);
  });
}

module.exports = { initUpdater };
