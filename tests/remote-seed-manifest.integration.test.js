'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRemoteSeedManifestManager } = require('../remote-seed-manifest');

function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (_) {
    // Best effort cleanup.
  }
}

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

function createManager(baseDir, { requestExternalResponse, runtimeConfig, syncEvents }) {
  return createRemoteSeedManifestManager({
    fs,
    getRuntimeConfig: () => runtimeConfig,
    getCachePath: () => path.join(baseDir, 'remote-seed-peers-cache.json'),
    normalizePeerUrl,
    isDeprecatedPeerUrl: () => false,
    requestExternalResponse,
    fetchTimeoutMs: 5000,
    defaultRemoteSeedManifestUrls: [],
    schedulePeerSync: (reason, delayMs) => syncEvents.push({ reason, delayMs }),
    logger: { log() {}, warn() {} },
  });
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtc-remote-seed-manifest-'));
  try {
    const syncEvents = [];
    const runtimeConfig = {
      network: 'wtc-mainnet',
      ledgerSeedManifestUrls: ['https://manifest.example/seed-peers.mainnet.json'],
    };

    const goodManager = createManager(baseDir, {
      runtimeConfig,
      syncEvents,
      requestExternalResponse: (url) => {
        assert.strictEqual(url, runtimeConfig.ledgerSeedManifestUrls[0]);
        return {
          statusCode: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            seedPeers: [{ url: 'http://198.51.100.24:39310' }, { url: 'http://198.51.100.24:39310' }],
          }),
        };
      },
    });

    const goodPeers = await goodManager.refreshRemoteSeedPeers({ enabled: true });
    assert.deepStrictEqual(goodPeers, ['http://198.51.100.24:39310'], 'good manifest should normalize and cache peers');
    assert.strictEqual(syncEvents.length, 1, 'manifest change should schedule peer sync');

    const malformedManager = createManager(baseDir, {
      runtimeConfig,
      syncEvents: [],
      requestExternalResponse: () => ({
        statusCode: 200,
        contentType: 'text/plain',
        body: 'not-json',
      }),
    });
    const malformedPeers = await malformedManager.refreshRemoteSeedPeers({ enabled: true });
    assert.deepStrictEqual(
      malformedPeers,
      ['http://198.51.100.24:39310'],
      'malformed manifest should fall back to cached peers',
    );

    const timeoutManager = createManager(baseDir, {
      runtimeConfig,
      syncEvents: [],
      requestExternalResponse: () => {
        throw new Error('timeout');
      },
    });
    const timeoutPeers = await timeoutManager.refreshRemoteSeedPeers({ enabled: true });
    assert.deepStrictEqual(
      timeoutPeers,
      ['http://198.51.100.24:39310'],
      'timeout should also fall back to cached peers',
    );

    const freshManager = createManager(baseDir, {
      runtimeConfig,
      syncEvents: [],
      requestExternalResponse: () => {
        throw new Error('seed manifest unavailable');
      },
    });
    const cachedPeers = freshManager.loadCachedRemoteSeedPeers();
    assert.deepStrictEqual(
      cachedPeers,
      ['http://198.51.100.24:39310'],
      'fresh manager should reuse cached remote peers from disk',
    );

    const effectiveSeedPeers = freshManager.buildEffectiveSeedPeers({
      network: 'wtc-mainnet',
      bootstrapPeers: ['http://62.65.200.145:39310'],
      bundledSeedPeers: ['http://62.65.200.145:39310'],
      cachedRemoteSeedPeers: cachedPeers,
    });
    assert.deepStrictEqual(
      effectiveSeedPeers,
      ['http://62.65.200.145:39310', 'http://198.51.100.24:39310'],
      'fresh-node bootstrap set should include cached remote backup peers',
    );

    const availability = new Map([
      ['http://62.65.200.145:39310', false],
      ['http://198.51.100.24:39310', true],
    ]);
    const bootstrapPeer = effectiveSeedPeers.find((peerUrl) => availability.get(peerUrl) === true) || '';
    assert.strictEqual(
      bootstrapPeer,
      'http://198.51.100.24:39310',
      'fresh-node bootstrap should still have a reachable backup when the primary seed is unavailable',
    );

    console.log('remote seed manifest integration tests passed');
  } finally {
    rmrf(baseDir);
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
