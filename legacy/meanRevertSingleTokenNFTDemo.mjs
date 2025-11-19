// scripts/meanRevertSingleTokenNFTDemo.js
//
// Demo for MeanRevertSingleTokenNFTAuth.cash
//
// Flow:
//  1. Pick a fungible token (FT) UTXO and an NFT UTXO from Alice.
//  2. Instantiate the MeanRevertSingleTokenNFTAuth contract.
//  3. Fund the contract with FT + BCH using a token-capable address,
//     estimating fees from a provisional transaction using a 546-sat
//     placeholder change to aliceAddress (do NOT broadcast that tx).
//  4. Rebalance via rebalance() using the NFT as authorization.
//  5. drain() everything back to Alice.
//
// Run:
//   npm run mean-revert-demo
// or:
//   node scripts/meanRevertSingleTokenNFTDemo.js

import {
  Contract,
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from "cashscript";
import { hash160 } from "@cashscript/utils";
import {
  hexToBin,
  swapEndianness,
  decodeCashAddress,
  encodeCashAddress,
} from "@bitauth/libauth";

import { NETWORK, DUST_THRESHOLD } from "../config.js";
import {
  alicePriv,
  alicePub,
  aliceAddress,
  aliceTokenAddress,
} from "../common.js";
import { splitByToken, logAddressState, logContractState } from "../utxos.js";
import { formatSats } from "../bigint.js";

// Use the compiled JSON artifact so contract.functions works
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const meanRevertArtifact = require("../artifacts/MeanRevertSingleTokenNFTAuth.json");

// Normalize satoshi value for different UTXO shapes
function utxoValueBigInt(utxo) {
  const v = utxo.satoshis ?? utxo.value;
  if (v === undefined) throw new Error("UTXO missing satoshi value");
  return BigInt(v);
}

// Convert BCH-only cashaddr → token-capable cashaddr (p2pkhWithTokens/p2shWithTokens)
function toTokenAwareAddress(address) {
  const decoded = decodeCashAddress(address, { throwErrors: true });
  const { payload, prefix, type } = decoded;

  if (type === "p2pkhWithTokens" || type === "p2shWithTokens") {
    return address; // already token-aware
  }

  let newType;
  if (type === "p2pkh") newType = "p2pkhWithTokens";
  else if (type === "p2sh") newType = "p2shWithTokens";
  else throw new Error(`Unsupported cashaddr type for token address: ${type}`);

  return encodeCashAddress({
    prefix,
    type: newType,
    payload,
    throwErrors: true,
  }).address;
}

// Estimate fee by:
//  - calling buildProvisionalTx() to get a *hex string* of a provisional tx
//  - computing 1 sat/byte from hex length
async function estimateFeeWithPlaceholderChange(
  buildProvisionalTx,
  totalInput
) {
  const hex = await buildProvisionalTx(); // hex string
  if (typeof hex !== "string") {
    throw new Error(
      "buildProvisionalTx did not return a hex string for provisional transaction"
    );
  }
  const byteLength = BigInt(hex.length / 2);
  const fee = byteLength; // 1 sat/byte

  if (fee >= totalInput) {
    throw new Error(
      `Estimated fee ${fee.toString()} ≥ total input ${totalInput.toString()}`
    );
  }

  return { fee, byteLength };
}

async function main() {
  const provider = new ElectrumNetworkProvider(NETWORK);
  const aliceTemplate = new SignatureTemplate(alicePriv);

  console.log("================================================");
  console.log(" MeanRevertSingleTokenNFTAuth Demo");
  console.log("================================================\n");

  // ---------------------------------------------------------------------------
  // 1. Inspect Alice & choose FT + NFT UTXOs
  // ---------------------------------------------------------------------------
  console.log("--- Alice state (pre) ---");
  await logAddressState("Alice (token address)", provider, aliceTokenAddress);

  const aliceUtxos = await provider.getUtxos(aliceTokenAddress);
  const { withTokens, bchOnly } = splitByToken(aliceUtxos);

  if (!withTokens.length) {
    throw new Error(
      "Alice has no token UTXOs. Mint FT + NFT to aliceTokenAddress first."
    );
  }

  let ftUtxo = null;
  let nftUtxo = null;

  for (const utxo of withTokens) {
    const t = utxo.token;
    if (!t) continue;

    const amount = BigInt(t.amount ?? 0n);
    const hasCommitment =
      t.nft?.commitment != null && t.nft.commitment.length > 0;

    // Fungible token UTXO (amount > 0)
    if (!ftUtxo && amount > 0n) {
      ftUtxo = utxo;
    }

    // NFT UTXO (amount == 0 with commitment)
    if (!nftUtxo && amount === 0n && hasCommitment) {
      nftUtxo = utxo;
    }

    if (ftUtxo && nftUtxo) break;
  }

  if (!ftUtxo) {
    throw new Error(
      "No fungible-token UTXO found for Alice (need amount > 0). " +
        "Run `npm run mint-tokens` first."
    );
  }

  if (!nftUtxo) {
    throw new Error(
      "No NFT UTXO with commitment found for Alice. " +
        "Run `npm run mint-rebal-nft` first."
    );
  }

  // FT details
  const ftCategoryWalletHex = ftUtxo.token.category;
  const ftAmount = BigInt(ftUtxo.token.amount);

  console.log("\nSelected FT UTXO (portfolio token):");
  console.log(`  txid:    ${ftUtxo.txid}`);
  console.log(`  vout:    ${ftUtxo.vout}`);
  console.log(`  category (wallet hex): ${ftCategoryWalletHex}`);
  console.log(`  amount:  ${ftAmount.toString()}`);

  // NFT details
  const nftCategoryWalletHex = nftUtxo.token.category;
  const nftCommitmentHex = nftUtxo.token.nft.commitment;

  console.log("\nSelected NFT UTXO (rebalancer auth):");
  console.log(`  txid:    ${nftUtxo.txid}`);
  console.log(`  vout:    ${nftUtxo.vout}`);
  console.log(`  category (wallet hex): ${nftCategoryWalletHex}`);
  console.log(`  commitment:  ${nftCommitmentHex}`);
  console.log(`  capability:  ${nftUtxo.token.nft.capability}`);

  if (!bchOnly.length) {
    throw new Error(
      "Alice has no BCH-only UTXOs to pay fees. " +
        "Send a bit of BCH to aliceTokenAddress."
    );
  }
  const feeUtxo = bchOnly[0];
  console.log("\nUsing BCH-only UTXO for initial fund:");
  console.log(`  txid:  ${feeUtxo.txid}`);
  console.log(`  vout:  ${feeUtxo.vout}`);
  console.log(`  value: ${formatSats(utxoValueBigInt(feeUtxo))}`);

  // Convert categories & commitment to VM-order bytes for contract params
  const ftCategoryVmHex = swapEndianness(ftCategoryWalletHex);
  const nftCategoryVmHex = swapEndianness(nftCategoryWalletHex);

  const tokenCategoryBytes = hexToBin(ftCategoryVmHex);
  const rebalancerNftCatBytes = hexToBin(nftCategoryVmHex);
  const rebalancerNftCommitBytes = hexToBin(nftCommitmentHex);

  // ---------------------------------------------------------------------------
  // 2. Instantiate contract (using JSON artifact)
  // ---------------------------------------------------------------------------
  const ownerPkh = hash160(alicePub);
  const targetTokenAmount = ftAmount; // simple: target = current FT amount

  const contract = new Contract(
    meanRevertArtifact,
    [
      tokenCategoryBytes,
      targetTokenAmount,
      rebalancerNftCatBytes,
      rebalancerNftCommitBytes,
      ownerPkh,
    ],
    { provider }
  );

  const contractBchAddress = contract.address;
  const contractTokenAddress = toTokenAwareAddress(contract.address);

  console.log("\n--- Contract instantiated ---");
  console.log("Contract (CashScript) address:", contractBchAddress);
  console.log("Contract token address       :", contractTokenAddress);
  console.log("FT category (VM hex)        :", ftCategoryVmHex);
  console.log("NFT category (VM hex)       :", nftCategoryVmHex);
  console.log("Target token amount         :", targetTokenAmount.toString());

  // ---------------------------------------------------------------------------
  // 3. FUND contract (FT + BCH) with fee estimated via placeholder change
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 1: Fund contract (FT + BCH) ---");

  const ftInputValue = utxoValueBigInt(ftUtxo);
  const bchInputValue = utxoValueBigInt(feeUtxo);
  const totalFundInput = ftInputValue + bchInputValue;

  console.log("[fund] FT input:         ", formatSats(ftInputValue));
  console.log("[fund] BCH input:        ", formatSats(bchInputValue));
  console.log("[fund] Combined inputs:  ", formatSats(totalFundInput));

  // Provisional build: contract gets (total - dust), Alice gets DUST placeholder
  const { fee: fundFee } = await estimateFeeWithPlaceholderChange(async () => {
    const provisional = new TransactionBuilder({ provider });
    provisional.addInput(ftUtxo, aliceTemplate.unlockP2PKH());
    provisional.addInput(feeUtxo, aliceTemplate.unlockP2PKH());

    const contractGuess = totalFundInput - DUST_THRESHOLD;
    if (contractGuess <= DUST_THRESHOLD) {
      throw new Error(
        "Not enough value to construct provisional fund tx with placeholder change."
      );
    }

    provisional.addOutput({
      to: contractTokenAddress,
      amount: contractGuess,
      token: {
        category: ftCategoryWalletHex,
        amount: ftAmount,
      },
    });

    provisional.addOutput({
      to: aliceAddress,
      amount: DUST_THRESHOLD,
    });

    const hex = await provisional.build(); // hex string
    return hex;
  }, totalFundInput);

  const availableAfterFundFee = totalFundInput - fundFee;
  console.log("[fund] Estimated fee:       ", formatSats(fundFee));
  console.log(
    "[fund] Available after fee: ",
    formatSats(availableAfterFundFee)
  );

  if (availableAfterFundFee <= DUST_THRESHOLD) {
    throw new Error(
      "Available value after fee is below dust; cannot safely fund contract."
    );
  }

  // Decide whether to keep a change output:
  //  - If we can pay contract >= dust and change >= dust, keep both.
  //  - Otherwise, send everything (after fee) to the contract, no change.
  let fundContractAmount, fundChangeAmount;

  if (availableAfterFundFee > 2n * DUST_THRESHOLD) {
    fundChangeAmount = DUST_THRESHOLD;
    fundContractAmount = availableAfterFundFee - fundChangeAmount;
  } else {
    fundChangeAmount = 0n;
    fundContractAmount = availableAfterFundFee;
  }

  if (fundContractAmount <= DUST_THRESHOLD) {
    throw new Error(
      "Contract output would be below dust after fee/change calculation."
    );
  }

  console.log("[fund] Final contract amount: ", formatSats(fundContractAmount));
  if (fundChangeAmount > 0n) {
    console.log("[fund] Change back to Alice:", formatSats(fundChangeAmount));
  } else {
    console.log("[fund] No separate change output (all to contract).");
  }

  // Final fund tx
  const fundBuilder = new TransactionBuilder({ provider });
  fundBuilder.addInput(ftUtxo, aliceTemplate.unlockP2PKH());
  fundBuilder.addInput(feeUtxo, aliceTemplate.unlockP2PKH());

  fundBuilder.addOutput({
    to: contractTokenAddress,
    amount: fundContractAmount,
    token: {
      category: ftCategoryWalletHex,
      amount: ftAmount,
    },
  });

  if (fundChangeAmount > 0n) {
    fundBuilder.addOutput({
      to: aliceAddress,
      amount: fundChangeAmount,
    });
  }

  const fundTxDetails = await fundBuilder.send();
  console.log("Fund txid:", fundTxDetails.txid);

  console.log("\n--- State after funding ---");
  await logAddressState("Alice (post-fund)", provider, aliceTokenAddress);
  await logContractState("Contract (post-fund)", contract);

  // ---------------------------------------------------------------------------
  // 4. Rebalance using NFT authority
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 2: (demo) rebalance() using NFT ---");

  const contractUtxosAfterFund = await contract.getUtxos();
  if (!contractUtxosAfterFund.length) {
    throw new Error("No contract UTXOs found after funding.");
  }
  const contractUtxo = contractUtxosAfterFund[0];

  const contractValueBefore = utxoValueBigInt(contractUtxo);
  const contractTokensBefore = BigInt(contractUtxo.token.amount ?? 0n);

  console.log("Contract UTXO before rebalance:");
  console.log(`  value : ${formatSats(contractValueBefore)}`);
  console.log(`  tokens: ${contractTokensBefore.toString()}`);

  // Total BCH in rebalance tx inputs = contract UTXO + NFT UTXO
  const rebalanceInputTotal = contractValueBefore + utxoValueBigInt(nftUtxo);

  // Provisional rebalance tx to estimate fee: contract + 546-sat placeholder to Alice
  const { fee: rebalanceFee } = await estimateFeeWithPlaceholderChange(
    async () => {
      const provisionalCall = contract.functions
        .rebalance()
        .from([contractUtxo])
        .fromP2PKH([nftUtxo], aliceTemplate)
        .to(
          {
            to: contractTokenAddress,
            amount: rebalanceInputTotal - DUST_THRESHOLD,
            token: {
              category: ftCategoryWalletHex,
              amount: contractTokensBefore,
            },
          },
          {
            to: aliceAddress,
            amount: DUST_THRESHOLD,
          }
        );

      const hex = await provisionalCall.build(); // hex string
      return hex;
    },
    rebalanceInputTotal
  );

  const availableAfterRebalanceFee = rebalanceInputTotal - rebalanceFee;
  console.log("[rebal] Estimated fee:        ", formatSats(rebalanceFee));
  console.log(
    "[rebal] Available after fee:  ",
    formatSats(availableAfterRebalanceFee)
  );

  if (availableAfterRebalanceFee <= DUST_THRESHOLD) {
    console.log(
      "Skipping rebalance(): not enough value to keep contract output above dust after fee."
    );
  } else {
    // Same rule: if we can keep contract >= dust and Alice >= dust, do so.
    let rebalContractAmount, rebalAliceAmount;

    if (availableAfterRebalanceFee > 2n * DUST_THRESHOLD) {
      rebalAliceAmount = DUST_THRESHOLD;
      rebalContractAmount = availableAfterRebalanceFee - rebalAliceAmount;
    } else {
      rebalAliceAmount = 0n;
      rebalContractAmount = availableAfterRebalanceFee;
    }

    if (rebalContractAmount <= DUST_THRESHOLD) {
      throw new Error(
        "Contract output would be below dust in rebalance() final tx."
      );
    }

    console.log(
      "[rebal] Final contract amount:",
      formatSats(rebalContractAmount)
    );
    if (rebalAliceAmount > 0n) {
      console.log(
        "[rebal] Alice receive amount:",
        formatSats(rebalAliceAmount)
      );
    } else {
      console.log("[rebal] No separate Alice BCH output.");
    }

    const finalRebalanceCall = contract.functions
      .rebalance()
      .from([contractUtxo])
      .fromP2PKH([nftUtxo], aliceTemplate);

    const rebalOutputs = [
      {
        to: contractTokenAddress,
        amount: rebalContractAmount,
        token: {
          category: ftCategoryWalletHex,
          amount: contractTokensBefore,
        },
      },
    ];

    if (rebalAliceAmount > 0n) {
      rebalOutputs.push({
        to: aliceAddress,
        amount: rebalAliceAmount,
      });
    }

    const rebalanceTxDetails = await finalRebalanceCall
      .to(...rebalOutputs)
      .send();

    console.log("Rebalance txid:", rebalanceTxDetails.txid);
  }

  console.log("\n--- State after rebalance ---");
  await logContractState("Contract (post-rebalance)", contract);

  // ---------------------------------------------------------------------------
  // 5. Drain contract back to Alice, fee estimated from tx size
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 3: drain() contract back to Alice ---");

  const contractUtxosAfterRebalance = await contract.getUtxos();
  if (!contractUtxosAfterRebalance.length) {
    throw new Error("No contract UTXOs found after rebalance.");
  }
  const contractUtxo2 = contractUtxosAfterRebalance[0];

  const drainInputAmount = utxoValueBigInt(contractUtxo2);
  const drainTokenAmount = BigInt(contractUtxo2.token.amount ?? 0n);
  const drainTotalInput = drainInputAmount;

  // Provisional drain tx: send dust to Alice with tokens, just to get size
  const { fee: drainFee } = await estimateFeeWithPlaceholderChange(async () => {
    const provisionalDrainCall = contract.functions
      .drain(alicePub, aliceTemplate)
      .from([contractUtxo2])
      .to(aliceTokenAddress, DUST_THRESHOLD, {
        category: ftCategoryWalletHex,
        amount: drainTokenAmount,
      });

    const hex = await provisionalDrainCall.build(); // hex string
    return hex;
  }, drainTotalInput);

  const availableAfterDrainFee = drainTotalInput - drainFee;
  console.log("[drain] Estimated fee:       ", formatSats(drainFee));
  console.log(
    "[drain] Available after fee: ",
    formatSats(availableAfterDrainFee)
  );

  if (availableAfterDrainFee <= DUST_THRESHOLD) {
    throw new Error(
      "Contract UTXO too small to drain after fee (would be below dust)."
    );
  }

  console.log(
    `Draining ${formatSats(
      availableAfterDrainFee
    )} and ${drainTokenAmount.toString()} tokens back to Alice`
  );

  const finalDrainCall = contract.functions
    .drain(alicePub, aliceTemplate)
    .from([contractUtxo2])
    .to(aliceTokenAddress, availableAfterDrainFee, {
      category: ftCategoryWalletHex,
      amount: drainTokenAmount,
    });

  const drainTxDetails = await finalDrainCall.send();
  console.log("Drain txid:", drainTxDetails.txid);

  console.log("\n--- Final state ---");
  await logAddressState("Alice (final)", provider, aliceTokenAddress);
  await logContractState("Contract (final)", contract);

  console.log("\n✅ MeanRevertSingleTokenNFTAuth demo completed.");
}

main().catch((err) => {
  console.error("\n❌ Error in meanRevertSingleTokenNFTDemo:", err);
  process.exit(1);
});
