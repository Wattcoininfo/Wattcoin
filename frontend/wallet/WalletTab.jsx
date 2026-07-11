import React, { useCallback } from 'react';
import {
  createDefaultWalletReadiness,
  loadPersistedSentTransactions,
  SENT_TX_HISTORY_STORAGE_KEY,
  MAX_PERSISTED_SENT_TXS,
} from '../storage';
import WalletAddressDisplay from './WalletAddressDisplay';
import NftTierStatusBar from './NftTierStatusBar';
import SaleView from './SaleView';
import StakingView from './StakingView';
import ExplorerView from '../explorer/ExplorerView';
import nftImgGold from '../../assets/Vortex NFT Gold.jpg';
import nftImgSilver from '../../assets/Vortex NFT Silver.jpg';
import nftImgBronze from '../../assets/Vortex NFT Bronze.jpg';

export default function WalletTab({
  coins,
  maturedCoins,
  unmaturedCoins,
  energy: _energy,
  selectedWalletAddress,
  walletSyncState,
  refreshBalances,
  onAddressChange,
  purchasedWtc = 0,
}) {
  const [walletView, setWalletView] = React.useState('sale');
  const [networkInfo, setNetworkInfo] = React.useState({ network: 'regtest', explorerBaseUrl: '' });
  const [betaPolicy, setBetaPolicy] = React.useState({
    loading: true,
    betaMode: false,
    withdrawalsEnabled: true,
    resetWipePolicy: false,
    policyMessage: '',
  });
  const walletReadiness =
    walletSyncState && walletSyncState.walletReadiness
      ? walletSyncState.walletReadiness
      : createDefaultWalletReadiness();
  const [sentTxHistory, setSentTxHistory] = React.useState(() => loadPersistedSentTransactions());
  const [transactions, setTransactions] = React.useState([]);
  const initialTxLoadRef = React.useRef(false);
  const [transactionsBusy, setTransactionsBusy] = React.useState(true);
  const [transactionsStatus, setTransactionsStatus] = React.useState('');
  const [withdrawAddress, setWithdrawAddress] = React.useState('');
  const [withdrawAmount, setWithdrawAmount] = React.useState('');
  const [subtractFeeFromAmount, setSubtractFeeFromAmount] = React.useState(false);
  const [withdrawBusy, setWithdrawBusy] = React.useState(false);
  const [withdrawMessage, setWithdrawMessage] = React.useState('');
  const [withdrawTxid, setWithdrawTxid] = React.useState('');
  const [withdrawPending, setWithdrawPending] = React.useState(false); // true while polling for confirmation
  const txStatusPollRef = React.useRef(null); // interval id
  const txStatusTimeoutRef = React.useRef(null); // timeout id
  // Address validation state
  const [addrValidation, setAddrValidation] = React.useState({ state: 'empty', reason: '' }); // 'empty'|'checking'|'valid'|'invalid'
  const addrValidationTimer = React.useRef(null);
  const [showSendConfirm, setShowSendConfirm] = React.useState(false);
  const [queuedSaleOrders, setQueuedSaleOrders] = React.useState([]);
  const [orderId, setOrderId] = React.useState(null);
  const [orderStatus, setOrderStatus] = React.useState(null);
  const [orderPollRef] = React.useState({ iv: null });
  // Vortex NFT state
  const [nfts, setNfts] = React.useState([]);
  const [nftsBusy, setNftsBusy] = React.useState(false);
  const [nftTransferTarget, setNftTransferTarget] = React.useState(null);
  const [nftTransferAddress, setNftTransferAddress] = React.useState('');
  const [nftTransferMsg, setNftTransferMsg] = React.useState('');

  const nodeMatured = Math.max(0, Number(maturedCoins) || 0);
  const nodeUnmatured = Math.max(0, Number(unmaturedCoins) || 0);
  const nodeTotal = Math.max(Number(coins) || 0, nodeMatured + nodeUnmatured);
  const displayTotal = Math.max(0, nodeTotal);
  const displayMatured = Math.max(0, nodeMatured);
  const displayUnmatured = Math.max(0, nodeUnmatured);

  const formatTxTime = React.useCallback((unixSeconds) => {
    const ts = Number(unixSeconds) || 0;
    if (!ts) return '-';
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch (_) {
      return '-';
    }
  }, []);

  // ── Poll order status after placing ──────────────────────────────────────
  const startOrderPoll = useCallback(
    (id, callbacks = {}) => {
      if (orderPollRef.iv) clearInterval(orderPollRef.iv);
      orderPollRef.iv = setInterval(async () => {
        try {
          const r = await window.wattcoinHardware.invoke('wattcoin-sale-get-order', id);
          if (r && r.ok && r.order) {
            setOrderStatus(r.order);
            if (r.order.status === 'queued' || r.order.status === 'delivery_pending') {
              clearInterval(orderPollRef.iv);
              orderPollRef.iv = null;
              setOrderId(null);
              setOrderStatus(null);
              setQueuedSaleOrders((prev) => prev.filter((o) => o.id !== id));
              if (callbacks.onConfirmed) callbacks.onConfirmed();
            } else if (r.order.status === 'fulfilled') {
              clearInterval(orderPollRef.iv);
              orderPollRef.iv = null;
              if (callbacks.onFulfilled) callbacks.onFulfilled();
            } else if (r.order.status === 'failed') {
              clearInterval(orderPollRef.iv);
              orderPollRef.iv = null;
              if (callbacks.onFailed) callbacks.onFailed();
            } else if (r.order.status === 'expired') {
              clearInterval(orderPollRef.iv);
              orderPollRef.iv = null;
              if (callbacks.onExpired) callbacks.onExpired();
            }
          }
        } catch (_) {
          /* istanbul ignore next */
        }
      }, 10_000);
    },
    [orderPollRef],
  );

  React.useEffect(() => {
    try {
      const compact = Array.isArray(sentTxHistory) ? sentTxHistory.slice(0, MAX_PERSISTED_SENT_TXS) : [];
      localStorage.setItem(SENT_TX_HISTORY_STORAGE_KEY, JSON.stringify(compact));
    } catch (_) {
      // Ignore storage errors in restricted environments.
    }
  }, [sentTxHistory]);

  const loadTransactions = React.useCallback(async () => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setTransactionsStatus('Wallet API unavailable.');
      return;
    }
    setTransactionsBusy(true);
    setTransactionsStatus('Loading transactions...');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-list-transactions', {
        selectedAddress: selectedWalletAddress || '',
        count: 50,
      });
      if (res && res.ok) {
        const rows = Array.isArray(res.transactions) ? res.transactions : [];
        const filteredLocalHistory = sentTxHistory.filter((tx) => {
          if (!tx || typeof tx !== 'object') return false;
          if (tx.network !== networkInfo.network) return false;
          if (!selectedWalletAddress) return true;
          return !tx.selectedAddress || tx.selectedAddress === selectedWalletAddress;
        });

        const chainTxIds = new Set(rows.map((tx) => tx && tx.txid).filter(Boolean));
        const merged = [...rows];
        filteredLocalHistory.forEach((tx) => {
          if (!chainTxIds.has(tx.txid)) {
            merged.push(tx);
          }
        });
        merged.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));

        setTransactions(merged);
        setTransactionsStatus(merged.length === 0 ? 'No transactions yet.' : '');

        if (chainTxIds.size > 0) {
          setSentTxHistory((prev) => {
            const next = prev.filter((tx) => !chainTxIds.has(tx.txid));
            return next.length === prev.length ? prev : next;
          });
        }
      } else {
        setTransactions([]);
        setTransactionsStatus(`Failed to load transactions: ${res && res.message ? res.message : 'Unknown error'}`);
      }
    } catch (e) {
      setTransactions([]);
      setTransactionsStatus(`Failed to load transactions: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setTransactionsBusy(false);
    initialTxLoadRef.current = true;
  }, [networkInfo.network, selectedWalletAddress, sentTxHistory]);

  React.useEffect(() => {
    if (walletView !== 'transactions') return;
    loadTransactions();
  }, [walletView, loadTransactions]);

  // Load Vortex NFTs owned by the selected address
  const loadNfts = React.useCallback(() => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    setNftsBusy(true);
    setNftTransferMsg('');
    if (!selectedWalletAddress) {
      setNftsBusy(false);
      return;
    }
    window.wattcoinHardware
      .invoke('wattcoin-nft-list', selectedWalletAddress)
      .then((res) => {
        if (res && res.ok) setNfts(res.nfts || []);
      })
      .catch(() => {})
      .finally(() => setNftsBusy(false));
  }, [selectedWalletAddress]);

  React.useEffect(() => {
    if (walletView !== 'nfts') return;
    loadNfts();
  }, [walletView, loadNfts]);

  React.useEffect(() => {
    let cancelled = false;
    async function loadBetaPolicy() {
      if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
        if (!cancelled) {
          setBetaPolicy({
            loading: false,
            betaMode: false,
            withdrawalsEnabled: true,
            resetWipePolicy: false,
            policyMessage: '',
          });
        }
        return;
      }
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-beta-policy');
        if (!cancelled && res && res.ok) {
          setBetaPolicy({
            loading: false,
            betaMode: !!res.betaMode,
            withdrawalsEnabled: !!res.withdrawalsEnabled,
            resetWipePolicy: !!res.resetWipePolicy,
            policyMessage: typeof res.policyMessage === 'string' ? res.policyMessage : '',
          });
        }
      } catch (_) {
        if (!cancelled) {
          setBetaPolicy({
            loading: false,
            betaMode: false,
            withdrawalsEnabled: true,
            resetWipePolicy: false,
            policyMessage: '',
          });
        }
      }
    }
    async function loadNetworkInfo() {
      if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-network-info');
        if (!cancelled && res && res.ok) {
          setNetworkInfo({
            network: typeof res.network === 'string' ? res.network : 'regtest',
            explorerBaseUrl: typeof res.explorerBaseUrl === 'string' ? res.explorerBaseUrl : '',
          });
        }
      } catch (_) {
        // Keep default network info.
      }
    }
    loadBetaPolicy();
    loadNetworkInfo();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load queued/pending sale orders for this address.
  React.useEffect(() => {
    if (!selectedWalletAddress || !(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    let cancelled = false;
    function loadQueued() {
      window.wattcoinHardware
        .invoke('wattcoin-sale-get-my-orders', selectedWalletAddress)
        .then((res) => {
          if (cancelled || !res || !res.ok || !Array.isArray(res.orders)) return;
          setQueuedSaleOrders(res.orders);
        })
        .catch(() => {});
    }
    loadQueued();
    const iv = setInterval(loadQueued, 15_000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [selectedWalletAddress]);

  function handleWithdrawAddressChange(raw) {
    setWithdrawAddress(raw);
    setWithdrawMessage('');
    setWithdrawTxid('');
    const trimmed = raw.trim();
    if (!trimmed) {
      setAddrValidation({ state: 'empty', reason: '' });
      return;
    }
    setAddrValidation({ state: 'checking', reason: '' });
    if (addrValidationTimer.current) clearTimeout(addrValidationTimer.current);
    addrValidationTimer.current = setTimeout(async () => {
      if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
        setAddrValidation({ state: 'invalid', reason: 'API unavailable' });
        return;
      }
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-validate-address', trimmed);
        if (res && res.ok) {
          setAddrValidation({ state: res.valid ? 'valid' : 'invalid', reason: res.reason || '' });
        } else {
          setAddrValidation({ state: 'invalid', reason: 'Validation failed' });
        }
      } catch (_) {
        setAddrValidation({ state: 'invalid', reason: 'Validation error' });
      }
    }, 350);
  }

  function _stopTxPoll() {
    if (txStatusPollRef.current) {
      clearInterval(txStatusPollRef.current);
      txStatusPollRef.current = null;
    }
    if (txStatusTimeoutRef.current) {
      clearTimeout(txStatusTimeoutRef.current);
      txStatusTimeoutRef.current = null;
    }
  }

  function _startTxConfirmPoll(txid) {
    _stopTxPoll();
    setWithdrawPending(true);

    let unknownCount = 0; // grace counter for 'unknown' status

    // Poll every 5 s — tx confirms in the next naturally-mined block
    txStatusPollRef.current = setInterval(async () => {
      try {
        const res = await window.wattcoinHardware.invoke('wattcoin-get-tx-status', { txid });
        if (res && res.status === 'confirmed') {
          _stopTxPoll();
          setWithdrawPending(false);
          setWithdrawMessage('Transaction confirmed.');
          if (typeof refreshBalances === 'function') refreshBalances();
          if (walletView === 'transactions') loadTransactions();
          if (walletView === 'nfts') loadNfts();
          return;
        }
        // 'pending' — tx is in mempool, waiting for next block → keep polling
        if (res && res.status === 'pending') {
          unknownCount = 0; // reset if it was briefly unknown
          return;
        }
        // 'unknown' — tx is not in mempool or chain; allow 3 consecutive unknowns
        // before declaring failure (brief network hiccup protection)
        if (res && res.status === 'unknown') {
          unknownCount++;
          if (unknownCount >= 3) {
            _stopTxPoll();
            setWithdrawPending(false);
            setWithdrawMessage('Transaction not found in mempool. It may have been dropped — please try again.');
          }
        }
      } catch (_) {
        /* ignore transient errors, keep polling */
      }
    }, 5000);

    // Soft timeout — just stop spinning after 1 day, don't declare failure
    // (mining may be slow; user can check the Explorer)
    txStatusTimeoutRef.current = setTimeout(
      () => {
        _stopTxPoll();
        setWithdrawPending(false);
        setWithdrawMessage('Transaction submitted — check the Explorer to confirm it landed in a block.');
      },
      24 * 60 * 60 * 1000,
    ); // 1 day
  }

  async function executeWithdrawal() {
    setShowSendConfirm(false);
    const toAddress = (withdrawAddress || '').trim();
    const amount = Number(withdrawAmount);
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setWithdrawTxid('');
      setWithdrawMessage('Wallet API unavailable.');
      return;
    }
    setWithdrawBusy(true);
    setWithdrawTxid('');
    setWithdrawMessage('Sending transaction...');
    try {
      const res = await window.wattcoinHardware.invoke('wattcoin-send', {
        toAddress,
        amount,
        subtractFeeFromAmount,
        selectedAddress: selectedWalletAddress || '',
      });
      if (res && res.ok) {
        setSentTxHistory((prev) =>
          [
            {
              txid: res.txid || '',
              category: 'send',
              direction: 'out',
              amount: -Math.abs(Number(res.amount) || amount),
              confirmations: 0,
              address: toAddress,
              time: Math.floor(Date.now() / 1000),
              network: networkInfo.network,
              selectedAddress: selectedWalletAddress || '',
              localOnly: true,
            },
            ...prev.filter((tx) => tx && tx.txid !== res.txid),
          ].slice(0, MAX_PERSISTED_SENT_TXS),
        );
        setWithdrawTxid(res.txid || '');
        setWithdrawMessage('Transaction sent. Waiting to be included in next block…');
        setWithdrawAddress('');
        setWithdrawAmount('');
        setAddrValidation({ state: 'empty', reason: '' });
        _startTxConfirmPoll(res.txid || '');
      } else {
        setWithdrawTxid('');
        setWithdrawMessage(`Withdrawal failed: ${res && res.message ? res.message : 'Unknown error'}`);
      }
    } catch (e) {
      setWithdrawTxid('');
      setWithdrawMessage(`Withdrawal failed: ${e && e.message ? e.message : 'Unknown error'}`);
    }
    setWithdrawBusy(false);
  }

  function submitWithdrawal() {
    if (!walletReadiness.spendReady) {
      setWithdrawTxid('');
      setWithdrawMessage('Withdrawals are disabled until wallet sync is ready.');
      return;
    }
    if (betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled) {
      setWithdrawTxid('');
      setWithdrawMessage(betaPolicy.policyMessage || 'Withdrawals are disabled during closed beta.');
      return;
    }
    const toAddress = (withdrawAddress || '').trim();
    const amount = Number(withdrawAmount);

    if (!toAddress) {
      setWithdrawTxid('');
      setWithdrawMessage('Recipient address is required.');
      return;
    }
    if (addrValidation.state === 'invalid') {
      setWithdrawTxid('');
      setWithdrawMessage(`Invalid address: ${addrValidation.reason || 'does not pass validation'}`);
      return;
    }
    if (addrValidation.state !== 'valid') {
      setWithdrawTxid('');
      setWithdrawMessage('Please wait for address validation to complete.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setWithdrawTxid('');
      setWithdrawMessage('Amount must be greater than 0.');
      return;
    }
    if (!subtractFeeFromAmount && amount > displayMatured) {
      setWithdrawTxid('');
      setWithdrawMessage(`Amount exceeds matured balance (${displayMatured.toFixed(8)} WTC).`);
      return;
    }
    // Show confirmation modal — actual send happens in executeWithdrawal()
    setShowSendConfirm(true);
  }

  return (
    <div
      style={{
        color: '#e8f5e8',
        fontFamily: "'DM Mono', monospace",
        fontSize: 22,
        maxWidth: 640,
        margin: '60px auto 0 auto',
        background: '#122612',
        borderRadius: 18,
        boxShadow: '0 2px 16px #0008',
        padding: '36px 36px 28px 36px',
        border: '2px solid #1e3a1e',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 14,
          flexWrap: 'nowrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, minWidth: 0 }}>
          <div style={{ fontSize: 28, color: '#4ade80', fontWeight: 700, lineHeight: 1 }}>Wallet</div>
          <span
            style={{
              fontSize: 11,
              color: networkInfo.network === 'testnet' ? '#fbbf24' : '#9ac79f',
              background: '#1e3a1e',
              borderRadius: 999,
              padding: '4px 8px',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}
          >
            {networkInfo.network}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {[
            { key: 'explorer', label: 'Explorer' },
            { key: 'sale', label: 'Buy' },
            { key: 'staking', label: 'Staking' },
            { key: 'overview', label: 'Overview' },
            { key: 'transactions', label: 'Transactions' },
            { key: 'nfts', label: 'NFTs' },
          ].map((tab) => (
            <button
              key={tab.key}
              onClick={() => setWalletView(tab.key)}
              style={{
                background: walletView === tab.key ? '#4ade80' : '#1e3a1e',
                color: walletView === tab.key ? '#001008' : '#b7f5bc',
                border: 'none',
                borderRadius: 8,
                padding: '8px 14px',
                fontWeight: 700,
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>
      <WalletAddressDisplay
        selectedWalletAddress={selectedWalletAddress}
        walletSyncState={walletSyncState}
        onAddressChange={onAddressChange}
      />
      <NftTierStatusBar purchasedWtc={purchasedWtc} />
      {betaPolicy.betaMode && (
        <div
          style={{
            marginTop: 10,
            marginBottom: 12,
            padding: '10px 12px',
            borderRadius: 10,
            background: '#2a180c',
            border: '1px solid #7c4a18',
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700, color: '#fbbf24', marginBottom: 4 }}>Closed Beta Policy</div>
          <div style={{ fontSize: 12, color: '#fde68a', marginBottom: 4 }}>
            {betaPolicy.policyMessage || 'Balances are test-only and withdrawals are disabled during beta.'}
          </div>
          {betaPolicy.resetWipePolicy && (
            <div style={{ fontSize: 11, color: '#fcd34d' }}>Beta balances may be reset or wiped at any time.</div>
          )}
        </div>
      )}

      {queuedSaleOrders.filter((o) => o.status === 'pending_payment' || o.status === 'payment_submitted').length >
        0 && (
        <div
          style={{
            marginTop: 8,
            marginBottom: 4,
            padding: '10px 14px',
            background: '#12100a',
            border: '1px solid #3d3000',
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#fbbf24', letterSpacing: '0.1em' }}>
            SALE QUEUE
          </span>
          <span style={{ fontFamily: 'monospace', fontSize: 15, color: '#fcd34d', fontWeight: 700 }}>
            +
            {queuedSaleOrders
              .filter((o) => o.status === 'pending_payment' || o.status === 'payment_submitted')
              .reduce((s, o) => s + (o.wtcAmount || 0), 0)
              .toLocaleString()}{' '}
            WTC
          </span>
          <span style={{ fontSize: 11, color: '#7a6a3a' }}>
            {queuedSaleOrders.some((o) => o.status === 'payment_submitted')
              ? 'paid — awaiting confirmation (up to 10 min)'
              : 'awaiting payment — up to 10 min to detect'}
          </span>
        </div>
      )}

      {walletView === 'overview' && (
        <>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: '#a7ffb0', fontWeight: 600 }}>Total mined coins:</span>
            <span
              style={{
                fontFamily: 'monospace',
                marginLeft: 12,
                fontSize: 20,
                background: '#1e3a1e',
                padding: '4px 10px',
                borderRadius: 8,
              }}
            >
              {`${displayTotal.toLocaleString(undefined, { maximumFractionDigits: 6 })} WTC`}
            </span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: '#a7ffb0', fontWeight: 600 }}>Matured coins:</span>
            <span
              style={{
                fontFamily: 'monospace',
                marginLeft: 12,
                fontSize: 20,
                background: '#1e3a1e',
                padding: '4px 10px',
                borderRadius: 8,
              }}
            >
              {`${displayMatured.toLocaleString(undefined, { maximumFractionDigits: 6 })} WTC`}
            </span>
          </div>
          <div style={{ marginBottom: 8 }}>
            <span style={{ color: '#a7ffb0', fontWeight: 600 }}>Unmatured coins:</span>
            <span
              style={{
                fontFamily: 'monospace',
                marginLeft: 12,
                fontSize: 20,
                background: '#1e3a1e',
                padding: '4px 10px',
                borderRadius: 8,
              }}
            >
              {`${displayUnmatured.toLocaleString(undefined, { maximumFractionDigits: 6 })} WTC`}
            </span>
          </div>
          {(() => {
            const queuedWtc = queuedSaleOrders
              .filter((o) => o.status === 'queued' || o.status === 'delivery_pending')
              .reduce((s, o) => s + (o.wtcAmount || 0), 0);
            if (!queuedWtc) return null;
            return (
              <div style={{ marginBottom: 8 }}>
                <span style={{ color: '#fcd34d', fontWeight: 600 }}>Queued for delivery:</span>
                <span
                  style={{
                    fontFamily: 'monospace',
                    marginLeft: 12,
                    fontSize: 20,
                    background: '#12100a',
                    border: '1px solid #3d3000',
                    padding: '4px 10px',
                    borderRadius: 8,
                    color: '#fcd34d',
                  }}
                >
                  {`+${queuedWtc.toLocaleString()} WTC`}
                </span>
                <span style={{ marginLeft: 8, fontSize: 11, color: '#7a6a3a' }}>purchased — pending batch send</span>
              </div>
            );
          })()}
          <div style={{ marginTop: 10, fontSize: 14, color: '#9ac79f' }}>
            Source: backend round-ledger (node-side accounting)
          </div>

          <div style={{ marginTop: 24, paddingTop: 18, borderTop: '1px solid #1e3a1e' }}>
            <div style={{ fontSize: 18, color: '#4ade80', marginBottom: 10, fontWeight: 700 }}>Withdraw WTC</div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ color: '#a7ffb0', fontWeight: 600, fontSize: 14 }}>Recipient address</div>
                {addrValidation.state === 'checking' && (
                  <span style={{ fontSize: 11, color: '#9ac79f' }}>Validating…</span>
                )}
                {addrValidation.state === 'valid' && (
                  <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>✓ Valid WTC address</span>
                )}
                {addrValidation.state === 'invalid' && (
                  <span style={{ fontSize: 11, color: '#f87171', fontWeight: 700 }}>
                    ✕ {addrValidation.reason || 'Invalid address'}
                  </span>
                )}
              </div>
              <input
                type="text"
                value={withdrawAddress}
                onChange={(e) => handleWithdrawAddressChange(e.target.value)}
                placeholder="wtc1q…"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  background: '#0d1a0d',
                  color: '#d7ffd9',
                  border: `1px solid ${addrValidation.state === 'valid' ? '#4ade80' : addrValidation.state === 'invalid' ? '#f87171' : '#2a4a2a'}`,
                  borderRadius: 8,
                  padding: '9px 10px',
                }}
                disabled={
                  withdrawBusy || betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled || !walletReadiness.spendReady
                }
              />
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ color: '#a7ffb0', fontWeight: 600, marginBottom: 6, fontSize: 14 }}>Amount (WTC)</div>
              <input
                type="number"
                min="0"
                step="0.00000001"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                placeholder="0.00000000"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  fontFamily: 'monospace',
                  fontSize: 13,
                  background: '#0d1a0d',
                  color: '#d7ffd9',
                  border: '1px solid #2a4a2a',
                  borderRadius: 8,
                  padding: '9px 10px',
                }}
                disabled={
                  withdrawBusy || betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled || !walletReadiness.spendReady
                }
              />
            </div>

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                color: '#9ac79f',
                marginBottom: 12,
                cursor: withdrawBusy ? 'default' : 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={subtractFeeFromAmount}
                onChange={(e) => setSubtractFeeFromAmount(e.target.checked)}
                disabled={
                  withdrawBusy || betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled || !walletReadiness.spendReady
                }
              />
              Subtract network fee from sent amount
            </label>

            <button
              onClick={submitWithdrawal}
              disabled={
                withdrawBusy ||
                betaPolicy.betaMode ||
                !betaPolicy.withdrawalsEnabled ||
                !walletReadiness.spendReady ||
                addrValidation.state !== 'valid'
              }
              style={{
                background:
                  withdrawBusy ||
                  betaPolicy.betaMode ||
                  !betaPolicy.withdrawalsEnabled ||
                  !walletReadiness.spendReady ||
                  addrValidation.state !== 'valid'
                    ? '#275a2f'
                    : '#4ade80',
                color:
                  withdrawBusy ||
                  betaPolicy.betaMode ||
                  !betaPolicy.withdrawalsEnabled ||
                  !walletReadiness.spendReady ||
                  addrValidation.state !== 'valid'
                    ? '#9fd4a8'
                    : '#001008',
                border: 'none',
                borderRadius: 8,
                padding: '9px 14px',
                fontWeight: 700,
                cursor:
                  withdrawBusy ||
                  betaPolicy.betaMode ||
                  !betaPolicy.withdrawalsEnabled ||
                  !walletReadiness.spendReady ||
                  addrValidation.state !== 'valid'
                    ? 'default'
                    : 'pointer',
                fontSize: 13,
              }}
            >
              {betaPolicy.betaMode || !betaPolicy.withdrawalsEnabled
                ? 'Withdrawals Disabled In Beta'
                : !walletReadiness.spendReady
                  ? 'Withdrawals Locked Until Sync Ready'
                  : withdrawBusy
                    ? 'Sending...'
                    : 'Send Withdrawal'}
            </button>

            {withdrawMessage && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 13,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  color: withdrawMessage.startsWith('Transaction confirmed')
                    ? '#4ade80'
                    : withdrawMessage.startsWith('Transaction failed')
                      ? '#fca5a5'
                      : '#fcd34d',
                }}
              >
                {withdrawPending && (
                  <span
                    style={{
                      display: 'inline-block',
                      width: 11,
                      height: 11,
                      borderRadius: '50%',
                      border: '2px solid #fcd34d',
                      borderTopColor: 'transparent',
                      animation: 'spin 0.8s linear infinite',
                    }}
                  />
                )}
                {withdrawMessage}
              </div>
            )}

            {withdrawTxid && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#9ac79f', wordBreak: 'break-all' }}>
                TXID: {withdrawTxid}
              </div>
            )}
          </div>

          {/* Send confirmation modal */}
          {showSendConfirm && (
            <div
              style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(0,0,0,0.82)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 3000,
              }}
            >
              <div
                style={{
                  background: '#0f1f0f',
                  border: '2px solid #f59e0b',
                  borderRadius: 14,
                  padding: 28,
                  minWidth: 360,
                  maxWidth: 520,
                  color: '#fef3c7',
                }}
              >
                <div style={{ fontSize: 17, fontWeight: 700, color: '#f59e0b', marginBottom: 14 }}>
                  ⚠ Confirm Withdrawal
                </div>
                <div style={{ fontSize: 13, color: '#d1fae5', marginBottom: 6 }}>You are about to send:</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: '#4ade80', marginBottom: 12 }}>
                  {Number(withdrawAmount).toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC
                </div>
                <div style={{ fontSize: 12, color: '#9ac79f', marginBottom: 4 }}>To address:</div>
                <div
                  style={{
                    fontSize: 12,
                    fontFamily: 'monospace',
                    color: '#d7ffd9',
                    background: '#0d1a0d',
                    border: '1px solid #2a4a2a',
                    borderRadius: 6,
                    padding: '8px 10px',
                    wordBreak: 'break-all',
                    marginBottom: 14,
                  }}
                >
                  {(withdrawAddress || '').trim()}
                </div>
                {subtractFeeFromAmount && (
                  <div style={{ fontSize: 12, color: '#fcd34d', marginBottom: 10 }}>
                    Network fee will be subtracted from the sent amount.
                  </div>
                )}
                <div style={{ fontSize: 12, color: '#fca5a5', marginBottom: 18 }}>
                  This transaction is irreversible. Double-check the address above before confirming.
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowSendConfirm(false)}
                    style={{
                      padding: '8px 18px',
                      borderRadius: 7,
                      border: '1px solid #7c2d12',
                      background: 'transparent',
                      color: '#fcd34d',
                      cursor: 'pointer',
                      fontWeight: 600,
                      fontSize: 13,
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={executeWithdrawal}
                    style={{
                      padding: '8px 18px',
                      borderRadius: 7,
                      border: 'none',
                      background: '#f59e0b',
                      color: '#1f1100',
                      cursor: 'pointer',
                      fontWeight: 700,
                      fontSize: 13,
                    }}
                  >
                    Confirm Send
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {walletView === 'explorer' && <ExplorerView />}

      {walletView === 'sale' && (
        <SaleView
          selectedWalletAddress={selectedWalletAddress}
          setQueuedSaleOrders={setQueuedSaleOrders}
          orderId={orderId}
          setOrderId={setOrderId}
          orderStatus={orderStatus}
          setOrderStatus={setOrderStatus}
          orderPollRef={orderPollRef}
          startOrderPoll={startOrderPoll}
        />
      )}

      {walletView === 'staking' && (
        <StakingView
          selectedWalletAddress={selectedWalletAddress}
          walletBalance={maturedCoins}
          queuedWtc={queuedSaleOrders
            .filter((o) => o.status === 'queued' || o.status === 'delivery_pending')
            .reduce((s, o) => s + (o.wtcAmount || 0), 0)}
        />
      )}

      {walletView === 'transactions' && (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 700 }}>Recent Transactions</div>
            <button
              onClick={loadTransactions}
              disabled={transactionsBusy}
              style={{
                background: transactionsBusy ? '#275a2f' : '#4ade80',
                color: transactionsBusy ? '#9fd4a8' : '#001008',
                border: 'none',
                borderRadius: 8,
                padding: '7px 12px',
                fontWeight: 700,
                cursor: transactionsBusy ? 'default' : 'pointer',
                fontSize: 12,
              }}
            >
              {transactionsBusy ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {transactionsStatus && (
            <div
              style={{
                marginBottom: 10,
                fontSize: 13,
                color: transactionsStatus.startsWith('Failed') ? '#fca5a5' : '#9ac79f',
              }}
            >
              {transactionsStatus}
            </div>
          )}

          {transactions.length === 0 && transactionsBusy && (
            <div style={{ color: '#6b9b6b', fontSize: 13 }}>Loading transactions...</div>
          )}
          {transactions.length === 0 && !transactionsBusy && initialTxLoadRef.current && (
            <div style={{ color: '#6b9b6b', fontSize: 13 }}>No transactions yet.</div>
          )}

          <div style={{ display: 'grid', gap: 8 }}>
            {transactions.map((tx, idx) => {
              const amount = Number(tx.amount) || 0;
              const outgoing = amount < 0;
              return (
                <div
                  key={`${tx.txid || 'tx'}-${idx}`}
                  style={{ background: '#0d1a0d', border: '1px solid #224022', borderRadius: 8, padding: '10px 12px' }}
                >
                  <div
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}
                  >
                    <span style={{ fontSize: 12, color: outgoing ? '#fca5a5' : '#86efac', fontWeight: 700 }}>
                      {outgoing ? 'Sent' : 'Received'}
                    </span>
                    <span
                      style={{ fontSize: 12, color: '#d7ffd9', fontWeight: 700 }}
                    >{`${amount.toLocaleString(undefined, { maximumFractionDigits: 8 })} WTC`}</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#9ac79f', marginBottom: 3 }}>Category: {tx.category || '-'}</div>
                  <div style={{ fontSize: 11, color: '#9ac79f', marginBottom: 3 }}>
                    Confirmations: {Math.max(0, Number(tx.confirmations) || 0)}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ac79f', marginBottom: 3 }}>Time: {formatTxTime(tx.time)}</div>
                  <div style={{ fontSize: 11, color: '#9ac79f', wordBreak: 'break-all' }}>TXID: {tx.txid || '-'}</div>
                  {!!(networkInfo.explorerBaseUrl && tx.txid) && (
                    <button
                      onClick={() => {
                        if (window.wattcoinHardware && window.wattcoinHardware.invoke) {
                          window.wattcoinHardware.invoke(
                            'wattcoin-open-external-url',
                            `${networkInfo.explorerBaseUrl}/tx/${tx.txid}`,
                          );
                        }
                      }}
                      style={{
                        display: 'inline-block',
                        marginTop: 6,
                        fontSize: 11,
                        color: '#60a5fa',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                        textDecoration: 'underline',
                      }}
                    >
                      Open in explorer
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {walletView === 'nfts' && (
        <div style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 700 }}>Wattcoin Vortex NFTs</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={loadNfts}
                disabled={nftsBusy}
                style={{
                  background: nftsBusy ? '#275a2f' : '#4ade80',
                  color: nftsBusy ? '#9fd4a8' : '#001008',
                  border: 'none',
                  borderRadius: 8,
                  padding: '7px 12px',
                  fontWeight: 700,
                  cursor: nftsBusy ? 'default' : 'pointer',
                  fontSize: 12,
                }}
              >
                {nftsBusy ? 'Loading...' : 'Refresh'}
              </button>
            </div>
          </div>

          {nftTransferMsg && (
            <div
              style={{
                marginBottom: 10,
                fontSize: 13,
                color: /^(Failed|Error|Init failed|Init error|Transfer failed|Transfer error)/.test(nftTransferMsg)
                  ? '#fca5a5'
                  : '#86efac',
              }}
            >
              {nftTransferMsg}
            </div>
          )}

          {nfts.length === 0 && !nftsBusy && (
            <div style={{ fontSize: 14, color: '#9ac79f', textAlign: 'center', marginTop: 32 }}>
              No Wattcoin Vortex NFTs found for this address.
            </div>
          )}

          {(() => {
            const TIER_COLORS = { gold: '#fbbf24', silver: '#9ca3af', bronze: '#d97706' };
            const TIER_BG = { gold: '#2d2200', silver: '#1a1a1e', bronze: '#1e0e00' };
            const TIER_LABELS = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' };
            const NFT_IMGS = {
              gold: nftImgGold,
              silver: nftImgSilver,
              bronze: nftImgBronze,
            };
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 14 }}>
                {nfts.map((nft) => {
                  const tier = (nft.metadata && nft.metadata.tier) || 'bronze';
                  const name = (nft.metadata && nft.metadata.name) || nft.nftId;
                  const shares = (nft.metadata && nft.metadata.shares) || 0;
                  const isTransferring = nftTransferTarget === nft.nftId;
                  return (
                    <div
                      key={nft.nftId}
                      style={{
                        background: TIER_BG[tier] || '#0d1a0d',
                        border: `1px solid ${TIER_COLORS[tier] || '#224022'}`,
                        borderRadius: 12,
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column',
                      }}
                    >
                      <img
                        src={NFT_IMGS[tier] || NFT_IMGS.bronze}
                        alt={name}
                        style={{ width: '100%', aspectRatio: '1', objectFit: 'cover', display: 'block' }}
                        onError={(e) => {
                          e.target.style.display = 'none';
                        }}
                      />
                      <div style={{ padding: '10px 12px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 13, fontWeight: 700, color: '#d7ffd9' }}>{name}</span>
                          <span
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: TIER_COLORS[tier],
                              background: `${TIER_COLORS[tier]}22`,
                              borderRadius: 6,
                              padding: '2px 7px',
                            }}
                          >
                            {TIER_LABELS[tier] || tier}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: '#9ac79f' }}>
                          {shares} profit {shares === 1 ? 'share' : 'shares'}
                        </div>
                        <div style={{ fontSize: 10, color: '#6b8f6b', wordBreak: 'break-all' }}>ID: {nft.nftId}</div>
                        {!isTransferring ? (
                          <button
                            onClick={() => {
                              setNftTransferTarget(nft.nftId);
                              setNftTransferAddress('');
                              setNftTransferMsg('');
                            }}
                            style={{
                              marginTop: 6,
                              background: '#1e3a1e',
                              color: '#4ade80',
                              border: '1px solid #4ade80',
                              borderRadius: 8,
                              padding: '6px 10px',
                              fontWeight: 700,
                              cursor: 'pointer',
                              fontSize: 12,
                            }}
                          >
                            Transfer
                          </button>
                        ) : (
                          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                            <input
                              value={nftTransferAddress}
                              onChange={(e) => setNftTransferAddress(e.target.value)}
                              placeholder="Recipient wtc1q..."
                              style={{
                                fontSize: 11,
                                padding: '5px 8px',
                                borderRadius: 6,
                                border: '1px solid #224022',
                                background: '#0d1a0d',
                                color: '#d7ffd9',
                                width: '100%',
                                boxSizing: 'border-box',
                              }}
                            />
                            <div style={{ display: 'flex', gap: 5 }}>
                              <button
                                onClick={() => {
                                  if (!nftTransferAddress.trim()) {
                                    setNftTransferMsg('Please enter a recipient address.');
                                    return;
                                  }
                                  setNftTransferMsg('');
                                  setNftsBusy(true);
                                  window.wattcoinHardware
                                    .invoke('wattcoin-nft-transfer', {
                                      nftId: nft.nftId,
                                      fromAddress: selectedWalletAddress,
                                      toAddress: nftTransferAddress.trim(),
                                    })
                                    .then((res) => {
                                      if (res && res.ok) {
                                        setNftTransferMsg(`Submitted. TXID: ${res.txid || ''}`);
                                        setNftTransferTarget(null);
                                        setNftTransferAddress('');
                                        loadNfts();
                                      } else {
                                        setNftTransferMsg(`Failed: ${(res && res.error) || 'unknown error'}`);
                                      }
                                    })
                                    .catch((e) => {
                                      setNftTransferMsg(`Error: ${e && e.message}`);
                                    })
                                    .finally(() => setNftsBusy(false));
                                }}
                                disabled={nftsBusy}
                                style={{
                                  flex: 1,
                                  background: '#4ade80',
                                  color: '#001008',
                                  border: 'none',
                                  borderRadius: 6,
                                  padding: '6px 0',
                                  fontWeight: 700,
                                  cursor: nftsBusy ? 'default' : 'pointer',
                                  fontSize: 11,
                                }}
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => {
                                  setNftTransferTarget(null);
                                  setNftTransferAddress('');
                                }}
                                style={{
                                  flex: 1,
                                  background: '#1e3a1e',
                                  color: '#b7f5bc',
                                  border: 'none',
                                  borderRadius: 6,
                                  padding: '6px 0',
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                  fontSize: 11,
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
