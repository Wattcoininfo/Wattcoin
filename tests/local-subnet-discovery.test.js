const assert = require('assert');

const {
  getLocalSubnetProbeCandidates,
  isPrivateIpv4,
  selectDiscoveryPeerUrl,
  selectPreferredPeerUrl,
  sortPeerUrlsByPreference,
} = require('../local-subnet-discovery');

function testPrivateIpv4Detection() {
  assert.strictEqual(isPrivateIpv4('192.168.1.10'), true);
  assert.strictEqual(isPrivateIpv4('10.0.0.5'), true);
  assert.strictEqual(isPrivateIpv4('172.16.8.9'), true);
  assert.strictEqual(isPrivateIpv4('172.32.0.1'), false);
  assert.strictEqual(isPrivateIpv4('8.8.8.8'), false);
}

function testCandidatesExcludeSelfAndClampWideMasksToSlash24() {
  const candidates = getLocalSubnetProbeCandidates(
    [{ address: '192.168.50.23', netmask: '255.255.0.0', internal: false }],
    {
      selfHosts: ['192.168.50.23'],
    },
  );

  assert.ok(candidates.includes('192.168.50.1'));
  assert.ok(candidates.includes('192.168.50.254'));
  assert.ok(!candidates.includes('192.168.50.23'));
  assert.ok(!candidates.includes('192.168.49.1'));
  assert.strictEqual(candidates.length, 253);
}

function testCandidatesIgnorePublicAndInternalInterfaces() {
  const candidates = getLocalSubnetProbeCandidates(
    [
      { address: '8.8.8.8', netmask: '255.255.255.0', internal: false },
      { address: '192.168.1.15', netmask: '255.255.255.0', internal: true },
    ],
    {
      selfHosts: ['192.168.1.15'],
    },
  );

  assert.deepStrictEqual(candidates, []);
}

function testPreferredPeerUrlChoosesPrivateDirectOverPublic() {
  const preferred = selectPreferredPeerUrl('http://91.95.4.111:39310', 'http://192.168.1.44:39310');
  assert.strictEqual(preferred, 'http://192.168.1.44:39310');
}

function testPeerUrlSortingPrefersDirectBeforeTunnel() {
  const sorted = sortPeerUrlsByPreference([
    'http://62.65.200.145:39310/api/v1/tunnel/abc',
    'http://91.95.4.111:39310',
    'http://192.168.1.44:39310',
  ]);
  assert.deepStrictEqual(sorted, [
    'http://192.168.1.44:39310',
    'http://91.95.4.111:39310',
    'http://62.65.200.145:39310/api/v1/tunnel/abc',
  ]);
}

function testDiscoveryPeerUrlPrefersDirectLanSocketOverAdvertisedPublicUrl() {
  const selected = selectDiscoveryPeerUrl(['http://91.95.4.111:39310', 'http://192.168.1.44:39310']);
  assert.strictEqual(selected, 'http://192.168.1.44:39310');
}

function testDiscoveryPeerUrlPrefersDirectLanSocketOverAdvertisedTunnelUrl() {
  const selected = selectDiscoveryPeerUrl([
    'http://62.65.200.145:39310/api/v1/tunnel/abc',
    'http://192.168.1.44:39310',
  ]);
  assert.strictEqual(selected, 'http://192.168.1.44:39310');
}

function run() {
  testPrivateIpv4Detection();
  testCandidatesExcludeSelfAndClampWideMasksToSlash24();
  testCandidatesIgnorePublicAndInternalInterfaces();
  testPreferredPeerUrlChoosesPrivateDirectOverPublic();
  testPeerUrlSortingPrefersDirectBeforeTunnel();
  testDiscoveryPeerUrlPrefersDirectLanSocketOverAdvertisedPublicUrl();
  testDiscoveryPeerUrlPrefersDirectLanSocketOverAdvertisedTunnelUrl();
  console.log('local subnet discovery tests passed');
}

run();
