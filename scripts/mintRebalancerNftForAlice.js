// scripts/mintRebalancerNftForAlice.js
//
// Proper CashTokens NFT genesis for a "rebalancer" NFT,
// following the spec: category = txid of a vout=0 input.
//
// Run:
//   node scripts/mintRebalancerNftForAlice.js

import {
  ElectrumNetworkProvider,
  SignatureTemplate,
  TransactionBuilder,
} from "cashscript";
import { NETWORK, DUST_THRESHOLD } from "../config.js";
import { alicePriv, aliceTokenAddress } from "../common.js";
import { splitByToken, logAddressState, selectFundingUtxo } from "../utxos.js";
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
  console.log(" Minting rebalancer NFT for Alice (spec-correct)");
  console.log("=========================================\n");

  const aliceUtxos = await logAddressState(
    "Alice (before NFT mint)",
    provider,
    aliceTokenAddress
  );

  const { bchOnly } = splitByToken(aliceUtxos);
  if (!bchOnly.length) {
    throw new Error(
      "Alice has no BCH-only UTXOs at aliceTokenAddress. Send some BCH first."
    );
  }

  // Filter to BCH-only UTXOs where vout === 0 (eligible for token genesis)
  const vout0Bch = bchOnly.filter((u) => u.vout === 0);
  if (!vout0Bch.length) {
    throw new Error(
      [
        "No BCH-only UTXO with vout=0 found for Alice.",
        "To create a token category per the CashTokens spec,",
        "you must spend a vout=0 UTXO in the genesis tx.",
        "",
        "Workaround:",
        "  - Create a simple self-send tx to aliceTokenAddress",
        "    where the received output is index 0, then re-run this script.",
      ].join("\n")
    );
  }

  // Require at least ~5k sats on that UTXO (for fee + dust)
  const fundingUtxo = selectFundingUtxo(vout0Bch, 5000n) ?? vout0Bch[0];
  const inputValue = utxoValueBigInt(fundingUtxo);

  const fee = 1000n;
  const outputAmount = inputValue - fee;

  if (outputAmount <= DUST_THRESHOLD) {
    throw new Error(
      `Funding UTXO too small to mint NFT after fee. value=${inputValue} fee=${fee}`
    );
  }

  console.log("Selected genesis/funding UTXO:");
  console.log(`  txid:  ${fundingUtxo.txid}`);
  console.log(`  vout:  ${fundingUtxo.vout} (must be 0 for category genesis)`);
  console.log(`  value: ${formatSats(inputValue)}`);
  console.log(`Minting NFT with output amount: ${formatSats(outputAmount)}`);
  console.log(`Estimated fee: ${formatSats(fee)}\n`);

  // Per spec: category ID = txid of a token genesis input (vout=0)
  const newCategory = fundingUtxo.txid;
  console.log(`New NFT Category (txid of vout=0 input): ${newCategory}`);

  // Commitment is "rebal_key" in ASCII hex
  const rebalCommitmentHex = "726562616c5f6b6579";

  const builder = new TransactionBuilder({ provider });
  builder.addInput(fundingUtxo, aliceTemplate.unlockP2PKH());
  builder.addOutput({
    to: aliceTokenAddress,
    amount: outputAmount,
    token: {
      category: newCategory, // must match vout=0 input txid
      amount: 0n, // NFT only, no FTs
      nft: {
        capability: "minting", // allowed in genesis
        commitment: rebalCommitmentHex,
      },
    },
  });

  const txDetails = await builder.send();
  console.log("Mint NFT txid:", txDetails.txid);

  console.log("\n--- Alice state (after NFT mint) ---");
  await logAddressState("Alice (after NFT mint)", provider, aliceTokenAddress);

  console.log("\n✅ Rebalancer NFT minted to aliceTokenAddress.");
  console.log(
    "You can now re-run: node scripts/meanRevertSingleTokenNFTDemo.js"
  );
}

main().catch((err) => {
  console.error("\n❌ Error in mintRebalancerNftForAlice:", err);
  process.exit(1);
});
