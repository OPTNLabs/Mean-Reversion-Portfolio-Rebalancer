// scripts/consolidateAliceFtCategory.js
//
// Consolidate all Alice FT UTXOs for FT_CATEGORY_HEX into a single UTXO.
//
// Why:
//   - After rebalances + reset, Alice can have many small FT UTXOs
//     (e.g. 640, 200, 80, 80, ...).
//   - fundMeanRevertV3FromAlice.js expects ONE UTXO with
//     amount >= INITIAL_TOKENS_ON_CONTRACT (e.g. 800).
//
// This script:
//   - spends all FT UTXOs with category = FT_CATEGORY_HEX at aliceTokenAddress
//   - creates a single FT UTXO back to aliceTokenAddress with:
//        * token.amount = sum(all token amounts)
//        * amount      = sum(all BCH backing) - fee
//   - preserves all tokens, only reshapes UTXO layout.

import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
} from "cashscript";

import {
  NETWORK,
  FT_CATEGORY_HEX,
  SATS_PER_BYTE,
  DUST_THRESHOLD,
} from "../config.js";

import { alicePriv, aliceTokenAddress } from "../common.js";
import { splitByToken } from "../utxos.js";
import { formatSats, safeJson } from "../bigint.js";

function utxoValueBigInt(u) {
  const v = u.satoshis ?? u.value;
  if (v === undefined) throw new Error("UTXO missing satoshi value");
  return BigInt(v);
}

export async function runConsolidateAliceFtCategory() {
  console.log("========================================");
  console.log(" Consolidate Alice FT UTXOs (FT_CATEGORY_HEX) ");
  console.log("========================================\n");
  console.log(`[network] NETWORK="${NETWORK}"`);
  console.log(`[addr] aliceTokenAddress: ${aliceTokenAddress}\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);
  const tmpl = new SignatureTemplate(alicePriv);

  const utxos = await provider.getUtxos(aliceTokenAddress);
  const { bchOnly, withTokens } = splitByToken(utxos);

  console.log("=== Current UTXOs at aliceTokenAddress ===");
  console.log(`Total UTXOs     : ${utxos.length}`);
  console.log(`  BCH-only      : ${bchOnly.length}`);
  console.log(`  Token-bearing : ${withTokens.length}\n`);

  // Filter: FT UTXOs for our portfolio category
  const ftUtxos = withTokens.filter(
    (u) => u.token?.category === FT_CATEGORY_HEX && BigInt(u.token.amount) > 0n
  );

  if (!ftUtxos.length) {
    console.log(
      `[consolidate] No FT UTXOs found with category=${FT_CATEGORY_HEX}. Nothing to do.\n`
    );
    return;
  }

  console.log("[consolidate] FT UTXOs to merge:");
  console.log(safeJson(ftUtxos));

  const totalTokens = ftUtxos.reduce((s, u) => s + BigInt(u.token.amount), 0n);
  const totalBacking = ftUtxos.reduce((s, u) => s + utxoValueBigInt(u), 0n);

  console.log(
    `\n[consolidate] Total FT tokens: ${totalTokens.toString()} (category=${FT_CATEGORY_HEX})`
  );
  console.log(
    `[consolidate] Total BCH backing in these UTXOs: ${formatSats(
      totalBacking
    )}`
  );

  if (totalBacking <= DUST_THRESHOLD) {
    throw new Error(
      [
        "[consolidate] Total BCH backing for FT UTXOs is at/below dust.",
        `  totalBacking : ${formatSats(totalBacking)}`,
        `  DUST_THRESHOLD: ${formatSats(DUST_THRESHOLD)}`,
        "Cannot safely build a single consolidated output.",
      ].join("\n")
    );
  }

  // --- PASS 1: provisional tx for fee estimate ---
  console.log("\n[pass1] Building provisional consolidation tx...");

  const estBuilder = new TransactionBuilder({ provider });

  for (const u of ftUtxos) {
    estBuilder.addInput(u, tmpl.unlockP2PKH());
  }

  // Provisional: send everything (BCH + tokens) to one output
  estBuilder.addOutput({
    to: aliceTokenAddress,
    amount: totalBacking,
    token: {
      category: FT_CATEGORY_HEX,
      amount: totalTokens,
    },
  });

  const provisionalHex = await estBuilder.build();
  const bytesEstimate = BigInt(provisionalHex.length / 2);
  const feeEstimate = bytesEstimate * SATS_PER_BYTE;

  console.log(
    `[pass1] Estimated size: ${bytesEstimate} bytes @ ${SATS_PER_BYTE} sat/byte → fee ≈ ${formatSats(
      feeEstimate
    )}`
  );

  const finalAmount = totalBacking - feeEstimate;

  if (finalAmount < DUST_THRESHOLD) {
    throw new Error(
      [
        "[consolidate] Final BCH amount would fall below dust after fees.",
        `  finalAmount  : ${formatSats(finalAmount)}`,
        `  DUST_THRESHOLD: ${formatSats(DUST_THRESHOLD)}`,
      ].join("\n")
    );
  }

  console.log(
    `[pass1] Expected BCH amount in consolidated FT UTXO: ${formatSats(
      finalAmount
    )}`
  );

  // --- PASS 2: final consolidation tx ---
  console.log("\n[pass2] Building FINAL consolidation tx...");

  const txb = new TransactionBuilder({ provider });

  for (const u of ftUtxos) {
    txb.addInput(u, tmpl.unlockP2PKH());
  }

  txb.addOutput({
    to: aliceTokenAddress,
    amount: finalAmount,
    token: {
      category: FT_CATEGORY_HEX,
      amount: totalTokens,
    },
  });

  const txDetails = await txb.send();

  console.log("\n[consolidate] Broadcast txid:", txDetails.txid);
  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const actualFee = totalBacking - finalAmount;
    console.log(
      `[consolidate] Final size: ${finalBytes.toString()} bytes, actual fee ≈ ${formatSats(
        actualFee
      )}`
    );
  }

  console.log(
    "\nDone. aliceTokenAddress now has a single consolidated FT UTXO for this category.\n" +
      "You can now run scripts/fundMeanRevertV3FromAlice.js again.\n"
  );
}

// --- CLI runner ---
if (import.meta.url === `file://${process.argv[1]}`) {
  runConsolidateAliceFtCategory().catch((err) => {
    console.error("Error in consolidateAliceFtCategory script:", err);
    process.exit(1);
  });
}
