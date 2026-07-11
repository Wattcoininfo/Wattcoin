import React, { useCallback } from 'react';
import { TIER1_ENERGY } from '../wattcoin/wattcoinConstants';
import { SALE_TOTAL, SALE_TIER_SIZE, SALE_TIERS } from './walletConstants';
import WalletPayModal from './WalletPayModal';

export default function SaleView({
  selectedWalletAddress,
  setQueuedSaleOrders,
  orderId,
  setOrderId,
  orderStatus,
  setOrderStatus,
  orderPollRef,
  startOrderPoll,
}) {
  const [soldWtc, setSoldWtc] = React.useState(null);
  const [electricityPrice, setElectricityPrice] = React.useState(null);
  const [electricitySource, setElectricitySource] = React.useState(null);
  const [busy, setBusy] = React.useState(true);
  const [status, setStatus] = React.useState('');
  const [lastEtherscanPoll, setLastEtherscanPoll] = React.useState(null);

  // Buy form
  const [buyAmount, setBuyAmount] = React.useState('');
  const [usdcRequired, setUsdcRequired] = React.useState(null);
  const [priceLoading, setPriceLoading] = React.useState(false);
  const [orderMsg, setOrderMsg] = React.useState('');
  const [orderError, setOrderError] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  const [buyToAddress, setBuyToAddress] = React.useState(selectedWalletAddress || '');
  const [localAddresses, setLocalAddresses] = React.useState([]);
  const [showWalletModal, setShowWalletModal] = React.useState(false);
  const [optimisticPaid, setOptimisticPaid] = React.useState(false);
  const [buyerEthAddress, setBuyerEthAddress] = React.useState(''); // ETH address buyer will send USDC from

  // Sync buyToAddress with prop on first load
  React.useEffect(() => {
    if (selectedWalletAddress) setBuyToAddress((prev) => prev || selectedWalletAddress);
  }, [selectedWalletAddress]);

  // Load wallet addresses for the delivery address picker
  React.useEffect(() => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    window.wattcoinHardware
      .invoke('wattcoin-get-addresses')
      .then((res) => {
        if (res && res.ok && Array.isArray(res.addresses) && res.addresses.length > 0) {
          setLocalAddresses(res.addresses);
          setBuyToAddress((prev) => prev || res.addresses[0]);
        }
      })
      .catch(() => {});
  }, []);

  const SELLER_USDC = '0x0ca8cc23d85e5c988828076978c4ca65aa4293e8';
  const MIN_BUY = 1;

  // Coins sold = from sale-status IPC (on-chain sent + queued/paid)
  const soldRaw = soldWtc;
  const sold = soldRaw === null ? null : Math.max(0, Math.min(SALE_TOTAL, Number(soldRaw) || 0));

  const activeTierIdx =
    sold === null ? 0 : sold >= SALE_TOTAL ? -1 : sold < SALE_TIER_SIZE ? 0 : sold < 2 * SALE_TIER_SIZE ? 1 : 2;

  // ── Load sale status & electricity price ─────────────────────────────────
  const loadSaleData = useCallback(async () => {
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) {
      setStatus('Wallet API unavailable.');
      setBusy(false);
      return;
    }
    try {
      const [elRes, saleRes] = await Promise.all([
        window.wattcoinHardware.invoke('wattcoin-get-electricity-price'),
        window.wattcoinHardware.invoke('wattcoin-sale-status'),
      ]);
      if (saleRes && saleRes.ok) {
        setSoldWtc(saleRes.sold ?? 0);
      } else {
        setStatus('Could not load sale data.');
      }
      if (elRes && elRes.ok && elRes.price != null) {
        setElectricityPrice(elRes.price);
        setElectricitySource(elRes.source || null);
      }
      if (saleRes && saleRes.ok && saleRes.lastEtherscanPoll) {
        setLastEtherscanPoll(saleRes.lastEtherscanPoll);
      }
    } catch (e) {
      setStatus('Error loading sale data.');
    }
    setBusy(false);
  }, []);

  React.useEffect(() => {
    loadSaleData();
    return () => {
      if (orderPollRef.iv) clearInterval(orderPollRef.iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On mount (and whenever the delivery address is resolved), check for any existing
  // active order for this address — covers web-wallet orders that were synced by the
  // miner node but the Electron Buy tab never knew about.
  const _checkedOrderAddr = React.useRef(null);
  React.useEffect(() => {
    if (!buyToAddress || orderStatus || _checkedOrderAddr.current === buyToAddress) return;
    if (!(window.wattcoinHardware && window.wattcoinHardware.invoke)) return;
    _checkedOrderAddr.current = buyToAddress;
    window.wattcoinHardware
      .invoke('wattcoin-sale-get-my-orders', buyToAddress)
      .then((res) => {
        if (!res || !res.ok || !Array.isArray(res.orders) || res.orders.length === 0) return;
        // Only restore orders that still need user action (awaiting or submitted payment).
        // Queued/fulfilled/cancelled orders have already been acted on — don't re-show them.
        const actionable = res.orders.filter((o) => o.status === 'pending_payment' || o.status === 'payment_submitted');
        if (actionable.length === 0) return;
        const sorted = [...actionable].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        const existing = sorted[0];
        setOrderId(existing.id);
        setOrderStatus(existing);
        startOrderPoll(existing.id, {
          onConfirmed: () => {
            loadSaleData();
            setOrderMsg('');
            setOrderError('');
            setBuyAmount('');
            setUsdcRequired(null);
            setOptimisticPaid(false);
            setShowWalletModal(false);
          },
          onFulfilled: () => {
            loadSaleData();
            setOrderMsg('Payment received and WTC sent! Check your wallet balance.');
          },
          onFailed: () => {
            setOrderError('Fulfillment failed — please contact support with your order ID.');
          },
          onExpired: () => {
            setOrderError('Order expired (no payment received within 24 h). Please try again.');
          },
        });
      })
      .catch(() => {});
  }, [buyToAddress, orderStatus, setOrderId, setOrderStatus, startOrderPoll, loadSaleData]);

  // ── Recompute price when amount or electricity changes ─────────────────
  React.useEffect(() => {
    setUsdcRequired(null);
    if (!buyAmount || !electricityPrice) return;
    const amount = Number(buyAmount);
    if (!Number.isFinite(amount) || amount < MIN_BUY) return;

    setPriceLoading(true);
    window.wattcoinHardware
      .invoke('wattcoin-sale-compute-price', {
        wtcAmount: amount,
        electricityPricePerKwh: electricityPrice,
      })
      .then((r) => {
        if (r && r.ok) setUsdcRequired(r.usdcRequired);
      })
      .catch(() => {})
      .finally(() => setPriceLoading(false));
  }, [buyAmount, electricityPrice]);

  // ── Poll order status after placing ──────────────────────────────────────
  // (moved to WalletTab)
  // ── Place order ───────────────────────────────────────────────────────────
  async function handlePlaceOrder() {
    if (!buyToAddress) {
      setOrderError('No wallet address selected.');
      return;
    }
    const amount = Number(buyAmount);
    if (!Number.isFinite(amount) || amount < MIN_BUY) {
      setOrderError(`Minimum purchase is ${MIN_BUY} WTC.`);
      return;
    }
    if (!usdcRequired) {
      setOrderError('Price not loaded yet. Please wait a moment.');
      return;
    }
    setOrderError('');
    setOrderMsg('');
    try {
      const r = await window.wattcoinHardware.invoke('wattcoin-sale-place-order', {
        wtcAddress: buyToAddress,
        wtcAmount: amount,
        usdcRequired: usdcRequired,
        buyerEthAddress: buyerEthAddress || null,
      });
      if (r && r.ok) {
        loadSaleData();
        setOrderId(r.orderId);
        setOrderMsg('');
        if (r.alreadyExists) {
          // An existing order was returned — fetch its real current status immediately
          // to avoid flashing stale payment instructions (e.g. old $6 USDC for a queued order).
          let resolvedStatus = r.existingStatus || 'pending_payment';
          try {
            const ord = await window.wattcoinHardware.invoke('wattcoin-sale-get-order', r.orderId);
            if (ord && ord.ok && ord.order) {
              setOrderStatus(ord.order);
              resolvedStatus = ord.order.status;
            } else {
              setOrderStatus({
                status: resolvedStatus,
                wtcAmount: r.wtcAmount || amount,
                usdcRequired: r.usdcRequired,
                id: r.orderId,
              });
            }
          } catch (_) {
            setOrderStatus({
              status: resolvedStatus,
              wtcAmount: r.wtcAmount || amount,
              usdcRequired: r.usdcRequired,
              id: r.orderId,
            });
          }
          // Only open payment modal if genuinely awaiting payment
          if (resolvedStatus === 'pending_payment') setShowWalletModal(true);
        } else {
          setOrderStatus({ status: 'pending_payment', wtcAmount: amount, usdcRequired: r.usdcRequired, id: r.orderId });
          setShowWalletModal(true);
        }
        startOrderPoll(r.orderId, {
          onConfirmed: () => {
            loadSaleData();
            setOrderMsg('');
            setOrderError('');
            setBuyAmount('');
            setUsdcRequired(null);
            setOptimisticPaid(false);
            setShowWalletModal(false);
          },
          onFulfilled: () => {
            loadSaleData();
            setOrderMsg('Payment received and WTC sent! Check your wallet balance.');
          },
          onFailed: () => {
            setOrderError('Fulfillment failed — please contact support with your order ID.');
          },
          onExpired: () => {
            setOrderError('Order expired (no payment received within 24 h). Please try again.');
          },
        });
      } else {
        setOrderError(r && r.error ? r.error : 'Failed to place order.');
      }
    } catch (e) {
      setOrderError(e && e.message ? e.message : 'Unexpected error.');
    }
  }

  function handleCancelOrder() {
    if (!orderId) return;
    const cancellingId = orderId;
    window.wattcoinHardware
      .invoke('wattcoin-sale-cancel-order', cancellingId)
      .then((r) => {
        if (r && r.ok) {
          loadSaleData();
          if (orderPollRef.iv) {
            clearInterval(orderPollRef.iv);
            orderPollRef.iv = null;
          }
          setOrderId(null);
          setOrderStatus(null);
          setOrderMsg('Order cancelled.');
          setQueuedSaleOrders((prev) => prev.filter((o) => o.id !== cancellingId));
        }
      })
      .catch(() => {});
  }

  function copyUsdc() {
    navigator.clipboard
      .writeText(SELLER_USDC)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {});
  }

  const ENERGY_PER_WTC_KWH = TIER1_ENERGY / 1000; // 20 kWh

  return (
    <div style={{ marginTop: 4 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
        <div style={{ fontSize: 16, color: '#4ade80', fontWeight: 700 }}>WTC Sale</div>
        {lastEtherscanPoll &&
          lastEtherscanPoll.at &&
          (() => {
            const ok = lastEtherscanPoll.result === 'ok';
            const d = new Date(lastEtherscanPoll.at);
            const timeStr =
              d.getFullYear() +
              '-' +
              String(d.getMonth() + 1).padStart(2, '0') +
              '-' +
              String(d.getDate()).padStart(2, '0') +
              ' ' +
              String(d.getHours()).padStart(2, '0') +
              ':' +
              String(d.getMinutes()).padStart(2, '0') +
              ':' +
              String(d.getSeconds()).padStart(2, '0');
            const label = ok ? 'OK' : lastEtherscanPoll.result || 'ERR';
            return (
              <div
                title={`Last Etherscan USDC check: ${label}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 10,
                  color: '#4a6a4a',
                  fontFamily: 'monospace',
                }}
              >
                <span style={{ color: ok ? '#4ade80' : '#fca5a5' }}>{ok ? '\u25cf' : '\u25cf'}</span>
                <span>Etherscan {timeStr}</span>
                <span style={{ color: ok ? '#4ade80' : '#fca5a5' }}>{label}</span>
              </div>
            );
          })()}
        {electricityPrice !== null && (
          <div
            title={electricitySource === 'live' ? 'Live global average - globalpetrolprices.com' : 'Estimated/cached'}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              background: '#0a1f0a',
              border: '1px solid #1e3a1e',
              borderRadius: 6,
              padding: '4px 10px',
              cursor: 'default',
            }}
          >
            <span style={{ fontSize: 11, color: electricitySource === 'live' ? '#4ade80' : '#6b9b6b' }}>&#9889;</span>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#a7ffb0' }}>
              ${electricityPrice.toFixed(3)}
              <span style={{ color: '#4a6a4a' }}>/kWh</span>
            </span>
            <span style={{ fontSize: 9, color: electricitySource === 'live' ? '#4ade80' : '#4a6a4a', marginLeft: 2 }}>
              {electricitySource === 'live' ? '\u25cf' : '\u25cb'}
            </span>
            {(() => {
              const costPerWtc = electricityPrice * ENERGY_PER_WTC_KWH;
              return (
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#6b9b6b', marginLeft: 4 }}>
                  mining cost {costPerWtc >= 1 ? `$${costPerWtc.toFixed(2)}` : `$${costPerWtc.toFixed(4)}`}/WTC
                </span>
              );
            })()}
          </div>
        )}
      </div>

      {status && <div style={{ color: '#fca5a5', fontSize: 13, marginBottom: 12 }}>{status}</div>}
      {busy && !status && <div style={{ color: '#6b9b6b', fontSize: 13, marginBottom: 12 }}>Loading...</div>}

      {/* Overall progress bar */}
      {sold !== null && (
        <div style={{ marginBottom: 22 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11,
              color: '#6b9b6b',
              marginBottom: 5,
            }}
          >
            <span>{sold.toLocaleString()} WTC sold</span>
            <span>{Math.max(0, SALE_TOTAL - sold).toLocaleString()} WTC remaining</span>
          </div>
          <div
            style={{
              height: 10,
              background: '#122612',
              borderRadius: 999,
              overflow: 'hidden',
              border: '1px solid #1e3a1e',
              position: 'relative',
            }}
          >
            {[1 / 3, 2 / 3].map((frac) => (
              <div
                key={frac}
                style={{
                  position: 'absolute',
                  left: `${frac * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: 1,
                  background: '#4ade8040',
                  zIndex: 1,
                }}
              />
            ))}
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, (sold / SALE_TOTAL) * 100)}%`,
                background: 'linear-gradient(90deg, #4ade80, #22c55e)',
                transition: 'width 0.4s ease',
                borderRadius: 999,
              }}
            />
          </div>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#4a6a4a', marginTop: 3 }}
          >
            <span>0</span>
            <span>111,111</span>
            <span>222,222</span>
            <span>333,333</span>
          </div>
        </div>
      )}

      {/* Tier cards */}
      <div style={{ display: 'grid', gap: 10, marginBottom: 24 }}>
        {SALE_TIERS.map((t) => {
          const isActive = sold !== null && activeTierIdx >= 0 && t.idx === activeTierIdx;
          const isCompleted = sold !== null && sold >= t.end;
          const tierSold = sold === null ? 0 : Math.min(SALE_TIER_SIZE, Math.max(0, sold - t.start));
          const tierPct = Math.min(100, (tierSold / SALE_TIER_SIZE) * 100);
          const priceLabel = t.idx === 0 ? '1/3 mining cost' : t.idx === 1 ? '2/3 mining cost' : 'Full mining cost';
          const usdPrice = electricityPrice !== null ? electricityPrice * ENERGY_PER_WTC_KWH * t.fraction : null;

          return (
            <div
              key={t.idx}
              style={{
                background: isActive ? '#0a1f0a' : '#0d160d',
                border: `1px solid ${isActive ? '#4ade80' : isCompleted ? '#2d4a2d' : '#1e3a1e'}`,
                borderRadius: 12,
                padding: '14px 16px',
                opacity: isCompleted ? 0.65 : 1,
                transition: 'border-color 0.2s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 14, color: isActive ? '#4ade80' : '#9ac79f' }}>
                    {t.label}
                  </span>
                  {isActive && (
                    <span
                      style={{
                        fontSize: 10,
                        background: '#4ade80',
                        color: '#001008',
                        borderRadius: 999,
                        padding: '2px 7px',
                        fontWeight: 700,
                      }}
                    >
                      ACTIVE
                    </span>
                  )}
                  {isCompleted && (
                    <span
                      style={{
                        fontSize: 10,
                        background: '#2d4a2d',
                        color: '#4a9a4a',
                        borderRadius: 999,
                        padding: '2px 7px',
                        fontWeight: 700,
                      }}
                    >
                      SOLD OUT
                    </span>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 13, color: '#fcd34d', fontWeight: 700 }}>
                    {usdPrice !== null
                      ? usdPrice >= 1
                        ? `~$${usdPrice.toFixed(2)}`
                        : `~$${usdPrice.toFixed(4)}`
                      : `${Math.round(t.fraction * 100)}%`}
                  </span>
                  <span style={{ fontSize: 10, color: '#6b9b6b', marginLeft: 4 }}>/WTC</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#6b9b6b', marginBottom: 8 }}>
                {t.start.toLocaleString()} – {t.end.toLocaleString()} WTC &nbsp;&middot;&nbsp; {priceLabel}
              </div>
              <div
                style={{
                  height: 6,
                  background: '#122612',
                  borderRadius: 999,
                  overflow: 'hidden',
                  border: '1px solid #1e3a1e',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${tierPct}%`,
                    background: isCompleted ? '#2d4a2d' : 'linear-gradient(90deg, #4ade80, #22c55e)',
                    transition: 'width 0.4s ease',
                    borderRadius: 999,
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10,
                  color: '#4a6a4a',
                  marginTop: 3,
                }}
              >
                <span>{tierSold.toLocaleString()} sold</span>
                <span>{Math.max(0, SALE_TIER_SIZE - tierSold).toLocaleString()} left</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Buy form / order status ─────────────────────────────────────── */}
      {!orderStatus ? (
        <div style={{ background: '#0a1f0a', border: '1px solid #1e3a1e', borderRadius: 14, padding: '18px 20px' }}>
          <div style={{ fontSize: 14, color: '#4ade80', fontWeight: 700, marginBottom: 14 }}>Buy WTC</div>

          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                display: 'block',
                marginBottom: 6,
                fontSize: 11,
                color: '#9ac79f',
                letterSpacing: '0.06em',
                fontFamily: 'monospace',
              }}
            >
              DELIVER WTC TO
            </label>
            {localAddresses.length > 1 ? (
              <select
                value={buyToAddress}
                onChange={(e) => setBuyToAddress(e.target.value)}
                style={{
                  width: 'auto',
                  background: '#0d160d',
                  border: '1px solid #2d4a2d',
                  borderRadius: 8,
                  padding: '9px 12px',
                  color: '#a7ffb0',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                {localAddresses.map((addr) => (
                  <option key={addr} value={addr}>
                    {addr}
                  </option>
                ))}
              </select>
            ) : (
              <div
                style={{
                  display: 'inline-block',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: buyToAddress ? '#a7ffb0' : '#fca5a5',
                  background: '#0d160d',
                  border: `1px solid ${buyToAddress ? '#1e3a1e' : '#4a1a1a'}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                }}
              >
                {buyToAddress || 'No wallet address found. Create a wallet first.'}
              </div>
            )}
          </div>

          <div style={{ marginBottom: 14 }}>
            <label
              style={{
                display: 'block',
                marginBottom: 6,
                fontSize: 11,
                color: '#9ac79f',
                letterSpacing: '0.06em',
                fontFamily: 'monospace',
              }}
            >
              YOUR USDC WALLET ADDRESS <span style={{ color: '#fbbf24' }}>(required)</span>
            </label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="text"
                value={buyerEthAddress}
                onChange={(e) => setBuyerEthAddress(e.target.value.trim())}
                placeholder="0x..."
                spellCheck={false}
                style={{
                  width: '44ch',
                  background: '#0d160d',
                  border: `1px solid ${buyerEthAddress && (!buyerEthAddress.startsWith('0x') || buyerEthAddress.length < 40) ? '#4a1a1a' : '#2d4a2d'}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                  color: '#a7ffb0',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  outline: 'none',
                }}
              />
              <button
                onClick={() =>
                  navigator.clipboard
                    .readText()
                    .then((t) => setBuyerEthAddress(t.trim()))
                    .catch(() => {})
                }
                style={{
                  background: '#1e3a1e',
                  color: '#a7ffb0',
                  border: '1px solid #2d4a2d',
                  borderRadius: 8,
                  padding: '9px 12px',
                  fontSize: 11,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Paste
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#4a6a4a', marginTop: 4 }}>
              The Ethereum address you will send USDC from — used to match your payment automatically.
            </div>
          </div>

          <label style={{ display: 'block', marginBottom: 6, fontSize: 12, color: '#9ac79f' }}>
            Amount (WTC) — minimum {MIN_BUY}
          </label>
          <input
            type="number"
            min={MIN_BUY}
            step="1"
            value={buyAmount}
            onChange={(e) => setBuyAmount(e.target.value)}
            placeholder={`e.g. 500`}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              background: '#0d160d',
              border: '1px solid #2d4a2d',
              borderRadius: 8,
              padding: '10px 12px',
              color: '#a7ffb0',
              fontFamily: 'monospace',
              fontSize: 14,
              outline: 'none',
            }}
          />

          {/* Price preview */}
          <div style={{ marginTop: 10, marginBottom: 14, minHeight: 28 }}>
            {priceLoading && <span style={{ fontSize: 12, color: '#6b9b6b' }}>Computing price...</span>}
            {!priceLoading && usdcRequired !== null && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 20, fontWeight: 700, color: '#fcd34d', fontFamily: 'monospace' }}>
                  ${usdcRequired.toFixed(2)}
                </span>
                <span style={{ fontSize: 12, color: '#6b9b6b' }}>USDC</span>
                <span style={{ fontSize: 11, color: '#4a6a4a', marginLeft: 4 }}>
                  (${(usdcRequired / Number(buyAmount || 1)).toFixed(4)}/WTC)
                </span>
              </div>
            )}
          </div>

          {orderError && <div style={{ color: '#fca5a5', fontSize: 12, marginBottom: 10 }}>{orderError}</div>}
          {orderMsg && <div style={{ color: '#4ade80', fontSize: 12, marginBottom: 10 }}>{orderMsg}</div>}

          {usdcRequired && (
            <div
              style={{
                fontSize: 11,
                color: '#6b9b6b',
                marginBottom: 10,
                lineHeight: 1.5,
                background: '#0d160d',
                border: '1px solid #1e3a1e',
                borderRadius: 8,
                padding: '8px 12px',
              }}
            >
              WTC will be sent to your wallet once 10,101 WTC is queued.
            </div>
          )}

          <button
            disabled={
              !usdcRequired ||
              !buyToAddress ||
              priceLoading ||
              !buyerEthAddress ||
              !buyerEthAddress.startsWith('0x') ||
              buyerEthAddress.length < 40
            }
            onClick={handlePlaceOrder}
            style={{
              width: '100%',
              padding: '12px 0',
              borderRadius: 10,
              border: 'none',
              background:
                !usdcRequired ||
                !buyToAddress ||
                priceLoading ||
                !buyerEthAddress ||
                !buyerEthAddress.startsWith('0x') ||
                buyerEthAddress.length < 40
                  ? '#1e3a1e'
                  : '#4ade80',
              color:
                !usdcRequired ||
                !buyToAddress ||
                priceLoading ||
                !buyerEthAddress ||
                !buyerEthAddress.startsWith('0x') ||
                buyerEthAddress.length < 40
                  ? '#4a6a4a'
                  : '#001008',
              fontWeight: 700,
              fontSize: 14,
              cursor:
                !usdcRequired ||
                !buyToAddress ||
                priceLoading ||
                !buyerEthAddress ||
                !buyerEthAddress.startsWith('0x') ||
                buyerEthAddress.length < 40
                  ? 'not-allowed'
                  : 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {priceLoading
              ? 'Computing...'
              : !buyerEthAddress
                ? 'Enter your USDC wallet address'
                : usdcRequired
                  ? `Place Order — Pay $${usdcRequired.toFixed(2)} USDC`
                  : 'Enter amount to see price'}
          </button>
        </div>
      ) : (
        /* ── Active order card ─────────────────────────────────────────── */
        <div
          style={{
            background: '#0a1f0a',
            border: `1px solid ${orderStatus.status === 'fulfilled' ? '#4ade80' : optimisticPaid || orderStatus.status === 'payment_submitted' ? '#a7ffb0' : '#fbbf24'}`,
            borderRadius: 14,
            padding: '18px 20px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 700,
                color:
                  orderStatus.status === 'fulfilled'
                    ? '#4ade80'
                    : optimisticPaid || orderStatus.status === 'payment_submitted'
                      ? '#a7ffb0'
                      : '#fbbf24',
              }}
            >
              {(optimisticPaid || orderStatus.status === 'payment_submitted') &&
                orderStatus.status !== 'queued' &&
                orderStatus.status !== 'fulfilled' &&
                'Payment Submitted — Pending Delivery'}
              {!optimisticPaid && orderStatus.status === 'pending_payment' && 'Awaiting Payment'}
              {orderStatus.status === 'queued' && 'Payment Received — Queued'}
              {orderStatus.status === 'fulfilled' && 'Complete!'}
              {orderStatus.status === 'failed' && 'Failed'}
              {orderStatus.status === 'expired' && 'Expired'}
            </div>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#4a6a4a' }}>{orderStatus.id}</span>
          </div>

          <div style={{ fontSize: 13, color: '#9ac79f', marginBottom: 14 }}>
            {orderStatus.wtcAmount?.toLocaleString()} WTC &rarr;{' '}
            <span style={{ fontFamily: 'monospace' }}>{orderStatus.wtcAddress || selectedWalletAddress}</span>
          </div>

          {orderStatus.status === 'pending_payment' && !optimisticPaid && (
            <>
              <div
                style={{
                  padding: '12px 14px',
                  background: '#091409',
                  border: '1px solid #2d4a2d',
                  borderRadius: 10,
                  marginBottom: 14,
                }}
              >
                <div style={{ fontSize: 13, color: '#fde68a', fontWeight: 700, marginBottom: 4 }}>
                  {orderStatus.wtcAmount?.toLocaleString()} WTC awaiting payment
                </div>
                <div style={{ fontSize: 11, color: '#6b9b6b', marginBottom: 8 }}>
                  Send exactly{' '}
                  <span style={{ color: '#fcd34d', fontWeight: 700 }}>
                    ${orderStatus.usdcRequired?.toFixed(2)} USDC
                  </span>{' '}
                  (Ethereum mainnet ERC-20) to:
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    background: '#0d160d',
                    border: '1px solid #2d4a2d',
                    borderRadius: 6,
                    padding: '7px 10px',
                    marginBottom: 8,
                  }}
                >
                  <span
                    style={{ fontFamily: 'monospace', fontSize: 11, color: '#a7ffb0', wordBreak: 'break-all', flex: 1 }}
                  >
                    {SELLER_USDC}
                  </span>
                  <button
                    onClick={copyUsdc}
                    style={{
                      background: copied ? '#4ade80' : '#1e3a1e',
                      color: copied ? '#001008' : '#b7f5bc',
                      border: 'none',
                      borderRadius: 6,
                      padding: '3px 8px',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <div style={{ fontSize: 11, color: '#4a6a4a' }}>Payment detected automatically within ~10 minutes.</div>
              </div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button
                  onClick={() => setShowWalletModal(true)}
                  style={{
                    background: '#1e3a1e',
                    color: '#a7ffb0',
                    border: '1px solid #4ade80',
                    borderRadius: 8,
                    padding: '9px 18px',
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  Pay with Wallet
                </button>
                <button
                  onClick={handleCancelOrder}
                  style={{
                    background: 'transparent',
                    color: '#6b9b6b',
                    border: '1px solid #2d4a2d',
                    borderRadius: 8,
                    padding: '9px 14px',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel Order
                </button>
              </div>
            </>
          )}

          {(orderStatus.status === 'queued' ||
            orderStatus.status === 'payment_submitted' ||
            (optimisticPaid && orderStatus.status === 'pending_payment')) && (
            <div style={{ padding: '12px 14px', background: '#091409', border: '1px solid #2d4a2d', borderRadius: 10 }}>
              <div style={{ fontSize: 13, color: '#a7ffb0', fontWeight: 700, marginBottom: 4 }}>
                {orderStatus.wtcAmount?.toLocaleString()} WTC pending delivery
              </div>
              <div style={{ fontSize: 11, color: '#6b9b6b' }}>
                Payment confirmed — WTC will be sent once block is mined.
              </div>
              {(orderStatus.status === 'payment_submitted' ||
                (optimisticPaid && orderStatus.status === 'pending_payment')) && (
                <div style={{ fontSize: 11, color: '#7a6a3a', marginTop: 4 }}>
                  Payment detection may take up to 10 minutes.
                </div>
              )}
            </div>
          )}

          {orderMsg && <div style={{ marginTop: 12, fontSize: 13, color: '#4ade80', fontWeight: 600 }}>{orderMsg}</div>}
          {orderError && <div style={{ marginTop: 12, fontSize: 13, color: '#fca5a5' }}>{orderError}</div>}

          {(orderStatus.status === 'queued' ||
            orderStatus.status === 'payment_submitted' ||
            (optimisticPaid && orderStatus.status === 'pending_payment') ||
            orderStatus.status === 'fulfilled' ||
            orderStatus.status === 'failed' ||
            orderStatus.status === 'expired' ||
            orderStatus.status === 'cancelled') && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
              <button
                onClick={() => {
                  if (orderPollRef.iv) {
                    clearInterval(orderPollRef.iv);
                    orderPollRef.iv = null;
                  }
                  setOrderId(null);
                  setOrderStatus(null);
                  setOrderMsg('');
                  setOrderError('');
                  setBuyAmount('');
                  setUsdcRequired(null);
                  setOptimisticPaid(false);
                  setShowWalletModal(false);
                }}
                style={{
                  background: '#1e3a1e',
                  color: '#b7f5bc',
                  border: 'none',
                  borderRadius: 8,
                  padding: '9px 18px',
                  fontWeight: 700,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                {orderStatus.status === 'queued' ||
                orderStatus.status === 'payment_submitted' ||
                (optimisticPaid && orderStatus.status === 'pending_payment')
                  ? 'Place New Order'
                  : 'Place Another Order'}
              </button>
              {(orderStatus.status === 'queued' ||
                orderStatus.status === 'payment_submitted' ||
                (optimisticPaid && orderStatus.status === 'pending_payment')) && (
                <button
                  onClick={handleCancelOrder}
                  style={{
                    background: 'transparent',
                    color: '#6b9b6b',
                    border: '1px solid #2d4a2d',
                    borderRadius: 8,
                    padding: '9px 14px',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Cancel Order
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 11, color: '#4a6a4a', lineHeight: 1.5 }}>
        Prices are in USD based on live global average electricity cost to mine WTC.
      </div>

      {showWalletModal && orderStatus && (
        <WalletPayModal
          orderId={orderId}
          usdcRequired={orderStatus.usdcRequired || 0}
          wtcAmount={orderStatus.wtcAmount}
          onPaid={() => {
            setOptimisticPaid(true);
            setShowWalletModal(false);
          }}
          onManual={() => {
            setOptimisticPaid(true);
            setShowWalletModal(false);
          }}
          onClose={() => setShowWalletModal(false)}
        />
      )}
    </div>
  );
}
