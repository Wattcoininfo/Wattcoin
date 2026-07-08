const https = require('https');
const os = require('os');
const { filterAdvertisedPeerUrls } = require('../peer-privacy');
const { isValidAddress: isValidWtcAddress } = require('../wtc-address');
const { formatPeerHostForUrl, normalizePeerUrl, isLoopbackPeerHost } = require('./main-utils');

const AUTO_PUBLIC_IP_LOOKUP_TIMEOUT_MS = 4_000;
const LEDGER_NETWORK_BODY_MAX_BYTES = 64 * 1024;
const PEER_EXCHANGE_TARGET_LIMIT = 4;

function buildPeerUrlFromSocket(remoteAddress, listenPort, protocol = 'http:') {
  const port = Math.max(1, Number(listenPort) || 0);
  const host = formatPeerHostForUrl(remoteAddress);
  if (!host || !port) return '';
  return normalizePeerUrl(`${protocol}//${host}:${port}`);
}

function getLocalPeerHosts() {
  const hosts = new Set(['127.0.0.1', 'localhost']);
  try {
    const interfaces = os.networkInterfaces() || {};
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries || []) {
        if (entry && entry.family === 'IPv4' && entry.address) {
          hosts.add(String(entry.address));
        }
      }
    }
  } catch (_) {
    /* intentional */
  }
  return hosts;
}

function getLocalPeerIpv4InterfaceEntries() {
  const entries = [];
  try {
    const interfaces = os.networkInterfaces() || {};
    for (const interfaceEntries of Object.values(interfaces)) {
      for (const entry of interfaceEntries || []) {
        if (!entry || entry.family !== 'IPv4' || !entry.address || entry.internal) continue;
        entries.push({
          address: String(entry.address),
          netmask: String(entry.netmask || ''),
          internal: !!entry.internal,
        });
      }
    }
  } catch (_) {
    /* intentional */
  }
  return entries;
}

function getLocalPeerIpv4Interfaces() {
  const addresses = new Set();
  for (const entry of getLocalPeerIpv4InterfaceEntries()) {
    addresses.add(entry.address);
  }
  return Array.from(addresses);
}

function requestExternalResponse(url, timeoutMs = AUTO_PUBLIC_IP_LOOKUP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = https.get(
      url,
      {
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'wattcoin-miner/1.0 (public-ip-detect)',
          Accept: 'text/plain',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve({
            statusCode: Number(res.statusCode) || 0,
            contentType: String((res.headers && res.headers['content-type']) || '').trim(),
            body: Buffer.concat(chunks).toString('utf8').trim(),
          });
        });
        res.on('error', (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        });
      },
    );
    req.on('timeout', () => {
      if (settled) return;
      settled = true;
      req.destroy(new Error('public ip lookup timeout'));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function requestExternalText(url, timeoutMs = AUTO_PUBLIC_IP_LOOKUP_TIMEOUT_MS) {
  const response = await requestExternalResponse(url, timeoutMs);
  return response.body;
}

function readRequestBodyBuffer(req, maxBytes = LEDGER_NETWORK_BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

function buildReverseTunnelPublicUrl(baseUrl, tunnelId) {
  try {
    const base = new URL(baseUrl);
    const prefix = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/+$/, '') : '';
    return normalizePeerUrl(`${base.origin}${prefix}/api/v1/tunnel/${encodeURIComponent(tunnelId)}`);
  } catch (_) {
    return '';
  }
}

function buildReverseTunnelConnectUrl(coordinatorUrl) {
  try {
    const base = new URL(coordinatorUrl);
    const prefix = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/+$/, '') : '';
    return `${base.origin}${prefix}/api/v1/tunnel/connect`;
  } catch (_) {
    return '';
  }
}

function pickPeerExchangeTargets(peerUrls, limit = PEER_EXCHANGE_TARGET_LIMIT) {
  const candidates = Array.from(new Set((peerUrls || []).map(normalizePeerUrl).filter(Boolean)));
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  return candidates.slice(0, Math.max(0, Number(limit) || 0));
}

function isReverseTunnelForwardedRequest(req) {
  const marker = String(req && req.headers ? req.headers['x-wtc-via-tunnel'] || '' : '').trim();
  if (marker !== '1') return false;
  return isLoopbackPeerHost(req && req.socket ? req.socket.remoteAddress : '');
}

function getExplicitAdvertisedPeerUrls(settings) {
  const candidates = [
    settings && settings.publicUrl,
    settings && settings.tunnelPublicUrl,
    ...((settings && settings.advertiseUrls) || []),
  ];
  return filterAdvertisedPeerUrls(candidates);
}

function isPinnedPeerUrl(peerUrl, settings) {
  const normalized = normalizePeerUrl(peerUrl);
  if (!normalized) return false;
  const persistentPeers = [
    ...((settings && settings.peers) || []),
    ...((settings && settings.configuredPeers) || []),
    ...((settings && settings.seedPeers) || []),
  ];
  return persistentPeers.some((entry) => normalizePeerUrl(entry) === normalized);
}

function isValidPeerIdentity(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return false;
  if (isValidWtcAddress(normalized)) return true;
  return /^[a-f0-9]{64}$/i.test(normalized);
}

function getPeerIdentityKey(peerUrl, tipResponse) {
  const peerIdentity =
    tipResponse && typeof tipResponse.peerIdentity === 'string' ? tipResponse.peerIdentity.trim() : '';
  if (peerIdentity) return `id:${peerIdentity}`;
  const normalized = normalizePeerUrl(peerUrl);
  return normalized ? `url:${normalized}` : `url:${String(peerUrl || '').trim()}`;
}

function shouldUseManagedReverseTunnel(settings) {
  if (!settings || !settings.enabled || settings.mode !== 'peer') return false;
  return getExplicitAdvertisedPeerUrls(settings).length === 0;
}

module.exports = {
  buildPeerUrlFromSocket,
  getLocalPeerHosts,
  getLocalPeerIpv4InterfaceEntries,
  getLocalPeerIpv4Interfaces,
  requestExternalResponse,
  requestExternalText,
  readRequestBodyBuffer,
  buildReverseTunnelPublicUrl,
  buildReverseTunnelConnectUrl,
  pickPeerExchangeTargets,
  isReverseTunnelForwardedRequest,
  getExplicitAdvertisedPeerUrls,
  isPinnedPeerUrl,
  isValidPeerIdentity,
  getPeerIdentityKey,
  shouldUseManagedReverseTunnel,
};
