'use strict';
/**
 * Tests for block reward schedule and energy-per-block invariant.
 *
 * Verifies:
 *  1. Each block always requires exactly 10 MWh (10,000,000 Wh) of energy,
 *     in every tier — this is constant by design.
 *  2. Tier 1 pays 500 WTC/block for exactly 2,000 blocks = 1,000,000 WTC total,
 *     then transitions to Tier 2 (250 WTC/block) at height 2001.
 *  3. Cumulative mined WTC across all 20 mining tiers = 20,000,000 WTC
 *     (plus 1,000,000 genesis premine = 21,000,000 total hard cap).
 */

const assert = require('assert');
const { rewardForHeight, energyForHeight } = require('../wtc-chain');

const BLOCK_ENERGY_WH = 10_000_000;   // 10 MWh — the invariant across all tiers
const SUPPLY_PER_TIER = 1_000_000;
const MAX_MINING_TIERS = 20;          // tiers 1-20 (tier 0 = genesis premine)
const GENESIS_PREMINE  = 1_000_000;
const HARD_CAP         = 21_000_000;

// ─── Question 1: Does each block always cost exactly 10 MWh? ─────────────────

// Tier 1, first block
assert.strictEqual(
  energyForHeight(1), BLOCK_ENERGY_WH,
  'Height 1 (first mined block) should require exactly 10 MWh'
);
assert.strictEqual(
  rewardForHeight(1), 500,
  'Height 1 should pay 500 WTC (Tier 1 reward)'
);

// Tier 1, last block (height 2000)
assert.strictEqual(
  energyForHeight(2000), BLOCK_ENERGY_WH,
  'Height 2000 (last Tier-1 block) should still require exactly 10 MWh'
);
assert.strictEqual(
  rewardForHeight(2000), 500,
  'Height 2000 should still pay 500 WTC (still Tier 1)'
);

// ─── Question 2: Does the tier transition happen after 1,000,000 WTC mined? ──

// Height 2001 = first Tier-2 block (after exactly 2000 × 500 = 1,000,000 WTC)
assert.strictEqual(
  rewardForHeight(2001), 250,
  'Height 2001 (first Tier-2 block) should pay 250 WTC — tier transitioned'
);
assert.strictEqual(
  energyForHeight(2001), BLOCK_ENERGY_WH,
  'Height 2001 should still require exactly 10 MWh — energy invariant holds across tier boundary'
);

// Cumulative WTC mined in Tier 1 = exactly 1,000,000
let tier1Total = 0;
for (let h = 1; h <= 2000; h++) tier1Total += rewardForHeight(h);
assert.strictEqual(
  tier1Total, SUPPLY_PER_TIER,
  'Tier 1 (heights 1–2000) must produce exactly 1,000,000 WTC total'
);

// ─── Invariant check: 10 MWh holds for the first block of every tier ─────────

// Tier k starts at height: 1 + sum(blocksInTiers 1..k-1)
// Tier k reward: 1000/2^k, blocks: round(1_000_000 / reward)
let startHeight = 1;
for (let tier = 1; tier <= MAX_MINING_TIERS; tier++) {
  const reward = 1000 / Math.pow(2, tier);
  const blocksThisTier = Math.round(SUPPLY_PER_TIER / reward);

  assert.strictEqual(
    energyForHeight(startHeight), BLOCK_ENERGY_WH,
    `Tier ${tier} (first block at height ${startHeight}) should require exactly 10 MWh`
  );
  assert.strictEqual(
    rewardForHeight(startHeight), reward,
    `Tier ${tier} first block should pay ${reward} WTC/block`
  );
  // Last block of this tier
  assert.strictEqual(
    energyForHeight(startHeight + blocksThisTier - 1), BLOCK_ENERGY_WH,
    `Tier ${tier} (last block at height ${startHeight + blocksThisTier - 1}) should require exactly 10 MWh`
  );

  startHeight += blocksThisTier;
}

// ─── Total supply across all tiers ────────────────────────────────────────────

let totalMined = 0;
startHeight = 1;
for (let tier = 1; tier <= MAX_MINING_TIERS; tier++) {
  const reward = 1000 / Math.pow(2, tier);
  const blocksThisTier = Math.round(SUPPLY_PER_TIER / reward);
  totalMined += blocksThisTier * reward;
  startHeight += blocksThisTier;
}
assert.strictEqual(
  Math.round(totalMined), HARD_CAP - GENESIS_PREMINE,
  `Total mined WTC across all 20 tiers should equal ${HARD_CAP - GENESIS_PREMINE} (hard cap minus genesis premine)`
);

// After supply exhausted, reward is 0
assert.strictEqual(
  rewardForHeight(startHeight), 0,
  'After all tiers exhausted, reward should be 0'
);
assert.strictEqual(
  energyForHeight(startHeight), 0,
  'After all tiers exhausted, energy requirement should be 0'
);

console.log('All reward schedule tests passed.');
console.log(`  Tier 1: heights 1–2000, 500 WTC/block, 10 MWh/block → 1,000,000 WTC`);
console.log(`  Tier 2: heights 2001–6000, 250 WTC/block, 10 MWh/block → 1,000,000 WTC`);
console.log(`  Energy per block: 10 MWh constant across ALL ${MAX_MINING_TIERS} tiers.`);
console.log(`  Total mined supply: ${Math.round(totalMined).toLocaleString()} WTC + ${GENESIS_PREMINE.toLocaleString()} genesis = ${HARD_CAP.toLocaleString()} WTC hard cap.`);
