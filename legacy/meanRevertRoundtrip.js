// scripts/meanRevertRoundtrip.js
//
// MeanRevertSingleTokenNFTAuth – FT funding + NFT-authorised rebalance PoC
//
// Flow:
//  1) Detect Alice's freshly-minted FT + NFT from mintAllForAlice.js
//  2) Compile & instantiate MeanRevertSingleTokenNFTAuth from .cash
//     - tokenCategory     = FT category from Alice's FT UTXO
//     - targetTokenAmount = 1000n (per your confirmation)
//     - rebalancerNftCat  = NFT category from Alice's NFT UTXO
//     - rebalancerNftCommit = "6e667430" (or whatever is on the NFT)
//     - ownerPkh          = alicePkh
//  3) Send ALL FT from Alice → contract.tokenAddress
//  4) Run rebalance():
//       - Inputs: contract FT UTXO, Alice NFT UTXO, Alice BCH UTXO
//       - Outputs: same FT back to contract, NFT back to Alice, BCH change
//     This keeps oldTokens == newTokens, so |new-target| <= |old-target|
//     and exercises the NFT auth + loop logic.
//
// NOTE: This assumes your NFT UTXO satisfies the on-chain condition
//   tx.inputs[k].tokenAmount == 0
// for the authority check. If your mint set token.amount = 1n, you may
// need to adjust the contract check or mint a "pure" NFT.

import {
  Contract,
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
} from "cashscript";
import { compileFile } from "cashc";

import {
  alicePriv,
  alicePkh,
  aliceAddress,
  aliceTokenAddress,
} from "../common.js";
import {
  splitByToken,
  logAddressState,
  logContractState,
  selectFundingUtxo,
} from "../utxos.js";
import { NETWORK, SATS_PER_BYTE, DUST_THRESHOLD } from "../config.js";

// ---------------------------------------------------------------------------
// Contract instantiation (derives categories from actual UTXOs)
// ---------------------------------------------------------------------------

function safeJson(o) {
  return JSON.stringify(
    o,
    (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v),
    2
  );
}

/**
 * Compile MeanRevertSingleTokenNFTAuth and instantiate it using:
 *  - FT category from Alice's FT UTXO
 *  - NFT category + commitment from Alice's NFT UTXO
 */
async function initMeanRevertContract(provider) {
  console.log("\n=== Initialising MeanRevertSingleTokenNFTAuth contract ===");

  // 1) See what Alice has on her token-aware address
  const aliceTokenUtxos = await logAddressState(
    "Alice (token address, initial)",
    provider,
    aliceTokenAddress
  );
  const { withTokens: aliceTokenWithTokens } = splitByToken(aliceTokenUtxos);

  // Pick an FT UTXO (any token with amount > 0 and no NFT metadata)
  const ftTemplateUtxo =
    aliceTokenWithTokens.find(
      (u) => u.token?.amount && u.token.amount > 0n && !u.token.nft
    ) ?? null;

  if (!ftTemplateUtxo) {
    throw new Error(
      "No fungible token UTXO found on Alice's token address (need FT from mintAllForAlice.js)."
    );
  }

  // Pick the NFT that should act as rebalancer authority
  // Here we look for commitment "6e667430", but you can relax this if needed.
  const nftTemplateUtxo =
    aliceTokenWithTokens.find(
      (u) => u.token?.nft && u.token.nft.commitment === "6e667430" // "nft0" in hex
    ) ?? null;

  if (!nftTemplateUtxo) {
    throw new Error(
      'No NFT UTXO with commitment "6e667430" found on Alice\'s token address.'
    );
  }

  console.log("\n[init] Using FT template UTXO:\n", safeJson(ftTemplateUtxo));
  console.log("\n[init] Using NFT template UTXO:\n", safeJson(nftTemplateUtxo));

  const tokenCategory = ftTemplateUtxo.token.category;
  const rebalancerNftCat = nftTemplateUtxo.token.category;
  const rebalancerNftCommit = nftTemplateUtxo.token.nft.commitment;

  const targetTokenAmount = 1000n; // per your confirmation
  const ownerPkh = alicePkh;

  // 2) Compile the .cash file (contract folder only has .cash)
  const artifact = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuth.cash", import.meta.url)
  );

  // 3) Instantiate the contract
  const contract = new Contract(
    artifact,
    [
      tokenCategory,
      targetTokenAmount,
      rebalancerNftCat,
      rebalancerNftCommit,
      ownerPkh,
    ],
    { provider }
  );

  console.log("\n[init] MeanRevert contract address     :", contract.address);
  console.log("[init] MeanRevert token-aware address :", contract.tokenAddress);

  return {
    contract,
    tokenCategory,
    targetTokenAmount,
    rebalancerNftCat,
    rebalancerNftCommit,
    ftTemplateUtxo,
    nftTemplateUtxo,
  };
}

