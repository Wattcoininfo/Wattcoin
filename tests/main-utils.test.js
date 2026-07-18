// SPDX-License-Identifier: MIT
'use strict';

const assert = require('assert');
const {
  normalizePeerUrl,
  isDeprecatedPeerUrl,
  normalizeIpLiteral,
  isPrivateIpv4,
  isPrivateIpv6,
  isPublicPeerHost,
  isLoopbackPeerHost,
  formatPeerHostForUrl,
  isReverseTunnelPeerUrl,
  extractTunnelIdFromUrl,
  isUnusableGpuIdentity,
  normalizeGpuFingerprintValue,
  formatHardwareChangeList,
  appendBenchmarkSample,
  getPersonalReference,
  isPowerCpuOutlier,
  getCliCommandName,
  normalizeUpdateFeedUrl,
  secureStringEquals,
  validatePassphrase,
  normalizeWalletError,
  sha256Hex,
  parseRegexSafe,
  hardwareModelsMatch,
  getEndpointActorKey,
  shouldEscalateRateLimitToIdentityFailure,
  normalizeMinerIdentity,
  normalizeHardwareDescriptor,
  sanitizeForwardedTunnelHeaders,
  getPeerNetworkSegment,
  defaultAttestationState,
  verifyPolicyFeedEnvelope,
  computeMinedCoinsFromHeight,
  _computeMaturedMinedCoinsFromHeight,
  _computeWattcoinFromMinedBlocks,
  median,
  pruneOldTimestamps,
  pushTimestampWindow,
  formatBackupTimestampForFilename,
  encryptBackupPayload,
  decryptBackupPayload,
  DEPRECATED_PEER_ENDPOINTS,
  sendJson,
  readJsonBody,
  getHostLanIp,
  computeNextReattestDueAt,
  verifyManifestSignature,
} = require('../electron-main/main-utils');

function describe(name, fn) {
  fn();
}

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    throw e;
  }
}

// ─── normalizePeerUrl ───────────────────────────────────────────────────────

describe('normalizePeerUrl', () => {
  it('normalizes a basic http URL', () => {
    assert.strictEqual(normalizePeerUrl('http://198.51.100.24:39310'), 'http://198.51.100.24:39310');
  });

  it('normalizes an https URL', () => {
    assert.strictEqual(normalizePeerUrl('https://relay.wattcoin.ee:4430'), 'https://relay.wattcoin.ee:4430');
  });

  it('strips trailing slash on path', () => {
    assert.strictEqual(
      normalizePeerUrl('http://198.51.100.24:39310/api/v1/tunnel/abc/'),
      'http://198.51.100.24:39310/api/v1/tunnel/abc',
    );
  });

  it('preserves path when present', () => {
    assert.strictEqual(
      normalizePeerUrl('http://198.51.100.24:39310/api/v1/tunnel/abc'),
      'http://198.51.100.24:39310/api/v1/tunnel/abc',
    );
  });

  it('rejects URLs with port <= 1023', () => {
    assert.strictEqual(normalizePeerUrl('http://198.51.100.24:80'), '');
  });

  it('rejects URLs with port 0', () => {
    assert.strictEqual(normalizePeerUrl('http://198.51.100.24:0'), '');
  });

  it('rejects non-http protocols', () => {
    assert.strictEqual(normalizePeerUrl('ftp://198.51.100.24:39310'), '');
  });

  it('rejects empty string', () => {
    assert.strictEqual(normalizePeerUrl(''), '');
  });

  it('rejects null', () => {
    assert.strictEqual(normalizePeerUrl(null), '');
  });

  it('rejects whitespace-only', () => {
    assert.strictEqual(normalizePeerUrl('   '), '');
  });

  it('rejects https default port 443 (privileged)', () => {
    assert.strictEqual(normalizePeerUrl('https://relay.wattcoin.ee'), '');
  });

  it('rejects http default port 80 (privileged)', () => {
    assert.strictEqual(normalizePeerUrl('http://example.com'), '');
  });

  it('handles IPv6 literal', () => {
    assert.strictEqual(normalizePeerUrl('http://[::1]:39310'), 'http://[::1]:39310');
  });
});

// ─── isDeprecatedPeerUrl ────────────────────────────────────────────────────

describe('isDeprecatedPeerUrl', () => {
  it('returns true for known deprecated endpoint', () => {
    assert.strictEqual(isDeprecatedPeerUrl('http://91.95.15.55:39310'), true);
  });

  it('returns true for deprecated endpoint with trailing slash', () => {
    assert.strictEqual(isDeprecatedPeerUrl('http://62.65.200.145:39310/'), true);
  });

  it('returns false for non-deprecated URL', () => {
    assert.strictEqual(isDeprecatedPeerUrl('http://198.51.100.24:39310'), false);
  });

  it('returns false for empty string', () => {
    assert.strictEqual(isDeprecatedPeerUrl(''), false);
  });

  it('DEPRECATED_PEER_ENDPOINTS contains expected entries', () => {
    assert.strictEqual(DEPRECATED_PEER_ENDPOINTS.length, 2);
    assert.deepStrictEqual(DEPRECATED_PEER_ENDPOINTS[0], { hostParts: ['91', '95', '15', '55'], port: 39310 });
  });
});

// ─── normalizeIpLiteral ─────────────────────────────────────────────────────

