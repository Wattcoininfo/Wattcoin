import { useState, useEffect, useCallback } from 'react';

const VOTE_WEIGHTS = { gold: 5, silver: 3, bronze: 1 };
const TIER_RANK = { gold: 3, silver: 2, bronze: 1 };

const containerStyle = {
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  background: '#060e06',
  color: '#e8f5e8',
  fontFamily: 'system-ui, sans-serif',
};

const headerStyle = {
  padding: '20px 24px 12px',
  borderBottom: '1px solid #1e3a1e',
};

const headerTitleStyle = {
  fontSize: 22,
  fontWeight: 700,
  color: '#4ade80',
  letterSpacing: '0.06em',
};

const headerSubStyle = {
  fontSize: 13,
  color: '#7aaa7a',
  marginTop: 4,
};

const scrollStyle = {
  flex: 1,
  overflowY: 'auto',
  padding: '16px 24px 24px',
};

const noNftContainerStyle = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  padding: 40,
  textAlign: 'center',
};

const noNftIconStyle = {
  fontSize: 48,
  marginBottom: 16,
  opacity: 0.6,
};

const noNftTitleStyle = {
  fontSize: 20,
  fontWeight: 700,
  color: '#4ade80',
  marginBottom: 8,
};

const noNftTextStyle = {
  fontSize: 14,
  color: '#7aaa7a',
  maxWidth: 440,
  lineHeight: 1.6,
};

const cardStyle = {
  background: '#0d1a0d',
  border: '1px solid #1e3a1e',
  borderRadius: 12,
  padding: 16,
  marginBottom: 14,
};

const cardTitleStyle = {
  fontSize: 15,
  fontWeight: 700,
  color: '#d7ffd9',
  marginBottom: 4,
};

const cardMetaStyle = {
  fontSize: 12,
  color: '#6b8f6b',
  marginBottom: 8,
};

const badgeStyle = (tier) => {
  const colors = { gold: '#fbbf24', silver: '#9ca3af', bronze: '#d97706' };
  return {
    display: 'inline-block',
    fontSize: 11,
    fontWeight: 700,
    color: colors[tier] || '#9ca3af',
    background: `${colors[tier] || '#9ca3af'}22`,
    borderRadius: 6,
    padding: '2px 7px',
    marginLeft: 6,
  };
};

const contentInnerStyle = {
  maxWidth: 760,
  margin: '0 auto',
};

const sectionDividerStyle = {
  height: 1,
  background: '#1e3a1e',
  margin: '22px 0',
};

function getHighestTier(nfts) {
  let best = null;
  for (const nft of nfts) {
    const tier = (nft.metadata && nft.metadata.tier) || 'bronze';
    const rank = TIER_RANK[tier] || 0;
    if (!best || rank > best.rank) {
      best = { tier, rank, weight: VOTE_WEIGHTS[tier] || 1 };
    }
  }
  return best;
}

function pipDisplayId(pipId) {
  if (!pipId) return 'PIP-?';
  const parts = pipId.split('-');
  if (parts.length >= 3) {
    return `PIP-${parts[1]}`;
  }
  return pipId;
}

function getRemainingTime(endAt) {
  if (!endAt) return '';
  const remaining = endAt - Date.now();
  if (remaining <= 0) return '';
  const days = Math.floor(remaining / 86400000);
  const hours = Math.floor((remaining % 86400000) / 3600000);
  if (days > 0) return `${days}d ${hours}h remaining`;
  return `${hours}h remaining`;
}

