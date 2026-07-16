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
  const { registerLedgerIpcHandlers, _nodeHasGovernanceNfts } = require('../electron-main/ledger-ipc');

  // Section 1: Basic exports
  await test('registerLedgerIpcHandlers is a function', () => {
    assert.strictEqual(typeof registerLedgerIpcHandlers, 'function');
  });

  await test('_nodeHasGovernanceNfts is a function', () => {
    assert.strictEqual(typeof _nodeHasGovernanceNfts, 'function');
  });

  // Section 2: _nodeHasGovernanceNfts
  await test('_nodeHasGovernanceNfts returns false when wtcNode is null', () => {
    assert.strictEqual(_nodeHasGovernanceNfts(null), false);
  });

  await test('_nodeHasGovernanceNfts returns false when wtcNode has no addresses', () => {
    const mockNode = {
      getAddresses: () => [],
      getNftsForAddress: () => [],
    };
    assert.strictEqual(_nodeHasGovernanceNfts(mockNode), false);
  });

  await test('_nodeHasGovernanceNfts returns false when address has no NFTs', () => {
    const mockNode = {
      getAddresses: () => ['addr1'],
      getNftsForAddress: () => [],
    };
    assert.strictEqual(_nodeHasGovernanceNfts(mockNode), false);
  });

  await test('_nodeHasGovernanceNfts returns true when address has NFTs', () => {
    const mockNode = {
      getAddresses: () => ['addr1', 'addr2'],
      getNftsForAddress: (addr) => {
        if (addr === 'addr1') return [{ id: 'nft1' }];
        return [];
      },
    };
    assert.strictEqual(_nodeHasGovernanceNfts(mockNode), true);
  });

  // Section 3: registerLedgerIpcHandlers smoke test
  function buildDeps(overrides = {}) {
    return {
      ipcMain: { handle: () => {} },
      roundLedger: {
        isTampered: () => false,
        addContribution: () => ({ ok: true }),
        getCurrentRoundSnapshot: () => ({}),
        getRoundContribution: () => 0,
      },
      getWtcNode: () => null,
      hwAuthority: {
        hwChangedBlocked: false,
        hwHoldUntilMs: 0,
        trustScore: 100,
        currentLoadPercent: 100,
        calibratedUnitPowerW: 100,
        nativeGpuTdpW: 0,
        asicPowerW: 0,
      },
      walletAddressCache: { address: 'test', at: Date.now() },
      getLedgerNetworkSettings: () => ({ enabled: false }),
      getActivePeers: () => [],
      getCurrentBlockHeight: () => 0,
      getCurrentNetworkRoundId: () => 0,
      requestPeerJson: () => null,
      enforceEndpointRateLimit: () => ({ ok: true }),
      settleLocalLedgerRound: () => ({ ok: true }),
      broadcastRoundContributionToPeers: () => {},
      alignRoundLedgerToChain: () => {},
      _flushPendingContribution: () => {},
      PROBE_INTERVAL_MS: 1000,
      ENABLE_POWER_PROOF_COMMITMENT: false,
      getGpuTdpW: () => 0,
      getCpuTdpW: () => 0,
      getAsicPowerW: () => 0,
      getAsicHashrateTHs: () => 0,
      getLocalProbeChain: () => ({ chainIndex: 0 }),
      getMeasuredCpuDuty: () => -1,
      getGpuLoadState: () => null,
      getSharedRoundSnapshot: () => ({ id: 0, totalWh: 0, contributionsWh: {} }),
      hasOnlinePeers: () => false,
      getLocalLedgerBalances: () => ({ ok: true, addressRoundWh: 0 }),
      loadBenchmarkHistory: () => ({ cpuSamples: [], gpuSamples: [] }),
      _pendingContributionWh: { current: 0 },
      _contributionPerSecond: { current: 0 },
      _contributionSecondStart: { current: 0 },
      _startupRampUp: { current: false },
      _startupRampUpStartedAt: { current: 0 },
      _cpuDutySamples: { current: [] },
      _prevRawCpuDuty: { current: -1 },
      _startupGpuRampUp: { current: false },
      _startupGpuRampUpStartedAt: { current: 0 },
      _gpuDutySamples: { current: [] },
      _prevRawGpuDuty: { current: -1 },
      _physicalCoreCount: { current: 0 },
      ...overrides,
    };
  }

  await test('registerLedgerIpcHandlers accepts valid deps without throwing', () => {
    registerLedgerIpcHandlers(buildDeps());
  });

  // Section 4: Contribution handler captures
  let capturedHandlers = {};
  const fakeIpcMain = {
    handle: (channel, handler) => {
      capturedHandlers[channel] = handler;
    },
  };

  await test('registerLedgerIpcHandlers captures the contribution handler', () => {
    capturedHandlers = {};
    registerLedgerIpcHandlers(buildDeps({ ipcMain: fakeIpcMain }));
    assert.ok(capturedHandlers['wattcoin-ledger-add-contribution'], 'handler should have been captured');
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (!process.env.VITEST) process.exit(failed > 0 ? 1 : 0);
}

run();