// ---------------------------------------------------------------------------
// Step 1 – Send FT from Alice → contract.tokenAddress
// ---------------------------------------------------------------------------

async function fundContractWithFt(provider, contract, tokenCategory) {
  console.log("\n=== Step 1: Funding contract with FT from Alice ===");

  const aliceTokenUtxos = await logAddressState(
    "Alice (token address, before FT fund)",
    provider,
    aliceTokenAddress
  );
  const { withTokens: aliceTokenWithTokens } = splitByToken(aliceTokenUtxos);

  const ftUtxo =
    aliceTokenWithTokens.find(
      (u) =>
        u.token?.category === tokenCategory &&
        u.token.amount &&
        u.token.amount > 0n
    ) ?? null;

  if (!ftUtxo) {
    throw new Error(
      "No FT UTXO for the configured tokenCategory found on Alice's token address."
    );
  }

  console.log(
    `[fund-FT] Using FT UTXO: category=${ftUtxo.token.category}, ` +
      `amount=${ftUtxo.token.amount}, BCH backing=${ftUtxo.satoshis} sats`
  );

  // BCH-only funding for the fee (from Alice's main BCH address)
  const aliceMainUtxos = await logAddressState(
    "Alice (main BCH address, fee funding for FT)",
    provider,
    aliceAddress
  );
  const { bchOnly: aliceMainBchOnly } = splitByToken(aliceMainUtxos);

  const feeFundingUtxo = selectFundingUtxo(aliceMainBchOnly, 3000n);
  if (!feeFundingUtxo) {
    throw new Error(
      "No BCH-only UTXO ≥ 3000 sats available for FT funding fee on Alice's main address."
    );
  }

  console.log(
    "[fund-FT] Using fee funding UTXO:",
    `${feeFundingUtxo.txid}:${feeFundingUtxo.vout}, value=${feeFundingUtxo.satoshis} sats`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);
  const ftValue = ftUtxo.satoshis;
  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional for fee estimation
  const builder1 = new TransactionBuilder({ provider });
  builder1.addInput(ftUtxo, aliceTemplate.unlockP2PKH());
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder1.addOutput({
    to: contract.tokenAddress,
    amount: ftValue,
    token: ftUtxo.token,
  });

  // Provisional "all back" change, will be reduced to pay fee
  builder1.addOutput({
    to: aliceAddress,
    amount: fundingValue,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[fund-FT] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final tx with calculated fee
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[fund-FT] Final change from fee funding UTXO = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const builder2 = new TransactionBuilder({ provider });
  builder2.addInput(ftUtxo, aliceTemplate.unlockP2PKH());
  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder2.addOutput({
    to: contract.tokenAddress,
    amount: ftValue,
    token: ftUtxo.token,
  });

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log("\n[fund-FT] FT funding tx broadcast:", txDetails);

  await logContractState("MeanRevert contract (after FT fund)", contract);
}

// ---------------------------------------------------------------------------
// Step 2 – NFT-authorised rebalance() that keeps tokens unchanged
// ---------------------------------------------------------------------------

async function runNftAuthorisedRebalance(
  provider,
  contract,
  tokenCategory,
  rebalancerNftCat,
  rebalancerNftCommit
) {
  console.log("\n=== Step 2: NFT-authorised rebalance() ===");

  // Contract UTXOs – we expect one FT UTXO with our tokenCategory
  const contractUtxos = await logContractState(
    "MeanRevert contract (before rebalance)",
    contract
  );
  const { withTokens: contractTokenUtxos } = splitByToken(contractUtxos);

  const contractFtUtxo =
    contractTokenUtxos.find(
      (u) =>
        u.token?.category === tokenCategory &&
        u.token.amount &&
        u.token.amount > 0n
    ) ?? null;

  if (!contractFtUtxo) {
    throw new Error(
      "Contract does not hold an FT UTXO for the configured tokenCategory."
    );
  }

  console.log(
    `[rebalance] Contract FT UTXO: category=${contractFtUtxo.token.category}, ` +
      `amount=${contractFtUtxo.token.amount}, BCH backing=${contractFtUtxo.satoshis} sats`
  );

  // Alice's NFT authority UTXO – must match (rebalancerNftCat, rebalancerNftCommit)
  const aliceTokenUtxos = await logAddressState(
    "Alice (token address, for NFT authority)",
    provider,
    aliceTokenAddress
  );
  const { withTokens: aliceTokenWithTokens } = splitByToken(aliceTokenUtxos);

  const nftAuthorityUtxo =
    aliceTokenWithTokens.find(
      (u) =>
        u.token?.category === rebalancerNftCat &&
        u.token?.nft &&
        u.token.nft.commitment === rebalancerNftCommit
    ) ?? null;

  if (!nftAuthorityUtxo) {
    throw new Error(
      "No NFT authority UTXO found on Alice's token address matching rebalancer parameters."
    );
  }

  console.log(
    `[rebalance] Using NFT authority UTXO: category=${nftAuthorityUtxo.token.category}, ` +
      `capability=${nftAuthorityUtxo.token.nft.capability}, ` +
      `commitment=${nftAuthorityUtxo.token.nft.commitment}, ` +
      `BCH backing=${nftAuthorityUtxo.satoshis} sats`
  );

  // BCH-only UTXO from Alice for the fee
  const aliceMainUtxos = await logAddressState(
    "Alice (main BCH address, for rebalance fee)",
    provider,
    aliceAddress
  );
  const { bchOnly: aliceMainBchOnly } = splitByToken(aliceMainUtxos);

  const feeFundingUtxo = selectFundingUtxo(aliceMainBchOnly, 3000n);
  if (!feeFundingUtxo) {
    throw new Error(
      "No BCH-only UTXO ≥ 3000 sats available for rebalance fee funding on Alice's main address."
    );
  }

  console.log(
    "[rebalance] Using fee funding UTXO:",
    `${feeFundingUtxo.txid}:${feeFundingUtxo.vout}, value=${feeFundingUtxo.satoshis} sats`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);

  const ftValue = contractFtUtxo.satoshis;
  const nftValue = nftAuthorityUtxo.satoshis;
  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional tx to estimate fee
  const builder1 = new TransactionBuilder({ provider });

  //  - Contract FT input (unlocked by MeanRevert.rebalance())
  builder1.addInput(contractFtUtxo, contract.unlock.rebalance());

  //  - Alice NFT input (P2PKH)
  builder1.addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH());

  //  - Alice BCH fee funding input (P2PKH)
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  // Outputs:
  //  1) Same FT back to contract (no change in token total → distAfter == distBefore)
  builder1.addOutput({
    to: contract.tokenAddress,
    amount: ftValue,
    token: contractFtUtxo.token,
  });

  //  2) NFT back to Alice's token address (so she keeps the authority)
  builder1.addOutput({
    to: aliceTokenAddress,
    amount: nftValue,
    token: nftAuthorityUtxo.token,
  });

  //  3) Provisional BCH change output for fee funding UTXO
  builder1.addOutput({
    to: aliceAddress,
    amount: fundingValue,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[rebalance] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final tx with fee applied only to the BCH funding UTXO
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[rebalance] Final change from fee funding UTXO = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const builder2 = new TransactionBuilder({ provider });

  builder2.addInput(contractFtUtxo, contract.unlock.rebalance());
  builder2.addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH());
  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  // FT output stays entirely on the contract
  builder2.addOutput({
    to: contract.tokenAddress,
    amount: ftValue,
    token: contractFtUtxo.token,
  });

  // NFT returns to Alice
  builder2.addOutput({
    to: aliceTokenAddress,
    amount: nftValue,
    token: nftAuthorityUtxo.token,
  });

  // BCH change
  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log(
    "\n[rebalance] NFT-authorised rebalance tx broadcast:",
    txDetails
  );

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const inputsTotal = ftValue + nftValue + fundingValue;
    const outputsTotal = ftValue + nftValue + (includeChange ? realChange : 0n);
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[rebalance] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  await logContractState("MeanRevert contract (after rebalance)", contract);
  await logAddressState("Alice (after rebalance)", provider, aliceAddress);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const provider = new ElectrumNetworkProvider(NETWORK);

  const {
    contract,
    tokenCategory,
    targetTokenAmount,
    rebalancerNftCat,
    rebalancerNftCommit,
  } = await initMeanRevertContract(provider);

  console.log(
    "\n[init] Constructor args:",
    safeJson({
      tokenCategory,
      targetTokenAmount,
      rebalancerNftCat,
      rebalancerNftCommit,
      ownerPkh: alicePkh,
    })
  );

  // 1) Fund contract with FT from Alice
  await fundContractWithFt(provider, contract, tokenCategory);

  // 2) Run NFT-gated rebalance (no change in total tokens, but exercises the covenant)
  await runNftAuthorisedRebalance(
    provider,
    contract,
    tokenCategory,
    rebalancerNftCat,
    rebalancerNftCommit
  );

  console.log("\n>>> MeanRevertSingleTokenNFTAuth FT+NFT demo complete.");
}

main().catch((e) => {
  console.error("\n❌ ERROR in MeanRevert demo:", e);
  process.exit(1);
});
