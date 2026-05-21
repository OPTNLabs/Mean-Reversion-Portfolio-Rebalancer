// scripts/inspectMeanRevertV3State.js
//
// Inspect the on-chain state of MeanRevertSingleTokenNFTAuthV3 on CHIPNET.

import { ElectrumNetworkProvider, Contract } from "cashscript";
import { compileFile } from "cashc";

import {
  NETWORK,
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
  TARGET_TOKENS,
} from "../config.js";
import { alicePkh } from "../common.js";
import { formatSats, safeJson } from "../bigint.js";

function beHexToVmBytes(beHex) {
  const clean = beHex.startsWith("0x") ? beHex.slice(2) : beHex;
  const vmHex = clean.match(/../g).reverse().join("");
  return `0x${vmHex}`;
}

function utxoValueBigInt(u) {
  const v = u.satoshis ?? u.value;
  return v === undefined ? 0n : BigInt(v);
}

export async function runInspectMeanRevertV3State() {
  console.log("========================================");
  console.log(" Inspect MeanRevertSingleTokenNFTAuthV3 ");
  console.log("========================================\n");
  console.log(`[network] NETWORK="${NETWORK}"\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);

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
      TARGET_TOKENS, // same as deploy/fund/rebalance
      nftCategoryBytes,
      nftCommitBytes,
      alicePkh,
    ],
    { provider }
  );

  console.log("V3 contract.address      :", contract.address);
  console.log("V3 contract.tokenAddress :", contract.tokenAddress);

  const utxos = await contract.getUtxos();

  console.log(`\n=== Contract UTXOs (count=${utxos.length}) ===`);
  let totalBch = 0n;
  const tokenBalances = new Map(); // category -> amount

  for (const u of utxos) {
    const v = utxoValueBigInt(u);
    totalBch += v;

    if (u.token) {
      const cat = u.token.category;
      const amt = BigInt(u.token.amount ?? 0n);
      tokenBalances.set(cat, (tokenBalances.get(cat) ?? 0n) + amt);
    }

    console.log(
      ` • txid=${u.txid} vout=${u.vout} value=${formatSats(v)} ` +
        (u.token
          ? `| token.category=${u.token.category} amount=${u.token.amount}` +
            (u.token.nft?.commitment
              ? ` nftCommit=${u.token.nft.commitment}`
              : "")
          : "")
    );
  }

  console.log(`\nTotal BCH on contract: ${formatSats(totalBch)}`);

  console.log("\nToken balances per category:");
  if (!tokenBalances.size) {
    console.log("  (none)");
  } else {
    for (const [cat, amt] of tokenBalances.entries()) {
      const marker = cat === FT_CATEGORY_HEX ? " ← stablecoin FT" : "";
      console.log(`  ${cat}: ${amt.toString()}${marker}`);
    }
  }

  console.log(
    "\nTip: stablecoin FT category should match config.FT_CATEGORY_HEX."
  );
}

// --- CLI runner ---
if (import.meta.url === `file://${process.argv[1]}`) {
  runInspectMeanRevertV3State().catch((err) => {
    console.error("Error in inspectMeanRevertV3State script:", err);
    process.exit(1);
  });
}
