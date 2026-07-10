function registerMiningIpcHandlers(
  ipcMain,
  {
    walletAddressCache,
    enforceEndpointRateLimit,
    enforceReattestationGateForMiner,
    getWtcNode,
    hasOnlinePeers,
    getLedgerNetworkSettings,
    normalizeProbeReceipt,
    hasRecentPeerAttestationRelation,
    buildPowerProofCommitment,
    getSharedRoundSnapshot,
    buildRewardMapFromRoundSnapshot,
    hwAuthority,
    announceTipToPeers,
    pushChainToPeers,
    saleQueue,
    stakingQueue,
  },
) {
  let mineBlockBusy = false;

  ipcMain.handle('wattcoin-mine-block', async (_, selectedAddress, proofData) => {
    const _walletName = 'wattminer';
    const verifiedAddr = walletAddressCache.address || '';
    const actorId =
      verifiedAddr ||
      (typeof selectedAddress === 'string' && selectedAddress.trim() ? selectedAddress.trim() : 'local-client');
    const rateLimit = await enforceEndpointRateLimit('wattcoin-mine-block', actorId, { selectedAddress: actorId });
    if (!rateLimit.ok) {
      return {
        address: '',
        mined: '',
        error: rateLimit.message,
        code: rateLimit.code,
        lockedUntil: rateLimit.lockedUntil || 0,
      };
    }
    const reattestationGate = enforceReattestationGateForMiner(actorId, {}, { allowSpotCheck: true });
    if (!reattestationGate.ok) {
      return {
        address: '',
        mined: '',
        error: reattestationGate.message,
        code: reattestationGate.code,
        reasons: reattestationGate.reasons || [],
        policy: reattestationGate.policy || null,
      };
    }

    const wtcNode = getWtcNode();
    if (wtcNode) {
      if (mineBlockBusy) {
        return { address: '', mined: '', error: 'A block is already being mined - please wait.', code: 'MINE_BUSY' };
      }
      if (!hasOnlinePeers(getLedgerNetworkSettings())) {
        return {
          address: '',
          mined: '',
          error: 'At least one peer must be connected before mining. Waiting for peer connection...',
          code: 'NO_PEERS',
        };
      }
      if (!(proofData && proofData.peerProbeVerified)) {
        return {
          address: '',
          mined: '',
          error: 'A peer probe is required before mining. Complete a peer probe first.',
          code: 'PEER_PROBE_REQUIRED',
        };
      }
      const probeReceipt =
        proofData && proofData.probeReceipt && typeof proofData.probeReceipt === 'object'
          ? normalizeProbeReceipt(proofData.probeReceipt)
          : null;
      if (
        probeReceipt &&
        probeReceipt.verifierAddress &&
        probeReceipt.workerId &&
        hasRecentPeerAttestationRelation(probeReceipt.verifierAddress, probeReceipt.workerId)
      ) {
        return {
          address: '',
          mined: '',
          error:
            'Peer receipt comes from a peer with recent reciprocal attestation activity. Select a different verifier peer.',
          code: 'RECIPROCAL_PEER_ATTESTATION',
        };
      }
      mineBlockBusy = true;
      try {
        const preferred = typeof selectedAddress === 'string' ? selectedAddress.trim() : '';
        const addr = preferred && wtcNode.getAddresses().includes(preferred) ? preferred : wtcNode.getPrimaryAddress();
        const commitment = buildPowerProofCommitment(proofData);
        const sharedRoundSnapshot = getSharedRoundSnapshot();
        const rewardMap = buildRewardMapFromRoundSnapshot(sharedRoundSnapshot, addr);
        const effectiveEnergyWh = Math.max(
          Number(proofData && proofData.energyWh) || 0,
          Number(sharedRoundSnapshot.totalWh) || 0,
        );
        hwAuthority.pendingProofCommitment = commitment || '';
        const result = await wtcNode.mineBlock(
          addr,
          {
            energyWh: effectiveEnergyWh,
            proofCommitment: commitment || '',
            peerProbeVerified: !!(proofData && proofData.peerProbeVerified),
            probeReceipt:
              proofData && proofData.probeReceipt && typeof proofData.probeReceipt === 'object'
                ? normalizeProbeReceipt(proofData.probeReceipt)
                : null,
            probesAnswered: Math.max(0, Math.floor(Number(proofData && proofData.probesAnswered) || 0)),
            cpuSpeedInitialSeed: Number(proofData && proofData.cpuSpeedInitialSeed) || 0,
            cpuSpeedProof: String((proofData && proofData.cpuSpeedProof) || ''),
            memProof: String((proofData && proofData.memProof) || ''),
            memProofSeed: Number(proofData && proofData.memProofSeed) || 0,
            gpuProof: String((proofData && proofData.gpuProof) || ''),
            gpuProofSeed: Number(proofData && proofData.gpuProofSeed) || 0,
          },
          rewardMap,
        );
        announceTipToPeers({ height: result.height, hash: result.hash });
        pushChainToPeers({ windowSize: 200 });
        saleQueue.onBlockConfirmed();
        saleQueue.flushSaleQueue().catch((e) => console.warn('[SaleQueue] post-mine flush error:', e && e.message));
        stakingQueue
          .flushStakingQueue()
          .catch((e) => console.warn('[StakingQueue] post-mine flush error:', e && e.message));
        return {
          walletName: 'wtc-native',
          address: result.address,
          mined: result.hash,
          blockHash: result.hash,
          proofCommitment: commitment || null,
          proofTxid: null,
          height: result.height,
          reward: result.reward,
          energyWh: effectiveEnergyWh,
          contributionsWh: sharedRoundSnapshot.contributionsWh,
          roundId: sharedRoundSnapshot.id,
        };
      } catch (e) {
        return { address: '', mined: '', error: e && e.message ? e.message : 'Mine failed' };
      } finally {
        mineBlockBusy = false;
      }
    }
  });
}

module.exports = { registerMiningIpcHandlers };
