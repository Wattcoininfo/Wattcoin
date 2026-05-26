// SPDX-License-Identifier: MIT
'use strict';

function parseIpv4Octets(address) {
  const raw = String(address || '').trim();
  if (!raw) return null;
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function ipv4ToInt(address) {
  const octets = parseIpv4Octets(address);
  if (!octets) return null;
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function intToIpv4(value) {
  const normalized = Number(value) >>> 0;
  return [(normalized >>> 24) & 255, (normalized >>> 16) & 255, (normalized >>> 8) & 255, normalized & 255].join('.');
}

function isPrivateIpv4(address) {
  const octets = parseIpv4Octets(address);
  if (!octets) return false;
  if (octets[0] === 10) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  return false;
}

function getPeerUrlPreferenceScore(candidate) {
  try {
    const parsed = new URL(String(candidate || '').trim());
    const hostname = String(parsed.hostname || '').trim();
    const pathname = String(parsed.pathname || '').replace(/\/+$/, '') || '/';
    const isTunnel = pathname.startsWith('/api/v1/tunnel/');
    if (isPrivateIpv4(hostname)) {
      return isTunnel ? 3 : 4;
    }
    return isTunnel ? 1 : 2;
  } catch (_) {
    return 0;
  }
}

function selectPreferredPeerUrl(currentPeerUrl = '', candidatePeerUrl = '') {
  const current = String(currentPeerUrl || '').trim();
  const candidate = String(candidatePeerUrl || '').trim();
  if (!current) return candidate;
  if (!candidate) return current;
  const currentScore = getPeerUrlPreferenceScore(current);
  const candidateScore = getPeerUrlPreferenceScore(candidate);
  if (candidateScore > currentScore) return candidate;
  if (candidateScore < currentScore) return current;
  return current.localeCompare(candidate) <= 0 ? current : candidate;
}

function sortPeerUrlsByPreference(peerUrls = []) {
  return Array.from(
    new Set((Array.isArray(peerUrls) ? peerUrls : []).map((entry) => String(entry || '').trim()).filter(Boolean)),
  ).sort((left, right) => {
    const scoreDelta = getPeerUrlPreferenceScore(right) - getPeerUrlPreferenceScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    return left.localeCompare(right);
  });
}

function selectDiscoveryPeerUrl(peerUrls = []) {
  let preferredPeerUrl = '';
  for (const candidate of Array.isArray(peerUrls) ? peerUrls : []) {
    preferredPeerUrl = selectPreferredPeerUrl(preferredPeerUrl, candidate);
  }
  return preferredPeerUrl;
}

function countMaskBits(maskInt) {
  let seenZero = false;
  let bits = 0;
  for (let shift = 31; shift >= 0; shift -= 1) {
    const bit = (maskInt >>> shift) & 1;
    if (bit === 1) {
      if (seenZero) return null;
      bits += 1;
    } else {
      seenZero = true;
    }
  }
  return bits;
}

function getLocalSubnetProbeCandidates(interfaces, { selfHosts = [] } = {}) {
  const candidates = new Set();
  const excludedHosts = new Set(
    (Array.isArray(selfHosts) ? selfHosts : []).map((entry) => String(entry || '').trim()).filter(Boolean),
  );

  for (const entry of Array.isArray(interfaces) ? interfaces : []) {
    if (!entry || entry.internal) continue;
    const address = String(entry.address || '').trim();
    if (!isPrivateIpv4(address)) continue;
    const addressInt = ipv4ToInt(address);
    const maskInt = ipv4ToInt(entry.netmask);
    if (addressInt === null || maskInt === null) continue;
    const prefixBits = countMaskBits(maskInt);
    if (!Number.isInteger(prefixBits)) continue;
    const effectivePrefixBits = Math.max(prefixBits, 24);
    const effectiveMaskInt = effectivePrefixBits === 0 ? 0 : (0xffffffff << (32 - effectivePrefixBits)) >>> 0;
    const networkInt = (addressInt & effectiveMaskInt) >>> 0;
    const broadcastInt = (networkInt | (~effectiveMaskInt >>> 0)) >>> 0;
    for (let current = networkInt + 1; current < broadcastInt; current += 1) {
      const candidate = intToIpv4(current);
      if (candidate === address || excludedHosts.has(candidate)) continue;
      candidates.add(candidate);
    }
  }

  return Array.from(candidates).sort((left, right) => {
    const leftInt = ipv4ToInt(left);
    const rightInt = ipv4ToInt(right);
    return (leftInt || 0) - (rightInt || 0);
  });
}

/**
 * Pure predicate for the LAN subnet-probe gate.
 *
 * Returns true if any peer in `peerUrls` is a private-IPv4 peer that is
 * currently considered "known" — i.e. either recently discovered (within
 * staleThresholdMs) or recently reachability-verified (within
 * reachabilitySuccessTtlMs).  Stale or only-statically-configured private
 * peers are NOT treated as "known" so subnet probing is not suppressed.
 *
 * All state is injected so the function is testable without Electron.
 *
 * @param {string[]} peerUrls
 * @param {{
 *   discoveredPeers?: Map,
 *   peerReachabilityCache?: Map,
 *   normalizePeerUrl?: (url: string) => string,
 *   isSelfPeerUrl?: (url: string) => boolean,
 *   staleThresholdMs?: number,
 *   reachabilitySuccessTtlMs?: number,
 *   now?: number,
 * }} opts
 */
function checkHasKnownPrivateLanPeer(
  peerUrls,
  {
    discoveredPeers = new Map(),
    peerReachabilityCache = new Map(),
    normalizePeerUrl = (url) => url,
    isSelfPeerUrl = () => false,
    staleThresholdMs = 5 * 60_000,
    reachabilitySuccessTtlMs = 10 * 60_000,
    now = Date.now(),
  } = {},
) {
  for (const peerUrl of Array.isArray(peerUrls) ? peerUrls : []) {
    try {
      const parsed = new URL(String(peerUrl || '').trim());
      const hostname = String(parsed.hostname || '').trim();
      if (!hostname || !isPrivateIpv4(hostname)) continue;
      if (isSelfPeerUrl(peerUrl)) continue;

      const normalized = normalizePeerUrl(peerUrl);

      const discovered = normalized ? discoveredPeers.get(normalized) : null;
      if (discovered && now - Number(discovered.lastSeenMs || 0) <= staleThresholdMs) {
        return true;
      }

      const reachability = normalized ? peerReachabilityCache.get(normalized) : null;
      if (
        reachability &&
        reachability.ok &&
        now - Number(reachability.lastSuccessAtMs || 0) <= reachabilitySuccessTtlMs
      ) {
        return true;
      }
    } catch (_) { /* istanbul ignore next */ }
  }
  return false;
}

module.exports = {
  checkHasKnownPrivateLanPeer,
  getLocalSubnetProbeCandidates,
  isPrivateIpv4,
  selectDiscoveryPeerUrl,
  selectPreferredPeerUrl,
  sortPeerUrlsByPreference,
};
