'use strict';

const assert = require('assert');

const { countLiveReverseTunnelPeers, summarizeDisplayedPeerCounts } = require('../electron-main/peer-utils');

function testIgnoresCoordinatorAndOnlyCountsLiveInboundTunnelPeers() {
  const nowMs = 1_000_000;
  const sessions = [
    {
      tunnelId: 'peer-a-1',
      peerIdentity: 'peer-a',
      socket: { readyState: 1 },
      lastSeenAtMs: nowMs - 1_000,
    },
    {
      tunnelId: 'peer-a-2',
      peerIdentity: 'peer-a',
      socket: { readyState: 1 },
      lastSeenAtMs: nowMs - 500,
    },
    {
      tunnelId: 'peer-b',
      peerIdentity: '',
      socket: { readyState: 1 },
      lastSeenAtMs: nowMs - 750,
    },
    {
      tunnelId: 'stale-peer',
      peerIdentity: 'peer-stale',
      socket: { readyState: 1 },
      lastSeenAtMs: nowMs - 20_000,
    },
    {
      tunnelId: 'closed-peer',
      peerIdentity: 'peer-closed',
      socket: { readyState: 3 },
      lastSeenAtMs: nowMs - 100,
    },
  ];

  assert.strictEqual(
    countLiveReverseTunnelPeers({
      sessions,
      nowMs,
      liveThresholdMs: 5_000,
      openState: 1,
    }),
    2,
  );
}

function testDisplayedPeerCountsDoNotIncludeLocalNode() {
  assert.deepStrictEqual(summarizeDisplayedPeerCounts({ healthyDistinct: 0, reverseTunnelDistinct: 0 }), {
    activeCount: 0,
    onlineCount: 0,
    tunnelCount: 0,
  });

  assert.deepStrictEqual(summarizeDisplayedPeerCounts({ healthyDistinct: 1, reverseTunnelDistinct: 0 }), {
    activeCount: 1,
    onlineCount: 1,
    tunnelCount: 0,
  });

  assert.deepStrictEqual(summarizeDisplayedPeerCounts({ healthyDistinct: 0, reverseTunnelDistinct: 2 }), {
    activeCount: 0,
    onlineCount: 2,
    tunnelCount: 2,
  });
}

function run() {
  testIgnoresCoordinatorAndOnlyCountsLiveInboundTunnelPeers();
  testDisplayedPeerCountsDoNotIncludeLocalNode();
  console.log('peer count observability tests passed');
}

run();
