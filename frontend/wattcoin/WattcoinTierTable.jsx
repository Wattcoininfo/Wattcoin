import { useState } from 'react';
import { TIERS, TOTAL_ENERGY_TWH, TOTAL_SUPPLY, fmtNum, fmtSci, fmtCost, fmtEnergy } from './wattcoinConstants';

export default function TierTable() {
  const [highlight, setHighlight] = useState(null);
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'DM Mono', monospace", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #1e3a1e' }}>
            {['Tier', 'Energy/Coin', 'Block Reward', 'Blocks/Tier', 'Cost @ 18¢/kWh', 'Tier Energy', 'Cumulative'].map(
              (h) => (
                <th
                  key={h}
                  style={{
                    padding: '10px 14px',
                    textAlign: h === 'Tier' ? 'left' : 'right',
                    color: '#4ade80',
                    fontWeight: 500,
                    fontSize: 11,
                    letterSpacing: '0.06em',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {TIERS.map((t) => (
            <tr
              key={t.n}
              onMouseEnter={() => setHighlight(t.n)}
              onMouseLeave={() => setHighlight(null)}
              style={{
                borderBottom: '1px solid #0f1f0f',
                background: highlight === t.n ? '#0d1a0d' : 'transparent',
                transition: 'background 0.15s',
              }}
            >
              <td
                style={{
                  padding: '8px 14px',
                  color: t.n === 0 ? '#fbbf24' : '#4ade80',
                  textAlign: 'left',
                  fontWeight: t.n === 0 ? 700 : 400,
                }}
              >
                {t.n === 0 ? '0 ★' : t.n}
              </td>
              <td style={{ padding: '8px 14px', color: t.n === 0 ? '#fbbf24' : '#e8f5e8', textAlign: 'right' }}>
                {t.n === 0 ? 'Pre-mined' : fmtEnergy(t.epc)}
              </td>
              <td style={{ padding: '8px 14px', color: '#7aaa7a', textAlign: 'right' }}>
                {t.n === 0 ? '—' : fmtSci(t.reward) + ' WTC'}
              </td>
              <td style={{ padding: '8px 14px', color: '#3d5c3d', textAlign: 'right' }}>
                {t.n === 0 ? '—' : fmtNum(t.blocksThisTier)}
              </td>
              <td style={{ padding: '8px 14px', color: highlight === t.n ? '#4ade80' : '#a0c8a0', textAlign: 'right' }}>
                {t.n === 0 ? '—' : fmtCost(t.costAt18)}
              </td>
              <td style={{ padding: '8px 14px', color: '#3d5c3d', textAlign: 'right' }}>
                {t.tierEnergyTWh.toFixed(0)} TWh
              </td>
              <td style={{ padding: '8px 14px', color: '#7aaa7a', textAlign: 'right' }}>{fmtNum(t.cumulative)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: '1px solid #2e4a2e' }}>
            <td colSpan={5} style={{ padding: '10px 14px', color: '#4ade80', fontWeight: 700 }}>
              TOTAL
            </td>
            <td style={{ padding: '10px 14px', color: '#4ade80', textAlign: 'right', fontWeight: 700 }}>
              {TOTAL_ENERGY_TWH.toFixed(0)} TWh
            </td>
            <td style={{ padding: '10px 14px', color: '#e8f5e8', textAlign: 'right', fontWeight: 700 }}>
              {fmtNum(TOTAL_SUPPLY)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
