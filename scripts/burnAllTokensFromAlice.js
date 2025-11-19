// scripts/burnAllTokensFromAlice.js
//
// Burn ALL tokens held at aliceTokenAddress by:
//  - Spending every token-bearing UTXO as an input
//  - Creating a single BCH-only output back to aliceTokenAddress
//    with NO token field (all tokens are burned).
//
// Intended use: "reset" local demo token state while keeping BCH value.

import {
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from "cashscript";
import { NETWORK, SATS_PER_BYTE, DUST_THRESHOLD } from "../config.js";
import { alicePriv, aliceTokenAddress } from "../common.js";
import {
  splitByToken,
  logAddressState,
  logTokenUtxosDetailed,
} from "../utxos.js";
import { formatSats } from "../bigint.js";

function utxoValueBigInt(utxo) {
  const v = utxo.satoshis ?? utxo.value;
  if (v === undefined) throw new Error("UTXO missing satoshi value");
  return BigInt(v);
}

export async function runBurnAllTokensFromAlice() {
  console.log("=========================================");
  console.log(" Burn ALL tokens from aliceTokenAddress");
  console.log("=========================================\n");
  console.log(`[network] Using NETWORK="${NETWORK}"\n`);
  console.log(`[addr] aliceTokenAddress: ${aliceTokenAddress}\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);
  const aliceTemplate = new SignatureTemplate(alicePriv);

  const aliceUtxos = await logAddressState(
    "Alice (before burn, token address)",
    provider,
    aliceTokenAddress
  );

  const { withTokens, bchOnly } = splitByToken(aliceUtxos);

  console.log(
    `\n[analysis] Token-bearing UTXOs: ${withTokens.length}, BCH-only UTXOs: ${bchOnly.length}`
  );

  if (!withTokens.length) {
    console.log("\n✅ No token UTXOs found for Alice. Nothing to burn.");
    return;
  }

  logTokenUtxosDetailed("Alice token", withTokens);

  console.log(`\nFound ${withTokens.length} token UTXO(s) to burn.`);

  let totalInput = 0n;
  for (const utxo of withTokens) {
    totalInput += utxoValueBigInt(utxo);
  }

  console.log(
    `Total backing value in token UTXOs: ${formatSats(totalInput)} (sats)`
  );

  if (totalInput <= DUST_THRESHOLD) {
    throw new Error(
      `Total token backing (${totalInput} sats) is at or below dust threshold ` +
        `(${DUST_THRESHOLD} sats). Not enough to create a clean BCH output.`
    );
  }

  // PASS 1 – fee estimate
  console.log(
    "\n[pass1] Building provisional burn transaction for fee estimate..."
  );

  const builder1 = new TransactionBuilder({
    provider,
    allowImplicitFungibleTokenBurn: true,
  });

  for (const utxo of withTokens) {
    builder1.addInput(utxo, aliceTemplate.unlockP2PKH());
  }

  builder1.addOutput({
    to: aliceTokenAddress,
    amount: totalInput,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `\n[pass1] Provisional size: ${byteLength} bytes @ ${SATS_PER_BYTE} sat/byte → estimated fee = ${fee} sats`
  );

  const finalAmount = totalInput - fee;
  console.log(
    `[pass1] Expected BCH-only output (after fee): ${formatSats(finalAmount)}`
  );

  if (finalAmount < DUST_THRESHOLD) {
    throw new Error(
      `After paying estimated fee (${fee} sats), remaining amount ` +
        `(${finalAmount} sats) would be below dust threshold (${DUST_THRESHOLD} sats).\n` +
        `Aborting burn – consider adding a BCH-only UTXO or using fewer token UTXOs.`
    );
  }

  // PASS 2 – final tx
  console.log("\n[pass2] Building FINAL burn transaction...");

  const builder2 = new TransactionBuilder({
    provider,
    allowImplicitFungibleTokenBurn: true,
  });

  for (const utxo of withTokens) {
    builder2.addInput(utxo, aliceTemplate.unlockP2PKH());
  }

  builder2.addOutput({
    to: aliceTokenAddress,
    amount: finalAmount,
  });

  const txDetails = await builder2.send();
  console.log("\n[burn] Burn tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const actualFee = totalInput - finalAmount;
    console.log(
      `[burn] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  console.log("\n--- Alice state (after burn) ---");
  await logAddressState(
    "Alice (after burn, token address)",
    provider,
    aliceTokenAddress
  );

  console.log("\n✅ All selected token UTXOs were burned to a BCH-only UTXO.");
}
