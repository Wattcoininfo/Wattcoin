// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

async function run() {
  const { createLedgerRequestHandler } = require('../electron-main/ledger-routes');

  await test('createLedgerRequestHandler is a function', () => {
    assert.strictEqual(typeof createLedgerRequestHandler, 'function');
  });

  await test('createLedgerRequestHandler returns an async function', () => {
    const dummyFn = () => {};
    const handler = createLedgerRequestHandler({
      getRequesterIdentity: dummyFn,
      isPeerIdentityBanned: () => false,
      handleReverseTunnelHttpRequest: dummyFn,
      refreshCoordinatorIdentityKey: dummyFn,
      enforceEndpointRateLimit: () => ({ ok: true }),
      submitPeerProbeResult: dummyFn,
      getCurrentNetworkRoundId: () => 0,
      getProbeReceiptSigningPayload: dummyFn,
      attachProbeReceiptSignature: dummyFn,
      recordPeerAttestation: dummyFn,
      broadcastProbeReceiptToPeers: dummyFn,
      normalizeProbeReceipt: dummyFn,
      _nodeHasGovernanceNfts: () => false,
      readTeamData: () => [],
      writeTeamData: dummyFn,
      readDocsData: () => [],
      writeDocsData: dummyFn,
      isLedgerNetworkAuthorized: () => false,
      recordPeerIdentityFailure: dummyFn,
      collectOpsSnapshot: dummyFn,
      rememberObservedRequester: dummyFn,
      maybeRegisterReachableRequester: dummyFn,
      buildAdvertisedPeerList: () => [],
      receivePeerGossip: dummyFn,
      getPrimaryAdvertisedPeerUrl: () => '',
      extractReachablePeerCandidates: () => [],
      rememberDiscoveredPeer: dummyFn,
      allocatePunchPort: () => 0,
      buildPunchResponse: () => ({}),
      performPunch: dummyFn,
      buildOpsHealthResponse: () => ({}),
      computeHwAuthSig: () => '',
      recordWitnessedSettlement: dummyFn,
      verifyChainPeerCompatibility: () => ({ ok: true }),
      handlePeerTipSignal: dummyFn,
      handleIncomingGossip: dummyFn,
      requestPeerJson: dummyFn,
      getActivePeers: () => [],
      getLedgerNetworkSettings: () => ({ enabled: true, mode: 'peer', listenPort: 39310, listenHost: '0.0.0.0' }),
      validateContributionProbe: () => ({ ok: true, attestedPowerW: 0 }),
      alignRoundLedgerToChain: dummyFn,
      buildRoundContributionMessage: () => '',
      isValidWtcAddress: () => false,
      opsState: { latestSnapshot: null },
      wtcNode: null,
      roundLedger: {
        getRoundContribution: () => 0,
        getRoundContributionUpdatedAt: () => 0,
        getCurrentRoundSnapshot: () => ({ totalWh: 0 }),
        getCurrentRoundStartMs: () => 0,
        setRoundContribution: () => ({ ok: false }),
      },
      walletAddressCache: { address: '' },
      witnessedProbeReceipts: new Map(),
      forwardedContributionMessages: new Map(),
      peerReachabilityCache: new Map(),
      usedPunchPorts: new Set(),
      stunNatInfoRef: { current: null },
      CHAIN_STALL_ALERT_MS: 20 * 60_000,
    });
    assert.strictEqual(typeof handler, 'function');
    assert.strictEqual(handler.constructor.name, 'AsyncFunction');
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
