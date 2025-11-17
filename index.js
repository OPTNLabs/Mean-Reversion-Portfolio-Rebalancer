// index.js
import {
  Contract,
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
} from "cashscript";
import { compileFile } from "cashc";
import { aliceAddress, alicePriv } from "./common.js";

// ────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────

const NETWORK = "chipnet";
const MIN_TOTAL_SATS = 15000n;
const FUNDING_AMOUNT = 20000n;
const SATS_PER_BYTE = 1n;

// ────────────────────────────────────────────────
// UTXO Helpers
// ────────────────────────────────────────────────

/**
 * Split UTXOs into BCH-only vs token UTXOs.
 */
function splitByToken(utxos) {
  const bchOnly = [];
  const withTokens = [];
  for (const u of utxos) {
    if (u.token) withTokens.push(u);
    else bchOnly.push(u);
  }
  return { bchOnly, withTokens };
}

/**
 * Group token UTXOs by category for display.
 */
function groupTokenUtxosByCategory(tokenUtxos) {
  const map = new Map();
  for (const u of tokenUtxos) {
    const cat = u.token.category;
    const arr = map.get(cat) ?? [];
    arr.push(u);
    map.set(cat, arr);
  }
  return map;
}

/**
 * Pretty-print a summary for any UTXO set.
 */
function logUtxoSummary(label, utxos) {
  console.log(`\n=== ${label} UTXOs ===`);
  console.log(`Total UTXOs: ${utxos.length}`);

  if (utxos.length === 0) {
    console.log("(none)\n");
    return;
  }

  const { bchOnly, withTokens } = splitByToken(utxos);
  const totalBch = bchOnly.reduce((sum, u) => sum + u.satoshis, 0n);

  console.log(`BCH-only UTXOs: ${bchOnly.length}`);
  console.log(`  Total BCH: ${totalBch} sats`);

  if (withTokens.length > 0) {
    console.log(`Token UTXOs: ${withTokens.length}`);
    const grouped = groupTokenUtxosByCategory(withTokens);
    for (const [cat, arr] of grouped.entries()) {
      const tokenTotal = arr.reduce((s, u) => s + u.token.amount, 0n);
      const satTotal = arr.reduce((s, u) => s + u.satoshis, 0n);
      console.log(
        `  - category ${cat}: ${arr.length} utxos, ${tokenTotal} tokens, backing ${satTotal} sats`
      );
    }
  }

  console.log("");
}

/**
 * Pick a BCH-only UTXO that has >= required sats.
 */
function selectFundingUtxo(bchOnly, required) {
  const sorted = [...bchOnly].sort((a, b) =>
    a.satoshis > b.satoshis ? -1 : 1
  );
  return sorted.find((u) => u.satoshis >= required) ?? null;
}

// ────────────────────────────────────────────────
// Fee-aware Funding Helper (Alice → Contract)
// 1 sat/byte, two-pass build
// ────────────────────────────────────────────────

async function fundContractWithBch({
  provider,
  contract,
  amount,
  satsPerByte,
  fromAddress,
  fromPriv,
}) {
  // 1) Fetch and classify Alice UTXOs
  const utxos = await provider.getUtxos(fromAddress);
  logUtxoSummary("Alice (current)", utxos);

  const { bchOnly } = splitByToken(utxos);
  if (bchOnly.length === 0) throw new Error("Alice has no BCH UTXOs");

  // For now: single-input funding
  const fundingUtxo = bchOnly[0];
  const inputValue = fundingUtxo.satoshis;

  if (inputValue <= amount) {
    throw new Error(
      `Funding UTXO too small: input=${inputValue} <= amount=${amount}`
    );
  }

  console.log("Selected funding UTXO:", fundingUtxo);

  const aliceTemplate = new SignatureTemplate(fromPriv);

  // ─────────────────────────────────────────────
  // PASS 1: build provisional tx to measure bytes
  // ─────────────────────────────────────────────

  const provisionalChange = inputValue - amount; // assume fee=0
  if (provisionalChange <= 0n) {
    throw new Error("Funding UTXO too small for even amount alone.");
  }

  const provisionalBuilder = new TransactionBuilder({ provider });

  provisionalBuilder.addInput(fundingUtxo, aliceTemplate.unlockP2PKH());
  provisionalBuilder.addOutput({
    to: contract.address,
    amount,
  });
  provisionalBuilder.addOutput({
    to: fromAddress,
    amount: provisionalChange,
  });

  // Build but do NOT broadcast
  const provisionalHex = await provisionalBuilder.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const desiredFee = byteLength * satsPerByte;

  console.log(
    `Provisional size: ${byteLength} bytes → desired fee = ${desiredFee} sats`
  );

  // ─────────────────────────────────────────────
  // PASS 2: build FINAL tx with correct fee & change
  // ─────────────────────────────────────────────

  const realChange = inputValue - amount - desiredFee;
  const DUST = 546n;

  const includeChange = realChange >= DUST;

  console.log(
    `Final change = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const finalBuilder = new TransactionBuilder({ provider });

  finalBuilder.addInput(fundingUtxo, aliceTemplate.unlockP2PKH());
  finalBuilder.addOutput({ to: contract.address, amount });

  if (includeChange) {
    finalBuilder.addOutput({
      to: fromAddress,
      amount: realChange,
    });
  }

  // Broadcast
  const txDetails = await finalBuilder.send();
  console.log("\nFunding tx broadcast (fee=1 sat/byte):", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const actualFee = inputValue - (amount + (includeChange ? realChange : 0n));

    console.log(
      `Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  return txDetails;
}

// ────────────────────────────────────────────────
// main()
// ────────────────────────────────────────────────

async function main() {
  // 1. Compile contract
  const artifact = compileFile(
    new URL("./contracts/SumInputs.cash", import.meta.url)
  );

  // 2. Provider + contract instance
  const provider = new ElectrumNetworkProvider(NETWORK);
  const contract = new Contract(artifact, [MIN_TOTAL_SATS], { provider });

  console.log("SumInputs contract address:", contract.address);
  console.log("SumInputs token address  :", contract.tokenAddress);
  console.log("Contract bytesize        :", contract.bytesize);
  console.log("Contract opcount         :", contract.opcount);

  // 3. Show Alice + contract UTXOs before anything
  const aliceUtxos = await provider.getUtxos(aliceAddress);
  logUtxoSummary("Alice (initial)", aliceUtxos);

  const before = await contract.getUtxos();
  logUtxoSummary("Contract (before funding)", before);

  // 4. Fund contract using 1 sat/byte fee estimation
  await fundContractWithBch({
    provider,
    contract,
    amount: FUNDING_AMOUNT,
    satsPerByte: SATS_PER_BYTE,
    fromAddress: aliceAddress,
    fromPriv: alicePriv,
  });

  // 5. Show contract utxos after funding
  const after = await contract.getUtxos();
  logUtxoSummary("Contract (after funding)", after);
}

// Run
main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
