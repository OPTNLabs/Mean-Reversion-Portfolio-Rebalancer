// scripts/fundContractFromAlice.js
import { TransactionBuilder, SignatureTemplate } from "cashscript";
import {
  FUNDING_AMOUNT,
  SMALL_FUNDING_AMOUNT,
  SMALL_FUND_COUNT,
  SATS_PER_BYTE,
  DUST_THRESHOLD,
} from "../config.js";
import { aliceAddress, alicePriv } from "../common.js";
import {
  splitByToken,
  selectFundingUtxo,
  logAddressState,
  logContractState,
} from "../utxos.js";
import { getProviderAndContract } from "../contract.js";

/**
 * Fee-aware funding helper (Alice P2PKH → SumInputs contract).
 * Two-pass build:
 *  1) provisional tx (fee=0) to measure size
 *  2) final tx with fee = bytes * SATS_PER_BYTE and adjusted change
 *
 * This version funds the contract with a SINGLE output of `amount`.
 */
async function fundContractOnce({ provider, contract, amount }) {
  // Track initial state for this funding step
  await logContractState("Contract (before single funding)", contract);
  const aliceUtxos = await logAddressState(
    "Alice (before single funding)",
    provider,
    aliceAddress
  );

  const { bchOnly } = splitByToken(aliceUtxos);
  if (bchOnly.length === 0) {
    throw new Error("Alice has no BCH-only UTXOs.");
  }

  // pick a BCH UTXO big enough; fall back to first if none meet the margin
  const safetyMargin = 1_000n;
  const requiredMin = amount + safetyMargin;
  const fundingUtxo = selectFundingUtxo(bchOnly, requiredMin) ?? bchOnly[0];
  const inputValue = fundingUtxo.satoshis;

  if (inputValue <= amount) {
    throw new Error(
      `Funding UTXO too small: input=${inputValue} <= amount=${amount}`
    );
  }

  console.log("[fund] Selected funding UTXO:", fundingUtxo);

  const aliceTemplate = new SignatureTemplate(alicePriv);

  // ─────────────────────────────────────────────
  // PASS 1: provisional tx (fee=0) to get size
  // ─────────────────────────────────────────────
  const provisionalChange = inputValue - amount;
  if (provisionalChange <= 0n) {
    throw new Error("Funding UTXO too small for provisional change.");
  }

  const builder1 = new TransactionBuilder({ provider });
  builder1.addInput(fundingUtxo, aliceTemplate.unlockP2PKH());
  builder1.addOutput({ to: contract.address, amount });
  builder1.addOutput({ to: aliceAddress, amount: provisionalChange });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[fund] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // ─────────────────────────────────────────────
  // PASS 2: final tx with correct fee & change
  // ─────────────────────────────────────────────
  const realChange = inputValue - amount - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[fund] Final change = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const builder2 = new TransactionBuilder({ provider });
  builder2.addInput(fundingUtxo, aliceTemplate.unlockP2PKH());
  builder2.addOutput({ to: contract.address, amount });

  if (includeChange) {
    builder2.addOutput({ to: aliceAddress, amount: realChange });
  }

  const txDetails = await builder2.send();
  console.log("\n[fund] Funding tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const outputsTotal = amount + (includeChange ? realChange : 0n);
    const actualFee = inputValue - outputsTotal;

    console.log(
      `[fund] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  // Track state after this funding step
  await logContractState("Contract (after single funding)", contract);
  await logAddressState("Alice (after single funding)", provider, aliceAddress);

  return txDetails;
}

/**
 * Batch funding helper:
 *   • ONE tx
 *   • ONE (large) Alice input
 *   • MANY (SMALL_FUND_COUNT) contract outputs of SMALL_FUNDING_AMOUNT
 *   • Optional change back to Alice
 */
async function fundContractBatchSmall({
  provider,
  contract,
  amountPerOutput,
  count,
}) {
  await logContractState("Contract (before batched small funding)", contract);
  const aliceUtxos = await logAddressState(
    "Alice (before batched small funding)",
    provider,
    aliceAddress
  );

  const { bchOnly } = splitByToken(aliceUtxos);
  if (bchOnly.length === 0) {
    throw new Error("Alice has no BCH-only UTXOs.");
  }

  const totalAmount = amountPerOutput * BigInt(count);

  // Safety margin for fees (we'll refine after size estimation)
  const safetyMargin = 2_000n;
  const requiredMin = totalAmount + safetyMargin;

  const fundingUtxo = selectFundingUtxo(bchOnly, requiredMin) ?? bchOnly[0];
  const inputValue = fundingUtxo.satoshis;

  if (inputValue <= totalAmount) {
    throw new Error(
      `Funding UTXO too small: input=${inputValue} <= totalAmount=${totalAmount}`
    );
  }

  console.log("[batch-fund] Selected funding UTXO:", fundingUtxo);
  console.log(
    `[batch-fund] Creating ${count} outputs of ${amountPerOutput} sats ` +
      `(total=${totalAmount} sats) to contract`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);

  // ─────────────────────────────────────────────
  // PASS 1: provisional tx (fee=0) to get size
  // ─────────────────────────────────────────────
  const provisionalChange = inputValue - totalAmount;
  if (provisionalChange <= 0n) {
    throw new Error(
      "[batch-fund] Funding UTXO too small for provisional change."
    );
  }

  const builder1 = new TransactionBuilder({ provider });
  builder1.addInput(fundingUtxo, aliceTemplate.unlockP2PKH());

  for (let i = 0; i < count; i++) {
    builder1.addOutput({
      to: contract.address,
      amount: amountPerOutput,
    });
  }

  builder1.addOutput({ to: aliceAddress, amount: provisionalChange });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[batch-fund] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // ─────────────────────────────────────────────
  // PASS 2: final tx with correct fee & change
  // ─────────────────────────────────────────────
  const realChange = inputValue - totalAmount - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[batch-fund] Final change = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const builder2 = new TransactionBuilder({ provider });
  builder2.addInput(fundingUtxo, aliceTemplate.unlockP2PKH());

  for (let i = 0; i < count; i++) {
    builder2.addOutput({
      to: contract.address,
      amount: amountPerOutput,
    });
  }

  if (includeChange) {
    builder2.addOutput({ to: aliceAddress, amount: realChange });
  }

  const txDetails = await builder2.send();
  console.log("\n[batch-fund] Batched funding tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const outputsTotal = totalAmount + (includeChange ? realChange : 0n);
    const actualFee = inputValue - outputsTotal;

    console.log(
      `[batch-fund] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  await logContractState("Contract (after batched small funding)", contract);
  await logAddressState(
    "Alice (after batched small funding)",
    provider,
    aliceAddress
  );

  return txDetails;
}

/**
 * Script entry: one funding of FUNDING_AMOUNT sats to the contract.
 */
export async function runFundContractFromAlice() {
  const { provider, contract } = getProviderAndContract();

  await logContractState("Contract (before funding)", contract);
  await logAddressState("Alice (before funding)", provider, aliceAddress);

  await fundContractOnce({ provider, contract, amount: FUNDING_AMOUNT });

  await logContractState("Contract (after funding)", contract);
  await logAddressState("Alice (after funding)", provider, aliceAddress);
}

/**
 * Script entry: fund the contract ONCE with SMALL_FUND_COUNT outputs of
 * SMALL_FUNDING_AMOUNT sats each, in a single batched transaction.
 */
export async function runFundManySmallToContract() {
  const { provider, contract } = getProviderAndContract();

  await logContractState("Contract (before small-fund loop)", contract);
  await logAddressState(
    "Alice (before small-fund loop)",
    provider,
    aliceAddress
  );

  await fundContractBatchSmall({
    provider,
    contract,
    amountPerOutput: SMALL_FUNDING_AMOUNT,
    count: SMALL_FUND_COUNT,
  });

  await logContractState("Contract (after small-fund loop)", contract);
  await logAddressState(
    "Alice (after small-fund loop)",
    provider,
    aliceAddress
  );
}
