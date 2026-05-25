const assert = require('assert');

const { buildPeerDiscoverySnapshot } = require('../peer-discovery-observability');
const { obfuscatePeerUrl } = require('../peer-privacy');

function testDiscoverySnapshotIncludesSourceFields() {
  const snapshot = {
    peers: {
      discovery: buildPeerDiscoverySnapshot({
        settings: {
          configuredPeers: ['http://127.0.0.1:39310'],
          seedPeers: ['http://127.0.0.1:39311'],
        },
        discoveredEntries: [
          {
            url: 'http://127.0.0.1:39312',
            info: {
              lastSeenMs: Date.now(),
              source: 'peer-exchange',
              sources: ['lan-beacon', 'peer-exchange'],
            },
          },
          {
            url: 'http://127.0.0.1:39313',
            info: {
              lastSeenMs: Date.now(),
              source: 'seed-cache',
              sources: ['seed-cache'],
            },
          },
        ],
        staleThresholdMs: 5 * 60 * 1000,
        isPeerUrlBanned: () => false,
      }),
    },
  };

  assert.ok(snapshot.peers.discovery, 'discovery snapshot should exist');
  assert.strictEqual(snapshot.peers.discovery.configuredPeers, 1);
  assert.strictEqual(snapshot.peers.discovery.seedPeers, 1);
  assert.strictEqual(snapshot.peers.discovery.discoveredPeers, 2);
  assert.ok(snapshot.peers.discovery.discoveredBySource, 'discoveredBySource should exist');
  assert.strictEqual(snapshot.peers.discovery.discoveredBySource['lan-beacon'], 1);
  assert.strictEqual(snapshot.peers.discovery.discoveredBySource['peer-exchange'], 1);
  assert.strictEqual(snapshot.peers.discovery.discoveredBySource['seed-cache'], 1);
  assert.ok(Array.isArray(snapshot.peers.discovery.directory), 'discovery directory should exist');
  assert.strictEqual(snapshot.peers.discovery.directory.length, 2);
}

function testDiscoverySnapshotObfuscatesPublicPeerIps() {
  const snapshot = buildPeerDiscoverySnapshot({
    settings: {
      configuredPeers: [],
      seedPeers: [],
    },
    discoveredEntries: [
      {
        url: 'http://203.0.113.10:39310',
        info: {
          lastSeenMs: Date.now(),
          source: 'peer-exchange',
          sources: ['peer-exchange'],
        },
      },
      {
        url: 'http://192.168.1.44:39310',
        info: {
          lastSeenMs: Date.now(),
          source: 'lan-beacon',
          sources: ['lan-beacon'],
        },
      },
    ],
    staleThresholdMs: 5 * 60 * 1000,
    isPeerUrlBanned: () => false,
    transformUrl: (url) => obfuscatePeerUrl(url, 'peer-privacy-test-secret'),
  });

  const discoveredUrls = snapshot.directory.map((entry) => entry.url).sort();
  assert.ok(discoveredUrls.includes('http://192.168.1.44:39310'));
  assert.ok(discoveredUrls.some((url) => /^http:\/\/peer-ip4-[a-f0-9]{12}\.wtc\.invalid:39310\/$/.test(url)));
}

function run() {
  testDiscoverySnapshotIncludesSourceFields();
  testDiscoverySnapshotObfuscatesPublicPeerIps();
  console.log('peer discovery ops integration tests passed');
}

run();
