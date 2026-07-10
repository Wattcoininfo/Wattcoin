// SPDX-License-Identifier: MIT
'use strict';

function countLiveReverseTunnelPeers({ sessions = [], nowMs = Date.now(), liveThresholdMs = 0, openState = 1 } = {}) {
  const inboundConnections = new Set();
  for (const session of sessions) {
    if (!session || !session.socket || session.socket.readyState !== openState) continue;
    if (nowMs - Number(session.lastSeenAtMs || 0) > liveThresholdMs) continue;
    const key = String(session.peerIdentity || '').trim() || `tunnel:${String(session.tunnelId || '').trim()}`;
    inboundConnections.add(key);
  }
  return inboundConnections.size;
}

function summarizeDisplayedPeerCounts({ healthyDistinct = 0, reverseTunnelDistinct = 0 } = {}) {
  const activeCount = Math.max(0, Number(healthyDistinct) || 0);
  const tunnelCount = Math.max(0, Number(reverseTunnelDistinct) || 0);
  const onlineCount = Math.max(activeCount, tunnelCount);
  return {
    activeCount,
    onlineCount,
    tunnelCount: Math.min(tunnelCount, onlineCount),
  };
}

module.exports = {
  countLiveReverseTunnelPeers,
  summarizeDisplayedPeerCounts,
};
