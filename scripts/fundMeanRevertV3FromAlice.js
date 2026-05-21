// scripts/fundMeanRevertV3FromAlice.js
//
// Fund the V3 contract on CHIPNET with:
//   - BCH portfolio value (PORTFOLIO_BCH)
//   - INITIAL_TOKENS_ON_CONTRACT fungible tokens
//
// Sources:
//   - FT UTXO at aliceTokenAddress (from mintAllForAlice.js)
//   - BCH-only UTXO at aliceAddress (for BCH backing + fees)
//
// Result:
//   - Contract gets: PORTFOLIO_BCH BCH + INITIAL_TOKENS_ON_CONTRACT FT
//   - Alice gets: FT change (if any) + BCH change.

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
  INITIAL_TOKENS_ON_CONTRACT,
  SATS_PER_BYTE,
  DUST_THRESHOLD,
} from "../config.js";
import {
  alicePriv,
  aliceAddress,
  aliceTokenAddress,
  alicePkh,
} from "../common.js";
import { splitByToken } from "../utxos.js";
import { formatSats, safeJson } from "../bigint.js";

// 1 BCH as default backing for a nice intuitive demo.
const PORTFOLIO_BCH = 1_000_000n;

// Helper: big-endian txid hex -> VM-order bytes literal.
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

