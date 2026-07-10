'use strict';

const path = require('path');
const fs = require('fs');
const { getDataDir } = require('./env');

const STARTUP_TRACE_FILE_NAME = 'wattcoin-startup-trace.log';

let startupTraceEnabled = false;
let startupTraceWindowMs = 180_000;
let startupTraceUntilMs = 0;

function getWalletDataDir() {
  return getDataDir();
}

function getStartupTraceFilePath() {
  return path.join(getWalletDataDir(), STARTUP_TRACE_FILE_NAME);
}

function isStartupTraceActive() {
  return startupTraceEnabled && Date.now() <= startupTraceUntilMs;
}

const STARTUP_TRACE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap to prevent unbounded growth

function writeStartupTrace(event, details = {}) {
  if (!startupTraceEnabled) return;
  const allowedOutsideWindow = event.startsWith('app.') || event.startsWith('startup.');
  if (!allowedOutsideWindow && !isStartupTraceActive()) return;
  try {
    const filePath = getStartupTraceFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      const stat = fs.statSync(filePath);
      if (stat.size >= STARTUP_TRACE_MAX_BYTES) {
        fs.writeFileSync(filePath, '', 'utf8');
      }
    } catch (_) {
      if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      details,
    });
    fs.appendFileSync(filePath, `${line}\n`, 'utf8');
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
}

function beginStartupTrace(reason) {
  if (!startupTraceEnabled) return;
  startupTraceUntilMs = Date.now() + startupTraceWindowMs;
  writeStartupTrace('startup.trace-window-started', {
    reason,
    windowMs: startupTraceWindowMs,
  });
}

module.exports = {
  getStartupTraceFilePath,
  isStartupTraceActive,
  writeStartupTrace,
  beginStartupTrace,
  setEnabled(v) {
    startupTraceEnabled = v;
  },
  setWindowMs(v) {
    startupTraceWindowMs = v;
  },
};
