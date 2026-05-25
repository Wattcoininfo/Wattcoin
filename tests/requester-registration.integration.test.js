'use strict';

const assert = require('assert');

const { maybeRegisterReachableRequester } = require('../requester-registration');

async function testDirectPublicPeerUsesExplicitAnnouncement() {
  const calls = [];
  const req = {
    headers: {
      'x-wtc-peer-urls': 'http://198.51.100.24:39310',
    },
    socket: {
      remoteAddress: '198.51.100.24',
    },
  };

  const result = await maybeRegisterReachableRequester(req, {}, 'peer-directory', {
    isReverseTunnelForwardedRequest: () => false,
    rememberObservedRequester: () => false,
    extractReachablePeerCandidates: () => ['http://198.51.100.24:39310'],
    isPublicPeerHost: (host) => host === '198.51.100.24',
    verifyReachablePeerCandidate: async (candidate, source) => {
      calls.push({ candidate, source });
      return { ok: true, source, candidate };
    },
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    calls,
    [{ candidate: 'http://198.51.100.24:39310', source: 'peer-directory' }],
    'explicit public peer announcement should be verified',
  );
}

async function testNatedPeerWithoutExplicitPublicUrlUsesSocketCandidate() {
  const calls = [];
  const req = {
    headers: {
      'x-wtc-peer-urls': '',
    },
    socket: {
      remoteAddress: '192.168.1.44',
    },
  };

  const result = await maybeRegisterReachableRequester(req, {}, 'peer-contact', {
    isReverseTunnelForwardedRequest: () => false,
    rememberObservedRequester: () => false,
    extractReachablePeerCandidates: () => ['http://192.168.1.44:39310'],
    isPublicPeerHost: () => false,
    verifyReachablePeerCandidate: async (candidate, source) => {
      calls.push({ candidate, source });
      return { ok: true, source, candidate };
    },
  });

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(
    calls,
    [{ candidate: 'http://192.168.1.44:39310', source: 'peer-contact' }],
    'NATed peer should still be probed via inferred socket candidate',
  );
}

async function testReverseTunnelForwardedRequesterSkipsReachabilityProbe() {
  const remembered = [];
  let verifyCalls = 0;
  const req = {
    headers: {
      'x-wtc-via-tunnel': '1',
      'x-wtc-peer-identity': 'a'.repeat(64),
    },
    socket: {
      remoteAddress: '127.0.0.1',
    },
  };

  const result = await maybeRegisterReachableRequester(req, {}, 'peer-directory', {
    isReverseTunnelForwardedRequest: () => true,
    rememberObservedRequester: (_req, _settings, source) => {
      remembered.push(source);
      return true;
    },
    extractReachablePeerCandidates: () => [],
    isPublicPeerHost: () => false,
    verifyReachablePeerCandidate: async () => {
      verifyCalls += 1;
      return { ok: false };
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(
    result.skippedReachability,
    true,
    'reverse-tunnel forwarded requests should skip callback probing',
  );
  assert.deepStrictEqual(remembered, ['peer-directory-tunnel']);
  assert.strictEqual(verifyCalls, 0, 'reverse-tunnel forwarded requests should not issue reachability probes');
}

async function run() {
  await testDirectPublicPeerUsesExplicitAnnouncement();
  await testNatedPeerWithoutExplicitPublicUrlUsesSocketCandidate();
  await testReverseTunnelForwardedRequesterSkipsReachabilityProbe();
  console.log('requester registration integration tests passed');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
