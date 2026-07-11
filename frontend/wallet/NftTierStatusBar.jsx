import React from 'react';

const NFT_TIER_BRONZE = 5_000;
const NFT_TIER_SILVER = 15_000;
const NFT_TIER_GOLD = 25_000;

export default function NftTierStatusBar({ purchasedWtc = 0 }) {
  const [animPct, setAnimPct] = React.useState(0);
  React.useEffect(() => {
    const pct = (Math.min(Math.max(0, purchasedWtc), NFT_TIER_GOLD) / NFT_TIER_GOLD) * 100;
    const t = setTimeout(() => setAnimPct(pct), 80);
    return () => clearTimeout(t);
  }, [purchasedWtc]);

  const hasBronze = purchasedWtc >= NFT_TIER_BRONZE;
  const hasSilver = purchasedWtc >= NFT_TIER_SILVER;
  const hasGold = purchasedWtc >= NFT_TIER_GOLD;

  // Gradient spanning the full bar (0–25 000 WTC):
  // 0 % = 0 WTC, 20 % = 5 000 (Bronze), 60 % = 15 000 (Silver), 100 % = 25 000 (Gold)
  const fillGradient = 'linear-gradient(90deg, #d97706 0%, #c47a12 20%, #9ca3af 60%, #fbbf24 100%)';
  const glowColor = hasGold ? '#fbbf24' : hasSilver ? '#9ca3af' : '#d97706';

  let toGo = null;
  let toGoTier = '';
  let toGoColor = '#d97706';
  if (!hasBronze) {
    toGo = NFT_TIER_BRONZE - purchasedWtc;
    toGoTier = 'Bronze';
    toGoColor = '#d97706';
  } else if (!hasSilver) {
    toGo = NFT_TIER_SILVER - purchasedWtc;
    toGoTier = 'Silver';
    toGoColor = '#9ca3af';
  } else if (!hasGold) {
    toGo = NFT_TIER_GOLD - purchasedWtc;
    toGoTier = 'Gold';
    toGoColor = '#fbbf24';
  }

  const badges = [
    { label: 'Bronze', color: '#d97706', bg: '#2a1500', reached: hasBronze },
    { label: 'Silver', color: '#9ca3af', bg: '#1a1a1e', reached: hasSilver },
    { label: 'Gold', color: '#fbbf24', bg: '#2d2200', reached: hasGold },
  ];

  return (
    <div
      style={{
        background: '#0a140a',
        border: '1px solid #1e3a1e',
        borderRadius: 12,
        padding: '11px 16px',
        marginBottom: 14,
      }}
    >
      {/* Header row: label + amount + badges | thresholds */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 9,
              color: '#4ade80',
              letterSpacing: '0.1em',
              whiteSpace: 'nowrap',
            }}
          >
            PURCHASED WTC
          </span>
          <span
            style={{ fontSize: 15, fontWeight: 700, color: '#e8f5e8', fontFamily: 'monospace', whiteSpace: 'nowrap' }}
          >
            {Math.floor(purchasedWtc).toLocaleString()}
          </span>
          <div style={{ display: 'flex', gap: 5 }}>
            {badges.map((b) => (
              <span
                key={b.label}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 99,
                  color: b.reached ? b.color : '#3a4a3a',
                  background: b.reached ? b.bg : '#111a11',
                  border: `1px solid ${b.reached ? b.color : '#1e3a1e'}`,
                  boxShadow: b.reached ? `0 0 7px ${b.color}55` : 'none',
                  transition: 'all 0.5s ease',
                  whiteSpace: 'nowrap',
                }}
              >
                {b.label}
              </span>
            ))}
          </div>
        </div>
        {/* Tier thresholds — always visible top-right */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            fontSize: 9,
            fontFamily: "'DM Mono', monospace",
            flexShrink: 0,
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          <span style={{ color: hasBronze ? '#d97706' : '#5a3a10' }}>Bronze&nbsp;5,000</span>
          <span style={{ color: hasSilver ? '#9ca3af' : '#3a3a45' }}>Silver&nbsp;15,000</span>
          <span style={{ color: hasGold ? '#fbbf24' : '#5a4a10' }}>Gold&nbsp;25,000</span>
        </div>
      </div>

      {/* Animated progress bar */}
      <div style={{ height: 7, background: '#172a17', borderRadius: 99, overflow: 'hidden', position: 'relative' }}>
        {/* Tier marker lines */}
        <div
          style={{
            position: 'absolute',
            left: '20%',
            top: 0,
            bottom: 0,
            width: 1,
            background: '#d97706',
            opacity: 0.45,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '60%',
            top: 0,
            bottom: 0,
            width: 1,
            background: '#9ca3af',
            opacity: 0.45,
            zIndex: 1,
            pointerEvents: 'none',
          }}
        />
        {/* Fill */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${animPct}%`,
            background: fillGradient,
            borderRadius: 99,
            transition: 'width 1.3s ease-out',
            boxShadow: animPct > 0 ? `0 0 7px ${glowColor}88` : 'none',
          }}
        />
      </div>

      {/* Bottom row: X WTC to go */}
      <div style={{ marginTop: 5, fontSize: 11, minHeight: 16 }}>
        {toGo !== null ? (
          <>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, color: toGoColor }}>
              {Math.ceil(toGo).toLocaleString()}
            </span>
            <span style={{ color: '#5a7a5a', marginLeft: 4 }}>WTC to {toGoTier}</span>
          </>
        ) : (
          <span style={{ color: '#fbbf24', fontWeight: 700 }}>✦ Gold tier reached</span>
        )}
      </div>
    </div>
  );
}