export default function Governance({ selectedWalletAddress }) {
  const [nfts, setNfts] = useState([]);
  const [nftsLoaded, setNftsLoaded] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [proposalsLoaded, setProposalsLoaded] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createTitle, setCreateTitle] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createCommentPeriod, setCreateCommentPeriod] = useState(2);
  const [createDuration, setCreateDuration] = useState(2);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState('info');
  const [govStatus, setGovStatus] = useState({
    distributedPower: 0,
    passThreshold: 0,
    totalPossible: 140,
    governanceWallet: { confirmed: 0, pending: 0, address: 'wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw' },
  });
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferPurpose, setTransferPurpose] = useState('');
  const [useReserveOverride, setUseReserveOverride] = useState(false);
  const [govSubTab, setGovSubTab] = useState('proposals');

  const highestTier = getHighestTier(nfts);
  const hasNft = nfts.length > 0;
  const votingPower = highestTier ? highestTier.weight : 0;
  const votingTier = highestTier ? highestTier.tier : null;

  useEffect(() => {
    if (!selectedWalletAddress || !window.wattcoinHardware?.invoke) {
      setNftsLoaded(true);
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-nft-list', selectedWalletAddress)
      .then((res) => {
        if (res && res.ok) setNfts(res.nfts || []);
      })
      .catch(() => {})
      .finally(() => setNftsLoaded(true));
  }, [selectedWalletAddress]);

  const loadProposals = useCallback(() => {
    if (!window.wattcoinHardware?.invoke) return;
    window.wattcoinHardware
      .invoke('wattcoin-governance-list')
      .then((res) => {
        if (res && res.ok) setProposals(res.proposals || []);
      })
      .catch(() => {})
      .finally(() => setProposalsLoaded(true));
    window.wattcoinHardware
      .invoke('wattcoin-governance-status')
      .then((res) => {
        if (res && res.ok) setGovStatus(res);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadProposals();
    if (window.wattcoinHardware?.invoke) {
      window.wattcoinHardware
        .invoke('wattcoin-governance-status')
        .then((res) => {
          if (res && res.ok) setGovStatus(res);
        })
        .catch(() => {});
    }
    const iv = setInterval(loadProposals, 10000);
    return () => clearInterval(iv);
  }, [loadProposals]);

  const handleCreateProposal = useCallback(() => {
    const title = createTitle.trim();
    const desc = createDesc.trim();
    if (!title) {
      setStatusType('error');
      setStatusMsg('Please enter a proposal title.');
      return;
    }

    const proposal = {
      title,
      description: desc,
      commentPeriodWeeks: createCommentPeriod,
      votingDurationWeeks: createDuration,
    };

    // Include governance transfer fields if filled
    const transferAddr = transferTo.trim();
    const transferAmt = parseFloat(transferAmount);
    if (transferAddr && transferAmt > 0) {
      proposal.transferTo = transferAddr;
      proposal.transferAmount = transferAmt;
      proposal.transferPurpose = transferPurpose.trim();
      if (useReserveOverride) {
        proposal.useReserveOverride = true;
      }
    }

    window.wattcoinHardware
      .invoke('wattcoin-governance-propose', proposal)
      .then((res) => {
        if (res && res.ok) {
          setCreateTitle('');
          setCreateDesc('');
          setTransferTo('');
          setTransferAmount('');
          setTransferPurpose('');
          setUseReserveOverride(false);
          setShowTransferForm(false);
          setShowCreate(false);
          setStatusType('info');
          setStatusMsg(`Proposal submitted as ${pipDisplayId(res.pipId)}.`);
          loadProposals();
          setTimeout(() => setStatusMsg(''), 4000);
        } else {
          const errMsg = (res && res.error) || 'unknown error';
          if (res && res.violations && res.violations.length > 0) {
            setStatusType('error');
            setStatusMsg(
              `Proposal rejected: violates immutable principles — ${res.violations.map((v) => v.label).join(', ')}`,
            );
          } else {
            setStatusType('error');
            setStatusMsg(`Failed: ${errMsg}`);
          }
        }
      })
      .catch((e) => {
        setStatusType('error');
        setStatusMsg(`Error: ${e && e.message}`);
      });
  }, [
    createTitle,
    createDesc,
    createCommentPeriod,
    createDuration,
    loadProposals,
    transferTo,
    transferAmount,
    transferPurpose,
    useReserveOverride,
  ]);

  const handleVote = useCallback(
    (pipId, vote) => {
      if (!selectedWalletAddress) return;
      const highest = getHighestTier(nfts);
      const voteData = {
        voter: selectedWalletAddress,
        power: highest ? highest.weight : 0,
        nftTier: highest ? highest.tier : 'bronze',
        vote,
      };
      window.wattcoinHardware
        .invoke('wattcoin-governance-vote', pipId, voteData)
        .then((res) => {
          if (res && res.ok) {
            loadProposals();
            if (res.quorum && res.quorum.reached) {
              setStatusType('info');
              setStatusMsg(
                `Pass threshold reached (${govStatus.passThreshold}/${govStatus.distributedPower} votes)! Proposal ${res.quorum.outcome}. Transaction submitted.`,
              );
              setTimeout(() => setStatusMsg(''), 6000);
            }
          } else {
            setStatusType('error');
            setStatusMsg(`Vote failed: ${(res && res.error) || 'unknown error'}`);
          }
        })
        .catch((e) => {
          setStatusType('error');
          setStatusMsg(`Error: ${e && e.message}`);
        });
    },
    [selectedWalletAddress, nfts, loadProposals, govStatus],
  );

  if (!nftsLoaded || !proposalsLoaded) {
    return (
      <div style={{ ...containerStyle, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ fontSize: 14, color: '#7aaa7a' }}>Loading...</div>
      </div>
    );
  }

  if (!hasNft) {
    return (
      <div style={containerStyle}>
        <div style={noNftContainerStyle}>
          <div style={noNftIconStyle}>🗳️</div>
          <div style={noNftTitleStyle}>Governance</div>
          <div style={noNftTextStyle}>
            Acquiring a Vortex NFT grants you access to on-chain governance. No Vortex NFTs were detected in your
            wallet. Acquire a Vortex NFT from the NFT tab to submit proposals and vote on protocol changes.
          </div>
        </div>
      </div>
    );
  }

  const commentProposals = proposals.filter((p) => p.status === 'in_comment');
  const activeProposals = proposals.filter((p) => p.status === 'active');
  const pastProposals = proposals.filter((p) => p.status !== 'in_comment' && p.status !== 'active');

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={headerTitleStyle}>Governance</div>
            <div style={headerSubStyle}>
              Voting power: <strong style={{ color: '#4ade80' }}>{votingPower}</strong>
              {votingTier && (
                <span style={badgeStyle(votingTier)}>{votingTier.charAt(0).toUpperCase() + votingTier.slice(1)}</span>
              )}
              <span style={{ marginLeft: 12, fontSize: 11, color: '#5a8a5a' }}>
                Pass threshold: <strong style={{ color: '#fbbf24' }}>{govStatus.passThreshold}</strong>/
                {govStatus.distributedPower} distributed votes
              </span>
              {govStatus.governanceWallet && (
                <span style={{ marginLeft: 12, fontSize: 11, color: '#5a8a5a' }}>
                  Treasury:{' '}
                  <strong style={{ color: '#fbbf24' }}>{govStatus.governanceWallet.confirmed.toLocaleString()}</strong>{' '}
                  WTC
                </span>
              )}
            </div>
          </div>
          <button
            onClick={() => {
              setShowCreate(!showCreate);
              setStatusMsg('');
            }}
            style={{
              background: showCreate ? '#1e3a1e' : '#4ade80',
              color: showCreate ? '#9ac79f' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '9px 16px',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {showCreate ? 'Cancel' : 'New Proposal'}
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 0,
          borderBottom: '1px solid #1e3a1e',
          padding: '0 24px',
          background: '#0a140a',
        }}
      >
        {['proposals', 'team', 'documentation'].map((tab) => (
          <button
            key={tab}
            onClick={() => setGovSubTab(tab)}
            style={{
              padding: '10px 18px',
              fontSize: 13,
              fontWeight: govSubTab === tab ? 700 : 500,
              color: govSubTab === tab ? '#4ade80' : '#7aaa7a',
              background: 'transparent',
              border: 'none',
              borderBottom: govSubTab === tab ? '2px solid #4ade80' : '2px solid transparent',
              cursor: 'pointer',
              textTransform: 'capitalize',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {tab}
          </button>
        ))}
      </div>

      <div style={scrollStyle}>
        <div style={contentInnerStyle}>
          {govSubTab === 'proposals' && (
            <>
              {statusMsg && (
                <div
                  style={{
                    fontSize: 13,
                    color: statusType === 'error' ? '#fca5a5' : '#86efac',
                    marginBottom: 12,
                    padding: '8px 12px',
                    background: '#0d1a0d',
                    borderRadius: 8,
                    border: '1px solid #1e3a1e',
                  }}
                >
                  {statusMsg}
                </div>
              )}

              {showCreate && (
                <div style={{ ...cardStyle, marginBottom: 18 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80', marginBottom: 10 }}>
                    Submit a Proposal
                  </div>
                  <input
                    value={createTitle}
                    onChange={(e) => setCreateTitle(e.target.value)}
                    placeholder="Proposal title"
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      fontSize: 14,
                      padding: '9px 12px',
                      borderRadius: 8,
                      border: '1px solid #224022',
                      background: '#060e06',
                      color: '#d7ffd9',
                      marginBottom: 8,
                    }}
                  />
                  <textarea
                    value={createDesc}
                    onChange={(e) => setCreateDesc(e.target.value)}
                    placeholder="Describe your proposal (optional)"
                    rows={4}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      fontSize: 13,
                      padding: '9px 12px',
                      borderRadius: 8,
                      border: '1px solid #224022',
                      background: '#060e06',
                      color: '#d7ffd9',
                      marginBottom: 10,
                      resize: 'vertical',
                      fontFamily: 'inherit',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 16, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: 12, color: '#7aaa7a' }}>Comment period:</div>
                      <select
                        value={createCommentPeriod}
                        onChange={(e) => setCreateCommentPeriod(Number(e.target.value))}
                        style={{
                          fontSize: 13,
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #224022',
                          background: '#060e06',
                          color: '#d7ffd9',
                        }}
                      >
                        {[1, 2, 3, 4].map((w) => (
                          <option key={w} value={w}>
                            {w} week{w > 1 ? 's' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <div style={{ fontSize: 12, color: '#7aaa7a' }}>Voting period:</div>
                      <select
                        value={createDuration}
                        onChange={(e) => setCreateDuration(Number(e.target.value))}
                        style={{
                          fontSize: 13,
                          padding: '6px 10px',
                          borderRadius: 6,
                          border: '1px solid #224022',
                          background: '#060e06',
                          color: '#d7ffd9',
                        }}
                      >
                        {[2, 3, 4, 5, 6, 7, 8, 9, 10].map((w) => (
                          <option key={w} value={w}>
                            {w} week{w > 1 ? 's' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#5a8a5a', marginBottom: 10, lineHeight: 1.5 }}>
                    Proposals that mention changing the 21M hard cap, energy law (20 kWh/coin floor), or genesis
                    allocation will be automatically rejected.
                  </div>

                  {/* Governance treasury transfer toggle */}
                  <div
                    onClick={() => setShowTransferForm(!showTransferForm)}
                    style={{
                      fontSize: 12,
                      color: '#38bdf8',
                      cursor: 'pointer',
                      marginBottom: showTransferForm ? 10 : 0,
                      padding: '4px 0',
                    }}
                  >
                    {showTransferForm ? '− Hide treasury transfer' : '+ Add treasury transfer'}
                  </div>

                  {showTransferForm && (
                    <div
                      style={{
                        background: '#0a1f2e',
                        border: '1px solid #1e4a6e',
                        borderRadius: 8,
                        padding: 12,
                        marginBottom: 10,
                      }}
                    >
                      <div style={{ fontSize: 12, fontWeight: 700, color: '#60a5fa', marginBottom: 8 }}>
                        Governance Treasury Transfer
                      </div>
                      <input
                        value={transferTo}
                        onChange={(e) => setTransferTo(e.target.value)}
                        placeholder="Recipient address (wtc1...)"
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          fontSize: 13,
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: '1px solid #224022',
                          background: '#060e06',
                          color: '#d7ffd9',
                          marginBottom: 6,
                          fontFamily: 'monospace',
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          value={transferAmount}
                          onChange={(e) => setTransferAmount(e.target.value)}
                          placeholder="Amount (WTC)"
                          type="number"
                          min="0"
                          step="0.01"
                          style={{
                            flex: 1,
                            boxSizing: 'border-box',
                            fontSize: 13,
                            padding: '8px 10px',
                            borderRadius: 6,
                            border: '1px solid #224022',
                            background: '#060e06',
                            color: '#d7ffd9',
                            marginBottom: 6,
                          }}
                        />
                      </div>
                      <input
                        value={transferPurpose}
                        onChange={(e) => setTransferPurpose(e.target.value)}
                        placeholder="Purpose (e.g. Security audit Q3 2026)"
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          fontSize: 13,
                          padding: '8px 10px',
                          borderRadius: 6,
                          border: '1px solid #224022',
                          background: '#060e06',
                          color: '#d7ffd9',
                        }}
                      />
                      <label
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          fontSize: 12,
                          color: '#abf0c2',
                          marginTop: 8,
                          cursor: 'pointer',
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={useReserveOverride}
                          onChange={(e) => setUseReserveOverride(e.target.checked)}
                          style={{ accentColor: '#ef8c3c', cursor: 'pointer' }}
                        />
                        Allow treasury balance to fall below 10,000 WTC reserve
                      </label>
                    </div>
                  )}

                  <button
                    onClick={handleCreateProposal}
                    style={{
                      background: '#4ade80',
                      color: '#001008',
                      border: 'none',
                      borderRadius: 8,
                      padding: '8px 16px',
                      fontWeight: 700,
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    Submit Proposal
                  </button>
                </div>
              )}

              <div style={sectionDividerStyle} />

              {commentProposals.length > 0 && (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#60a5fa', margin: '0 0 10px' }}>
                    In Comment Period
                  </div>
                  {commentProposals.map((proposal) => (
                    <div key={proposal.pipId} style={{ ...cardStyle, borderColor: '#3b82f6' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={cardTitleStyle}>{proposal.title}</div>
                        <span style={{ fontSize: 11, color: '#6b8f6b', fontFamily: 'monospace' }}>
                          {pipDisplayId(proposal.pipId)}
                        </span>
                      </div>
                      {proposal.description && (
                        <div
                          style={{
                            fontSize: 13,
                            color: '#b7f5bc',
                            marginBottom: 8,
                            lineHeight: 1.5,
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {proposal.description}
                        </div>
                      )}
                      <div
                        style={{ ...cardMetaStyle, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                      >
                        <span>by {proposal.creator ? proposal.creator.slice(0, 12) + '...' : 'unknown'}</span>
                        {proposal.creatorNftId && (
                          <span style={badgeStyle(proposal.creatorTier)}>
                            {proposal.creatorNftId.toUpperCase()} ·{' '}
                            {proposal.creatorTier.charAt(0).toUpperCase() + proposal.creatorTier.slice(1)}
                          </span>
                        )}
                        <span>&middot; {new Date(proposal.createdAt).toLocaleDateString()}</span>
                      </div>
                      {proposal.transferTo && proposal.transferAmount && (
                        <div
                          style={{
                            fontSize: 12,
                            color: '#60a5fa',
                            background: '#1e3a8a22',
                            borderRadius: 6,
                            padding: '6px 10px',
                            marginBottom: 8,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span>
                            💠 Treasury transfer: <strong>{proposal.transferAmount.toLocaleString()} WTC</strong>
                          </span>
                          <span style={{ color: '#93c5fd' }}>→</span>
                          <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#93c5fd' }}>
                            {proposal.transferTo.slice(0, 12)}...
                          </span>
                          {proposal.transferPurpose && (
                            <span style={{ color: '#93c5fd' }}>· {proposal.transferPurpose}</span>
                          )}
                        </div>
                      )}
                      <div
                        style={{
                          fontSize: 12,
                          color: '#60a5fa',
                          background: '#1e3a8a22',
                          borderRadius: 6,
                          padding: '6px 10px',
                          display: 'inline-block',
                        }}
                      >
                        💬 Comment period
                        {proposal.commentPeriodEndsAt ? ` — ${getRemainingTime(proposal.commentPeriodEndsAt)}` : ''}
                        {proposal.commentPeriodWeeks
                          ? ` (${proposal.commentPeriodWeeks} week${proposal.commentPeriodWeeks > 1 ? 's' : ''})`
                          : ''}
                        {proposal.votingDurationWeeks ? ` · Voting opens after` : ''}
                      </div>
                    </div>
                  ))}
                </>
              )}

              {activeProposals.length === 0 && commentProposals.length === 0 && (
                <div style={{ fontSize: 14, color: '#7aaa7a', textAlign: 'center', marginTop: 40, marginBottom: 20 }}>
                  No active proposals. Click &ldquo;New Proposal&rdquo; to create one.
                </div>
              )}

              {activeProposals.length > 0 && (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80', margin: '16px 0 10px' }}>
                    Voting Open
                  </div>
                  {activeProposals.map((proposal) => {
                    const totalVotes = proposal.voteTallies.for + proposal.voteTallies.against;
                    const forPct = totalVotes > 0 ? Math.round((proposal.voteTallies.for / totalVotes) * 100) : 0;
                    const againstPct =
                      totalVotes > 0 ? Math.round((proposal.voteTallies.against / totalVotes) * 100) : 0;
                    return (
                      <div key={proposal.pipId} style={cardStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={cardTitleStyle}>{proposal.title}</div>
                          <span style={{ fontSize: 11, color: '#6b8f6b', fontFamily: 'monospace' }}>
                            {pipDisplayId(proposal.pipId)}
                          </span>
                        </div>
                        {proposal.description && (
                          <div
                            style={{
                              fontSize: 13,
                              color: '#b7f5bc',
                              marginBottom: 8,
                              lineHeight: 1.5,
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {proposal.description}
                          </div>
                        )}
                        <div
                          style={{ ...cardMetaStyle, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
                        >
                          <span>by {proposal.creator ? proposal.creator.slice(0, 12) + '...' : 'unknown'}</span>
                          {proposal.creatorNftId && (
                            <span style={badgeStyle(proposal.creatorTier)}>
                              {proposal.creatorNftId.toUpperCase()} ·{' '}
                              {proposal.creatorTier.charAt(0).toUpperCase() + proposal.creatorTier.slice(1)}
                            </span>
                          )}
                          <span>&middot; {new Date(proposal.createdAt).toLocaleDateString()}</span>
                          {proposal.votingEndsAt && (
                            <span style={{ color: '#fbbf24', fontSize: 12 }}>
                              &middot; {getRemainingTime(proposal.votingEndsAt)}
                            </span>
                          )}
                        </div>

                        {proposal.transferTo && proposal.transferAmount && (
                          <div
                            style={{
                              fontSize: 12,
                              color: '#60a5fa',
                              background: '#1e3a8a22',
                              borderRadius: 6,
                              padding: '6px 10px',
                              marginBottom: 8,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              flexWrap: 'wrap',
                            }}
                          >
                            <span>
                              💠 Treasury transfer: <strong>{proposal.transferAmount.toLocaleString()} WTC</strong>
                            </span>
                            <span style={{ color: '#93c5fd' }}>→</span>
                            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#93c5fd' }}>
                              {proposal.transferTo.slice(0, 12)}...
                            </span>
                            {proposal.transferPurpose && (
                              <span style={{ color: '#93c5fd' }}>· {proposal.transferPurpose}</span>
                            )}
                          </div>
                        )}

                        {totalVotes > 0 && (
                          <div style={{ marginBottom: 10 }}>
                            <div
                              style={{
                                height: 6,
                                background: '#1e3a1e',
                                borderRadius: 3,
                                overflow: 'hidden',
                                display: 'flex',
                              }}
                            >
                              <div
                                style={{
                                  width: `${forPct}%`,
                                  background: '#4ade80',
                                  transition: 'width 0.3s',
                                }}
                              />
                              <div
                                style={{
                                  width: `${againstPct}%`,
                                  background: '#ef4444',
                                  transition: 'width 0.3s',
                                }}
                              />
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                fontSize: 12,
                                color: '#7aaa7a',
                                marginTop: 4,
                              }}
                            >
                              <span style={{ color: '#4ade80' }}>{proposal.voteTallies.for} for</span>
                              <span style={{ color: '#ef4444' }}>{proposal.voteTallies.against} against</span>
                            </div>
                          </div>
                        )}

                        <VoteButtons
                          proposal={proposal}
                          selectedWalletAddress={selectedWalletAddress}
                          onVote={handleVote}
                        />
                      </div>
                    );
                  })}
                </>
              )}

              {pastProposals.length > 0 && (
                <>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#7aaa7a', margin: '20px 0 10px' }}>
                    Past Proposals
                  </div>
                  {pastProposals.map((proposal) => {
                    const totalVotes = proposal.voteTallies.for + proposal.voteTallies.against;
                    const forPct = totalVotes > 0 ? Math.round((proposal.voteTallies.for / totalVotes) * 100) : 0;
                    const recorded = proposal.recordedAtHeight != null;
                    return (
                      <div key={proposal.pipId} style={{ ...cardStyle, opacity: 0.7 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <div style={cardTitleStyle}>{proposal.title}</div>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontSize: 11, color: '#6b8f6b', fontFamily: 'monospace' }}>
                              {pipDisplayId(proposal.pipId)}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                fontWeight: 700,
                                color: proposal.status === 'passed' ? '#4ade80' : '#ef4444',
                                background: proposal.status === 'passed' ? '#4ade80' + '22' : '#ef4444' + '22',
                                borderRadius: 6,
                                padding: '2px 7px',
                              }}
                            >
                              {proposal.status === 'passed' ? 'Passed' : 'Rejected'}
                            </span>
                          </div>
                        </div>
                        {proposal.description && (
                          <div
                            style={{
                              fontSize: 13,
                              color: '#b7f5bc',
                              marginBottom: 8,
                              lineHeight: 1.5,
                              whiteSpace: 'pre-wrap',
                            }}
                          >
                            {proposal.description}
                          </div>
                        )}
                        {proposal.transferTo && proposal.transferAmount && (
                          <div
                            style={{
                              fontSize: 12,
                              color: '#93c5fd',
                              marginBottom: 6,
                            }}
                          >
                            💠 Treasury transfer: <strong>{proposal.transferAmount.toLocaleString()} WTC</strong> →{' '}
                            <span style={{ fontFamily: 'monospace' }}>{proposal.transferTo.slice(0, 12)}...</span>
                            {proposal.transferPurpose && ` · ${proposal.transferPurpose}`}
                          </div>
                        )}
                        <div style={{ fontSize: 12, color: '#6b8f6b' }}>
                          {proposal.voteTallies.for} for &middot; {proposal.voteTallies.against} against
                          {totalVotes > 0 && ` (${forPct}% in favor)`}
                          {recorded && ` \u00b7 Recorded at height ${proposal.recordedAtHeight}`}
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}

          {govSubTab === 'team' && <TeamView selectedWalletAddress={selectedWalletAddress} nfts={nfts} />}

          {govSubTab === 'documentation' && <DocsView selectedWalletAddress={selectedWalletAddress} nfts={nfts} />}
        </div>
      </div>
    </div>
  );
}

function TeamView({ selectedWalletAddress, nfts }) {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState('');
  const [formRole, setFormRole] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formPicture, setFormPicture] = useState('');
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPicture, setEditPicture] = useState('');
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('info');

  const hasNft = nfts.length > 0;
  const isVhpn1 = nfts.some((n) => n.nftId === 'vhpn-1');
  const usedNftIds = new Set(members.map((m) => m.nftId).filter(Boolean));
  const availableNfts = nfts.filter((n) => !usedNftIds.has(n.nftId));
  const TIER_ORDER = { gold: 3, silver: 2, bronze: 1 };
  const bestAvailableNft =
    availableNfts.length > 0
      ? availableNfts.sort((a, b) => {
          const ta = TIER_ORDER[(a.metadata && a.metadata.tier) || 'bronze'] || 0;
          const tb = TIER_ORDER[(b.metadata && b.metadata.tier) || 'bronze'] || 0;
          if (ta !== tb) return tb - ta;
          const na = parseInt(a.nftId.replace(/\D/g, ''), 10) || 999;
          const nb = parseInt(b.nftId.replace(/\D/g, ''), 10) || 999;
          return na - nb;
        })[0]
      : null;

  const loadMembers = useCallback(() => {
    if (!window.wattcoinHardware?.invoke || !hasNft) return;
    window.wattcoinHardware
      .invoke('wattcoin-team-list', selectedWalletAddress)
      .then((res) => {
        if (res && res.ok) setMembers(res.members || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedWalletAddress, hasNft]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const handlePictureFile = (setter) => (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setter(reader.result);
    reader.readAsDataURL(file);
  };

  const handleAdd = () => {
    const name = formName.trim();
    if (!name) {
      setMsgType('error');
      setMsg('Name is required');
      return;
    }
    if (!bestAvailableNft) {
      setMsgType('error');
      setMsg('No available NFT to use');
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-team-add', selectedWalletAddress, {
        name,
        role: formRole.trim(),
        description: formDesc.trim(),
        picture: formPicture,
        nftId: bestAvailableNft.nftId,
      })
      .then((res) => {
        if (res && res.ok) {
          setMembers((prev) => [...prev, res.member]);
          setFormName('');
          setFormRole('');
          setFormDesc('');
          setFormPicture('');
          setShowAdd(false);
          setMsgType('info');
          setMsg('Added to team.');
          setTimeout(() => setMsg(''), 3000);
        } else {
          setMsgType('error');
          setMsg(res.error || 'Failed');
        }
      })
      .catch((e) => {
        setMsgType('error');
        setMsg(String(e && e.message));
      });
  };

  const handleEdit = (member) => {
    setEditId(member.id);
    setEditName(member.name);
    setEditRole(member.role || '');
    setEditDesc(member.description || '');
    setEditPicture(member.picture || '');
  };

  const handleSaveEdit = () => {
    const name = editName.trim();
    if (!name) {
      setMsgType('error');
      setMsg('Name is required');
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-team-edit', selectedWalletAddress, editId, {
        name,
        role: editRole.trim(),
        description: editDesc.trim(),
        picture: editPicture,
      })
      .then((res) => {
        if (res && res.ok) {
          setMembers((prev) =>
            prev.map((m) =>
              m.id === editId
                ? {
                    ...m,
                    name: editName.trim(),
                    role: editRole.trim(),
                    description: editDesc.trim(),
                    picture: editPicture,
                  }
                : m,
            ),
          );
          setEditId(null);
          setMsgType('info');
          setMsg('Team member updated.');
          setTimeout(() => setMsg(''), 3000);
        } else {
          setMsgType('error');
          setMsg(res.error || 'Failed');
        }
      })
      .catch((e) => {
        setMsgType('error');
        setMsg(String(e && e.message));
      });
  };

  const handleDelete = (memberId) => {
    window.wattcoinHardware
      .invoke('wattcoin-team-delete', selectedWalletAddress, memberId)
      .then((res) => {
        if (res && res.ok) {
          setMembers((prev) => prev.filter((m) => m.id !== memberId));
          setMsgType('info');
          setMsg('Team member removed.');
          setTimeout(() => setMsg(''), 3000);
        } else {
          setMsgType('error');
          setMsg(res.error || 'Failed');
        }
      })
      .catch((e) => {
        setMsgType('error');
        setMsg(String(e && e.message));
      });
  };

  const canEdit = (member) => isVhpn1 || nfts.some((n) => n.nftId === member.nftId);

  if (!hasNft) return null;

  if (loading)
    return <div style={{ fontSize: 13, color: '#7aaa7a', textAlign: 'center', marginTop: 40 }}>Loading team...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>Team ({members.length})</div>
        {isVhpn1 && (
          <button
            onClick={() => setShowAdd(!showAdd)}
            style={{
              background: showAdd ? '#1e3a1e' : '#4ade80',
              color: showAdd ? '#9ac79f' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {showAdd ? 'Cancel' : 'Add Member'}
          </button>
        )}
        {!isVhpn1 && availableNfts.length > 0 && (
          <button
            onClick={() => setShowAdd(!showAdd)}
            style={{
              background: showAdd ? '#1e3a1e' : '#4ade80',
              color: showAdd ? '#9ac79f' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {showAdd ? 'Cancel' : 'Add Yourself'}
          </button>
        )}
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            color: msgType === 'error' ? '#fca5a5' : '#86efac',
            marginBottom: 10,
            padding: '6px 10px',
            background: '#0d1a0d',
            borderRadius: 6,
            border: '1px solid #1e3a1e',
          }}
        >
          {msg}
        </div>
      )}

      {showAdd && (
        <div
          style={{ background: '#0d1a0d', border: '1px solid #1e3a1e', borderRadius: 8, padding: 12, marginBottom: 14 }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', marginBottom: 8 }}>
            {isVhpn1 ? 'Add Team Member' : 'Add Yourself'}
          </div>
          {bestAvailableNft && (
            <div style={{ fontSize: 11, color: '#7aaa7a', marginBottom: 8 }}>
              Using NFT:{' '}
              <span style={{ color: '#4ade80', fontWeight: 700 }}>{bestAvailableNft.nftId.toUpperCase()}</span>
              {' · '}
              {(bestAvailableNft.metadata && bestAvailableNft.metadata.tier) || 'bronze'}
            </div>
          )}
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Name"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 6,
            }}
          />
          <input
            value={formRole}
            onChange={(e) => setFormRole(e.target.value)}
            placeholder="Role (optional)"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 6,
            }}
          />
          <textarea
            value={formDesc}
            onChange={(e) => setFormDesc(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 6,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <input
              type="file"
              accept="image/*"
              onChange={handlePictureFile(setFormPicture)}
              style={{ fontSize: 12, color: '#7aaa7a', flex: 1 }}
            />
            {formPicture && (
              <img
                src={formPicture}
                alt=""
                style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }}
              />
            )}
          </div>
          <button
            onClick={handleAdd}
            style={{
              background: '#4ade80',
              color: '#001008',
              border: 'none',
              borderRadius: 6,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {isVhpn1 ? 'Add Member' : 'Add Yourself'}
          </button>
        </div>
      )}

      {members.length === 0 && (
        <div style={{ fontSize: 13, color: '#7aaa7a', textAlign: 'center', marginTop: 30 }}>No team members yet.</div>
      )}

      {members.map((member) => (
        <div
          key={member.id}
          style={{ background: '#0d1a0d', border: '1px solid #1e3a1e', borderRadius: 8, padding: 12, marginBottom: 10 }}
        >
          {editId === member.id ? (
            <div>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="Name"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontSize: 13,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid #224022',
                  background: '#060e06',
                  color: '#d7ffd9',
                  marginBottom: 6,
                }}
              />
              <input
                value={editRole}
                onChange={(e) => setEditRole(e.target.value)}
                placeholder="Role"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontSize: 13,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid #224022',
                  background: '#060e06',
                  color: '#d7ffd9',
                  marginBottom: 6,
                }}
              />
              <textarea
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Description"
                rows={2}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontSize: 13,
                  padding: '8px 10px',
                  borderRadius: 6,
                  border: '1px solid #224022',
                  background: '#060e06',
                  color: '#d7ffd9',
                  marginBottom: 6,
                  resize: 'vertical',
                  fontFamily: 'inherit',
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handlePictureFile(setEditPicture)}
                  style={{ fontSize: 12, color: '#7aaa7a', flex: 1 }}
                />
                {editPicture && (
                  <img
                    src={editPicture}
                    alt=""
                    style={{ width: 36, height: 36, borderRadius: '50%', objectFit: 'cover' }}
                  />
                )}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={handleSaveEdit}
                  style={{
                    background: '#4ade80',
                    color: '#001008',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => setEditId(null)}
                  style={{
                    background: '#1e3a1e',
                    color: '#9ac79f',
                    border: 'none',
                    borderRadius: 6,
                    padding: '6px 12px',
                    fontWeight: 700,
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {member.picture ? (
                <img
                  src={member.picture}
                  alt=""
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    objectFit: 'cover',
                    flexShrink: 0,
                    marginTop: 2,
                  }}
                />
              ) : (
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: '#1e3a1e',
                    flexShrink: 0,
                    marginTop: 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 16,
                    fontWeight: 700,
                    color: '#4ade80',
                  }}
                >
                  {member.name ? member.name.charAt(0).toUpperCase() : '?'}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#d7ffd9' }}>{member.name}</div>
                    {member.role && <div style={{ fontSize: 12, color: '#fbbf24', marginTop: 2 }}>{member.role}</div>}
                    {member.nftId && (
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: '#4ade80',
                          background: '#4ade8022',
                          borderRadius: 6,
                          padding: '1px 6px',
                          display: 'inline-block',
                          marginTop: 4,
                        }}
                      >
                        {member.nftId.toUpperCase()}
                      </span>
                    )}
                  </div>
                  {canEdit(member) && (
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button
                        onClick={() => handleEdit(member)}
                        style={{
                          background: 'transparent',
                          color: '#38bdf8',
                          border: '1px solid #38bdf8',
                          borderRadius: 5,
                          padding: '3px 8px',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(member.id)}
                        style={{
                          background: 'transparent',
                          color: '#ef4444',
                          border: '1px solid #ef4444',
                          borderRadius: 5,
                          padding: '3px 8px',
                          fontSize: 11,
                          cursor: 'pointer',
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
                {member.description && (
                  <div style={{ fontSize: 12, color: '#b7f5bc', marginTop: 6, lineHeight: 1.5 }}>
                    {member.description}
                  </div>
                )}
                <div style={{ fontSize: 10, color: '#6b8f6b', marginTop: 6, wordBreak: 'break-all' }}>
                  {member.address || ''}
                  {member.addedAt ? ` · ${new Date(member.addedAt).toLocaleDateString()}` : ''}
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function DocsView({ selectedWalletAddress, nfts }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showUpload, setShowUpload] = useState(false);
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');
  const [formCategory, setFormCategory] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [msg, setMsg] = useState('');
  const [msgType, setMsgType] = useState('info');

  const hasNft = nfts.length > 0;
  const isVhpn1 = nfts.some((n) => n.nftId === 'vhpn-1');

  const loadDocs = useCallback(() => {
    if (!window.wattcoinHardware?.invoke || !hasNft) return;
    window.wattcoinHardware
      .invoke('wattcoin-docs-list', selectedWalletAddress)
      .then((res) => {
        if (res && res.ok) setDocs(res.docs || []);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [selectedWalletAddress, hasNft]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const handleUpload = () => {
    const title = formTitle.trim();
    const content = formContent.trim();
    if (!title) {
      setMsgType('error');
      setMsg('Title is required');
      return;
    }
    if (!content) {
      setMsgType('error');
      setMsg('Content is required');
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-docs-upload', selectedWalletAddress, { title, content, category: formCategory.trim() })
      .then((res) => {
        if (res && res.ok) {
          setDocs((prev) => [...prev, res.doc]);
          setFormTitle('');
          setFormContent('');
          setFormCategory('');
          setShowUpload(false);
          setMsgType('info');
          setMsg('Documentation uploaded.');
          setTimeout(() => setMsg(''), 3000);
        } else {
          setMsgType('error');
          setMsg(res.error || 'Failed');
        }
      })
      .catch((e) => {
        setMsgType('error');
        setMsg(String(e && e.message));
      });
  };

  const handleDelete = (docId) => {
    window.wattcoinHardware
      .invoke('wattcoin-docs-delete', selectedWalletAddress, docId)
      .then((res) => {
        if (res && res.ok) {
          setDocs((prev) => prev.filter((d) => d.id !== docId));
          setExpanded((prev) => (prev === docId ? null : prev));
          setMsgType('info');
          setMsg('Documentation deleted.');
          setTimeout(() => setMsg(''), 3000);
        } else {
          setMsgType('error');
          setMsg(res.error || 'Failed');
        }
      })
      .catch((e) => {
        setMsgType('error');
        setMsg(String(e && e.message));
      });
  };

  if (!hasNft) return null;

  if (loading)
    return (
      <div style={{ fontSize: 13, color: '#7aaa7a', textAlign: 'center', marginTop: 40 }}>Loading documentation...</div>
    );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80' }}>Documentation ({docs.length})</div>
        {isVhpn1 && (
          <button
            onClick={() => setShowUpload(!showUpload)}
            style={{
              background: showUpload ? '#1e3a1e' : '#4ade80',
              color: showUpload ? '#9ac79f' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {showUpload ? 'Cancel' : 'Upload'}
          </button>
        )}
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            color: msgType === 'error' ? '#fca5a5' : '#86efac',
            marginBottom: 10,
            padding: '6px 10px',
            background: '#0d1a0d',
            borderRadius: 6,
            border: '1px solid #1e3a1e',
          }}
        >
          {msg}
        </div>
      )}

      {showUpload && (
        <div
          style={{ background: '#0d1a0d', border: '1px solid #1e3a1e', borderRadius: 8, padding: 12, marginBottom: 14 }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, color: '#4ade80', marginBottom: 8 }}>Upload Documentation</div>
          <input
            value={formTitle}
            onChange={(e) => setFormTitle(e.target.value)}
            placeholder="Title"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 6,
            }}
          />
          <input
            value={formCategory}
            onChange={(e) => setFormCategory(e.target.value)}
            placeholder="Category (optional)"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 6,
            }}
          />
          <textarea
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder="Content (markdown supported)"
            rows={6}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              fontSize: 13,
              padding: '8px 10px',
              borderRadius: 6,
              border: '1px solid #224022',
              background: '#060e06',
              color: '#d7ffd9',
              marginBottom: 8,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <button
            onClick={handleUpload}
            style={{
              background: '#4ade80',
              color: '#001008',
              border: 'none',
              borderRadius: 6,
              padding: '7px 14px',
              fontWeight: 700,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Upload
          </button>
        </div>
      )}

      {docs.length === 0 && (
        <div style={{ fontSize: 13, color: '#7aaa7a', textAlign: 'center', marginTop: 30 }}>
          No documentation uploaded yet.
        </div>
      )}

      {docs.map((doc) => (
        <div
          key={doc.id}
          style={{
            background: '#0d1a0d',
            border: '1px solid #1e3a1e',
            borderRadius: 8,
            marginBottom: 10,
            overflow: 'hidden',
          }}
        >
          <div
            onClick={() => setExpanded((prev) => (prev === doc.id ? null : doc.id))}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: '12px 14px',
              cursor: 'pointer',
              background: expanded === doc.id ? '#122212' : 'transparent',
            }}
          >
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#d7ffd9' }}>{doc.title}</div>
              <div style={{ fontSize: 11, color: '#6b8f6b', marginTop: 2 }}>
                {doc.category && <span style={{ color: '#fbbf24' }}>{doc.category}</span>}
                {doc.category && ' · '}
                {doc.addedAt ? new Date(doc.addedAt).toLocaleDateString() : ''}
              </div>
            </div>
            <div style={{ fontSize: 11, color: '#5a8a5a' }}>{expanded === doc.id ? '▲' : '▼'}</div>
          </div>
          {expanded === doc.id && (
            <div style={{ padding: '0 14px 12px', borderTop: '1px solid #1e3a1e' }}>
              <div
                style={{
                  fontSize: 13,
                  color: '#b7f5bc',
                  lineHeight: 1.6,
                  marginTop: 10,
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'inherit',
                }}
              >
                {doc.content}
              </div>
              {isVhpn1 && (
                <button
                  onClick={() => handleDelete(doc.id)}
                  style={{
                    marginTop: 10,
                    background: 'transparent',
                    color: '#ef4444',
                    border: '1px solid #ef4444',
                    borderRadius: 5,
                    padding: '4px 10px',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function VoteButtons({ proposal, selectedWalletAddress, onVote }) {
  const userVote = selectedWalletAddress && proposal.votes ? proposal.votes[selectedWalletAddress] : null;

  if (userVote) {
    return (
      <div style={{ fontSize: 13, color: '#6b8f6b' }}>
        You voted <strong style={{ color: userVote.vote === 'for' ? '#4ade80' : '#ef4444' }}>{userVote.vote}</strong>
        {userVote.power > 0 && ` (${userVote.power} vote${userVote.power > 1 ? 's' : ''})`}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <button
        onClick={() => onVote(proposal.pipId, 'for')}
        style={{
          flex: 1,
          background: '#0d1a0d',
          color: '#4ade80',
          border: '1px solid #4ade80',
          borderRadius: 8,
          padding: '7px 0',
          fontWeight: 700,
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Vote For
      </button>
      <button
        onClick={() => onVote(proposal.pipId, 'against')}
        style={{
          flex: 1,
          background: '#0d1a0d',
          color: '#ef4444',
          border: '1px solid #ef4444',
          borderRadius: 8,
          padding: '7px 0',
          fontWeight: 700,
          fontSize: 13,
          cursor: 'pointer',
        }}
      >
        Vote Against
      </button>
    </div>
  );
}
