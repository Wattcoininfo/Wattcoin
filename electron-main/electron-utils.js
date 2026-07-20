const path = require('path');

function getFocusedWindow() {
  const { BrowserWindow } = require('electron');
  return BrowserWindow.getFocusedWindow() || null;
}

function getAppDisplayVersion() {
  const { app } = require('electron');
  const pkgDir = path.resolve(__dirname, '..');
  let packageVersion = '';
  try {
    packageVersion = String(require(path.join(pkgDir, 'package.json')).version || '').trim();
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }

  if (!app.isPackaged) {
    return packageVersion || '?';
  }

  try {
    const packagedVersion = String(app.getVersion() || '').trim();
    return packagedVersion || packageVersion || '?';
  } catch (_) {
    return packageVersion || '?';
  }
}

function createWindow() {
  const { ipcMain, session, BrowserWindow } = require('electron');
  const appDir = path.resolve(__dirname, '..');

  // -- Content Security Policy -----------------------------------------------
  // Set before the window is created so it applies from the very first navigation.
  // Restricts script, style, and connection sources to 'self' (the local app bundle).
  // In dev mode we also allow localhost:5173 for the Vite dev server.
  const devMode = process.env.NODE_ENV === 'development';
  const externalApiHosts = [].join(' ');
  const connectSrc = devMode
    ? `'self' http://localhost:5173 ws://localhost:5173 ${externalApiHosts}`
    : `'self' ${externalApiHosts}`;
  const cspValue = `default-src 'self'; script-src 'self'${devMode ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src ${connectSrc}; object-src 'none'; base-uri 'none'; form-action 'none';`;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [cspValue],
      },
    });
  });

  const win = new BrowserWindow({
    width: 1240,
    height: 800,
    icon: path.join(appDir, 'assets', 'icons', 'icon.ico'),
    title: `Wattcoin Miner v${getAppDisplayVersion()}`,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      // Must be false so setTimeout-driven GPU load loop keeps firing when the
      // window is minimized.  true (the Electron default) throttles all timers
      // in hidden pages, which drops GPU utilisation to 0%.
      backgroundThrottling: false,
      preload: path.join(appDir, 'preload.js'),
    },
  });
  // Keep the versioned title even after the page's <title> tag loads.
  win.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  // Block all new-window openings and external navigations.
  // The renderer is a local single-page app; it should never open popups or
  // navigate away from the local file:// bundle.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = devMode
      ? url.startsWith('http://localhost:5173') || url.startsWith('file://')
      : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      console.warn('[Security] Blocked renderer navigation to:', url);
    }
  });

  ipcMain.on('wattcoin-get-app-version', (event) => {
    event.returnValue = getAppDisplayVersion();
  });
  // Load the Vite dev server in development, or the built miner.html in production
  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173/miner.html');
  } else {
    win.loadFile(path.join(appDir, 'dist', 'miner.html'));
  }
}

function getRateLockFilePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'rate-locks.json');
}

function getHwAuthStatePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'hw-auth-state.json');
}

function getHwFingerprintPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'hw-fingerprint.json');
}

function getBenchmarkHistoryPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'benchmark-history.json');
}

function getDiscoveredSeedPeerCachePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'discovered-seed-peer-cache.json');
}

function getRemoteSeedPeerCachePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'remote-seed-peers-cache.json');
}

function getConsumedProofsFilePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'consumed-proofs.json');
}

function getProbeLogFilePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'probe-log.json');
}

function getPowerCurvePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'power-curve.json');
}

function persistDevPeerPrivacyRecoveryKey(getDeviceIdentitySecret, loadOrCreateDeviceIdentity) {
  const { app } = require('electron');
  if (app.isPackaged) return '';
  const { buildPeerPrivacyRecoveryPayload, writePeerPrivacyRecoveryFile } = require('./peer-privacy');
  const secret = getDeviceIdentitySecret();
  if (!secret) return '';
  const identity = loadOrCreateDeviceIdentity();
  const payload = buildPeerPrivacyRecoveryPayload({
    secret,
    deviceId: identity && identity.deviceId,
    createdAt: identity && identity.createdAt,
  });
  if (!payload) return '';
  return writePeerPrivacyRecoveryFile({ fs: require('fs'), baseDir: path.resolve(__dirname, '..'), payload });
}

module.exports = {
  getFocusedWindow,
  getAppDisplayVersion,
  createWindow,
  getRateLockFilePath,
  getHwAuthStatePath,
  getHwFingerprintPath,
  getBenchmarkHistoryPath,
  getDiscoveredSeedPeerCachePath,
  getRemoteSeedPeerCachePath,
  getConsumedProofsFilePath,
  getProbeLogFilePath,
  getPowerCurvePath,
  persistDevPeerPrivacyRecoveryKey,
};