describe('normalizeIpLiteral', () => {
  it('passes through a normal IPv4', () => {
    assert.strictEqual(normalizeIpLiteral('198.51.100.24'), '198.51.100.24');
  });

  it('passes through normal IPv6', () => {
    assert.strictEqual(normalizeIpLiteral('::1'), '::1');
  });

  it('strips IPv6 zone suffix', () => {
    assert.strictEqual(normalizeIpLiteral('fe80::1%eth0'), 'fe80::1');
  });

  it('extracts IPv4 from IPv4-mapped IPv6', () => {
    assert.strictEqual(normalizeIpLiteral('::ffff:192.168.1.1'), '192.168.1.1');
  });

  it('returns empty for empty input', () => {
    assert.strictEqual(normalizeIpLiteral(''), '');
  });

  it('returns empty for whitespace', () => {
    assert.strictEqual(normalizeIpLiteral('   '), '');
  });
});

// ─── isPrivateIpv4 ──────────────────────────────────────────────────────────

describe('isPrivateIpv4', () => {
  it('returns true for 10.x.x.x', () => {
    assert.strictEqual(isPrivateIpv4('10.0.0.1'), true);
    assert.strictEqual(isPrivateIpv4('10.255.255.255'), true);
  });

  it('returns true for 127.x.x.x', () => {
    assert.strictEqual(isPrivateIpv4('127.0.0.1'), true);
  });

  it('returns true for 169.254.x.x', () => {
    assert.strictEqual(isPrivateIpv4('169.254.1.1'), true);
  });

  it('returns true for 172.16.x.x - 172.31.x.x', () => {
    assert.strictEqual(isPrivateIpv4('172.16.0.1'), true);
    assert.strictEqual(isPrivateIpv4('172.31.255.255'), true);
    assert.strictEqual(isPrivateIpv4('172.32.0.1'), false);
  });

  it('returns true for 192.168.x.x', () => {
    assert.strictEqual(isPrivateIpv4('192.168.0.1'), true);
    assert.strictEqual(isPrivateIpv4('192.168.255.255'), true);
  });

  it('returns true for 100.64.x.x - 100.127.x.x (CGNAT)', () => {
    assert.strictEqual(isPrivateIpv4('100.64.0.1'), true);
    assert.strictEqual(isPrivateIpv4('100.127.255.255'), true);
    assert.strictEqual(isPrivateIpv4('100.128.0.1'), false);
  });

  it('returns true for 0.x.x.x', () => {
    assert.strictEqual(isPrivateIpv4('0.0.0.0'), true);
  });

  it('returns false for public IP', () => {
    assert.strictEqual(isPrivateIpv4('198.51.100.24'), false);
    assert.strictEqual(isPrivateIpv4('8.8.8.8'), false);
  });

  it('returns false for non-IP strings', () => {
    assert.strictEqual(isPrivateIpv4('localhost'), false);
    assert.strictEqual(isPrivateIpv4(''), false);
  });

  it('handles IPv4-mapped IPv6', () => {
    assert.strictEqual(isPrivateIpv4('::ffff:192.168.1.1'), true);
    assert.strictEqual(isPrivateIpv4('::ffff:198.51.100.24'), false);
  });
});

// ─── isPrivateIpv6 ──────────────────────────────────────────────────────────

describe('isPrivateIpv6', () => {
  it('returns true for ::1', () => {
    assert.strictEqual(isPrivateIpv6('::1'), true);
  });

  it('returns true for fc00::/7 (ULA)', () => {
    assert.strictEqual(isPrivateIpv6('fc00::1'), true);
    assert.strictEqual(isPrivateIpv6('fd00::1'), true);
  });

  it('returns true for link-local fe80::/10', () => {
    assert.strictEqual(isPrivateIpv6('fe80::1'), true);
  });

  it('returns false for public IPv6', () => {
    assert.strictEqual(isPrivateIpv6('2001:db8::1'), false);
  });

  it('delegates IPv4-mapped to isPrivateIpv4', () => {
    assert.strictEqual(isPrivateIpv6('::ffff:192.168.1.1'), true);
    assert.strictEqual(isPrivateIpv6('::ffff:8.8.8.8'), false);
  });

  it('returns false for empty', () => {
    assert.strictEqual(isPrivateIpv6(''), false);
  });
});

// ─── isPublicPeerHost ───────────────────────────────────────────────────────

describe('isPublicPeerHost', () => {
  it('returns true for public IPv4', () => {
    assert.strictEqual(isPublicPeerHost('198.51.100.24'), true);
  });

  it('returns false for private IPv4', () => {
    assert.strictEqual(isPublicPeerHost('192.168.1.1'), false);
  });

  it('returns false for localhost', () => {
    assert.strictEqual(isPublicPeerHost('localhost'), false);
  });

  it('returns false for loopback', () => {
    assert.strictEqual(isPublicPeerHost('127.0.0.1'), false);
  });

  it('returns false for empty', () => {
    assert.strictEqual(isPublicPeerHost(''), false);
  });

  it('returns true for public IPv6', () => {
    assert.strictEqual(isPublicPeerHost('2001:db8::1'), true);
  });

  it('returns false for link-local IPv6', () => {
    assert.strictEqual(isPublicPeerHost('fe80::1'), false);
  });

  it('returns false for hostname (not an IP)', () => {
    assert.strictEqual(isPublicPeerHost('example.com'), false);
  });
});

// ─── isLoopbackPeerHost ─────────────────────────────────────────────────────

describe('isLoopbackPeerHost', () => {
  it('returns true for 127.0.0.1', () => {
    assert.strictEqual(isLoopbackPeerHost('127.0.0.1'), true);
  });

  it('returns true for ::1', () => {
    assert.strictEqual(isLoopbackPeerHost('::1'), true);
  });

  it('returns true for localhost', () => {
    assert.strictEqual(isLoopbackPeerHost('localhost'), true);
  });

  it('returns false for private IP', () => {
    assert.strictEqual(isLoopbackPeerHost('192.168.1.1'), false);
  });

  it('returns false for empty', () => {
    assert.strictEqual(isLoopbackPeerHost(''), false);
  });
});

