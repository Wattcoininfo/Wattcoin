'use strict';

const net = require('net');
const PUNCH_TIMEOUT_MS = 5000;
const PUNCH_CONNECT_TIMEOUT_MS = 7000;
const MIN_PUNCH_PORT = 39320;
const MAX_PUNCH_PORT = 39410;

let activePunchSessions = new Map();

function allocatePunchPort(usedPorts = new Set()) {
  for (let port = MIN_PUNCH_PORT; port <= MAX_PUNCH_PORT; port++) {
    if (!usedPorts.has(port)) return port;
  }
  return 0;
}

function cleanupPunchSession(key) {
  const session = activePunchSessions.get(key);
  if (session) {
    clearTimeout(session.timer);
    if (session.socket && !session.socket.destroyed) {
      try {
        session.socket.destroy();
      } catch (_) {}
    }
    activePunchSessions.delete(key);
  }
}

function calculatePunchAtMs(nowMs = Date.now()) {
  return nowMs + 200;
}

function simultaneousConnect(localPort, targetIp, targetPort, timeoutMs = PUNCH_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!socket.destroyed) socket.destroy();
      resolve({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    const socket = net.createConnection(
      {
        host: targetIp,
        port: targetPort,
        localPort: localPort,
      },
      () => {
        clearTimeout(timer);
        resolve({ ok: true, socket });
      },
    );

    socket.on('error', (err) => {
      clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      resolve({ ok: false, reason: err && err.message ? err.message : 'connection error' });
    });
  });
}

async function performPunch(targetIp, targetPort, localPort, timeoutMs = PUNCH_CONNECT_TIMEOUT_MS) {
  const result = await simultaneousConnect(localPort, targetIp, targetPort, timeoutMs);
  return result;
}

function buildPunchResponse(ourPublicIp, ourPublicPort, suggestedLocalPort = 0) {
  const punchPort = suggestedLocalPort || allocatePunchPort();
  return {
    ok: true,
    publicIp: ourPublicIp || '',
    publicPort: ourPublicPort || 0,
    punchPort,
    punchAtMs: calculatePunchAtMs(),
  };
}

function isPublicPunchIp(ip) {
  if (net.isIP(ip) !== 4) return false;
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((o) => !Number.isFinite(o) || o < 0 || o > 255)) return false;
  if (octets[0] === 10 || octets[0] === 127) return false;
  if (octets[0] === 169 && octets[1] === 254) return false;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return false;
  if (octets[0] === 192 && octets[1] === 168) return false;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return false;
  if (octets[0] === 0) return false;
  return true;
}

async function handlePunchResponse(response, localPunchPort) {
  if (!response || !response.ok) {
    return { ok: false, reason: 'punch request rejected' };
  }
  const { publicIp, publicPort, punchPort, punchAtMs } = response;
  if (!publicIp || !publicPort || !punchPort) {
    return { ok: false, reason: 'invalid punch response' };
  }
  if (!isPublicPunchIp(publicIp)) {
    return { ok: false, reason: 'non-public punch IP rejected' };
  }
  const nowMs = Date.now();
  let delayMs = Math.max(0, (punchAtMs || nowMs) - nowMs);
  if (delayMs > 5000) delayMs = 0;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
  const result = await performPunch(publicIp, punchPort, localPunchPort);
  return result;
}

function requestPunch(targetUrl, ourPublicIp, ourPublicPort, options = {}) {
  const { requestPeerJson, localPunchPort, timeoutMs = PUNCH_TIMEOUT_MS } = options;

  if (typeof requestPeerJson !== 'function') {
    throw new Error('requestPeerJson function is required');
  }

  const body = {
    publicIp: ourPublicIp || '',
    publicPort: ourPublicPort || 0,
    punchPort: localPunchPort || 0,
  };

  return {
    body,
    async execute() {
      const response = await requestPeerJson(targetUrl, 'POST', '/api/v1/network/punch', body, undefined, {
        timeoutMs,
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'hole-punch',
      });
      return handlePunchResponse(response, localPunchPort);
    },
  };
}

module.exports = {
  allocatePunchPort,
  cleanupPunchSession,
  simultaneousConnect,
  performPunch,
  buildPunchResponse,
  handlePunchResponse,
  requestPunch,
  PUNCH_TIMEOUT_MS,
  MIN_PUNCH_PORT,
  MAX_PUNCH_PORT,
};
