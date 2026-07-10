'use strict';

const {
  sendJson,
  readJsonBody,
  secureStringEquals,
  isPublicPeerHost,
  normalizePeerUrl,
  getActiveNetwork,
} = require('./main-utils');

function createLedgerRequestHandler(ctx) {
  const {
    getRequesterIdentity,
    isPeerIdentityBanned,
    handleReverseTunnelHttpRequest,
    refreshCoordinatorIdentityKey,
    enforceEndpointRateLimit,
    submitPeerProbeResult,
    getCurrentNetworkRoundId,
    getProbeReceiptSigningPayload,
    attachProbeReceiptSignature,
    recordPeerAttestation,
    broadcastProbeReceiptToPeers,
    normalizeProbeReceipt,
    _nodeHasGovernanceNfts,
    readTeamData,
    writeTeamData,
    readDocsData,
    writeDocsData,
    isLedgerNetworkAuthorized,
    recordPeerIdentityFailure,
    collectOpsSnapshot,
    rememberObservedRequester,
    maybeRegisterReachableRequester,
    buildAdvertisedPeerList,
    receivePeerGossip,
    getPrimaryAdvertisedPeerUrl,
    extractReachablePeerCandidates,
    rememberDiscoveredPeer,
    allocatePunchPort,
    buildPunchResponse,
    performPunch,
    buildOpsHealthResponse,
    computeHwAuthSig,
    recordWitnessedSettlement,
    verifyChainPeerCompatibility,
    handlePeerTipSignal,
    handleIncomingGossip,
    requestPeerJson,
    getActivePeers,
    getLedgerNetworkSettings,
    validateContributionProbe,
    alignRoundLedgerToChain,
    buildRoundContributionMessage,
    isValidWtcAddress,
    opsState,
    getWtcNode,
    roundLedger,
    walletAddressCache,
    witnessedProbeReceipts,
    forwardedContributionMessages,
    peerReachabilityCache,
    usedPunchPorts,
    stunNatInfoRef,
    CHAIN_STALL_ALERT_MS,
  } = ctx;

  return async (req, res) => {
    try {
      const wtcNode = getWtcNode();
      const settings = getLedgerNetworkSettings();
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const requesterIdentity = getRequesterIdentity(req);
      if (isPeerIdentityBanned(requesterIdentity)) {
        sendJson(res, 403, { ok: false, code: 'PEER_BANNED', message: 'Peer identity is temporarily banned.' });
        return;
      }

      if (reqUrl.pathname.startsWith('/api/v1/tunnel/')) {
        const handled = await handleReverseTunnelHttpRequest(req, res, settings);
        if (handled) return;
      }

      // POST /api/v1/probe/submit - unauthenticated: results are cryptographically verified;
      // a wrong proof is simply rejected.  Rate-limited by remote IP.
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/probe/submit') {
        refreshCoordinatorIdentityKey();
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('peer-probe-submit', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const body = await readJsonBody(req);
        console.warn(
          `[PeerProbe/Crd] submit body probeWallClockMs=${body && typeof body.probeWallClockMs === 'number' ? Math.round(body.probeWallClockMs) : '?'} (typeof=${typeof (body && body.probeWallClockMs)})`,
        );
        const probeResult = {
          id: body && body.probeId ? String(body.probeId) : '',
          proof: body && body.proof ? String(body.proof) : '',
          pixelHash: body && body.pixelHash ? String(body.pixelHash) : '',
          devices: body && Array.isArray(body.devices) ? body.devices : [],
          probeWallClockMs: body && typeof body.probeWallClockMs === 'number' ? body.probeWallClockMs : undefined,
          loadPercent: body && typeof body.loadPercent === 'number' ? body.loadPercent : undefined,
          version: body && typeof body.version === 'string' ? body.version : '',
        };
        const hardwareSpec = body && typeof body.hardwareSpec === 'object' ? body.hardwareSpec : null;
        const probeRoundId = getCurrentNetworkRoundId();
        const verdict = await submitPeerProbeResult(probeResult, hardwareSpec, probeRoundId);
        if (verdict && verdict.receipt && wtcNode && typeof wtcNode.signMessage === 'function') {
          const verifierAddress = String(verdict.receipt.verifierAddress || '').trim();
          const workerId = String(verdict.receipt.workerId || '').trim();
          if (verifierAddress && workerId && verifierAddress === workerId) {
            console.warn('[PeerProbe] Self-verification attempt detected: verifierAddress equals workerId.');
            verdict.ok = false;
            verdict.issues = [
              ...(Array.isArray(verdict.issues) ? verdict.issues : []),
              'self-verification is not allowed',
            ];
            verdict.receipt = null;
          } else {
            const signingPayload = getProbeReceiptSigningPayload(verdict.receipt);
            if (verifierAddress && signingPayload) {
              try {
                const signed = wtcNode.signMessage(verifierAddress, signingPayload);
                verdict.receipt = attachProbeReceiptSignature(verdict.receipt, signed && signed.signature);
                if (verdict.receipt) {
                  recordPeerAttestation(verifierAddress, workerId);
                  broadcastProbeReceiptToPeers(verdict.receipt);
                }
              } catch (error) {
                console.warn(
                  '[PeerProbe] Failed to sign probe receipt:',
                  error && error.message ? error.message : error,
                );
                verdict.ok = false;
                verdict.issues = [
                  ...(Array.isArray(verdict.issues) ? verdict.issues : []),
                  'peer probe receipt signing failed',
                ];
                verdict.receipt = null;
              }
            }
          }
        }
        sendJson(res, 200, verdict);
        return;
      }

      // POST /api/v1/probe/receipt - receives a probe receipt broadcast from a
      // verifier peer.  The receipt is signed by the verifier and attests to a
      // worker having answered a specific probe.  Stores it so the worker's
      // contribution chainIndex can be cross-checked.
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/probe/receipt') {
        const body = await readJsonBody(req);
        const receipt = body && body.receipt && typeof body.receipt === 'object' ? body.receipt : null;
        if (!receipt || !receipt.workerId || !receipt.chainIndex || !receipt.verifierAddress) {
          sendJson(res, 400, { ok: false, code: 'INVALID_RECEIPT', message: 'Invalid probe receipt.' });
          return;
        }
        const normalizedReceipt = normalizeProbeReceipt(receipt);
        if (!normalizedReceipt) {
          sendJson(res, 400, { ok: false, code: 'INVALID_RECEIPT', message: 'Could not normalize receipt.' });
          return;
        }
        if (normalizedReceipt.verifierAddress === normalizedReceipt.workerId) {
          sendJson(res, 400, {
            ok: false,
            code: 'SELF_VERIFICATION',
            message: 'Verifier cannot attest to its own worker receipt.',
          });
          return;
        }
        if (
          !normalizedReceipt.signature ||
          typeof normalizedReceipt.signature !== 'string' ||
          normalizedReceipt.signature.length < 130
        ) {
          sendJson(res, 400, {
            ok: false,
            code: 'INVALID_SIGNATURE',
            message: 'Missing or invalid receipt signature.',
          });
          return;
        }
        const payload_no_sig = getProbeReceiptSigningPayload(normalizedReceipt);
        if (!payload_no_sig) {
          sendJson(res, 400, { ok: false, code: 'INVALID_PAYLOAD', message: 'Invalid receipt payload.' });
          return;
        }
        const verified = wtcNode.verifyMessage(
          normalizedReceipt.verifierAddress,
          normalizedReceipt.signature,
          payload_no_sig,
        );
        if (!verified) {
          sendJson(res, 403, {
            ok: false,
            code: 'SIGNATURE_MISMATCH',
            message: 'Receipt signature verification failed.',
          });
          return;
        }
        const currentRoundId = getCurrentNetworkRoundId();
        const receiptRoundId = Math.max(0, Math.floor(Number(normalizedReceipt.roundId) || 0));
        if (receiptRoundId !== currentRoundId) {
          sendJson(res, 409, {
            ok: false,
            code: 'RECEIPT_ROUND_MISMATCH',
            message: `Receipt roundId ${receiptRoundId} does not match current round ${currentRoundId}.`,
          });
          return;
        }
        recordPeerAttestation(normalizedReceipt.verifierAddress, normalizedReceipt.workerId);
        const workerAddr = normalizedReceipt.workerId;
        const chainIdx = Math.max(0, Math.floor(Number(normalizedReceipt.chainIndex) || 0));
        if (!witnessedProbeReceipts.has(workerAddr)) {
          witnessedProbeReceipts.set(workerAddr, { maxChainIndex: 0, receipts: new Map() });
        }
        const entry = witnessedProbeReceipts.get(workerAddr);
        if (chainIdx > (entry.maxChainIndex || 0)) {
          entry.maxChainIndex = chainIdx;
        }
        const receiptsForIndex = entry.receipts.get(chainIdx) || new Map();
        receiptsForIndex.set(String(normalizedReceipt.verifierAddress || '').trim(), normalizedReceipt);
        entry.receipts.set(chainIdx, receiptsForIndex);
        if (entry.receipts.size > 500) {
          const oldest = [...entry.receipts.keys()].sort((a, b) => a - b).slice(0, 100);
          for (const k of oldest) entry.receipts.delete(k);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // -- Governance capability probe ------------------------------------------
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/governance/capability') {
        const rl = await enforceEndpointRateLimit('governance-capability', requesterIdentity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        sendJson(res, 200, { ok: true, hasNfts: _nodeHasGovernanceNfts() });
        return;
      }

      // -- Governance snapshot (pull-based sync) ----------------------------
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/governance/snapshot') {
        const rl = await enforceEndpointRateLimit('governance-snapshot', requesterIdentity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, error: 'Node not ready' });
          return;
        }
        try {
          const proposals = wtcNode.getGovernanceProposals();
          sendJson(res, 200, { ok: true, proposals });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e && e.message) });
        }
        return;
      }

      // -- Governance team/docs snapshot (pull-based sync) ------------------
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/governance/team-docs') {
        if (!_nodeHasGovernanceNfts()) {
          sendJson(res, 403, { ok: false, error: 'No governance NFTs on this node' });
          return;
        }
        const rl = await enforceEndpointRateLimit('governance-team-docs', requesterIdentity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        try {
          sendJson(res, 200, { ok: true, members: readTeamData(), docs: readDocsData() });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e && e.message) });
        }
        return;
      }
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/governance/team-docs') {
        if (!_nodeHasGovernanceNfts()) {
          sendJson(res, 403, { ok: false, error: 'No governance NFTs on this node' });
          return;
        }
        const rl = await enforceEndpointRateLimit('governance-team-docs-push', requesterIdentity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        try {
          let body = '';
          for await (const chunk of req) body += chunk;
          const data = JSON.parse(body);
          if (data && data.ok) {
            const localMembers = readTeamData();
            const localDocs = readDocsData();
            const merged = { members: {}, docs: {} };
            for (const m of localMembers) merged.members[m.id] = m;
            for (const d of localDocs) merged.docs[d.id] = d;
            if (Array.isArray(data.members)) {
              for (const m of data.members) {
                if (!merged.members[m.id] || m.addedAt > merged.members[m.id].addedAt) {
                  merged.members[m.id] = m;
                }
              }
            }
            if (Array.isArray(data.docs)) {
              for (const d of data.docs) {
                if (!merged.docs[d.id] || d.addedAt > merged.docs[d.id].addedAt) {
                  merged.docs[d.id] = d;
                }
              }
            }
            writeTeamData(Object.values(merged.members));
            writeDocsData(Object.values(merged.docs));
          }
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e && e.message) });
        }
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/ops/metrics') {
        if (!isLedgerNetworkAuthorized(req, settings)) {
          recordPeerIdentityFailure(requesterIdentity, 'unauthorized-request');
          sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Missing or invalid ledger network token.' });
          return;
        }
        const snapshot = opsState.latestSnapshot || (await collectOpsSnapshot());
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/network/peers') {
        rememberObservedRequester(req, settings, 'peer-directory-presence');
        maybeRegisterReachableRequester(req, settings, 'peer-directory').catch(() => {});
        sendJson(res, 200, {
          ok: true,
          network: getActiveNetwork(),
          peers: buildAdvertisedPeerList(settings),
        });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/network/gossip') {
        const body = await readJsonBody(req);
        receivePeerGossip(body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/network/punch') {
        const advertisedUrl = getPrimaryAdvertisedPeerUrl(settings);
        let ourPublicIp = '';
        let ourPublicPort = 0;
        if (advertisedUrl) {
          try {
            const parsed = new URL(advertisedUrl);
            ourPublicIp = parsed.hostname;
            ourPublicPort = Number(parsed.port) || settings.listenPort;
          } catch (_) {
            /* ignore URL parse error */
          }
        }
        if (!ourPublicIp && stunNatInfoRef.current && stunNatInfoRef.current.mappedIp) {
          ourPublicIp = stunNatInfoRef.current.mappedIp;
          ourPublicPort = stunNatInfoRef.current.mappedPort;
        }
        const requesterCandidates = extractReachablePeerCandidates(req, settings);
        const referrerPeerUrl = requesterCandidates.length > 0 ? requesterCandidates[0] : '';
        if (referrerPeerUrl) {
          rememberDiscoveredPeer(referrerPeerUrl, { source: 'hole-punch', quiet: true });
        }
        const body = await readJsonBody(req);
        const requesterIp = body && body.publicIp;
        const requesterPort = body && body.publicPort;
        const requesterPunchPort = body && body.punchPort;
        if (requesterIp && requesterPort && isPublicPeerHost(requesterIp)) {
          const requestedPunchPort = Number(requesterPunchPort) || 0;
          const ourPunchPort = allocatePunchPort(usedPunchPorts);
          if (ourPunchPort > 0) usedPunchPorts.add(ourPunchPort);
          const response = buildPunchResponse(ourPublicIp, ourPublicPort, ourPunchPort);
          response.requesterPort = requestedPunchPort;
          response.requesterIp = requesterIp;
          sendJson(res, 200, response);
          if (ourPunchPort > 0 && ourPublicIp) {
            const punchDelay = Math.max(0, (response.punchAtMs || Date.now()) - Date.now() + 50);
            setTimeout(() => {
              performPunch(requesterIp, requestedPunchPort, ourPunchPort)
                .then((result) => {
                  if (result.ok && result.socket) {
                    console.log(
                      `[HolePunch] Direct TCP connection established to ${requesterIp}:${requestedPunchPort}`,
                    );
                    const viaUrl = normalizePeerUrl(`http://${requesterIp}:${requesterPort}`);
                    if (viaUrl) {
                      peerReachabilityCache.set(viaUrl, {
                        ok: true,
                        lastAttemptAtMs: Date.now(),
                        lastSuccessAtMs: Date.now(),
                      });
                      if (!referrerPeerUrl || viaUrl !== referrerPeerUrl) {
                        rememberDiscoveredPeer(viaUrl, { source: 'hole-punch', quiet: true });
                      }
                    }
                  }
                  if (result && result.socket && !result.socket.destroyed) {
                    try {
                      result.socket.end();
                      result.socket.destroy();
                    } catch (_) {
                      /* ignore */
                    }
                  }
                })
                .catch(() => {});
            }, punchDelay);
          }
        } else {
          sendJson(res, 200, buildPunchResponse('', 0, 0));
        }
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/ops/health') {
        if (!isLedgerNetworkAuthorized(req, settings)) {
          recordPeerIdentityFailure(requesterIdentity, 'unauthorized-request');
          sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Missing or invalid ledger network token.' });
          return;
        }
        const snapshot = opsState.latestSnapshot || (await collectOpsSnapshot());
        sendJson(
          res,
          200,
          buildOpsHealthResponse(snapshot, {
            chainStallAlertMs: CHAIN_STALL_ALERT_MS,
          }),
        );
        return;
      }

      // POST /api/v1/settlement/seen  body: { blockHash, minedAddress, totalWh, rewardCoins, settledAtMs, sig }
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/settlement/seen') {
        const body = await readJsonBody(req);
        const { sig: receivedSig, ...bodyWithoutSig } = body || {};
        const expectedSig = computeHwAuthSig(bodyWithoutSig);
        if (!receivedSig || !secureStringEquals(String(receivedSig), expectedSig)) {
          sendJson(res, 403, { ok: false, code: 'INVALID_SETTLEMENT_SIG', message: 'Settlement signature invalid.' });
          return;
        }
        const fromPeer = getRequesterIdentity(req) || req.socket.remoteAddress || 'unknown';
        recordWitnessedSettlement(body, fromPeer);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/round/contribution') {
        if (!wtcNode || typeof wtcNode.verifyMessage !== 'function') {
          sendJson(res, 503, { ok: false, code: 'NODE_NOT_READY', message: 'Node not ready.' });
          return;
        }
        const body = await readJsonBody(req);
        const address = String((body && body.address) || '').trim();
        const roundId = Math.max(1, Math.floor(Number(body && body.roundId) || 0));
        const totalWh = Number(Math.max(0, Number(body && body.totalWh) || 0).toFixed(8));
        const updatedAtMs = Math.max(0, Math.floor(Number(body && body.updatedAtMs) || 0));
        const chainIndex = Math.max(-1, Math.floor(Number(body && body.chainIndex) || -1));
        const message = String((body && body.message) || '');
        const signature = String((body && body.signature) || '').trim();
        const expectedRoundId = getCurrentNetworkRoundId();
        if (!address || !isValidWtcAddress(address)) {
          sendJson(res, 400, { ok: false, code: 'INVALID_ADDRESS', message: 'Contribution address invalid.' });
          return;
        }
        if (roundId !== expectedRoundId) {
          sendJson(res, 409, {
            ok: false,
            code: 'ROUND_MISMATCH',
            message: `Expected round ${expectedRoundId}, got ${roundId}.`,
          });
          return;
        }
        const expectedMessage = buildRoundContributionMessage({ address, roundId, totalWh, updatedAtMs, chainIndex });
        if (!message || message !== expectedMessage) {
          sendJson(res, 400, { ok: false, code: 'INVALID_MESSAGE', message: 'Contribution message invalid.' });
          return;
        }
        if (!signature || !wtcNode.verifyMessage(address, signature, message)) {
          sendJson(res, 403, { ok: false, code: 'INVALID_SIGNATURE', message: 'Contribution signature invalid.' });
          return;
        }
        const probeCheck = validateContributionProbe(address, totalWh, chainIndex);
        if (!probeCheck.ok) {
          sendJson(res, 409, { ok: false, code: probeCheck.code, message: probeCheck.message });
          return;
        }
        const attestedPowerW = probeCheck.attestedPowerW;
        alignRoundLedgerToChain(roundId);
        const prevWh = roundLedger.getRoundContribution(address);
        const prevUpdatedAt = roundLedger.getRoundContributionUpdatedAt(address);
        const hasPriorContribution = prevWh > 0 && prevUpdatedAt > 0;
        if (hasPriorContribution) {
          if (updatedAtMs > prevUpdatedAt) {
            const elapsedMs = updatedAtMs - prevUpdatedAt;
            const increment = totalWh - prevWh;
            const maxIncrement = (attestedPowerW / 3600000) * elapsedMs * 2;
            if (increment > maxIncrement && maxIncrement > 0.001) {
              sendJson(res, 409, {
                ok: false,
                code: 'CONTRIBUTION_RATE_EXCEEDED',
                message:
                  `Energy increment ${increment.toFixed(4)} Wh exceeds max credible ` +
                  `${maxIncrement.toFixed(4)} Wh over ${elapsedMs}ms ` +
                  `(${((increment / Math.max(1, elapsedMs)) * 3600000).toFixed(0)}W equivalent).`,
              });
              return;
            }
          }
        } else if (totalWh > 0 && attestedPowerW > 0) {
          const roundStartMs = roundLedger.getCurrentRoundStartMs();
          if (roundStartMs > 0 && updatedAtMs > roundStartMs) {
            const elapsedMs = updatedAtMs - roundStartMs;
            const maxIncrement = (attestedPowerW / 3600000) * elapsedMs * 2;
            if (totalWh > maxIncrement && maxIncrement > 0.001) {
              sendJson(res, 409, {
                ok: false,
                code: 'CONTRIBUTION_RATE_EXCEEDED',
                message:
                  `Energy total ${totalWh.toFixed(4)} Wh exceeds max credible ` +
                  `${maxIncrement.toFixed(4)} Wh since round start (${elapsedMs}ms) ` +
                  `(${((totalWh / Math.max(1, elapsedMs)) * 3600000).toFixed(0)}W equivalent).`,
              });
              return;
            }
          }
        }
        const applied = roundLedger.setRoundContribution(address, totalWh, updatedAtMs, message, signature);
        if (!applied || applied.ok === false) {
          sendJson(res, 409, {
            ok: false,
            code: applied && applied.code ? applied.code : 'STALE_CONTRIBUTION',
            message:
              applied && applied.reason
                ? applied.reason
                : 'Contribution update is older than the latest accepted total for this round.',
            roundId,
            addressRoundWh: applied && typeof applied.addressRoundWh === 'number' ? applied.addressRoundWh : 0,
            updatedAtMs: applied && typeof applied.updatedAtMs === 'number' ? applied.updatedAtMs : 0,
          });
          return;
        }
        if (wtcNode && wtcNode._consensus) wtcNode._consensus._hadContributionsBefore = true;
        if (address && message) {
          const fwdKey = `${address}:${message}`;
          if (!forwardedContributionMessages.has(fwdKey)) {
            forwardedContributionMessages.set(fwdKey, Date.now() + 30_000);
            setTimeout(() => forwardedContributionMessages.delete(fwdKey), 30_000);
            if (process.env.WATTCOIN_DEBUG)
              console.log(
                `[contribution-forward] Accepted contribution from ${address}: ${totalWh} Wh (round ${roundId}), dedupKey=${fwdKey.slice(0, 40)}...`,
              );
            if (address !== walletAddressCache.address) {
              const fwdSettings = getLedgerNetworkSettings();
              const fwdPeers = fwdSettings && fwdSettings.enabled ? getActivePeers(fwdSettings) : [];
              if (process.env.WATTCOIN_DEBUG)
                console.log(`[contribution-forward] Forwarding ${address} to ${fwdPeers.length} peers...`);
              if (fwdPeers.length > 0) {
                const fwdBody = { address, roundId, totalWh, updatedAtMs, chainIndex, message, signature };
                for (const peerUrl of fwdPeers) {
                  requestPeerJson(peerUrl, 'POST', '/api/v1/round/contribution', fwdBody, undefined, {
                    timeoutMs: 5000,
                    trackReachability: false,
                    suppressPeerDiscovery: true,
                    source: 'contribution-forward',
                  }).catch(() => {});
                }
              }
            }
          }
        }
        const snapshot = roundLedger.getCurrentRoundSnapshot();
        sendJson(res, 200, {
          ok: true,
          roundId: applied.roundId,
          addressRoundWh: applied.addressRoundWh,
          totalWh: snapshot.totalWh,
        });
        return;
      }

      // GET /api/v1/round/contribution - pull current round snapshot from this peer
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/round/contribution') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, code: 'NODE_NOT_READY', message: 'Node not ready.' });
          return;
        }
        const snapshot = roundLedger.getCurrentRoundSnapshot();
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      // -- WTC native chain endpoints (unauthenticated - proofs are self-verifying) --
      // GET /api/v1/chain/tip
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/chain/tip') {
        maybeRegisterReachableRequester(req, settings, 'tip-probe').catch(() => {});
        const tip = wtcNode ? wtcNode.handleGetTip() : { ok: false, reason: 'node not ready' };
        sendJson(res, 200, tip);
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chain/tip') {
        const body = await readJsonBody(req);
        handlePeerTipSignal(getRequesterIdentity(req), body, 'tip-announce');
        sendJson(res, 200, { ok: true });
        return;
      }

      // POST /api/v1/peers/gossip - receive peer topology gossip
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/peers/gossip') {
        const body = await readJsonBody(req);
        handleIncomingGossip(getRequesterIdentity(req), body);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chain/push') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const body = await readJsonBody(req);
        const fromPeer = getRequesterIdentity(req) || req.socket.remoteAddress || 'unknown';
        const pushResult = wtcNode.handlePushBlocks({
          ancestorHeight: body && body.ancestorHeight,
          blocks: body && body.blocks,
          peer: fromPeer,
        });
        if (pushResult && pushResult.synced) {
          handlePeerTipSignal(fromPeer, { height: pushResult.toHeight }, 'push-chain');
        }
        sendJson(res, 200, pushResult);
        return;
      }

      if (reqUrl.pathname.startsWith('/api/v1/chain/')) {
        const compat = verifyChainPeerCompatibility(req);
        if (!compat.ok) {
          recordPeerIdentityFailure(requesterIdentity, `chain-compat:${compat.reason}`);
          sendJson(res, 409, { ok: false, code: 'CHAIN_INCOMPATIBLE', message: compat.reason });
          return;
        }
      }

      // GET /api/v1/chain/headers?fromHeight=&limit=
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/chain/headers') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('wtc-peer-chain-headers', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const fromHeight = Number(reqUrl.searchParams.get('fromHeight')) || 0;
        const limit = Number(reqUrl.searchParams.get('limit')) || 200;
        sendJson(res, 200, wtcNode.handleGetHeaders(fromHeight, limit));
        return;
      }

      // GET /api/v1/chain/blocks?fromHeight=&limit=
      if (req.method === 'GET' && reqUrl.pathname === '/api/v1/chain/blocks') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('wtc-peer-chain-blocks', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const fromHeight = Number(reqUrl.searchParams.get('fromHeight')) || 0;
        const limit = Number(reqUrl.searchParams.get('limit')) || 100;
        sendJson(res, 200, wtcNode.handleGetBlocks(fromHeight, limit));
        return;
      }

      // GET /api/v1/chain/block/{hash}
      if (req.method === 'GET' && reqUrl.pathname.startsWith('/api/v1/chain/block/')) {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const identity = getRequesterIdentity(req);
        const rl = await enforceEndpointRateLimit('wtc-peer-chain-block-hash', identity);
        if (!rl.ok) {
          sendJson(res, 429, { ok: false, code: rl.code, message: rl.message });
          return;
        }
        const hash = reqUrl.pathname.slice('/api/v1/chain/block/'.length);
        sendJson(res, 200, wtcNode.handleGetBlockByHash(hash));
        return;
      }

      // POST /api/v1/chain/propose
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chain/propose') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const body = await readJsonBody(req);
        const fromPeer = getRequesterIdentity(req) || req.socket.remoteAddress || 'unknown';
        const voteReply = await wtcNode.handleProposal(body, fromPeer);
        sendJson(res, 200, voteReply);
        return;
      }

      // POST /api/v1/chain/vote
      if (req.method === 'POST' && reqUrl.pathname === '/api/v1/chain/vote') {
        if (!wtcNode) {
          sendJson(res, 503, { ok: false, reason: 'node not ready' });
          return;
        }
        const body = await readJsonBody(req);
        const result = wtcNode.handleVote(body);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Ledger endpoint not found.' });
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        code: 'LEDGER_NETWORK_ERROR',
        message: error && error.message ? error.message : 'Peer request failed.',
      });
    }
  };
}

module.exports = { createLedgerRequestHandler };