export async function runFundMeanRevertV3FromAlice() {
  console.log("========================================");
  console.log(" Fund MeanRevertSingleTokenNFTAuthV3   ");
  console.log("========================================\n");
  console.log(`[network] NETWORK="${NETWORK}"\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);
  const tmpl = new SignatureTemplate(alicePriv);

  // --- Reconstruct the same contract instance as deployMeanRevertV3 ---
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
      TARGET_TOKENS, // IMPORTANT: same as deploy + inspect + rebalance
      nftCategoryBytes,
      nftCommitBytes,
      alicePkh,
    ],
    { provider }
  );

  console.log("V3 contract.address      :", contract.address);
  console.log("V3 contract.tokenAddress :", contract.tokenAddress);
  console.log("");

  // --- 1) Find Alice's FT UTXO for the portfolio token ---
  console.log("Fetching UTXOs for aliceTokenAddress:", aliceTokenAddress);
  const aliceTokenUtxos = await provider.getUtxos(aliceTokenAddress);
  const { bchOnly: tokenBchOnly, withTokens: tokenWithTokens } =
    splitByToken(aliceTokenUtxos);

  console.log(
    `  - BCH-only:   ${tokenBchOnly.length}\n  - Token-bearing: ${tokenWithTokens.length}`
  );

  const ftUtxo = tokenWithTokens.find(
    (u) =>
      u.token?.category === FT_CATEGORY_HEX &&
      BigInt(u.token.amount) >= INITIAL_TOKENS_ON_CONTRACT
  );

  if (!ftUtxo) {
    throw new Error(
      [
        "No suitable FT UTXO found at aliceTokenAddress.",
        `Need category=${FT_CATEGORY_HEX} with amount >= ${INITIAL_TOKENS_ON_CONTRACT.toString()}.`,
        "Run mintAllForAlice.js and confirm config.FT_CATEGORY_HEX matches the FT genesis txid.",
      ].join("\n")
    );
  }

  console.log("\n[chosen] Portfolio FT UTXO:");
  console.log(safeJson(ftUtxo));

  const ftAmount = BigInt(ftUtxo.token.amount);
  const ftChangeTokens = ftAmount - INITIAL_TOKENS_ON_CONTRACT;

  // --- 2) Find a BCH-only funding UTXO at aliceAddress ---
  console.log("\nFetching UTXOs for aliceAddress:", aliceAddress);
  const aliceUtxos = await provider.getUtxos(aliceAddress);
  const { bchOnly: fundingBchOnly } = splitByToken(aliceUtxos);

  if (!fundingBchOnly.length) {
    throw new Error(
      "No BCH-only UTXOs at aliceAddress. Fund aliceAddress on chipnet first."
    );
  }

  // Pick the largest BCH-only UTXO as funding.
  fundingBchOnly.sort((a, b) =>
    Number(utxoValueBigInt(b) - utxoValueBigInt(a))
  );
  const fundingUtxo = fundingBchOnly[0];

  console.log("\n[chosen] BCH funding UTXO:");
  console.log(safeJson(fundingUtxo));

  const totalInputBch = utxoValueBigInt(ftUtxo) + utxoValueBigInt(fundingUtxo);

  console.log(`\n[inputs] total BCH from inputs: ${formatSats(totalInputBch)}`);
  console.log(
    `[plan] contract portfolio: ${formatSats(
      PORTFOLIO_BCH
    )} + ${INITIAL_TOKENS_ON_CONTRACT.toString()} tokens`
  );
  console.log(
    `[plan] FT change back to Alice: ${ftChangeTokens.toString()} tokens\n`
  );

  // --- PASS 1: provisional tx for fee estimate ---
  console.log("[pass1] Building provisional funding tx for fee estimate...");

  const estBuilder = new TransactionBuilder({ provider });

  estBuilder.addInput(ftUtxo, tmpl.unlockP2PKH());
  estBuilder.addInput(fundingUtxo, tmpl.unlockP2PKH());

  // Output 0: contract portfolio UTXO
  estBuilder.addOutput({
    to: contract.tokenAddress,
    amount: PORTFOLIO_BCH,
    token: {
      category: FT_CATEGORY_HEX,
      amount: INITIAL_TOKENS_ON_CONTRACT,
    },
  });

  // Output 1: FT token change back to Alice
  if (ftChangeTokens > 0n) {
    estBuilder.addOutput({
      to: aliceTokenAddress,
      amount: DUST_THRESHOLD, // sats backing for token change
      token: {
        category: FT_CATEGORY_HEX,
        amount: ftChangeTokens,
      },
    });
  }

  // Output 2: BCH change back to Alice (provisional DUST_THRESHOLD for fee calc)
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
    PORTFOLIO_BCH +
    (ftChangeTokens > 0n ? DUST_THRESHOLD : 0n) +
    DUST_THRESHOLD +
    feeEstimate;

  if (totalInputBch < requiredMin) {
    throw new Error(
      [
        "[fund] Insufficient BCH to fund portfolio + fees.",
        `  totalInputBch:   ${formatSats(totalInputBch)}`,
        `  required minimum: ${formatSats(requiredMin)}`,
      ].join("\n")
    );
  }

  const finalBchChange =
    totalInputBch -
    PORTFOLIO_BCH -
    (ftChangeTokens > 0n ? DUST_THRESHOLD : 0n) -
    feeEstimate;

  if (finalBchChange < DUST_THRESHOLD) {
    throw new Error(
      [
        "[fund] BCH change would fall below dust after fees.",
        `  finalBchChange: ${formatSats(finalBchChange)}`,
        `  DUST_THRESHOLD: ${formatSats(DUST_THRESHOLD)}`,
      ].join("\n")
    );
  }

  console.log(
    `[pass1] Expected BCH change back to Alice: ${formatSats(finalBchChange)}`
  );

  // --- PASS 2: final funding transaction ---
  console.log("\n[pass2] Building FINAL funding tx...");

  const txb = new TransactionBuilder({ provider });
  txb.addInput(ftUtxo, tmpl.unlockP2PKH());
  txb.addInput(fundingUtxo, tmpl.unlockP2PKH());

  // Contract portfolio output
  txb.addOutput({
    to: contract.tokenAddress,
    amount: PORTFOLIO_BCH,
    token: {
      category: FT_CATEGORY_HEX,
      amount: INITIAL_TOKENS_ON_CONTRACT,
    },
  });

  // FT change
  if (ftChangeTokens > 0n) {
    txb.addOutput({
      to: aliceTokenAddress,
      amount: DUST_THRESHOLD,
      token: {
        category: FT_CATEGORY_HEX,
        amount: ftChangeTokens,
      },
    });
  }

  // BCH change
  txb.addOutput({
    to: aliceAddress,
    amount: finalBchChange,
  });

  const txDetails = await txb.send();

  console.log("\n[fund] Broadcast txid:", txDetails.txid);
  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const actualFee =
      totalInputBch -
      PORTFOLIO_BCH -
      (ftChangeTokens > 0n ? DUST_THRESHOLD : 0n) -
      finalBchChange;
    console.log(
      `[fund] Final size: ${finalBytes.toString()} bytes, actual fee ≈ ${formatSats(
        actualFee
      )}`
    );
  }

  console.log(
    "\nTip: run scripts/inspectMeanRevertV3State.js to verify the contract portfolio."
  );
}

// --- CLI runner ---
if (import.meta.url === `file://${process.argv[1]}`) {
  runFundMeanRevertV3FromAlice().catch((err) => {
    console.error("Error in fundMeanRevertV3FromAlice script:", err);
    process.exit(1);
  });
}
