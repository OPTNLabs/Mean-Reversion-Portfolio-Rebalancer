// scripts/fundMeanRevertV2FromAlice.js
//
// Send INITIAL_TOKENS_ON_CONTRACT FT from aliceTokenAddress to the
// MeanRevert V2 contract's token address on CHIPNET.
//
// - Uses FT/NFT categories + commitment defined in config.js
// - Keeps FT change (and backing BCH) at aliceTokenAddress
// - Uses at least 1000 sats for *all* token-bearing outputs
// - Uses an additional BCH-only UTXO (if available) to fund backing + fees
//
// Usage:
//   node scripts/fundMeanRevertV2FromAlice.js

import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  Contract,
} from "cashscript";
import { compileFile } from "cashc";

import {
  NETWORK,
  SATS_PER_BYTE,
  DUST_THRESHOLD,
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
  TARGET_TOKENS,
  INITIAL_TOKENS_ON_CONTRACT,
} from "../config.js";
import { alicePriv, aliceTokenAddress, alicePkh } from "../common.js";
import { splitByToken } from "../utxos.js";

const utxoValue = (u) => BigInt(u.satoshis ?? u.value);

// Minimum sats we want on any token-bearing output.
const TOKEN_OUTPUT_BACKING = 1000n;

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

const safeJson = (o) =>
  JSON.stringify(
    o,
    (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v),
    2
  );

function logInputs(label, ins) {
  console.log(`\n--- ${label} INPUTS ---`);
  ins.forEach((u, i) => {
    console.log(
      ` [${i}] txid=${u.txid} vout=${u.vout} sats=${utxoValue(u)} token=${
        u.token ? safeJson(u.token) : "none"
      }`
    );
  });
}

function logOutputs(label, outs) {
  console.log(`\n--- ${label} OUTPUTS ---`);
  outs.forEach((o, i) => {
    console.log(
      ` [${i}]`,
      safeJson({
        ...o,
        amount: o.amount?.toString(),
        token: o.token
          ? { ...o.token, amount: o.token.amount?.toString() }
          : undefined,
      })
    );
  });
}

