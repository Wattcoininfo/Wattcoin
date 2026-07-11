const COINS_PER_TIER = 1_000_000;
const TOTAL_TIERS = 21;
const TIER0_ENERGY = 1;
const TIER1_ENERGY = 20_000;

const energyForTier = (n) => (n === 0 ? TIER0_ENERGY : TIER1_ENERGY * Math.pow(2, n - 1));

export function computeCoinsFromEnergy(energyWh) {
  let remainingWh = Math.max(0, Number(energyWh) || 0);
  let minedCoins = 0;
  const maxCoins = COINS_PER_TIER * TOTAL_TIERS;

  for (let tier = 0; tier < TOTAL_TIERS; tier++) {
    const energyPerCoinWh = energyForTier(tier);
    const tierCoinCap = COINS_PER_TIER;
    const tierMaxEnergyWh = tierCoinCap * energyPerCoinWh;

    if (remainingWh >= tierMaxEnergyWh) {
      minedCoins += tierCoinCap;
      remainingWh -= tierMaxEnergyWh;
    } else {
      minedCoins += remainingWh / energyPerCoinWh;
      return Math.min(maxCoins, minedCoins);
    }
  }

  return Math.min(maxCoins, minedCoins);
}
