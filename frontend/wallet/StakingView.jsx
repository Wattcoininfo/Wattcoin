import React from 'react';

export default function StakingView({ selectedWalletAddress, walletBalance, queuedWtc = 0 }) {
  const [status, setStatus] = React.useState(null); // pool info
  const [myEntries, setMyEntries] = React.useState([]);
  const [stakeAmount, setStakeAmount] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState('');
  const [msgOk, setMsgOk] = React.useState(true);

  const address = selectedWalletAddress || '';

  // ── load status + my entries ────────────────────────────────────────────────
  const refresh = React.useCallback(async () => {
    try {
      const s = await window.wattcoinHardware.invoke('wattcoin-staking-status');
      if (s.ok) setStatus(s);
    } catch (_) {
      /* istanbul ignore next */
    }
    if (address) {
      try {
        const r = await window.wattcoinHardware.invoke('wattcoin-staking-get-my-entries', address);
        if (r.ok) setMyEntries(r.entries || []);
      } catch (_) {
        /* istanbul ignore next */
      }
    }
  }, [address]);

  React.useEffect(() => {
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => clearInterval(id);
  }, [refresh]);

  // ── place stake ─────────────────────────────────────────────────────────────
  async function handleStake() {
    setMsg('');
    const amt = parseFloat(stakeAmount);
    if (!address) {
      setMsg('No wallet address selected.');
      setMsgOk(false);
      return;
    }
    if (!Number.isFinite(amt) || amt < (status ? status.minStake : 100)) {
      setMsg(`Minimum stake is ${status ? status.minStake : 100} WTC.`);
      setMsgOk(false);
      return;
    }
    const totalAvailable = (walletBalance || 0) + (queuedWtc || 0);
    if (totalAvailable > 0 && Math.floor(amt) > totalAvailable) {
      setMsg(`Insufficient balance. You have ${totalAvailable.toLocaleString()} WTC in your wallet.`);
      setMsgOk(false);
      return;
    }
    setBusy(true);
    try {
      const r = await window.wattcoinHardware.invoke('wattcoin-staking-stake', {
        fromAddress: address,
        wtcAmount: Math.floor(amt),
      });
      if (r.ok) {
        setMsg(
          r.alreadyExists
            ? 'You already have a pending staking entry.'
            : 'Stake submitted! Reward will be paid when queue reaches the flush threshold.',
        );
        setMsgOk(true);
        setStakeAmount('');
        await refresh();
      } else {
        setMsg(r.error || 'Failed to submit stake.');
        setMsgOk(false);
      }
    } catch (e) {
      setMsg('Error: ' + (e.message || e));
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  // ── cancel entry ─────────────────────────────────────────────────────────────
  async function handleCancel(entryId) {
    setBusy(true);
    try {
      const r = await window.wattcoinHardware.invoke('wattcoin-staking-cancel', entryId);
      setMsg(r.ok ? 'Staking entry cancelled.' : r.error || 'Failed to cancel.');
      setMsgOk(r.ok);
      await refresh();
    } catch (e) {
      setMsg('Error: ' + (e.message || e));
      setMsgOk(false);
    } finally {
      setBusy(false);
    }
  }

  const hasPending = myEntries.some((e) => e.status === 'pending');
  const poolBal = status ? status.poolBalance : null;
  const apy = status ? status.currentApy : 0;
  const totalStaked = status ? status.totalStaked : 0;
  const _flushThreshold = status ? status.flushThreshold : 10000;

  return (
    <div style={{ padding: '18px 0' }}>
      {/* ── Wallet balance ── */}
      <div
        style={{
          background: '#071507',
          border: '1px solid #1a3a1a',
          borderRadius: 10,
          padding: '11px 18px',
          marginBottom: 16,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ color: '#6ee688', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em' }}>
          YOUR WALLET BALANCE
        </div>
        <div
          style={{
            color: walletBalance + queuedWtc > 0 ? '#4ade80' : '#9ca3af',
            fontSize: 16,
            fontWeight: 800,
            marginLeft: 'auto',
          }}
        >
          {(walletBalance + queuedWtc).toLocaleString()} WTC
        </div>
        {queuedWtc > 0 && walletBalance > 0 && (
          <div style={{ width: '100%', textAlign: 'right', fontSize: 11, color: '#6b9a6b', fontFamily: 'monospace' }}>
            {walletBalance.toLocaleString()} mined + {queuedWtc.toLocaleString()} queued for delivery
          </div>
        )}
        {queuedWtc > 0 && walletBalance === 0 && (
          <div style={{ width: '100%', textAlign: 'right', fontSize: 11, color: '#fbbf24', fontFamily: 'monospace' }}>
            {queuedWtc.toLocaleString()} WTC queued for delivery
          </div>
        )}
      </div>
      {/* ── Pool info bar ── */}
      <div
        style={{
          background: '#0d2710',
          borderRadius: 10,
          padding: '14px 18px',
          marginBottom: 18,
          display: 'flex',
          gap: 32,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ color: '#6ee688', fontSize: 11, fontWeight: 600, marginBottom: 2 }}>COINS LEFT TO EARN</div>
          <div style={{ color: '#4ade80', fontSize: 20, fontWeight: 800 }}>
            {poolBal !== null ? poolBal.toLocaleString() + ' WTC' : '—'}
          </div>
        </div>
        <div>
          <div style={{ color: '#6ee688', fontSize: 11, fontWeight: 600, marginBottom: 2 }}>TOTAL CURRENTLY STAKED</div>
          <div style={{ color: '#e2f5e5', fontSize: 20, fontWeight: 700 }}>{totalStaked.toLocaleString()} WTC</div>
        </div>
        <div>
          <div style={{ color: '#6ee688', fontSize: 11, fontWeight: 600, marginBottom: 2 }}>CURRENT APY</div>
          <div style={{ color: apy > 0 ? '#4ade80' : '#9ca3af', fontSize: 20, fontWeight: 700 }}>{apy.toFixed(2)}%</div>
        </div>
      </div>

      <div style={{ color: '#9ca3af', fontSize: 12, marginBottom: 16, lineHeight: 1.5 }}>
        Stake WTC to earn rewards. Every <strong style={{ color: '#b7f5bc' }}>100&nbsp;WTC</strong> in the queue adds{' '}
        <strong style={{ color: '#b7f5bc' }}>0.01% APY</strong>. Staking will end when the total supply of{' '}
        <strong style={{ color: '#b7f5bc' }}>166,667&nbsp;WTC</strong> has been distributed.
      </div>

      {/* ── Stake form ── */}
      {!hasPending ? (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
          <input
            type="number"
            min={status ? status.minStake : 100}
            step="1"
            placeholder={`Amount (min ${status ? status.minStake : 100} WTC)`}
            value={stakeAmount}
            onChange={(e) => setStakeAmount(e.target.value)}
            disabled={busy}
            style={{
              background: '#0d2710',
              border: '1.5px solid #265b2e',
              borderRadius: 8,
              color: '#e2f5e5',
              padding: '9px 13px',
              fontSize: 14,
              width: 220,
              outline: 'none',
            }}
          />
          <button
            onClick={handleStake}
            disabled={busy || !address}
            style={{
              background: busy || !address ? '#265b2e' : '#4ade80',
              color: busy || !address ? '#9ca3af' : '#001008',
              border: 'none',
              borderRadius: 8,
              padding: '9px 22px',
              fontWeight: 700,
              fontSize: 14,
              cursor: busy || !address ? 'default' : 'pointer',
            }}
          >
            {busy ? 'Submitting…' : 'Stake WTC'}
          </button>
        </div>
      ) : (
        <div
          style={{
            background: '#0d2710',
            borderRadius: 8,
            padding: '10px 14px',
            marginBottom: 14,
            color: '#4ade80',
            fontSize: 13,
          }}
        >
          You have a pending staking entry. Cancel it below to stake a different amount.
        </div>
      )}

      {msg && (
        <div
          style={{
            background: msgOk ? '#0d2710' : '#2a1010',
            border: `1px solid ${msgOk ? '#4ade80' : '#f87171'}`,
            borderRadius: 8,
            padding: '9px 13px',
            marginBottom: 14,
            color: msgOk ? '#4ade80' : '#f87171',
            fontSize: 13,
          }}
        >
          {msg}
        </div>
      )}

      {/* ── My staking entries ── */}
      {myEntries.length > 0 && (
        <div>
          <div style={{ color: '#6ee688', fontSize: 13, fontWeight: 700, marginBottom: 8 }}>My Staking Entries</div>
          {myEntries.map((entry) => (
            <div
              key={entry.id}
              style={{
                background: '#0d2710',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 8,
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 120 }}>
                <div style={{ color: '#4ade80', fontWeight: 700, fontSize: 15 }}>
                  {entry.wtcAmount.toLocaleString()} WTC
                </div>
                <div style={{ color: '#9ca3af', fontSize: 11 }}>{new Date(entry.createdAtMs).toLocaleString()}</div>
              </div>
              <div style={{ minWidth: 80 }}>
                <span
                  style={{
                    background:
                      entry.status === 'pending' ? '#1a3a2a' : entry.status === 'rewarded' ? '#0d2710' : '#2a1a1a',
                    color: entry.status === 'pending' ? '#4ade80' : entry.status === 'rewarded' ? '#86efac' : '#f87171',
                    borderRadius: 5,
                    padding: '3px 9px',
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {entry.status.toUpperCase()}
                </span>
              </div>
              {entry.status === 'rewarded' && entry.rewardAmount !== null && (
                <div style={{ color: '#86efac', fontSize: 13 }}>
                  +{entry.rewardAmount.toLocaleString()} WTC reward @ {entry.apyAtFlush}% APY
                </div>
              )}
              {entry.status === 'pending' && (
                <button
                  onClick={() => handleCancel(entry.id)}
                  disabled={busy}
                  style={{
                    background: 'none',
                    border: '1px solid #f87171',
                    color: '#f87171',
                    borderRadius: 6,
                    padding: '5px 12px',
                    cursor: busy ? 'default' : 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
