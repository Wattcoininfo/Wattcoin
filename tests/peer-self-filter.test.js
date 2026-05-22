'use strict';

const assert = require('assert');

const { isSelfPeerUrlCandidate, filterExternalPeerUrls } = require('../peer-self-filter');

function testRootPeerUrlOnLocalHostIsSelf() {
  assert.strictEqual(
    isSelfPeerUrlCandidate('http://62.65.200.145:39310', {
      selfAdvertisedUrls: [],
      listenPort: 39310,
      localHosts: ['62.65.200.145', '127.0.0.1', 'localhost'],
    }),
    true,
  );
}

function testExactAdvertisedTunnelUrlIsSelf() {
  assert.strictEqual(
    isSelfPeerUrlCandidate('http://62.65.200.145:39310/api/v1/tunnel/self-tunnel', {
      selfAdvertisedUrls: ['http://62.65.200.145:39310/api/v1/tunnel/self-tunnel'],
      listenPort: 39310,
      localHosts: ['62.65.200.145'],
    }),
    true,
  );
}

function testDifferentTunnelUrlSameHostPortIsNotSelf() {
  assert.strictEqual(
    isSelfPeerUrlCandidate('http://62.65.200.145:39310/api/v1/tunnel/remote-peer', {
      selfAdvertisedUrls: [],
      listenPort: 39310,
      localHosts: ['62.65.200.145', '127.0.0.1', 'localhost'],
    }),
    false,
  );
}

function testFilterExternalPeerUrlsRemovesExactSelfAndKeepsRemoteTunnel() {
  const peers = filterExternalPeerUrls([
    'http://62.65.200.145:39310',
    'http://62.65.200.145:39310/api/v1/tunnel/self-tunnel',
    'http://62.65.200.145:39310/api/v1/tunnel/remote-peer',
    'http://203.0.113.10:39310',
  ], {
    selfAdvertisedUrls: ['http://62.65.200.145:39310/api/v1/tunnel/self-tunnel'],
    listenPort: 39310,
    localHosts: ['62.65.200.145', '127.0.0.1', 'localhost'],
  });

  assert.deepStrictEqual(peers, [
    'http://62.65.200.145:39310/api/v1/tunnel/remote-peer',
    'http://203.0.113.10:39310',
  ]);
}

function run() {
  testRootPeerUrlOnLocalHostIsSelf();
  testExactAdvertisedTunnelUrlIsSelf();
  testDifferentTunnelUrlSameHostPortIsNotSelf();
  testFilterExternalPeerUrlsRemovesExactSelfAndKeepsRemoteTunnel();
  console.log('peer self-filter tests passed');
}

run();