async function main() {
  console.log("==========================================");
  console.log(" Fund MeanRevert V2 contract from Alice");
  console.log("==========================================\n");
  console.log(`[network] Using NETWORK="${NETWORK}"`);
  console.log(`[addr] aliceTokenAddress: ${aliceTokenAddress}\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);

  // Re-instantiate the contract so we can derive tokenAddress
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

  console.log("Contract token address (FTs):", contract.tokenAddress, "\n");

  // --- Step 1: inspect Alice token/BCH UTXOs ---------------------------------
  const aliceUtxos = await provider.getUtxos(aliceTokenAddress);
  const { withTokens, bchOnly } = splitByToken(aliceUtxos);

  console.log("=== Alice token UTXOs (aliceTokenAddress) ===");
  console.log(`Total UTXOs     : ${aliceUtxos.length}`);
  console.log(`  BCH-only      : ${bchOnly.length}`);
  console.log(`  Token-bearing : ${withTokens.length}`);

  const ftUtxos = withTokens.filter(
    (u) =>
      u.token &&
      u.token.category === FT_CATEGORY_HEX &&
      (u.token.amount ?? 0n) > 0n &&
      !u.token.nft
  );

  if (!ftUtxos.length) {
    throw new Error(
      "No FT UTXOs found for the configured FT_CATEGORY_HEX at aliceTokenAddress.\n" +
        "Hint: run mintAllForAlice.js first."
    );
  }

  if (!bchOnly.length) {
    throw new Error(
      "[fund] Need at least one BCH-only UTXO at aliceTokenAddress to fund\n" +
        "       token backing (1000 sats per token output) and fees.\n" +
        "       Hint: send some BCH to aliceTokenAddress, then retry."
    );
  }

  if (ftUtxos.length > 1) {
    console.log(
      `[warn] Found ${ftUtxos.length} FT UTXOs. Using the first (you can refine this later).`
    );
  }

  // Pick one FT UTXO and the largest BCH-only UTXO as fee/backing input
  const ftUtxo = ftUtxos[0];

  bchOnly.sort((a, b) => Number(utxoValue(b) - utxoValue(a)));
  const feeUtxo = bchOnly[0];

  const fundingInputs = [ftUtxo, feeUtxo];
  const totalBacking = fundingInputs.reduce((sum, u) => sum + utxoValue(u), 0n);

  const totalTokens = BigInt(ftUtxo.token.amount ?? 0n);

  console.log("\n[fund] Selected FT UTXO as input:");
  console.log(safeJson({ ...ftUtxo, satoshis: utxoValue(ftUtxo).toString() }));
  console.log("[fund] Selected BCH-only UTXO as fee/backing input:");
  console.log(
    safeJson({ ...feeUtxo, satoshis: utxoValue(feeUtxo).toString() })
  );
  console.log(`[fund] Total FT tokens in FT input: ${totalTokens.toString()}`);
  console.log(
    `[fund] Total BCH backing (all inputs): ${totalBacking.toString()} sats\n`
  );

  if (totalTokens < INITIAL_TOKENS_ON_CONTRACT) {
    throw new Error(
      `[fund] Not enough FT in selected UTXO.\n` +
        `  required = ${INITIAL_TOKENS_ON_CONTRACT.toString()} tokens\n` +
        `  have     = ${totalTokens.toString()} tokens`
    );
  }

  const tokensToContract = INITIAL_TOKENS_ON_CONTRACT;
  const tokensChange = totalTokens - tokensToContract;

  // --- Step 2: Provisional tx to estimate fee -------------------------------
  console.log("[pass1] Building provisional tx to estimate fee...");

  const tmpl = new SignatureTemplate(alicePriv);

  const est = new TransactionBuilder({ provider });
  fundingInputs.forEach((u) => est.addInput(u, tmpl.unlockP2PKH()));

  // Base amounts for estimating size (values don't affect size as long as
  // they're in the same varint range).
  const baseContractBacking = TOKEN_OUTPUT_BACKING;
  const baseChangeBackingIfTokens = TOKEN_OUTPUT_BACKING;
  const baseChangeBackingIfBchOnly = DUST_THRESHOLD;

  // Provisional outputs
  est.addOutput({
    to: contract.tokenAddress,
    amount: baseContractBacking,
    token: {
      category: FT_CATEGORY_HEX,
      amount: tokensToContract,
    },
  });

  if (tokensChange > 0n) {
    // Token change output to aliceTokenAddress
    est.addOutput({
      to: aliceTokenAddress,
      amount: baseChangeBackingIfTokens,
      token: {
        category: FT_CATEGORY_HEX,
        amount: tokensChange,
      },
    });
  } else {
    // BCH-only change output to aliceTokenAddress
    est.addOutput({
      to: aliceTokenAddress,
      amount: baseChangeBackingIfBchOnly,
    });
  }

  const provisionalHex = await est.build();
  const txBytes = BigInt(provisionalHex.length / 2);
  const fee = txBytes * SATS_PER_BYTE;

  console.log(
    `[pass1] Provisional size: ${txBytes} bytes @ ${SATS_PER_BYTE} sat/byte → fee ≈ ${fee} sats`
  );

  // --- Step 3: Compute final backing distribution ----------------------------
  let outputs;

  if (tokensChange > 0n) {
    // Two token-bearing outputs:
    //  - Contract: fixed at 1000 sats
    //  - Token change: at least 1000 sats, plus all extra BCH
    const baseCost = baseContractBacking + baseChangeBackingIfTokens + fee;

    const extra = totalBacking - baseCost;

    if (extra < 0n) {
      throw new Error(
        "[fund] Not enough total BCH to fund: 1000 sats to contract token output,\n" +
          "       1000 sats to token change output, and fees.\n" +
          `       totalBacking = ${totalBacking.toString()} sats\n` +
          `       required     = ${baseCost.toString()} sats`
      );
    }

    const finalContractBacking = baseContractBacking;
    const finalChangeBacking = baseChangeBackingIfTokens + extra;

    outputs = [
      {
        to: contract.tokenAddress,
        amount: finalContractBacking,
        token: {
          category: FT_CATEGORY_HEX,
          amount: tokensToContract,
        },
      },
      {
        to: aliceTokenAddress,
        amount: finalChangeBacking,
        token: {
          category: FT_CATEGORY_HEX,
          amount: tokensChange,
        },
      },
    ];
  } else {
    // Only the contract gets tokens; any remaining BCH goes to a BCH-only
    // change output at aliceTokenAddress.
    const baseCost = baseContractBacking + baseChangeBackingIfBchOnly + fee;
    const extra = totalBacking - baseCost;

    if (extra < 0n) {
      throw new Error(
        "[fund] Not enough total BCH to fund: 1000 sats to contract token output,\n" +
          "       dust BCH-only change output, and fees.\n" +
          `       totalBacking = ${totalBacking.toString()} sats\n` +
          `       required     = ${baseCost.toString()} sats`
      );
    }

    const finalContractBacking = baseContractBacking;
    const finalChangeBacking = baseChangeBackingIfBchOnly + extra;

    outputs = [
      {
        to: contract.tokenAddress,
        amount: finalContractBacking,
        token: {
          category: FT_CATEGORY_HEX,
          amount: tokensToContract,
        },
      },
      {
        to: aliceTokenAddress,
        amount: finalChangeBacking,
      },
    ];
  }

  // --- Step 4: Build FINAL tx ------------------------------------------------
  console.log("\n[pass2] Building FINAL funding transaction...");

  const txb = new TransactionBuilder({ provider });
  fundingInputs.forEach((u) => txb.addInput(u, tmpl.unlockP2PKH()));
  outputs.forEach((o) => txb.addOutput(o));

  logInputs("FINAL", fundingInputs);
  logOutputs("FINAL", outputs);

  const tx = await txb.send();

  console.log("\n[fund] Funding tx broadcast:");
  console.log(safeJson(tx));

  if (tx?.hex) {
    const finalBytes = BigInt(tx.hex.length / 2);
    const actualFee =
      totalBacking - outputs.reduce((s, o) => s + BigInt(o.amount ?? 0n), 0n);
    console.log(
      `[fund] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  console.log(
    "\n✅ Done: FT tokens sent to MeanRevert V2 contract on chipnet."
  );
  console.log(
    "   - Check contract.tokenAddress UTXOs for the FT position on-chain.\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Error funding MeanRevert V2 from Alice:", err);
    process.exitCode = 1;
  });
}
