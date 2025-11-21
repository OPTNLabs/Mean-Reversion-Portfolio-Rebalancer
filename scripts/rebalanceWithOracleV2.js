// scripts/rebalanceWithOracleV2.js
//
// Sketch of an oracle-aware rebalancer driver for
// MeanRevertSingleTokenNFTAuthV2.cash.
//
// Current behaviour:
//   - Fetches latest price from oracles.cash
//   - Decodes the 16-byte price message
//   - Logs a *hypothetical* rebalance plan for the V2 contract
//
// This script does NOT yet:
//   - Query real UTXOs for the live contract
//   - Build/broadcast a transaction
//   - Mutate any on-chain state
//
// Those steps are intentionally left as TODOs so we can iteratively
// plug in real providers (ElectrumNetworkProvider, indexers, etc.)
// and your actual portfolio strategy.

// Node ESM imports
import { getLatestPriceMessageForOracle } from "../oracles/oraclesClient.js";
import { decodePriceMessageHex } from "../oracles/priceCodec.js";

import {
  alicePkh,
  aliceAddress,
  aliceTokenAddress,
  alicePriv,
} from "../common.js";

// NOTE: We import CashScript tooling but don't *yet* use it to send TXs.
// This keeps the script executable while showing exactly which pieces
// we'll plug in later.
import {
  Contract,
  TransactionBuilder,
  SignatureTemplate,
  MockNetworkProvider,
  // ElectrumNetworkProvider, // <- for future mainnet/testnet wiring
  randomUtxo,
} from "cashscript";

import { compileFile } from "cashc";

// -----------------------------------------------------------------------------
// Config – strategy + oracle settings
// -----------------------------------------------------------------------------

// General Protocols BCH/USD oracle public key (from docs/oracles.cash)
const DEFAULT_ORACLE_PUBKEY =
  "02d09db08af1ff4e8453919cc866a4be427d7bfe18f2c05e5444c196fcf6fd2818";

// How many BCH worth of exposure we "target" in this simple sketch.
// In a real setup, this might be read from config, DB, or per-portfolio settings.
const TARGET_USD_EXPOSURE = 1_000; // e.g. 1000 USD worth of BCH exposure

// This is purely an example: the on-chain contract currently takes a fixed
// `targetTokenAmount` at construction time, so the oracle here is used for
// *off-chain decision making* (when/if to rebalance, and how much), not to
// dynamically change the contract's on-chain target.
const CONTRACT_TARGET_TOKENS = 1_000n; // Matches tests: TARGET_TOKENS

// -----------------------------------------------------------------------------
// Helper: load MeanRevertSingleTokenNFTAuthV2 (local artifact via compileFile)
// -----------------------------------------------------------------------------

async function loadMeanRevertV2Contract({
  provider,
  tokenCategoryBytes,
  rebalancerNftCatBytes,
  rebalancerNftCommitBytes,
}) {
  const artifact = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuthV2.cash", import.meta.url)
  );

  const contract = new Contract(
    artifact,
    [
      tokenCategoryBytes,
      CONTRACT_TARGET_TOKENS,
      rebalancerNftCatBytes,
      rebalancerNftCommitBytes,
      alicePkh,
    ],
    { provider }
  );

  return contract;
}

// -----------------------------------------------------------------------------
// Strategy sketch – compute a *candidate* new token position
// -----------------------------------------------------------------------------

/**
 * Very simple toy strategy:
 *
 * - Take current oracle BCH/USD price.
 * - Compute how many "BCH units" we would like to hold for TARGET_USD_EXPOSURE.
 *   (desiredBch = TARGET_USD_EXPOSURE / price)
 * - Interpret 1 FT token as "1 unit of BCH exposure".
 * - Clamp to a sane range (0 → 2 * CONTRACT_TARGET_TOKENS).
 *
 * This is *not* binding on-chain – the contract's mean-reversion inequality
 * is still enforced by the covenant; this strategy just suggests a new
 * position we'd like to aim for.
 */
function planNewTokenPositionFromOracle({
  priceValue,
  currentTokensOnContract,
}) {
  // priceValue is scaled by x100 (e.g. 47622 => 476.22 USD/BCH)
  const priceUsdPerBch = priceValue / 100;

  // Avoid divide-by-zero / nonsense data
  if (!priceUsdPerBch || priceUsdPerBch <= 0) {
    return {
      desiredTokensOnContract: currentTokensOnContract,
      reason: "Invalid oracle price (<= 0); keeping current allocation.",
    };
  }

  // "How many BCH would represent TARGET_USD_EXPOSURE at this price?"
  const desiredBchExposureFloat = TARGET_USD_EXPOSURE / priceUsdPerBch;

  // Interpret 1 FT = 1 unit of BCH; round to integer tokens
  const desiredTokensFloat = desiredBchExposureFloat;
  let desiredTokens = BigInt(Math.round(desiredTokensFloat));

  // Clamp to [0, 2 * CONTRACT_TARGET_TOKENS] for this demo
  const maxTokens = CONTRACT_TARGET_TOKENS * 2n;
  if (desiredTokens < 0n) desiredTokens = 0n;
  if (desiredTokens > maxTokens) desiredTokens = maxTokens;

  return {
    desiredTokensOnContract: desiredTokens,
    reason:
      "Simple oracle-driven exposure: tokens ~= TARGET_USD_EXPOSURE / BCH_price.",
  };
}

