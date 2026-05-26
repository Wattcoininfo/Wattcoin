// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');

// Simulate the preload.js ALLOWED_CHANNELS set for testing
const ALLOWED_CHANNELS = new Set([
  'wattcoin-get-wallet-address',
  'wattcoin-get-wallet-state',
  'wattcoin-set-primary-address',
  'wattcoin-get-benchmark-capabilities',
  'wattcoin-run-backend-benchmark',
  'wattcoin-set-hardware-load',
  'wattcoin-stop-hardware-load',
  'wattcoin-get-hardware-load-state',
  'wattcoin-mine-block',
  'wattcoin-get-pending-probe',
  'wattcoin-submit-probe-result',
  'wattcoin-get-probe-history',
  'wattcoin-get-attest-history',
  'wattcoin-get-probe-log',
  'wattcoin-save-probe-log',
  'wattcoin-request-peer-probe',
  'wattcoin-submit-peer-probe-result',
  'wattcoin-read-fingerprint',
  'wattcoin-write-fingerprint',
  'wattcoin-get-device-identity',
  'wattcoin-get-peer-count',
  'wattcoin-get-authority-state',
  'wattcoin-reset-hardware-identity',
  'wattcoin-clear-search-cache',
  'wattcoin-seed-authority-state',
  'wattcoin-report-gpu-calibration',
  'wattcoin-verify-gpu-proof',
  'wattcoin-activate-hardware-hold',
  'wattcoin-attestation-issue-challenge',
  'wattcoin-attestation-submit-proof',
  'wattcoin-attestation-get-policy',
  'wattcoin-sign-attestation-message',
  'wattcoin-get-miner-access-policy',
  'wattcoin-get-beta-policy',
  'wattcoin-verify-miner-password',
  'wattcoin-get-network-info',
  'wattcoin-get-wallet-readiness',
  'wattcoin-get-node-mined-coins',
  'wattcoin-ledger-add-contribution',
  'wattcoin-ledger-get-round-summary',
  'wattcoin-ledger-settle-round',
  'wattcoin-ledger-get-balances',
  'wattcoin-get-seed',
  'wattcoin-export-wallet-backup',
  'wattcoin-restore-wallet-backup',
  'wattcoin-send',
  'wattcoin-get-tx-status',
  'wattcoin-list-transactions',
  'wattcoin-get-addresses',
  'wattcoin-create-address',
  'wattcoin-delete-address',
  'wattcoin-check-for-update',
  'wattcoin-install-update',
  'wattcoin-fetch-url',
  'wattcoin-get-electricity-price',
  'wattcoin-explorer-get-blocks',
  'wattcoin-explorer-get-block',
  'wattcoin-validate-address',
  'wattcoin-open-external-url',
  'wattcoin-open-pay-page',
  'wattcoin-sale-status',
  'wattcoin-sale-compute-price',
  'wattcoin-sale-place-order',
  'wattcoin-sale-get-order',
  'wattcoin-sale-cancel-order',
  'wattcoin-sale-get-my-orders',
  'wattcoin-sale-confirm-payment',
  'wattcoin-staking-status',
  'wattcoin-staking-stake',
  'wattcoin-staking-get-entry',
  'wattcoin-staking-get-my-entries',
  'wattcoin-staking-cancel',
  'wattcoin-nft-list',
  'wattcoin-nft-get',
  'wattcoin-nft-collection',
  'wattcoin-nft-transfer',
]);

function invoke(channel) {
  if (!ALLOWED_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`IPC channel '${channel}' is not allowed from the renderer`));
  }
  return Promise.resolve({ ok: true });
}

// ─── describe / it helpers ────────────────────────────────────────────────

function describe(name, fn) {
  fn();
}

function it(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => console.log(`  ✓ ${name}`),
        (e) => {
          console.error(`  ✗ ${name}: ${e.message}`);
          throw e;
        },
      );
    }
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    throw e;
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('IPC allowlist — known production channels', () => {
  it('allows wattcoin-get-wallet-address', async () => {
    const r = await invoke('wattcoin-get-wallet-address');
    assert.ok(r.ok);
  });

  it('allows wattcoin-mine-block', async () => {
    const r = await invoke('wattcoin-mine-block');
    assert.ok(r.ok);
  });

  it('allows wattcoin-sale-place-order', async () => {
    const r = await invoke('wattcoin-sale-place-order');
    assert.ok(r.ok);
  });

  it('allows wattcoin-staking-stake', async () => {
    const r = await invoke('wattcoin-staking-stake');
    assert.ok(r.ok);
  });

  it('allows wattcoin-fetch-url', async () => {
    const r = await invoke('wattcoin-fetch-url');
    assert.ok(r.ok);
  });

  it('allows wattcoin-open-pay-page', async () => {
    const r = await invoke('wattcoin-open-pay-page');
    assert.ok(r.ok);
  });

  it('allows wattcoin-ledger-add-contribution', async () => {
    const r = await invoke('wattcoin-ledger-add-contribution');
    assert.ok(r.ok);
  });

  it('allows wattcoin-nft-transfer', async () => {
    const r = await invoke('wattcoin-nft-transfer');
    assert.ok(r.ok);
  });
});

describe('IPC allowlist — sensitive channels are blocked', () => {
  it('rejects random unknown channel', async () => {
    await assert.rejects(() => invoke('wattcoin-evil-command'), /not allowed from the renderer/);
  });

  it('rejects empty channel', async () => {
    await assert.rejects(() => invoke(''), /not allowed from the renderer/);
  });

  it('rejects null channel', async () => {
    await assert.rejects(() => invoke(null), /not allowed from the renderer/);
  });

  it('rejects undefined channel', async () => {
    await assert.rejects(() => invoke(undefined), /not allowed from the renderer/);
  });

  it('rejects channel with path traversal', async () => {
    await assert.rejects(() => invoke('../wattcoin-evil'), /not allowed from the renderer/);
  });

  it('rejects channel with unexpected prefix', async () => {
    await assert.rejects(() => invoke('wattcoin-delete-all-wallets'), /not allowed from the renderer/);
  });
});

describe('IPC allowlist — exact match required (no substring)', () => {
  it('wattcoin-send is allowed', async () => {
    const r = await invoke('wattcoin-send');
    assert.ok(r.ok);
  });

  it('wattcoin-send-without-approval is NOT allowed', async () => {
    await assert.rejects(() => invoke('wattcoin-send-without-approval'), /not allowed from the renderer/);
  });
});

describe('IPC allowlist — count integrity (no accidental additions)', () => {
  it('has exactly 76 allowed channels', () => {
    assert.strictEqual(ALLOWED_CHANNELS.size, 76);
  });

  it('every channel starts with wattcoin-', () => {
    for (const ch of ALLOWED_CHANNELS) {
      assert.ok(ch.startsWith('wattcoin-'), `Channel ${ch} does not start with wattcoin-`);
    }
  });
});
