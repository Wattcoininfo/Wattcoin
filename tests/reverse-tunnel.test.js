// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const { createReverseTunnel } = require('../electron-main/reverse-tunnel');

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

function noop() {}

function buildMinimalCtx(overrides = {}) {
  const reverseTunnelSessions = new Map();
  const reverseTunnelSessionsByPeerIdentity = new Map();
  const reverseTunnelPendingResponses = new Map();
  const reverseTunnelClientState = {
    connecting: false,
    publicUrl: '',
    tunnelId: '',
    coordinatorUrl: '',
    connectedAtMs: 0,
    lastSeenAtMs: 0,
    reconnectDelayMs: 10_000,
    reconnectTimer: null,
    pingTimer: null,
    socket: null,
    rotateCoordinatorOnNextAttempt: false,
  };
  const relayWorkerConns = new Map();
  const probePushConns = new Map();
  const workerIsMining = new Map();

  const defaults = {
    reverseTunnelSessions,
    reverseTunnelSessionsByPeerIdentity,
    reverseTunnelPendingResponses,
    reverseTunnelClientState,
    relayWorkerConns,
    probePushConns,
    workerIsMining,

    cancelPendingPeerProbesForWorker: noop,
    handleWorkerBusy: noop,
    handleWsProbeResult: async () => {},
    getConfiguredAdvertisedPeerUrls: () => [],
    isPublicPeerHost: () => true,
    normalizePeerUrl: (url) => url || '',
    getPeerDirectoryTargets: () => [],
    getLedgerNetworkSettings: () => ({
      enabled: true,
      mode: 'peer',
      peers: [],
      seedPeers: [],
      listenPort: 39310,
      listenHost: '0.0.0.0',
      publicUrl: '',
      tunnelPublicUrl: '',
      advertiseUrls: [],
      authToken: '',
      coordinatorUrl: '',
    }),
    sendJson: noop,
    forgetDiscoveredPeer: noop,
    rememberDiscoveredPeer: noop,
    scheduleWtcPeerSync: noop,
    forgetDiscoveredPeersByIdentity: noop,
    refreshPeerDirectory: async () => {},
    writeStartupTrace: noop,
    obfuscatePublicPeerUrl: (url) => url || '',
    isSelfPeerUrl: () => false,
    isLocallyServedReverseTunnelPeerUrl: () => false,
    buildPeerAnnouncementHeaders: () => ({}),
    getPeerProtocolInfo: () => ({ networkId: 'test', protocolVersion: 1, genesisHash: '' }),
    getLocalPeerHosts: () => new Set(),
    verifyChainPeerCompatibility: () => ({ ok: true }),
    getLocalPeerIdentity: () => '',
    peerUtils: {
      buildReverseTunnelPublicUrl: (baseUrl, tunnelId) => `http://tunnel/${tunnelId}`,
      buildReverseTunnelConnectUrl: (coordinatorUrl) => `${coordinatorUrl}/api/v1/tunnel/connect`,
      shouldUseManagedReverseTunnel: (settings) => {
        if (!settings || !settings.enabled || settings.mode !== 'peer') return false;
        return !settings.advertiseUrls || settings.advertiseUrls.length === 0;
      },
      sanitizeForwardedTunnelHeaders: (headers) => ({ ...headers }),
      getExplicitAdvertisedPeerUrls: (settings) => settings.advertiseUrls || [],
      isValidPeerIdentity: (value) => typeof value === 'string' && value.length > 0,
      readRequestBodyBuffer: () => Buffer.alloc(0),
    },
    updateWorkerRtt: noop,
    forgetPeerUrlState: noop,
    crypto: { randomBytes: (n) => Buffer.alloc(n, 'a') },
    ledgerNetworkServerRef: { current: null },
    probePushWssRef: { current: null },
    clearProbePushTimer: noop,
    runProbePush: noop,
    REVERSE_TUNNEL_CONNECT_TIMEOUT_MS: 10_000,
    REVERSE_TUNNEL_REQUEST_TIMEOUT_MS: 30_000,
    REVERSE_TUNNEL_MAX_PENDING: 100,
    REVERSE_TUNNEL_RECONNECT_BASE_MS: 10_000,
    REVERSE_TUNNEL_RECONNECT_MAX_MS: 300_000,
    REVERSE_TUNNEL_PING_INTERVAL_MS: 30_000,
    REVERSE_TUNNEL_LIVE_THRESHOLD_MS: 90_000,

    ...overrides,
  };
  return defaults;
}

