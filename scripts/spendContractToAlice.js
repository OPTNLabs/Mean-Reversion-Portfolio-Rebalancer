// scripts/spendContractToAlice.js
import { TransactionBuilder } from "cashscript";
import {
  SATS_PER_BYTE,
  DUST_THRESHOLD,
  SPEND_SPLIT_OUTPUTS,
} from "../config.js";
import { aliceAddress } from "../common.js";
import { logAddressState, logContractState } from "../utxos.js";
import { getProviderAndContract } from "../contract.js";

/**
 * Spend all contract UTXOs back to a single address,
 * splitting the final amount into several smaller UTXOs.
 *
 * Two-pass 1 sat/byte fee estimation:
 *  - Pass 1: assume 0-fee, build tx with N outputs
 *  - Pass 2: recompute outputs so sum = totalIn - fee
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

  // Decide a provisional number of outputs for pass 1
  const maxOutputsByDust = Number(totalIn / DUST_THRESHOLD) || 1;
  const initialOutputs = Math.max(
    1,
    Math.min(SPEND_SPLIT_OUTPUTS, maxOutputsByDust)
  );

  // ─────────────────────────────────────────────
  // PASS 1: provisional tx (fee=0) with initialOutputs outputs
  // ─────────────────────────────────────────────
  const builder1 = new TransactionBuilder({ provider });

  for (const u of contractUtxos) {
    builder1.addInput(u, contract.unlock.spend());
  }

  const perOutputProvisional = totalIn / BigInt(initialOutputs);

  for (let i = 0; i < initialOutputs; i++) {
    builder1.addOutput({
      to: toAddress,
      amount: perOutputProvisional,
    });
  }

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

  // Decide real number of outputs given dust constraints
  let outputsCount = Math.max(
    1,
    Math.min(SPEND_SPLIT_OUTPUTS, Number(finalAmount / DUST_THRESHOLD) || 1)
  );

  // Ensure each output is above dust
  let base = finalAmount / BigInt(outputsCount);
  while (outputsCount > 1 && base < DUST_THRESHOLD) {
    outputsCount -= 1;
    base = finalAmount / BigInt(outputsCount);
  }

  if (base < DUST_THRESHOLD) {
    // fall back to a single output if even that fails
    outputsCount = 1;
    base = finalAmount;
  }

  const remainder = finalAmount % BigInt(outputsCount);

  console.log(
    `[spend] Final outputs: ${outputsCount} → base=${base} sats, remainder=${remainder} sats`
  );

  // ─────────────────────────────────────────────
  // PASS 2: final tx with outputsCount outputs
  // ─────────────────────────────────────────────
  const builder2 = new TransactionBuilder({ provider });

  for (const u of contractUtxos) {
    builder2.addInput(u, contract.unlock.spend());
  }

  for (let i = 0; i < outputsCount; i++) {
    const extra = i === outputsCount - 1 ? remainder : 0n;
    const amount = base + extra;

    if (amount < DUST_THRESHOLD) {
      throw new Error(
        `[spend] Output #${i} amount ${amount} below dust threshold ${DUST_THRESHOLD}.`
      );
    }

    builder2.addOutput({
      to: toAddress,
      amount,
    });
  }

  const txDetails = await builder2.send();
  console.log("\n[spend] Contract spend tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const actualFee = totalIn - finalAmount;
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
 * splitting into several smaller UTXOs on Alice's side.
 */
export async function runSpendContractToAlice() {
  const { provider, contract } = getProviderAndContract();
  await spendContractToAddress({
    provider,
    contract,
    toAddress: aliceAddress,
  });
}
