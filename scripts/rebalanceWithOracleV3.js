// scripts/rebalanceWithOracleV3.js
//
// CHIPNET "good" rebalance for MeanRevertSingleTokenNFTAuthV3.
//
// This script:
//  - Reads the actual stablecoin token balance on the contract as oldTokens.
//  - Fetches a live oracle price (BCH/USD * 100) from General Protocols.
//  - Computes a dynamic tokenDelta that moves the portfolio toward
//    a 1:1 value balance (BCH_value_USD-ish vs FT).
//  - Leaves newTokens = oldTokens - tokenDelta on the contract and
//    sends tokenDelta FT to Alice.
//  - Ensures off-chain that the value imbalance improves:
//        D_after < D_before
//    using the same integer formula as the contract / tests.
//
// IMPORTANT: we DO NOT burn any fungible tokens.
//  - Total input tokens = total output tokens
//  - So we don't need allowImplicitFungibleTokenBurn.

import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
  Contract,
} from "cashscript";
import { compileFile } from "cashc";

import {
  NETWORK,
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
  TARGET_TOKENS,
  SATS_PER_BYTE,
  DUST_THRESHOLD,
} from "../config.js";
import {
  alicePriv,
  aliceAddress,
  aliceTokenAddress,
  alicePkh,
} from "../common.js";
import { formatSats, safeJson } from "../bigint.js";
import { fetchLatestOraclePrice } from "../oracles/fetchOraclePrice.js";

const BCH_SCALE_DOWN = 10_000n;
const PRICE_SCALE = 100n;

// Use the same env var as the indexerProxy server.
const ORACLE_PUBLIC_KEY_HEX = process.env.ORACLE_PUBLIC_KEY_HEX || "";

function beHexToVmBytes(beHex) {
  const clean = beHex.startsWith("0x") ? beHex.slice(2) : beHex;
  const vmHex = clean.match(/../g).reverse().join("");
  return `0x${vmHex}`;
}

function utxoValueBigInt(u) {
  const v = u.satoshis ?? u.value;
  if (v === undefined) throw new Error("UTXO missing satoshi value");
  return BigInt(v);
}

function bchValueUsd(bchSats, oraclePriceRaw) {
  // Mirror the on-chain integer math:
  //   bchScaled = bchSats / 10_000
  //   bchValueUsd = (bchScaled * oraclePriceRaw) / 10_000 / 100
  const bchScaled = bchSats / BCH_SCALE_DOWN;
  return (bchScaled * oraclePriceRaw) / BCH_SCALE_DOWN / PRICE_SCALE;
}

function imbalance(bchSats, tokens, oraclePriceRaw) {
  const lhs = bchValueUsd(bchSats, oraclePriceRaw);
  const rhs = tokens;
  let d = lhs - rhs;
  if (d < 0n) d = -d;
  return d;
}

/**
 * Choose a new token amount for the contract that moves towards 1:1 BCH vs FT
 * using the same integer math as the covenant.
 *
 * This helper ONLY supports the "withdraw tokens" direction:
 *   newTokens < oldTokens
 *
 * Returns:
 *   {
 *     newTokens,      // BigInt – token amount to leave on contract
 *     stepTokens,     // BigInt – tokenDelta withdrawn to Alice
 *     bchUsd,         // BigInt – BCH value in USD-ish units
 *     D_before,       // BigInt – |bchUsd - oldTokens|
 *     D_after         // BigInt – |bchUsd - newTokens|
 *   }
 */
