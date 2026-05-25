// SPDX-License-Identifier: MIT
'use strict';

function buildPeerDiscoverySnapshot({ settings, discoveredEntries, staleThresholdMs, isPeerUrlBanned, nowMs = Date.now(), transformUrl }) {
  const bySource = {};
  const discovered = [];
  const rows = Array.isArray(discoveredEntries) ? discoveredEntries : [];
  const bannedCheck = typeof isPeerUrlBanned === 'function' ? isPeerUrlBanned : () => false;
  const mapUrl = typeof transformUrl === 'function' ? transformUrl : (value) => value;

  for (const entry of rows) {
    const url = entry && entry.url ? String(entry.url) : '';
    const info = entry && entry.info ? entry.info : null;
    if (!url || !info) continue;
    if (Number.isFinite(staleThresholdMs) && staleThresholdMs >= 0 && nowMs - (Number(info.lastSeenMs) || 0) > staleThresholdMs) continue;
    if (bannedCheck(url)) continue;

    const sources = Array.isArray(info.sources) && info.sources.length > 0
      ? [...info.sources]
      : [info.source || 'peer-exchange'];

    for (const source of sources) {
      const key = String(source || 'unknown');
      bySource[key] = (bySource[key] || 0) + 1;
    }

    discovered.push({
      url: mapUrl(url),
      lastSeenMs: Number(info.lastSeenMs) || 0,
      source: String(info.source || 'peer-exchange'),
      sources,
    });
  }

  discovered.sort((a, b) => a.url.localeCompare(b.url));

  return {
    configuredPeers: Array.isArray(settings && settings.configuredPeers) ? settings.configuredPeers.length : 0,
    seedPeers: Array.isArray(settings && settings.seedPeers) ? settings.seedPeers.length : 0,
    discoveredPeers: discovered.length,
    discoveredBySource: bySource,
    directory: discovered,
  };
}

module.exports = {
  buildPeerDiscoverySnapshot,
};