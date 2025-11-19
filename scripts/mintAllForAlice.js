// scripts/mintAllForAlice.js
//
// FINAL CLEAN VERSION (MODULED)
// ---------------------------------------------------------
// - No artificial genesis txs
// - Uses INPUT[0] as FT category
// - Uses INPUT[1] as NFT category
// - Mints both FT + NFT in ONE atomic transaction
// - Each token output backed by EXACTLY 1000 sats
// - Change returns all remaining BCH to aliceAddress
// - Fee rate: SATS_PER_BYTE (1 sat/byte) from config.js
// - Dust limit respected via DUST_THRESHOLD
// ---------------------------------------------------------

import {
  TransactionBuilder,
  SignatureTemplate,
  ElectrumNetworkProvider,
} from "cashscript";

import { alicePriv, aliceAddress, aliceTokenAddress } from "../common.js";
import { NETWORK, SATS_PER_BYTE, DUST_THRESHOLD } from "../config.js";
import { splitByToken } from "../utxos.js";

const utxoValue = (u) => BigInt(u.satoshis ?? u.value);

const safeJson = (o) =>
  JSON.stringify(
    o,
    (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v),
    2
  );

function logInputs(label, ins) {
  console.log(`\n--- ${label} INPUTS ---`);
  ins.forEach((u, i) => {
    console.log(
      ` [${i}] txid=${u.txid} vout=${u.vout} sats=${utxoValue(u)} token=${
        u.token ? safeJson(u.token) : "none"
      }`
    );
  });
}

function logOutputs(label, outs) {
  console.log(`\n--- ${label} OUTPUTS ---`);
  outs.forEach((o, i) => {
    console.log(
      ` [${i}]`,
      safeJson({
        ...o,
        amount: o.amount?.toString(),
        token: o.token
          ? { ...o.token, amount: o.token.amount?.toString() }
          : undefined,
      })
    );
  });
}

function logFundingSummary(bchOnly) {
  const total = bchOnly.reduce((s, u) => s + utxoValue(u), 0n);
  console.log("\n=== Alice BCH-only funding UTXOs ===");
  console.log(`Count: ${bchOnly.length}`);
  console.log(`Total BCH: ${total.toString()} sats`);
}

/**
 * Run the FT+NFT atomic mint for Alice.
 *
 * - consumes all BCH-only UTXOs from aliceAddress
 * - uses the 2 largest UTXOs as FT/NFT genesis categories
 * - mints:
 *    * FT: 1000 tokens in FT_GENESIS.txid
 *    * NFT: pure NFT in NFT_GENESIS.txid with commitment "6e667430"
 * - sends both tokens to aliceTokenAddress
 */
export async function runMintAllForAlice() {
  console.log("============================================");
  console.log("  CLEAN FT + NFT ATOMIC MINT (ONE PASS)");
  console.log("============================================\n");
  console.log(`[network] Using NETWORK="${NETWORK}"\n`);

  const provider = new ElectrumNetworkProvider(NETWORK);

  const all = await provider.getUtxos(aliceAddress);
  let { bchOnly, withTokens } = splitByToken(all);

  console.log("\n=== Raw Alice UTXOs (P2PKH address) ===");
  console.log(`Total UTXOs: ${all.length}`);
  console.log(`  BCH-only:   ${bchOnly.length}`);
  console.log(`  WithTokens: ${withTokens.length}`);
  logFundingSummary(bchOnly);

  if (bchOnly.length < 2)
    throw new Error(
      "Need at least TWO BCH-only UTXOs to mint FT and NFT.\n" +
        "Hint: fund aliceAddress (P2PKH) with more BCH on chipnet."
    );

  // sort largest-first
  bchOnly.sort((a, b) => Number(utxoValue(b) - utxoValue(a)));

  const FT_GENESIS = bchOnly[0];
  const NFT_GENESIS = bchOnly[1];

  console.log("\nUsing genesis inputs (largest-first):");
  console.log("FT (fungible category source):", safeJson(FT_GENESIS));
  console.log("NFT (NFT category source):", safeJson(NFT_GENESIS));

  const tmpl = new SignatureTemplate(alicePriv);

  // PASS 1 – fee estimate
  console.log("\n[pass1] Building provisional transaction to estimate fee...");

  const est = new TransactionBuilder({ provider });

  bchOnly.forEach((u) => est.addInput(u, tmpl.unlockP2PKH()));

  const FT_BACK = 1000n;
  const NFT_BACK = 1000n;

  const provisional = [
    {
      to: aliceTokenAddress,
      amount: FT_BACK,
      token: { category: FT_GENESIS.txid, amount: 1000n },
    },
    {
      to: aliceTokenAddress,
      amount: NFT_BACK,
      token: {
        category: NFT_GENESIS.txid,
        amount: 0n, // pure NFT
        nft: { capability: "none", commitment: "6e667430" },
      },
    },
    { to: aliceAddress, amount: DUST_THRESHOLD },
  ];

  provisional.forEach((o) => est.addOutput(o));

  const hex = await est.build();
  const txBytes = BigInt(hex.length / 2);
  const fee = txBytes * SATS_PER_BYTE;

  console.log(
    `[pass1] Provisional tx size: ${txBytes} bytes @ ${SATS_PER_BYTE} sat/byte → fee = ${fee} sats`
  );

  const totalIn = bchOnly.reduce((s, u) => s + utxoValue(u), 0n);
  const required = FT_BACK + NFT_BACK + fee + DUST_THRESHOLD;

  console.log(
    `[pass1] Total input value:            ${totalIn.toString()} sats`
  );
  console.log(
    `[pass1] Required (FT+NFT+fee+dust): ${required.toString()} sats`
  );

  if (totalIn < required)
    throw new Error(
      `[mint] insufficient funds.\n` +
        `  need = ${required.toString()} sats\n` +
        `  have = ${totalIn.toString()} sats\n` +
        `Hint: fund aliceAddress with more BCH.`
    );

  const change = totalIn - FT_BACK - NFT_BACK - fee;
  const includeChange = change >= DUST_THRESHOLD;

  console.log(`[pass1] Change candidate: ${change.toString()} sats`);
  console.log(
    `[pass1] Change >= DUST_THRESHOLD (${DUST_THRESHOLD} sats)? ${includeChange}`
  );

  // PASS 2 – final tx
  console.log("\n[pass2] Building FINAL transaction...");

  const txb = new TransactionBuilder({ provider });
  bchOnly.forEach((u) => txb.addInput(u, tmpl.unlockP2PKH()));

  const outputs = [
    {
      to: aliceTokenAddress,
      amount: FT_BACK,
      token: { category: FT_GENESIS.txid, amount: 1000n },
    },
    {
      to: aliceTokenAddress,
      amount: NFT_BACK,
      token: {
        category: NFT_GENESIS.txid,
        amount: 0n,
        nft: { capability: "none", commitment: "6e667430" },
      },
    },
  ];

  if (includeChange) {
    outputs.push({ to: aliceAddress, amount: change });
  } else {
    console.log(
      "[pass2] Skipping change output because it would be below dust."
    );
  }

  outputs.forEach((o) => txb.addOutput(o));

  logInputs("FINAL", bchOnly);
  logOutputs("FINAL", outputs);

  const tx = await txb.send();

  console.log("\nMINT TXID:", tx.txid);
  console.log(
    "\nTip: the FT category is FT_GENESIS.txid; NFT category is NFT_GENESIS.txid."
  );
  console.log("Use these when wiring up covenant contracts.\n");
  console.log("=== DONE ===\n");
}
