// index.js
import {
  runFundContractFromAlice,
  runFundManySmallToContract,
} from "./scripts/fundContractFromAlice.js";
import { runSpendContractToAlice } from "./scripts/spendContractToAlice.js";
import { runMintTokensForAlice } from "./scripts/mintTokensForAlice.js";
import { runTokenContractRoundtrip } from "./scripts/tokenContractRoundtrip.js";

import { aliceAddress } from "./common.js";
import { getProviderAndContract } from "./contract.js";
import { splitByToken } from "./utxos.js";
import { SMALL_FUNDING_AMOUNT, SMALL_FUND_COUNT } from "./config.js";

async function main() {
  const cmd = process.argv[2] ?? "fund";

  if (cmd === "fund") {
    console.log("[index] Running: fundContractFromAlice");
    await runFundContractFromAlice();
  } else if (cmd === "fund-small") {
    console.log("[index] Running: runFundManySmallToContract");
    await runFundManySmallToContract();
  } else if (cmd === "spend") {
    console.log("[index] Running: runSpendContractToAlice");
    await runSpendContractToAlice();
  } else if (cmd === "both") {
    console.log("[index] Running: fund (large), then spend (merge to 1 UTXO)");
    await runFundContractFromAlice();
    await runSpendContractToAlice();
  } else if (cmd === "small-cycle") {
    console.log(
      "[index] Running: fundManySmallToContract (batched), then spend (merge to 1 UTXO)"
    );

    // Use a provider to measure Alice's BCH-only balance before & after
    const { provider } = getProviderAndContract();

    const aliceStartUtxos = await provider.getUtxos(aliceAddress);
    const { bchOnly: aliceStartBchUtxos } = splitByToken(aliceStartUtxos);
    const aliceStartBch = aliceStartBchUtxos.reduce(
      (sum, u) => sum + u.satoshis,
      0n
    );

    await runFundManySmallToContract();
    const spendResult = await runSpendContractToAlice();

    const aliceEndUtxos = await provider.getUtxos(aliceAddress);
    const { bchOnly: aliceEndBchUtxos } = splitByToken(aliceEndUtxos);
    const aliceEndBch = aliceEndBchUtxos.reduce(
      (sum, u) => sum + u.satoshis,
      0n
    );

    const netChange = aliceEndBch - aliceStartBch; // likely negative
    const totalFees = aliceStartBch - aliceEndBch; // positive
    const roundTrip = SMALL_FUNDING_AMOUNT * BigInt(SMALL_FUND_COUNT); // total through contract
    const contractInputs = spendResult?.inputs?.length ?? null;

    console.log("\n==== Small-cycle experiment summary ====");
    console.log(`Alice BCH before: ${aliceStartBch} sats`);
    console.log(`Alice BCH after : ${aliceEndBch} sats`);
    console.log(`Net change      : ${netChange} sats`);
    console.log(`Total miner fees (approx): ${totalFees} sats`);
    console.log(
      `Contract round-trip value: ${roundTrip} sats (via ${SMALL_FUND_COUNT} × ${SMALL_FUNDING_AMOUNT} sats)`
    );
    if (contractInputs !== null) {
      console.log(`Contract UTXOs spent in final tx: ${contractInputs}`);
    }
    console.log("========================================\n");
  } else if (cmd === "mint-tokens") {
    console.log("[index] Running: runMintTokensForAlice");
    await runMintTokensForAlice();
  } else if (cmd === "token-cycle") {
    console.log("[index] Running: runTokenContractRoundtrip");
    await runTokenContractRoundtrip();
  } else {
    console.log(
      "Usage: node index.js [fund|fund-small|spend|both|small-cycle|mint-tokens|token-cycle]"
    );
  }
}

main().catch((err) => {
  console.error("Error in index.js:", err);
  process.exit(1);
});
