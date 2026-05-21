// scripts/resetMeanRevertV3ToAlice.js
//
// Reset/demo helper for MeanRevertSingleTokenNFTAuthV3 on CHIPNET.
//
// Goal:
//  - Spend ALL UTXOs locked to the V3 contract
//  - Send every satoshi + every token back to Alice
//  - Pay miner fees from a separate BCH-only UTXO at aliceAddress
//
// Result:
//  - V3 contract has zero UTXOs (fully drained)
//  - All FTs/NFTs previously in the contract are now at aliceTokenAddress
//  - All BCH previously in the contract is now at Alice (token or plain address)

import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  Contract,
} from "cashscript";
import { compileFile } from "cashc";

import {
  NETWORK,
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
  TARGET_TOKENS,
  SATS_PER_BYTE,
  DUST_THRESHOLD,
} from "../config.js";

import {
  alicePriv,
  alicePub,
  aliceAddress,
  aliceTokenAddress,
  alicePkh,
} from "../common.js";

import { formatSats, safeJson } from "../bigint.js";

// Helper: big-endian txid hex -> VM-order bytes literal.
function beHexToVmBytes(beHex) {
  const clean = beHex.startsWith("0x") ? beHex.slice(2) : beHex;
  const vmHex = clean.match(/../g).reverse().join("");
  return `0x${vmHex}`;
}

function utxoValueBigInt(u) {
  const v = u.satoshis ?? u.value;
  if (v === undefined) throw new Error("UTXO missing satoshi value");
  return BigInt(v);
}

