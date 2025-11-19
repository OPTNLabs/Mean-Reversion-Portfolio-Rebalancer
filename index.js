// index.js
//
// Root CLI orchestrator for the loops demo.
//
// Commands (node index.js <cmd>):
//   mint-all       → Mint FT + NFT (atomic) to aliceTokenAddress
//   burn-tokens    → Burn ALL tokens from aliceTokenAddress
//   mean-fund      → Send FT from Alice → MeanRevert contract
//   mean-rebalance → NFT-authorised rebalance()
//   mean-roundtrip → fund + rebalance in one go
//   mean-drain     → Drain ALL contract funds back to Alice
//   status         → Print UTXO summaries for Alice P2PKH + token address
//
// Live scripts use ElectrumNetworkProvider on NETWORK (see config.js).
// Tests (under ./tests) use MockNetworkProvider (local mocknet).

import { ElectrumNetworkProvider } from "cashscript";

import { runMintAllForAlice } from "./scripts/mintAllForAlice.js";
import { runBurnAllTokensFromAlice } from "./scripts/burnAllTokensFromAlice.js";
import {
  runMeanRevertFund,
  runMeanRevertRebalance,
  runMeanRevertRoundtrip,
  runMeanRevertDrainAll,
} from "./scripts/meanRevert.js";

import { aliceAddress, aliceTokenAddress } from "./common.js";
import { NETWORK } from "./config.js";
import { logAddressState } from "./utxos.js";

async function showStatus() {
  console.log("=========================================");
  console.log("  ADDRESS STATUS (live network)");
  console.log("=========================================\n");
  console.log(`[network] Using NETWORK="${NETWORK}"\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);

  await logAddressState("Alice (main P2PKH)", provider, aliceAddress);
  await logAddressState(
    "Alice (token P2PKH+tokens)",
    provider,
    aliceTokenAddress
  );
}

async function main() {
  const cmd = process.argv[2] ?? "help";

  if (cmd === "mint-all") {
    console.log("[index] Running: runMintAllForAlice");
    await runMintAllForAlice();
  } else if (cmd === "burn-tokens") {
    console.log("[index] Running: runBurnAllTokensFromAlice");
    await runBurnAllTokensFromAlice();
  } else if (cmd === "mean-fund") {
    console.log("[index] Running: runMeanRevertFund (FT Alice → contract)");
    await runMeanRevertFund();
  } else if (cmd === "mean-rebalance") {
    console.log("[index] Running: runMeanRevertRebalance (NFT-authorised)");
    await runMeanRevertRebalance();
  } else if (cmd === "mean-roundtrip") {
    console.log(
      "[index] Running: runMeanRevertRoundtrip (fund + NFT-authorised rebalance)"
    );
    await runMeanRevertRoundtrip();
  } else if (cmd === "mean-drain") {
    console.log(
      "[index] Running: runMeanRevertDrainAll (drain contract → Alice)"
    );
    await runMeanRevertDrainAll();
  } else if (cmd === "status") {
    console.log("[index] Running: status");
    await showStatus();
  } else {
    console.log("Usage: node index.js <command>\n");
    console.log("Commands:");
    console.log("  mint-all       → mint FT + NFT (atomic) to Alice");
    console.log("  burn-tokens    → burn ALL tokens from aliceTokenAddress");
    console.log("  mean-fund      → FT Alice → MeanRevert contract");
    console.log("  mean-rebalance → NFT-authorised rebalance()");
    console.log("  mean-roundtrip → fund + rebalance in one go");
    console.log("  mean-drain     → drain ALL contract funds back to Alice");
    console.log("  status         → show Alice UTXO summaries\n");
  }
}

main().catch((err) => {
  console.error("Error in index.js:", err);
  process.exit(1);
});
