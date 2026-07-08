'use strict';

/**
 * Governance P2P gossip module.
 * Syncs governance proposals, team/docs data across peers.
 */
function createGovernance(ctx) {
  const {
    getWtcNode,
    getLedgerNetworkSettings,
    getActivePeers,
    requestPeerJson,
    readTeamData,
    writeTeamData,
    readDocsData,
    writeDocsData,
  } = ctx;

  let _govSyncInterval = null;

  // -- Helpers ----------------------------------------------------------------

  function _nodeHasGovernanceNfts() {
    const node = getWtcNode();
    if (!node) return false;
    const addrs = node.getAddresses();
    for (const addr of addrs) {
      const nfts = node.getNftsForAddress(addr);
      if (nfts && nfts.length > 0) return true;
    }
    return false;
  }

  // -- Governance proposal sync ----------------------------------------------

  async function syncGovernanceFromPeers() {
    const node = getWtcNode();
    if (!node) return;
    if (!_nodeHasGovernanceNfts()) return;
    node.closeExpiredProposals();
    const settings = getLedgerNetworkSettings();
    if (!settings.enabled) return;
    const peers = getActivePeers(settings);
    if (!peers || peers.length === 0) return;

    const results = await Promise.allSettled(
      peers.map((peerUrl) =>
        requestPeerJson(peerUrl, 'GET', '/api/v1/governance/snapshot', undefined, undefined, {
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'governance-pull',
          timeoutMs: 10000,
        }).catch(() => null),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const snapshot = results[i].value;
      if (!snapshot || !snapshot.ok || !Array.isArray(snapshot.proposals)) continue;

      for (const proposal of snapshot.proposals) {
        let creatorNftId = '';
        let creatorTier = '';
        if (proposal.creator) {
          const creatorNfts = node.getNftsForAddress(proposal.creator);
          if (creatorNfts && creatorNfts.length > 0) {
            const TIER_RANK = { gold: 3, silver: 2, bronze: 1 };
            let bestTier = 'bronze';
            let bestNftId = '';
            for (const nft of creatorNfts) {
              const tier = (nft.metadata && nft.metadata.tier) || 'bronze';
              if ((TIER_RANK[tier] || 0) > (TIER_RANK[bestTier] || 0)) {
                bestTier = tier;
                bestNftId = nft.nftId;
              }
            }
            creatorNftId = bestNftId;
            creatorTier = bestTier;
          }
        }

        const propResult = node.addGovernanceProposal({
          pipId: proposal.pipId,
          title: proposal.title,
          description: proposal.description || '',
          creator: proposal.creator || '',
          createdAt: proposal.createdAt || Date.now(),
          creatorNftId,
          creatorTier,
          votingDurationWeeks: Math.max(2, Math.min(10, Math.floor(Number(proposal.votingDurationWeeks) || 2))),
          commentPeriodWeeks: Math.max(1, Math.min(4, Math.floor(Number(proposal.commentPeriodWeeks) || 2))),
        });

        if (propResult.ok && proposal.votes) {
          for (const voterAddr of Object.keys(proposal.votes)) {
            const v = proposal.votes[voterAddr];
            if (!v || !v.signature) continue;

            const msg = `${proposal.pipId}|${v.voter}|${v.vote}|${v.power}|${v.nftTier}|${v.timestamp}`;
            if (!node.verifyMessage(v.voter, v.signature, msg)) continue;

            node.addGovernanceVote(proposal.pipId, {
              voter: v.voter,
              vote: v.vote,
              power: v.power,
              nftTier: v.nftTier,
              timestamp: v.timestamp,
              signature: v.signature,
            });
          }
        }
      }
    }
  }

  // -- Sync lifecycle --------------------------------------------------------

  function startGovernanceSync() {
    stopGovernanceSync();
    const doSync = () => {
      syncGovernanceFromPeers().catch(() => {});
      syncTeamDocsFromPeers().catch(() => {});
    };
    setTimeout(() => doSync(), 5000);
    _govSyncInterval = setInterval(() => doSync(), 30_000);
  }

  function stopGovernanceSync() {
    if (_govSyncInterval) {
      clearInterval(_govSyncInterval);
      _govSyncInterval = null;
    }
  }

  // -- Team/docs sync --------------------------------------------------------

  async function syncTeamDocsFromPeers() {
    const node = getWtcNode();
    if (!node) return;
    if (!_nodeHasGovernanceNfts()) return;
    const settings = getLedgerNetworkSettings();
    if (!settings.enabled) return;
    const peers = getActivePeers(settings);
    if (!peers || peers.length === 0) return;

    const results = await Promise.allSettled(
      peers.map((peerUrl) =>
        requestPeerJson(peerUrl, 'GET', '/api/v1/governance/team-docs', undefined, undefined, {
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'team-docs-pull',
          timeoutMs: 10000,
        }).catch(() => null),
      ),
    );

    const mergedMembers = {};
    const mergedDocs = {};
    for (const m of readTeamData()) mergedMembers[m.id] = m;
    for (const d of readDocsData()) mergedDocs[d.id] = d;

    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      const snap = results[i].value;
      if (!snap || !snap.ok) continue;
      if (Array.isArray(snap.members)) {
        for (const m of snap.members) {
          if (!mergedMembers[m.id] || m.addedAt > mergedMembers[m.id].addedAt) {
            mergedMembers[m.id] = m;
          }
        }
      }
      if (Array.isArray(snap.docs)) {
        for (const d of snap.docs) {
          if (!mergedDocs[d.id] || d.addedAt > mergedDocs[d.id].addedAt) {
            mergedDocs[d.id] = d;
          }
        }
      }
    }

    writeTeamData(Object.values(mergedMembers));
    writeDocsData(Object.values(mergedDocs));
  }

  function broadcastTeamDocsToPeers() {
    const settings = getLedgerNetworkSettings();
    if (!settings.enabled) return;
    const peers = getActivePeers(settings);
    if (!peers || peers.length === 0) return;
    const payload = { ok: true, members: readTeamData(), docs: readDocsData() };
    for (const peerUrl of peers) {
      requestPeerJson(peerUrl, 'POST', '/api/v1/governance/team-docs', payload, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'team-docs-push',
        timeoutMs: 5000,
      }).catch(() => {});
    }
  }

  return {
    syncGovernanceFromPeers,
    startGovernanceSync,
    stopGovernanceSync,
    syncTeamDocsFromPeers,
    broadcastTeamDocsToPeers,
  };
}

module.exports = { createGovernance };
