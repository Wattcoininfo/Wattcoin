import { useState, useRef, useEffect, useCallback } from 'react';
import { shortHash, formatTs, proofColor, proofLabel, PAGE_SIZE } from './explorerUtils';
import BlockDetail from './BlockDetail';
import Row from './Row';

export default function ExplorerView() {
  // Block list state
  const [blocks, setBlocks] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [selectedBlock, setSelectedBlock] = useState(null);
  const [selectedBlockData, setSelectedBlockData] = useState(null);
  const [blockBusy, setBlockBusy] = useState(false);

  // Stats state
  const [stats, setStats] = useState(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchResult, setSearchResult] = useState(null);

  // Jump to height
  const [jumpHeight, setJumpHeight] = useState('');

  // Sub-views: 'blocks', 'address', 'tx'
  const [subView, setSubView] = useState('blocks');
  const [addressData, setAddressData] = useState(null);
  const [addressBusy, setAddressBusy] = useState(false);
  const [txData, setTxData] = useState(null);
  const [txBusy, setTxBusy] = useState(false);

  const hasPrev = offset + PAGE_SIZE < total;
  const hasNext = offset > 0;

  const loadBlocks = useCallback(async (off) => {
    if (!window.wattcoinHardware?.invoke) {
      setStatus('API unavailable.');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-blocks', {
        offset: off,
        limit: PAGE_SIZE,
      });
      if (res?.ok) {
        setBlocks(res.blocks || []);
        setTotal(res.total || 0);
        setOffset(off);
        setSelectedBlock(null);
        setSelectedBlockData(null);
      } else setStatus('Failed to load blocks.');
    } catch (e) {
      setStatus('Error: ' + e?.message);
    }
    setBusy(false);
  }, []);

  const loadStats = useCallback(async () => {
    if (!window.wattcoinHardware?.invoke) return;
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-stats');
      if (res?.ok) setStats(res);
    } catch (_) {
      /* ignore */
    }
  }, []);

  const loadBlockDetail = useCallback(async (height) => {
    if (!window.wattcoinHardware?.invoke) return;
    setBlockBusy(true);
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-block', { height });
      if (res?.ok) setSelectedBlockData(res.block);
    } catch (_) {
      /* ignore */
    }
    setBlockBusy(false);
  }, []);

  const loadAddress = useCallback(async (address) => {
    if (!window.wattcoinHardware?.invoke) return;
    setAddressBusy(true);
    setAddressData(null);
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-address', { address });
      if (res?.ok) setAddressData(res);
    } catch (_) {
      /* ignore */
    }
    setAddressBusy(false);
  }, []);

  const loadTx = useCallback(async (txid) => {
    if (!window.wattcoinHardware?.invoke) return;
    setTxBusy(true);
    setTxData(null);
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-explorer-get-tx-detail', { txid });
      if (res?.ok) setTxData(res.tx || res);
    } catch (_) {
      /* ignore */
    }
    setTxBusy(false);
  }, []);

  useEffect(() => {
    loadBlocks(0);
    loadStats();
  }, [loadBlocks, loadStats]);

  // Auto-refresh: poll stats every 30s, reload blocks when at offset 0
  useEffect(() => {
    const iv = setInterval(() => {
      loadStats();
      if (offset === 0) loadBlocks(0);
    }, 30_000);
    return () => clearInterval(iv);
  }, [loadStats, loadBlocks, offset]);

  function handleSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    setSearchBusy(true);
    setSearchResult(null);
    window.wattcoinHardware
      .invoke('wattcoin-explorer-search', { query: q })
      .then((res) => {
        setSearchResult(res);
        if (res?.type === 'block') {
          setSelectedBlock(res.block.height);
          setSelectedBlockData(res.block);
        } else if (res?.type === 'address') {
          setSubView('address');
          loadAddress(res.address);
        } else if (res?.type === 'tx') {
          setSubView('tx');
          setTxData(res.tx);
        }
      })
      .catch(() => setSearchResult({ type: 'not_found', message: 'Search failed.' }))
      .finally(() => setSearchBusy(false));
  }

  function handleJumpToHeight() {
    const h = parseInt(jumpHeight, 10);
    if (isNaN(h) || h < 0) return;
    setSearchQuery(String(h));
    setJumpHeight('');
    handleSearchRef.current = true;
  }

  const handleSearchRef = useRef(false);
  useEffect(() => {
    if (handleSearchRef.current) {
      handleSearchRef.current = false;
      handleSearch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  function handleSelectBlock(height) {
    if (selectedBlock === height) {
      setSelectedBlock(null);
      setSelectedBlockData(null);
      return;
    }
    setSelectedBlock(height);
    setSelectedBlockData(null);
    loadBlockDetail(height);
  }

  function handleAddressClick(address) {
    if (!address || address === 'genesis') return;
    setSubView('address');
    loadAddress(address);
  }

  function handleTxClick(txid) {
    if (!txid) return;
    setSubView('tx');
    loadTx(txid);
  }

  function handleBack() {
    setSubView('blocks');
    setAddressData(null);
    setTxData(null);
    setSearchResult(null);
  }

  const btnStyle = (disabled) => ({
    background: disabled ? '#1a2e1a' : '#1e3a1e',
    color: disabled ? '#456045' : '#b7f5bc',
    border: 'none',
    borderRadius: 6,
    padding: '5px 10px',
    fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer',
    fontSize: 12,
  });

  // ── Address Detail view ─────────────────────────────────────────────
  function renderAddressDetail() {
    const d = addressData;
    if (addressBusy) return <div style={{ color: '#9ac79f', fontSize: 13 }}>Loading address…</div>;
    if (!d) return <div style={{ color: '#fca5a5', fontSize: 13 }}>No data.</div>;
    return (
      <div>
        <div style={{ fontSize: 14, color: '#4ade80', fontWeight: 700, marginBottom: 8 }}>Address Detail</div>
        <Row label="Address" value={d.address} mono />
        <Row label="Balance" value={`${(d.balance?.confirmed || 0).toLocaleString()} WTC`} />
        {d.balance?.unmatured > 0 && (
          <Row label="Unmatured" value={`${(d.balance?.unmatured || 0).toLocaleString()} WTC`} />
        )}
        <Row
          label="Mined"
          value={`${(d.minedStats?.totalWTC || 0).toLocaleString()} WTC (${d.minedStats?.totalBlocks || 0} blocks)`}
        />
        <Row label="Transactions" value={d.totalTransactions} />
        {d.minedBlocks?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 4, fontSize: 12 }}>Mined Blocks</div>
            {d.minedBlocks.map((mb) => (
              <div
                key={mb.height}
                onClick={() => {
                  setSubView('blocks');
                  handleSelectBlock(mb.height);
                }}
                style={{ cursor: 'pointer', fontSize: 11, color: '#60a5fa', fontFamily: 'monospace', marginBottom: 2 }}
              >
                #{mb.height} — {formatTs(mb.timestamp)} — +
                {(mb.rewardTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} WTC
              </div>
            ))}
          </div>
        )}
        {d.transactions?.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: '#4ade80', fontWeight: 700, marginBottom: 4, fontSize: 12 }}>Recent Transactions</div>
            {d.transactions.map((tx, i) => (
              <div
                key={tx.id || tx.txid || i}
                onClick={() => handleTxClick(tx.id || tx.txid)}
                style={{
                  cursor: 'pointer',
                  fontSize: 11,
                  color: '#60a5fa',
                  fontFamily: 'monospace',
                  marginBottom: 3,
                  wordBreak: 'break-all',
                }}
              >
                {tx.category === 'mine' ? '⛏ ' : ''}
                {(tx.id || tx.txid || '-').slice(0, 20)}… —{' '}
                {tx.amount != null ? `${Number(tx.amount).toLocaleString()} WTC` : ''}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── Tx Detail view ──────────────────────────────────────────────────
  function renderTxDetail() {
    const tx = txData;
    if (txBusy) return <div style={{ color: '#9ac79f', fontSize: 13 }}>Loading transaction…</div>;
    if (!tx) return <div style={{ color: '#fca5a5', fontSize: 13 }}>No data.</div>;
    return (
      <div style={{ fontSize: 12, display: 'grid', gap: 5 }}>
        <div style={{ fontSize: 14, color: '#4ade80', fontWeight: 700, marginBottom: 4 }}>Transaction Detail</div>
        <Row label="ID" value={tx.id || tx.txid || '-'} mono />
        {tx.from !== undefined && <Row label="From" value={tx.from} mono />}
        {tx.to !== undefined && <Row label="To" value={tx.to} mono />}
        {tx.amount != null && (
          <Row
            label="Amount"
            value={`${Number(tx.amount).toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC`}
          />
        )}
        {tx.fee != null && <Row label="Fee" value={`${Number(tx.fee).toLocaleString()} WTC`} />}
        {tx.nonce != null && <Row label="Nonce" value={tx.nonce} />}
        {tx.blockHeight != null && (
          <Row
            label="Block"
            value={
              <span
                onClick={() => {
                  setSubView('blocks');
                  handleSelectBlock(tx.blockHeight);
                }}
                style={{ color: '#60a5fa', cursor: 'pointer' }}
              >
                #{tx.blockHeight}
              </span>
            }
          />
        )}
        {tx.blockHash && <Row label="Block Hash" value={shortHash(tx.blockHash)} mono />}
        {tx.timestamp && <Row label="Time" value={formatTs(tx.timestamp)} />}
        {tx.type && <Row label="Type" value={tx.type} />}
        {tx.sig && (
          <div style={{ marginTop: 4 }}>
            <Row label="Signature" value={tx.sig} mono />
          </div>
        )}
      </div>
    );
  }

  // ── Stats Panel ─────────────────────────────────────────────────────
  function renderStats() {
    if (!stats || stats.height < 0) return null;
    const s = stats;
    let avgBlockTime = '-';
    let hashrate = '-';
    if (s.latestBlocks?.length >= 2) {
      const recent = s.latestBlocks;
      const oldest = recent[recent.length - 1];
      const newest = recent[0];
      const dt = (newest.timestamp - oldest.timestamp) / 1000;
      const n = recent.length - 1;
      if (dt > 0) {
        avgBlockTime = (dt / n).toFixed(1) + 's';
        hashrate = (n / (dt / 3600)).toFixed(1) + ' blk/h';
      }
    }
    return (
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '4px 16px',
          marginBottom: 10,
          fontSize: 12,
          color: '#9ac79f',
          background: '#0a150a',
          border: '1px solid #1e3a1e',
          borderRadius: 8,
          padding: '8px 12px',
        }}
      >
        <span>
          Height: <strong style={{ color: '#d7ffd9' }}>{s.height}</strong>
        </span>
        <span>
          Supply: <strong style={{ color: '#fbbf24' }}>{(s.totalSupply || 0).toLocaleString()} / 21,000,000 WTC</strong>
        </span>
        <span>
          Peers: <strong style={{ color: '#4ade80' }}>{s.peerCount}</strong>
        </span>
        <span>
          Block Time: <strong style={{ color: '#86efac' }}>{avgBlockTime}</strong>
        </span>
        <span>
          Rate: <strong style={{ color: '#86efac' }}>{hashrate}</strong>
        </span>
      </div>
    );
  }

  // ── Search + Jump bar ───────────────────────────────────────────────
  function renderSearchBar() {
    return (
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleSearch();
          }}
          placeholder="Height / hash / address…"
          style={{
            flex: 1,
            minWidth: 160,
            background: '#0d1a0d',
            border: '1px solid #224022',
            borderRadius: 6,
            padding: '5px 10px',
            color: '#d7ffd9',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button
          onClick={handleSearch}
          disabled={searchBusy || !searchQuery.trim()}
          style={btnStyle(searchBusy || !searchQuery.trim())}
        >
          {searchBusy ? '…' : 'Search'}
        </button>
        <input
          value={jumpHeight}
          onChange={(e) => setJumpHeight(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleJumpToHeight();
          }}
          placeholder="Go to height…"
          style={{
            width: 110,
            background: '#0d1a0d',
            border: '1px solid #224022',
            borderRadius: 6,
            padding: '5px 10px',
            color: '#d7ffd9',
            fontSize: 12,
            outline: 'none',
          }}
        />
        <button onClick={handleJumpToHeight} disabled={!jumpHeight} style={btnStyle(!jumpHeight)}>
          Go
        </button>
      </div>
    );
  }

  // ── Search Result Banner ────────────────────────────────────────────
  function renderSearchResult() {
    if (!searchResult) return null;
    if (searchResult.type === 'not_found') {
      return (
        <div
          style={{
            marginBottom: 8,
            fontSize: 12,
            color: '#fca5a5',
            background: '#1a0d0d',
            border: '1px solid #5a2020',
            borderRadius: 6,
            padding: '6px 10px',
          }}
        >
          {searchResult.message}
          <button
            onClick={() => setSearchResult(null)}
            style={{
              marginLeft: 10,
              background: 'none',
              border: 'none',
              color: '#9ac79f',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            Dismiss
          </button>
        </div>
      );
    }
    return null;
  }

  // ── Block Row ───────────────────────────────────────────────────────
  function renderBlockRow(b) {
    const expanded = selectedBlock === b.height;
    return (
      <div key={b.height}>
        <div
          onClick={() => handleSelectBlock(b.height)}
          style={{
            background: expanded ? '#112a11' : '#0d1a0d',
            border: expanded ? '1px solid #4ade80' : '1px solid #224022',
            borderRadius: expanded && selectedBlockData ? '8px 8px 0 0' : 8,
            padding: '9px 12px',
            cursor: 'pointer',
            display: 'grid',
            gridTemplateColumns: '3.5rem 1fr auto',
            gap: '0 12px',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13, color: '#4ade80', fontWeight: 700 }}>#{b.height}</span>
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                padding: '1px 5px',
                borderRadius: 4,
                color: '#001008',
                background: proofColor(b.proofType),
              }}
            >
              {proofLabel(b.proofType)}
            </span>
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  fontSize: 11,
                  color: '#9ac79f',
                  fontFamily: 'monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {shortHash(b.hash)}
              </span>
              {b.hash && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(b.hash).catch(() => {});
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#708870',
                    cursor: 'pointer',
                    fontSize: 10,
                    padding: 0,
                    flexShrink: 0,
                  }}
                  title="Copy hash"
                >
                  📋
                </button>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#708870', marginTop: 2 }}>
              {formatTs(b.timestamp)} &nbsp;·&nbsp; {b.txCount} tx &nbsp;·&nbsp;
              {b.proposer === 'genesis' ? (
                'genesis'
              ) : (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAddressClick(b.proposer);
                  }}
                  style={{ color: '#60a5fa', cursor: 'pointer' }}
                >
                  {b.proposer ? shortHash(b.proposer) : '-'}
                </span>
              )}
            </div>
          </div>
          <span style={{ fontSize: 12, color: '#86efac', fontWeight: 700, whiteSpace: 'nowrap' }}>
            +{(b.rewardTotal || 0).toLocaleString(undefined, { maximumFractionDigits: 4 })} WTC
          </span>
        </div>

        {expanded && (
          <div
            style={{
              background: '#0a150a',
              border: '1px solid #4ade80',
              borderTop: 'none',
              borderRadius: '0 0 8px 8px',
              padding: '10px 14px',
            }}
          >
            {blockBusy ? (
              <div style={{ fontSize: 13, color: '#9ac79f' }}>Loading block…</div>
            ) : selectedBlockData ? (
              <BlockDetail block={selectedBlockData} onAddressClick={handleAddressClick} onTxClick={handleTxClick} />
            ) : (
              <div style={{ fontSize: 13, color: '#fca5a5' }}>Failed to load block detail.</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Main render ───────────────────────────────────────────────────
  if (subView === 'address') {
    return (
      <div style={{ marginTop: 4 }}>
        <button onClick={handleBack} style={{ ...btnStyle(false), marginBottom: 8 }}>
          ← Back to Explorer
        </button>
        {renderAddressDetail()}
      </div>
    );
  }

  if (subView === 'tx') {
    return (
      <div style={{ marginTop: 4 }}>
        <button onClick={handleBack} style={{ ...btnStyle(false), marginBottom: 8 }}>
          ← Back to Explorer
        </button>
        {renderTxDetail()}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 700 }}>WTC Block Explorer</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={() => loadBlocks(offset + PAGE_SIZE)}
            disabled={busy || !hasPrev}
            style={btnStyle(busy || !hasPrev)}
          >
            ← Older
          </button>
          <button
            onClick={() => loadBlocks(Math.max(0, offset - PAGE_SIZE))}
            disabled={busy || !hasNext}
            style={btnStyle(busy || !hasNext)}
          >
            Newer →
          </button>
          <button
            onClick={() => loadBlocks(0)}
            disabled={busy}
            style={{
              background: busy ? '#275a2f' : '#4ade80',
              color: busy ? '#9fd4a8' : '#001008',
              border: 'none',
              borderRadius: 6,
              padding: '5px 10px',
              fontWeight: 700,
              cursor: busy ? 'default' : 'pointer',
              fontSize: 12,
            }}
          >
            {busy ? 'Loading\u2026' : 'Latest'}
          </button>
        </div>
      </div>

      {renderStats()}
      {renderSearchBar()}
      {renderSearchResult()}

      {total > 0 && (
        <div style={{ fontSize: 12, color: '#9ac79f', marginBottom: 8 }}>
          Chain height: <strong style={{ color: '#d7ffd9' }}>{total - 1}</strong> &nbsp;·&nbsp; {total} block
          {total !== 1 ? 's' : ''}
        </div>
      )}

      {status && <div style={{ marginBottom: 8, fontSize: 13, color: '#fca5a5' }}>{status}</div>}

      <div style={{ display: 'grid', gap: 6 }}>
        {blocks.map(renderBlockRow)}
        {blocks.length === 0 && !busy && (
          <div style={{ fontSize: 13, color: '#9ac79f', padding: '12px 0' }}>No blocks yet.</div>
        )}
      </div>
    </div>
  );
}