export async function runResetMeanRevertV3ToAlice() {
  console.log("========================================");
  console.log(" Reset / Drain MeanRevertSingleTokenNFTAuthV3 ");
  console.log("========================================\n");
  console.log(`[network] NETWORK="${NETWORK}"\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);
  const tmpl = new SignatureTemplate(alicePriv);

  // --- Reconstruct the same contract instance as deploy/fund/rebalance ---
  const artifact = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuthV3.cash", import.meta.url)
  );

  const tokenCategoryBytes = beHexToVmBytes(FT_CATEGORY_HEX);
  const nftCategoryBytes = beHexToVmBytes(NFT_CATEGORY_HEX);
  const nftCommitBytes = `0x${REBALANCER_NFT_COMMITMENT_HEX}`;

  const contract = new Contract(
    artifact,
    [
      tokenCategoryBytes,
      TARGET_TOKENS, // MUST match deploy/fund/rebalance
      nftCategoryBytes,
      nftCommitBytes,
      alicePkh,
    ],
    { provider }
  );

  console.log("V3 contract.address      :", contract.address);
  console.log("V3 contract.tokenAddress :", contract.tokenAddress);

  // --- 1) Collect all contract UTXOs ---
  const contractUtxos = await contract.getUtxos();
  console.log(`\n[contract] UTXO count: ${contractUtxos.length}`);

  if (!contractUtxos.length) {
    console.log(
      "\n[reset] No contract UTXOs found. Nothing to drain – state is already empty.\n"
    );
    return;
  }

  console.log("\n[contract] UTXOs to drain:");
  console.log(safeJson(contractUtxos));

  const totalContractBch = contractUtxos.reduce(
    (s, u) => s + utxoValueBigInt(u),
    0n
  );
  console.log(
    `\n[contract] Total BCH locked in contract: ${formatSats(totalContractBch)}`
  );

  // --- 2) Find a BCH-only funding UTXO at aliceAddress to pay fees ---
  const aliceUtxos = await provider.getUtxos(aliceAddress);
  const fundingBchOnly = aliceUtxos.filter((u) => !u.token);

  if (!fundingBchOnly.length) {
    throw new Error(
      "No BCH-only UTXOs at aliceAddress to pay for fees. Fund aliceAddress on chipnet first."
    );
  }

  // Pick the largest BCH-only UTXO for fee funding.
  fundingBchOnly.sort((a, b) =>
    Number(utxoValueBigInt(b) - utxoValueBigInt(a))
  );
  const fundingUtxo = fundingBchOnly[0];

  console.log("\n[funding] Alice BCH UTXO (for miner fee):");
  console.log(safeJson(fundingUtxo));

  const totalInputBch = totalContractBch + utxoValueBigInt(fundingUtxo);

  // --- 3) Plan outputs: ALL contract value → Alice, fee from funding UTXO ---
  //
  // For each contract UTXO:
  //  - If it has tokens → send to aliceTokenAddress (token-aware)
  //  - If it is pure BCH → send to aliceAddress
  //
  // This preserves all token balances and BCH amounts from the contract,
  // just changing ownership from the covenant to Alice.
  const contractOutputs = contractUtxos.map((u) => {
    const amount = utxoValueBigInt(u);
    if (u.token) {
      return {
        to: aliceTokenAddress,
        amount,
        token: u.token,
      };
    }
    return {
      to: aliceAddress,
      amount,
    };
  });

  const sumContractOutputs = contractOutputs.reduce(
    (s, o) => s + BigInt(o.amount),
    0n
  );

  if (sumContractOutputs !== totalContractBch) {
    throw new Error(
      "[reset] Internal mismatch: sumContractOutputs != totalContractBch"
    );
  }

  // --- 4) PASS 1 – provisional tx for fee estimate ---
  console.log("\n[pass1] Building provisional reset tx for fee estimate...");

  const estBuilder = new TransactionBuilder({ provider });

  // Inputs: ALL contract UTXOs (drain) + funding UTXO
  for (const utxo of contractUtxos) {
    estBuilder.addInput(utxo, contract.unlock.drain(alicePub, tmpl));
  }
  estBuilder.addInput(fundingUtxo, tmpl.unlockP2PKH());

  // Outputs: contract value → Alice (token/BCH), plus provisional BCH change
  for (const out of contractOutputs) {
    estBuilder.addOutput(out);
  }

  // Provisional BCH change from funding UTXO
  estBuilder.addOutput({
    to: aliceAddress,
    amount: DUST_THRESHOLD,
  });

  const provisionalHex = await estBuilder.build();
  const bytesEstimate = BigInt(provisionalHex.length / 2);
  const feeEstimate = bytesEstimate * SATS_PER_BYTE;

  console.log(
    `[pass1] Estimated size: ${bytesEstimate} bytes @ ${SATS_PER_BYTE} sat/byte → fee ≈ ${formatSats(
      feeEstimate
    )}`
  );

  const requiredMin =
    sumContractOutputs +
    DUST_THRESHOLD + // change output must be >= dust
    feeEstimate;

  if (totalInputBch < requiredMin) {
    throw new Error(
      [
        "[reset] Insufficient BCH to pay miner fee while preserving all contract value.",
        `  totalInputBch : ${formatSats(totalInputBch)}`,
        `  requiredMin   : ${formatSats(requiredMin)}`,
      ].join("\n")
    );
  }

  const finalBchChange = totalInputBch - sumContractOutputs - feeEstimate;

  if (finalBchChange < DUST_THRESHOLD) {
    throw new Error(
      [
        "[reset] Final BCH change from funding UTXO would be below dust.",
        `  finalBchChange: ${formatSats(finalBchChange)}`,
        `  DUST_THRESHOLD: ${formatSats(DUST_THRESHOLD)}`,
      ].join("\n")
    );
  }

  console.log(
    `[pass1] Expected BCH change back to Alice (fee payer): ${formatSats(
      finalBchChange
    )}`
  );

  // --- 5) PASS 2 – final reset transaction ---
  console.log("\n[pass2] Building FINAL reset tx...");

  const txb = new TransactionBuilder({ provider });

  // Inputs: same as provisional
  for (const utxo of contractUtxos) {
    txb.addInput(utxo, contract.unlock.drain(alicePub, tmpl));
  }
  txb.addInput(fundingUtxo, tmpl.unlockP2PKH());

  // Outputs: ALL contract value to Alice (preserved), plus BCH change
  for (const out of contractOutputs) {
    txb.addOutput(out);
  }

  txb.addOutput({
    to: aliceAddress,
    amount: finalBchChange,
  });

  const txDetails = await txb.send();

  console.log("\n[reset] Broadcast txid:", txDetails.txid);
  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const actualFee = totalInputBch - sumContractOutputs - finalBchChange;
    console.log(
      `[reset] Final size: ${finalBytes.toString()} bytes, actual fee ≈ ${formatSats(
        actualFee
      )}`
    );
  }

  console.log(
    "\nTip: run scripts/inspectMeanRevertV3State.js afterwards – contract UTXOs should be 0.\n" +
      "Then you can re-run scripts/fundMeanRevertV3FromAlice.js to restart the demo."
  );
}

// --- CLI runner ---
if (import.meta.url === `file://${process.argv[1]}`) {
  runResetMeanRevertV3ToAlice().catch((err) => {
    console.error("Error in resetMeanRevertV3ToAlice script:", err);
    process.exit(1);
  });
}
