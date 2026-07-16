'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

function getDataDir() {
  return path.join(os.homedir(), 'WattcoinMinerUserData');
}

function getActiveNetwork() {
  return 'wtc-mainnet';
}

function ensureCanonicalGenesis({ getWalletDataDir }) {
  try {
    const genesisDestPath = path.join(getWalletDataDir(), 'wtc-genesis.json');
    const genesisSourcePath = [
      process.resourcesPath ? path.join(process.resourcesPath, 'wtc-genesis.json') : '',
      path.join(__dirname, 'resources', 'wtc-genesis.json'),
      path.join(__dirname, '..', 'resources', 'wtc-genesis.json'),
    ].find((candidate) => candidate && fs.existsSync(candidate));
    if (genesisSourcePath && fs.existsSync(genesisSourcePath)) {
      fs.mkdirSync(path.dirname(genesisDestPath), { recursive: true });
      fs.copyFileSync(genesisSourcePath, genesisDestPath);
      console.log('[WtcNode] Canonical wtc-genesis.json copied to userData.');
    } else {
      console.warn('[WtcNode] Bundled wtc-genesis.json not found -- genesis will fall back to local address.');
    }
  } catch (genesisErr) {
    console.warn('[WtcNode] Could not install wtc-genesis.json:', genesisErr && genesisErr.message);
  }
}

const DEPRECATED_PEER_ENDPOINTS = [
  { hostParts: ['91', '95', '15', '55'], port: 39310 },
  { hostParts: ['62', '65', '200', '145'], port: 39310 },
];
const DEPRECATED_PEER_URLS = new Set(
  DEPRECATED_PEER_ENDPOINTS.map(({ hostParts, port }) =>
    normalizePeerUrl(`http://${(hostParts || []).join('.')}:${port}`),
  ).filter(Boolean),
);

function normalizePeerUrl(candidate) {
  try {
    const parsed = new URL(String(candidate || '').trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port <= 1023) return '';
    const pathname = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
    return `${parsed.protocol}//${parsed.hostname}:${port}${pathname}`;
  } catch (_) {
    return '';
  }
}

function isDeprecatedPeerUrl(candidate) {
  const normalized = normalizePeerUrl(candidate);
  return normalized ? DEPRECATED_PEER_URLS.has(normalized) : false;
}

function normalizeIpLiteral(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutZone = raw.split('%')[0];
  if (withoutZone.startsWith('::ffff:')) {
    const mapped = withoutZone.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return mapped;
  }
  return withoutZone;
}

function isPrivateIpv4(host) {
  const normalized = normalizeIpLiteral(host);
  if (net.isIP(normalized) !== 4) return false;
  const octets = normalized.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  if (octets[0] === 0) return true;
  return false;
}

function isPrivateIpv6(host) {
  const normalized = normalizeIpLiteral(host).toLowerCase();
  const family = net.isIP(normalized);
  if (family === 4) return isPrivateIpv4(normalized);
  if (family !== 6) return false;
  return (
    normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')
  );
}

function isPublicPeerHost(host) {
  const normalized = normalizeIpLiteral(host).toLowerCase();
  if (!normalized || normalized === 'localhost') return false;
  const family = net.isIP(normalized);
  if (family === 4) return !isPrivateIpv4(normalized);
  if (family === 6) return !isPrivateIpv6(normalized);
  return false;
}

function isLoopbackPeerHost(host) {
  const normalized = normalizeIpLiteral(host).toLowerCase();
  if (!normalized) return false;
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

function formatPeerHostForUrl(host) {
  const normalized = normalizeIpLiteral(host);
  if (!normalized) return '';
  return net.isIP(normalized) === 6 ? `[${normalized}]` : normalized;
}

function isReverseTunnelPeerUrl(candidate) {
  const normalized = normalizePeerUrl(candidate);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
    const segments = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean);
    return (
      segments.length >= 4 &&
      (segments[0] === 'api' || segments[0] === 'relay') &&
      segments[1] === 'v1' &&
      segments[2] === 'tunnel'
    );
  } catch (_) {
    return false;
  }
}

