// scripts/meanRevertSingleTokenNFTDemo.js
//
// Demo for MeanRevertSingleTokenNFTAuth.cash
//
// Flow:
// 1. Pick a fungible token category from Alice's token address.
// 2. Pick an NFT owned by Alice as the rebalancer authority.
// 3. Instantiate MeanRevertSingleTokenNFTAuth.
// 4. Fund the contract with FT + BCH (P2PKH → contract, via TransactionBuilder).
// 5. Perform a rebalance() call using the NFT as authorization.
// 6. Drain the contract back to Alice.
//
// Run:
//   node scripts/meanRevertSingleTokenNFTDemo.js

import {
  Contract,
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from "cashscript";
import { compileFile } from "cashc";
import { hash160 } from "@cashscript/utils";
import {
  hexToBin,
  swapEndianness,
  decodeCashAddress,
  encodeCashAddress,
} from "@bitauth/libauth";

import { NETWORK, DUST_THRESHOLD } from "../config.js";
import { alicePriv, alicePub, aliceTokenAddress } from "../common.js";
import { splitByToken, logAddressState, logContractState } from "../utxos.js";
import { formatSats } from "../bigint.js";

// Helper: normalize satoshi value field on UTXOs
function utxoValueBigInt(utxo) {
  const v = utxo.satoshis ?? utxo.value;
  if (v === undefined) throw new Error("UTXO missing satoshi value");
  return BigInt(v);
}

// Helper: pick a BCH-only UTXO large enough to pay `fee` and still leave >= dust
function pickFeeUtxo(bchOnlyUtxos, requiredFee) {
  const minNeeded = requiredFee + BigInt(DUST_THRESHOLD);
  const utxo = bchOnlyUtxos.find((u) => utxoValueBigInt(u) >= minNeeded);
  if (!utxo) {
    throw new Error(
      `No BCH-only UTXO large enough to pay fee (${requiredFee} sats) + dust (${DUST_THRESHOLD} sats)`
    );
  }
  return utxo;
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
      "Alice has no token UTXOs. Run mint-rebal-nft and mint-tokens first."
    );
  }
  if (!bchOnly.length) {
    throw new Error(
      "Alice has no BCH-only UTXOs to pay fees. Send some BCH to aliceTokenAddress."
    );
  }

  // Choose one FT (amount > 0) and one NFT (amount == 0 + commitment)
  let ftUtxo = null;
  let nftUtxo = null;

  for (const utxo of withTokens) {
    const t = utxo.token;
    if (!t) continue;

    const amount = BigInt(t.amount ?? 0n);
    const hasCommitment =
      t.nft?.commitment != null && t.nft.commitment.length > 0;

    if (!ftUtxo && amount > 0n) {
      ftUtxo = utxo;
    }

    if (!nftUtxo && amount === 0n && hasCommitment) {
      nftUtxo = utxo;
    }

    if (ftUtxo && nftUtxo) break;
  }

  if (!ftUtxo) {
    throw new Error("No fungible-token UTXO found for Alice.");
  }
  if (!nftUtxo) {
    throw new Error(
      "No NFT UTXO with commitment found for Alice. Mint an NFT to use as rebalancer key via mint-rebal-nft."
    );
  }

  // FT details
  const ftCategoryWalletHex = ftUtxo.token.category; // wallet/explorer order
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

  // ---------------------------------------------------------------------------
  // 2. Instantiate contract (with correct constructor args)
  // ---------------------------------------------------------------------------

  // Convert categories & commitment to VM-order bytes for the contract params
  const ftCategoryVmHex = swapEndianness(ftCategoryWalletHex);
  const nftCategoryVmHex = swapEndianness(nftCategoryWalletHex);

  const tokenCategoryBytes = hexToBin(ftCategoryVmHex);
  const rebalancerNftCatBytes = hexToBin(nftCategoryVmHex);
  const rebalancerNftCommitBytes = hexToBin(nftCommitmentHex);

  const ownerPkh = hash160(alicePub);

  // For PoC: set target = current FT amount in the selected UTXO
  const targetTokenAmount = ftAmount;

  const artifact = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuth.cash", import.meta.url)
  );

  const contract = new Contract(
    artifact,
    [
      tokenCategoryBytes, // bytes
      targetTokenAmount, // int
      rebalancerNftCatBytes, // bytes
      rebalancerNftCommitBytes, // bytes
      ownerPkh, // bytes20
    ],
    { provider }
  );

  // Derive token-aware P2SH address from contract.address
  const contractP2shAddress = contract.address;
  const decoded = decodeCashAddress(contractP2shAddress, {
    throwErrors: true,
  });
  if (!decoded.payload) {
    throw new Error("Failed to decode contract P2SH address payload");
  }
  const contractTokenAddress = encodeCashAddress({
    prefix: decoded.prefix,
    type: "p2shWithTokens",
    payload: decoded.payload,
    throwErrors: true,
  }).address;

  console.log("\n--- Contract instantiated ---");
  console.log("Contract (CashScript) address:", contractP2shAddress);
  console.log("Contract token address       :", contractTokenAddress);
  console.log("FT category (VM hex)        :", ftCategoryVmHex);
  console.log("NFT category (VM hex)       :", nftCategoryVmHex);
  console.log("Target token amount         :", targetTokenAmount.toString());

  // ---------------------------------------------------------------------------
  // 3. FUND contract from Alice using FT + BCH-only UTXO
  //    - Inputs: FT UTXO + BCH-only UTXO
  //    - Outputs: contract (FT + BCH), + optional BCH change to Alice
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 1: Fund contract (FT + BCH) ---");

  const ftInputValue = utxoValueBigInt(ftUtxo);

  // Pick a BCH-only UTXO to co-fund this tx (for fees)
  const bchOnlySorted = [...bchOnly].sort((a, b) =>
    Number(utxoValueBigInt(b) - utxoValueBigInt(a))
  );
  const fundFeeUtxo = bchOnlySorted[0];
  const fundFeeInputValue = utxoValueBigInt(fundFeeUtxo);

  console.log("[fund] FT input:         ", formatSats(ftInputValue));
  console.log("[fund] BCH input:        ", formatSats(fundFeeInputValue));
  console.log(
    "[fund] Combined inputs:  ",
    formatSats(ftInputValue + fundFeeInputValue)
  );

  if (ftInputValue < BigInt(DUST_THRESHOLD)) {
    throw new Error(
      `FT UTXO value too small for contract fund: ${ftInputValue} < dust (${DUST_THRESHOLD})`
    );
  }

  const fundBuilder = new TransactionBuilder({ provider });

  fundBuilder.addInput(ftUtxo, aliceTemplate.unlockP2PKH());
  fundBuilder.addInput(fundFeeUtxo, aliceTemplate.unlockP2PKH());

  // Send FT + BCH to the token-aware P2SH contract address
  fundBuilder.addOutput({
    to: contractTokenAddress,
    amount: ftInputValue,
    token: {
      category: ftCategoryWalletHex,
      amount: ftAmount,
    },
  });

  const fundTxDetails = await fundBuilder.send();
  console.log("Fund txid:", fundTxDetails.txid);

  console.log("\n--- State after funding ---");
  await logAddressState("Alice (post-fund)", provider, aliceTokenAddress);
  await logContractState("Contract (post-fund)", contract);

  // ---------------------------------------------------------------------------
  // 4. Rebalance() using NFT authority
  //
  // For this PoC, we keep token amount unchanged – we just prove:
  //   - NFT must be present in inputs
  //   - Contract enforces its mean-reversion invariant
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 2: rebalance() using NFT ---");

  const contractUtxosAfterFund = await contract.getUtxos();
  if (!contractUtxosAfterFund.length) {
    throw new Error("No contract UTXOs found after funding.");
  }
  const contractUtxo = contractUtxosAfterFund[0];

  const contractValueBefore = utxoValueBigInt(contractUtxo);
  const contractTokensBefore = BigInt(contractUtxo.token?.amount ?? 0n);

  console.log("Contract UTXO before rebalance:");
  console.log(`  value : ${formatSats(contractValueBefore)}`);
  console.log(`  tokens: ${contractTokensBefore.toString()}`);

  // Refresh Alice's UTXOs to pick a fresh BCH-only UTXO for the rebalance fee
  const aliceUtxos2 = await provider.getUtxos(aliceTokenAddress);
  const { withTokens: withTokens2, bchOnly: bchOnly2 } =
    splitByToken(aliceUtxos2);

  // Re-find the NFT UTXO (in case earlier txs shuffled things)
  let nftUtxo2 = null;
  for (const utxo of withTokens2) {
    const t = utxo.token;
    if (!t) continue;
    const amount = BigInt(t.amount ?? 0n);
    const hasCommitment =
      t.nft?.commitment != null && t.nft.commitment.length > 0;

    if (
      amount === 0n &&
      hasCommitment &&
      t.category === nftCategoryWalletHex &&
      t.nft.commitment === nftCommitmentHex
    ) {
      nftUtxo2 = utxo;
      break;
    }
  }

  if (!nftUtxo2) {
    throw new Error(
      "Could not re-locate NFT UTXO after funding; ensure the NFT is still held by Alice."
    );
  }

  const rebalanceFee = 600n; // sats – keep generous enough

  const rebalanceFeeUtxo = pickFeeUtxo(bchOnly2, rebalanceFee);
  const rebalanceFeeInputValue = utxoValueBigInt(rebalanceFeeUtxo);
  const rebalanceChangeAmount = rebalanceFeeInputValue - rebalanceFee;

  console.log(
    "[rebalance] BCH fee input: ",
    formatSats(rebalanceFeeInputValue)
  );
  console.log("[rebalance] Fee (hardcoded):", formatSats(rebalanceFee));
  console.log(
    "[rebalance] Alice change:   ",
    formatSats(rebalanceChangeAmount)
  );

  // Contract BCH + FT remain unchanged; all fee comes from the BCH-only input.
  const rebalanceTxDetails = await contract.functions
    .rebalance()
    .from([contractUtxo])
    .fromP2PKH([nftUtxo2, rebalanceFeeUtxo], aliceTemplate)
    .to(
      {
        to: contractTokenAddress,
        amount: contractValueBefore,
        token: {
          category: ftCategoryWalletHex,
          amount: contractTokensBefore,
        },
      },
      {
        to: aliceTokenAddress,
        amount: rebalanceChangeAmount,
      }
    )
    .withHardcodedFee(rebalanceFee)
    .send();

  console.log("Rebalance txid:", rebalanceTxDetails.txid);

  console.log("\n--- State after rebalance ---");
  await logContractState("Contract (post-rebalance)", contract);
  await logAddressState("Alice (post-rebalance)", provider, aliceTokenAddress);

  // ---------------------------------------------------------------------------
  // 5. Drain contract back to Alice (owner escape hatch)
  // ---------------------------------------------------------------------------
  console.log("\n--- Step 3: drain() contract back to Alice ---");

  const contractUtxosAfterRebalance = await contract.getUtxos();
  if (!contractUtxosAfterRebalance.length) {
    throw new Error("No contract UTXOs found after rebalance.");
  }
  const contractUtxo2 = contractUtxosAfterRebalance[0];

  const drainInputAmount = utxoValueBigInt(contractUtxo2);
  const drainTokenAmount = BigInt(contractUtxo2.token?.amount ?? 0n);

  const drainFee = 600n;
  if (drainInputAmount <= drainFee + BigInt(DUST_THRESHOLD)) {
    throw new Error(
      `Contract UTXO too small to drain after fee. input=${drainInputAmount}, fee=${drainFee}, dust=${DUST_THRESHOLD}`
    );
  }

  const aliceDrainAmount = drainInputAmount - drainFee;

  console.log(
    `Draining ${formatSats(
      aliceDrainAmount
    )} and ${drainTokenAmount.toString()} tokens back to Alice`
  );
  console.log(`Implied miner fee (drain tx): ${formatSats(drainFee)}`);

  const drainTxDetails = await contract.functions
    .drain(alicePub, aliceTemplate)
    .from([contractUtxo2])
    .to(aliceTokenAddress, aliceDrainAmount, {
      category: ftCategoryWalletHex,
      amount: drainTokenAmount,
    })
    .withHardcodedFee(drainFee)
    .send();

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