// -- getActiveReverseTunnelPeerConnectionCount --------------------------------

function testGetActiveReverseTunnelPeerConnectionCount() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);

  assert.strictEqual(rt.getActiveReverseTunnelPeerConnectionCount(), 0, 'returns 0 when no sessions');

  const fakeSocket = { readyState: 1 };
  ctx.reverseTunnelSessions.set('tunnel-1', {
    tunnelId: 'tunnel-1',
    socket: fakeSocket,
    lastSeenAtMs: Date.now(),
  });
  assert.strictEqual(rt.getActiveReverseTunnelPeerConnectionCount(), 1, 'returns 1 for one live session');

  ctx.reverseTunnelSessions.set('tunnel-stale', {
    tunnelId: 'tunnel-stale',
    socket: { readyState: 3 },
    lastSeenAtMs: Date.now(),
  });
  assert.strictEqual(rt.getActiveReverseTunnelPeerConnectionCount(), 1, 'skips non-OPEN readyState');

  ctx.reverseTunnelSessions.set('tunnel-old', {
    tunnelId: 'tunnel-old',
    socket: { readyState: 1 },
    lastSeenAtMs: Date.now() - 200_000,
  });
  assert.strictEqual(rt.getActiveReverseTunnelPeerConnectionCount(), 1, 'skips stale sessions past threshold');
}

function testGetActiveReverseTunnelPeerConnectionCountDedup() {
  const fakeSocket = { readyState: 1 };
  const sessions = new Map();
  sessions.set('tunnel-a', {
    tunnelId: 'tunnel-a',
    peerIdentity: 'peer-1',
    socket: fakeSocket,
    lastSeenAtMs: Date.now(),
  });
  sessions.set('tunnel-b', {
    tunnelId: 'tunnel-b',
    peerIdentity: 'peer-1',
    socket: fakeSocket,
    lastSeenAtMs: Date.now(),
  });
  const ctx = buildMinimalCtx({ reverseTunnelSessions: sessions });
  const rt = createReverseTunnel(ctx);

  assert.strictEqual(rt.getActiveReverseTunnelPeerConnectionCount(), 1, 'deduplicates same peerIdentity');
}

function testGetActiveReverseTunnelPeerConnectionCountDistinct() {
  const fakeSocket = { readyState: 1 };
  const sessions = new Map();
  sessions.set('tunnel-a', {
    tunnelId: 'tunnel-a',
    peerIdentity: 'peer-1',
    socket: fakeSocket,
    lastSeenAtMs: Date.now(),
  });
  sessions.set('tunnel-b', {
    tunnelId: 'tunnel-b',
    peerIdentity: 'peer-2',
    socket: fakeSocket,
    lastSeenAtMs: Date.now(),
  });
  const ctx = buildMinimalCtx({ reverseTunnelSessions: sessions });
  const rt = createReverseTunnel(ctx);

  assert.strictEqual(rt.getActiveReverseTunnelPeerConnectionCount(), 2, 'counts distinct peerIdentities');
}

// -- stopManagedReverseTunnelClient -------------------------------------------

function testStopManagedReverseTunnelClientResetsState() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);
  const s = ctx.reverseTunnelClientState;

  s.connecting = true;
  s.publicUrl = 'http://tunnel/test';
  s.tunnelId = 'tunnel-1';
  s.coordinatorUrl = 'http://coordinator';
  s.connectedAtMs = 12345;
  s.lastSeenAtMs = 67890;
  s.reconnectDelayMs = 5000;

  rt.stopManagedReverseTunnelClient();

  assert.strictEqual(s.connecting, false);
  assert.strictEqual(s.publicUrl, '');
  assert.strictEqual(s.tunnelId, '');
  assert.strictEqual(s.coordinatorUrl, '');
  assert.strictEqual(s.connectedAtMs, 0);
  assert.strictEqual(s.lastSeenAtMs, 0);
  assert.strictEqual(s.reconnectDelayMs, ctx.REVERSE_TUNNEL_RECONNECT_BASE_MS);
}

