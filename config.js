// config.js

export const NETWORK = "chipnet";

// SumInputs constructor argument
export const MIN_TOTAL_SATS = 15000n;

// Default large funding amount (for single-UTXO tests)
export const FUNDING_AMOUNT = 20000n;

// Small funding scenario – create many small contract UTXOs
export const SMALL_FUNDING_AMOUNT = 1000n; // sats per small UTXO
export const SMALL_FUND_COUNT = 15; // was 5 – now 15 × 1000 = 15000

// Fee settings
export const SATS_PER_BYTE = 1n;

// Dust handling
export const DUST_THRESHOLD = 546n;

// Max outputs to split contract spends into
export const SPEND_SPLIT_OUTPUTS = 4;
