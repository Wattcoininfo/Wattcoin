import { useState, useEffect } from 'react';
import nftImgGold from './assets/Vortex NFT Gold.jpg';
import nftImgSilver from './assets/Vortex NFT Silver.jpg';
import nftImgBronze from './assets/Vortex NFT Bronze.jpg';

// ─── App version ─────────────────────────────────────────────────────────────────
// Resolved at runtime from the Electron app metadata via preload — keeps the
// whitepaper in sync with the actual desktop app version and window title.
const APP_VERSION =
  typeof window !== 'undefined' && window.wattcoinHardware && window.wattcoinHardware.appVersion
    ? window.wattcoinHardware.appVersion
    : '?';

// ─── Core Parameters ───────────────────────────────────────────────────────────
const COINS_PER_TIER = 1_000_000;
const NUM_TIERS = 21;
const TOTAL_SUPPLY = NUM_TIERS * COINS_PER_TIER; // 21,000,000

// Tier 0 = 1 Wh (bootstrap tier)
// Tier 1 = 20,000 Wh (20 kWh)
// Tier n≥1 = 20,000 × 2^(n-1) Wh
const TIER0_ENERGY = 1;
const TIER1_ENERGY = 20_000;
const BASE_REWARD = 1000;

const energyForTier = (n) => (n === 0 ? TIER0_ENERGY : TIER1_ENERGY * Math.pow(2, n - 1));

let _totalWh = 0;
for (let n = 0; n < NUM_TIERS; n++) _totalWh += COINS_PER_TIER * energyForTier(n);
const TOTAL_ENERGY_TWH = _totalWh / 1e12; // ~21,000 TWh

const TIERS = Array.from({ length: NUM_TIERS }, (_, n) => {
  const epc = energyForTier(n);
  const reward = BASE_REWARD / Math.pow(2, n);
  const blocksThisTier = Math.round(COINS_PER_TIER / reward);
  const tierEnergyTWh = (COINS_PER_TIER * epc) / 1e12;
  const costAt18 = epc * 0.00018;
  const cumulative = COINS_PER_TIER * (n + 1);
  return { n, epc, reward, blocksThisTier, tierEnergyTWh, costAt18, cumulative };
});

const HARDWARE = [
  { id: 0, name: 'RHM (Reference)', type: 'Reference', eta: 1.0, color: '#8B6F47' },
  { id: 1, name: 'Intel i9-14900K', type: 'CPU', eta: 0.095, color: '#0071C5' },
  { id: 2, name: 'AMD Ryzen 9 7950X', type: 'CPU', eta: 0.092, color: '#ED1C24' },
  { id: 3, name: 'NVIDIA RTX 4090', type: 'GPU', eta: 0.0092, color: '#76B900' },
  { id: 4, name: 'AMD RX 7900 XTX', type: 'GPU', eta: 0.0095, color: '#ED1C24' },
  { id: 5, name: 'Antminer S21', type: 'ASIC', eta: 0.00095, color: '#F7931A' },
  { id: 6, name: 'Whatsminer M60', type: 'ASIC', eta: 0.00094, color: '#F7931A' },
];

const FAIRNESS_NAME_FONT = "11px 'DM Mono', monospace";

function getFairnessLabelWidthPx() {
  if (typeof document === 'undefined') return 150;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 150;
  ctx.font = FAIRNESS_NAME_FONT;
  return Math.ceil(Math.max(...HARDWARE.map((hw) => ctx.measureText(hw.name).width)));
}

const NETWORK_POWERS = [
  { label: '1 MW', w: 1e6 },
  { label: '10 MW', w: 1e7 },
  { label: '100 MW', w: 1e8 },
  { label: '1 GW', w: 1e9 },
  { label: '12.5 GW (½ global)', w: 12.5e9 },
  { label: '25 GW (full global)', w: 25e9 },
];

// ─── Formatters ────────────────────────────────────────────────────────────────
const fmtNum = (v, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtSci = (v) =>
  v === 0 ? '0' : v < 0.00001 ? v.toExponential(3) : v < 1 ? v.toFixed(5) : v < 10000 ? fmtNum(v, 2) : fmtNum(v, 0);
const fmtCost = (c) =>
  c < 0.0001
    ? c.toFixed(7) + '¢'
    : c < 0.01
      ? c.toFixed(5) + '¢'
      : c < 1
        ? c.toFixed(4) + '¢'
        : c < 100
          ? '$' + c.toFixed(2)
          : '$' + fmtNum(Math.round(c));
const fmtEnergy = (wh) => {
  if (wh >= 1e12) return (wh / 1e12).toFixed(0) + ' TWh';
  if (wh >= 1e9) return (wh / 1e9).toFixed(0) + ' GWh';
  if (wh >= 1e6) return (wh / 1e6).toFixed(0) + ' MWh';
  if (wh >= 1e3) return (wh / 1e3).toFixed(0) + ' kWh';
  return wh.toFixed(0) + ' Wh';
};
const fmtYears = (y) =>
  y >= 2
    ? y.toFixed(1) + ' years'
    : y * 365.25 >= 2
      ? Math.round(y * 365.25) + ' days'
      : Math.round(y * 365.25 * 24) + ' hours';
// ─── Electricity Dial ─────────────────────────────────────────────────────────
const TIER1_WH = 20000; // 20 kWh
const ELEC_FALLBACK = 0.174;

function ElecDial({ price, live }) {
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
// ─── UI Primitives ─────────────────────────────────────────────────────────────
function FadeIn({ children }) {
  return <>{children}</>;
}

function Section({ id, children, style }) {
  return (
    <section id={id} style={{ padding: '80px 0', borderBottom: '1px solid #1a2a1a', ...style }}>
      {children}
    </section>
  );
}

function SectionTitle({ number, title }) {
  return (
    <FadeIn>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 48 }}>
        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#4ade80', letterSpacing: '0.12em' }}>
          {String(number).padStart(2, '0')}
        </span>
        <h2
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 34,
            fontWeight: 700,
            color: '#e8f5e8',
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          {title}
        </h2>
      </div>
    </FadeIn>
  );
}

function Pill({ children, color = '#4ade80' }) {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 12px',
        borderRadius: 99,
        border: `1px solid ${color}50`,
        color,
        fontSize: 11,
        fontFamily: "'DM Mono', monospace",
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </span>
  );
}

function MetricCard({ label, value, sub }) {
  return (
    <div style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 12, padding: '20px 24px' }}>
      <div
        style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 10,
          color: '#4ade80',
          letterSpacing: '0.12em',
          marginBottom: 8,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "'Playfair Display', serif",
          fontSize: 24,
          fontWeight: 700,
          color: '#e8f5e8',
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: '#3d5c3d', marginTop: 6, fontFamily: "'DM Mono', monospace" }}>{sub}</div>
      )}
    </div>
  );
}

