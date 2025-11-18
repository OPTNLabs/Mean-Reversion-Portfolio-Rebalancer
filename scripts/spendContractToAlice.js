// scripts/spendContractToAlice.js
import { TransactionBuilder } from "cashscript";
import { SATS_PER_BYTE, DUST_THRESHOLD } from "../config.js";
import { aliceAddress } from "../common.js";
import { logAddressState, logContractState } from "../utxos.js";
import { getProviderAndContract } from "../contract.js";

/**
 * Spend all contract UTXOs back to a single address,
 * merging them into ONE big BCH UTXO.
 *
 * Two-pass 1 sat/byte fee estimation:
 *  - Pass 1: assume 0-fee, build tx with a single output
 *  - Pass 2: recompute the single output so amount = totalIn - fee
 */
async function spendContractToAddress({ provider, contract, toAddress }) {
  const contractUtxos = await logContractState(
    "Contract (before spend)",
    contract
  );

  if (contractUtxos.length === 0) {
    throw new Error("No contract UTXOs to spend.");
  }

  const totalIn = contractUtxos.reduce((sum, u) => sum + u.satoshis, 0n);
  console.log(`[spend] Total contract input value: ${totalIn} sats`);

  await logAddressState("Alice (before contract spend)", provider, toAddress);

  // ─────────────────────────────────────────────
  // PASS 1: provisional tx (fee=0) with a single output
  // ─────────────────────────────────────────────
  const builder1 = new TransactionBuilder({ provider });

  for (const u of contractUtxos) {
    builder1.addInput(u, contract.unlock.spend());
  }

  // provisional output uses the full totalIn – just for size estimation
  builder1.addOutput({
    to: toAddress,
    amount: totalIn,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[spend] Provisional size: ${byteLength} bytes → fee = ${fee} sats`
  );

  const finalAmount = totalIn - fee;
  if (finalAmount <= 0n) {
    throw new Error("[spend] Final amount is non-positive after fee.");
  }

  if (finalAmount < DUST_THRESHOLD) {
    throw new Error(
      `[spend] Final output ${finalAmount} below dust threshold ${DUST_THRESHOLD}.`
    );
  }

  console.log(`[spend] Single merged output amount: ${finalAmount} sats`);

  // ─────────────────────────────────────────────
  // PASS 2: final tx with single merged output
  // ─────────────────────────────────────────────
  const builder2 = new TransactionBuilder({ provider });

  for (const u of contractUtxos) {
    builder2.addInput(u, contract.unlock.spend());
  }

  builder2.addOutput({
    to: toAddress,
    amount: finalAmount,
  });

  const txDetails = await builder2.send();
  console.log("\n[spend] Contract spend tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const actualFee = fee; // same formula: totalIn - finalAmount
    console.log(
      `[spend] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  await logContractState("Contract (after spend)", contract);
  await logAddressState("Alice (after contract spend)", provider, toAddress);

  return txDetails;
}

/**
 * Script entry: spend contract funds back to Alice,
 * merging into a single large UTXO on Alice's side.
 */
export async function runSpendContractToAlice() {
  const { provider, contract } = getProviderAndContract();
  await spendContractToAddress({
    provider,
    contract,
    toAddress: aliceAddress,
  });
}
