import { useState } from 'react';
import {
  TOTAL_ENERGY_TWH,
  TOTAL_SUPPLY,
  TIER1_ENERGY,
  BASE_REWARD,
  NETWORK_POWERS,
  fmtNum,
  fmtYears,
} from './wattcoinConstants';
import { MetricCard } from './WattcoinUI';

export default function MiningCalculator() {
  const [powerGW, setPowerGW] = useState(12.5);
  const totalWh = TOTAL_ENERGY_TWH * 1e12;
  const years = totalWh / (powerGW * 1e9) / 24 / 365.25;
  const blockEnergyWh = TIER1_ENERGY * BASE_REWARD; // 20 MWh per block at T1
  const blockS = (blockEnergyWh / (powerGW * 1e9)) * 3600;
  const blockTimeStr =
    blockS < 1
      ? blockS.toFixed(3) + 's'
      : blockS < 60
        ? blockS.toFixed(1) + 's'
        : blockS < 3600
          ? (blockS / 60).toFixed(1) + 'm'
          : (blockS / 3600).toFixed(2) + 'h';

  return (
    <div style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 16, padding: 32 }}>
      <div style={{ marginBottom: 24 }}>
        <label
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            color: '#4ade80',
            letterSpacing: '0.1em',
            display: 'block',
            marginBottom: 12,
          }}
        >
          NETWORK POWER: {powerGW.toFixed(3)} GW
        </label>
        <input
          type="range"
          min={0.001}
          max={50}
          step={0.001}
          value={powerGW}
          onChange={(e) => setPowerGW(parseFloat(e.target.value))}
          style={{ width: '100%', accentColor: '#4ade80' }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: "'DM Mono', monospace",
            fontSize: 10,
            color: '#3d5c3d',
            marginTop: 4,
          }}
        >
          <span>1 MW</span>
          <span>25 GW (½ global)</span>
          <span>50 GW</span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24 }}>
        <MetricCard label="Time to mine all" value={fmtYears(years)} sub={fmtNum(TOTAL_SUPPLY) + ' WTC'} />
        <MetricCard label="Total energy" value={TOTAL_ENERGY_TWH.toFixed(0) + ' TWh'} sub="to mine all coins" />
        <MetricCard label="Block time (T1+)" value={blockTimeStr} sub="emergent from network power" />
      </div>
      <div style={{ borderTop: '1px solid #1e3a1e', paddingTop: 20 }}>
        <div
          style={{
            fontFamily: "'DM Mono', monospace",
            fontSize: 11,
            color: '#4ade80',
            marginBottom: 12,
            letterSpacing: '0.06em',
          }}
        >
          REFERENCE POINTS
        </div>
        <div style={{ display: 'grid', gap: 6 }}>
          {NETWORK_POWERS.map((np) => {
            const y = totalWh / np.w / 24 / 365.25;
            return (
              <div
                key={np.label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '6px 0',
                  borderBottom: '1px solid #0f1f0f',
                }}
              >
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#7aaa7a' }}>{np.label}</span>
                <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#e8f5e8' }}>
                  {fmtYears(y)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
