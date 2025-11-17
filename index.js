// index.js
import {
  runFundContractFromAlice,
  runFundManySmallToContract,
} from "./scripts/fundContractFromAlice.js";
import { runSpendContractToAlice } from "./scripts/spendContractToAlice.js";

async function main() {
  const cmd = process.argv[2] ?? "fund";

  if (cmd === "fund") {
    console.log("[index] Running: fundContractFromAlice");
    await runFundContractFromAlice();
  } else if (cmd === "fund-small") {
    console.log("[index] Running: runFundManySmallToContract");
    await runFundManySmallToContract();
  } else if (cmd === "spend") {
    console.log("[index] Running: spendContractToAlice");
    await runSpendContractToAlice();
  } else if (cmd === "both") {
    console.log("[index] Running: fund (large), then spend (split outputs)");
    await runFundContractFromAlice();
    await runSpendContractToAlice();
  } else if (cmd === "small-cycle") {
    console.log(
      "[index] Running: fundManySmallToContract, then spend (split outputs)"
    );
    await runFundManySmallToContract();
    await runSpendContractToAlice();
  } else {
    console.log(
      "Usage: node index.js [fund|fund-small|spend|both|small-cycle]"
    );
  }
}

main().catch((err) => {
  console.error("Error in index.js:", err);
  process.exit(1);
});