function chooseNewTokenAmountMeanRevert(oldBch, oldTokens, oraclePriceRaw) {
  const bchUsd = bchValueUsd(oldBch, oraclePriceRaw);

  let D_before = bchUsd - oldTokens;
  if (D_before < 0n) D_before = -D_before;

  // Case 1: already balanced at this integer precision.
  if (D_before === 0n) {
    return {
      newTokens: oldTokens,
      stepTokens: 0n,
      bchUsd,
      D_before,
      D_after: 0n,
    };
  }

  const targetTokens = bchUsd;

  // Case 2: mean-reversion direction would ADD tokens to the contract,
  // but this demo script only supports WITHDRAWING tokens.
  if (targetTokens >= oldTokens) {
    return {
      newTokens: oldTokens,
      stepTokens: 0n,
      bchUsd,
      D_before,
      D_after: D_before,
    };
  }

  // Normal withdraw-only mean-reversion (targetTokens < oldTokens).
  let gap = oldTokens - targetTokens; // > 0
  let step = gap / 2n;
  if (step < 1n) step = 1n;

  let newTokens = oldTokens - step;
  let D_after = imbalance(oldBch, newTokens, oraclePriceRaw);

  // Shrink the step until we find an improving move or give up.
  while (step > 1n && D_after >= D_before) {
    step = step / 2n;
    if (step < 1n) step = 1n;
    newTokens = oldTokens - step;
    D_after = imbalance(oldBch, newTokens, oraclePriceRaw);
  }

  if (D_after >= D_before) {
    // Fall back to "no-op" – let caller decide to skip the rebalance.
    return {
      newTokens: oldTokens,
      stepTokens: 0n,
      bchUsd,
      D_before,
      D_after: D_before,
    };
  }

  return {
    newTokens,
    stepTokens: step,
    bchUsd,
    D_before,
    D_after,
  };
}

