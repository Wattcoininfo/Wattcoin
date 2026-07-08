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
  const {
    buildPeerUrlFromSocket,
    getLocalPeerHosts,
    getLocalPeerIpv4InterfaceEntries,
    getLocalPeerIpv4Interfaces,
    requestExternalResponse,
    requestExternalText,
    readRequestBodyBuffer,
    buildReverseTunnelPublicUrl,
    buildReverseTunnelConnectUrl,
    pickPeerExchangeTargets,
    isReverseTunnelForwardedRequest,
    getExplicitAdvertisedPeerUrls,
    isPinnedPeerUrl,
    isValidPeerIdentity,
    getPeerIdentityKey,
    shouldUseManagedReverseTunnel,
  } = require('../electron-main/peer-utils');

  // ─── buildPeerUrlFromSocket ────────────────────────────────────────────────

  await test('buildPeerUrlFromSocket builds URL from IPv4 address and port', () => {
    const result = buildPeerUrlFromSocket('198.51.100.24', 39310);
    assert.strictEqual(result, 'http://198.51.100.24:39310');
  });

  await test('buildPeerUrlFromSocket builds URL from IPv6 address and port', () => {
    const result = buildPeerUrlFromSocket('::1', 39310);
    assert.strictEqual(result, 'http://[::1]:39310');
  });

  await test('buildPeerUrlFromSocket uses https protocol when specified', () => {
    const result = buildPeerUrlFromSocket('198.51.100.24', 39310, 'https:');
    assert.strictEqual(result, 'https://198.51.100.24:39310');
  });

  await test('buildPeerUrlFromSocket ignores port 0 or NaN', () => {
    assert.strictEqual(buildPeerUrlFromSocket('198.51.100.24', 0), '');
    assert.strictEqual(buildPeerUrlFromSocket('198.51.100.24', NaN), '');
    assert.strictEqual(buildPeerUrlFromSocket('198.51.100.24', undefined), '');
  });

  await test('buildPeerUrlFromSocket ignores missing host', () => {
    assert.strictEqual(buildPeerUrlFromSocket('', 39310), '');
    assert.strictEqual(buildPeerUrlFromSocket(null, 39310), '');
    assert.strictEqual(buildPeerUrlFromSocket(undefined, 39310), '');
  });

  await test('buildPeerUrlFromSocket strips privileged ports (<=1023)', () => {
    assert.strictEqual(buildPeerUrlFromSocket('198.51.100.24', 80), '');
    assert.strictEqual(buildPeerUrlFromSocket('198.51.100.24', 443), '');
    assert.strictEqual(buildPeerUrlFromSocket('198.51.100.24', 1023), '');
  });

  await test('buildPeerUrlFromSocket allows port 1024', () => {
    const result = buildPeerUrlFromSocket('198.51.100.24', 1024);
    assert.strictEqual(result, 'http://198.51.100.24:1024');
  });

  // ─── getLocalPeerHosts ─────────────────────────────────────────────────────

  await test('getLocalPeerHosts always includes 127.0.0.1 and localhost', () => {
    const hosts = getLocalPeerHosts();
    assert.ok(hosts.has('127.0.0.1'), 'should include loopback');
    assert.ok(hosts.has('localhost'), 'should include localhost');
    assert.ok(hosts.size >= 2, 'should have at least 2 entries');
  });

  await test('getLocalPeerHosts entries are strings', () => {
    const hosts = getLocalPeerHosts();
    for (const h of hosts) {
      assert.strictEqual(typeof h, 'string');
    }
  });

  // ─── getLocalPeerIpv4InterfaceEntries ──────────────────────────────────────

  await test('getLocalPeerIpv4InterfaceEntries returns array of entries with address, netmask, internal', () => {
    const entries = getLocalPeerIpv4InterfaceEntries();
    assert.ok(Array.isArray(entries));
    for (const e of entries) {
      assert.strictEqual(typeof e.address, 'string');
      assert.ok(e.address.length > 0);
      assert.strictEqual(typeof e.netmask, 'string');
      assert.strictEqual(typeof e.internal, 'boolean');
    }
  });

  await test('getLocalPeerIpv4InterfaceEntries excludes internal interfaces by default', () => {
    const entries = getLocalPeerIpv4InterfaceEntries();
    for (const e of entries) {
      assert.strictEqual(e.internal, false);
    }
  });

  // ─── getLocalPeerIpv4Interfaces ────────────────────────────────────────────

  await test('getLocalPeerIpv4Interfaces returns array of address strings', () => {
    const addrs = getLocalPeerIpv4Interfaces();
    assert.ok(Array.isArray(addrs));
    for (const a of addrs) {
      assert.strictEqual(typeof a, 'string');
      assert.ok(a.length > 0);
    }
  });

  await test('getLocalPeerIpv4Interfaces deduplicates addresses', () => {
    const addrs = getLocalPeerIpv4Interfaces();
    const unique = new Set(addrs);
    assert.strictEqual(addrs.length, unique.size);
  });

  // ─── Cross-function consistency ────────────────────────────────────────────

  await test('getLocalPeerIpv4Interfaces matches getLocalPeerIpv4InterfaceEntries addresses', () => {
    const entries = getLocalPeerIpv4InterfaceEntries();
    const addrs = getLocalPeerIpv4Interfaces();
    const entryAddrs = entries.map((e) => e.address);
    assert.deepStrictEqual(new Set(addrs), new Set(entryAddrs));
  });

  await test('getLocalPeerHosts includes all non-internal IPv4 addresses', () => {
    const hosts = getLocalPeerHosts();
    const addrs = getLocalPeerIpv4Interfaces();
    for (const a of addrs) {
      assert.ok(hosts.has(a), `hosts should contain ${a}`);
    }
  });

  // ─── New exports: existence check and core behaviour ──────────────────────────

  await test('requestExternalResponse is a function', () => {
    assert.strictEqual(typeof requestExternalResponse, 'function');
  });

  await test('requestExternalText is a function', () => {
    assert.strictEqual(typeof requestExternalText, 'function');
  });

  // ─── readRequestBodyBuffer ───────────────────────────────────────────────────

  await test('readRequestBodyBuffer resolves with buffer from data events', async () => {
    const EventEmitter = require('events');
    const req = new EventEmitter();
    const promise = readRequestBodyBuffer(req);
    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    req.emit('end');
    const buf = await promise;
    assert.ok(Buffer.isBuffer(buf));
    assert.strictEqual(buf.toString(), 'hello world');
  });

  await test('readRequestBodyBuffer rejects when body exceeds maxBytes', async () => {
    const EventEmitter = require('events');
    const req = new EventEmitter();
    req.destroy = () => {};
    const promise = readRequestBodyBuffer(req, 5);
    req.emit('data', Buffer.from('hello '));
    req.emit('data', Buffer.from('world'));
    await assert.rejects(promise, /Request body too large/);
  });

  // ─── buildReverseTunnelPublicUrl ─────────────────────────────────────────────

  await test('buildReverseTunnelPublicUrl builds URL from base and tunnel id', () => {
    const result = buildReverseTunnelPublicUrl('http://coord.local:8080', 'abc123');
    assert.ok(result.includes('/api/v1/tunnel/abc123'));
  });

  await test('buildReverseTunnelPublicUrl returns empty for invalid URL', () => {
    assert.strictEqual(buildReverseTunnelPublicUrl('', 'abc'), '');
  });

  await test('buildReverseTunnelPublicUrl preserves path prefix', () => {
    const result = buildReverseTunnelPublicUrl('http://coord.local:8080/prefix', 'abc123');
    assert.ok(result.includes('/prefix/api/v1/tunnel/abc123'));
  });

  // ─── buildReverseTunnelConnectUrl ────────────────────────────────────────────

  await test('buildReverseTunnelConnectUrl builds connect URL', () => {
    const result = buildReverseTunnelConnectUrl('http://coord.local:8080');
    assert.strictEqual(result, 'http://coord.local:8080/api/v1/tunnel/connect');
  });

  await test('buildReverseTunnelConnectUrl returns empty for invalid URL', () => {
    assert.strictEqual(buildReverseTunnelConnectUrl(''), '');
  });

  await test('buildReverseTunnelConnectUrl preserves path prefix', () => {
    const result = buildReverseTunnelConnectUrl('http://coord.local:8080/prefix');
    assert.strictEqual(result, 'http://coord.local:8080/prefix/api/v1/tunnel/connect');
  });

  // ─── pickPeerExchangeTargets ─────────────────────────────────────────────────

  await test('pickPeerExchangeTargets returns up to limit entries', () => {
    const urls = ['http://a:1', 'http://b:2', 'http://c:3', 'http://d:4', 'http://e:5'];
    const result = pickPeerExchangeTargets(urls, 3);
    assert.ok(Array.isArray(result));
    assert.ok(result.length <= 3);
  });

  await test('pickPeerExchangeTargets deduplicates URLs', () => {
    const urls = ['http://a:1', 'http://a:1', 'http://b:2'];
    const result = pickPeerExchangeTargets(urls, 10);
    assert.ok(result.length <= 2);
  });

  await test('pickPeerExchangeTargets returns empty for empty input', () => {
    assert.deepStrictEqual(pickPeerExchangeTargets([], 5), []);
  });

  await test('pickPeerExchangeTargets filters invalid URLs', () => {
    const urls = ['not-a-url', '', 'http://valid:1'];
    const result = pickPeerExchangeTargets(urls, 10);
    assert.ok(result.every((u) => u.startsWith('http')));
  });

  // ─── isReverseTunnelForwardedRequest ─────────────────────────────────────────

  await test('isReverseTunnelForwardedRequest returns true for loopback tunnel request', () => {
    const req = {
      headers: { 'x-wtc-via-tunnel': '1' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    assert.strictEqual(isReverseTunnelForwardedRequest(req), true);
  });

  await test('isReverseTunnelForwardedRequest returns false without header', () => {
    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    assert.strictEqual(isReverseTunnelForwardedRequest(req), false);
  });

  await test('isReverseTunnelForwardedRequest returns false for non-loopback address', () => {
    const req = {
      headers: { 'x-wtc-via-tunnel': '1' },
      socket: { remoteAddress: '198.51.100.1' },
    };
    assert.strictEqual(isReverseTunnelForwardedRequest(req), false);
  });

  // ─── getExplicitAdvertisedPeerUrls ──────────────────────────────────────────

  await test('getExplicitAdvertisedPeerUrls extracts publicUrl and tunnelPublicUrl', () => {
    const settings = {
      enabled: true,
      mode: 'peer',
      publicUrl: 'http://public:1',
      tunnelPublicUrl: 'http://tunnel:2',
    };
    const result = getExplicitAdvertisedPeerUrls(settings);
    assert.ok(result.includes('http://public:1'));
    assert.ok(result.includes('http://tunnel:2'));
  });

  await test('getExplicitAdvertisedPeerUrls includes advertiseUrls', () => {
    const settings = {
      enabled: true,
      mode: 'peer',
      advertiseUrls: ['http://extra:3'],
    };
    const result = getExplicitAdvertisedPeerUrls(settings);
    assert.ok(result.includes('http://extra:3'));
  });

  await test('getExplicitAdvertisedPeerUrls returns empty for empty settings', () => {
    assert.deepStrictEqual(getExplicitAdvertisedPeerUrls({}), []);
  });

  // ─── isPinnedPeerUrl ─────────────────────────────────────────────────────────

  await test('isPinnedPeerUrl returns true for peer in peers list', () => {
    const settings = { peers: ['http://pinned:39310'] };
    assert.strictEqual(isPinnedPeerUrl('http://pinned:39310', settings), true);
  });

  await test('isPinnedPeerUrl returns true for peer in seedPeers list', () => {
    const settings = { seedPeers: ['http://seed:39310'] };
    assert.strictEqual(isPinnedPeerUrl('http://seed:39310', settings), true);
  });

  await test('isPinnedPeerUrl returns true for peer in configuredPeers list', () => {
    const settings = { configuredPeers: ['http://cfg:39310'] };
    assert.strictEqual(isPinnedPeerUrl('http://cfg:39310', settings), true);
  });

  await test('isPinnedPeerUrl returns false for unknown peer', () => {
    const settings = { peers: ['http://known:39310'] };
    assert.strictEqual(isPinnedPeerUrl('http://unknown:39311', settings), false);
  });

  await test('isPinnedPeerUrl returns false for empty input', () => {
    assert.strictEqual(isPinnedPeerUrl('', {}), false);
  });

  // ─── isValidPeerIdentity ─────────────────────────────────────────────────────

  await test('isValidPeerIdentity returns true for 64-char hex string', () => {
    assert.strictEqual(isValidPeerIdentity('a'.repeat(64)), true);
    assert.strictEqual(isValidPeerIdentity('0'.repeat(64)), true);
    assert.strictEqual(isValidPeerIdentity('f'.repeat(64)), true);
  });

  await test('isValidPeerIdentity returns false for short hex string', () => {
    assert.strictEqual(isValidPeerIdentity('a'.repeat(63)), false);
  });

  await test('isValidPeerIdentity returns false for empty string', () => {
    assert.strictEqual(isValidPeerIdentity(''), false);
  });

  await test('isValidPeerIdentity returns false for null/undefined', () => {
    assert.strictEqual(isValidPeerIdentity(null), false);
    assert.strictEqual(isValidPeerIdentity(undefined), false);
  });

  // ─── getPeerIdentityKey ──────────────────────────────────────────────────────

  await test('getPeerIdentityKey uses peerIdentity from tipResponse when present', () => {
    const result = getPeerIdentityKey('http://a:1', { peerIdentity: 'abc123' });
    assert.strictEqual(result, 'id:abc123');
  });

  await test('getPeerIdentityKey falls back to URL-based key when peerIdentity absent', () => {
    const result = getPeerIdentityKey('http://host:39310', {});
    assert.ok(result.startsWith('url:'));
  });

  await test('getPeerIdentityKey handles null tipResponse gracefully', () => {
    const result = getPeerIdentityKey('http://host:39310', null);
    assert.ok(result.startsWith('url:'));
  });

  // ─── shouldUseManagedReverseTunnel ───────────────────────────────────────────

  await test('shouldUseManagedReverseTunnel returns true for peer with no advertised URLs', () => {
    const settings = { enabled: true, mode: 'peer' };
    assert.strictEqual(shouldUseManagedReverseTunnel(settings), true);
  });

  await test('shouldUseManagedReverseTunnel returns false when peer has advertised URLs', () => {
    const settings = { enabled: true, mode: 'peer', publicUrl: 'http://public:1' };
    assert.strictEqual(shouldUseManagedReverseTunnel(settings), false);
  });

  await test('shouldUseManagedReverseTunnel returns false when not enabled', () => {
    const settings = { enabled: false, mode: 'peer' };
    assert.strictEqual(shouldUseManagedReverseTunnel(settings), false);
  });

  await test('shouldUseManagedReverseTunnel returns false when not in peer mode', () => {
    const settings = { enabled: true, mode: 'miner' };
    assert.strictEqual(shouldUseManagedReverseTunnel(settings), false);
  });

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
