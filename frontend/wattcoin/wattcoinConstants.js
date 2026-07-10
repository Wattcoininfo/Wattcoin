// ─── App version ─────────────────────────────────────────────────────────────────
// Resolved at runtime from the Electron app metadata via preload — keeps the
// whitepaper in sync with the actual desktop app version and window title.
export const APP_VERSION =
  typeof window !== 'undefined' && window.wattcoinHardware && window.wattcoinHardware.appVersion
    ? window.wattcoinHardware.appVersion
    : '?';

// ─── Core Parameters ───────────────────────────────────────────────────────────
const COINS_PER_TIER = 1_000_000;
const NUM_TIERS = 21;
export const TOTAL_SUPPLY = NUM_TIERS * COINS_PER_TIER; // 21,000,000

// Tier 0 = 1 Wh (bootstrap tier)
// Tier 1 = 20,000 Wh (20 kWh)
// Tier n≥1 = 20,000 × 2^(n-1) Wh
export const TIER0_ENERGY = 1;
export const TIER1_ENERGY = 20_000;
export const BASE_REWARD = 1000;

const energyForTier = (n) => (n === 0 ? TIER0_ENERGY : TIER1_ENERGY * Math.pow(2, n - 1));

let _totalWh = 0;
for (let n = 0; n < NUM_TIERS; n++) _totalWh += COINS_PER_TIER * energyForTier(n);
export const TOTAL_ENERGY_TWH = _totalWh / 1e12; // ~21,000 TWh

export const TIERS = Array.from({ length: NUM_TIERS }, (_, n) => {
  const epc = energyForTier(n);
  const reward = BASE_REWARD / Math.pow(2, n);
  const blocksThisTier = Math.round(COINS_PER_TIER / reward);
  const tierEnergyTWh = (COINS_PER_TIER * epc) / 1e12;
  const costAt18 = epc * 0.00018;
  const cumulative = COINS_PER_TIER * (n + 1);
  return { n, epc, reward, blocksThisTier, tierEnergyTWh, costAt18, cumulative };
});

export const HARDWARE = [
  { id: 0, name: 'RHM (Reference)', type: 'Reference', eta: 1.0, color: '#8B6F47' },
  { id: 1, name: 'Intel i9-14900K', type: 'CPU', eta: 0.095, color: '#0071C5' },
  { id: 2, name: 'AMD Ryzen 9 7950X', type: 'CPU', eta: 0.092, color: '#ED1C24' },
  { id: 3, name: 'NVIDIA RTX 4090', type: 'GPU', eta: 0.0092, color: '#76B900' },
  { id: 4, name: 'AMD RX 7900 XTX', type: 'GPU', eta: 0.0095, color: '#ED1C24' },
  { id: 5, name: 'Antminer S21', type: 'ASIC', eta: 0.00095, color: '#F7931A' },
  { id: 6, name: 'Whatsminer M60', type: 'ASIC', eta: 0.00094, color: '#F7931A' },
];

const FAIRNESS_NAME_FONT = "11px 'DM Mono', monospace";

export function getFairnessLabelWidthPx() {
  if (typeof document === 'undefined') return 150;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return 150;
  ctx.font = FAIRNESS_NAME_FONT;
  return Math.ceil(Math.max(...HARDWARE.map((hw) => ctx.measureText(hw.name).width)));
}

export const NETWORK_POWERS = [
  { label: '1 MW', w: 1e6 },
  { label: '10 MW', w: 1e7 },
  { label: '100 MW', w: 1e8 },
  { label: '1 GW', w: 1e9 },
  { label: '12.5 GW (½ global)', w: 12.5e9 },
  { label: '25 GW (full global)', w: 25e9 },
];

// ─── Formatters ────────────────────────────────────────────────────────────────
export const fmtNum = (v, d = 0) => v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
export const fmtSci = (v) =>
  v === 0 ? '0' : v < 0.00001 ? v.toExponential(3) : v < 1 ? v.toFixed(5) : v < 10000 ? fmtNum(v, 2) : fmtNum(v, 0);
export const fmtCost = (c) =>
  c < 0.0001
    ? c.toFixed(7) + '¢'
    : c < 0.01
      ? c.toFixed(5) + '¢'
      : c < 1
        ? c.toFixed(4) + '¢'
        : c < 100
          ? '$' + c.toFixed(2)
          : '$' + fmtNum(Math.round(c));
export const fmtEnergy = (wh) => {
  if (wh >= 1e12) return (wh / 1e12).toFixed(0) + ' TWh';
  if (wh >= 1e9) return (wh / 1e9).toFixed(0) + ' GWh';
  if (wh >= 1e6) return (wh / 1e6).toFixed(0) + ' MWh';
  if (wh >= 1e3) return (wh / 1e3).toFixed(0) + ' kWh';
  return wh.toFixed(0) + ' Wh';
};
export const fmtYears = (y) =>
  y >= 2
    ? y.toFixed(1) + ' years'
    : y * 365.25 >= 2
      ? Math.round(y * 365.25) + ' days'
      : Math.round(y * 365.25 * 24) + ' hours';
// ─── Electricity Dial ─────────────────────────────────────────────────────────
export const TIER1_WH = 20000; // 20 kWh
export const ELEC_FALLBACK = 0.174;
