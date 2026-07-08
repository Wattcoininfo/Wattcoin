'use strict';

const { getGpuTdpW, getExpectedCpuSpeedOps } = require('../hardware-tables.cjs');
const { PROBE_INTERVAL_MS, PROBE_CPU_ITERS } = require('../backend-benchmark');

const ROUND_CONTRIBUTION_MESSAGE_PREFIX = 'wtc-round-contribution-v1';

function createRoundContributions(deps) {
  const {
    roundLedger,
    getWtcNode,
    hwAuthority,
    walletAddressCache,
    getLedgerNetworkSettings,
    getActivePeers,
    getCurrentBlockHeight,
    getCurrentNetworkRoundId,
    requestPeerJson,
    normalizePeerUrl,
    getLocalProbeChain,
    rewardForHeight,
    getActiveNetwork,
    computeHwAuthSig,
    recordForkMismatch,
    alignRoundLedgerToChain,
    ENABLE_POWER_PROOF_COMMITMENT,
    console,
    _pendingContributionWh,
    _contributionPerSecond,
    _contributionSecondStart,
    pendingRoundContributionBroadcasts,
    witnessedSettlements,
    witnessedProbeReceipts,
    bootstrapPeerAddresses,
    MIN_PROBE_VERIFIERS,
    REVERSE_TUNNEL_LIVE_THRESHOLD_MS,
    ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS,
  } = deps;

  function validateContributionProbe(address, totalWh, chainIndex) {
    let attestedPowerW = 0;
    if (witnessedProbeReceipts.has(address)) {
      const verifiedEntry = witnessedProbeReceipts.get(address);
      const receiptsForClaimedIndex = verifiedEntry.receipts.get(chainIndex) || new Map();
      if (receiptsForClaimedIndex.size < MIN_PROBE_VERIFIERS) {
        return {
          ok: false,
          code: 'INSUFFICIENT_PROBE_ATTESTATIONS',
          message: `chainIndex ${chainIndex} has only ${receiptsForClaimedIndex.size} verifier attestations, requires ${MIN_PROBE_VERIFIERS}`,
        };
      }
      const hasBootstrapVerifier = [...receiptsForClaimedIndex.keys()].some((vAddr) =>
        bootstrapPeerAddresses.has(vAddr),
      );
      if (!hasBootstrapVerifier) {
        return {
          ok: false,
          code: 'MISSING_BOOTSTRAP_VERIFIER',
          message: `chainIndex ${chainIndex} has ${receiptsForClaimedIndex.size} verifiers but none is a known bootstrap/seed peer`,
        };
      }
      const verifiedMax = Math.max(0, verifiedEntry.maxChainIndex || 0);
      if (chainIndex > verifiedMax + 1) {
        return {
          ok: false,
          code: 'PROBE_CHAIN_EXCEEDS_VERIFIED',
          message: `claimed chainIndex (${chainIndex}) exceeds verified max (${verifiedMax}) by more than 1`,
        };
      }
      const powerValues = [];
      for (const receipt of receiptsForClaimedIndex.values()) {
        if (receipt.hwPowerW <= 0) continue;
        let cap = receipt.hwPowerW;
        if (receipt.type === 'gpu' && Array.isArray(receipt.gpuModels) && receipt.gpuModels.length > 0) {
          const model = receipt.gpuModels[0];
          if (model) {
            try {
              const tableTdp = getGpuTdpW(model);
              if (tableTdp > 0 && tableTdp < cap) cap = tableTdp;
            } catch (_) {
              /* ignore lookup failure */
            }
          }
        } else if ((receipt.type === 'cpu' || receipt.type === 'memory') && receipt.cpuModel) {
          try {
            const expectedOps = getExpectedCpuSpeedOps(receipt.cpuModel);
            if (expectedOps > 0) {
              const cpuCap = Math.round(expectedOps / 10);
              if (cpuCap > 0 && cpuCap < cap) cap = cpuCap;
            }
          } catch (_) {
            /* ignore lookup failure */
          }
        }
        if (receipt.wallClockMs > 10) {
          try {
            if (receipt.type === 'gpu') {
              const product = receipt.hwPowerW * receipt.wallClockMs;
              const MAX_GPU_PROBE_PRODUCT = 120_000;
              if (product > MAX_GPU_PROBE_PRODUCT) {
                const powerFromTiming = Math.round(MAX_GPU_PROBE_PRODUCT / receipt.wallClockMs);
                if (powerFromTiming > 0 && powerFromTiming < cap) cap = powerFromTiming;
              }
            } else if (receipt.type === 'cpu') {
              const measuredCpuOpsPerSec = (PROBE_CPU_ITERS / receipt.wallClockMs) * 1000;
              const timingCap = Math.round(measuredCpuOpsPerSec / 10);
              if (timingCap > 0 && timingCap < cap) cap = timingCap;
            }
          } catch (_) {
            /* ignore timing cap failure */
          }
        }
        powerValues.push(cap);
      }
      if (powerValues.length > 0) {
        attestedPowerW = Math.min(...powerValues);
      }
      if (attestedPowerW <= 0) {
        return {
          ok: false,
          code: 'CONTRIBUTION_NO_VERIFIED_POWER',
          message: `No verifier-attested hardware power for ${address} chainIndex ${chainIndex}.`,
        };
      }
      const MAX_WH_PER_PROBE = (attestedPowerW * PROBE_INTERVAL_MS) / 3600000;
      const maxWhForChainIndex = chainIndex * MAX_WH_PER_PROBE;
      if (totalWh > maxWhForChainIndex) {
        return {
          ok: false,
          code: 'CONTRIBUTION_EXCEEDS_PROBE_LIMIT',
          message: `totalWh (${totalWh}) exceeds max (${maxWhForChainIndex.toFixed(2)}) for chainIndex ${chainIndex} (attested ${attestedPowerW}W)`,
        };
      }
    } else if (chainIndex > 0) {
      return {
        ok: false,
        code: 'INSUFFICIENT_PROBE_ATTESTATIONS',
        message: `No probe attestations witnessed for ${address}; cannot verify chainIndex ${chainIndex}.`,
      };
    } else if (totalWh > 0) {
      return {
        ok: false,
        code: 'CONTRIBUTION_EXCEEDS_PROBE_LIMIT',
        message: `No probe attestations for ${address}; chainIndex is 0 but totalWh is ${totalWh}.`,
      };
    }
    return { ok: true, attestedPowerW };
  }

  async function pullContributionsFromPeers() {
    const wtcNode = getWtcNode();
    const settings = getLedgerNetworkSettings();
    if (!settings || !settings.enabled || !wtcNode) return;
    const peers = getActivePeers(settings);
    if (!peers || peers.length === 0) {
      if (process.env.WATTCOIN_DEBUG) console.log('[pullContributions] No active peers to pull from.');
      return;
    }
    const currentRoundId = getCurrentNetworkRoundId();
    if (currentRoundId <= 0) return;

    if (process.env.WATTCOIN_DEBUG)
      console.log(`[pullContributions] Pulling from ${peers.length} peers for round ${currentRoundId}...`);

    const snapshots = [];
    for (const peerUrl of peers) {
      try {
        const res = await requestPeerJson(peerUrl, 'GET', '/api/v1/round/contribution', undefined, undefined, {
          timeoutMs: 5000,
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'pull-contributions',
        });
        if (res && res.ok && res.snapshot && Number(res.snapshot.id) === currentRoundId) {
          snapshots.push(res.snapshot);
        }
      } catch (_) {
        // Peer unreachable or returned error - skip
      }
    }
    if (snapshots.length === 0) {
      if (process.env.WATTCOIN_DEBUG) console.log('[pullContributions] No valid snapshots from peers.');
      return;
    }

    if (process.env.WATTCOIN_DEBUG) {
      const allAddrs = new Set();
      for (const snap of snapshots) {
        for (const addr of Object.keys(snap.contributionsWh || {})) {
          if (addr) allAddrs.add(addr);
        }
      }
      console.log(
        `[pullContributions] Found ${allAddrs.size} unique addresses across ${snapshots.length} peer snapshots:`,
        Array.from(allAddrs),
      );
    }

    alignRoundLedgerToChain(currentRoundId);

    const allAddresses = new Set();
    for (const snap of snapshots) {
      for (const addr of Object.keys(snap.contributionsWh || {})) {
        if (addr) allAddresses.add(addr);
      }
    }

    for (const address of allAddresses) {
      let bestVerifiedWh = 0;
      let bestVerifiedTime = 0;
      let bestMessage = '';
      let bestSignature = '';

      for (const snap of snapshots) {
        const totalWh = Number((snap.contributionsWh || {})[address] || 0);
        if (totalWh <= 0) continue;
        const updatedAtMs = Number((snap.contributionUpdatedAtMs || {})[address] || 0);
        const message = (snap.contributionMessage || {})[address];
        const signature = (snap.contributionSignature || {})[address];
        if (message && signature) {
          try {
            if (wtcNode.verifyMessage(address, signature, message)) {
              const chainIdx = Math.max(-1, Math.floor(Number((snap.probeChainIndex || {})[address]) || -1));
              const probeCheck = validateContributionProbe(address, totalWh, chainIdx);
              if (!probeCheck.ok && process.env.WATTCOIN_DEBUG) {
                console.log(
                  `[pullContributions] Probe validation warning for ${address}: ${probeCheck.code} - ${probeCheck.message}`,
                );
              }
              if (updatedAtMs > bestVerifiedTime) {
                bestVerifiedWh = totalWh;
                bestVerifiedTime = updatedAtMs;
                bestMessage = String(message);
                bestSignature = String(signature);
              }
            }
          } catch (_) {
            // Verification error ? skip
          }
        }
      }

      if (bestVerifiedTime > 0) {
        roundLedger.setRoundContribution(address, bestVerifiedWh, bestVerifiedTime, bestMessage, bestSignature);
        if (wtcNode && wtcNode._consensus) wtcNode._consensus._hadContributionsBefore = true;
        continue;
      }

      const tally = {};
      let latestUpdatedMs = 0;
      for (const snap of snapshots) {
        const totalWh = Number((snap.contributionsWh || {})[address] || 0);
        if (totalWh > 0) {
          tally[totalWh] = (tally[totalWh] || 0) + 1;
          const snapTime = Number((snap.contributionUpdatedAtMs || {})[address] || 0);
          if (snapTime > latestUpdatedMs) latestUpdatedMs = snapTime;
        }
      }
      const values = Object.keys(tally);
      if (values.length > 0) {
        let bestCount = 0;
        let bestValue = 0;
        for (const [value, count] of Object.entries(tally)) {
          if (Number(count) > bestCount) {
            bestCount = Number(count);
            bestValue = Number(value);
          }
        }
        const bestTime = latestUpdatedMs > 0 ? latestUpdatedMs : Date.now();
        roundLedger.setRoundContribution(address, bestValue, bestTime);
        if (wtcNode && wtcNode._consensus) wtcNode._consensus._hadContributionsBefore = true;
      }
    }
  }

  function buildRoundContributionMessage({ address, roundId, totalWh, updatedAtMs, chainIndex }) {
    return JSON.stringify({
      prefix: ROUND_CONTRIBUTION_MESSAGE_PREFIX,
      network: getActiveNetwork(),
      address: String(address || '').trim(),
      roundId: Math.max(1, Math.floor(Number(roundId) || 0)),
      totalWh: Number(Math.max(0, Number(totalWh) || 0).toFixed(8)),
      updatedAtMs: Math.max(0, Math.floor(Number(updatedAtMs) || 0)),
      chainIndex: Math.max(0, Math.floor(Number(chainIndex) || 0)),
    });
  }

  function buildRewardMapFromRoundSnapshot(roundSnapshot, fallbackAddress = '') {
    const roundId = Math.max(1, Math.floor(Number(roundSnapshot && roundSnapshot.id) || getCurrentNetworkRoundId()));
    const rewardTotal = rewardForHeight(roundId);
    if (rewardTotal <= 0) return {};

    const contributionEntries = Object.entries((roundSnapshot && roundSnapshot.contributionsWh) || {})
      .map(([address, amount]) => [String(address || '').trim(), Math.max(0, Number(amount) || 0)])
      .filter(([address, amount]) => address && amount > 0);
    const totalWh = contributionEntries.reduce((sum, [, amount]) => sum + amount, 0);

    if (totalWh <= 0) {
      return fallbackAddress ? { [fallbackAddress]: rewardTotal } : {};
    }

    const rewardMap = {};
    let allocated = 0;
    contributionEntries.forEach(([address, amount], index) => {
      const isLast = index === contributionEntries.length - 1;
      let share = isLast
        ? Number((rewardTotal - allocated).toFixed(8))
        : Number(((rewardTotal * amount) / totalWh).toFixed(8));
      if (share < 0) share = 0;
      allocated = Number((allocated + share).toFixed(8));
      rewardMap[address] = Number(((rewardMap[address] || 0) + share).toFixed(8));
    });
    return rewardMap;
  }

  function broadcastRoundContributionToPeers({ address, roundId, totalWh }) {
    const wtcNode = getWtcNode();
    const normalizedAddress = String(address || '').trim();
    if (!normalizedAddress || !wtcNode || typeof wtcNode.signMessage !== 'function') return;

    const settings = getLedgerNetworkSettings();
    if (!settings.enabled) return;
    const peers = getActivePeers(settings);

    const updatedAtMs = Date.now();
    const _localChainIdx = Math.max(
      0,
      Math.floor(Number((getLocalProbeChain && getLocalProbeChain().chainIndex) || 0)),
    );
    const chainIndex = hwAuthority.peerProbeChainIndex > 0 ? hwAuthority.peerProbeChainIndex : _localChainIdx;
    const message = buildRoundContributionMessage({
      address: normalizedAddress,
      roundId,
      totalWh,
      updatedAtMs,
      chainIndex,
    });

    let signature = '';
    try {
      signature = String((wtcNode.signMessage(normalizedAddress, message) || {}).signature || '').trim();
    } catch (_) {
      return;
    }
    if (!signature) return;

    const payload = {
      address: normalizedAddress,
      roundId,
      totalWh: Number(Math.max(0, Number(totalWh) || 0).toFixed(8)),
      updatedAtMs,
      chainIndex,
      message,
      signature,
    };
    for (const peerUrl of peers) {
      queueRoundContributionBroadcast(peerUrl, payload);
    }
  }

  function _flushPendingContribution(chainIndex) {
    const wtcNode = getWtcNode();
    const wh = _pendingContributionWh.current;
    if (wh <= 0.0001) {
      _pendingContributionWh.current = 0;
      return;
    }
    console.warn(`[Flush] wh=${wh.toFixed(6)} chainIdx=${chainIndex}`);
    _pendingContributionWh.current = 0;
    try {
      const addr = walletAddressCache.address;
      if (!addr) return;
      alignRoundLedgerToChain();
      const added = roundLedger.addContribution(addr, wh);
      if (added && added.ok && added.acceptedWh > 0) {
        if (wtcNode && wtcNode._consensus) wtcNode._consensus._hadContributionsBefore = true;
        const snap = roundLedger.getCurrentRoundSnapshot();
        broadcastRoundContributionToPeers({
          address: addr,
          roundId: snap.id,
          totalWh: added.addressRoundWh,
        });
      } else if (wh > 0) {
        _pendingContributionWh.current = wh;
      }
    } catch (_) {
      _pendingContributionWh.current = wh;
    }
  }

  function broadcastProbeReceiptToPeers(receipt) {
    if (!receipt || !receipt.workerId) return;
    const settings = getLedgerNetworkSettings();
    if (!settings || !settings.enabled) return;
    const peers = getActivePeers(settings);
    if (!peers || peers.length === 0) return;
    const payload = { receipt };
    for (const peerUrl of peers) {
      requestPeerJson(peerUrl, 'POST', '/api/v1/probe/receipt', payload, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'probe-receipt',
        timeoutMs: 5000,
      }).catch(() => {});
    }
  }

  function queueRoundContributionBroadcast(peerUrl, payload) {
    const normalizedPeerUrl = normalizePeerUrl(peerUrl);
    if (!normalizedPeerUrl || !payload || typeof payload !== 'object') return;

    const roundId = Math.max(1, Math.floor(Number(payload.roundId) || 0));
    const normalizedAddress = String(payload.address || '').trim();
    if (!normalizedAddress || !roundId) return;

    const key = `${normalizedPeerUrl}|${normalizedAddress}`;
    const existing = pendingRoundContributionBroadcasts.get(key);
    if (existing) {
      existing.payload = payload;
      return;
    }

    const entry = {
      peerUrl: normalizedPeerUrl,
      payload,
      timer: setTimeout(() => {
        const latest = pendingRoundContributionBroadcasts.get(key);
        pendingRoundContributionBroadcasts.delete(key);
        if (!latest || !latest.payload) return;
        requestPeerJson(latest.peerUrl, 'POST', '/api/v1/round/contribution', latest.payload, undefined, {
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'round-contribution',
        }).catch(() => {});
      }, ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS),
    };
    pendingRoundContributionBroadcasts.set(key, entry);
  }

  async function getLocalLedgerBalances(selectedAddress) {
    alignRoundLedgerToChain();
    const address = typeof selectedAddress === 'string' ? selectedAddress.trim() : '';
    const blockHeight = await getCurrentBlockHeight();
    roundLedger.syncMaturity(blockHeight);
    const snapshot = roundLedger.getAddressSnapshot(address);
    const currentRoundWh = roundLedger.getRoundContribution(address);
    const maturityDepth = typeof roundLedger.getMaturityDepth === 'function' ? roundLedger.getMaturityDepth() : 100;
    return {
      ok: true,
      address: snapshot.address,
      balanceSource: 'backend-round-ledger',
      accountingModel: 'proportional-energy-rounds',
      balanceSemanticsVersion: 2,
      isAddressSpecific: true,
      totalMinedCoins: snapshot.total,
      maturedMinedCoins: snapshot.matured,
      unmaturedMinedCoins: snapshot.pending,
      currentRoundContributionWh: currentRoundWh,
      blockHeight,
      maturityDepth,
    };
  }

  async function settleLocalLedgerRound(payload = {}) {
    const proofCommitment = payload && payload.proofCommitment ? String(payload.proofCommitment).trim() : '';
    if (ENABLE_POWER_PROOF_COMMITMENT && !proofCommitment) {
      console.warn('[Ledger] Settlement rejected: missing power-proof commitment.');
      return {
        ok: false,
        code: 'PROOF_MISSING',
        message: 'Settlement rejected: no power-proof commitment was present for this block.',
      };
    }

    if (ENABLE_POWER_PROOF_COMMITMENT && proofCommitment) {
      const expected = hwAuthority.pendingProofCommitment;
      if (!expected || proofCommitment !== expected) {
        console.warn('[Ledger] Settlement rejected: proof commitment mismatch.');
        hwAuthority.pendingProofCommitment = '';
        return {
          ok: false,
          code: 'PROOF_COMMITMENT_MISMATCH',
          message: 'Settlement rejected: proof commitment does not match mined block.',
        };
      }
    }
    hwAuthority.pendingProofCommitment = '';

    const minedAddress = payload && payload.minedAddress ? String(payload.minedAddress) : '';

    const blockHeight = await getCurrentBlockHeight();
    const round = roundLedger.settleCurrentRound({
      blockHash: payload && payload.blockHash ? String(payload.blockHash) : '',
      minedAddress,
      blockHeight,
      rewardCoins: Number(payload && payload.rewardCoins) || 0,
      contributionsWh:
        payload && payload.contributionsWh && typeof payload.contributionsWh === 'object'
          ? payload.contributionsWh
          : null,
    });
    const maturedRounds = roundLedger.syncMaturity(blockHeight);
    if (round && !round.idempotent) broadcastSettlementToPeers(round).catch(() => {});
    return { ok: true, round, maturedRounds, blockHeight };
  }

  function recordWitnessedSettlement(summary, fromPeer) {
    if (!summary || !summary.blockHash) return;
    const blockHash = String(summary.blockHash).trim();
    if (!blockHash) return;
    const entry = {
      blockHash,
      minedAddress: String(summary.minedAddress || ''),
      totalWh: Number(summary.totalWh) || 0,
      rewardCoins: Number(summary.rewardCoins) || 0,
      settledAtMs: Number(summary.settledAtMs) || Date.now(),
      sig: String(summary.sig || ''),
      fromPeer: String(fromPeer || 'self'),
    };
    const existing = witnessedSettlements.get(blockHash);
    if (existing && fromPeer !== 'self') {
      if (
        Math.abs(existing.totalWh - entry.totalWh) > 0.0001 ||
        Math.abs(existing.rewardCoins - entry.rewardCoins) > 1e-8
      ) {
        recordForkMismatch({ blockHash, fromPeer, localTotalWh: existing.totalWh, peerTotalWh: entry.totalWh });
        console.warn(
          `[SettlementGossip] MISMATCH for block ${blockHash}: ` +
            `local totalWh=${existing.totalWh} vs peer=${entry.totalWh}, ` +
            `local coins=${existing.rewardCoins} vs peer=${entry.rewardCoins} (from ${fromPeer})`,
        );
      }
    } else {
      witnessedSettlements.set(blockHash, entry);
      if (witnessedSettlements.size > 500) {
        witnessedSettlements.delete(witnessedSettlements.keys().next().value);
      }
    }
  }

  function broadcastSettlementToPeers(round) {
    const settings = getLedgerNetworkSettings();
    if (!settings.enabled) return;
    const peers = getActivePeers(settings);
    if (!peers || peers.length === 0) return;
    const summary = {
      blockHash: round.blockHash,
      minedAddress: round.minedAddress,
      totalWh: round.totalWh,
      rewardCoins: round.rewardCoins,
      settledAtMs: Date.now(),
    };
    summary.sig = computeHwAuthSig(summary);
    recordWitnessedSettlement(summary, 'self');
    for (const peerUrl of peers) {
      requestPeerJson(peerUrl, 'POST', '/api/v1/settlement/seen', summary, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'settlement-gossip',
      }).catch(() => {});
    }
  }

  return {
    pullContributionsFromPeers,
    buildRoundContributionMessage,
    buildRewardMapFromRoundSnapshot,
    broadcastRoundContributionToPeers,
    _flushPendingContribution,
    broadcastProbeReceiptToPeers,
    queueRoundContributionBroadcast,
    getLocalLedgerBalances,
    settleLocalLedgerRound,
    recordWitnessedSettlement,
    broadcastSettlementToPeers,
    validateContributionProbe,
  };
}

module.exports = { createRoundContributions };