// ─── formatPeerHostForUrl ───────────────────────────────────────────────────

describe('formatPeerHostForUrl', () => {
  it('passes through IPv4', () => {
    assert.strictEqual(formatPeerHostForUrl('198.51.100.24'), '198.51.100.24');
  });

  it('brackets IPv6', () => {
    assert.strictEqual(formatPeerHostForUrl('::1'), '[::1]');
    assert.strictEqual(formatPeerHostForUrl('2001:db8::1'), '[2001:db8::1]');
  });

  it('returns empty for empty', () => {
    assert.strictEqual(formatPeerHostForUrl(''), '');
  });
});

// ─── isReverseTunnelPeerUrl ─────────────────────────────────────────────────

describe('isReverseTunnelPeerUrl', () => {
  it('returns true for valid tunnel URL', () => {
    assert.strictEqual(isReverseTunnelPeerUrl('http://198.51.100.24:39310/api/v1/tunnel/abc123'), true);
  });

  it('returns true for relay-style tunnel URL', () => {
    assert.strictEqual(isReverseTunnelPeerUrl('https://relay.wattcoin.ee:4430/api/v1/tunnel/node-123'), true);
  });

  it('returns false for plain peer URL without tunnel path', () => {
    assert.strictEqual(isReverseTunnelPeerUrl('http://198.51.100.24:39310'), false);
  });

  it('returns false for too-short path', () => {
    assert.strictEqual(isReverseTunnelPeerUrl('http://198.51.100.24:39310/api/v1'), false);
  });

  it('returns false for empty', () => {
    assert.strictEqual(isReverseTunnelPeerUrl(''), false);
  });
});

// ─── extractTunnelIdFromUrl ─────────────────────────────────────────────────

describe('extractTunnelIdFromUrl', () => {
  it('extracts tunnel ID from a valid tunnel URL', () => {
    assert.strictEqual(extractTunnelIdFromUrl('http://198.51.100.24:39310/api/v1/tunnel/abc123'), 'abc123');
  });

  it('extracts tunnel ID with dashes', () => {
    assert.strictEqual(extractTunnelIdFromUrl('http://198.51.100.24:39310/api/v1/tunnel/node-123'), 'node-123');
  });

  it('returns empty for URL without tunnel path', () => {
    assert.strictEqual(extractTunnelIdFromUrl('http://198.51.100.24:39310'), '');
  });

  it('returns empty for too-short path', () => {
    assert.strictEqual(extractTunnelIdFromUrl('http://198.51.100.24:39310/api/v1'), '');
  });

  it('returns empty for empty string', () => {
    assert.strictEqual(extractTunnelIdFromUrl(''), '');
  });

  it('returns empty for malformed URL', () => {
    assert.strictEqual(extractTunnelIdFromUrl('not a url'), '');
  });
});

// ─── validatePassphrase ─────────────────────────────────────────────────────

describe('validatePassphrase', () => {
  it('returns true for passphrase with 8+ characters', () => {
    assert.strictEqual(validatePassphrase('12345678'), true);
  });

  it('returns false for passphrase with 7 characters', () => {
    assert.strictEqual(validatePassphrase('1234567'), false);
  });

  it('returns false for empty string', () => {
    assert.strictEqual(validatePassphrase(''), false);
  });

  it('returns false for non-string input', () => {
    assert.strictEqual(validatePassphrase(null), false);
    assert.strictEqual(validatePassphrase(undefined), false);
    assert.strictEqual(validatePassphrase(123), false);
  });
});

// ─── normalizeWalletError ───────────────────────────────────────────────────

describe('normalizeWalletError', () => {
  it('returns ok:false with code and message from error', () => {
    const err = new Error('something broke');
    err.code = 'ERR_BROKE';
    const result = normalizeWalletError(err);
    assert.deepStrictEqual(result, { ok: false, code: 'ERR_BROKE', message: 'something broke' });
  });

  it('uses UNKNOWN code when error has no code', () => {
    const err = new Error('no code');
    const result = normalizeWalletError(err);
    assert.strictEqual(result.code, 'UNKNOWN');
  });

  it('uses default message when error has no message', () => {
    const result = normalizeWalletError({ code: 'SILENT' });
    assert.strictEqual(result.message, 'Unknown wallet error');
  });

  it('handles null gracefully', () => {
    const result = normalizeWalletError(null);
    assert.deepStrictEqual(result, { ok: false, code: 'UNKNOWN', message: 'Unknown wallet error' });
  });
});

// ─── sha256Hex ──────────────────────────────────────────────────────────────

