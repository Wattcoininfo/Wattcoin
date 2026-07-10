import { useState, useEffect } from 'react';
import { HARDWARE, TIER1_ENERGY, getFairnessLabelWidthPx } from './wattcoinConstants';

export default function FairnessViz() {
  const maxOps = (TIER1_ENERGY * 3600) / HARDWARE[HARDWARE.length - 1].eta;
  const [fairnessLabelWidth, setFairnessLabelWidth] = useState(() => getFairnessLabelWidthPx());

  useEffect(() => {
    let active = true;
    const updateWidth = () => {
      if (active) setFairnessLabelWidth(getFairnessLabelWidthPx());
    };

    updateWidth();
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(updateWidth).catch(() => {});
    }

    return () => {
      active = false;
    };
  }, []);

  const fairnessColumns = `${fairnessLabelWidth}px minmax(0, 1fr) 70px`;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {HARDWARE.map((hw) => {
        const ops = (TIER1_ENERGY * 3600) / hw.eta;
        const barW = Math.log10(ops) / Math.log10(maxOps);
        return (
          <div
            key={hw.id}
            style={{ display: 'grid', gridTemplateColumns: fairnessColumns, gap: '1mm', alignItems: 'center' }}
          >
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#7aaa7a', textAlign: 'left' }}>
              {hw.name}
            </div>
            <div style={{ background: '#0a160a', borderRadius: 3, height: 6, overflow: 'hidden' }}>
              <div style={{ width: `${barW * 100}%`, height: '100%', background: hw.color, borderRadius: 3 }} />
            </div>
            <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#4ade80', textAlign: 'right' }}>
              20 kWh ✓
            </div>
          </div>
        );
      })}
      <div
        style={{
          marginTop: 4,
          padding: '10px 14px',
          background: '#0a160a',
          borderRadius: 8,
          border: '1px solid #1e3a1e',
        }}
      >
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#4ade80' }}>
          Every hardware type consumes exactly 20 kWh per coin in Tier 1. Bar width = operation count (log scale).
        </span>
      </div>
    </div>
  );
}