function testStopManagedReverseTunnelClientClearsTimers() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);
  const s = ctx.reverseTunnelClientState;

  const reconnectTimer = setTimeout(noop, 100000);
  s.reconnectTimer = reconnectTimer;
  const pingTimer = setInterval(noop, 100000);
  s.pingTimer = pingTimer;

  rt.stopManagedReverseTunnelClient();

  assert.strictEqual(s.reconnectTimer, null);
  assert.strictEqual(s.pingTimer, null);
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
}

function testStopManagedReverseTunnelClientClosesSocket() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);
  const s = ctx.reverseTunnelClientState;

  let closed = false;
  s.socket = {
    readyState: 1,
    close: () => {
      closed = true;
    },
  };
  rt.stopManagedReverseTunnelClient();
  assert.strictEqual(closed, true);
  assert.strictEqual(s.socket, null);
}

function testStopManagedReverseTunnelClientRemovesRelayConns() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);

  const virtualWs = { _isRelayWs: true, ws: { _isRelayWs: true }, close: noop };
  ctx.probePushConns.set('worker-relay', { ws: virtualWs });
  const regularWs = { close: noop };
  ctx.probePushConns.set('worker-regular', { ws: regularWs });

  rt.stopManagedReverseTunnelClient();

  assert.strictEqual(ctx.probePushConns.has('worker-relay'), false);
  assert.strictEqual(ctx.probePushConns.has('worker-regular'), true);
}

// -- stopReverseTunnelCoordinator ---------------------------------------------

function testStopReverseTunnelCoordinatorClearsSessions() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);

  const fakeSocket = { readyState: 1, close: noop };
  ctx.reverseTunnelSessions.set('tunnel-1', { tunnelId: 'tunnel-1', socket: fakeSocket, lastSeenAtMs: Date.now() });
  ctx.reverseTunnelSessions.set('tunnel-2', {
    tunnelId: 'tunnel-2',
    socket: { ...fakeSocket },
    lastSeenAtMs: Date.now(),
  });

  rt.stopReverseTunnelCoordinator();
  assert.strictEqual(ctx.reverseTunnelSessions.size, 0);
}

function testStopReverseTunnelCoordinatorClearsPending() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);

  ctx.reverseTunnelPendingResponses.set('req-1', { res: {}, timer: setTimeout(noop, 100000) });
  rt.stopReverseTunnelCoordinator();
  assert.strictEqual(ctx.reverseTunnelPendingResponses.size, 0);
}

// -- handleReverseTunnelHttpRequest -------------------------------------------

async function testHandleReverseTunnelHttpRequestReturns502WhenTunnelNotFound() {
  let statusCode = 0;
  const ctx = buildMinimalCtx({
    sendJson: (_res, code) => {
      statusCode = code;
    },
  });
  const rt = createReverseTunnel(ctx);

  const req = { url: '/api/v1/tunnel/nonexistent/api/v1/test', headers: {} };
  const res = {};

  const handled = await rt.handleReverseTunnelHttpRequest(req, res);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 502);
}

async function testHandleReverseTunnelHttpRequestReturns502WhenSessionNotOpen() {
  let statusCode = 0;
  const sessions = new Map();
  sessions.set('tunnel-1', { tunnelId: 'tunnel-1', socket: { readyState: 3 } });
  const ctx = buildMinimalCtx({
    sendJson: (_res, code) => {
      statusCode = code;
    },
    reverseTunnelSessions: sessions,
  });
  const rt = createReverseTunnel(ctx);

  const req = { url: '/api/v1/tunnel/tunnel-1/api/v1/test', headers: {} };
  const res = {};

  const handled = await rt.handleReverseTunnelHttpRequest(req, res);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 502);
}