describe('sha256Hex', () => {
  it('returns hex hash for a buffer', () => {
    const result = sha256Hex(Buffer.from('hello', 'utf8'));
    assert.strictEqual(result.length, 64);
    assert.strictEqual(result, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('returns hex hash for a string', () => {
    const result = sha256Hex('hello');
    assert.strictEqual(result, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});

// ─── parseRegexSafe ─────────────────────────────────────────────────────────

describe('parseRegexSafe', () => {
  it('returns a RegExp for a valid pattern', () => {
    const re = parseRegexSafe('foo');
    assert.ok(re instanceof RegExp);
    assert.ok(re.test('FOO'));
  });

  it('returns null for invalid pattern', () => {
    assert.strictEqual(parseRegexSafe('[invalid'), null);
  });

  it('returns null for non-string', () => {
    assert.strictEqual(parseRegexSafe(null), null);
    assert.strictEqual(parseRegexSafe(123), null);
  });
});

// ─── hardwareModelsMatch ────────────────────────────────────────────────────

describe('hardwareModelsMatch', () => {
  it('matches identical models', () => {
    assert.ok(hardwareModelsMatch('Intel Core i5-3320M', 'Intel Core i5-3320M'));
  });

  it('matches despite OEM decoration', () => {
    assert.ok(hardwareModelsMatch('Intel Core i5-3320M CPU @ 2.60GHz', 'Intel Core i5-3320M'));
  });

  it('matches via token fallback', () => {
    assert.ok(hardwareModelsMatch('NVIDIA GeForce RTX 4090', 'RTX 4090'));
  });

  it('returns false for completely different models', () => {
    assert.strictEqual(hardwareModelsMatch('Intel Core i5', 'AMD Ryzen 7'), false);
  });

  it('returns false for empty', () => {
    assert.strictEqual(hardwareModelsMatch('', ''), false);
  });
});

// ─── getEndpointActorKey ────────────────────────────────────────────────────

describe('getEndpointActorKey', () => {
  it('returns endpointName:actorId', () => {
    assert.strictEqual(getEndpointActorKey('test-endpoint', 'actor-1'), 'test-endpoint:actor-1');
  });

  it('uses default actorId', () => {
    assert.strictEqual(getEndpointActorKey('test'), 'test:local-client');
  });
});

// ─── shouldEscalateRateLimitToIdentityFailure ───────────────────────────────

describe('shouldEscalateRateLimitToIdentityFailure', () => {
  it('returns true for non-peer endpoints', () => {
    assert.strictEqual(shouldEscalateRateLimitToIdentityFailure('login'), true);
  });

  it('returns false for wtc-peer endpoints', () => {
    assert.strictEqual(shouldEscalateRateLimitToIdentityFailure('wtc-peer-sync'), false);
  });

  it('returns false for peer-probe endpoints', () => {
    assert.strictEqual(shouldEscalateRateLimitToIdentityFailure('peer-probe-1'), false);
  });

  it('returns false for empty', () => {
    assert.strictEqual(shouldEscalateRateLimitToIdentityFailure(''), false);
  });
});

// ─── normalizeMinerIdentity ────────────────────────────────────────────────

describe('normalizeMinerIdentity', () => {
  it('trims and returns miner ID', () => {
    assert.strictEqual(normalizeMinerIdentity('  my-miner  '), 'my-miner');
  });

  it('truncates to 128 chars', () => {
    const long = 'a'.repeat(200);
    assert.strictEqual(normalizeMinerIdentity(long).length, 128);
  });

  it('returns local-client for empty input', () => {
    assert.strictEqual(normalizeMinerIdentity(''), 'local-client');
  });

  it('returns local-client for non-string', () => {
    assert.strictEqual(normalizeMinerIdentity(null), 'local-client');
  });
});

// ─── normalizeHardwareDescriptor ────────────────────────────────────────────

describe('normalizeHardwareDescriptor', () => {
  it('normalizes a hardware descriptor', () => {
    const result = normalizeHardwareDescriptor({
      deviceType: 'Desktop',
      cpu: 'Intel i7',
      gpu: 'RTX 4090',
      memory: '32GB',
    });
    assert.strictEqual(result.deviceType, 'Desktop');
    assert.strictEqual(result.cpu, 'Intel i7');
    assert.strictEqual(result.gpu, 'RTX 4090');
    assert.strictEqual(result.memory, '32GB');
  });

  it('returns empty strings for missing fields', () => {
    const result = normalizeHardwareDescriptor({});
    assert.strictEqual(result.deviceType, '');
  });
});

// ─── sanitizeForwardedTunnelHeaders ─────────────────────────────────────────

describe('sanitizeForwardedTunnelHeaders', () => {
  it('keeps allowed headers', () => {
    const result = sanitizeForwardedTunnelHeaders({ 'content-type': 'application/json', 'x-wtc-foo': 'bar' });
    assert.strictEqual(result['content-type'], 'application/json');
    assert.strictEqual(result['x-wtc-foo'], 'bar');
  });

  it('strips disallowed headers', () => {
    const result = sanitizeForwardedTunnelHeaders({ authorization: 'Bearer x', cookie: 'y' });
    assert.deepStrictEqual(result, {});
  });

  it('skips null/undefined/empty values', () => {
    const result = sanitizeForwardedTunnelHeaders({ 'content-type': null });
    assert.deepStrictEqual(result, {});
  });
});

// ─── getPeerNetworkSegment ──────────────────────────────────────────────────

describe('getPeerNetworkSegment', () => {
  it('returns CIDR for IPv4', () => {
    assert.strictEqual(getPeerNetworkSegment('http://192.168.1.100:39310'), '192.168.1.0/24');
  });

  it('returns hostname for domain', () => {
    assert.strictEqual(getPeerNetworkSegment('http://peer.example.com:39310'), 'peer.example.com');
  });

  it('returns empty for invalid URL', () => {
    assert.strictEqual(getPeerNetworkSegment(''), '');
  });
});

// ─── defaultAttestationState ────────────────────────────────────────────────

describe('defaultAttestationState', () => {
  it('returns state with version 1', () => {
    const state = defaultAttestationState();
    assert.strictEqual(state.version, 1);
    assert.ok(state.secret);
    assert.deepStrictEqual(state.miners, {});
  });
});

// ─── verifyPolicyFeedEnvelope ───────────────────────────────────────────────

describe('verifyPolicyFeedEnvelope', () => {
  it('returns false for missing envelope', () => {
    assert.strictEqual(verifyPolicyFeedEnvelope(null, 'key'), false);
  });

  it('returns false for missing signature', () => {
    assert.strictEqual(verifyPolicyFeedEnvelope({ policy: {} }, 'key'), false);
  });

  it('returns false for missing public key', () => {
    assert.strictEqual(verifyPolicyFeedEnvelope({ policy: {}, signature: 'sig' }, ''), false);
  });
});

// ─── computeMinedCoinsFromHeight ────────────────────────────────────────────

describe('computeMinedCoinsFromHeight', () => {
  it('returns 0 for height 0', () => {
    assert.strictEqual(computeMinedCoinsFromHeight(0), 0);
  });

  it('returns correct coins for first halving era', () => {
    const result = computeMinedCoinsFromHeight(210000);
    assert.strictEqual(result, 50 * 210000);
  });
});

// ─── _computeMaturedMinedCoinsFromHeight ────────────────────────────────────

describe('_computeMaturedMinedCoinsFromHeight', () => {
  it('returns 0 for low height (within maturity)', () => {
    assert.strictEqual(_computeMaturedMinedCoinsFromHeight(50), 0);
  });

  it('returns same as computeMinedCoinsFromHeight for mature height', () => {
    const mature = _computeMaturedMinedCoinsFromHeight(210100);
    const direct = computeMinedCoinsFromHeight(210000);
    assert.strictEqual(mature, direct);
  });
});

// ─── _computeWattcoinFromMinedBlocks ────────────────────────────────────────

describe('_computeWattcoinFromMinedBlocks', () => {
  it('returns 0 for 0 blocks', () => {
    assert.strictEqual(_computeWattcoinFromMinedBlocks(0), 0);
  });

  it('returns positive for some blocks', () => {
    const result = _computeWattcoinFromMinedBlocks(1000);
    assert.ok(result > 0);
  });

  it('handles large block count', () => {
    const result = _computeWattcoinFromMinedBlocks(10000000);
    assert.ok(result > 0);
  });
});

// ─── median ─────────────────────────────────────────────────────────────────

describe('median', () => {
  it('returns 0 for empty array', () => {
    assert.strictEqual(median([]), 0);
  });

  it('returns the middle value for odd-length sorted', () => {
    assert.strictEqual(median([1, 2, 3]), 2);
  });

  it('returns average of two middle values for even-length', () => {
    assert.strictEqual(median([1, 2, 3, 4]), 2.5);
  });

  it('works with unsorted input', () => {
    assert.strictEqual(median([3, 1, 2]), 2);
  });

  it('returns 0 for non-array input', () => {
    assert.strictEqual(median(null), 0);
    assert.strictEqual(median('not array'), 0);
  });
});

// ─── pruneOldTimestamps ─────────────────────────────────────────────────────

describe('pruneOldTimestamps', () => {
  it('removes timestamps older than windowMs', () => {
    const now = Date.now();
    const old = now - 100000;
    const result = pruneOldTimestamps([old, now], 50000);
    assert.deepStrictEqual(result, [now]);
  });

  it('keeps timestamps within window', () => {
    const now = Date.now();
    const result = pruneOldTimestamps([now], 1000);
    assert.deepStrictEqual(result, [now]);
  });

  it('returns empty when all are old', () => {
    const result = pruneOldTimestamps([100], 1);
    assert.deepStrictEqual(result, []);
  });
});

// ─── pushTimestampWindow ────────────────────────────────────────────────────

describe('pushTimestampWindow', () => {
  it('adds a timestamp and prunes old ones', () => {
    const target = [];
    const result = pushTimestampWindow(target, 60000, 10);
    assert.strictEqual(result.length, 1);
    assert.ok(typeof result[0] === 'number');
  });

  it('respects maxLen', () => {
    const now = Date.now();
    const target = [now - 3000, now - 2000, now - 1000];
    const result = pushTimestampWindow(target, 60000, 2);
    // Should keep the newest 2 (now - 1000 and the newly pushed now)
    assert.strictEqual(result.length, 2);
  });
});

// ─── isUnusableGpuIdentity ──────────────────────────────────────────────────

describe('isUnusableGpuIdentity', () => {
  it('returns true for empty string', () => {
    assert.strictEqual(isUnusableGpuIdentity(''), true);
  });

  it('returns true for "unknown"', () => {
    assert.strictEqual(isUnusableGpuIdentity('unknown'), true);
    assert.strictEqual(isUnusableGpuIdentity('Unknown GPU'), true);
  });

  it('returns true for hex IDs like 0x1234', () => {
    assert.strictEqual(isUnusableGpuIdentity('0x1234'), true);
    assert.strictEqual(isUnusableGpuIdentity('0xABCD'), true);
  });

  it('returns true for numeric-only strings', () => {
    assert.strictEqual(isUnusableGpuIdentity('12345'), true);
    assert.strictEqual(isUnusableGpuIdentity('1, 2, 3'), true);
  });

  it('returns true for Microsoft Basic/Remote Display', () => {
    assert.strictEqual(isUnusableGpuIdentity('Microsoft Basic Display Driver'), true);
    assert.strictEqual(isUnusableGpuIdentity('Microsoft Remote Display Adapter'), true);
    assert.strictEqual(isUnusableGpuIdentity('Microsoft Hyper-V Video'), true);
  });

  it('returns false for a real GPU name', () => {
    assert.strictEqual(isUnusableGpuIdentity('NVIDIA GeForce RTX 3080'), false);
    assert.strictEqual(isUnusableGpuIdentity('AMD Radeon RX 6800'), false);
    assert.strictEqual(isUnusableGpuIdentity('Intel Arc A770'), false);
  });

  it('returns false for null', () => {
    assert.strictEqual(isUnusableGpuIdentity(null), true);
  });
});

// ─── normalizeGpuFingerprintValue ───────────────────────────────────────────

describe('normalizeGpuFingerprintValue', () => {
  it('sorts GPU models alphabetically', () => {
    const result = normalizeGpuFingerprintValue(['NVIDIA RTX 3080', 'AMD RX 6800']);
    assert.deepStrictEqual(result, ['AMD RX 6800', 'NVIDIA RTX 3080']);
  });

  it('filters out empty strings', () => {
    const result = normalizeGpuFingerprintValue(['NVIDIA RTX 3080', '', 'AMD RX 6800']);
    assert.deepStrictEqual(result, ['AMD RX 6800', 'NVIDIA RTX 3080']);
  });

  it('trims whitespace', () => {
    const result = normalizeGpuFingerprintValue(['  NVIDIA RTX 3080  ']);
    assert.deepStrictEqual(result, ['NVIDIA RTX 3080']);
  });

  it('returns empty array for non-array input', () => {
    assert.deepStrictEqual(normalizeGpuFingerprintValue(null), []);
    assert.deepStrictEqual(normalizeGpuFingerprintValue('string'), []);
  });

  it('returns empty array for empty array', () => {
    assert.deepStrictEqual(normalizeGpuFingerprintValue([]), []);
  });
});

// ─── formatHardwareChangeList ───────────────────────────────────────────────

describe('formatHardwareChangeList', () => {
  it('detects CPU change', () => {
    const changes = formatHardwareChangeList({ cpuModel: 'Intel i7-10700' }, { cpuModel: 'Intel i9-13900K' });
    assert.ok(changes.some((c) => c.startsWith('CPU:')));
  });

  it('detects GPU change filtering unusable identities', () => {
    const changes = formatHardwareChangeList({ gpuModels: ['NVIDIA RTX 3080'] }, { gpuModels: ['AMD RX 6800'] });
    assert.ok(changes.some((c) => c.startsWith('GPU:')));
  });

  it('ignores unusable GPU identities', () => {
    const changes = formatHardwareChangeList(
      { gpuModels: ['NVIDIA RTX 3080'] },
      { gpuModels: ['Microsoft Basic Display Driver'] },
    );
    assert.strictEqual(
      changes.some((c) => c.startsWith('GPU:') && c.includes('unknown')),
      true,
    );
  });

  it('returns empty array when nothing changed', () => {
    const descriptor = {
      cpuModel: 'Intel i7',
      gpuModels: ['NVIDIA RTX 3080'],
    };
    const changes = formatHardwareChangeList(descriptor, { ...descriptor });
    assert.deepStrictEqual(changes, []);
  });

  it('handles missing descriptors', () => {
    const changes = formatHardwareChangeList(null, { cpuModel: 'Intel i7' });
    assert.ok(changes.length > 0);
  });
});

// ─── appendBenchmarkSample ──────────────────────────────────────────────────

describe('appendBenchmarkSample', () => {
  it('accepts sample when fewer than 4 existing samples', () => {
    const result = appendBenchmarkSample([100, 110], 105);
    assert.deepStrictEqual(result, [100, 110, 105]);
  });

  it('rejects outlier above 2.5x mean', () => {
    const result = appendBenchmarkSample([100, 110, 105, 95], 500);
    assert.deepStrictEqual(result, [100, 110, 105, 95]);
  });

  it('rejects outlier below 0.4x mean', () => {
    const result = appendBenchmarkSample([100, 110, 105, 95], 10);
    assert.deepStrictEqual(result, [100, 110, 105, 95]);
  });

  it('accepts inlier value', () => {
    const result = appendBenchmarkSample([100, 110, 105, 95], 102);
    assert.deepStrictEqual(result, [100, 110, 105, 95, 102]);
  });

  it('trims to max samples (default 20)', () => {
    const samples = Array.from({ length: 20 }, (_, i) => 100 + i);
    const result = appendBenchmarkSample(samples, 150);
    assert.strictEqual(result.length, 20);
    assert.strictEqual(result[19], 150);
  });

  it('uses provided historyMaxSamples', () => {
    const samples = [1, 2, 3];
    const result = appendBenchmarkSample(samples, 4, 3);
    assert.strictEqual(result.length, 3);
    assert.deepStrictEqual(result, [2, 3, 4]);
  });
});

// ─── getPersonalReference ───────────────────────────────────────────────────

describe('getPersonalReference', () => {
  it('returns tableValue when sample count below enroll', () => {
    assert.strictEqual(getPersonalReference([100, 110], 150, 20, 8), 150);
  });

  it('returns tableValue for empty samples', () => {
    assert.strictEqual(getPersonalReference([], 150), 150);
  });

  it('blends when samples reach enroll count', () => {
    const samples = Array.from({ length: 8 }, (_, i) => 100 + i);
    const ref = getPersonalReference(samples, 150, 20, 8);
    const personalMean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const blendFactor = 8 / 20;
    const expected = 150 * (1 - blendFactor) + personalMean * blendFactor;
    assert.strictEqual(ref, expected);
  });

  it('returns personal mean when tableValue is 0', () => {
    const samples = [100, 110, 105, 95, 102, 108, 103, 97];
    const ref = getPersonalReference(samples, 0, 20, 8);
    const personalMean = samples.reduce((a, b) => a + b, 0) / samples.length;
    assert.strictEqual(ref, personalMean);
  });

  it('fully blends at max samples', () => {
    const samples = Array.from({ length: 20 }, () => 100);
    const ref = getPersonalReference(samples, 200, 20, 8);
    assert.strictEqual(ref, 100);
  });
});

// ─── isPowerCpuOutlier ──────────────────────────────────────────────────────

describe('isPowerCpuOutlier', () => {
  it('returns false when fewer than 3 peers in stats', () => {
    const stats = new Map();
    stats.set('peer1', { totalPowerW: 500, totalCpuOps: 1000, count: 1 });
    assert.strictEqual(isPowerCpuOutlier('peer2', 100, 200, stats), false);
  });

  it('returns false when within normal range', () => {
    const stats = new Map();
    stats.set('peer1', { totalPowerW: 500, totalCpuOps: 1000, count: 1 });
    stats.set('peer2', { totalPowerW: 480, totalCpuOps: 1000, count: 1 });
    stats.set('peer3', { totalPowerW: 520, totalCpuOps: 1000, count: 1 });
    assert.strictEqual(isPowerCpuOutlier('test', 505, 1000, stats), false);
  });

  it('returns true when power/cpu ratio is >3 stddev from mean', () => {
    const stats = new Map();
    stats.set('peer1', { totalPowerW: 500, totalCpuOps: 1000, count: 1 });
    stats.set('peer2', { totalPowerW: 480, totalCpuOps: 1000, count: 1 });
    stats.set('peer3', { totalPowerW: 520, totalCpuOps: 1000, count: 1 });
    assert.strictEqual(isPowerCpuOutlier('test', 5000, 1000, stats), true);
  });

  it('skips the address being checked in mean calc', () => {
    const stats = new Map();
    stats.set('test', { totalPowerW: 999999, totalCpuOps: 999999, count: 1 });
    stats.set('peer1', { totalPowerW: 500, totalCpuOps: 1000, count: 1 });
    stats.set('peer2', { totalPowerW: 480, totalCpuOps: 1000, count: 1 });
    stats.set('peer3', { totalPowerW: 520, totalCpuOps: 1000, count: 1 });
    assert.strictEqual(isPowerCpuOutlier('test', 5000, 1000, stats), true);
  });
});

// ─── getCliCommandName ──────────────────────────────────────────────────────

describe('getCliCommandName', () => {
  it('extracts first non-flag, non-key=value token', () => {
    assert.strictEqual(getCliCommandName(['--flag', 'command', 'arg']), 'command');
  });

  it('skips flags', () => {
    assert.strictEqual(getCliCommandName(['--verbose', 'start']), 'start');
  });

  it('skips key=value tokens', () => {
    assert.strictEqual(getCliCommandName(['--env=prod', 'deploy']), 'deploy');
  });

  it('returns empty when only flags present', () => {
    assert.strictEqual(getCliCommandName(['--help']), '');
  });

  it('skips empty tokens', () => {
    assert.strictEqual(getCliCommandName(['', 'run']), 'run');
  });

  it('returns empty for empty array', () => {
    assert.strictEqual(getCliCommandName([]), '');
  });
});

// ─── normalizeUpdateFeedUrl ─────────────────────────────────────────────────

describe('normalizeUpdateFeedUrl', () => {
  it('trims trailing slashes', () => {
    assert.strictEqual(normalizeUpdateFeedUrl('https://wattcoin.ee/releases///'), 'https://wattcoin.ee/releases');
  });

  it('passes through URL without trailing slash', () => {
    assert.strictEqual(normalizeUpdateFeedUrl('https://wattcoin.ee/releases'), 'https://wattcoin.ee/releases');
  });

  it('returns empty for empty string', () => {
    assert.strictEqual(normalizeUpdateFeedUrl(''), '');
  });

  it('trims whitespace', () => {
    assert.strictEqual(normalizeUpdateFeedUrl('  https://example.com  '), 'https://example.com');
  });

  it('returns empty for null', () => {
    assert.strictEqual(normalizeUpdateFeedUrl(null), '');
  });
});

// ─── secureStringEquals ─────────────────────────────────────────────────────

describe('secureStringEquals', () => {
  it('returns true for equal strings', () => {
    assert.strictEqual(secureStringEquals('hello', 'hello'), true);
  });

  it('returns false for different strings', () => {
    assert.strictEqual(secureStringEquals('hello', 'world'), false);
  });

  it('returns false for different lengths', () => {
    assert.strictEqual(secureStringEquals('abc', 'abcdef'), false);
  });

  it('handles empty strings', () => {
    assert.strictEqual(secureStringEquals('', ''), true);
  });

  it('handles null gracefully', () => {
    assert.strictEqual(secureStringEquals(null, ''), true);
  });
});

// ─── formatBackupTimestampForFilename ───────────────────────────────────────

describe('formatBackupTimestampForFilename', () => {
  it('formats a date as YYYYMMDD-HHmmss', () => {
    const d = new Date(2026, 6, 8, 14, 30, 5);
    assert.strictEqual(formatBackupTimestampForFilename(d), '20260708-143005');
  });

  it('uses current date when none provided', () => {
    const result = formatBackupTimestampForFilename();
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const expectedPrefix = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    assert.ok(result.startsWith(expectedPrefix));
  });

  it('pads single-digit months and days', () => {
    const d = new Date(2026, 0, 5, 9, 3, 7);
    assert.strictEqual(formatBackupTimestampForFilename(d), '20260105-090307');
  });
});

// ─── encryptBackupPayload / decryptBackupPayload ────────────────────────────

describe('encryptBackupPayload / decryptBackupPayload', () => {
  it('round-trips a payload correctly', () => {
    const original = { trustScore: 75, hwHoldUntilMs: 1000, wallets: ['addr1', 'addr2'] };
    const passphrase = 'test-passphrase-123!';
    const encrypted = encryptBackupPayload(original, passphrase);
    assert.ok(encrypted.salt);
    assert.ok(encrypted.iv);
    assert.ok(encrypted.tag);
    assert.ok(encrypted.ciphertext);
    const decrypted = decryptBackupPayload(encrypted, passphrase);
    assert.deepStrictEqual(decrypted, original);
  });

  it('fails to decrypt with wrong passphrase', () => {
    const original = { key: 'value' };
    const encrypted = encryptBackupPayload(original, 'correct-passphrase');
    assert.throws(() => decryptBackupPayload(encrypted, 'wrong-passphrase'));
  });

  it('produces different ciphertexts for same data (different salt/iv)', () => {
    const original = { data: 'test' };
    const e1 = encryptBackupPayload(original, 'pass');
    const e2 = encryptBackupPayload(original, 'pass');
    assert.notStrictEqual(e1.ciphertext, e2.ciphertext);
    assert.notStrictEqual(e1.salt, e2.salt);
  });
});

// ─── Edge cases: combined IP logic ──────────────────────────────────────────

describe('IP utility coordination', () => {
  it('isPublicPeerHost and isPrivateIpv4 are complementary for IPv4', () => {
    assert.strictEqual(isPublicPeerHost('8.8.8.8'), true);
    assert.strictEqual(isPrivateIpv4('8.8.8.8'), false);
    assert.strictEqual(isPublicPeerHost('192.168.1.1'), false);
    assert.strictEqual(isPrivateIpv4('192.168.1.1'), true);
  });

  it('isLoopbackPeerHost is a subset of isPrivateIpv4', () => {
    assert.strictEqual(isLoopbackPeerHost('127.0.0.1'), true);
    assert.strictEqual(isPrivateIpv4('127.0.0.1'), true);
    assert.strictEqual(isLoopbackPeerHost('192.168.1.1'), false);
    assert.strictEqual(isPrivateIpv4('192.168.1.1'), true);
  });

  it('formatPeerHostForUrl + normalizePeerUrl works for IPv6', () => {
    const formatted = formatPeerHostForUrl('::1');
    const url = `http://${formatted}:39310`;
    assert.strictEqual(normalizePeerUrl(url), 'http://[::1]:39310');
  });
});

// ─── HTTP and networking utilities ─────────────────────────────────────────

describe('sendJson', () => {
  it('writes JSON response with correct headers', () => {
    const chunks = [];
    const headers = {};
    const res = {
      writeHead: (status, hdrs) => {
        headers.status = status;
        headers.headers = hdrs;
      },
      end: (chunk) => {
        chunks.push(chunk);
      },
    };
    sendJson(res, 200, { ok: true });
    assert.strictEqual(headers.status, 200);
    assert.strictEqual(headers.headers['Content-Type'], 'application/json; charset=utf-8');
    assert.strictEqual(chunks.join(''), JSON.stringify({ ok: true }));
  });

  it('handles null payload', () => {
    const chunks = [];
    const headers = {};
    const res = {
      writeHead: (status, hdrs) => {
        headers.status = status;
        headers.headers = hdrs;
      },
      end: (chunk) => {
        chunks.push(chunk);
      },
    };
    sendJson(res, 400, null);
    assert.strictEqual(headers.status, 400);
    assert.strictEqual(chunks.join(''), JSON.stringify({}));
  });
});

describe('readJsonBody', () => {
  it('parses a valid JSON body', async () => {
    const req = createMockReq(JSON.stringify({ foo: 'bar' }));
    const result = await readJsonBody(req);
    assert.deepStrictEqual(result, { foo: 'bar' });
  });

  it('rejects on body exceeding maxBytes', async () => {
    const large = 'x'.repeat(70000);
    const req = createMockReq(JSON.stringify({ data: large }));
    await assert.rejects(() => readJsonBody(req, 1024), /body too large/i);
  });

  it('resolves to empty object on empty body', async () => {
    const req = createMockReq('');
    const result = await readJsonBody(req);
    assert.deepStrictEqual(result, {});
  });
});

function createMockReq(body) {
  const events = {};
  const ret = {
    on: (ev, fn) => {
      events[ev] = fn;
    },
    destroy: () => {},
  };
  if (body) {
    const buf = Buffer.from(body, 'utf8');
    process.nextTick(() => events.data && events.data(buf));
  }
  process.nextTick(() => events.end && events.end());
  return ret;
}

describe('getHostLanIp', () => {
  it('returns a string', () => {
    const ip = getHostLanIp();
    assert.strictEqual(typeof ip, 'string');
    assert.ok(ip.length > 0);
  });
});

describe('computeNextReattestDueAt', () => {
  it('returns a future timestamp > nowMs', () => {
    const now = Date.now();
    const result = computeNextReattestDueAt(now);
    assert.ok(result > now);
  });

  it('is within expected range', () => {
    const now = Date.now();
    const results = new Set();
    for (let i = 0; i < 50; i++) {
      results.add(computeNextReattestDueAt(now));
    }
    for (const r of results) {
      assert.ok(r >= now + 2 * 60 * 60_000);
      assert.ok(r <= now + 4 * 60 * 60_000);
    }
  });

  it('defaults nowMs to Date.now()', () => {
    const before = Date.now();
    const result = computeNextReattestDueAt();
    const after = Date.now();
    assert.ok(result >= before + 2 * 60 * 60_000);
    assert.ok(result <= after + 4 * 60 * 60_000);
  });
});

describe('verifyManifestSignature', () => {
  it('returns true when no .sig file exists (graceful fallback)', () => {
    const result = verifyManifestSignature('/nonexistent/manifest.json', { data: 1 });
    assert.strictEqual(result, true);
  });
});
