'use strict';

const { expect } = require('chai');
const { createLedgerNetwork } = require('../electron-main/ledger-network');

function buildMinimalCtx(overrides = {}) {
  const defaults = {
    getRuntimeConfig: () => ({
      ledgerNetworkEnabled: false,
      ledgerNetworkMode: 'standalone',
      ledgerPeers: [],
      network: 'wtc-mainnet',
      ledgerNetworkListenHost: '0.0.0.0',
      ledgerNetworkListenPort: 39310,
      ledgerNetworkRequestTimeoutMs: 15000,
      ledgerNetworkPublicUrl: '',
      ledgerNetworkTunnelPublicUrl: '',
      ledgerNetworkAdvertiseUrls: [],
      ledgerCoordinatorUrl: '',
      ledgerNetworkAuthToken: 'test-token',
    }),
    getConfiguredAdvertisedPeerUrls: () => [],
    roundLedger: { syncMaturity: () => {} },
    getCurrentBlockHeight: async () => 100,
    LEDGER_RECONCILE_INTERVAL_MS: 60000,
    loadCachedRemoteSeedPeers: () => [],
    ...overrides,
  };
  return defaults;
}

describe('ledger-network', function () {
  let ledgerNetwork;

  beforeEach(function () {
    ledgerNetwork = createLedgerNetwork(buildMinimalCtx());
  });

  describe('exports', function () {
    const expected = [
      'getLedgerNetworkSettings',
      'getLedgerListenUrls',
      'isLedgerNetworkAuthorized',
      'getTrustedRequesterPeerIdentity',
      'getRequesterIdentity',
      'startLedgerReconcileLoop',
      'stopLedgerReconcileLoop',
    ];
    for (const name of expected) {
      it(`exports ${name}`, function () {
        expect(ledgerNetwork).to.have.property(name).that.is.a('function');
      });
    }
  });

  describe('getLedgerNetworkSettings', function () {
    it('returns disabled settings when ledgerNetworkEnabled is false', function () {
      const settings = ledgerNetwork.getLedgerNetworkSettings();
      expect(settings.enabled).to.equal(false);
      expect(settings.mode).to.equal('standalone');
    });

    it('includes configured peers', function () {
      const ctx = buildMinimalCtx({
        getRuntimeConfig: () => ({
          ledgerNetworkEnabled: true,
          ledgerNetworkMode: 'peer',
          ledgerPeers: ['http://peer1:39310', 'http://peer2:39310'],
          network: 'wtc-mainnet',
          ledgerNetworkListenHost: '0.0.0.0',
          ledgerNetworkListenPort: 39310,
          ledgerNetworkRequestTimeoutMs: 15000,
          ledgerNetworkPublicUrl: '',
          ledgerNetworkTunnelPublicUrl: '',
          ledgerNetworkAdvertiseUrls: [],
          ledgerCoordinatorUrl: '',
          ledgerNetworkAuthToken: '',
        }),
      });
      const ln = createLedgerNetwork(ctx);
      const settings = ln.getLedgerNetworkSettings();
      expect(settings.enabled).to.equal(true);
      expect(settings.mode).to.equal('peer');
      expect(settings.configuredPeers.length).to.be.greaterThan(0);
      expect(settings.listenPort).to.equal(39310);
    });

    it('falls back to default listen port', function () {
      const ctx = buildMinimalCtx({
        getRuntimeConfig: () => ({
          ledgerNetworkEnabled: true,
          ledgerNetworkMode: 'peer',
          ledgerPeers: [],
          network: 'wtc-testnet',
          ledgerNetworkListenHost: '0.0.0.0',
          ledgerNetworkListenPort: undefined,
          ledgerNetworkRequestTimeoutMs: 15000,
          ledgerNetworkPublicUrl: '',
          ledgerNetworkTunnelPublicUrl: '',
          ledgerNetworkAdvertiseUrls: [],
          ledgerCoordinatorUrl: '',
          ledgerNetworkAuthToken: '',
        }),
      });
      const ln = createLedgerNetwork(ctx);
      const settings = ln.getLedgerNetworkSettings();
      expect(settings.listenPort).to.equal(39310);
    });
  });

  describe('getLedgerListenUrls', function () {
    it('uses explicit advertised URLs when available', function () {
      const ctx = buildMinimalCtx({
        getConfiguredAdvertisedPeerUrls: () => ['http://example.com:39310'],
      });
      const ln = createLedgerNetwork(ctx);
      const urls = ln.getLedgerListenUrls({ listenPort: 39310 });
      expect(urls).to.include('http://example.com:39310');
    });
  });

  describe('isLedgerNetworkAuthorized', function () {
    it('rejects request without token header', function () {
      const req = { headers: {} };
      expect(ledgerNetwork.isLedgerNetworkAuthorized(req, { authToken: 'secret' })).to.equal(false);
    });

    it('rejects request with wrong token', function () {
      const req = { headers: { 'x-wattcoin-ledger-token': 'wrong' } };
      expect(ledgerNetwork.isLedgerNetworkAuthorized(req, { authToken: 'secret' })).to.equal(false);
    });
  });

  describe('getRequesterIdentity', function () {
    it('returns remoteAddress when no peer identity header', function () {
      const req = { headers: {}, socket: { remoteAddress: '192.168.1.1' } };
      expect(ledgerNetwork.getRequesterIdentity(req, { authToken: '' })).to.equal('192.168.1.1');
    });

    it('returns remote-client when no remoteAddress', function () {
      const req = { headers: {}, socket: {} };
      expect(ledgerNetwork.getRequesterIdentity(req, { authToken: '' })).to.equal('remote-client');
    });
  });

  describe('reconcile loop', function () {
    it('startLedgerReconcileLoop and stopLedgerReconcileLoop are callable', function () {
      ledgerNetwork.startLedgerReconcileLoop();
      ledgerNetwork.stopLedgerReconcileLoop();
    });
  });
});