async function testHandleReverseTunnelHttpRequestReturns503WhenBusy() {
  const sessions = new Map();
  sessions.set('tunnel-1', { tunnelId: 'tunnel-1', socket: { readyState: 1 } });
  const pending = new Map();
  pending.set('a', { tunnelId: 'tunnel-1', res: {}, timer: null });
  pending.set('b', { tunnelId: 'tunnel-1', res: {}, timer: null });

  let statusCode = 0;
  const ctx = buildMinimalCtx({
    sendJson: (_res, code) => {
      statusCode = code;
    },
    reverseTunnelSessions: sessions,
    reverseTunnelPendingResponses: pending,
    REVERSE_TUNNEL_MAX_PENDING: 2,
  });
  const rt = createReverseTunnel(ctx);

  const req = { url: '/api/v1/tunnel/tunnel-1/api/v1/test', headers: {} };
  const res = {};

  const handled = await rt.handleReverseTunnelHttpRequest(req, res);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 503);
}

async function testHandleReverseTunnelHttpRequestReturns404ForNonApiPath() {
  const sessions = new Map();
  sessions.set('tunnel-1', { tunnelId: 'tunnel-1', socket: { readyState: 1 } });

  let statusCode = 0;
  const ctx = buildMinimalCtx({
    sendJson: (_res, code) => {
      statusCode = code;
    },
    reverseTunnelSessions: sessions,
  });
  const rt = createReverseTunnel(ctx);

  const req = { url: '/api/v1/tunnel/tunnel-1/health', headers: {} };
  const res = {};

  const handled = await rt.handleReverseTunnelHttpRequest(req, res);
  assert.strictEqual(handled, true);
  assert.strictEqual(statusCode, 404);
}

// -- handleManagedReverseTunnelMessage ----------------------------------------

function testHandleManagedReverseTunnelPingPong() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);

  let sent = '';
  const socket = {
    readyState: 1,
    send: (msg) => {
      sent = msg;
    },
  };
  ctx.reverseTunnelClientState.tunnelId = 'tunnel-1';
  ctx.reverseTunnelClientState.publicUrl = 'http://tunnel/test';

  rt.handleManagedReverseTunnelMessage(socket, JSON.stringify({ type: 'ping', nowMs: 1000 }));

  const parsed = JSON.parse(sent);
  assert.strictEqual(parsed.type, 'pong');
  assert.strictEqual(typeof parsed.nowMs, 'number');
}

function testHandleManagedReverseTunnelTunnelReady() {
  let syncCalled = false;
  const clientState = {
    connecting: false,
    publicUrl: '',
    tunnelId: '',
    coordinatorUrl: '',
    connectedAtMs: 0,
    lastSeenAtMs: 0,
    reconnectDelayMs: 50000,
    reconnectTimer: null,
    pingTimer: null,
    socket: null,
    rotateCoordinatorOnNextAttempt: false,
  };
  const ctx = buildMinimalCtx({
    reverseTunnelClientState: clientState,
    normalizePeerUrl: (url) => url,
    scheduleWtcPeerSync: () => {
      syncCalled = true;
    },
  });
  const rt = createReverseTunnel(ctx);

  const socket = { readyState: 1, send: noop };

  rt.handleManagedReverseTunnelMessage(
    socket,
    JSON.stringify({
      type: 'tunnel-ready',
      tunnelId: 'tun-1',
      publicUrl: 'http://public',
    }),
  );

  assert.strictEqual(clientState.tunnelId, 'tun-1');
  assert.strictEqual(clientState.publicUrl, 'http://public');
  assert.ok(clientState.connectedAtMs > 0);
  assert.strictEqual(clientState.reconnectDelayMs, ctx.REVERSE_TUNNEL_RECONNECT_BASE_MS);
  assert.strictEqual(syncCalled, true);
}