export async function runRebalanceWithOracleV3() {
  console.log("========================================");
  console.log(" Rebalance MeanRevertSingleTokenNFTAuthV3 (good) ");
  console.log("========================================\n");
  console.log(`[network] NETWORK="${NETWORK}"\n`);

  if (!ORACLE_PUBLIC_KEY_HEX) {
    throw new Error(
      "ORACLE_PUBLIC_KEY_HEX env var not set. Example:\n" +
        '  ORACLE_PUBLIC_KEY_HEX="<gp_oracle_pubkey_hex>" node scripts/rebalanceWithOracleV3.js'
    );
  }

  const provider = new ElectrumNetworkProvider(NETWORK);
  const tmpl = new SignatureTemplate(alicePriv);

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
      TARGET_TOKENS, // IMPORTANT: same as deploy/fund/inspect
      nftCategoryBytes,
      nftCommitBytes,
      alicePkh,
    ],
    { provider }
  );

  console.log("V3 contract.address      :", contract.address);
  console.log("V3 contract.tokenAddress :", contract.tokenAddress);

  // --- 1) Find the contract portfolio UTXO ---
  const contractUtxos = await contract.getUtxos();
  if (!contractUtxos.length) {
    throw new Error(
      "No UTXOs found for the V3 contract. Run fundMeanRevertV3FromAlice.js first."
    );
  }

  const portfolioUtxo =
    contractUtxos.find(
      (u) => u.token && u.token.category === FT_CATEGORY_HEX
    ) || contractUtxos[0];

  console.log("\n[portfolio] Using contract UTXO:");
  console.log(safeJson(portfolioUtxo));

  const oldBch = utxoValueBigInt(portfolioUtxo);
  const currentTokens = BigInt(portfolioUtxo.token?.amount ?? 0n);

  if (currentTokens <= 0n) {
    throw new Error(
      "Contract portfolio UTXO has no fungible tokens in the stablecoin category."
    );
  }

  const oldTokens = currentTokens;

  // --- 2) Fetch live oracle price ---
  console.log("\n[oracle] Fetching latest BCH/USD oracle price...");
  const oracleSnap = await fetchLatestOraclePrice({
    publicKey: ORACLE_PUBLIC_KEY_HEX,
  });

  const oraclePriceRaw = BigInt(oracleSnap.priceRaw);

  console.log(
    `[oracle] oraclePubKey=${oracleSnap.oraclePubKey},` +
      ` priceRaw=${oracleSnap.priceRaw} (scale=${oracleSnap.priceScale}),` +
      ` price≈$${oracleSnap.priceValue.toFixed(2)}`
  );

  // --- 3) Choose mean-reverting token amount (withdraw direction only) ---
  const {
    newTokens,
    stepTokens: tokenDelta,
    bchUsd,
    D_before,
    D_after,
  } = chooseNewTokenAmountMeanRevert(oldBch, oldTokens, oraclePriceRaw);

  if (tokenDelta <= 0n) {
    console.log(
      "[math] Portfolio is already balanced at this precision, or wants to ADD tokens."
    );
    console.log(
      "[math] Withdraw-only demo will not perform a rebalance for this state."
    );
    return;
  }

  const newBch = oldBch; // BCH on contract stays fixed.

  console.log("\n[math] Off-chain imbalance check (mean-revert):");
  console.log(`  BCH(USD-ish) ≈ ${bchUsd.toString()}`);
  console.log(
    `  D_before = |BCH(USD-ish) - tokens| = ${D_before.toString()} (oldTokens=${oldTokens.toString()})`
  );
  console.log(
    `  D_after  = |BCH(USD-ish) - tokens| = ${D_after.toString()} (newTokens=${newTokens.toString()})`
  );
  console.log(
    `  tokenDelta (old - new) = ${tokenDelta.toString()} tokens will be withdrawn to Alice\n`
  );

  // Extra sanity: mirror contract condition.
  if (!(D_after < D_before)) {
    throw new Error(
      "Sanity failure: D_after must be strictly less than D_before for a 'good' rebalance."
    );
  }

  // --- 4) NFT authority UTXO at aliceTokenAddress ---
  const aliceTokenUtxos = await provider.getUtxos(aliceTokenAddress);
  const nftAuthorityUtxo = aliceTokenUtxos.find(
    (u) =>
      u.token &&
      u.token.category === NFT_CATEGORY_HEX &&
      BigInt(u.token.amount ?? 0n) === 0n &&
      u.token.nft?.commitment === REBALANCER_NFT_COMMITMENT_HEX
  );

  if (!nftAuthorityUtxo) {
    throw new Error(
      [
        "No suitable NFT authority UTXO found at aliceTokenAddress.",
        `Need category=${NFT_CATEGORY_HEX}, amount=0, commitment=${REBALANCER_NFT_COMMITMENT_HEX}.`,
        "Ensure mintAllForAlice.js was run and config.NFT_CATEGORY_HEX / REBALANCER_NFT_COMMITMENT_HEX match that mint.",
      ].join("\n")
    );
  }

  console.log("\n[authority] NFT UTXO:");
  console.log(safeJson(nftAuthorityUtxo));

  // --- 5) Alice BCH funding UTXO for fees ---
  const aliceUtxos = await provider.getUtxos(aliceAddress);
  const fundingBchOnly = aliceUtxos.filter((u) => !u.token);

  if (!fundingBchOnly.length) {
    throw new Error(
      "No BCH-only UTXOs at aliceAddress to pay for fees. Fund aliceAddress on chipnet."
    );
  }

  fundingBchOnly.sort((a, b) =>
    Number(utxoValueBigInt(b) - utxoValueBigInt(a))
  );
  const aliceFundingUtxo = fundingBchOnly[0];

  console.log("\n[funding] Alice BCH UTXO:");
  console.log(safeJson(aliceFundingUtxo));

  const totalInputBch =
    utxoValueBigInt(portfolioUtxo) +
    utxoValueBigInt(nftAuthorityUtxo) +
    utxoValueBigInt(aliceFundingUtxo);

  // --- 6) Build transaction (2-pass) ---
  console.log(
    "\n[pass1] Building provisional rebalance tx for fee estimate..."
  );

  const estBuilder = new TransactionBuilder({ provider });

  estBuilder.addInput(portfolioUtxo, contract.unlock.rebalance(oraclePriceRaw));
  estBuilder.addInput(nftAuthorityUtxo, tmpl.unlockP2PKH());
  estBuilder.addInput(aliceFundingUtxo, tmpl.unlockP2PKH());

  // Output 0: contract portfolio after rebalance (same BCH + newTokens)
  estBuilder.addOutput({
    to: contract.tokenAddress,
    amount: newBch,
    token: {
      category: FT_CATEGORY_HEX,
      amount: newTokens,
    },
  });

  // Output 1: tokens withdrawn to Alice (tokenDelta)
  estBuilder.addOutput({
    to: aliceTokenAddress,
    amount: DUST_THRESHOLD,
    token: {
      category: FT_CATEGORY_HEX,
      amount: tokenDelta,
    },
  });

  // Output 2: NFT back to Alice
  estBuilder.addOutput({
    to: aliceTokenAddress,
    amount: DUST_THRESHOLD,
    token: nftAuthorityUtxo.token,
  });

  // Output 3: BCH change back to Alice (provisional DUST_THRESHOLD)
  estBuilder.addOutput({
    to: aliceAddress,
    amount: DUST_THRESHOLD,
  });

  const provisionalHex = await estBuilder.build();
  const bytesEstimate = BigInt(provisionalHex.length / 2);
  const feeEstimate = bytesEstimate * SATS_PER_BYTE;

  console.log(
    `[pass1] Estimated size: ${bytesEstimate} bytes @ ${SATS_PER_BYTE} sat/byte → fee ≈ ${formatSats(
      feeEstimate
    )}`
  );

  const requiredMin =
    newBch +
    DUST_THRESHOLD + // tokenDelta output
    DUST_THRESHOLD + // NFT output
    DUST_THRESHOLD + // BCH change
    feeEstimate;

  if (totalInputBch < requiredMin) {
    throw new Error(
      [
        "[rebalance] Insufficient BCH backing for portfolio + fee plan.",
        `  totalInputBch: ${formatSats(totalInputBch)}`,
        `  requiredMin  : ${formatSats(requiredMin)}`,
      ].join("\n")
    );
  }

  const finalBchChange =
    totalInputBch -
    newBch -
    DUST_THRESHOLD - // tokenDelta
    DUST_THRESHOLD - // NFT output
    feeEstimate;

  if (finalBchChange < DUST_THRESHOLD) {
    throw new Error(
      [
        "[rebalance] BCH change would be below dust after fee.",
        `  finalBchChange: ${formatSats(finalBchChange)}`,
        `  DUST_THRESHOLD: ${formatSats(DUST_THRESHOLD)}`,
      ].join("\n")
    );
  }

  console.log(
    `[pass1] Expected BCH change back to Alice: ${formatSats(finalBchChange)}`
  );

  // --- PASS 2: final rebalance transaction ---
  console.log("\n[pass2] Building FINAL rebalance tx...");

  const txb = new TransactionBuilder({ provider });

  txb.addInput(portfolioUtxo, contract.unlock.rebalance(oraclePriceRaw));
  txb.addInput(nftAuthorityUtxo, tmpl.unlockP2PKH());
  txb.addInput(aliceFundingUtxo, tmpl.unlockP2PKH());

  // Contract portfolio after rebalance
  txb.addOutput({
    to: contract.tokenAddress,
    amount: newBch,
    token: {
      category: FT_CATEGORY_HEX,
      amount: newTokens,
    },
  });

  // Token withdrawal to Alice
  txb.addOutput({
    to: aliceTokenAddress,
    amount: DUST_THRESHOLD,
    token: {
      category: FT_CATEGORY_HEX,
      amount: tokenDelta,
    },
  });

  // NFT back to Alice
  txb.addOutput({
    to: aliceTokenAddress,
    amount: DUST_THRESHOLD,
    token: nftAuthorityUtxo.token,
  });

  // BCH change to Alice
  txb.addOutput({
    to: aliceAddress,
    amount: finalBchChange,
  });

  const txDetails = await txb.send();
  console.log("\n[rebalance] Broadcast txid:", txDetails.txid);
  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const actualFee =
      totalInputBch - newBch - DUST_THRESHOLD - DUST_THRESHOLD - finalBchChange;
    console.log(
      `[rebalance] Final size: ${finalBytes.toString()} bytes, actual fee ≈ ${formatSats(
        actualFee
      )}`
    );
  }

  console.log(
    "\nTip: run scripts/inspectMeanRevertV3State.js again to see the updated portfolio."
  );
}

// --- CLI runner ---
if (import.meta.url === `file://${process.argv[1]}`) {
  runRebalanceWithOracleV3().catch((err) => {
    console.error("Error in rebalanceWithOracleV3 script:", err);
    process.exit(1);
  });
}
