import { HARDWARE, TIER0_ENERGY, TIER1_ENERGY, BASE_REWARD, fmtNum } from './wattcoinConstants';
import { Pill } from './WattcoinUI';

export default function HardwareTable() {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'DM Mono', monospace", fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #1e3a1e' }}>
            {['ID', 'Hardware', 'Type', 'η (J/op)', 'Ops/Coin T0', 'Ops/Coin T1', 'Ops/Block T1'].map((h) => (
              <th
                key={h}
                style={{
                  padding: '10px 14px',
                  textAlign: 'right',
                  color: '#4ade80',
                  fontWeight: 500,
                  fontSize: 11,
                  letterSpacing: '0.06em',
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {HARDWARE.map((hw) => {
            const opsT0 = (TIER0_ENERGY * 3600) / hw.eta;
            const opsT1 = (TIER1_ENERGY * 3600) / hw.eta;
            const opsBlockT1 = (TIER1_ENERGY * BASE_REWARD * 3600) / hw.eta;
            return (
              <tr key={hw.id} style={{ borderBottom: '1px solid #0f1f0f' }}>
                <td style={{ padding: '8px 14px', color: '#4ade80', textAlign: 'right' }}>{hw.id}</td>
                <td style={{ padding: '8px 14px', color: '#e8f5e8', textAlign: 'right' }}>{hw.name}</td>
                <td style={{ padding: '8px 14px', textAlign: 'right' }}>
                  <Pill color={hw.color}>{hw.type}</Pill>
                </td>
                <td style={{ padding: '8px 14px', color: '#7aaa7a', textAlign: 'right' }}>{hw.eta}</td>
                <td style={{ padding: '8px 14px', color: '#3d5c3d', textAlign: 'right' }}>
                  {fmtNum(Math.round(opsT0))}
                </td>
                <td style={{ padding: '8px 14px', color: '#e8f5e8', textAlign: 'right' }}>
                  {fmtNum(Math.round(opsT1))}
                </td>
                <td style={{ padding: '8px 14px', color: '#e8f5e8', textAlign: 'right' }}>
                  {fmtNum(Math.round(opsBlockT1))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