function testHandleManagedReverseTunnelRelayWsOpen() {
  const socket = { readyState: 1, send: noop };
  const clientState = {
    connecting: false,
    publicUrl: '',
    tunnelId: '',
    coordinatorUrl: '',
    connectedAtMs: 0,
    lastSeenAtMs: 0,
    reconnectDelayMs: 10_000,
    reconnectTimer: null,
    pingTimer: null,
    socket,
    rotateCoordinatorOnNextAttempt: false,
  };
  const ctx = buildMinimalCtx({
    reverseTunnelClientState: clientState,
    cancelPendingPeerProbesForWorker: noop,
    handleWorkerBusy: noop,
    handleWsProbeResult: async () => {},
  });
  const rt = createReverseTunnel(ctx);

  rt.handleManagedReverseTunnelMessage(
    socket,
    JSON.stringify({
      type: 'relay-ws-open',
      workerId: 'worker-1',
      allowGpu: true,
      hasAsic: false,
    }),
  );

  const conn = ctx.probePushConns.get('worker-1');
  assert.ok(conn, 'probePushConns has worker-1 entry');
  assert.strictEqual(conn.ws._isRelayWs, true);
  assert.strictEqual(conn.allowGpu, true);
  assert.strictEqual(conn.hasAsic, false);
}

function testHandleManagedReverseTunnelIgnoresInvalidJson() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);
  const socket = { readyState: 1, send: noop };
  rt.handleManagedReverseTunnelMessage(socket, '{bad json');
}

function testHandleManagedReverseTunnelIgnoresUnknownType() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);
  const socket = { readyState: 1, send: noop };
  rt.handleManagedReverseTunnelMessage(socket, JSON.stringify({ type: 'unknown-type' }));
}

function testHandleManagedReverseTunnelRelayWsData() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);

  const dataReceived = [];
  const virtualWs = {
    _isRelayWs: true,
    _emitMessage: (data) => dataReceived.push(data),
  };
  ctx.probePushConns.set('worker-1', { ws: virtualWs });
  const socket = { readyState: 1, send: noop };

  const payload = Buffer.from('hello').toString('base64');
  rt.handleManagedReverseTunnelMessage(
    socket,
    JSON.stringify({
      type: 'relay-ws-data',
      workerId: 'worker-1',
      dataBase64: payload,
    }),
  );

  assert.strictEqual(dataReceived.length, 1);
  assert.strictEqual(dataReceived[0].toString(), 'hello');
}

function testHandleManagedReverseTunnelRelayWsClose() {
  const ctx = buildMinimalCtx();
  const rt = createReverseTunnel(ctx);

  let emittedClose = false;
  const virtualWs = {
    _isRelayWs: true,
    _emitClose: () => {
      emittedClose = true;
    },
    _pendingMiningTimeout: null,
  };
  ctx.probePushConns.set('worker-1', { ws: virtualWs });
  const socket = { readyState: 1, send: noop };

  rt.handleManagedReverseTunnelMessage(
    socket,
    JSON.stringify({
      type: 'relay-ws-close',
      workerId: 'worker-1',
    }),
  );

  assert.strictEqual(emittedClose, true);
  assert.strictEqual(ctx.probePushConns.has('worker-1'), false);
}

// -- ensureManagedReverseTunnelClient -----------------------------------------

function testEnsureManagedReverseTunnelClientDisabled() {
  const clientState = {
    connecting: true,
    publicUrl: 'http://old',
    tunnelId: 'old',
    coordinatorUrl: 'http://old',
    connectedAtMs: 12345,
    lastSeenAtMs: 67890,
    reconnectDelayMs: 99999,
    reconnectTimer: null,
    pingTimer: null,
    socket: null,
    rotateCoordinatorOnNextAttempt: false,
  };
  const ctx = buildMinimalCtx({
    reverseTunnelClientState: clientState,
    getLedgerNetworkSettings: () => ({
      enabled: false,
      mode: 'peer',
      advertiseUrls: [],
      peers: [],
      seedPeers: [],
      listenPort: 39310,
      listenHost: '0.0.0.0',
      publicUrl: '',
      tunnelPublicUrl: '',
      authToken: '',
    }),
  });
  const rt = createReverseTunnel(ctx);

  rt.ensureManagedReverseTunnelClient(ctx.getLedgerNetworkSettings());

  // shouldUseManagedReverseTunnel returns false → stopManagedReverseTunnelClient resets state
  assert.strictEqual(clientState.connecting, false);
  assert.strictEqual(clientState.publicUrl, '');
  assert.strictEqual(clientState.tunnelId, '');
}

