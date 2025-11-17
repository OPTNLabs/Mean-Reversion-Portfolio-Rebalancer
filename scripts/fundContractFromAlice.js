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
 * Script entry: fund the contract MANY times with SMALL_FUNDING_AMOUNT sats,
 * creating multiple small UTXOs for loop experiments.
 */
export async function runFundManySmallToContract() {
  const { provider, contract } = getProviderAndContract();

  await logContractState("Contract (before small-fund loop)", contract);
  await logAddressState(
    "Alice (before small-fund loop)",
    provider,
    aliceAddress
  );

  for (let i = 0; i < SMALL_FUND_COUNT; i++) {
    console.log(`\n[small-fund] Iteration ${i + 1} of ${SMALL_FUND_COUNT}`);
    await fundContractOnce({
      provider,
      contract,
      amount: SMALL_FUNDING_AMOUNT,
    });
  }

  await logContractState("Contract (after small-fund loop)", contract);
  await logAddressState(
    "Alice (after small-fund loop)",
    provider,
    aliceAddress
  );
}