function InfoCard({ title, children }) {
  return (
    <div style={{ padding: '16px 20px', background: '#0a160a', borderRadius: 10, borderLeft: '2px solid #4ade80' }}>
      <div
        style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 10,
          color: '#4ade80',
          letterSpacing: '0.08em',
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

// ─── Tier Ratchet Viz ─────────────────────────────────────────────────────────
function TierRatchetViz() {
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

// ─── Tier Table ────────────────────────────────────────────────────────────────
function TierTable() {
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

// ─── Hardware Table ────────────────────────────────────────────────────────────
function HardwareTable() {
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

// ─── Fairness Viz ──────────────────────────────────────────────────────────────
function FairnessViz() {
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

// ─── Mining Calculator ─────────────────────────────────────────────────────────
function MiningCalculator() {
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

// ─── Main ──────────────────────────────────────────────────────────────────────
export default function Wattcoin() {
  const container = { maxWidth: 960, margin: '0 auto', padding: '0 40px' };

  const [elecPrice, setElecPrice] = useState(ELEC_FALLBACK);
  const [elecLive, setElecLive] = useState(false);

  useEffect(() => {
    const hw = window.wattcoinHardware;
    if (hw && hw.invoke) {
      // Running in Electron — use the main-process IPC handler which fetches
      // globalpetrolprices.com directly (no CORS proxy needed).
      hw.invoke('wattcoin-get-electricity-price')
        .then((res) => {
          if (res && res.ok && Number.isFinite(res.price) && res.price > 0) {
            setElecPrice(res.price);
            setElecLive(true);
          }
        })
        .catch(() => {});
    } else {
      // Fallback for browser preview — use our own server-side proxy.
      fetch('https://wattcoin.ee/elec-price-api/', { signal: AbortSignal.timeout(8000) })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((j) => {
          if (j.ok && Number.isFinite(j.price) && j.price > 0) {
            setElecPrice(j.price);
            setElecLive(true);
          }
        })
        .catch(() => {});
    }
  }, []);

  return (
    <div
      style={{
        background: '#060e06',
        backgroundImage:
          'linear-gradient(rgba(26,58,26,0.12) 1px, transparent 1px), linear-gradient(90deg, rgba(26,58,26,0.12) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
        minHeight: '100vh',
        color: '#e8f5e8',
        fontFamily: "'Georgia', serif",
      }}
    >
      <link
        href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=DM+Mono:wght@400;500&display=swap"
        rel="stylesheet"
      />

      {/* ── Nav ── */}
      <nav
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 100,
          background: 'rgba(6,14,6,0.95)',
          backdropFilter: 'blur(10px)',
          borderBottom: '1px solid #1a2a1a',
          padding: '0 40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 52,
          flexShrink: 0,
        }}
      >
        <a
          href="#hero"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById('hero')?.scrollIntoView({ behavior: 'smooth' });
          }}
          style={{
            fontFamily: "'Playfair Display', serif",
            fontSize: 20,
            fontWeight: 900,
            color: '#e8f5e8',
            textDecoration: 'none',
            cursor: 'pointer',
          }}
        >
          Watt<span style={{ color: '#4ade80' }}>coin</span>
        </a>
        <ul style={{ display: 'flex', gap: 22, listStyle: 'none', margin: 0, padding: 0, flexWrap: 'wrap' }}>
          {[
            { label: 'Mission', id: 'mission' },
            { label: 'Vortex', id: 'vortex', highlight: true },
            { label: 'Tokenomics', id: 'tokenomics' },
            { label: 'Staking', id: 'staking' },
            { label: 'NFT', id: 'nft-collection', silver: true },
            { label: 'WattDollar', id: 'wtd' },
            { label: 'Comparison', id: 'comparison' },
            { label: 'Roadmap', id: 'roadmap' },
            { label: 'Governance', id: 'governance' },
            { label: 'Network', id: 'network' },
          ].map(({ label, id, highlight, silver }) => (
            <li key={id}>
              <a
                href={`#${id}`}
                onClick={(e) => {
                  e.preventDefault();
                  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
                }}
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 10,
                  color: silver ? '#4ade80' : highlight ? '#4ade80' : '#6b9a6b',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                  textDecoration: 'none',
                  cursor: 'pointer',
                  fontWeight: highlight || silver ? 500 : 400,
                }}
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* ── Hero ── */}
      <section
        id="hero"
        style={{ padding: '0', display: 'flex', alignItems: 'center', position: 'relative', overflow: 'hidden' }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'radial-gradient(ellipse 60% 60% at 70% 50%, #091a09 0%, transparent 70%), radial-gradient(ellipse 40% 80% at 15% 80%, #091405 0%, transparent 60%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'linear-gradient(#1a3a1a 1px, transparent 1px), linear-gradient(90deg, #1a3a1a 1px, transparent 1px)',
            backgroundSize: '60px 60px',
            opacity: 0.12,
          }}
        />
        <div style={{ ...container, position: 'relative', zIndex: 1, paddingTop: 48, paddingBottom: 80 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
            <Pill>VERSION {APP_VERSION} — MAY 2026</Pill>
            <ElecDial price={elecPrice} live={elecLive} />
          </div>
          <h1
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: 'clamp(52px, 8vw, 100px)',
              fontWeight: 900,
              lineHeight: 0.92,
              letterSpacing: '-0.03em',
              margin: '0 0 32px',
              color: '#e8f5e8',
            }}
          >
            Watt<span style={{ color: '#4ade80' }}>coin</span>
          </h1>
          <p
            style={{
              fontFamily: "'DM Mono', monospace",
              fontSize: 12,
              color: '#4ade80',
              letterSpacing: '0.16em',
              marginBottom: 16,
              textTransform: 'uppercase',
            }}
          >
            Proof-of-Energy
          </p>
          <p style={{ fontSize: 18, fontWeight: 700, color: '#e8f5e8', letterSpacing: '0.04em', marginBottom: 12 }}>
            Energy-Backed. Physically Grounded. Fairly Mined.
          </p>
          <p style={{ fontSize: 19, color: '#7aaa7a', maxWidth: 520, lineHeight: 1.65, marginBottom: 48 }}>
            The first cryptocurrency where every miner pays the exact same energy cost per coin — regardless of
            hardware.
          </p>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: 14,
              width: 'fit-content',
              marginBottom: 0,
            }}
          >
            <MetricCard label="Total Supply" value="21,000,000" sub="21 tiers — 1,000,000 coins" />
            <MetricCard label="Per Block" value="10 MWh" sub="constant across every tier, forever" />
            <MetricCard label="Hydro Turbine" value="60 kW" sub="Vortex — Estonia" />
            <MetricCard label="Total Energy" value="~21,000 TWh" sub="~191 years at global power" />
            <div
              style={{
                gridColumn: '1/-1',
                background: '#0a160a',
                border: '1px solid #1e3a1e',
                borderRadius: 12,
                padding: '20px 28px',
                textAlign: 'center',
              }}
            >
              <p style={{ margin: '0 0 6px', fontWeight: 700, color: '#e8f5e8', fontSize: 14 }}>
                Energy-backed cryptocurrency with real physical infrastructure.
              </p>
              <p style={{ margin: 0, fontSize: 13, color: '#7aaa7a' }}>
                <span style={{ color: '#4ade80', fontWeight: 600 }}>Vortex NFT holders</span> share turbine electricity
                output — forever.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Mission ── */}
      <Section id="mission">
        <div style={container}>
          <SectionTitle number={1} title="Mission" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
            <FadeIn delay={0.1}>
              <div>
                <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 20 }}>
                  Most cryptocurrencies derive value from speculation alone. Wattcoin is different: every coin ever
                  minted has a verifiable, non-negotiable energy cost baked into its existence, and{' '}
                  <strong style={{ color: '#4ade80' }}>Vortex NFT holders</strong> share in the output of a real,
                  operating hydro turbine — forever.
                </p>
                <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a' }}>
                  The proceeds fund land acquisition, permitting, construction, and commissioning of a{' '}
                  <strong style={{ color: '#e8f5e8' }}>60 kW Vortex Gravity Hydro Turbine</strong> in Estonia. Once
                  built, that turbine generates metered, verifiable electricity whose revenue flows directly back to NFT
                  holders — on-chain, transparently, proportionally.
                </p>
              </div>
            </FadeIn>
            <FadeIn delay={0.2}>
              <div style={{ display: 'grid', gap: 12 }}>
                <InfoCard title="ENERGY COST FLOOR — NOT JUST HASH DIFFICULTY">
                  Every WTC minted required a provable, fixed quantity of real electrical energy. That floor doubles
                  with each tier advance, permanently raising the rational minimum price of every coin in existence —
                  including all coins already mined in earlier tiers.
                </InfoCard>
                <InfoCard title="A PHYSICAL ASSET BACKING THE NETWORK">
                  The Vortex turbine is the purpose of this sale. Metered electricity output is streamed live into the
                  Wattcoin Miner app and distributed on-chain to NFT holders. Real infrastructure. Real revenue.
                  Verifiable on-chain.
                </InfoCard>
                <InfoCard title="HARDWARE FAIRNESS — ANYONE CAN MINE">
                  <p style={{ margin: 0 }}>
                    A CPU miner and a GPU miner both spend exactly <strong style={{ color: '#e8f5e8' }}>20 kWh</strong>{' '}
                    to earn one WTC in Tier 1. Hardware determines how fast you mine, not how cheaply. No ASIC
                    dominance, no arms race, no exclusion by hardware wealth.
                  </p>
                  <p style={{ margin: '10px 0 0' }}>
                    Hardware that Bitcoin&rsquo;s SHA-256 arms race and Ethereum&rsquo;s proof-of-stake transition
                    rendered obsolete&mdash;ASICs bound for landfill, GPUs pulled from decommissioned rigs&mdash;mines
                    Wattcoin on equal energy terms. The network doesn&rsquo;t care how fast you are; it only counts the
                    kilowatt-hours you prove. What the industry discarded as e-waste becomes a productive asset again.
                  </p>
                </InfoCard>
              </div>
            </FadeIn>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginTop: 32 }}>
            <MetricCard label="Public Sale" value="333,333 WTC" sub="one-time only — ever" />
            <MetricCard label="Hydro Turbine" value="60 kW" sub="Vortex Gravity — Estonia" />
            <MetricCard label="Projected Lifetime" value="~191 years" sub="at current global network power" />
            <MetricCard label="Hard Cap" value="21,000,000" sub="total supply — inviolable" />
          </div>
        </div>
      </Section>

      {/* ── Vortex Hydro Turbine ── */}
      <Section id="vortex">
        <div style={container}>
          <SectionTitle number={2} title="Vortex Hydro Turbine" />
            <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 40, maxWidth: 680 }}>
              Wattcoin&apos;s first physical energy asset. A real-world hydro turbine whose verified output anchors the coin to
              tangible, renewable electricity production.
            </p>

          {/* Asset */}
          <div
            style={{
              background: '#0a160a',
              border: '1px solid #1e3a1e',
              borderRadius: 14,
              padding: 28,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                color: '#4ade80',
                letterSpacing: '0.12em',
                marginBottom: 14,
              }}
            >
              THE ASSET
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.85, color: '#7aaa7a' }}>
              A <strong style={{ color: '#e8f5e8' }}>60 kW Vortex Gravity Hydro Turbine</strong> will be installed and
              commissioned. Vortex turbines are low-impact, continuous-output hydro units — no dam required, minimal
              ecological footprint, and capable of near-24/7 baseload generation. At 60 kW capacity, the turbine
              produces real, metered, verifiable electricity that feeds directly into Wattcoin&apos;s energy-backed value
              model.
            </p>
          </div>

          {/* Timeline */}
          <div
            style={{
              background: '#0a160a',
              border: '1px solid #1e3a1e',
              borderRadius: 14,
              padding: 28,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                color: '#4ade80',
                letterSpacing: '0.12em',
                marginBottom: 18,
              }}
            >
              TIMELINE
            </div>
            {[
              {
                num: '01',
                title: 'TIER 1 SALE CLOSES',
                text: 'Land acquisition begins. The existing project documentation is taken into active coordination. Site surveys, engineering reviews, and permitting applications are initiated in parallel.',
              },
              {
                num: '02',
                title: 'PERMITS GRANTED',
                text: 'Physical construction of the hydro turbine begins. No construction work starts before the regulatory and permitting process is fully complete.',
              },
            ].map(({ num, title, text }) => (
              <div key={num} style={{ display: 'flex', gap: 16, marginBottom: 18 }}>
                <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 13, color: '#4ade80', minWidth: 28 }}>
                  {num}
                </div>
                <div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 4 }}>
                    {title}
                  </div>
                  <div style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.65 }}>{text}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Early Adopter Pool */}
          <div
            style={{
              background: '#0a160a',
              border: '1px solid #1e3a1e',
              borderRadius: 14,
              padding: 28,
              marginBottom: 24,
            }}
          >
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                color: '#4ade80',
                letterSpacing: '0.12em',
                marginBottom: 14,
              }}
            >
              EARLY ADOPTER ENERGY POOL
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 20 }}>
              Participants who hold WTC from the coin sale gain access to the{' '}
              <strong style={{ color: '#e8f5e8' }}>Early Adopter Energy Pool</strong> — a share of the turbine&apos;s net
              energy revenue, distributed on-chain proportionally to holdings.
            </p>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 20 }}>
              <thead>
                <tr>
                  <th
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11,
                      color: '#4ade80',
                      textAlign: 'left',
                      padding: '6px 0',
                      borderBottom: '1px solid #1e3a1e',
                    }}
                  >
                    Year
                  </th>
                  <th
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 11,
                      color: '#4ade80',
                      textAlign: 'center',
                      padding: '6px 0',
                      borderBottom: '1px solid #1e3a1e',
                    }}
                  >
                    Early Adopter Pool Share
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  { year: 'Year 1', share: '60%', highlight: true },
                  { year: 'Year 2', share: '45%' },
                  { year: 'Year 3', share: '~34%' },
                  { year: 'Year 4', share: '~25%' },
                ].map(({ year, share, highlight }) => (
                  <tr key={year}>
                    <td style={{ fontSize: 13, color: '#7aaa7a', padding: '7px 0', borderBottom: '1px solid #0f1f0f' }}>
                      {year}
                    </td>
                    <td
                      style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: 13,
                        color: highlight ? '#4ade80' : '#7aaa7a',
                        textAlign: 'center',
                        padding: '7px 0',
                        borderBottom: '1px solid #0f1f0f',
                      }}
                    >
                      {share}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 13, lineHeight: 1.8, color: '#5a7a5a' }}>
              The pool declines by 25% relative each year. However,{' '}
              <strong style={{ color: '#7aaa7a' }}>
                Governance reserves the right to freeze the allocation at any step
              </strong>{' '}
              if it determines that the current level represents a sustainable long-term floor. This decision rests
              entirely with Governance and may be made at any point in the schedule — including as early as Year 1,
              meaning the 60% allocation could remain permanent if Governance concludes it is the right balance between
              holder returns and infrastructure sustainability. No decline is automatic or obligatory. The schedule
              represents the planned trajectory, not a guaranteed reduction.
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.8, color: '#5a7a5a', marginTop: 12 }}>
              The remaining share each year is retained by Governance for infrastructure maintenance, expansion, and
              network development.
            </p>
          </div>

          {/* Terms + Metering */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 14, padding: 28 }}>
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 10,
                  color: '#4ade80',
                  letterSpacing: '0.12em',
                  marginBottom: 18,
                }}
              >
                TERMS
              </div>
              {[
                {
                  name: 'No Vesting Period',
                  desc: 'Energy revenue distributions begin as soon as the turbine is operational. There is no lock-up, cliff, or waiting period — early adopters receive their share from day one of production.',
                },
                {
                  name: 'Individual Share Cap: 10%',
                  desc: 'No single wallet address may hold more than 10% of the Early Adopter Pool allocation. This prevents concentration and ensures the pool delivers meaningful benefit across a broad base of holders.',
                },
              ].map(({ name, desc }) => (
                <div key={name} style={{ marginBottom: 18, paddingBottom: 18, borderBottom: '1px solid #0f1f0f' }}>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 6 }}>
                    {name}
                  </div>
                  <div style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.65 }}>{desc}</div>
                </div>
              ))}
            </div>
            <div style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 14, padding: 28 }}>
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 10,
                  color: '#4ade80',
                  letterSpacing: '0.12em',
                  marginBottom: 18,
                }}
              >
                LIVE METERING IN THE MINER APP
              </div>
              {[
                {
                  name: 'Real-Time Dashboard',
                  desc: 'Real-time turbine output will be streamed directly into the Wattcoin Miner application. Miners will see current turbine generation (kW), cumulative output (kWh), estimated revenue accrued to the pool, and their individual share — updated continuously alongside mining stats.',
                },
                {
                  name: 'Verifiable On-Chain',
                  desc: 'Physical energy backing becomes tangible and verifiable from within the app — not just on paper.',
                },
              ].map(({ name, desc }) => (
                <div key={name} style={{ marginBottom: 18, paddingBottom: 18, borderBottom: '1px solid #0f1f0f' }}>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 6 }}>
                    {name}
                  </div>
                  <div style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.65 }}>{desc}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* ── Energy Value ── */}
      <Section id="energy-value">
        <div style={container}>
          <SectionTitle number={3} title="Energy Value & The Tier Ratchet" />
          <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 24 }}>
            Wattcoin has 21 tiers of 1,000,000 coins each. From Tier 1 onward, the energy required to mine one coin{' '}
            <strong style={{ color: '#e8f5e8' }}>doubles every tier</strong> — T1: 20 kWh, T2: 40 kWh, T3: 80 kWh, and
            so on up to T8: 2,560 kWh per coin.
          </p>
          <TierRatchetViz />
          <div
            style={{
              padding: '10px 14px',
              background: '#0a160a',
              borderRadius: 8,
              border: '1px solid #1e3a1e',
              marginBottom: 40,
            }}
          >
            <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#4ade80' }}>
              When the network advances from Tier N to Tier N+1, the mining cost floor for new coins doubles. Since no
              rational miner sells below their cost, the effective market floor for{' '}
              <strong style={{ color: '#e8f5e8' }}>all WTC</strong> — including coins mined in earlier tiers — is pulled
              upward by every tier advance.
            </span>
          </div>
          <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 20 }}>
            Why Electricity Prices Trend Upward
          </h3>
            <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 24 }}>
            WTC&apos;s cost floor is structurally linked to global electricity prices. Four independent forces push
            electricity prices higher over time:
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <FadeIn delay={0.1}>
              <div style={{ display: 'grid', gap: 12 }}>
                <InfoCard title="GRID INFRASTRUCTURE INVESTMENT">
                  Aging electricity grids require multi-decade capital reinvestment. These costs are embedded in utility
                  tariffs and flow through to consumer and industrial electricity prices across every region.
                </InfoCard>
                <InfoCard title="DEMAND EXPLOSION">
                  AI data centres, electric vehicle adoption, and building electrification are driving electricity
                  demand faster than new supply can be built. Structural demand growth ahead of supply creates sustained
                  upward price pressure.
                </InfoCard>
              </div>
            </FadeIn>
            <FadeIn delay={0.2}>
              <div style={{ display: 'grid', gap: 12 }}>
                <InfoCard title="CARBON PRICING">
                  Carbon costs are structurally rising globally and pass through to wholesale electricity prices. As
                  carbon pricing expands, the cost of electricity from fossil-fuel generation — still a dominant source
                  — rises accordingly.
                </InfoCard>
                <InfoCard title="ENERGY TRANSITION CAPEX">
                  Wind, solar, and storage buildout is capital-intensive. Construction and financing costs are embedded
                  in electricity pricing for decades, even as renewable generation becomes the dominant source.
                </InfoCard>
              </div>
            </FadeIn>
          </div>
          <div
            style={{
              marginTop: 32,
              padding: '18px 22px',
              background: '#0a160a',
              border: '1px solid #2e4a2e',
              borderRadius: 12,
            }}
          >
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 11,
                color: '#4ade80',
                marginBottom: 8,
                letterSpacing: '0.1em',
              }}
            >
              THE KEY INSIGHT
            </div>
            <p style={{ fontSize: 14, color: '#7aaa7a', lineHeight: 1.7, margin: 0 }}>
              <strong style={{ color: '#e8f5e8' }}>
                WTC is the only asset whose cost floor is structurally linked to global electricity prices.
              </strong>{' '}
              As energy becomes more expensive, every WTC in existence becomes harder and more expensive to replace. The
              energy cost baked into each coin cannot be inflated away — it is a physical fact of its creation.
            </p>
          </div>
        </div>
      </Section>

      {/* ── Abstract ── */}
      <Section id="abstract">
        <div style={container}>
          <SectionTitle number={4} title="Abstract" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
            <FadeIn delay={0.1}>
              <div>
                <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 20 }}>
                  Wattcoin (WTC) introduces <strong style={{ color: '#e8f5e8' }}>Proof-of-Energy (PoE)</strong> — a
                  consensus mechanism where every miner pays the exact same energy cost per coin, regardless of hardware
                  type or efficiency. A GPU miner and a CPU miner both spend{' '}
                  <strong style={{ color: '#4ade80' }}>20 kWh</strong> to earn one WTC in Tier 1 — hardware only
                  determines how many operations that requires.
                </p>
                <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 20 }}>
                  Energy consumption is derived from hardware specifications scaled by the miner&apos;s configured duty-cycle
                  load:{' '}
                  <strong style={{ color: '#e8f5e8' }}>
                    Energy (Wh) = Hardware Power (W) &times; Load (%) &times; Time (h)
                  </strong>
                  . Benchmark proofs — CPU hash, memory walk, GPU pixel hash — measure actual computation throughput to
                  validate the hardware claim. Any ledger peer independently re-derives each expected proof using the
                  same deterministic algorithm. No specialised hardware is required on the verifier side.
                </p>
                <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a' }}>
                  The design uses a two-tier structure: <strong style={{ color: '#fbbf24' }}>Tier 0</strong> — 1,000,000
                  WTC allocated at genesis to the Foundation Reserve and distributed via on-chain transactions to four
                  wallets: Foundation Reserve (200,000), Public Sale (333,333), Staking Rewards (166,667), and Team
                  (300,000). From <strong style={{ color: '#4ade80' }}>Tier 1 onward</strong> the real economy begins at
                  20 kWh per coin, with the energy requirement doubling each tier across 20 mining tiers until the
                  21,000,000 WTC hard cap is reached. Transaction fees are awarded to the block proposer alongside the
                  block reward.
                </p>
              </div>
            </FadeIn>
            <FadeIn delay={0.2}>
              <div style={{ display: 'grid', gap: 12 }}>
                <InfoCard title="TIER 0 — GENESIS ALLOCATION">
                  1,000,000 WTC allocated at genesis to the Foundation Reserve and distributed via on-chain transactions
                  to four wallets: Foundation Reserve (200,000), Public Sale (333,333), Staking Rewards (166,667), Team
                  (300,000). Every allocation is verifiable on the public chain.
                </InfoCard>
                <InfoCard title="TIER 1+ — ECONOMY LAW">
                  20 kWh per coin — the real economic floor. Energy requirement doubles every tier. At $
                  {elecPrice.toFixed(3)}/kWh, Tier 1 mining costs ${((elecPrice * TIER1_WH) / 1000).toFixed(2)} per
                  coin.
                </InfoCard>
                <InfoCard title="FIXED SUPPLY">
                  21,000,000 WTC across 21 tiers of 1,000,000 coins each. Hard cap with no inflation mechanism.
                </InfoCard>
                <InfoCard title="PROPORTIONAL REWARDS">
                  Block rewards split by verified energy contribution. No luck, no lottery — every miner receives
                  exactly what their energy earns, every block. Mining pools are obsolete by design.
                </InfoCard>
                <InfoCard title="TRANSACTION FEES">
                  Network transaction fees are awarded to the block proposer alongside the block reward, providing an
                  additional revenue component that grows over later tiers.
                </InfoCard>
                <InfoCard title="ENERGY FAIRNESS">
                  Operation count scales inversely with hardware efficiency (&eta;) — so every hardware type spends
                  identical Wh per coin. A faster machine does more work in the same time, not cheaper work.
                </InfoCard>
              </div>
            </FadeIn>
          </div>
        </div>
      </Section>

      {/* ── Core Principles ── */}
      <Section id="principles">
        <div style={container}>
          <SectionTitle number={5} title="Core Principles" />
          <FadeIn delay={0.1}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 48 }}>
              <div
                style={{
                  padding: '28px 32px',
                  background: '#0a160a',
                  border: '1px solid #2e2000',
                  borderRadius: 14,
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#fbbf24',
                    letterSpacing: '0.15em',
                    marginBottom: 10,
                  }}
                >
                  TIER 0 — PRE-MINED GENESIS
                </div>
                <div
                  style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: 38,
                    fontWeight: 900,
                    color: '#e8f5e8',
                    letterSpacing: '-0.02em',
                  }}
                >
                  1,000,000 WTC
                </div>
                <div style={{ marginTop: 10, fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#3d3000' }}>
                  genesis distribution — sale, staking, team, foundation
                </div>
              </div>
              <div
                style={{
                  padding: '28px 32px',
                  background: '#0a160a',
                  border: '1px solid #2e4a2e',
                  borderRadius: 14,
                  textAlign: 'center',
                }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.15em',
                    marginBottom: 10,
                  }}
                >
                  TIER 1+ — ECONOMY LAW
                </div>
                <div
                  style={{
                    fontFamily: "'Playfair Display', serif",
                    fontSize: 38,
                    fontWeight: 900,
                    color: '#e8f5e8',
                    letterSpacing: '-0.02em',
                  }}
                >
                  10 MWh = 1 block
                </div>
                <div style={{ marginTop: 10, fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#3d5c3d' }}>
                  20 kWh/WTC at Tier 1 — doubles each tier
                </div>
              </div>
            </div>
          </FadeIn>
          <FadeIn delay={0.15}>
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}>
              Hardware-Aware Energy Invariant
            </h3>
            <div
              style={{
                background: '#0a160a',
                border: '1px solid #1e3a1e',
                borderRadius: 12,
                padding: '22px 28px',
                marginBottom: 40,
                fontFamily: "'DM Mono', monospace",
                fontSize: 12,
                color: '#4ade80',
                lineHeight: 2,
              }}
            >
               <div style={{ color: '#3d5c3d' }}>{'// Energy per coin at tier n (n ≥ 1)'}</div>
              <div>E(n) = 20,000 Wh × 2^(n−1)</div>
              <div style={{ color: '#3d5c3d', marginTop: 8 }}>{'// Operations per coin'}</div>
              <div>ops(n) = E(n) × 3,600 / η</div>
              <div style={{ color: '#3d5c3d', marginTop: 8 }}>
                {'// Actual energy consumed — always equal regardless of hardware'}
              </div>
              <div>actual = ops × η = E(n) Wh &nbsp;✓</div>
              <div style={{ color: '#3d5c3d', marginTop: 8 }}>
                {'// Energy per block at tier n (constant across all tiers T1+)'}
              </div>
              <div>E_block = (1,000 / 2^n) × (20,000 × 2^(n−1)) = 10,000,000 Wh = 10 MWh &nbsp;✓</div>
              <div style={{ color: '#3d5c3d', marginTop: 8 }}>{'// Block time (emergent)'}</div>
              <div>T_block (hours) = 10,000,000 Wh ÷ P_total (Watts)</div>
            </div>
          </FadeIn>
          <FadeIn delay={0.2}>
            <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 20 }}>
              Energy Fairness — Tier 1
            </h3>
            <FairnessViz />
          </FadeIn>
        </div>
      </Section>

      {/* ── Hardware Registry ── */}
      <Section id="hardware">
        <div style={container}>
          <SectionTitle number={6} title="Hardware Registry" />
          <FadeIn delay={0.1}>
            <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 32 }}>
              Benchmark proofs determine each hardware type&apos;s efficiency η (Joules per operation). Power of usage is
              calculated via algorithm that specifically calculates your hardware&apos;s power consumption and is scaled by
              the miner&apos;s configured duty-cycle load. Benchmark proofs calibrate the estimate against measured
              throughput — if the hardware underperforms, its credited power is reduced proportionally. Energy in Wh is
              computed as power × load% × elapsed time, and verified by ledger peers through computation probes.
            </p>
          </FadeIn>
          <FadeIn delay={0.15}>
            <HardwareTable />
          </FadeIn>
          <FadeIn delay={0.2}>
            <div style={{ marginTop: 40, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
              {[
                ['01', 'SUBMIT', 'Hardware specs and claimed efficiency η'],
                [
                  '02',
                  'BENCHMARK',
                  'A ledger peer issues random computation challenges (CPU hash, GPU pixel hash, memory probe)',
                ],
                [
                  '03',
                  'PROVE',
                  'Miner returns deterministic proof hash; issuing peer re-derives expected answer independently',
                ],
                ['04', 'ATTEST', 'Benchmark speed cross-checked against declared hardware TDP; level caps updated'],
                ['05', 'RECORD', 'Attestation level and power cap stored; influences WTC reward cap'],
              ].map(([n, title, desc]) => (
                <div
                  key={n}
                  style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 10, padding: '16px 14px' }}
                >
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 18, color: '#4ade80', marginBottom: 8 }}>
                    {n}
                  </div>
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 10,
                      color: '#e8f5e8',
                      marginBottom: 6,
                      letterSpacing: '0.08em',
                    }}
                  >
                    {title}
                  </div>
                  <div style={{ fontSize: 12, color: '#3d5c3d', lineHeight: 1.5 }}>{desc}</div>
                </div>
              ))}
            </div>
          </FadeIn>
        </div>
      </Section>

      {/* ── Tokenomics ── */}
      <Section id="tokenomics">
        <div style={container}>
          <SectionTitle number={7} title="Tokenomics" />
          <FadeIn delay={0.1}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 40 }}>
              <MetricCard label="Total Supply" value="21,000,000" sub="hard cap" />
              <MetricCard label="Coins per Tier" value="1,000,000" sub="fixed — all 21 tiers" />
              <MetricCard label="Base Block Reward" value="500 WTC" sub="halves each tier" />
              <MetricCard label="Total Energy" value="~21,000 TWh" sub="Tier 1-20 mined; Tier 0 pre-mined" />
            </div>
          </FadeIn>
          <FadeIn delay={0.15}>
            <div
              style={{
                padding: '18px 22px',
                background: '#0a160a',
                border: '1px solid #2e4a2e',
                borderRadius: 12,
                marginBottom: 32,
              }}
            >
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: '#4ade80',
                  marginBottom: 8,
                  letterSpacing: '0.1em',
                }}
              >
                DESIGN INSIGHT
              </div>
              <p style={{ fontSize: 14, color: '#7aaa7a', lineHeight: 1.7, margin: 0 }}>
                Blocks per tier = 1,000,000 ÷ (1,000 / 2ⁿ) ={' '}
                <strong style={{ color: '#e8f5e8' }}>1,000 × 2ⁿ — always an exact integer, every tier</strong>. Energy
                per block for T1+ = (1,000/2ⁿ) × (20,000 × 2^(n−1)) ={' '}
                <strong style={{ color: '#e8f5e8' }}>10 MWh constant</strong>. Tier 0 is the pre-mined genesis supply of
                1,000,000 WTC — distributed at launch across the foundation reserve, public sale, staking rewards, and
                team allocation.
              </p>
            </div>
          </FadeIn>
          <FadeIn delay={0.2}>
            <TierTable />
          </FadeIn>
        </div>
      </Section>

      {/* ── Proportional Rewards ── */}
      <Section id="rewards">
        <div style={container}>
          <SectionTitle number={8} title="Proportional Block Rewards" />
          <FadeIn delay={0.1}>
            <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 40 }}>
              When multiple miners contribute verified proofs within the same block window, the block reward is
              distributed proportionally based on each miner&apos;s verified energy contribution. This eliminates luck
              variance entirely — every miner receives exactly what their energy deserves, every block.
            </p>
          </FadeIn>
          <FadeIn delay={0.15}>
            <div
              style={{
                background: '#0a160a',
                border: '1px solid #1e3a1e',
                borderRadius: 12,
                padding: '22px 28px',
                marginBottom: 40,
                fontFamily: "'DM Mono', monospace",
                fontSize: 12,
                color: '#4ade80',
                lineHeight: 2,
              }}
            >
              <div style={{ color: '#3d5c3d' }}>{'// Miner share of block reward'}</div>
              <div>miner_reward = block_reward × (miner_energy_Wh / total_block_energy_Wh)</div>
              <div style={{ color: '#3d5c3d', marginTop: 8 }}>
                {'// Since all hardware is energy-normalized, this simplifies to'}
              </div>
              <div>miner_reward = block_reward × (miner_ops × η / Σ(all_ops × η))</div>
              <div style={{ color: '#3d5c3d', marginTop: 8 }}>{'// Total block energy is always conserved'}</div>
              <div>Σ(miner_rewards) = block_reward &nbsp;✓</div>
            </div>
          </FadeIn>
          <FadeIn delay={0.2}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 40 }}>
              <div
                style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 12, padding: '22px 24px' }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.1em',
                    marginBottom: 16,
                  }}
                >
                  WHAT THIS REPLACES
                </div>
                {[
                  [
                    'Mining Pools',
                    'No longer needed — the protocol itself distributes rewards proportionally, eliminating pool fees and pool operator trust',
                  ],
                  [
                    'Luck Variance',
                    'Solo miners no longer need to wait for a lucky block — every block window pays out proportionally',
                  ],
                  [
                    'Winner-Takes-All',
                    "No single miner claims the full reward unless they contributed 100% of the block's energy",
                  ],
                ].map(([title, desc]) => (
                  <div key={title} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #0f1f0f' }}>
                    <div
                      style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 4 }}
                    >
                      {title}
                    </div>
                    <div style={{ fontSize: 13, color: '#3d5c3d', lineHeight: 1.6 }}>{desc}</div>
                  </div>
                ))}
              </div>
              <div
                style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 12, padding: '22px 24px' }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.1em',
                    marginBottom: 16,
                  }}
                >
                  BLOCK WINDOW MODEL
                </div>
                {[
                  ['Window Opens', 'Previous block is confirmed. New block seed broadcast to all miners.'],
                  [
                    'Miners Work',
                    'Each miner runs their hardware-specific task, generating W(t) samples continuously.',
                  ],
                  [
                    'Proofs Submitted',
                    'Miners submit computation proofs and power readings before the round closes. The issuing ledger peer verifies each proof algebraically.',
                  ],
                  ['Window Closes', 'Fixed-time window ends. All valid proofs collected.'],
                  ['Reward Split', 'block_reward × (miner_Wh / total_Wh) paid to each contributor.'],
                ].map(([title, desc], i) => (
                  <div key={title} style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#4ade80', minWidth: 24 }}>
                      0{i + 1}
                    </div>
                    <div>
                      <div
                        style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 3 }}
                      >
                        {title}
                      </div>
                      <div style={{ fontSize: 12, color: '#3d5c3d', lineHeight: 1.5 }}>{desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>
          <FadeIn delay={0.25}>
            <div
              style={{
                padding: '18px 22px',
                background: '#0a160a',
                border: '1px solid #2e4a2e',
                borderRadius: 12,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: '#4ade80',
                  marginBottom: 8,
                  letterSpacing: '0.1em',
                }}
              >
                SYBIL RESISTANCE
              </div>
              <p style={{ fontSize: 14, color: '#7aaa7a', lineHeight: 1.7, margin: 0 }}>
                Splitting one miner into many identities provides{' '}
                <strong style={{ color: '#e8f5e8' }}>zero advantage</strong> — proportional share is calculated on total
                verified energy regardless of how many proofs it is split across. A miner spending 1,000 Wh as one
                identity receives the same reward as ten identities each spending 100 Wh. The energy is what counts, not
                the identity count.
              </p>
            </div>
            <div style={{ padding: '18px 22px', background: '#0a160a', border: '1px solid #2e4a2e', borderRadius: 12 }}>
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: '#4ade80',
                  marginBottom: 8,
                  letterSpacing: '0.1em',
                }}
              >
                TRANSACTION FEES
              </div>
              <p style={{ fontSize: 14, color: '#7aaa7a', lineHeight: 1.7, margin: 0 }}>
                All network transaction fees are captured by miners and distributed proportionally alongside block
                rewards — in exact proportion to each contributor&apos;s verified energy. As block rewards halve through
                successive tiers, transaction fees form an increasingly important component of miner revenue, sustaining
                mining incentives across the full emission schedule.
              </p>
            </div>
          </FadeIn>
        </div>
      </Section>

      {/* ── Calculator ── */}
      <Section id="calculator">
        <div style={container}>
          <SectionTitle number={9} title="Network Mining Calculator" />
          <FadeIn delay={0.1}>
            <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 40 }}>
              Total energy to mine all 21,000,000 WTC ≈ 21,000 TWh. Current global PoW mining draws approximately 25 GW.
            </p>
          </FadeIn>
          <FadeIn delay={0.15}>
            <MiningCalculator />
          </FadeIn>
        </div>
      </Section>

      {/* ── Verification ── */}
      <Section id="verification">
        <div style={container}>
          <SectionTitle number={10} title="Verification & Security" />
          <FadeIn delay={0.05}>
            <p style={{ fontSize: 14, color: '#7aaa7a', lineHeight: 1.7, marginBottom: 32 }}>
              A mining round produces a set of verifiable artefacts. Benchmark proofs run once at startup; periodic
              probes run throughout mining with chain-derived seeds so past answers cannot be recycled:
            </p>
          </FadeIn>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
            <FadeIn delay={0.1}>
              <div>
                <h3
                  style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}
                >
                  Proof System
                </h3>
                <div
                  style={{
                    background: '#0a160a',
                    border: '1px solid #1e3a1e',
                    borderRadius: 12,
                    padding: '18px 22px',
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 12,
                  }}
                >
                  {[
                    ['SUBMITTED', 'Miner address'],
                    ['SUBMITTED', 'Declared energy (Wh) — computed as hardware power × duty-cycle load × elapsed time'],
                    ['SUBMITTED', 'Proof commitment — SHA-256(blockHash + Wh + blocks), binds energy claim to block'],
                    ['BENCHMARK', 'CPU speed proof — deterministic IMUL/XOR hash, independently re-run by peers'],
                    ['BENCHMARK', 'Memory proof — seeded array-walk hash, independently re-run by peers'],
                    ['BENCHMARK', 'GPU proof hash — deterministic XOR-shift pixel hash (WebGL2), verified in pure JS'],
                    [
                      'PROBE',
                      'Periodic in-mining probes — chain-derived seeds, peer algebraically verifies each answer',
                    ],
                    ['ATTESTED', 'Power cap level — rises only by passing successive benchmark tiers'],
                  ].map(([type, desc]) => (
                    <div key={desc} style={{ display: 'flex', gap: 12, marginBottom: 8, alignItems: 'flex-start' }}>
                      <span
                        style={{
                          color:
                            type === 'SUBMITTED'
                              ? '#4ade80'
                              : type === 'BENCHMARK'
                                ? '#fbbf24'
                                : type === 'PROBE'
                                  ? '#60a5fa'
                                  : '#a78bfa',
                          fontSize: 10,
                          minWidth: 68,
                          marginTop: 1,
                        }}
                      >
                        {type}
                      </span>
                      <span style={{ color: '#3d5c3d' }}>{desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            </FadeIn>
            <FadeIn delay={0.2}>
              <div>
                <h3
                  style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}
                >
                  Attack Vectors
                </h3>
                <div style={{ display: 'grid', gap: 10 }}>
                  {[
                    [
                      'Hardware Spoofing',
                      'Claiming wrong η',
                      'Statistical monitoring: >20% deviation triggers re-benchmark',
                    ],
                    [
                      'Power Misreporting',
                      'Faking W(t) readings',
                      'Ledger peers cross-check probe computation speed against declared hardware TDP — excess claimed wattage without matching proof speed caps attestation level',
                    ],
                    [
                      'Sampling Manipulation',
                      'Infrequent sampling misses spikes',
                      'Protocol requires minimum sampling rate; proof verifies sample count',
                    ],
                    [
                      'Sybil Attack',
                      'Split identity to game rewards',
                      'Proportional share is calculated on total energy — splitting provides zero advantage',
                    ],
                    [
                      '51% Attack',
                      'Majority network power',
                      'Cost = energy for >50% of honest blocks — prohibitively expensive',
                    ],
                    [
                      'Hardware Forgery',
                      'Fake benchmark certificates',
                      'Chain-derived seeds prevent pre-computation; issuing peer wall-clock measures true elapsed time; attestation level rises only by passing successive benchmark tiers',
                    ],
                  ].map(([attack, method, mitigation]) => (
                    <div
                      key={attack}
                      style={{
                        background: '#0a160a',
                        border: '1px solid #1e3a1e',
                        borderRadius: 10,
                        padding: '12px 16px',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginBottom: 6,
                          gap: 8,
                          flexWrap: 'wrap',
                        }}
                      >
                        <span style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8' }}>
                          {attack}
                        </span>
                        <Pill color="#ef4444">{method}</Pill>
                      </div>
                      <div style={{ fontSize: 12, color: '#3d5c3d', lineHeight: 1.5 }}>{mitigation}</div>
                    </div>
                  ))}
                </div>
              </div>
            </FadeIn>
          </div>
        </div>
      </Section>

      {/* ── Staking ── */}
      <Section id="staking">
        <div style={container}>
          <SectionTitle number={12} title="Staking" />
          <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 32 }}>
            Staking lets WTC holders earn passive rewards by locking their coins in the protocol. A genesis wallet
            containing <strong style={{ color: '#e8f5e8' }}>166,667 WTC</strong> is reserved exclusively for staking
            rewards and distributed proportionally to stakers until the pool is fully depleted.
          </p>
          <div
            style={{
              padding: '18px 22px',
              background: '#0d0a1a',
              border: '1px solid #a78bfa40',
              borderRadius: 12,
              marginBottom: 40,
            }}
          >
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 11,
                color: '#a78bfa',
                marginBottom: 8,
                letterSpacing: '0.1em',
              }}
            >
              THE COLLECTIVE MECHANIC — MORE STAKED, HIGHER APY FOR ALL
            </div>
            <p style={{ fontSize: 14, color: '#7aaa7a', lineHeight: 1.7, margin: 0 }}>
              Unlike traditional staking where more participants dilute individual yield, Wattcoin staking works the
              opposite way:{' '}
              <strong style={{ color: '#e8f5e8' }}>
                the more WTC staked across the network, the higher the APY for every staker
              </strong>
              . For every 10,000 WTC added to the staking pool network-wide, all stakers earn 1% more per year.
              Collective participation increases individual reward.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}>
                APY Formula
              </h3>
              <div
                style={{
                  background: '#0a160a',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  padding: '22px 28px',
                  marginBottom: 24,
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 12,
                  color: '#4ade80',
                  lineHeight: 2,
                }}
              >
                <div style={{ color: '#3d5c3d' }}>{'// 1% APY per 10,000 WTC staked network-wide'}</div>
                <div>APY(S) = floor(S / 10,000) × 1%</div>
                <div style={{ color: '#3d5c3d', marginTop: 8 }}>{'// S = total WTC staked across entire network'}</div>
                <div>&nbsp;</div>
                <div style={{ color: '#3d5c3d' }}>{'// Examples:'}</div>
                <div>&nbsp;&nbsp;S = &nbsp;10,000 WTC &nbsp;→ APY = &nbsp;1%</div>
                <div>&nbsp;&nbsp;S = 100,000 WTC &nbsp;→ APY = 10%</div>
                <div>&nbsp;&nbsp;S = 166,667 WTC &nbsp;→ APY = 16%</div>
                <div style={{ color: '#4ade80' }}>
                  &nbsp;&nbsp;S = 333,333 WTC &nbsp;→ APY = 33% &nbsp;{'// max — all public sale WTC staked'}
                </div>
              </div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}>
                APY Milestones
              </h3>
              <div style={{ overflowX: 'auto' }}>
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr style={{ borderBottom: '1px solid #1e3a1e' }}>
                      {['Network Staked', 'APY', 'Annual per 10k'].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: '8px 12px',
                            textAlign: 'left',
                            color: '#4ade80',
                            fontWeight: 500,
                            fontSize: 11,
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['10,000 WTC', '1%', '100 WTC'],
                      ['50,000 WTC', '5%', '500 WTC'],
                      ['100,000 WTC', '10%', '1,000 WTC'],
                      ['120,000 WTC', '12%', '1,200 WTC'],
                      ['150,000 WTC', '15%', '1,500 WTC'],
                      ['166,667 WTC', '16%', '1,600 WTC'],
                      ['333,333 WTC', '33%', '3,300 WTC'],
                    ].map(([staked, apy, annual], i) => (
                      <tr
                        key={staked}
                        style={{
                          borderBottom: '1px solid #0f1f0f',
                          color: i === 6 ? '#4ade80' : '#7aaa7a',
                          fontWeight: i === 6 ? 600 : 400,
                        }}
                      >
                        <td style={{ padding: '7px 12px' }}>{staked}</td>
                        <td style={{ padding: '7px 12px' }}>{apy}</td>
                        <td style={{ padding: '7px 12px' }}>{annual}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}>
                How Staking Works
              </h3>
              {[
                [
                  '01',
                  'STAKE',
                  'Lock WTC via the Staking tab in the Wattcoin Miner app. Your staked coins remain yours — they are not transferred to a third party.',
                ],
                [
                  '02',
                  'EARN',
                  'Rewards accumulate proportionally. A staker holding 1% of all staked WTC earns 1% of every reward distribution. APY is recalculated as total staked changes.',
                ],
                [
                  '03',
                  'CLAIM',
                  'Accumulated staking rewards are sent to your wallet address and visible in the built-in blockchain explorer.',
                ],
                [
                  '04',
                  'UNSTAKE',
                  'Unstake at any time. Your staked principal is returned to your wallet. Any outstanding rewards are paid out at unstake.',
                ],
              ].map(([num, title, desc]) => (
                <div key={num} style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#4ade80', minWidth: 24 }}>
                    {num}
                  </div>
                  <div>
                    <div
                      style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 3 }}
                    >
                      {title}
                    </div>
                    <div style={{ fontSize: 12, color: '#3d5c3d', lineHeight: 1.5 }}>{desc}</div>
                  </div>
                </div>
              ))}
              <div
                style={{
                  padding: '16px 20px',
                  background: '#0a160a',
                  borderRadius: 10,
                  borderLeft: '2px solid #4ade80',
                  marginTop: 8,
                }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 10,
                    color: '#4ade80',
                    letterSpacing: '0.08em',
                    marginBottom: 6,
                  }}
                >
                  STAKING POOL LIFETIME
                </div>
                <div style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.6 }}>
                  The staking rewards pool contains 166,667 WTC. Once fully distributed, the staking programme ends
                  permanently — there is no replenishment. Early stakers benefit from the deepest pool and the longest
                  reward window.
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Wattcoin Vortex NFT ── */}
      <Section id="nft-collection">
        <div style={container}>
          <SectionTitle number={13} title="Wattcoin Vortex NFT" />
          <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 40, maxWidth: 680 }}>
            A limited collection of 60 on-chain NFTs tied directly to the Wattcoin Vortex Hydro Turbine. Each NFT
            represents a permanent, transferable profit-share in turbine revenue — tracked natively on the WTC chain,
            with no external dependencies.
          </p>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 24,
              marginBottom: 40,
            }}
          >
            {[
              {
                img: nftImgGold,
                tier: 'GOLD TIER — #1–#10',
                shares: '5 Profit Shares',
                color: '#fbbf24',
                border: '#3a2a00',
                desc: '10 tokens. Each Gold NFT carries 5 profit shares — the highest individual allocation. Holders receive a 5/140 slice of all turbine revenue distributions.',
                threshold: '25,000',
                thresholdColor: '#fbbf24',
                thresholdBg: '#2d2200',
              },
              {
                img: nftImgSilver,
                tier: 'SILVER TIER — #11–#30',
                shares: '3 Profit Shares',
                color: '#9ca3af',
                border: '#2a2a3a',
                desc: '20 tokens. Each Silver NFT carries 3 profit shares. Holders receive a 3/140 slice of all turbine revenue distributions.',
                threshold: '15,000',
                thresholdColor: '#9ca3af',
                thresholdBg: '#1a1a1e',
              },
              {
                img: nftImgBronze,
                tier: 'BRONZE TIER — #31–#60',
                shares: '1 Profit Share',
                color: '#d97706',
                border: '#2a1a0a',
                desc: '30 tokens. Each Bronze NFT carries 1 profit share. Holders receive a 1/140 slice of all turbine revenue distributions.',
                threshold: '5,000',
                thresholdColor: '#d97706',
                thresholdBg: '#2a1500',
              },
            ].map(({ img, tier, shares, color, border, desc, threshold, thresholdColor, thresholdBg }) => (
              <div
                key={tier}
                style={{
                  background: '#0f1a0a',
                  border: `1px solid ${border}`,
                  borderRadius: 14,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <img src={img} alt={tier} style={{ width: '100%', display: 'block' }} />
                <div style={{ padding: 20, display: 'flex', flexDirection: 'column', flex: 1 }}>
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 10,
                      color,
                      letterSpacing: '0.12em',
                      marginBottom: 8,
                    }}
                  >
                    {tier}
                  </div>
                  <div
                    style={{
                      fontFamily: "'Playfair Display', serif",
                      fontSize: 18,
                      fontWeight: 700,
                      color,
                      marginBottom: 8,
                    }}
                  >
                    {shares}
                  </div>
                  <p style={{ fontSize: 13, lineHeight: 1.7, color: '#7aaa7a', margin: 0 }}>{desc}</p>
                  <div style={{ marginTop: 'auto', paddingTop: 14 }}>
                    <div
                      style={{
                        padding: '10px 12px',
                        background: thresholdBg,
                        border: `1px solid ${thresholdColor}44`,
                        borderRadius: 8,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'DM Mono', monospace",
                          fontSize: 9,
                          color: thresholdColor,
                          letterSpacing: '0.1em',
                          marginBottom: 4,
                        }}
                      >
                        SALE REQUIREMENT
                      </div>
                      <div style={{ fontSize: 13, color: '#e8f5e8', lineHeight: 1.5 }}>
                        Purchase{' '}
                        <span
                          style={{
                            color: thresholdColor,
                            fontFamily: "'DM Mono', monospace",
                            fontSize: 14,
                            fontWeight: 'normal',
                          }}
                        >
                          {threshold} WTC
                        </span>{' '}
                        before the sale ends to qualify for this NFT tier.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ background: '#0a160a', border: '1px solid #1e3a1e', borderRadius: 14, padding: 28 }}>
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                color: '#4ade80',
                letterSpacing: '0.12em',
                marginBottom: 14,
              }}
            >
              COLLECTION PRINCIPLES
            </div>
            <ul style={{ margin: 0, paddingLeft: 20, color: '#7aaa7a', fontSize: 14, lineHeight: 1.85 }}>
              <li>
                <strong style={{ color: '#e8f5e8' }}>60 total NFTs — fixed forever.</strong> No additional minting, no
                dilution. The collection is sealed at genesis.
              </li>
              <li>
                <strong style={{ color: '#e8f5e8' }}>140 total profit shares</strong> across all three tiers (10×5 +
                20×3 + 30×1 = 50+60+30 = 140).
              </li>
              <li>
                <strong style={{ color: '#e8f5e8' }}>Voting power mirrors profit share.</strong> Each NFT carries
                governance voting weight equal to its profit-share count — Gold 5 votes, Silver 3 votes, Bronze 1 vote.
                An NFT that earns more earns more say.
              </li>
              <li>
                <strong style={{ color: '#e8f5e8' }}>On-chain ownership.</strong> Every NFT is minted and tracked
                natively on the WTC chain using secp256k1-signed transactions. No smart contract platform required.
              </li>
              <li>
                <strong style={{ color: '#e8f5e8' }}>Transferable &amp; tradeable.</strong> Ownership transfers via
                standard WTC NFT transfer transactions, recorded immutably on-chain.
              </li>
              <li>
                <strong style={{ color: '#e8f5e8' }}>Non-stacking entitlement.</strong> Holding multiple NFTs of the
                same tier does not multiply that tier&apos;s entitlement — each address qualifies for the tier benefit of its{' '}
                <em>highest-tier</em> NFT only. Additional tokens of equal or lower tier carry the same single-tier
                entitlement and do not stack.
              </li>
              <li>
                <strong style={{ color: '#e8f5e8' }}>One NFT earned per wallet.</strong> Each wallet address earns at
                most one NFT from the sale — the single highest tier its purchase total qualifies for. Purchasing beyond
                a tier threshold does not grant additional NFTs.
              </li>
              <li>
                <strong style={{ color: '#e8f5e8' }}>Foundation Reserve launch.</strong> All 60 NFTs are now minted to
                the Foundation Reserve address and are distributed following the public sale close. NFTs that will not
                be distributed after the sale will be distributed afterwards for completing different milestones.
                Milestones will be disclosed after the sale.
              </li>
              <li>
                <strong style={{ color: '#e8f5e8' }}>Revenue source.</strong> Profit distributions are funded by metered
                electricity output from the 60 kW Vortex Gravity Hydro Turbine. Distribution cadence and accounting are
                published by the Foundation.
              </li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── WattDollar ── */}
      <Section id="wtd">
        <div style={container}>
          <div
            style={{
              padding: '12px 20px',
              background: '#1a1000',
              border: '1px solid #fbbf2430',
              borderRadius: 10,
              marginBottom: 24,
              display: 'flex',
              gap: 14,
              alignItems: 'flex-start',
            }}
          >
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                color: '#fbbf24',
                letterSpacing: '0.12em',
                whiteSpace: 'nowrap',
              }}
            >
              PHASE 4 — PLANNED FEATURE
            </div>
            <p style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.7, margin: 0 }}>
              WattDollar is a planned dollar-pegged stablecoin scheduled for Phase 4 of the Wattcoin roadmap. The
              mechanism described below represents the intended design. WTD is not yet live.
            </p>
          </div>
          <SectionTitle number={14} title="WattDollar (WTD)" />
          <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 40, maxWidth: 680 }}>
            A dollar-pegged stablecoin collateralised by locked WTC. Every WTD is backed by real, energy-anchored
            collateral — not algorithmic promises.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 20 }}>
                How It Works
              </h3>
              {[
                [
                  '01',
                  'LOCK WTC',
                  'Deposit WTC into the protocol collateral contract. Your WTC is locked on-chain for the chosen duration — 3, 6, or 12 months.',
                ],
                [
                  '02',
                  'RECEIVE WTD',
                  'The protocol mints WTD proportional to the collateral value and chosen lock duration. WTD is pegged 1:1 to USDC. Longer commitment → higher WTD issuance rate.',
                ],
                [
                  '03',
                  'USE WTD',
                  'Spend, transfer, or deploy WTD in DeFi protocols. It is a standard transferable token pegged 1:1 to USD.',
                ],
                [
                  '04',
                  'BURN WTD TO UNLOCK',
                  'Return the original WTD amount to the protocol. The contract burns it and releases your WTC collateral in full.',
                ],
              ].map(([num, title, desc]) => (
                <div
                  key={num}
                  style={{
                    display: 'flex',
                    gap: 12,
                    marginBottom: 18,
                    padding: '12px 16px',
                    background: '#0a160a',
                    border: '1px solid #1e3a1e',
                    borderRadius: 10,
                  }}
                >
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#4ade80', minWidth: 24 }}>
                    {num}
                  </div>
                  <div>
                    <div
                      style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 3 }}
                    >
                      {title}
                    </div>
                    <div style={{ fontSize: 12, color: '#3d5c3d', lineHeight: 1.5 }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}>
                Lock Duration & WTD Issuance Rate
              </h3>
              <div
                style={{
                  background: '#0a160a',
                  border: '1px solid #1e3a1e',
                  borderRadius: 12,
                  overflow: 'hidden',
                  marginBottom: 20,
                }}
              >
                <table
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 12,
                  }}
                >
                  <thead>
                    <tr>
                      <th
                        style={{
                          padding: '10px 14px',
                          color: '#4ade80',
                          fontWeight: 500,
                          fontSize: 11,
                          letterSpacing: '0.06em',
                          textAlign: 'left',
                          borderBottom: '1px solid #1e3a1e',
                        }}
                      >
                        Lock Duration
                      </th>
                      <th
                        style={{
                          padding: '10px 14px',
                          color: '#4ade80',
                          fontWeight: 500,
                          fontSize: 11,
                          letterSpacing: '0.06em',
                          textAlign: 'right',
                          borderBottom: '1px solid #1e3a1e',
                        }}
                      >
                        WTD Issued
                      </th>
                      <th
                        style={{
                          padding: '10px 14px',
                          color: '#4ade80',
                          fontWeight: 500,
                          fontSize: 11,
                          letterSpacing: '0.06em',
                          textAlign: 'left',
                          borderBottom: '1px solid #1e3a1e',
                        }}
                      >
                        Note
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['3 months', '70% of WTC value', 'Conservative — short-term liquidity'],
                      ['6 months', '85% of WTC value', 'Balanced — mid-term commitment'],
                      ['12 months', '100% of WTC value', 'Full issuance — long-term lock'],
                    ].map(([dur, wtd, note]) => (
                      <tr key={dur} style={{ borderBottom: '1px solid #0f1f0f' }}>
                        <td style={{ padding: '8px 14px', color: '#e8f5e8', textAlign: 'left' }}>{dur}</td>
                        <td style={{ padding: '8px 14px', color: '#4ade80', textAlign: 'right' }}>{wtd}</td>
                        <td style={{ padding: '8px 14px', color: '#7aaa7a', textAlign: 'left', fontSize: 11 }}>
                          {note}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <InfoCard title="NO WTC SUPPLY DILUTION">
                The WTC supply is never diluted by the WTD system. Every WTC that enters collateral is still accounted
                for on-chain and returns to full circulation the moment the matching WTD is burned. Energy-backed value
                is preserved end to end.
              </InfoCard>
              <div style={{ marginTop: 12 }}>
                <InfoCard title="WHY IT MATTERS">
                  WTC holders who believe in long-term appreciation have no reason to sell. WTD lets them access dollar
                  liquidity today while maintaining full exposure to their WTC holding. The WTC supply is not diluted —
                  it is temporarily locked, then returned.
                </InfoCard>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Comparison ── */}
      <Section id="comparison">
        <div style={container}>
          <SectionTitle number={15} title="Comparison" />
          <FadeIn delay={0.1}>
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{ width: '100%', borderCollapse: 'collapse', fontFamily: "'DM Mono', monospace", fontSize: 12 }}
              >
                <thead>
                  <tr style={{ borderBottom: '1px solid #1e3a1e' }}>
                    {['Feature', 'Bitcoin', 'Ethereum PoS', 'Aleo', 'Wattcoin'].map((h, i) => (
                      <th
                        key={h}
                        style={{
                          padding: '12px 16px',
                          textAlign: i === 0 ? 'left' : 'center',
                          color: i === 4 ? '#4ade80' : '#3d5c3d',
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
                  {[
                    ['Consensus', 'Probabilistic PoW', 'Staking', 'Competitive PoSW', 'PoE'],
                    ['Hardware awareness', 'None', 'None', 'None', 'Full — per-hardware tasks'],
                    ['Energy per coin', 'Variable (ASICs)', 'N/A', 'Variable', 'Equal for all hardware'],
                    [
                      'Genesis supply',
                      'None (Satoshi ~1M early mined)',
                      '~72M ETH ICO pre-sale',
                      'Team/investor allocation',
                      '1,000,000 WTC pre-mined',
                    ],
                    ['Economy floor', 'Variable', 'N/A', 'Variable', 'Tier 1 — 20 kWh/coin'],
                    ['Reward model', 'Lottery', 'Staking yield', 'Proportional', 'Proportional by energy'],
                    ['Mining pools', 'Required', 'N/A', 'Optional', 'Obsolete by design'],
                    ['Block time', 'Fixed (10 min)', 'Fixed (12 sec)', 'Variable', 'Emergent from power'],
                    ['Difficulty adjust', 'Yes', 'Yes', 'Yes', 'None — tasks scale with η'],
                    ['Supply', '21M', 'Infinite', '1B', '21M'],
                    ['Fairness', 'ASICs dominate', 'Capital dom.', 'ASICs dominate', 'Energy cost equal'],
                  ].map(([feature, ...vals]) => (
                    <tr key={feature} style={{ borderBottom: '1px solid #0f1f0f' }}>
                      <td style={{ padding: '10px 16px', color: '#7aaa7a', textAlign: 'left' }}>{feature}</td>
                      {vals.map((v, i) => (
                        <td
                          key={i}
                          style={{
                            padding: '10px 16px',
                            color: i === 3 ? '#4ade80' : '#3d5c3d',
                            textAlign: 'center',
                            fontWeight: i === 3 ? 500 : 400,
                          }}
                        >
                          {v}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </FadeIn>
          <FadeIn delay={0.2}>
            <div
              style={{
                marginTop: 80,
                padding: '48px 40px',
                background: 'linear-gradient(135deg, #0a160a 0%, #0d1f0d 100%)',
                border: '1px solid #2e4a2e',
                borderRadius: 20,
                textAlign: 'center',
              }}
            >
              <div
                style={{
                  fontFamily: "'DM Mono', monospace",
                  fontSize: 11,
                  color: '#4ade80',
                  letterSpacing: '0.15em',
                  marginBottom: 16,
                }}
              >
                CONCLUSION
              </div>
              <h2
                style={{
                  fontFamily: "'Playfair Display', serif",
                  fontSize: 34,
                  fontWeight: 900,
                  color: '#e8f5e8',
                  letterSpacing: '-0.02em',
                  marginBottom: 24,
                  lineHeight: 1.2,
                }}
              >
                The first cryptocurrency where energy is the equalizer
              </h2>
              <p style={{ fontSize: 16, color: '#7aaa7a', lineHeight: 1.85, maxWidth: 640, margin: '0 auto 20px' }}>
                Wattcoin solves the defining failure of Proof-of-Work: the richest hardware wins. By anchoring block
                rewards to verified energy — not raw computation speed — every miner on any hardware pays the same
                energy cost per block. <strong style={{ color: '#4ade80' }}>10 MWh = 1 block</strong> is not a target or
                an average. It is a law, enforced on-chain, forever. Block rewards halve each tier — but the energy
                required per block never changes.
              </p>
              <p style={{ fontSize: 16, color: '#7aaa7a', lineHeight: 1.85, maxWidth: 640, margin: '0 auto 20px' }}>
                Mining pools, luck variance, and ASIC dominance are not problems to be patched. They are symptoms of a
                fundamentally broken incentive structure. Wattcoin eliminates the disease, not the symptoms.
              </p>
              <p style={{ fontSize: 16, color: '#7aaa7a', lineHeight: 1.85, maxWidth: 640, margin: '0 auto 32px' }}>
                As the global cost of electricity rises — driven by demand growth, infrastructure investment, and the
                energy transition — the real-world cost floor of every WTC rises with it. Coins mined early carry the
                lowest energy price ever attached to this chain. That advantage never disappears.
              </p>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
                {[
                  'Fair Mining',
                  'Hardware Agnostic',
                  'Energy Backed',
                  'Peer Verified',
                  'Fixed Supply',
                  'Pre-Mined Genesis',
                  'No Mining Pools',
                  'Zero Luck Variance',
                ].map((tag) => (
                  <Pill key={tag}>{tag}</Pill>
                ))}
              </div>
            </div>
          </FadeIn>
          <FadeIn delay={0.3}>
            <div
              style={{
                marginTop: 80,
                padding: '48px 40px',
                background: '#0a160a',
                border: '1px solid #1e3a1e',
                borderRadius: 20,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 28, flexWrap: 'wrap' }}>
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 11,
                    color: '#4ade80',
                    letterSpacing: '0.15em',
                  }}
                >
                  GENESIS WALLET DIRECTORY — 1,000,000 WTC TOTAL ALLOCATION
                </div>
                <ElecDial price={elecPrice} live={elecLive} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 28 }}>
                {[
                  { label: 'FOUNDATION', amount: '200,000', pct: '20%', color: '#4ade80' },
                  { label: 'PUBLIC SALE', amount: '333,333', pct: '33.3%', color: '#fbbf24' },
                  { label: 'STAKING', amount: '166,667', pct: '16.7%', color: '#a78bfa' },
                  { label: 'TEAM', amount: '300,000', pct: '30%', color: '#38bdf8' },
                ].map(({ label, amount, pct, color }) => (
                  <div
                    key={label}
                    style={{
                      textAlign: 'center',
                      padding: '14px 10px',
                      background: '#0d160d',
                      borderRadius: 10,
                      border: '1px solid #1e3a1e',
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: 10,
                        color,
                        letterSpacing: '0.1em',
                        marginBottom: 6,
                      }}
                    >
                      {label}
                    </div>
                    <div
                      style={{
                        fontFamily: "'Playfair Display', serif",
                        fontSize: 22,
                        fontWeight: 700,
                        color: '#e8f5e8',
                      }}
                    >
                      {amount}
                    </div>
                    <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 10, color: '#3d5c3d', marginTop: 4 }}>
                      {pct}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'grid', gap: 20 }}>
                {[
                  {
                    address: 'wtc1q073k2x8qvgd6xf7jvq64zkngyh7m7qdt4vvmrn',
                    label: 'Foundation Reserve',
                    amount: '200,000 WTC',
                    color: '#4ade80',
                    description:
                      '200,000 WTC allocated to the Wattcoin Foundation for ongoing network operations, infrastructure hosting, marketing, community development, and ecosystem growth. The operational backbone that keeps Wattcoin running and expanding.',
                  },
                  {
                    address: 'wtc1qd6dqez6rvh3ak2xw9jtsz3h8na0ssyepjgec3t',
                    label: 'Public Sale',
                    amount: '333,333 WTC',
                    color: '#fbbf24',
                    description:
                      'The one and only WTC public sale — ever. 333,333 WTC across three tiers: Tier 1 (111,111 WTC) at ⅓ of mining cost, Tier 2 (111,111 WTC) at ⅔ of mining cost, Tier 3 (111,111 WTC) at full Tier 1 mining cost. Prices anchored to real electricity cost.',
                  },
                  {
                    address: 'wtc1q7t624zx7px3ypd3u6zaz0hr7knpa0aun7d56gv',
                    label: 'Staking Rewards',
                    amount: '166,667 WTC',
                    color: '#a78bfa',
                    description:
                      '166,667 WTC reserved exclusively for staking rewards, distributed proportionally to stakers until the pool is fully depleted. APY grows with network participation: 1% per 10,000 WTC staked. At 100,000 WTC staked → 10% APY. At 166,667 WTC staked → 16% APY. At 333,333 WTC staked → 33% APY (maximum — all public sale WTC staked). Collective commitment multiplies individual reward — the more the network stakes, the more everyone earns.',
                  },
                  {
                    address: 'wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw',
                    label: 'Team',
                    amount: '300,000 WTC',
                    color: '#38bdf8',
                    description:
                      '300,000 WTC reserved for the Wattcoin development team. Funds protocol development, security research, audits, and long-term ecosystem growth. All allocations are on-chain and auditable by anyone at any time.',
                  },
                ].map(({ address, label, amount, color, description }) => (
                  <div
                    key={address}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr',
                      gap: '0 24px',
                      alignItems: 'start',
                      padding: '20px 24px',
                      background: '#0d160d',
                      border: `1px solid ${color}22`,
                      borderLeft: `3px solid ${color}`,
                      borderRadius: 12,
                    }}
                  >
                    <div>
                      <div
                        style={{
                          fontFamily: "'DM Mono', monospace",
                          fontSize: 10,
                          color,
                          letterSpacing: '0.12em',
                          marginBottom: 4,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {label.toUpperCase()}
                      </div>
                      <div
                        style={{
                          fontFamily: "'Playfair Display', serif",
                          fontSize: 18,
                          fontWeight: 700,
                          color,
                          marginBottom: 6,
                        }}
                      >
                        {amount}
                      </div>
                      <div
                        style={{
                          fontFamily: "'DM Mono', monospace",
                          fontSize: 11,
                          color: '#4a7a4a',
                          wordBreak: 'break-all',
                          maxWidth: 340,
                        }}
                      >
                        {address}
                      </div>
                    </div>
                    <div style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.7, paddingTop: 2 }}>{description}</div>
                  </div>
                ))}
              </div>
            </div>
          </FadeIn>
          <FadeIn delay={0.35}>
            <div
              style={{
                marginTop: 48,
                textAlign: 'center',
                fontFamily: "'DM Mono', monospace",
                fontSize: 11,
                color: '#1e3a1e',
              }}
            >
              WATTCOIN FOUNDATION — VERSION {APP_VERSION} — MAY 2026
            </div>
          </FadeIn>
        </div>
      </Section>

      {/* ── Roadmap ── */}
      <Section id="roadmap">
        <div style={container}>
          <SectionTitle number={16} title="Roadmap" />
          <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 40 }}>
            Four phases from launch to a full-stack energy-backed monetary system. Each phase is anchored to verifiable
            on-chain milestones, not promises. Phase 1 now includes the Vortex hydro turbine initiative — Wattcoin&apos;s
            first real-world physical energy asset.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            {[
              {
                badge: 'PHASE 1 — LIVE NOW',
                badgeColor: '#4ade80',
                title: 'Launch & Sale',
                borderColor: '#4ade8050',
                items: [
                  { text: 'Mainnet live — P2P network operational', done: true },
                  { text: 'Wattcoin Miner for Windows (v1.x)', done: true },
                  { text: 'Public sale open — 333,333 WTC across 3 tiers', done: true },
                  { text: 'Staking live — 166,667 WTC reward pool active', done: true },
                  { text: 'Built-in wallet, explorer, buy & stake interface', done: true },
                  { text: 'Foundation seed peer infrastructure', done: true },
                  'Vortex Hydro Turbine — land acquisition & project coordination begins after Tier 1 close',
                ],
              },
              {
                badge: 'PHASE 2 — GROWTH',
                badgeColor: '#3d5c3d',
                title: 'Network Expansion',
                borderColor: '#1e3a1e',
                items: [
                  'Linux miner build',
                  'Public block explorer website',
                  'First independent protocol security audit',
                  'Staking dashboard & real-time APY tracker',
                  'Foundation transparency report — on-chain audit',
                  'Vortex Turbine construction begins upon receipt of all required permits',
                  'Live turbine metering integrated into Wattcoin Miner app',
                  'Early Adopter Energy Pool distributions go live',
                ],
              },
              {
                badge: 'PHASE 3 — ECOSYSTEM',
                badgeColor: '#3d5c3d',
                title: 'Broad Adoption',
                borderColor: '#1e3a1e',
                items: [
                  'macOS miner build',
                  'CEX listing outreach (tier-1 exchange targets)',
                  'Mobile view-only wallet (iOS & Android)',
                  'Hardware vendor certification — official η values',
                  'Cross-chain bridge — ERC-20 ↔ native WTC',
                  'On-chain PIP governance signalling',
                ],
              },
              {
                badge: 'PHASE 4 — PROTOCOL MATURITY',
                badgeColor: '#fbbf24',
                title: 'Energy-Backed Monetary Layer',
                borderColor: '#fbbf2440',
                background: '#0f130a',
                items: [
                  'Smart contract / scripting layer',
                  'WTD WattDollar — stablecoin collateralised by WTC',
                  'WTC as on-chain collateral for DeFi protocols',
                  'Layer-2 micropayment channels (energy / IoT)',
                  'Annual Foundation transparency reports',
                ],
                hint: {
                  label: 'WTD WATTDOLLAR — PHASE 4 PREVIEW',
                  text: 'WattDollar is a planned dollar-pegged stablecoin backed by WTC collateral locked on-chain. Because every WTC has a verifiable, non-negotiable energy cost floor, WTD inherits real-world energy backing — a stablecoin whose collateral cannot be printed into existence.',
                },
              },
            ].map(({ badge, badgeColor, title, borderColor, background, items, hint }) => (
              <div
                key={badge}
                style={{
                  background: background || '#0a160a',
                  border: `1px solid ${borderColor}`,
                  borderRadius: 14,
                  padding: 28,
                }}
              >
                <div
                  style={{
                    fontFamily: "'DM Mono', monospace",
                    fontSize: 10,
                    color: badgeColor,
                    letterSpacing: '0.12em',
                    marginBottom: 14,
                  }}
                >
                  {badge}
                </div>
                <h3
                  style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}
                >
                  {title}
                </h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 0 0' }}>
                  {items.map((item) => {
                    const text = typeof item === 'string' ? item : item.text;
                    const done = typeof item === 'object' && item.done;
                    return (
                      <li
                        key={text}
                        style={{
                          fontSize: 13,
                          color: '#7aaa7a',
                          lineHeight: 1.6,
                          padding: '4px 0',
                          borderBottom: '1px solid #0f1f0f',
                          display: 'flex',
                          gap: 8,
                          alignItems: 'baseline',
                        }}
                      >
                        <span style={{ color: '#fbbf24', fontFamily: "'DM Mono', monospace", fontSize: 11 }}>
                          {done ? '✓' : '→'}
                        </span>
                        {text}
                      </li>
                    );
                  })}
                </ul>
                {hint && (
                  <div
                    style={{
                      marginTop: 20,
                      padding: '14px 16px',
                      background: '#0f1505',
                      border: '1px solid #fbbf2420',
                      borderRadius: 8,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "'DM Mono', monospace",
                        fontSize: 10,
                        color: '#fbbf24',
                        letterSpacing: '0.1em',
                        marginBottom: 6,
                      }}
                    >
                      {hint.label}
                    </div>
                    <div style={{ fontSize: 13, color: '#7aaa7a', lineHeight: 1.65 }}>{hint.text}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── Governance ── */}
      <Section id="governance">
        <div style={container}>
          <SectionTitle number={17} title="Governance" />
          <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 40 }}>
            Wattcoin governance transitions to Vortex NFT holders upon distribution. Until then, the Wattcoin Foundation
            proposes protocol upgrades publicly, seeks community feedback openly, and coordinates development. Once NFTs
            are distributed, voting power rests exclusively with NFT holders their on-chain signals drive all material
            protocol decisions. The core economic rules: energy per coin, block rewards, and total supply are protected
            constants.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 20 }}>
                Upgrade Process
              </h3>
              {[
                [
                  '01',
                  'PROPOSAL (PIP)',
                  'The Foundation or any community member publishes a Protocol Improvement Proposal describing the change, motivation, and expected impact.',
                ],
                [
                  '02',
                  'DISCUSSION',
                  'A minimum 14-day public comment period. The Foundation publishes written responses to all significant objections.',
                ],
                [
                  '03',
                  'COMMUNITY SIGNALLING',
                  'Upon distribution, Vortex NFT holders become the voting body for protocol governance. Voting power mirrors profit-share allocations — Gold (5 votes), Silver (3 votes), Bronze (1 vote) — ensuring governance authority aligns with economic commitment. The Foundation reviews on-chain signals from NFT holders and treats their consensus as binding-equivalent guidance for core protocol upgrades.',
                ],
                [
                  '04',
                  'DECISION & RELEASE',
                  'The Foundation publishes a final decision with full rationale. Approved upgrades ship as a new Wattcoin Miner version.',
                ],
              ].map(([num, title, desc]) => (
                <div key={num} style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#4ade80', minWidth: 24 }}>
                    {num}
                  </div>
                  <div>
                    <div
                      style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 3 }}
                    >
                      {title}
                    </div>
                    <div style={{ fontSize: 12, color: '#3d5c3d', lineHeight: 1.5 }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}>
                Immutable Principles
              </h3>
              <InfoCard title="HARD CAP — INVIOLABLE">
                The 21,000,000 WTC supply cap is a protocol constant. No governance process can modify it. Any proposal
                to inflate supply is automatically invalid.
              </InfoCard>
              <div style={{ marginTop: 12 }}>
                <InfoCard title="ENERGY LAW — PROTECTED">
                  The 20 kWh/coin Tier 1 floor and the halving schedule define the economic core of Wattcoin. Changes to
                  these parameters require overwhelming community consensus.
                </InfoCard>
              </div>
              <div style={{ marginTop: 12 }}>
                <InfoCard title="GENESIS WALLETS — ON-CHAIN">
                  All genesis allocations are visible on the public chain. Foundation spending from the reserve wallet
                  is on-chain and auditable by anyone at any time.
                </InfoCard>
              </div>
              <div style={{ marginTop: 12 }}>
                <InfoCard title="NFT VOTING WEIGHT">
                  Vortex NFT holders carry weighted votes matching their profit-share tier — Gold (5), Silver (3),
                  Bronze (1). An NFT that earns more, decides more. Voting weight is verified on-chain against NFT
                  ownership at the time of the signal.
                </InfoCard>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Network & Seed Peers ── */}
      <Section id="network">
        <div style={container}>
          <SectionTitle number={18} title="Network & Seed Peers" />
          <p style={{ fontSize: 16, lineHeight: 1.85, color: '#7aaa7a', marginBottom: 40 }}>
            The Wattcoin blockchain runs on a peer-to-peer network of full nodes. Every Wattcoin Miner installation
            holds a complete copy of the chain, validates all blocks independently, and participates in consensus. There
            are no trusted intermediaries — the network is the ledger.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 20 }}>
                Bootstrap Process
              </h3>
              {[
                [
                  '01',
                  'SEED CONNECTION',
                  'The node contacts bundled seed peers and downloads the current chain tip, peer directory, and network parameters.',
                ],
                [
                  '02',
                  'PEER EXCHANGE',
                  'Connected peers share their own peer directories. Within seconds the node learns about dozens of active participants and selects the highest-quality connections.',
                ],
                [
                  '03',
                  'LAN DISCOVERY',
                  'On local networks, nodes broadcast UDP multicast beacons so nearby miners discover each other automatically — no internet connection required for local network mining.',
                ],
                [
                  '04',
                  'PEER CACHING',
                  'Known peers are cached locally. After the first connection, the node reconnects instantly on restart without contacting seed peers — the network is fully self-sustaining.',
                ],
              ].map(([num, title, desc]) => (
                <div key={num} style={{ display: 'flex', gap: 12, marginBottom: 18 }}>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: '#4ade80', minWidth: 24 }}>
                    {num}
                  </div>
                  <div>
                    <div
                      style={{ fontFamily: "'DM Mono', monospace", fontSize: 11, color: '#e8f5e8', marginBottom: 3 }}
                    >
                      {title}
                    </div>
                    <div style={{ fontSize: 12, color: '#3d5c3d', lineHeight: 1.5 }}>{desc}</div>
                  </div>
                </div>
              ))}
            </div>
            <div>
              <h3 style={{ fontFamily: "'Playfair Display', serif", fontSize: 20, color: '#e8f5e8', marginBottom: 16 }}>
                Network Properties
              </h3>
              <InfoCard title="FULL NODES ONLY">
                Every Wattcoin Miner is a full node. All participants validate the complete chain history independently
                — there are no lightweight clients or trusted validators.
              </InfoCard>
              <div style={{ marginTop: 12 }}>
                <InfoCard title="SEED INDEPENDENCE">
                  Seed peers are a bootstrapping convenience, not a dependency. Once peer caches are populated, the
                  network operates entirely peer-to-peer and continues even if all Foundation seed nodes go offline.
                </InfoCard>
              </div>
              <div style={{ marginTop: 12 }}>
                <InfoCard title="NAT & REVERSE TUNNEL SUPPORT">
                  Nodes behind NAT firewalls participate fully using built-in reverse tunnel support, ensuring home
                  miners are first-class network citizens regardless of their internet configuration.
                </InfoCard>
              </div>
              <div style={{ marginTop: 12 }}>
                <InfoCard title="PROOF-OF-REACHABILITY">
                  Peers are continuously probed for reachability. Unreachable peers are removed from the active set and
                  automatically rediscovered when they return online.
                </InfoCard>
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* ── Risk Disclaimer ── */}
      <Section id="disclaimer" style={{ borderBottom: 'none' }}>
        <div style={container}>
          <div style={{ border: '1px solid #1a2a1a', borderRadius: 12, padding: '32px 36px', background: '#080e08' }}>
            <div
              style={{
                fontFamily: "'DM Mono', monospace",
                fontSize: 10,
                color: '#3d5c3d',
                letterSpacing: '0.15em',
                marginBottom: 20,
              }}
            >
              RISK DISCLOSURE & LEGAL DISCLAIMER
            </div>
            <p style={{ fontSize: 13, lineHeight: 1.8, color: '#5a7a5a', marginBottom: 14 }}>
              <strong style={{ color: '#7aaa7a' }}>Informational purposes only.</strong> This document and all materials
              published by the Wattcoin Foundation are provided for informational and educational purposes only. Nothing
              contained herein constitutes financial, investment, legal, or tax advice. You should conduct your own
              independent research and consult qualified professional advisers before making any financial decision.
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.8, color: '#5a7a5a', marginBottom: 14 }}>
              <strong style={{ color: '#7aaa7a' }}>Experimental protocol.</strong> Wattcoin is an early-stage
              experimental cryptocurrency protocol. Participation in mining, purchasing, or staking WTC carries
              substantial risk, including but not limited to: loss of the entire amount invested, software bugs, network
              attacks, hardware failure, regulatory action, and price volatility. The value of WTC may fall to zero.
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.8, color: '#5a7a5a', marginBottom: 14 }}>
              <strong style={{ color: '#7aaa7a' }}>Regulatory and jurisdictional responsibility.</strong> It is your
              sole responsibility to determine whether acquiring, holding, mining, or transacting WTC is legal in your
              jurisdiction and to comply with all applicable laws, regulations, and tax obligations.
            </p>
            <p style={{ fontSize: 13, lineHeight: 1.8, color: '#5a7a5a', marginBottom: 0 }}>
              <strong style={{ color: '#7aaa7a' }}>Limitation of liability.</strong> To the maximum extent permitted by
              law, the Wattcoin Foundation and its contributors accept no liability for any damages arising from
              participation in the Wattcoin network or reliance on information published herein. All protocol
              parameters, timelines, and roadmap items are subject to change without notice.
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}
