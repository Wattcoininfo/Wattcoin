// SPDX-License-Identifier: MIT
'use strict';

// ─── Protocol & addresses ──────────────────────────────────────────────────
//
// These are protocol-level constants that define the WTC blockchain's
// foundation-reserve, staking-pool, and sale-fund wallets.
// They are intentionally hardcoded — they define the immutable protocol
// and cannot be changed without a coordinated network upgrade.
//
// All modules MUST import these from a single source of truth so that
// changes propagate consistently across the entire codebase.

// Foundation Reserve — mints NFTs and holds the pre-mined reserve
const MINTER_ADDRESS = 'wtc1q073k2x8qvgd6xf7jvq64zkngyh7m7qdt4vvmrn';

// Staking pool — rewards are paid out from this address
const STAKING_POOL_ADDRESS = 'wtc1q7t624zx7px3ypd3u6zaz0hr7knpa0aun7d56gv';

// Sale fund — receives USDC payments and sends WTC to buyers
const SALE_WTC_ADDRESS = 'wtc1qd6dqez6rvh3ak2xw9jtsz3h8na0ssyepjgec3t';

// USDC seller address on Ethereum mainnet
const SELLER_USDC_ADDRESS = '0x0ca8cc23d85e5c988828076978c4ca65aa4293e8';

// USDC ERC-20 contract on Ethereum mainnet
const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

// Additional addresses permitted to initiate withdrawals
const ALLOWED_SENDER_ADDRESSES = new Set([
  MINTER_ADDRESS,
  SALE_WTC_ADDRESS,
  'wtc1qcfrnhn0mh0wmrq0q5dyku0z55q8kwdx2dt6etw',
  STAKING_POOL_ADDRESS,
]);

module.exports = {
  MINTER_ADDRESS,
  STAKING_POOL_ADDRESS,
  SALE_WTC_ADDRESS,
  SELLER_USDC_ADDRESS,
  USDC_CONTRACT,
  ALLOWED_SENDER_ADDRESSES,
};
