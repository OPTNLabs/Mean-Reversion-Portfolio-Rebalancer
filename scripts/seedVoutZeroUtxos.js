// scripts/seedVoutZeroUtxos.js
//
// Goal: ensure aliceAddress has at least N BCH-only UTXOs with vout=0,
// so we can use them as CashTokens FT/NFT genesis inputs.
//
// Usage:
//   node scripts/seedVoutZeroUtxos.js          # default: target 2 vout=0 UTXOs
//   node scripts/seedVoutZeroUtxos.js 3        # (optional) target a different count
//
// Strategy:
//   - Inspect aliceAddress UTXOs.
//   - Count BCH-only UTXOs with vout === 0 (genesis candidates).
//   - If already >= target, exit.
//   - Otherwise, for each *additional* candidate needed:
//       * Pick a BCH-only UTXO with vout !== 0 (non-genesis).
//       * Build a 1-input, 1-output tx:
//           - input: that UTXO
//           - output0: back to aliceAddress with (value - fee) sats
//         → this creates a new BCH-only UTXO where outpoint.vout === 0.
//   - We never spend existing vout=0 candidates.
//

import {
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from "cashscript";

import { NETWORK, SATS_PER_BYTE, DUST_THRESHOLD } from "../config.js";
import { alicePriv, aliceAddress } from "../common.js";
import { splitByToken } from "../utxos.js";

const utxoValueBigInt = (u) => BigInt(u.satoshis ?? u.value);

/**
 * Seed aliceAddress with at least `targetVout0` BCH-only UTXOs where vout === 0.
 *
 * @param {number} targetVout0
 */
export async function runSeedVoutZeroUtxos(targetVout0 = 2) {
  console.log("==============================================");
  console.log(" Seed vout=0 BCH-only UTXOs for aliceAddress ");
  console.log("==============================================\n");
  console.log(`[network] Using NETWORK="${NETWORK}"`);
  console.log(`[addr] aliceAddress: ${aliceAddress}\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);

  // 1) Inspect current UTXOs at aliceAddress
  const all = await provider.getUtxos(aliceAddress);
  const { bchOnly, withTokens } = splitByToken(all);

  const candidates = bchOnly.filter((u) => u.vout === 0);
  const nonZeroVoutFunding = bchOnly.filter((u) => u.vout !== 0);

  console.log("=== Current UTXOs at aliceAddress ===");
  console.log(`Total UTXOs          : ${all.length}`);
  console.log(`  BCH-only           : ${bchOnly.length}`);
  console.log(`  Token-bearing      : ${withTokens.length}`);
  console.log(`vout=0 BCH-only UTXOs: ${candidates.length}`);
  console.log(`vout!=0 BCH-only     : ${nonZeroVoutFunding.length}\n`);

  if (candidates.length >= targetVout0) {
    console.log(
      `[ok] Already have ${candidates.length} vout=0 BCH-only UTXOs (target ${targetVout0}).`
    );
    console.log("    Nothing to do.\n");
    return;
  }

  const needed = targetVout0 - candidates.length;

  if (nonZeroVoutFunding.length < needed) {
    throw new Error(
      [
        "",
        `[seed] Not enough non-vout0 BCH-only UTXOs to create ${needed} new vout=0 candidates.`,
        "",
        `  - BCH-only total      : ${bchOnly.length}`,
        `  - vout=0 BCH-only     : ${candidates.length}`,
        `  - vout!=0 BCH-only    : ${nonZeroVoutFunding.length}`,
        "",
        "You need at least as many BCH-only UTXOs with vout!=0 as the number of",
        "additional vout=0 candidates you want to create.",
        "",
        "Fix:",
        "  - Receive a couple more BCH-only UTXOs at aliceAddress (any vout),",
        "    then rerun this script.",
        "",
      ].join("\n")
    );
  }

  console.log(
    `[plan] Need ${needed} additional vout=0 BCH-only UTXOs (target = ${targetVout0}).`
  );
  console.log(
    "[plan] For each, we'll build a 1-input, 1-output tx from a vout!=0 UTXO → vout=0 self-UTXO.\n"
  );

  const tmpl = new SignatureTemplate(alicePriv);
  const newGenesisCandidates = [];

  for (let i = 0; i < needed; i++) {
    const utxo = nonZeroVoutFunding[i];
    const inputValue = utxoValueBigInt(utxo);

    console.log(`--- [${i + 1}/${needed}] Creating new vout=0 candidate ---`);
    console.log(
      `Input UTXO: txid=${utxo.txid} vout=${
        utxo.vout
      } sats=${inputValue.toString()}`
    );

    // PASS 1 – provisional tx for fee estimate
    const estBuilder = new TransactionBuilder({ provider });

    estBuilder.addInput(utxo, tmpl.unlockP2PKH());
    estBuilder.addOutput({
      to: aliceAddress,
      amount: inputValue, // provisional; we'll adjust after fee calc
    });

    const provisionalHex = await estBuilder.build();
    const byteLength = BigInt(provisionalHex.length / 2);
    const fee = byteLength * SATS_PER_BYTE;

    console.log(
      `[pass1] Provisional size: ${byteLength} bytes @ ${SATS_PER_BYTE} sat/byte → fee = ${fee} sats`
    );

    const finalAmount = inputValue - fee;

    console.log(
      `[pass1] Final output candidate amount (after fee): ${finalAmount.toString()} sats`
    );

    if (finalAmount < DUST_THRESHOLD) {
      throw new Error(
        [
          "",
          "[seed] Resulting output would be below dust threshold.",
          "",
          `  - input value        : ${inputValue.toString()} sats`,
          `  - estimated fee      : ${fee.toString()} sats`,
          `  - finalAmount        : ${finalAmount.toString()} sats`,
          `  - DUST_THRESHOLD     : ${DUST_THRESHOLD.toString()} sats`,
          "",
          "This UTXO is too small to safely convert into a new vout=0 genesis candidate.",
          "Consider funding aliceAddress with a larger BCH-only UTXO and try again.",
          "",
        ].join("\n")
      );
    }

    // PASS 2 – final tx using (inputValue - fee)
    const finalBuilder = new TransactionBuilder({ provider });

    finalBuilder.addInput(utxo, tmpl.unlockP2PKH());
    finalBuilder.addOutput({
      to: aliceAddress,
      amount: finalAmount,
    });

    const txDetails = await finalBuilder.send();

    console.log(`[pass2] Broadcast txid: ${txDetails.txid}`);
    console.log(
      `[pass2] New candidate genesis outpoint: (${
        txDetails.txid
      }, vout=0) with ${finalAmount.toString()} sats\n`
    );

    newGenesisCandidates.push({
      txid: txDetails.txid,
      vout: 0,
      satoshis: finalAmount,
    });
  }

  console.log("==============================================");
  console.log(" Done seeding vout=0 BCH-only UTXOs.");
  console.log(" New candidate genesis outpoints:");
  newGenesisCandidates.forEach((u, i) => {
    console.log(
      `  [${i}] txid=${u.txid} vout=${u.vout} sats=${u.satoshis.toString()}`
    );
  });
  console.log(
    "\nTip: after confirmations, these txids can safely serve as FT/NFT categories:\n" +
      "  - FT category  = txid of one vout=0 UTXO\n" +
      "  - NFT category = txid of another vout=0 UTXO\n"
  );
}

// --- CLI runner ---
if (import.meta.url === `file://${process.argv[1]}`) {
  // Optional CLI arg: target count
  const arg = process.argv[2];
  const target = arg && !Number.isNaN(Number(arg)) ? Number(arg) : 2;

  runSeedVoutZeroUtxos(target).catch((err) => {
    console.error("Error in seedVoutZeroUtxos script:", err);
    process.exit(1);
  });
}
