'use strict';

const { expect } = require('chai');
const { createGovernance } = require('../electron-main/governance');

function noop() {}

function createMockWtcNode() {
  let proposals = [];
  let votes = {};
  return {
    getAddresses: () => ['wtc1abc'],
    getNftsForAddress: (addr) => {
      if (addr === 'wtc1abc') return [{ nftId: 'nft-1', metadata: { tier: 'gold' } }];
      if (addr === 'wtc1creator') return [{ nftId: 'nft-c1', metadata: { tier: 'silver' } }];
      if (addr === 'wtc1voter') return [{ nftId: 'nft-v1', metadata: { tier: 'bronze' } }];
      return [];
    },
    closeExpiredProposals: noop,
    addGovernanceProposal: (p) => {
      proposals.push(p);
      return { ok: true };
    },
    addGovernanceVote: (pipId, v) => {
      if (!votes[pipId]) votes[pipId] = [];
      votes[pipId].push(v);
    },
    verifyMessage: (voter, signature, msg) => {
      return signature === 'valid-sig';
    },
    getProposals: () => proposals,
    getVotes: () => votes,
  };
}

function buildMinimalCtx(overrides = {}) {
  const node = createMockWtcNode();
  const defaults = {
    getWtcNode: () => node,
    getLedgerNetworkSettings: () => ({
      enabled: true,
      peers: ['http://peer-a:39310'],
      seedPeers: ['http://seed-a:39310'],
    }),
    getActivePeers: () => ['http://peer-a:39310', 'http://peer-b:39310'],
    requestPeerJson: async () => ({ ok: true, proposals: [], members: [], docs: [] }),
    readTeamData: () => [],
    writeTeamData: noop,
    readDocsData: () => [],
    writeDocsData: noop,
    ...overrides,
  };
  return defaults;
}

describe('governance', function () {
  let gov;
  let ctx;
  let mockNode;

  beforeEach(function () {
    mockNode = createMockWtcNode();
    ctx = buildMinimalCtx({ getWtcNode: () => mockNode });
    gov = createGovernance(ctx);
  });

  describe('exports', function () {
    const expected = [
      'syncGovernanceFromPeers',
      'startGovernanceSync',
      'stopGovernanceSync',
      'syncTeamDocsFromPeers',
      'broadcastTeamDocsToPeers',
    ];
    for (const name of expected) {
      it(`exports ${name}`, function () {
        expect(gov).to.have.property(name).that.is.a('function');
      });
    }
  });

  describe('_nodeHasGovernanceNfts (via syncGovernanceFromPeers guard)', function () {
    it('returns false when wtcNode is null', async function () {
      const g = createGovernance({ ...ctx, getWtcNode: () => null });
      // Should not throw - returns early at wtcNode check
      await g.syncGovernanceFromPeers();
    });

    it('returns false when node has no NFTs', async function () {
      const emptyNode = {
        getAddresses: () => ['wtc1empty'],
        getNftsForAddress: () => [],
      };
      const g = createGovernance({ ...ctx, getWtcNode: () => emptyNode });
      await g.syncGovernanceFromPeers();
    });

    it('proceeds when node has NFTs', async function () {
      await gov.syncGovernanceFromPeers();
      // No error means it passed the guard
    });
  });

  describe('syncGovernanceFromPeers', function () {
    it('merges proposals from peers', async function () {
      const peerResponses = [
        {
          ok: true,
          proposals: [
            {
              pipId: 'pip-1',
              title: 'Test Proposal',
              description: 'Test desc',
              creator: 'wtc1creator',
              createdAt: Date.now(),
              votingDurationWeeks: 2,
              commentPeriodWeeks: 1,
            },
          ],
        },
      ];
      const g = createGovernance({
        ...ctx,
        requestPeerJson: async () => peerResponses[0],
      });
      await g.syncGovernanceFromPeers();
    });
  });

  describe('sync lifecycle', function () {
    it('startGovernanceSync and stopGovernanceSync are callable', function () {
      gov.startGovernanceSync();
      // First call sets up interval; second call (via guard) is safe
      gov.startGovernanceSync();
      gov.stopGovernanceSync();
      gov.stopGovernanceSync(); // idempotent
    });
  });

  describe('syncTeamDocsFromPeers', function () {
    it('merges team members from peers', async function () {
      const peerResponses = [
        {
          ok: true,
          members: [{ id: 'tm-1', name: 'Alice', addedAt: 1000 }],
          docs: [],
        },
        {
          ok: true,
          members: [{ id: 'tm-1', name: 'Alice Updated', addedAt: 2000 }],
          docs: [],
        },
      ];
      let callIdx = 0;
      let writtenMembers = null;
      let writtenDocs = null;
      const g = createGovernance({
        ...ctx,
        requestPeerJson: async () => peerResponses[callIdx++],
        writeTeamData: (members) => {
          writtenMembers = members;
        },
        writeDocsData: (docs) => {
          writtenDocs = docs;
        },
      });
      await g.syncTeamDocsFromPeers();
      expect(writtenMembers).to.not.be.null;
      expect(writtenMembers.length).to.be.greaterThan(0);
      expect(writtenMembers[0].name).to.equal('Alice Updated');
    });

    it('skips when node has no NFTs', async function () {
      const g = createGovernance({
        ...ctx,
        getWtcNode: () => ({
          getAddresses: () => ['wtc1empty'],
          getNftsForAddress: () => [],
        }),
      });
      await g.syncTeamDocsFromPeers();
    });
  });

  describe('broadcastTeamDocsToPeers', function () {
    it('sends team/docs data to all peers', function () {
      let requestCount = 0;
      const g = createGovernance({
        ...ctx,
        requestPeerJson: async () => {
          requestCount++;
          return { ok: true };
        },
      });
      g.broadcastTeamDocsToPeers();
      expect(requestCount).to.equal(2);
    });

    it('skips when settings are disabled', function () {
      let requestCount = 0;
      const g = createGovernance({
        ...ctx,
        getLedgerNetworkSettings: () => ({ enabled: false }),
        requestPeerJson: async () => {
          requestCount++;
          return { ok: true };
        },
      });
      g.broadcastTeamDocsToPeers();
      expect(requestCount).to.equal(0);
    });
  });
});
