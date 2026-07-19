'use strict';

const { getGpuTdpW, getExpectedCpuSpeedOps, getMinOpsPerMs, getGpuMinOpsPerMs } = require('./hardware-tables.cjs');
const { PROBE_INTERVAL_MS } = require('./backend-benchmark');
const { estimateVdfTimingMs } = require('./vdf');
const { verifySeedProof, checkProofPlausibility, computeEnergyWh, isValidHex32 } = require('./token-verification');

const ROUND_CONTRIBUTION_MESSAGE_PREFIX = 'wtc-round-contribution-v1';

// Resolve measured power (W) at a claimed load from a power curve.
// Returns 0 if no curve is available — callers must not fall back to TDP.
function _powerAtLoad(powerCurve, interpolatePowerFn, claimedLoad) {
  if (!powerCurve || !Array.isArray(powerCurve.steps) || powerCurve.steps.length < 2 || !powerCurve.measuredWithSensors)
    return 0;
  const loadPct = Math.max(0, Math.min(100, (Number(claimedLoad) || 0) * 100));
  return typeof interpolatePowerFn === 'function' ? interpolatePowerFn(powerCurve, loadPct) : 0;
}

// ── Seed proof verification (standalone, usable by both round-contributions and ledger-routes) ──
async function verifyContributorSeedProofs(
  message,
  address,
  claimedTotalWh,
  elapsedMs,
  witnessedProbeReceipts,
  claimedLoad,
  powerCurve,
  interpolatePowerFn,
) {
  let parsed;
  try {
    parsed = typeof message === 'string' ? JSON.parse(message) : message;
  } catch (_) {
    return { ok: false, reason: 'invalid_message_format', verifiedWh: 0 };
  }
  if (!parsed || !Array.isArray(parsed.seedProofs) || parsed.seedProofs.length === 0) {
    if (claimedTotalWh > 0.0001) {
      return { ok: false, reason: 'no_seed_proofs', verifiedWh: 0 };
    }
    return { ok: true, reason: 'no_proofs_no_energy', verifiedWh: 0 };
  }
  // Hardware model: prefer local probe receipts, fall back to the model
  // embedded in the signed message (so pulling peers can verify without
  // having directly probed the contributor).
  const cpuModel = _getHardwareModel(witnessedProbeReceipts, address, 'cpu') || parsed.cpuModel || null;
  const gpuModel =
    _getHardwareModel(witnessedProbeReceipts, address, 'gpu') ||
    (Array.isArray(parsed.gpuModels) && parsed.gpuModels.length > 0 ? parsed.gpuModels[0] : null);
  const effectiveElapsed = Math.max(1, parsed.elapsedMs > 0 ? Number(parsed.elapsedMs) : Number(elapsedMs) || 60000);
  let powerW =
    typeof parsed.sampledPowerW === 'number' && parsed.sampledPowerW > 0
      ? parsed.sampledPowerW
      : _powerAtLoad(powerCurve, interpolatePowerFn, claimedLoad);
  // Cap power at the hardware's measured maximum to prevent inflated energy claims.
  const maxPowerW = powerCurve && powerCurve.maxPowerW > 0 ? powerCurve.maxPowerW : 0;
  if (maxPowerW > 0 && powerW > maxPowerW) {
    powerW = maxPowerW;
  }
  let verifiedCount = 0;
  for (const proof of parsed.seedProofs) {
    const seedHex = String(proof.seed || '');
    if (!isValidHex32(seedHex)) continue;
    const result = await verifySeedProof(proof, seedHex);
    if (!result.ok) continue;
    const isGpu = proof.type === 'gpu';
    const hwOpsPerMs = isGpu ? (gpuModel ? getGpuMinOpsPerMs(gpuModel) : 500) : getMinOpsPerMs(cpuModel);
    const plausibility = checkProofPlausibility(
      result.totalOps,
      effectiveElapsed,
      { opsPerMs: hwOpsPerMs },
      claimedLoad,
    );
    if (!plausibility.ok) continue;
    verifiedCount++;
  }
  const totalVerifiedWh = verifiedCount > 0 ? computeEnergyWh('cpu', effectiveElapsed, powerW) : 0;
  if (verifiedCount === 0 && claimedTotalWh > 0.0001) {
    return { ok: false, reason: 'no_valid_proofs', verifiedWh: 0 };
  }
  if (claimedTotalWh > 0.0001 && totalVerifiedWh > 0) {
    const tolerance = Math.max(0.001, claimedTotalWh * 0.1);
    if (Math.abs(claimedTotalWh - totalVerifiedWh) > tolerance) {
      if (process.env.WATTCOIN_DEBUG) {
        console.warn(
          `[SeedProof] Energy mismatch for ${address}: claimed=${claimedTotalWh.toFixed(6)} ` +
            `verified=${totalVerifiedWh.toFixed(6)} (tolerance=${tolerance.toFixed(6)})`,
        );
      }
    }
  }
  return {
    ok: true,
    verifiedWh: Math.min(claimedTotalWh, totalVerifiedWh),
    verifiedCount,
    totalProofs: parsed.seedProofs.length,
  };
}

