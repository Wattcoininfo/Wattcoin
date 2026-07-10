'use strict';

const fs = require('fs');
const path = require('path');

function isPrivateOrLocalHostname(hostname) {
  const normalizedHost = String(hostname || '')
    .trim()
    .toLowerCase();
  if (!normalizedHost) return true;
  if (normalizedHost === 'localhost') return true;
  if (normalizedHost === '::1') return true;
  if (normalizedHost.endsWith('.local')) return true;

  const ipv4Match = normalizedHost.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4Match) return false;

  const octets = ipv4Match.slice(1).map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  if (octets[0] === 10) return true;
  if (octets[0] === 127) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;

  return false;
}

function getNetworkSegment(url) {
  try {
    const host = new URL(url).hostname;
    const parts = host.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    }
    return host;
  } catch (_) {
    return '';
  }
}

function main() {
  const filePath = path.join(__dirname, '..', 'docs', 'seed-peers.mainnet.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing seed peer file: ${filePath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const seedPeers = Array.isArray(parsed.seedPeers)
    ? parsed.seedPeers
    : Array.isArray(parsed.peers)
      ? parsed.peers
      : [];
  const urls = seedPeers.map((p) => String((p && p.url) || '').trim()).filter(Boolean);
  const privateOrLocalUrls = urls.filter((url) => {
    try {
      return isPrivateOrLocalHostname(new URL(url).hostname);
    } catch (_) {
      return true;
    }
  });
  const providers = new Set(seedPeers.map((p) => String((p && p.provider) || '').trim()).filter(Boolean));
  const segments = new Set(urls.map(getNetworkSegment).filter(Boolean));

  const requiredMinSeedPeers = Number(parsed.requiredMinSeedPeers) || Number(parsed.requiredMinPeers) || 6;
  const requiredMinProviders = Number(parsed.requiredMinProviders) || 3;
  const requiredMinNetworkSegments = Number(parsed.requiredMinNetworkSegments) || 3;

  const failures = [];
  if (urls.length < requiredMinSeedPeers) {
    failures.push(`seed peer count ${urls.length} < required ${requiredMinSeedPeers}`);
  }
  if (providers.size < requiredMinProviders) {
    failures.push(`provider diversity ${providers.size} < required ${requiredMinProviders}`);
  }
  if (segments.size < requiredMinNetworkSegments) {
    failures.push(`network segment diversity ${segments.size} < required ${requiredMinNetworkSegments}`);
  }
  if (privateOrLocalUrls.length > 0) {
    failures.push(
      `bundled mainnet seeds must be publicly routable, found private/local endpoints: ${privateOrLocalUrls.join(', ')}`,
    );
  }

  if (failures.length > 0) {
    console.error('[seed-peers] FAIL');
    for (const msg of failures) console.error(' -', msg);
    process.exitCode = 1;
    return;
  }

  console.log('[seed-peers] PASS');
  console.log(' seedPeers:', urls.length);
  console.log(' providers:', providers.size);
  console.log(' segments:', segments.size);
}

main();
