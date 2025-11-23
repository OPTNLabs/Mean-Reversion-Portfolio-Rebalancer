// scripts/deployMeanRevertV3.chipnet.js
//
// Deploy (instantiate) MeanRevertSingleTokenNFTAuthV3 on CHIPNET.
// This does NOT create any on-chain UTXOs – it just gives us the
// deterministic contract + token addresses for the given constructor args.

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

// Helper: big-endian txid hex -> VM-order (little endian) bytes literal.
function beHexToVmBytes(beHex) {
  const clean = beHex.startsWith("0x") ? beHex.slice(2) : beHex;
  const vmHex = clean.match(/../g).reverse().join("");
  return `0x${vmHex}`;
}

export async function runDeployMeanRevertV3() {
  console.log("========================================");
  console.log(" Deploy MeanRevertSingleTokenNFTAuthV3 ");
  console.log("========================================\n");
  console.log(`[network] NETWORK="${NETWORK}"\n`);

  if (NETWORK !== "chipnet") {
    console.warn(
      `[warn] NETWORK is "${NETWORK}", but this script is intended for CHIPNET.`
    );
  }

  const provider = new ElectrumNetworkProvider(NETWORK);

  const artifact = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuthV3.cash", import.meta.url)
  );

  const tokenCategoryBytes = beHexToVmBytes(FT_CATEGORY_HEX);
  const nftCategoryBytes = beHexToVmBytes(NFT_CATEGORY_HEX);
  const nftCommitBytes = `0x${REBALANCER_NFT_COMMITMENT_HEX}`;

  console.log("[args] tokenCategory (FT, VM-order):", tokenCategoryBytes);
  console.log("[args] targetTokenAmount:", TARGET_TOKENS.toString());
  console.log("[args] rebalancerNftCat (NFT, VM-order):", nftCategoryBytes);
  console.log("[args] rebalancerNftCommit:", nftCommitBytes);
  console.log(
    "[args] ownerPkh (Alice):",
    Buffer.from(alicePkh).toString("hex")
  );
  console.log("");

  const contract = new Contract(
    artifact,
    [
      tokenCategoryBytes,
      TARGET_TOKENS,
      nftCategoryBytes,
      nftCommitBytes,
      alicePkh,
    ],
    { provider }
  );

  console.log("=== V3 CONTRACT ===");
  console.log("contract.address      :", contract.address);
  console.log("contract.tokenAddress :", contract.tokenAddress);
  console.log("");
  console.log(
    "Tip: keep these constructor args stable so all V3 scripts point to the same contract."
  );
  console.log("");

  return { contract, provider };
}

// --- CLI runner ---
if (import.meta.url === `file://${process.argv[1]}`) {
  runDeployMeanRevertV3().catch((err) => {
    console.error("Error in deployMeanRevertV3.chipnet script:", err);
    process.exit(1);
  });
}
