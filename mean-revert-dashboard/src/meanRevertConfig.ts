// mean-revert-dashboard/src/meanRevertConfig.ts

// Human-readable network name
export const NETWORK_NAME = "chipnet";

// CashToken category IDs – must match loops/config.js
export const FT_CATEGORY_HEX =
  "72841fa040aeeaeb4b3b08a7b74794cfddd97e3eac519c5290de44b5a297624c";

export const NFT_CATEGORY_HEX =
  "06165b5aecd9b02a29bb12b08446d4ed01e7bde60035287ebb12fd4b6d2c2553";

export const REBALANCER_NFT_COMMITMENT_HEX = "6e667430";

// Contract addresses – copied from deploy / inspect logs
//   V3 contract.address      : bchtest:pdu88tqjn0y0y9z7jrl6m6rfnzry3ama4smzmspc6vw6vw0hucudgctt37elv
//   V3 contract.tokenAddress : bchtest:rdu88tqjn0y0y9z7jrl6m6rfnzry3ama4smzmspc6vw6vw0hucudg2chs8cx8
export const CONTRACT_ADDRESS =
  "bchtest:pdu88tqjn0y0y9z7jrl6m6rfnzry3ama4smzmspc6vw6vw0hucudgctt37elv";

export const CONTRACT_TOKEN_ADDRESS =
  "bchtest:rdu88tqjn0y0y9z7jrl6m6rfnzry3ama4smzmspc6vw6vw0hucudg2chs8cx8";

// Alice treasury addresses – copied from your scripts/common.js logs
//   Alice BCH (P2PKH)        : bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy9f4vyfw
//   Alice tokens (p2pkhWithTokens): bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma
export const ALICE_ADDRESS =
  "bchtest:qqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy9f4vyfw";

export const ALICE_TOKEN_ADDRESS =
  "bchtest:zqqsg7fpq3c4xz3pgc6algdm8tjst4x5jy0rptz0ma";

// Mean-reversion parameters – keep in sync with config.js / tests
export const PRICE_RAW = 10000; // 100.00 USD/BCH (scaled x100)
export const TARGET_TOKENS = 1000n;
export const INITIAL_TOKENS_ON_CONTRACT = 800n;
