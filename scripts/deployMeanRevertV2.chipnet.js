// scripts/deployMeanRevertV2.chipnet.js
//
// Deploy MeanRevertSingleTokenNFTAuthV2.cash to CHIPNET using the
// FT + NFT categories and NFT commitment defined in common.js.

import { Contract, ElectrumNetworkProvider } from "cashscript";
import { compileFile } from "cashc";

import { NETWORK } from "../config.js";
import { alicePkh } from "../common.js";
import {
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
  TARGET_TOKENS,
} from "../config.js";

function hexToBytes(hex) {
  const cleaned = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (cleaned.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${cleaned.length}`);
  }
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  return bytes;
}

async function main() {
  console.log("==========================================");
  console.log(" Deploy MeanRevertSingleTokenNFTAuthV2");
  console.log("==========================================\n");
  console.log(`[network] Using NETWORK="${NETWORK}"`);
  console.log(
    `[rebalancer pkh] alicePkh = ${Buffer.from(alicePkh).toString("hex")}\n`
  );

  const provider = new ElectrumNetworkProvider(NETWORK);

  console.log("[compile] Compiling MeanRevertSingleTokenNFTAuthV2.cash...");
  const artifact = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuthV2.cash", import.meta.url)
  );

  const tokenCategoryBytes = hexToBytes(FT_CATEGORY_HEX);
  const rebalancerNftCatBytes = hexToBytes(NFT_CATEGORY_HEX);
  const rebalancerNftCommitBytes = hexToBytes(REBALANCER_NFT_COMMITMENT_HEX);

  console.log("[deploy] Constructor args:");
  console.log("  tokenCategoryBytes      :", FT_CATEGORY_HEX);
  console.log("  targetTokenAmount       :", TARGET_TOKENS.toString());
  console.log("  rebalancerNftCatBytes   :", NFT_CATEGORY_HEX);
  console.log("  rebalancerNftCommitBytes:", REBALANCER_NFT_COMMITMENT_HEX);
  console.log(
    "  rebalancerPkh (alice)   :",
    Buffer.from(alicePkh).toString("hex")
  );
  console.log("");

  const contract = new Contract(
    artifact,
    [
      tokenCategoryBytes,
      TARGET_TOKENS,
      rebalancerNftCatBytes,
      rebalancerNftCommitBytes,
      alicePkh,
    ],
    { provider }
  );

  console.log("=== MeanRevert V2 CHIPNET deployment ===");
  console.log("Contract address (BCH-only)   :", contract.address);
  console.log("Contract token address (FTs)  :", contract.tokenAddress);
  console.log("");
  console.log(
    "Next steps:\n" +
      "  1) Send some FT tokens from aliceTokenAddress to contract.tokenAddress.\n" +
      "  2) Later, build rebalancing transactions that:\n" +
      "       - spend from contract.tokenAddress UTXOs\n" +
      "       - include the rebalancer NFT input\n" +
      "       - satisfy the mean-reversion inequality enforced by the covenant.\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Error deploying MeanRevert V2:", err);
    process.exitCode = 1;
  });
}
