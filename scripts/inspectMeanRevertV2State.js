// scripts/inspectMeanRevertV2State.js
//
// Inspect the current on-chain state of the MeanRevert V2 system on CHIPNET.
//
// - Reinstantiates MeanRevertSingleTokenNFTAuthV2.cash using config.js
// - Discovers contract.tokenAddress (FTs)
// - Sums FT balances for the configured FT_CATEGORY_HEX at:
//     * contract.tokenAddress   (tokensOnContract)
//     * aliceTokenAddress       (Alice's FT balance)
// - Ignores any other token categories, but reports them.
//
// Usage:
//   node scripts/inspectMeanRevertV2State.js

import { ElectrumNetworkProvider, Contract } from "cashscript";
import { compileFile } from "cashc";

import {
  NETWORK,
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
  TARGET_TOKENS,
} from "../config.js";
import { aliceTokenAddress, alicePkh } from "../common.js";
import { splitByToken } from "../utxos.js";
import { formatSats } from "../bigint.js";

const utxoValue = (u) => BigInt(u.satoshis ?? u.value);

const safeJson = (o) =>
  JSON.stringify(
    o,
    (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v),
    2
  );

function hexToBytes(hex) {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${cleaned.length}`);
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return bytes;
}

function summarizeTokenUtxos(utxos, categoryHex) {
  const ftCategory = categoryHex.toLowerCase();

  const ftUtxos = [];
  const otherTokenCategories = new Set();

  for (const u of utxos) {
    if (!u.token) continue;
    const cat =
      typeof u.token.category === "string"
        ? u.token.category.toLowerCase()
        : Buffer.from(u.token.category).toString("hex").toLowerCase();

    if (cat === ftCategory && !u.token.nft) {
      ftUtxos.push(u);
    } else {
      otherTokenCategories.add(cat);
    }
  }

  const totalTokens = ftUtxos.reduce(
    (sum, u) => sum + BigInt(u.token.amount ?? 0n),
    0n
  );
  const totalBacking = ftUtxos.reduce((sum, u) => sum + utxoValue(u), 0n);

  return {
    ftUtxos,
    totalTokens,
    totalBacking,
    otherTokenCategories: [...otherTokenCategories],
  };
}

async function main() {
  console.log("==========================================");
  console.log(" Inspect MeanRevertSingleTokenNFTAuthV2");
  console.log("==========================================\n");
  console.log(`[network] Using NETWORK="${NETWORK}"\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);

  // Recreate the contract so we can derive the same tokenAddress as in deploy/fund.
  console.log("[contract] Instantiating MeanRevertSingleTokenNFTAuthV2...");
  const artifact = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuthV2.cash", import.meta.url)
  );

  const tokenCategoryBytes = hexToBytes(FT_CATEGORY_HEX);
  const rebalancerNftCatBytes = hexToBytes(NFT_CATEGORY_HEX);
  const rebalancerNftCommitBytes = hexToBytes(REBALANCER_NFT_COMMITMENT_HEX);

  const contract = new Contract(
    artifact,
    [
      tokenCategoryBytes,
      TARGET_TOKENS,
      rebalancerNftCatBytes,
      rebalancerNftCommitBytes,
      alicePkh,
    ],
    { provider }
  );

  console.log("Contract BCH-only address :", contract.address);
  console.log("Contract token address    :", contract.tokenAddress);
  console.log("Configured FT category    :", FT_CATEGORY_HEX);
  console.log("Configured NFT category   :", NFT_CATEGORY_HEX);
  console.log("Target token amount       :", TARGET_TOKENS.toString());
  console.log("");

  // ---------------------------------------------------------------------------
  // 1) Inspect contract.tokenAddress (on-chain FT position)
  // ---------------------------------------------------------------------------
  console.log("=== UTXOs at contract.tokenAddress (FTs) ===");
  console.log(`Address: ${contract.tokenAddress}\n`);

  const contractUtxos = await provider.getUtxos(contract.tokenAddress);
  const { withTokens: contractTokenUtxos, bchOnly: contractBchOnly } =
    splitByToken(contractUtxos);

  console.log(`Total UTXOs     : ${contractUtxos.length}`);
  console.log(`  BCH-only      : ${contractBchOnly.length}`);
  console.log(`  Token-bearing : ${contractTokenUtxos.length}`);

  const contractSummary = summarizeTokenUtxos(
    contractTokenUtxos,
    FT_CATEGORY_HEX
  );

  console.log(
    `\n[contract] FT UTXOs for FT_CATEGORY_HEX (${FT_CATEGORY_HEX}): ${contractSummary.ftUtxos.length}`
  );
  console.log(
    `[contract] Total FT tokens (this category) : ${contractSummary.totalTokens.toString()}`
  );
  console.log(
    `[contract] Total BCH backing (this category): ${formatSats(
      contractSummary.totalBacking
    )} (sats)`
  );

  if (contractSummary.otherTokenCategories.length) {
    console.log(
      "\n[contract] Other token categories seen at contract.tokenAddress (ignored):"
    );
    for (const cat of contractSummary.otherTokenCategories) {
      console.log(`  - ${cat}`);
    }
  } else {
    console.log(
      "[contract] No other token categories found at contract.tokenAddress."
    );
  }

  if (contractSummary.ftUtxos.length) {
    console.log("\n[contract] FT UTXO details (this category):");
    contractSummary.ftUtxos.forEach((u, i) => {
      console.log(`  [${i}]`, safeJson(u));
    });
  } else {
    console.log(
      "\n[contract] No FT UTXOs for FT_CATEGORY_HEX yet – contract not funded?"
    );
  }

  // ---------------------------------------------------------------------------
  // 2) Inspect aliceTokenAddress (controller/off-contract FT position)
  // ---------------------------------------------------------------------------
  console.log("\n=== UTXOs at aliceTokenAddress (controller) ===");
  console.log(`Address: ${aliceTokenAddress}\n`);

  const aliceUtxos = await provider.getUtxos(aliceTokenAddress);
  const { withTokens: aliceTokenUtxos, bchOnly: aliceBchOnly } =
    splitByToken(aliceUtxos);

  console.log(`Total UTXOs     : ${aliceUtxos.length}`);
  console.log(`  BCH-only      : ${aliceBchOnly.length}`);
  console.log(`  Token-bearing : ${aliceTokenUtxos.length}`);

  const aliceSummary = summarizeTokenUtxos(aliceTokenUtxos, FT_CATEGORY_HEX);

  console.log(
    `\n[alice] FT UTXOs for FT_CATEGORY_HEX (${FT_CATEGORY_HEX}): ${aliceSummary.ftUtxos.length}`
  );
  console.log(
    `[alice] Total FT tokens (this category) : ${aliceSummary.totalTokens.toString()}`
  );
  console.log(
    `[alice] Total BCH backing (this category): ${formatSats(
      aliceSummary.totalBacking
    )} (sats)`
  );

  if (aliceSummary.otherTokenCategories.length) {
    console.log(
      "\n[alice] Other token categories seen at aliceTokenAddress (ignored):"
    );
    for (const cat of aliceSummary.otherTokenCategories) {
      console.log(`  - ${cat}`);
    }
  } else {
    console.log(
      "[alice] No other token categories found at aliceTokenAddress."
    );
  }

  if (aliceSummary.ftUtxos.length) {
    console.log("\n[alice] FT UTXO details (this category):");
    aliceSummary.ftUtxos.forEach((u, i) => {
      console.log(`  [${i}]`, safeJson(u));
    });
  } else {
    console.log(
      "\n[alice] No FT UTXOs for FT_CATEGORY_HEX at aliceTokenAddress."
    );
  }

  // ---------------------------------------------------------------------------
  // 3) Mean-reversion snapshot
  // ---------------------------------------------------------------------------
  const tokensOnContract = contractSummary.totalTokens;
  const tokensWithAlice = aliceSummary.totalTokens;
  const totalSystemTokens = tokensOnContract + tokensWithAlice;

  const diff = tokensOnContract - TARGET_TOKENS;
  const absDiff = diff < 0n ? -diff : diff;

  console.log("\n=== Mean-reversion snapshot ===");
  console.log(
    `tokensOnContract (for FT_CATEGORY_HEX): ${tokensOnContract.toString()}`
  );
  console.log(
    `tokensWithAlice                 : ${tokensWithAlice.toString()}`
  );
  console.log(
    `totalSystemTokens (contract+alice)   : ${totalSystemTokens.toString()}`
  );
  console.log(`targetTokenAmount (config)      : ${TARGET_TOKENS.toString()}`);
  console.log(`|tokensOnContract - target|         : ${absDiff.toString()}`);
  console.log(
    "\nUse this along with the oracle planner to decide if a rebalance should be attempted.\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Error inspecting MeanRevert V2 state:", err);
    process.exitCode = 1;
  });
}
