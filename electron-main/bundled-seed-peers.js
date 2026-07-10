const path = require('path');
const fs = require('fs');
const { normalizePeerUrl, isDeprecatedPeerUrl } = require('./main-utils');

const BUNDLED_SEED_PEER_FILE_NAMES = ['seed-peers.mainnet.json', 'bootstrap-peers.mainnet.json'];
let bundledSeedPeersCache = null;

function getBundledSeedPeerCandidates() {
  const candidates = [];
  for (const fileName of BUNDLED_SEED_PEER_FILE_NAMES) {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, fileName));
    }
    candidates.push(
      path.join(__dirname, 'docs', fileName),
      path.join(__dirname, 'resources', fileName),
      path.join(__dirname, '..', 'docs', fileName),
      path.join(__dirname, '..', 'resources', fileName),
    );
  }
  return Array.from(new Set(candidates));
}

function loadBundledSeedPeers() {
  if (bundledSeedPeersCache) return bundledSeedPeersCache;

  for (const candidate of getBundledSeedPeerCandidates()) {
    try {
      if (!candidate || !fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      const peerEntries = Array.isArray(parsed && parsed.seedPeers)
        ? parsed.seedPeers
        : Array.isArray(parsed && parsed.peers)
          ? parsed.peers
          : [];
      const peers = peerEntries
        .map((peer) => {
          const rawUrl = (peer && peer.url) || peer || '';
          if (peer && peer.ipB64 && typeof peer.ipB64 === 'string') {
            try {
              const decoded = Buffer.from(peer.ipB64, 'base64').toString('utf8').trim();
              if (decoded) return normalizePeerUrl(`http://${decoded}`);
            } catch (err) {
              console.warn('[HW-Identity] si.system() failed:', String(err?.message || err).slice(0, 200));
            }
          }
          return normalizePeerUrl(rawUrl);
        })
        .filter((peer) => peer && !isDeprecatedPeerUrl(peer));
      bundledSeedPeersCache = peers;
      console.log(`[Bootstrap] Loaded ${peers.length} bundled peers from ${candidate}`);
      return bundledSeedPeersCache;
    } catch (err) {
      console.warn('[Bootstrap] Failed to load bundled peers:', err && err.message ? err.message : err);
    }
  }

  bundledSeedPeersCache = [];
  return bundledSeedPeersCache;
}

module.exports = { loadBundledSeedPeers, getBundledSeedPeerCandidates };