function testEnsureManagedReverseTunnelClientAlreadyConnected() {
  let shouldUseCalled = false;
  const clientState = {
    connecting: false,
    publicUrl: '',
    tunnelId: '',
    coordinatorUrl: '',
    connectedAtMs: 0,
    lastSeenAtMs: 0,
    reconnectDelayMs: 10_000,
    reconnectTimer: null,
    pingTimer: null,
    socket: { readyState: 1 },
    rotateCoordinatorOnNextAttempt: false,
  };
  const ctx = buildMinimalCtx({
    reverseTunnelClientState: clientState,
    peerUtils: {
      ...buildMinimalCtx().peerUtils,
      shouldUseManagedReverseTunnel: () => {
        shouldUseCalled = true;
        return true;
      },
    },
  });

  const rt = createReverseTunnel(ctx);
  rt.ensureManagedReverseTunnelClient(ctx.getLedgerNetworkSettings());

  // shouldUseManagedReverseTunnel is called first, so shouldUseCalled is true.
  // Then it returns early because socket is present.
  assert.strictEqual(shouldUseCalled, true);
}

function testEnsureManagedReverseTunnelClientAlreadyConnecting() {
  let shouldUseCalled = false;
  const clientState = {
    connecting: true,
    publicUrl: '',
    tunnelId: '',
    coordinatorUrl: '',
    connectedAtMs: 0,
    lastSeenAtMs: 0,
    reconnectDelayMs: 10_000,
    reconnectTimer: null,
    pingTimer: null,
    socket: null,
    rotateCoordinatorOnNextAttempt: false,
  };
  const ctx = buildMinimalCtx({
    reverseTunnelClientState: clientState,
    peerUtils: {
      ...buildMinimalCtx().peerUtils,
      shouldUseManagedReverseTunnel: () => {
        shouldUseCalled = true;
        return true;
      },
    },
  });

  const rt = createReverseTunnel(ctx);
  rt.ensureManagedReverseTunnelClient(ctx.getLedgerNetworkSettings());

  // shouldUseManagedReverseTunnel is called first, so shouldUseCalled is true.
  // Then it returns early because connecting is true.
  assert.strictEqual(shouldUseCalled, true);
}

function testEnsureManagedReverseTunnelClientNoCoordinator() {
  const ctx = buildMinimalCtx({
    getPeerDirectoryTargets: () => [],
    getLedgerNetworkSettings: () => ({
      enabled: true,
      mode: 'peer',
      coordinatorUrl: '',
      advertiseUrls: [],
      peers: [],
      seedPeers: [],
      listenPort: 39310,
      listenHost: '0.0.0.0',
      publicUrl: '',
      tunnelPublicUrl: '',
      authToken: '',
    }),
    peerUtils: {
      ...buildMinimalCtx().peerUtils,
      shouldUseManagedReverseTunnel: () => true,
    },
  });
  const rt = createReverseTunnel(ctx);
  rt.ensureManagedReverseTunnelClient(ctx.getLedgerNetworkSettings());
}

function testEnsureManagedReverseTunnelClientCoordinatorIsSelf() {
  let connectCalled = false;
  const ctx = buildMinimalCtx({
    isSelfPeerUrl: () => true,
    isLocallyServedReverseTunnelPeerUrl: () => true,
    getLedgerNetworkSettings: () => ({
      enabled: true,
      mode: 'peer',
      coordinatorUrl: 'http://self:39310',
      advertiseUrls: [],
      peers: [],
      seedPeers: [],
      listenPort: 39310,
      listenHost: '0.0.0.0',
      publicUrl: '',
      tunnelPublicUrl: '',
      authToken: '',
    }),
    getPeerDirectoryTargets: () => ['http://self:39310'],
    peerUtils: {
      ...buildMinimalCtx().peerUtils,
      shouldUseManagedReverseTunnel: () => true,
    },
    crypto: {
      randomBytes: () => {
        connectCalled = true;
        return Buffer.alloc(16, 'a');
      },
    },
  });
  const rt = createReverseTunnel(ctx);
  rt.ensureManagedReverseTunnelClient(ctx.getLedgerNetworkSettings());
  assert.strictEqual(connectCalled, false);
}

