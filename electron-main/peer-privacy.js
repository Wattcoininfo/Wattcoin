// SPDX-License-Identifier: MIT
'use strict';

const crypto = require('crypto');
const net = require('net');
const path = require('path');

const DEV_PEER_PRIVACY_DIR = '.dev';
const DEV_PEER_PRIVACY_FILE = 'peer-privacy-recovery.json';

function isPrivateIpv4(hostname) {
  const parts = String(hostname || '')
    .split('.')
    .map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  return false;
}

function isPrivateIpv6(hostname) {
  const normalized = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
    return true;
  const ipv4Mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Mapped) return isPrivateIpv4(ipv4Mapped[1]);
  return false;
}

function isPublicIpHostname(hostname) {
  const normalized = String(hostname || '').trim();
  const family = net.isIP(normalized);
  if (!family) return false;
  if (family === 4) return !isPrivateIpv4(normalized);
  return !isPrivateIpv6(normalized);
}

function isIpHostname(hostname) {
  return net.isIP(String(hostname || '').trim()) !== 0;
}

function isDirectIpPeerUrl(peerUrl) {
  const rawPeerUrl = String(peerUrl || '').trim();
  if (!rawPeerUrl) return false;
  try {
    return isIpHostname(new URL(rawPeerUrl).hostname);
  } catch (_) {
    return false;
  }
}

function filterAdvertisedPeerUrls(peerUrls) {
  const urls = Array.from(
    new Set((Array.isArray(peerUrls) ? peerUrls : []).map((peerUrl) => String(peerUrl || '').trim()).filter(Boolean)),
  );
  if (urls.length === 0) return [];
  const hasNonIpEndpoint = urls.some((peerUrl) => !isDirectIpPeerUrl(peerUrl));
  if (!hasNonIpEndpoint) return urls;
  return urls.filter((peerUrl) => !isDirectIpPeerUrl(peerUrl));
}

function resolvePeerPrivacySecret(persistedSecret, deviceId = '') {
  const normalizedSecret = String(persistedSecret || '').trim();
  if (normalizedSecret) return normalizedSecret;
  const fallback = String(deviceId || '').trim();
  if (!fallback) return '';
  return crypto.createHash('sha256').update(fallback, 'utf8').digest('hex');
}

function createPeerAlias(hostname, secret) {
  const normalizedHost = String(hostname || '').trim();
  const normalizedSecret = String(secret || '').trim();
  if (!normalizedHost || !normalizedSecret) return normalizedHost;
  const family = net.isIP(normalizedHost);
  if (!family) return normalizedHost;
  const token = crypto
    .createHmac('sha256', Buffer.from(normalizedSecret, 'utf8'))
    .update(normalizedHost)
    .digest('hex')
    .slice(0, 12);
  return `peer-ip${family}-${token}.wtc.invalid`;
}

function obfuscatePeerUrl(peerUrl, secret) {
  const rawPeerUrl = String(peerUrl || '').trim();
  if (!rawPeerUrl) return '';
  if (!String(secret || '').trim()) return rawPeerUrl;
  try {
    const parsed = new URL(rawPeerUrl);
    if (!isPublicIpHostname(parsed.hostname)) return rawPeerUrl;
    parsed.hostname = createPeerAlias(parsed.hostname, secret);
    return parsed.toString();
  } catch (_) {
    return rawPeerUrl;
  }
}

function getPeerPrivacyRecoveryFilePath(baseDir = '.') {
  return path.join(String(baseDir || '.'), DEV_PEER_PRIVACY_DIR, DEV_PEER_PRIVACY_FILE);
}

function buildPeerPrivacyRecoveryPayload({ secret, deviceId = '', createdAt = 0, exportedAtMs = Date.now() } = {}) {
  const normalizedSecret = String(secret || '').trim();
  if (!normalizedSecret) return null;

  return {
    version: 1,
    algorithm: 'hmac-sha256',
    aliasHostPattern: 'peer-ip{family}-{token}.wtc.invalid',
    tokenHexLength: 12,
    secret: normalizedSecret,
    deviceId: String(deviceId || '').trim(),
    createdAt: Number(createdAt) || 0,
    exportedAt: new Date(Number(exportedAtMs) || Date.now()).toISOString(),
    note: 'Developer-only recovery key for reproducing peer IP aliases in local diagnostics.',
  };
}

function writePeerPrivacyRecoveryFile({ fs, baseDir = '.', payload } = {}) {
  if (!fs || typeof fs.mkdirSync !== 'function' || typeof fs.writeFileSync !== 'function') {
    throw new Error('fs implementation is required');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('payload is required');
  }

  const filePath = getPeerPrivacyRecoveryFilePath(baseDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return filePath;
}

module.exports = {
  createPeerAlias,
  filterAdvertisedPeerUrls,
  isDirectIpPeerUrl,
  isPublicIpHostname,
  obfuscatePeerUrl,
  resolvePeerPrivacySecret,
  buildPeerPrivacyRecoveryPayload,
  getPeerPrivacyRecoveryFilePath,
  writePeerPrivacyRecoveryFile,
};