function _getHardwareModel(witnessedProbeReceipts, address, type) {
  if (!witnessedProbeReceipts || !witnessedProbeReceipts.has(address)) return null;
  const entry = witnessedProbeReceipts.get(address);
  if (!entry || !entry.receipts) return null;
  for (const [, verifierMap] of entry.receipts) {
    for (const [, receipt] of verifierMap) {
      if (type === 'cpu' && receipt && receipt.cpuModel) return receipt.cpuModel;
      if (
        type === 'gpu' &&
        receipt &&
        receipt.gpuModels &&
        Array.isArray(receipt.gpuModels) &&
        receipt.gpuModels.length > 0
      ) {
        return receipt.gpuModels[0];
      }
    }
  }
  return null;
}

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
    ROUND_CONTRIBUTION_BROADCAST_DEBOUNCE_MS,
    loadPowerCurve,
    interpolatePower,
  } = deps;

  // Track address+roundId combinations that failed pull verification so they
  // are only logged once per cycle instead of repeating every 60 seconds.
  const _pullFailedCache = new Set();
  let _pullFailedCacheRoundId = 0;

  // Look up a contributor's CPU model from witnessed probe receipts.
  // Returns the model string or null if not found.
  function _getContributorCpuModel(address) {
    if (!witnessedProbeReceipts || !witnessedProbeReceipts.has(address)) return null;
    const entry = witnessedProbeReceipts.get(address);
    if (!entry || !entry.receipts) return null;
    for (const [, verifierMap] of entry.receipts) {
      for (const [, receipt] of verifierMap) {
        if (receipt && receipt.cpuModel) return receipt.cpuModel;
      }
    }
    return null;
  }

  // Look up a contributor's GPU model from witnessed probe receipts.
  // Returns the model string or null if not found.
  function _getContributorGpuModel(address) {
    if (!witnessedProbeReceipts || !witnessedProbeReceipts.has(address)) return null;
    const entry = witnessedProbeReceipts.get(address);
    if (!entry || !entry.receipts) return null;
    for (const [, verifierMap] of entry.receipts) {
      for (const [, receipt] of verifierMap) {
        if (receipt && receipt.gpuModels && Array.isArray(receipt.gpuModels) && receipt.gpuModels.length > 0) {
          return receipt.gpuModels[0];
        }
      }
    }
    return null;
  }

  function validateContributionProbe(address, totalWh, chainIndex) {
    let attestedPowerW = 0;
    if (witnessedProbeReceipts.has(address)) {
      const verifiedEntry = witnessedProbeReceipts.get(address);
      const receiptsForClaimedIndex = verifiedEntry.receipts.get(chainIndex) || new Map();
      const hasBootstrapVerifier = [...receiptsForClaimedIndex.keys()].some((vAddr) =>
        bootstrapPeerAddresses.has(vAddr),
      );
      if (receiptsForClaimedIndex.size < MIN_PROBE_VERIFIERS) {
        if (!(hasBootstrapVerifier && receiptsForClaimedIndex.size >= 1)) {
          return {
            ok: false,
            code: 'INSUFFICIENT_PROBE_ATTESTATIONS',
            message: `chainIndex ${chainIndex} has only ${receiptsForClaimedIndex.size} verifier attestations, requires ${MIN_PROBE_VERIFIERS}`,
          };
        }
      }
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
        if (receipt.type === 'gpu-pow' && Array.isArray(receipt.gpuModels) && receipt.gpuModels.length > 0) {
          const model = receipt.gpuModels[0];
          if (model) {
            try {
              const tableTdp = getGpuTdpW(model);
              if (tableTdp > 0 && tableTdp < cap) cap = tableTdp;
            } catch (_) {
              /* ignore lookup failure */
            }
          }
        } else if (receipt.type === 'cpu' && receipt.cpuModel) {
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
            // Use VDF-derived timing when the receipt has a valid VDF proof.
            // This replaces the coordinator's wall clock as the authoritative timing source.
            let effectiveTimingMs = receipt.wallClockMs;
            if (receipt.vdfSteps > 0 && receipt.vdfDiscriminantSize > 0) {
              const vdfMs = estimateVdfTimingMs(receipt.vdfSteps, receipt.vdfDiscriminantSize);
              if (vdfMs > 0) effectiveTimingMs = vdfMs;
            }
            if (receipt.type === 'cpu') {
              const cpuIters = receipt.iterations || 0;
              if (cpuIters > 0) {
                const measuredCpuOpsPerSec = (cpuIters / effectiveTimingMs) * 1000;
                const timingCap = Math.round(measuredCpuOpsPerSec / 10);
                if (timingCap > 0 && timingCap < cap) cap = timingCap;
              }
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
      console.log('[Pull] No active peers to pull from.');
      return;
    }
    const currentRoundId = getCurrentNetworkRoundId();
    if (currentRoundId <= 0) return;

    // Clear failed cache on round change.
    if (_pullFailedCacheRoundId !== currentRoundId) {
      _pullFailedCache.clear();
      _pullFailedCacheRoundId = currentRoundId;
    }

    console.log(`[Pull] Pulling from ${peers.length} peers for round ${currentRoundId}...`);

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
          const snap = res.snapshot;
          const addrCount = Object.keys(snap.contributionsWh || {}).length;
          console.log(
            `[Pull] Got snapshot from ${peerUrl}: ${addrCount} contributors, totalWh=${(snap.totalWh || 0).toFixed(6)}`,
          );
          snapshots.push(snap);
        } else {
          console.log(
            `[Pull] No valid snapshot from ${peerUrl} (ok=${!!res}, roundMatch=${!!(res && res.snapshot && Number(res.snapshot.id) === currentRoundId)})`,
          );
        }
      } catch (e) {
        console.log(`[Pull] Peer unreachable: ${peerUrl} (${e.message})`);
      }
    }
    if (snapshots.length === 0) {
      console.log('[Pull] No valid snapshots from any peer.');
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
        `[Pull] Found ${allAddrs.size} unique addresses across ${snapshots.length} peer snapshots:`,
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
      // Skip contributions that already failed verification in a previous
      // cycle — they will not suddenly start passing.
      if (_pullFailedCache.has(address)) continue;

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

        // No message or no signature → old-format contribution that was stored
        // before the proof system existed.  Its energy is already counted on the
        // sending peer; silently ignore it here.
        if (!message || !signature) continue;

        let parsed;
        try {
          parsed = JSON.parse(message);
        } catch (_) {
          parsed = null;
        }

        // Old-format message that does not contain seed proofs.  The energy was
        // earned before the proof requirement — accept it silently.
        if (!parsed || !Array.isArray(parsed.seedProofs) || parsed.seedProofs.length === 0) continue;

        // ── From this point on the contribution must be signed ──
        try {
          if (wtcNode.verifyMessage(address, signature, message)) {
            // Verify seed proofs as defence-in-depth.  If verification fails
            // (e.g. hardware model missing from older messages), fall back to
            // trusting the valid signature — the contributor authorized this
            // energy claim cryptographically.
            let acceptedWh = totalWh;
            try {
              const elapsedMs = updatedAtMs > 0 ? Date.now() - updatedAtMs : 60000;
              const proofResult = await verifyContributorSeedProofs(
                message,
                address,
                totalWh,
                elapsedMs,
                witnessedProbeReceipts,
                undefined,
                typeof loadPowerCurve === 'function' ? loadPowerCurve() : null,
                interpolatePower,
              );
              if (proofResult.ok && proofResult.verifiedWh > 0) {
                acceptedWh = Math.min(totalWh, proofResult.verifiedWh);
              }
            } catch (_) {
              /* proof verification failed — accept on signature */
            }
            if (updatedAtMs > bestVerifiedTime) {
              bestVerifiedWh = acceptedWh;
              bestVerifiedTime = updatedAtMs;
              bestMessage = String(message);
              bestSignature = String(signature);
            }
          }
        } catch (_) {
          _pullFailedCache.add(address);
        }
      }

      if (bestVerifiedTime > 0) {
        // Skip if local ledger already has equal or higher energy for this address.
        const existingWh = roundLedger.getRoundContribution(address);
        const existingUpdatedAt = roundLedger.getRoundContributionUpdatedAt(address);
        if (existingWh >= bestVerifiedWh && existingUpdatedAt >= bestVerifiedTime) {
          _pullFailedCache.add(address);
          continue;
        }
        roundLedger.setRoundContribution(address, bestVerifiedWh, bestVerifiedTime, bestMessage, bestSignature);
        console.log(`[Pull] ACCEPTED ${address} ${bestVerifiedWh.toFixed(6)} Wh`);
        if (wtcNode && wtcNode._consensus) wtcNode._consensus._hadContributionsBefore = true;
        continue;
      }

      // No signed+verified contribution found for this address.
      _pullFailedCache.add(address);
    }
  }

  function buildRoundContributionMessage({
    address,
    roundId,
    totalWh,
    updatedAtMs,
    chainIndex,
    seedProofs,
    cpuModel,
    gpuModels,
    sampledPowerW,
    elapsedMs,
  }) {
    const msg = {
      prefix: ROUND_CONTRIBUTION_MESSAGE_PREFIX,
      network: getActiveNetwork(),
      address: String(address || '').trim(),
      roundId: Math.max(1, Math.floor(Number(roundId) || 0)),
      totalWh: Number(Math.max(0, Number(totalWh) || 0).toFixed(8)),
      updatedAtMs: Math.max(0, Math.floor(Number(updatedAtMs) || 0)),
      chainIndex: Math.max(0, Math.floor(Number(chainIndex) || 0)),
    };
    if (cpuModel) msg.cpuModel = String(cpuModel);
    if (Array.isArray(gpuModels) && gpuModels.length > 0) msg.gpuModels = gpuModels.map(String);
    if (typeof sampledPowerW === 'number' && sampledPowerW > 0) msg.sampledPowerW = Number(sampledPowerW.toFixed(4));
    if (typeof elapsedMs === 'number' && elapsedMs > 0) msg.elapsedMs = Math.round(elapsedMs);
    if (Array.isArray(seedProofs) && seedProofs.length > 0) {
      msg.seedProofs = seedProofs.map((p) => ({
        type: String(p.type || 'cpu'),
        seed: String(p.seed || ''),
        startState: String(p.startState || ''),
        endState: String(p.endState || ''),
        totalOps: Math.max(0, Math.floor(Number(p.totalOps) || 0)),
        burnMs: Math.max(0, Number(p.burnMs) || 0),
        intermediateProof: String(p.intermediateProof || ''),
      }));
    }
    return JSON.stringify(msg);
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

  function broadcastRoundContributionToPeers({ address, roundId, totalWh, seedProofs, hwModels }) {
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
      seedProofs,
      cpuModel: hwModels && hwModels.cpuModel,
      gpuModels: hwModels && hwModels.gpuModels,
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

  function _flushPendingContribution(chainIndex, seedProofs, hwModels, sampledPowerW, elapsedMs) {
    const wtcNode = getWtcNode();
    const wh = _pendingContributionWh.current;
    const hasProofs = Array.isArray(seedProofs) && seedProofs.length > 0;
    console.log(
      `[Flush] Entry: pendingWh=${wh.toFixed(6)} chainIndex=${chainIndex} proofs=${seedProofs ? seedProofs.length : 0}`,
    );
    if (wh <= 0.0001) {
      console.log(`[Flush] Skipped: energy too low (${wh.toFixed(8)} Wh)`);
      _pendingContributionWh.current = 0;
      return;
    }
    if (!hasProofs) {
      console.warn(`[Flush] Skipped: no seed proofs — energy (${wh.toFixed(6)} Wh) not added to ledger`);
      _pendingContributionWh.current = 0;
      return;
    }
    _pendingContributionWh.current = 0;
    try {
      const addr = walletAddressCache.address;
      if (!addr) {
        console.warn(`[Flush] skipped: no wallet address (wh=${wh.toFixed(6)})`);
        return;
      }
      alignRoundLedgerToChain();
      const added = roundLedger.addContribution(addr, wh);
      if (added && added.ok && added.acceptedWh > 0) {
        if (wtcNode && wtcNode._consensus) wtcNode._consensus._hadContributionsBefore = true;
        const snap = roundLedger.getCurrentRoundSnapshot();
        // Store the signed message in the ledger so pull-based peers can
        // verify the contribution when they fetch the snapshot via GET.
        const totalWh = added.addressRoundWh;
        const updatedAtMs = Date.now();
        const _localChainIdx = Math.max(
          0,
          Math.floor(Number((getLocalProbeChain && getLocalProbeChain().chainIndex) || 0)),
        );
        const effectiveChainIndex =
          hwAuthority.peerProbeChainIndex > 0 ? hwAuthority.peerProbeChainIndex : _localChainIdx;
        try {
          const message = buildRoundContributionMessage({
            address: addr,
            roundId: snap.id,
            totalWh,
            updatedAtMs,
            chainIndex: effectiveChainIndex,
            seedProofs,
            cpuModel: hwModels && hwModels.cpuModel,
            gpuModels: hwModels && hwModels.gpuModels,
            sampledPowerW,
            elapsedMs,
          });
          if (wtcNode && typeof wtcNode.signMessage === 'function') {
            const signed = wtcNode.signMessage(addr, message);
            const sig = String((signed && signed.signature) || '').trim();
            if (sig) {
              roundLedger.setRoundContribution(addr, totalWh, updatedAtMs, message, sig);
            }
          }
        } catch (msgErr) {
          console.warn(`[Flush] failed to store signed message: ${(msgErr && msgErr.message) || msgErr}`);
        }
        const hasProofs = Array.isArray(seedProofs) && seedProofs.length > 0;
        console.log(
          `[Flush] ${wh.toFixed(6)} Wh accepted (total=${totalWh.toFixed(6)} proofs=${hasProofs ? seedProofs.length : 0} round=${snap.id})`,
        );
        if (hasProofs) {
          broadcastRoundContributionToPeers({
            address: addr,
            roundId: snap.id,
            totalWh,
            seedProofs,
            hwModels,
          });
        } else {
          console.warn(`[Flush] skipped broadcast: no seed proofs to send`);
        }
      } else if (wh > 0) {
        console.warn(`[Flush] ${wh.toFixed(6)} Wh rejected by ledger`);
        _pendingContributionWh.current = wh;
      }
    } catch (e) {
      console.warn(`[Flush] failed: ${(e && e.message) || e}`);
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
    const RECEIPT_MAX_RETRIES = 2;
    const RECEIPT_RETRY_DELAY_MS = 3000;
    for (const peerUrl of peers) {
      const normalizedUrl = normalizePeerUrl(peerUrl);
      if (!normalizedUrl) continue;
      const attemptSend = (retryCount) => {
        requestPeerJson(normalizedUrl, 'POST', '/api/v1/probe/receipt', payload, undefined, {
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'probe-receipt',
          timeoutMs: 5000,
        }).catch((e) => {
          if (retryCount < RECEIPT_MAX_RETRIES) {
            console.warn(
              `[ReceiptBroadcast] retry ${normalizedUrl} (${retryCount}/${RECEIPT_MAX_RETRIES}): ${(e && e.message) || e}`,
            );
            setTimeout(() => attemptSend(retryCount + 1), RECEIPT_RETRY_DELAY_MS * retryCount);
          }
        });
      };
      attemptSend(0);
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

    const MAX_RETRIES = 2;
    const RETRY_DELAY_MS = 5000;

    function attemptSend(retryCount, fallbackPayload) {
      const latest = pendingRoundContributionBroadcasts.get(key);
      const sendPayload = (latest && latest.payload) || fallbackPayload;
      if (!sendPayload) return;
      requestPeerJson(normalizedPeerUrl, 'POST', '/api/v1/round/contribution', sendPayload, undefined, {
        trackReachability: false,
        suppressPeerDiscovery: true,
        source: 'round-contribution',
      })
        .then(() => {
          console.log(`[Broadcast] contribution sent to ${normalizedPeerUrl}`);
        })
        .catch((e) => {
          if (retryCount < MAX_RETRIES) {
            console.warn(
              `[Broadcast] retry ${normalizedPeerUrl} (${retryCount}/${MAX_RETRIES}): ${(e && e.message) || e}`,
            );
            setTimeout(() => attemptSend(retryCount + 1, sendPayload), RETRY_DELAY_MS * retryCount);
          } else {
            console.warn(`[Broadcast] gave up ${normalizedPeerUrl} after ${MAX_RETRIES} retries`);
          }
        });
    }

    const entry = {
      peerUrl: normalizedPeerUrl,
      payload,
      timer: setTimeout(() => {
        const latest = pendingRoundContributionBroadcasts.get(key);
        if (!latest || !latest.payload) {
          pendingRoundContributionBroadcasts.delete(key);
          return;
        }
        pendingRoundContributionBroadcasts.delete(key);
        requestPeerJson(latest.peerUrl, 'POST', '/api/v1/round/contribution', latest.payload, undefined, {
          trackReachability: false,
          suppressPeerDiscovery: true,
          source: 'round-contribution',
        })
          .then(() => {
            console.log(`[Broadcast] contribution sent to ${normalizedPeerUrl}`);
          })
          .catch((e) => {
            console.warn(
              `[Broadcast] failed ${normalizedPeerUrl} (attempt 0/${MAX_RETRIES}): ${(e && e.message) || e}`,
            );
            attemptSend(1, latest.payload);
          });
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

module.exports = { createRoundContributions, verifyContributorSeedProofs };
