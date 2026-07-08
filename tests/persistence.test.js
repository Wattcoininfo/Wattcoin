'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { expect } = require('chai');

const { createPersistence } = require('../electron-main/persistence');

describe('persistence', function () {
  let tmpDir;
  let persistence;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persistence-test-'));
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGetters(opts = {}) {
    const {
      getRateLockFilePath = () => path.join(tmpDir, 'rate-locks.json'),
      getPolicyAnchorCacheFilePath = () => path.join(tmpDir, 'policy-anchor.json'),
      getAttestationProfileCacheFilePath = () => path.join(tmpDir, 'profiles.json'),
      getDiscoveredSeedPeerCachePath = () => path.join(tmpDir, 'seed-cache.json'),
      getTeamFilePath = () => path.join(tmpDir, 'team.json'),
      getDocsFilePath = () => path.join(tmpDir, 'docs.json'),
      getDeviceIdentityFilePath = () => path.join(tmpDir, 'device-identity.json'),
      rememberedDiscoveredPeers = new Map(),
      rememberDiscoveredPeer = () => true,
      PEER_STALE_THRESHOLD_MS = 15 * 60_000,
      app = { isReady: () => true },
    } = opts;

    return {
      getRateLockFilePath,
      getPolicyAnchorCacheFilePath,
      getAttestationProfileCacheFilePath,
      getDiscoveredSeedPeerCachePath,
      getTeamFilePath,
      getDocsFilePath,
      getDeviceIdentityFilePath,
      rememberedDiscoveredPeers,
      rememberDiscoveredPeer,
      PEER_STALE_THRESHOLD_MS,
      app,
    };
  }

  beforeEach(function () {
    persistence = createPersistence(makeGetters());
  });

  describe('loadRateLocks / saveRateLock', function () {
    it('loads and saves rate locks', function () {
      const state = new Map();
      persistence.saveRateLock('test-key', Date.now() + 60_000);
      persistence.loadRateLocks(state);
      expect(state.has('test-key')).to.equal(true);
      expect(state.get('test-key').lockedUntil).to.be.greaterThan(Date.now());
    });

    it('ignores expired locks', function () {
      const state = new Map();
      persistence.saveRateLock('expired', Date.now() - 1000);
      persistence.loadRateLocks(state);
      expect(state.has('expired')).to.equal(false);
    });
  });

  describe('loadPolicyAnchorState / savePolicyAnchorState', function () {
    it('returns null when no file exists', function () {
      expect(persistence.loadPolicyAnchorState()).to.equal(null);
    });

    it('round-trips state', function () {
      const state = { latestAnchor: { hash: 'abc', blockHeight: 100 }, lastScannedHeight: 200, scannedAtMs: 300 };
      persistence.savePolicyAnchorState(state);
      const loaded = persistence.loadPolicyAnchorState();
      expect(loaded.latestAnchor.hash).to.equal('abc');
      expect(loaded.lastScannedHeight).to.equal(200);
      expect(loaded.scannedAtMs).to.equal(300);
    });
  });

  describe('loadCachedRemoteProfiles / saveRemoteProfilesToCache', function () {
    it('returns null when no cache', function () {
      expect(persistence.loadCachedRemoteProfiles()).to.equal(null);
    });

    it('round-trips profiles', function () {
      const feed = {
        rawProfiles: [
          {
            id: 'profile-1',
            conservativeCapW: 100,
            maxCapW: 200,
            stepW: 10,
            minCpuOpsPerSec: 100_000,
            minMemoryMBps: 400,
          },
        ],
        fetchedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        version: 1,
      };
      persistence.saveRemoteProfilesToCache(feed);
      const loaded = persistence.loadCachedRemoteProfiles();
      expect(loaded).to.not.equal(null);
      expect(loaded.profiles.length).to.equal(1);
      expect(loaded.profiles[0].id).to.equal('profile-1');
      expect(loaded.source).to.equal('cache');
    });
  });

  describe('readTeamData / writeTeamData', function () {
    it('returns empty array when no file', function () {
      expect(persistence.readTeamData()).to.deep.equal([]);
    });

    it('round-trips data', function () {
      const data = [{ id: '1', name: 'Alice' }];
      persistence.writeTeamData(data);
      expect(persistence.readTeamData()).to.deep.equal(data);
    });
  });

  describe('readDocsData / writeDocsData', function () {
    it('returns empty array when no file', function () {
      expect(persistence.readDocsData()).to.deep.equal([]);
    });

    it('round-trips data', function () {
      const data = [{ id: 'd1', title: 'Doc' }];
      persistence.writeDocsData(data);
      expect(persistence.readDocsData()).to.deep.equal(data);
    });
  });

  describe('device identity', function () {
    it('getDeviceIdentitySecret returns empty when no file', function () {
      expect(persistence.getDeviceIdentitySecret()).to.equal('');
    });

    it('loadOrCreateDeviceIdentity creates a new identity', function () {
      const result = persistence.loadOrCreateDeviceIdentity();
      expect(result.deviceId).to.be.a('string').with.length.of.at.least(1);
      expect(result.secret).to.be.a('string').with.length.of.at.least(32);
      expect(result.isNew).to.equal(true);
    });

    it('loadOrCreateDeviceIdentity returns cached identity on second call', function () {
      const first = persistence.loadOrCreateDeviceIdentity();
      const second = persistence.loadOrCreateDeviceIdentity();
      expect(second.deviceId).to.equal(first.deviceId);
    });
  });

  describe('exports', function () {
    const expected = [
      'loadRateLocks',
      'saveRateLock',
      'loadPolicyAnchorState',
      'savePolicyAnchorState',
      'loadCachedRemoteProfiles',
      'saveRemoteProfilesToCache',
      'loadDiscoveredSeedPeerCache',
      'scheduleDiscoveredSeedPeerCacheSave',
      'readTeamData',
      'writeTeamData',
      'readDocsData',
      'writeDocsData',
      'getDeviceIdentitySecret',
      'loadOrCreateDeviceIdentity',
    ];
    for (const name of expected) {
      it(`exports ${name}`, function () {
        expect(persistence).to.have.property(name).that.is.a('function');
      });
    }
  });
});