function extractTunnelIdFromUrl(peerUrl) {
  try {
    const parsed = new URL(peerUrl);
    const segments = String(parsed.pathname || '')
      .split('/')
      .filter(Boolean);
    return segments.length >= 4 ? decodeURIComponent(segments[3]) : '';
  } catch (_) {
    return '';
  }
}

function isUnusableGpuIdentity(value) {
  const s = String(value || '').trim();
  if (!s) return true;
  if (/^unknown/i.test(s)) return true;
  if (/^0x[0-9a-f]+$/i.test(s)) return true;
  if (/^[0-9\s,./-]+$/.test(s)) return true;
  if (/Microsoft (Basic|Remote) (Render|Display)( Driver)?/i.test(s)) return true;
  if (/Microsoft Hyper-V/i.test(s)) return true;
  return !/[a-z]/i.test(s);
}

function normalizeGpuFingerprintValue(gpuModels) {
  if (!Array.isArray(gpuModels)) return [];
  return gpuModels
    .map((gpu) => String(gpu || '').trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

function formatHardwareChangeList(previousDescriptor, nextDescriptor) {
  const changes = [];
  const previousCpu = String((previousDescriptor && previousDescriptor.cpuModel) || '').trim();
  const nextCpu = String((nextDescriptor && nextDescriptor.cpuModel) || '').trim();
  if (previousCpu !== nextCpu) {
    changes.push(`CPU: ${previousCpu || 'unknown'} -> ${nextCpu || 'unknown'}`);
  }

  const previousGpu = normalizeGpuFingerprintValue(previousDescriptor && previousDescriptor.gpuModels).filter(
    (g) => !isUnusableGpuIdentity(g),
  );
  const nextGpu = normalizeGpuFingerprintValue(nextDescriptor && nextDescriptor.gpuModels).filter(
    (g) => !isUnusableGpuIdentity(g),
  );
  if (previousGpu.join(' | ') !== nextGpu.join(' | ')) {
    changes.push(`GPU: ${previousGpu.join(', ') || 'unknown'} -> ${nextGpu.join(', ') || 'unknown'}`);
  }

  const previousMemType = String((previousDescriptor && previousDescriptor.memType) || '').trim();
  const nextMemType = String((nextDescriptor && nextDescriptor.memType) || '').trim();
  if (previousMemType !== nextMemType) {
    changes.push(`Memory type: ${previousMemType || 'unknown'} -> ${nextMemType || 'unknown'}`);
  }

  const previousMemSpeed = Number((previousDescriptor && previousDescriptor.memSpeedMhz) || 0);
  const nextMemSpeed = Number((nextDescriptor && nextDescriptor.memSpeedMhz) || 0);
  if (previousMemSpeed !== nextMemSpeed) {
    changes.push(`Memory speed: ${previousMemSpeed || 0} MHz -> ${nextMemSpeed || 0} MHz`);
  }

  const previousMemSticks = Number((previousDescriptor && previousDescriptor.memSticks) || 0);
  const nextMemSticks = Number((nextDescriptor && nextDescriptor.memSticks) || 0);
  if (previousMemSticks !== nextMemSticks) {
    changes.push(`Memory modules: ${previousMemSticks || 0} -> ${nextMemSticks || 0}`);
  }

  return changes;
}

function appendBenchmarkSample(samples, newValue, historyMaxSamples) {
  const max = historyMaxSamples || 20;
  if (samples.length >= 4) {
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    if (newValue > mean * 2.5 || newValue < mean * 0.4) {
      return samples;
    }
  }
  const updated = [...samples, newValue];
  return updated.length > max ? updated.slice(updated.length - max) : updated;
}

function getPersonalReference(samples, tableValue, historyMaxSamples, historyEnrollCount) {
  const max = historyMaxSamples || 20;
  const enroll = historyEnrollCount || 8;
  if (samples.length < enroll || samples.length === 0) return tableValue;
  const personalMean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const blendFactor = Math.min(1.0, samples.length / max);
  return tableValue > 0 ? tableValue * (1 - blendFactor) + personalMean * blendFactor : personalMean;
}

function isPowerCpuOutlier(address, powerW, cpuOps, networkMiningStats) {
  if (!networkMiningStats || networkMiningStats.size < 3) return false;
  let sumRatio = 0,
    count = 0;
  for (const [addr, stats] of networkMiningStats) {
    if (addr === address || stats.count === 0) continue;
    const ratio = stats.totalCpuOps > 0 ? stats.totalPowerW / stats.totalCpuOps : 0;
    sumRatio += ratio;
    count++;
  }
  if (count < 2) return false;
  const mean = sumRatio / count;
  let sumSq = 0;
  for (const [addr, stats] of networkMiningStats) {
    if (addr === address || stats.count === 0) continue;
    const ratio = stats.totalCpuOps > 0 ? stats.totalPowerW / stats.totalCpuOps : 0;
    sumSq += (ratio - mean) ** 2;
  }
  const stdDev = Math.sqrt(sumSq / count);
  if (stdDev === 0) return false;
  const myRatio = cpuOps > 0 ? powerW / cpuOps : 0;
  return (myRatio - mean) / stdDev > 3;
}

function getCliCommandName(args) {
  for (const raw of args) {
    const token = String(raw || '').trim();
    if (!token || token.startsWith('-')) continue;
    if (token.includes('=')) continue;
    return token;
  }
  return '';
}

function normalizeUpdateFeedUrl(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return s.replace(/\/+$/, '');
}

function secureStringEquals(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function validatePassphrase(passphrase) {
  return typeof passphrase === 'string' && passphrase.length >= 8;
}

function normalizeWalletError(e) {
  const code = e && e.code ? e.code : 'UNKNOWN';
  const message = e && e.message ? e.message : 'Unknown wallet error';
  return { ok: false, code, message };
}

function formatBackupTimestampForFilename(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join('') +
    '-' +
    [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join('')
  );
}

function encryptBackupPayload(payloadObject, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payloadObject), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptBackupPayload(encryptedObject, passphrase) {
  const salt = Buffer.from(encryptedObject.salt || '', 'base64');
  const iv = Buffer.from(encryptedObject.iv || '', 'base64');
  const tag = Buffer.from(encryptedObject.tag || '', 'base64');
  const ciphertext = Buffer.from(encryptedObject.ciphertext || '', 'base64');
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function parseRegexSafe(pattern) {
  if (!pattern || typeof pattern !== 'string') return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (_) {
    return null;
  }
}

function hardwareModelsMatch(osModel, declaredModel) {
  const normalize = (s) =>
    String(s || '')
      .normalize('NFKC')
      .replace(/G--|\u2212|\u2013|\u2014/g, ' ')
      .replace(/([a-z])tm\b/gi, '$1')
      .replace(/\b(tm|trademark|registered)\b/gi, ' ')
      .replace(/\(R\)|\(TM\)/gi, '')
      .replace(/@.*$/i, '')
      .replace(/[^\x20-\x7E]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const strip = (s) => s.replace(/\s+/g, ' ').trim();
  const a = normalize(strip(osModel));
  const b = normalize(strip(declaredModel));
  if (!a || !b) return false;
  if (a.includes(b) || b.includes(a)) return true;
  const tokenRe = /\b(?:[a-z]+-)?[a-z]?\d[\w-]{2,}\b/gi;
  const aTokens = new Set((a.match(tokenRe) || []).map((t) => t.toLowerCase()));
  const bTokens = (b.match(tokenRe) || []).map((t) => t.toLowerCase());
  return bTokens.some((t) => aTokens.has(t));
}

function getEndpointActorKey(endpointName, actorId = 'local-client') {
  return `${endpointName}:${String(actorId || 'local-client')}`;
}

function shouldEscalateRateLimitToIdentityFailure(endpointName) {
  const normalized = String(endpointName || '').trim();
  if (!normalized) return false;
  if (normalized.startsWith('wtc-peer-')) return false;
  if (normalized.startsWith('peer-probe-')) return false;
  return true;
}

function normalizeMinerIdentity(minerId) {
  if (typeof minerId === 'string' && minerId.trim()) return minerId.trim().slice(0, 128);
  return 'local-client';
}

function normalizeHardwareDescriptor(summary = {}) {
  return {
    deviceType: String(summary && summary.deviceType ? summary.deviceType : '').trim(),
    cpu: String(summary && summary.cpu ? summary.cpu : '').trim(),
    gpu: String(summary && summary.gpu ? summary.gpu : '').trim(),
    memory: String(summary && summary.memory ? summary.memory : '').trim(),
  };
}

function sanitizeForwardedTunnelHeaders(headers = {}) {
  const nextHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null || value === '') continue;
    if (/^(content-type|x-wtc-|x-wattcoin-ledger-token)/i.test(key)) {
      nextHeaders[key] = String(value);
    }
  }
  return nextHeaders;
}

function getPeerNetworkSegment(peerUrl) {
  try {
    const host = new URL(peerUrl).hostname;
    const parts = host.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return host;
  } catch (_) {
    return '';
  }
}

function defaultAttestationState() {
  return {
    version: 1,
    secret: crypto.randomBytes(32).toString('hex'),
    miners: {},
  };
}

function verifyPolicyFeedEnvelope(envelope, publicKeyPem) {
  if (!envelope || typeof envelope !== 'object') return false;
  const policy = envelope.policy && typeof envelope.policy === 'object' ? envelope.policy : null;
  const signatureBase64 = String(envelope.signature || '');
  if (!policy || !signatureBase64 || !publicKeyPem) return false;
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(JSON.stringify(policy));
    verifier.end();
    return verifier.verify(publicKeyPem, Buffer.from(signatureBase64, 'base64'));
  } catch (_) {
    return false;
  }
}

function computeMinedCoinsFromHeight(height) {
  const halvingInterval = 210000;
  let remainingBlocks = Math.max(0, Math.floor(Number(height) || 0));
  let subsidy = 50;
  let total = 0;
  while (remainingBlocks > 0 && subsidy > 0) {
    const blocksThisEra = Math.min(remainingBlocks, halvingInterval);
    total += blocksThisEra * subsidy;
    remainingBlocks -= blocksThisEra;
    subsidy /= 2;
  }
  return total;
}

function _computeMaturedMinedCoinsFromHeight(height) {
  const maturityDepth = 100;
  const maturedHeight = Math.max(0, Math.floor(Number(height) || 0) - maturityDepth);
  return computeMinedCoinsFromHeight(maturedHeight);
}

function _computeWattcoinFromMinedBlocks(blockCount) {
  let remainingBlocks = Math.max(0, Math.floor(Number(blockCount) || 0));
  let totalCoins = 0;
  for (let tier = 0; tier < 21 && remainingBlocks > 0; tier++) {
    const reward = 1000 / Math.pow(2, tier);
    const blocksThisTier = Math.round(1000000 / reward);
    const minedThisTier = Math.min(remainingBlocks, blocksThisTier);
    totalCoins += minedThisTier * reward;
    remainingBlocks -= minedThisTier;
  }
  return Number(totalCoins.toFixed(8));
}

function median(values) {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pruneOldTimestamps(timestamps, windowMs) {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter((ts) => ts >= cutoff);
}

function pushTimestampWindow(target, windowMs, maxLen = 5000) {
  const now = Date.now();
  target.push(now);
  const pruned = pruneOldTimestamps(target, windowMs);
  if (pruned.length > maxLen) return pruned.slice(pruned.length - maxLen);
  return pruned;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload || {});
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 65536) {
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
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) || {});
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

function _parseGeneratedBlockHash(minedOutput) {
  const raw = typeof minedOutput === 'string' ? minedOutput.trim() : '';
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === 'string') {
      return parsed[0];
    }
  } catch (_) {
    if (process.env.WATTCOIN_DEBUG) console.warn('[Main] Caught:', String(_.message || _).slice(0, 80));
  }
  return raw;
}

function getHostLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function computeNextReattestDueAt(nowMs = Date.now()) {
  const min = 2 * 60 * 60_000;
  const max = 4 * 60 * 60_000;
  const range = Math.max(1, max - min);
  const jitter = crypto.randomInt(0, range + 1);
  return nowMs + min + jitter;
}

const MANIFEST_SIGNING_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAS+Hbx0leVnkpk6O8Oh15Vl87/MIoa8sMofYK/CJrf7U=
-----END PUBLIC KEY-----`;

function verifyManifestSignature(manifestPath, manifestContent) {
  const sigPath = manifestPath + '.sig';
  if (!fs.existsSync(sigPath)) {
    console.warn(`[Integrity] ${path.basename(sigPath)} not found - manifest is not signed.`);
    return true;
  }
  try {
    const signature = fs.readFileSync(sigPath);
    const canonical = Buffer.from(JSON.stringify(manifestContent), 'utf8');
    const key = crypto.createPublicKey({ key: MANIFEST_SIGNING_PUBLIC_KEY, format: 'pem', type: 'spki' });
    const ok = crypto.verify(null, canonical, key, signature);
    if (!ok)
      console.warn(`[Integrity] ${path.basename(sigPath)} signature INVALID - manifest may have been tampered with.`);
    return ok;
  } catch (e) {
    console.warn(`[Integrity] signature verification error:`, e?.message);
    return false;
  }
}

module.exports = {
  normalizePeerUrl,
  isDeprecatedPeerUrl,
  normalizeIpLiteral,
  isPrivateIpv4,
  isPrivateIpv6,
  isPublicPeerHost,
  isLoopbackPeerHost,
  formatPeerHostForUrl,
  isReverseTunnelPeerUrl,
  extractTunnelIdFromUrl,
  isUnusableGpuIdentity,
  normalizeGpuFingerprintValue,
  formatHardwareChangeList,
  appendBenchmarkSample,
  getPersonalReference,
  isPowerCpuOutlier,
  getCliCommandName,
  normalizeUpdateFeedUrl,
  secureStringEquals,
  validatePassphrase,
  normalizeWalletError,
  formatBackupTimestampForFilename,
  encryptBackupPayload,
  decryptBackupPayload,
  sha256Hex,
  parseRegexSafe,
  hardwareModelsMatch,
  getEndpointActorKey,
  shouldEscalateRateLimitToIdentityFailure,
  normalizeMinerIdentity,
  normalizeHardwareDescriptor,
  sanitizeForwardedTunnelHeaders,
  getPeerNetworkSegment,
  defaultAttestationState,
  verifyPolicyFeedEnvelope,
  computeMinedCoinsFromHeight,
  _computeMaturedMinedCoinsFromHeight,
  _computeWattcoinFromMinedBlocks,
  median,
  pruneOldTimestamps,
  pushTimestampWindow,
  sendJson,
  readJsonBody,
  _parseGeneratedBlockHash,
  getHostLanIp,
  computeNextReattestDueAt,
  verifyManifestSignature,
  MANIFEST_SIGNING_PUBLIC_KEY,
  DEPRECATED_PEER_ENDPOINTS,
  getDataDir,
  getActiveNetwork,
  ensureCanonicalGenesis,
};
