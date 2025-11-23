// config.js
// Central configuration for CashScript demo scripts.
//
// NOTE: This file is intentionally minimal – all other scripts should
// import from here instead of hardcoding these values.

//
// Network config
//  - "chipnet" for BCH chipnet (test network for CHIPs/loops)
//  - "mainnet" or "testnet4" if you later change environments.
//
export const NETWORK = "chipnet";

//
// SumInputs constructor argument
//  - minTotalSats is the minimum total of *all* input values required
//    by the covenant (sum of tx.inputs[i].value).
//
export const MIN_TOTAL_SATS = 15000n;

//
// Funding amounts
//  - FUNDING_AMOUNT: a large funding amount you might use when creating
//    single-UTXO contract outputs.
//  - SMALL_FUNDING_AMOUNT / SMALL_FUND_COUNT: parameters for creating
//    many small contract UTXOs in a loop experiment.
//
export const FUNDING_AMOUNT = 20000n;

// Small funding scenario – create many small contract UTXOs
export const SMALL_FUNDING_AMOUNT = 1000n; // sats per small UTXO
export const SMALL_FUND_COUNT = 15; // 15 × 1000 = 15000

//
// Fee settings
//  - SATS_PER_BYTE: simple linear fee model used in all demo scripts.
//    Everything should use this constant so you can tweak fees in one place.
//
export const SATS_PER_BYTE = 1n;

//
// Dust handling
//  - DUST_THRESHOLD: minimum value for a BCH output to be considered
//    economically spendable. For BCH this is commonly 546 sats.
//
export const DUST_THRESHOLD = 1000n;

//
// Contract spend splitting
//  - SPEND_SPLIT_OUTPUTS: max number of outputs to split contract spends into
//    when you build demos that fan-out to multiple recipients.
//
export const SPEND_SPLIT_OUTPUTS = 4;

// ---------------------------------------------------------------------------
// Mean Revert V2 / CashTokens demo constants
// ---------------------------------------------------------------------------
//
// NOTE:
// These are demo-specific, network-specific values for chipnet.
// If you re-run mintAllForAlice and get new FT/NFT categories, update these.
//
// - FT_CATEGORY_HEX comes from the FT genesis UTXO (vout=0) you chose
// - NFT_CATEGORY_HEX comes from the NFT genesis UTXO (vout=0)
// - REBALANCER_NFT_COMMITMENT_HEX is the NFT commitment used in the covenant
// - TARGET_TOKENS is the contract's targetTokenAmount
// - INITIAL_TOKENS_ON_CONTRACT is how many FT you want to park on contract
//   in the funding demo (e.g. 800 vs target 1000).

export const FT_CATEGORY_HEX =
  "72841fa040aeeaeb4b3b08a7b74794cfddd97e3eac519c5290de44b5a297624c";

export const NFT_CATEGORY_HEX =
  "06165b5aecd9b02a29bb12b08446d4ed01e7bde60035287ebb12fd4b6d2c2553";

export const REBALANCER_NFT_COMMITMENT_HEX = "6e667430"; // "nft0"

export const TARGET_TOKENS = 1000n;

export const INITIAL_TOKENS_ON_CONTRACT = 800n;
