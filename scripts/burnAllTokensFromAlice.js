// scripts/burnAllTokensFromAlice.js
//
// Burn ALL tokens held at aliceTokenAddress by:
//  - Spending every token-bearing UTXO as an input
//  - Creating a single BCH-only output back to aliceTokenAddress
//    with NO token field (all tokens are burned).
//
// Run:
//   node scripts/burnAllTokensFromAlice.js

import {
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from "cashscript";
import { NETWORK, SATS_PER_BYTE, DUST_THRESHOLD } from "../config.js";
import { alicePriv, aliceTokenAddress } from "../common.js";
import { splitByToken, logAddressState } from "../utxos.js";
import { formatSats } from "../bigint.js";

function utxoValueBigInt(utxo) {
  const v = utxo.satoshis ?? utxo.value;
  if (v === undefined) throw new Error("UTXO missing satoshi value");
  return BigInt(v);
}

async function main() {
  const provider = new ElectrumNetworkProvider(NETWORK);
  const aliceTemplate = new SignatureTemplate(alicePriv);

  console.log("=========================================");
  console.log(" Burn ALL tokens from aliceTokenAddress");
  console.log("=========================================\n");

  // Show current state & get raw UTXOs
  const aliceUtxos = await logAddressState(
    "Alice (before burn, token address)",
    provider,
    aliceTokenAddress
  );

  const { withTokens } = splitByToken(aliceUtxos);
  if (!withTokens.length) {
    console.log("\n✅ No token UTXOs found for Alice. Nothing to burn.");
    return;
  }

  console.log(`\nFound ${withTokens.length} token UTXO(s) to burn.`);

  // Sum the BCH value backing those token UTXOs
  let totalInput = 0n;
  for (const utxo of withTokens) {
    totalInput += utxoValueBigInt(utxo);
  }

  console.log(`Total backing value in token UTXOs: ${formatSats(totalInput)}`);

  if (totalInput <= DUST_THRESHOLD) {
    throw new Error(
      `Total token backing (${totalInput} sats) is at or below dust threshold ` +
        `(${DUST_THRESHOLD} sats). Not enough to create a clean BCH output.`
    );
  }

  // ─────────────────────────────────────────────
  // PASS 1: provisional tx with fee=0 to estimate size
  // ─────────────────────────────────────────────
  const builder1 = new TransactionBuilder({
    provider,
    allowImplicitFungibleTokenBurn: true, // ✅ explicitly allow burning
  });

  // Inputs: all token-bearing UTXOs from aliceTokenAddress
  for (const utxo of withTokens) {
    builder1.addInput(utxo, aliceTemplate.unlockP2PKH());
  }

  // One BCH-only output back to Alice (no token field)
  builder1.addOutput({
    to: aliceTokenAddress,
    amount: totalInput, // provisional; we'll subtract fee in pass 2
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `\n[burn] Provisional size: ${byteLength} bytes → estimated fee = ${fee} sats`
  );

  const finalAmount = totalInput - fee;
  if (finalAmount < DUST_THRESHOLD) {
    throw new Error(
      `After paying estimated fee (${fee} sats), remaining amount ` +
        `(${finalAmount} sats) would be below dust threshold (${DUST_THRESHOLD} sats). ` +
        `Aborting burn – consider adding a BCH-only UTXO or using fewer token UTXOs.`
    );
  }

  console.log(
    `[burn] Final BCH-only output amount after fee: ${formatSats(finalAmount)}`
  );

  // ─────────────────────────────────────────────
  // PASS 2: final tx with correct fee & output amount
  // ─────────────────────────────────────────────
  const builder2 = new TransactionBuilder({
    provider,
    allowImplicitFungibleTokenBurn: true, // ✅ also here
  });

  for (const utxo of withTokens) {
    builder2.addInput(utxo, aliceTemplate.unlockP2PKH());
  }

  builder2.addOutput({
    to: aliceTokenAddress,
    amount: finalAmount,
    // IMPORTANT: no `token` field here → all input tokens are burned
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

main().catch((err) => {
  console.error("\n❌ Error in burnAllTokensFromAlice:", err);
  process.exit(1);
});