// -----------------------------------------------------------------------------
// Placeholder: inspect current contract state (mocked for now)
// -----------------------------------------------------------------------------

/**
 * In a real setup, this would:
 *   - Query the live UTXOs for contract.tokenAddress
 *   - Sum FT token amounts matching the contract's tokenCategory
 *
 * For now, we just return a mocked position so we can reason about
 * the strategy numbers without touching a real network.
 */
async function getMockCurrentContractState() {
  // In tests, we often start with 800 tokens on contract vs target=1000.
  // We'll reuse that here as the "current state".
  const mockedTokensOnContract = 800n;

  return {
    tokensOnContract: mockedTokensOnContract,
  };
}

// -----------------------------------------------------------------------------
// Main driver
// -----------------------------------------------------------------------------

async function main() {
  console.log("=== Oracle-aware MeanRevert V2 rebalancer (SKETCH) ===\n");

  // 1) Fetch latest oracle price
  const latest = await getLatestPriceMessageForOracle({
    oraclePublicKey: DEFAULT_ORACLE_PUBKEY,
  });

  if (!latest) {
    console.error("No oracle messages available for this public key.");
    process.exitCode = 1;
    return;
  }

  const { messageHex, oraclePublicKey, raw } = latest;
  const decoded = decodePriceMessageHex(messageHex);

  const { messageTimestamp, messageSequence, dataSequence, priceValue } =
    decoded;

  const priceScaled = priceValue / 100;

  console.log("Oracle pubkey      :", oraclePublicKey);
  console.log("Message sequence   :", messageSequence);
  console.log("Data sequence      :", dataSequence);
  console.log(
    "Timestamp          :",
    `${messageTimestamp} (${new Date(messageTimestamp * 1000).toISOString()})`
  );
  console.log("Raw priceValue     :", priceValue, "(scaled x100)");
  console.log("Price (USD/BCH)    :", priceScaled);
  console.log("");

  // 2) Inspect current contract state (mocked for now)
  const currentState = await getMockCurrentContractState();
  const currentTokens = currentState.tokensOnContract;

  console.log(
    "Current tokens on contract (mocked) :",
    currentTokens.toString()
  );
  console.log(
    "Contract targetTokenAmount          :",
    CONTRACT_TARGET_TOKENS.toString()
  );
  console.log("");

  // 3) Run simple oracle-driven strategy to get desired new position
  const plan = planNewTokenPositionFromOracle({
    priceValue,
    currentTokensOnContract: currentTokens,
  });

  const desired = plan.desiredTokensOnContract;

  console.log("=== Proposed oracle-driven rebalance plan (OFF-CHAIN) ===");
  console.log("Reason             :", plan.reason);
  console.log("Current tokens     :", currentTokens.toString());
  console.log("Desired tokens     :", desired.toString());

  const distBefore = currentTokens - CONTRACT_TARGET_TOKENS;
  const absBefore = distBefore < 0n ? -distBefore : distBefore;

  const distAfter = desired - CONTRACT_TARGET_TOKENS;
  const absAfter = distAfter < 0n ? -distAfter : distAfter;

  console.log("distBefore (|current - target|):", absBefore.toString());
  console.log("distAfter  (|desired - target|):", absAfter.toString());
  console.log(
    "Would satisfy mean-reversion inequality?:",
    absAfter <= absBefore
      ? "YES (distAfter <= distBefore)"
      : "NO (distAfter > distBefore)"
  );
  console.log("");

  // 4) Sketch of how the actual transaction builder will be wired (TODO)
  console.log("=== NEXT STEPS (not executed yet) ===");
  console.log(
    "- [ ] Replace MockNetworkProvider with ElectrumNetworkProvider for your network."
  );
  console.log("- [ ] Discover live contract UTXOs and real tokenCategory.");
  console.log(
    "- [ ] Instantiate MeanRevertSingleTokenNFTAuthV2 with the correct constructor args."
  );
  console.log("- [ ] Build a TransactionBuilder that:");
  console.log(
    "      * spends the contract UTXO(s) via contract.unlock.rebalance()"
  );
  console.log(
    "      * includes a valid NFT input with the required commitment"
  );
  console.log("      * redistributes FTs so that:");
  console.log("          - newTokensOnContract == desiredTokensOnContract");
  console.log(
    "          - |new - target| <= |old - target| (enforced by contract)"
  );
  console.log("- [ ] Broadcast and monitor confirmations.\n");

  console.log(
    "This script currently only prints the plan. Once we're happy with the\n" +
      "strategy and mean-reversion math, we'll upgrade it to actually build\n" +
      "and send the rebalance transaction.\n"
  );
}

// Only run main() when executed directly: `node scripts/rebalanceWithOracleV2.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal error in oracle rebalancer sketch:", err);
    process.exitCode = 1;
  });
}