// -- Run ----------------------------------------------------------------------

async function run() {
  console.log('reverse-tunnel tests\n');

  await test('getActiveReverseTunnelPeerConnectionCount', testGetActiveReverseTunnelPeerConnectionCount);
  await test(
    'getActiveReverseTunnelPeerConnectionCount deduplicates same peerIdentity',
    testGetActiveReverseTunnelPeerConnectionCountDedup,
  );
  await test(
    'getActiveReverseTunnelPeerConnectionCount counts distinct peerIdentities',
    testGetActiveReverseTunnelPeerConnectionCountDistinct,
  );
  await test('stopManagedReverseTunnelClient resets state', testStopManagedReverseTunnelClientResetsState);
  await test('stopManagedReverseTunnelClient clears timers', testStopManagedReverseTunnelClientClearsTimers);
  await test('stopManagedReverseTunnelClient closes socket', testStopManagedReverseTunnelClientClosesSocket);
  await test('stopManagedReverseTunnelClient removes relay conns', testStopManagedReverseTunnelClientRemovesRelayConns);
  await test('stopReverseTunnelCoordinator clears sessions', testStopReverseTunnelCoordinatorClearsSessions);
  await test('stopReverseTunnelCoordinator clears pending', testStopReverseTunnelCoordinatorClearsPending);
  await test(
    'handleReverseTunnelHttpRequest returns 502 when tunnel not found',
    testHandleReverseTunnelHttpRequestReturns502WhenTunnelNotFound,
  );
  await test(
    'handleReverseTunnelHttpRequest returns 502 when session not open',
    testHandleReverseTunnelHttpRequestReturns502WhenSessionNotOpen,
  );
  await test(
    'handleReverseTunnelHttpRequest returns 503 when busy',
    testHandleReverseTunnelHttpRequestReturns503WhenBusy,
  );
  await test(
    'handleReverseTunnelHttpRequest returns 404 for non-api path',
    testHandleReverseTunnelHttpRequestReturns404ForNonApiPath,
  );
  await test('handleManagedReverseTunnelMessage ping-pong', testHandleManagedReverseTunnelPingPong);
  await test('handleManagedReverseTunnelMessage tunnel-ready', testHandleManagedReverseTunnelTunnelReady);
  await test('handleManagedReverseTunnelMessage relay-ws-open', testHandleManagedReverseTunnelRelayWsOpen);
  await test(
    'handleManagedReverseTunnelMessage ignores invalid JSON',
    testHandleManagedReverseTunnelIgnoresInvalidJson,
  );
  await test(
    'handleManagedReverseTunnelMessage ignores unknown type',
    testHandleManagedReverseTunnelIgnoresUnknownType,
  );
  await test('handleManagedReverseTunnelMessage relay-ws-data', testHandleManagedReverseTunnelRelayWsData);
  await test('handleManagedReverseTunnelMessage relay-ws-close', testHandleManagedReverseTunnelRelayWsClose);
  await test('ensureManagedReverseTunnelClient disabled', testEnsureManagedReverseTunnelClientDisabled);
  await test(
    'ensureManagedReverseTunnelClient already connected',
    testEnsureManagedReverseTunnelClientAlreadyConnected,
  );
  await test(
    'ensureManagedReverseTunnelClient already connecting',
    testEnsureManagedReverseTunnelClientAlreadyConnecting,
  );
  await test('ensureManagedReverseTunnelClient no coordinator', testEnsureManagedReverseTunnelClientNoCoordinator);
  await test(
    'ensureManagedReverseTunnelClient coordinator is self',
    testEnsureManagedReverseTunnelClientCoordinatorIsSelf,
  );

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed\n`);
  if (!process.env.VITEST) process.exit(failed > 0 ? 1 : 0);
}

run();
