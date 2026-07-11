import { TIER0_ENERGY, TIER1_ENERGY, COINS_PER_TIER, TOTAL_TIERS } from '../wattcoin/wattcoinConstants';

const TOTAL_COINS = COINS_PER_TIER * TOTAL_TIERS;
const energyForTier = (n) => (n === 0 ? TIER0_ENERGY : TIER1_ENERGY * Math.pow(2, n - 1));

export function computeCoinsFromEnergyWallet(energyWh) {
  let remainingWh = Math.max(0, Number(energyWh) || 0);
  let minedCoins = 0;
  for (let tier = 0; tier < TOTAL_TIERS; tier++) {
    const energyPerCoinWh = energyForTier(tier);
    const tierMaxWh = COINS_PER_TIER * energyPerCoinWh;
    if (remainingWh >= tierMaxWh) {
      minedCoins += COINS_PER_TIER;
      remainingWh -= tierMaxWh;
    } else {
      minedCoins += remainingWh / energyPerCoinWh;
      return Math.min(TOTAL_COINS, minedCoins);
    }
  }
  return Math.min(TOTAL_COINS, minedCoins);
}

export const PAGE_SIZE = 20;

export function shortHash(h) {
  if (!h || h.length < 16) return h || '-';
  return h.slice(0, 8) + '\u2026' + h.slice(-6);
}

export function formatTs(ms) {
  if (!ms) return '-';
  try {
    return new Date(ms).toLocaleString();
  } catch (_) {
    return '-';
  }
}

export function proofColor(type) {
  switch (type) {
    case 'gpu':
      return '#a78bfa';
    case 'memory':
      return '#60a5fa';
    default:
      return '#4ade80';
  }
}

export function proofLabel(type) {
  switch (type) {
    case 'gpu':
      return 'GPU';
    case 'memory':
      return 'MEM';
    default:
      return 'CPU';
  }
}
