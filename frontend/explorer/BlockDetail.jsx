import { formatTs } from './explorerUtils';
import Row from './Row';

export default function BlockDetail({ block, onAddressClick, onTxClick }) {
  const rewardEntries = block.rewardAddresses ? Object.entries(block.rewardAddresses) : [];
  const txs = block.transactions || [];
  const votes = block.votes ? Object.keys(block.votes) : [];

  function shortHash(h) {
    return h?.length >= 16 ? h.slice(0, 8) + '\u2026' + h.slice(-6) : h || '-';
  }

  const copyBtn = (val) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(val).catch(() => {});
      }}
      style={{
        background: 'none',
        border: 'none',
        color: '#708870',
        cursor: 'pointer',
        fontSize: 10,
        padding: 0,
        marginLeft: 4,
        verticalAlign: 'middle',
      }}
      title="Copy"
    >
      📋
    </button>
  );

  return (
    <div style={{ fontSize: 12, display: 'grid', gap: 5 }}>
      <Row label="Height" value={block.height} />
      <Row label="Hash" value={block.hash} mono extra={copyBtn(block.hash)} />
      <Row
        label="PrevHash"
        value={shortHash(block.prevHash)}
        mono
        extra={block.prevHash ? copyBtn(block.prevHash) : null}
      />
      <Row label="Time" value={formatTs(block.timestamp)} />
      <Row
        label="Proposer"
        value={
          block.proposer === 'genesis' ? (
            'genesis'
          ) : (
            <span onClick={() => onAddressClick?.(block.proposer)} style={{ color: '#60a5fa', cursor: 'pointer' }}>
              {block.proposer}
            </span>
          )
        }
        mono
        extra={block.proposer && block.proposer !== 'genesis' ? copyBtn(block.proposer) : null}
      />
      <Row
        label="Energy"
        value={`${(block.energyWh || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} Wh`}
      />
      <Row
        label="Reward"
        value={`${(block.rewardTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC`}
      />
      {block.proofCommitment && (
        <Row label="Proof" value={shortHash(block.proofCommitment)} mono extra={copyBtn(block.proofCommitment)} />
      )}
      {rewardEntries.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 3 }}>Reward distribution</div>
          {rewardEntries.map(([addr, amt]) => (
            <div
              key={addr}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                color: '#9ac79f',
                fontFamily: 'monospace',
                fontSize: 11,
                wordBreak: 'break-all',
              }}
            >
              <span style={{ marginRight: 8, flex: 1 }}>
                <span onClick={() => onAddressClick?.(addr)} style={{ color: '#60a5fa', cursor: 'pointer' }}>
                  {addr}
                </span>
              </span>
              <span style={{ whiteSpace: 'nowrap', color: '#86efac' }}>
                {amt.toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC
              </span>
            </div>
          ))}
        </div>
      )}
      {txs.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 3 }}>Transactions ({txs.length})</div>
          {txs.map((tx, i) => (
            <div
              key={tx.id || i}
              style={{
                background: '#0d1a0d',
                border: '1px solid #1e3a1e',
                borderRadius: 6,
                padding: '6px 10px',
                marginBottom: 4,
              }}
            >
              <div
                style={{
                  color: '#60a5fa',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  wordBreak: 'break-all',
                  cursor: 'pointer',
                }}
                onClick={() => onTxClick?.(tx.id || tx.txid)}
              >
                ID: {tx.id || tx.txid || '-'} {copyBtn(tx.id || tx.txid)}
              </div>
              <div style={{ color: '#708870', fontSize: 11, marginTop: 2 }}>
                {tx.from && (
                  <span>
                    From:{' '}
                    <span onClick={() => onAddressClick?.(tx.from)} style={{ color: '#60a5fa', cursor: 'pointer' }}>
                      {tx.from}
                    </span>{' '}
                    &nbsp;
                  </span>
                )}
                {tx.to && (
                  <span>
                    To:{' '}
                    <span onClick={() => onAddressClick?.(tx.to)} style={{ color: '#60a5fa', cursor: 'pointer' }}>
                      {tx.to}
                    </span>{' '}
                    &nbsp;
                  </span>
                )}
                {tx.amount != null && (
                  <span>Amount: {Number(tx.amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {votes.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 3 }}>BFT Votes ({votes.length})</div>
          {votes.map((v) => (
            <div key={v} style={{ fontSize: 10, color: '#708870', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {v}
              {copyBtn(v)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
