'use strict';

const assert = require('assert');

const { filterAdvertisedPeerUrls, resolvePeerPrivacySecret } = require('../peer-privacy');

function testKeepsDirectIpUrlsWhenTheyAreAllWeHave() {
  const urls = filterAdvertisedPeerUrls(['http://198.51.100.24:39310', 'http://192.168.1.44:39310']);

  assert.deepStrictEqual(urls, ['http://198.51.100.24:39310', 'http://192.168.1.44:39310']);
}

function testDropsRawIpUrlsWhenTunnelOrDomainEndpointExists() {
  const urls = filterAdvertisedPeerUrls([
    'https://relay.wattcoin.ee/api/v1/tunnel/node-123',
    'http://198.51.100.24:39310',
    'http://192.168.1.44:39310',
  ]);

  assert.deepStrictEqual(urls, ['https://relay.wattcoin.ee/api/v1/tunnel/node-123']);
}

function testResolvePeerPrivacySecretPrefersPersistedInstallSecret() {
  const secret = resolvePeerPrivacySecret('install-secret-123', 'device-id-456');
  assert.strictEqual(secret, 'install-secret-123');
}

function testResolvePeerPrivacySecretFallsBackToDeviceId() {
  const secret = resolvePeerPrivacySecret('', 'device-id-456');
  assert.strictEqual(secret, 'device-id-456');
}

function run() {
  testKeepsDirectIpUrlsWhenTheyAreAllWeHave();
  testDropsRawIpUrlsWhenTunnelOrDomainEndpointExists();
  testResolvePeerPrivacySecretPrefersPersistedInstallSecret();
  testResolvePeerPrivacySecretFallsBackToDeviceId();
  console.log('peer privacy tests passed');
}

run();
