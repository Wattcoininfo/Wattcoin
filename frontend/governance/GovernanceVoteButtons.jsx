export default function VoteButtons({ proposal, selectedWalletAddress, onVote }) {
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
