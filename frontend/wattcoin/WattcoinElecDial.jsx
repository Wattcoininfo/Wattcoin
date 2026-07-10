import { TIER1_WH } from './wattcoinConstants';

export default function ElecDial({ price, live }) {
  const kwh = '$' + price.toFixed(3);
  const cost = '$' + ((price * TIER1_WH) / 1000).toFixed(2);
  return (
    <div
      title={live ? 'Live global average — globalpetrolprices.com' : 'Estimated global average (live data unavailable)'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontFamily: "'DM Mono', monospace",
        fontSize: 11,
        background: '#0a160a',
        border: '1px solid #1e3a1e',
        borderRadius: 20,
        padding: '4px 10px',
      }}
    >
      <span style={{ color: '#4ade80', fontSize: 10 }}>⚡</span>
      <span style={{ color: '#a7ffb0', letterSpacing: '0.03em' }}>{kwh}</span>
      <span style={{ color: '#4a6a4a' }}>/kWh</span>
      <span style={{ color: '#2a4a2a', margin: '0 2px' }}>·</span>
      <span style={{ color: '#a7ffb0', letterSpacing: '0.03em' }}>{cost}</span>
      <span style={{ color: '#4a6a4a' }}>/WTC</span>
      <span style={{ fontSize: 7, color: live ? '#4ade80' : '#4a6a4a', marginLeft: 2 }}>{live ? '●' : '○'}</span>
    </div>
  );
}
