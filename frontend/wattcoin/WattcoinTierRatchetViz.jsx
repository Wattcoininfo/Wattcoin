import { TIERS } from './wattcoinConstants';

export default function TierRatchetViz() {
  const activeTiers = TIERS.filter((t) => t.n >= 1 && t.n <= 8);
  const maxEpc = activeTiers[activeTiers.length - 1].epc;
  return (
    <div
      style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 120, padding: '0 0 8px 0', margin: '28px 0' }}
    >
      {activeTiers.map((t) => {
        const pct = (t.epc / maxEpc) * 100;
        const label = t.epc >= 1e6 ? `${(t.epc / 1e6).toFixed(2)} MWh` : `${(t.epc / 1e3).toFixed(0)} kWh`;
        const green = Math.round(0x6e + ((0xde - 0x6e) * (t.n - 1)) / 7);
        const color = `rgb(74,${green},128)`;
        return (
          <div key={t.n} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 9,
                color: '#4ade80',
                writingMode: 'vertical-rl',
                transform: 'rotate(180deg)',
                whiteSpace: 'nowrap',
                marginBottom: 2,
              }}
            >
              {label}
            </div>
            <div
              style={{
                width: '100%',
                background: color,
                borderRadius: '4px 4px 0 0',
                height: `${pct.toFixed(0)}%`,
                minHeight: 6,
                opacity: 0.85,
              }}
            />
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 9, color: '#3d5c3d' }}>T{t.n}</div>
          </div>
        );
      })}
    </div>
  );
}
