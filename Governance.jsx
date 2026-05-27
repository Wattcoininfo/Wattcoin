import React, { useState, useEffect, useCallback } from 'react';

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
  const [govStatus, setGovStatus] = useState({ distributedPower: 0, passThreshold: 0, totalPossible: 140 });
  const [showTransferForm, setShowTransferForm] = useState(false);
  const [transferTo, setTransferTo] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferPurpose, setTransferPurpose] = useState('');

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
                <span style={{ marginLeft: 12, fontSize: 11, color: '#38bdf8' }}>
                  Treasury: <strong>{govStatus.governanceWallet.confirmed.toLocaleString()} WTC</strong>
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

      <div style={scrollStyle}>
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
            <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80', marginBottom: 10 }}>Submit a Proposal</div>
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
              Proposals that mention changing the 21M hard cap, energy law (20 kWh/coin floor), or genesis allocation
              will be automatically rejected.
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

        {commentProposals.length > 0 && (
          <>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#60a5fa', margin: '0 0 10px' }}>In Comment Period</div>
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
                    style={{ fontSize: 13, color: '#b7f5bc', marginBottom: 8, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}
                  >
                    {proposal.description}
                  </div>
                )}
                <div style={{ ...cardMetaStyle, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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
                    {proposal.transferPurpose && <span style={{ color: '#93c5fd' }}>· {proposal.transferPurpose}</span>}
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
            <div style={{ fontSize: 14, fontWeight: 700, color: '#4ade80', margin: '16px 0 10px' }}>Voting Open</div>
            {activeProposals.map((proposal) => {
              const totalVotes = proposal.voteTallies.for + proposal.voteTallies.against;
              const forPct = totalVotes > 0 ? Math.round((proposal.voteTallies.for / totalVotes) * 100) : 0;
              const againstPct = totalVotes > 0 ? Math.round((proposal.voteTallies.against / totalVotes) * 100) : 0;
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
                  <div style={{ ...cardMetaStyle, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
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

                  <VoteButtons proposal={proposal} selectedWalletAddress={selectedWalletAddress} onVote={handleVote} />
                </div>
              );
            })}
          </>
        )}

        {pastProposals.length > 0 && (
          <>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#7aaa7a', margin: '20px 0 10px' }}>Past Proposals</div>
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
      </div>
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
