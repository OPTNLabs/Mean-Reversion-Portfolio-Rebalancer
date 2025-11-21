// scripts/meanRevert.oracleRebalancer.js
//
// Oracle-aware rebalancer demo for MeanRevertSingleTokenNFTAuthV2.cash.
//
// This script:
//   1. Fetches the latest BCH/USD price from General Protocols' oracle.
//   2. Sets up a mock environment with:
//        - MeanRevertSingleTokenNFTAuthV2 contract
//        - FT UTXOs representing the portfolio token
//        - NFT authority UTXO for the rebalancer
//        - Alice's BCH funding UTXO
//   3. Builds a rebalance transaction that moves the contract FT position
//      *closer to* its target, respecting the contract's mean-reversion rule.
//
// NOTE:
//   - This is a **mocknet/off-chain** strategy demo. It doesn't broadcast to
//     a real network. It mirrors the structure of your V2 tests but driven
//     by live oracle data.
//   - The contract itself stays "dumb": it only enforces that the new FT
//     position is at least as close to target as the old one. The oracle &
//     strategy logic live purely off-chain here.

import {
  MockNetworkProvider,
  Contract,
  TransactionBuilder,
  SignatureTemplate,
  randomUtxo,
} from "cashscript";
import { compileFile } from "cashc";

import {
  alicePriv,
  alicePkh,
  aliceTokenAddress,
  aliceAddress,
} from "../common.js";

import { fetchLatestOraclePrice } from "../oracles/fetchOraclePrice.js";

// Same constant as in tests
const DUST_LIMIT = 546n;
const TOKEN_OUTPUT_SATS = 1000n;

// General Protocols BCH/USD oracle public key
const ORACLE_PUBKEY =
  "02d09db08af1ff4e8453919cc866a4be427d7bfe18f2c05e5444c196fcf6fd2818";

// Target FT position baked into the contract
const TARGET_TOKENS = 1000n;

// How many tokens Alice is willing to supply/absorb in this demo step.
const STEP_TOKENS = 200n;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Convert a big-endian txid hex string (explorer/UI style) to VM-order hex
// (little-endian, as used in the CashToken category inside the VM).
function txidToVmOrderHex(txidHex) {
  return txidHex.match(/../g).reverse().join("");
}

function assertPureBch(utxo, label = "BCH UTXO") {
  if (!utxo) throw new Error(`${label} must exist`);
  if (utxo.satoshis < DUST_LIMIT) {
    throw new Error(`${label} must have dust sats (>= ${DUST_LIMIT})`);
  }
  if (utxo.token !== undefined) {
    throw new Error(`${label} must NOT have token field`);
  }
}

function createContractFtUtxo(contract, provider, categoryVmHex, amount) {
  const utxo = { ...randomUtxo() };
  utxo.satoshis = 2_000n;

  utxo.token = {
    category: categoryVmHex,
    amount,
  };

  provider.addUtxo(contract.tokenAddress, utxo);
  return utxo;
}

function createNftAuthorityUtxo(provider, categoryVmHex, commitmentHex) {
  const utxo = { ...randomUtxo() };
  utxo.satoshis = 2_000n;

  utxo.token = {
    category: categoryVmHex,
    amount: 0n,
    nft: {
      capability: "none",
      commitment: commitmentHex,
    },
  };

  provider.addUtxo(aliceTokenAddress, utxo);
  return utxo;
}

function createAliceFundingUtxo(provider, sats = 4_000n) {
  const utxo = randomUtxo();
  utxo.satoshis = sats;
  utxo.token = undefined;
  assertPureBch(utxo, "Alice BCH funding");
  provider.addUtxo(aliceAddress, utxo);
  return utxo;
}

// Very simple "policy": decide the new contract token position given
//   - old position
//   - target
//   - latest oracle price
//
// For now, we:
//
//   * ALWAYS move the contract *directly to target* in one step,
//     which is guaranteed to satisfy the contract's mean-reversion rule.
//   * Use the oracle price only for logging & future strategy hooks.
//
// This keeps the contract "dumb" while making the script oracle-aware.
function computeNewContractTokens({ oldTokens, targetTokens, priceValue }) {
  console.log(
    `\n[policy] Current contract tokens = ${oldTokens} | target = ${targetTokens}`
  );
  console.log(
    `[policy] Latest oracle price  = ${priceValue.toFixed(
      2
    )} (e.g. USD per BCH)`
  );

  if (oldTokens === targetTokens) {
    console.log("[policy] Already at target – no rebalance needed.");
    return oldTokens;
  }

  // In future, you might:
  //   - scale step size by volatility
  //   - use multiple assets & price ratios
  //   - implement bands / thresholds
  //
  // For now, we just "snap" to target in one go.
  console.log("[policy] Demo policy: move directly to target in one step.");
  return targetTokens;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main() {
  console.log("=== Oracle-aware rebalancer (mocknet demo) ===");

  // 1) Fetch latest oracle price
  const oracleSnapshot = await fetchLatestOraclePrice({
    publicKey: ORACLE_PUBKEY,
  });

  console.log("\n--- Oracle snapshot ---");
  console.log(`Oracle pubkey : ${oracleSnapshot.oraclePubKey}`);
  console.log(`Message seq   : ${oracleSnapshot.messageSequence}`);
  console.log(`Data seq      : ${oracleSnapshot.dataSequence}`);
  console.log(
    `Timestamp     : ${oracleSnapshot.timestamp} (${new Date(
      oracleSnapshot.timestamp * 1000
    ).toISOString()})`
  );
  console.log(
    `Raw price     : ${oracleSnapshot.priceRaw} (scaled by x${oracleSnapshot.priceScale})`
  );
  console.log(
    `Price         : ${oracleSnapshot.priceValue} (e.g. USD per BCH)`
  );

  // 2) Set up mock contract environment (like tests, but in a script)
  console.log("\n--- Setting up mock contract environment ---");

  const provider = new MockNetworkProvider();

  // Local FT/NFT "genesis" UTXOs (mock-only; no real genesis)
  const ftGenesisUtxo = randomUtxo();
  const nftGenesisUtxo = randomUtxo();

  const FT_CATEGORY_BE = ftGenesisUtxo.txid;
  const NFT_CATEGORY_BE = nftGenesisUtxo.txid;

  const FT_CATEGORY_VM = txidToVmOrderHex(FT_CATEGORY_BE);
  const NFT_CATEGORY_VM = txidToVmOrderHex(NFT_CATEGORY_BE);

  const FT_CATEGORY_BYTES = `0x${FT_CATEGORY_VM}`;
  const NFT_CATEGORY_BYTES = `0x${NFT_CATEGORY_VM}`;

  const NFT_COMMIT_RAW = "6e667430"; // "nft0"
  const NFT_COMMIT_BYTES = `0x${NFT_COMMIT_RAW}`;

  const artifactV2 = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuthV2.cash", import.meta.url)
  );

  const contract = new Contract(
    artifactV2,
    [
      FT_CATEGORY_BYTES, // tokenCategory (VM-order)
      TARGET_TOKENS,
      NFT_CATEGORY_BYTES, // rebalancerNftCat (reserved)
      NFT_COMMIT_BYTES,
      alicePkh,
    ],
    { provider }
  );

  console.log(`Contract address      : ${contract.address}`);
  console.log(`Contract token address: ${contract.tokenAddress}`);

  // 3) Seed mock UTXOs

  // Start below target: contract initially holds 800 tokens.
  const initialContractTokens = TARGET_TOKENS - STEP_TOKENS; // 1000 - 200 = 800
  const extraTokensFromAlice = STEP_TOKENS; // 200

  console.log(
    `\nInitial contract tokens: ${initialContractTokens} (target = ${TARGET_TOKENS})`
  );

  const contractFtUtxo = createContractFtUtxo(
    contract,
    provider,
    FT_CATEGORY_VM,
    initialContractTokens
  );

  // Alice FT UTXO supplying extra tokens
  const aliceFtUtxo = { ...randomUtxo() };
  aliceFtUtxo.satoshis = 2_000n;
  aliceFtUtxo.token = {
    category: FT_CATEGORY_VM,
    amount: extraTokensFromAlice,
  };
  provider.addUtxo(aliceTokenAddress, aliceFtUtxo);

  // NFT authority UTXO
  const nftAuthorityUtxo = createNftAuthorityUtxo(
    provider,
    NFT_CATEGORY_VM,
    NFT_COMMIT_RAW
  );

  // Alice BCH funding UTXO
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const aliceTemplate = new SignatureTemplate(alicePriv);

  // 4) Decide new contract FT position using oracle-aware policy
  const newContractTokens = computeNewContractTokens({
    oldTokens: initialContractTokens,
    targetTokens: TARGET_TOKENS,
    priceValue: oracleSnapshot.priceValue,
  });

  if (newContractTokens === initialContractTokens) {
    console.log("\nNo rebalance transaction built (already at policy target).");
    return;
  }

  console.log(
    `\nRebalancing: contract tokens ${initialContractTokens} -> ${newContractTokens}`
  );

  // 5) Build rebalance transaction (mocknet, not broadcast)
  //
  // Inputs:
  //   - contract: initialContractTokens (e.g. 800) tokens
  //   - Alice:    extraTokensFromAlice (e.g. 200) tokens
  //   - NFT:      authority for rebalancing
  //   - BCH:      Alice funding for fees
  //
  // Outputs:
  //   - contract: newContractTokens (e.g. 1000)
  //   - Alice:    NFT back
  //   - Alice:    BCH (with remainder as fee)
  const txBuilder = new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance())
    .addInput(aliceFtUtxo, aliceTemplate.unlockP2PKH())
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())
    .addOutput({
      to: contract.tokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: FT_CATEGORY_VM,
        amount: newContractTokens,
      },
    })
    .addOutput({
      to: aliceTokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: nftAuthorityUtxo.token,
    })
    .addOutput({
      to: aliceAddress,
      amount:
        contractFtUtxo.satoshis +
        aliceFtUtxo.satoshis +
        nftAuthorityUtxo.satoshis +
        aliceFundingUtxo.satoshis -
        3_000n, // rough fee
    });

  // Use build() to get the raw signed transaction hex
  const rawTxHex = txBuilder.build();

  // Optionally still "send" on the MockNetworkProvider so balances/UTXOs update
  const txDetails = await txBuilder.send();

  console.log("\n--- Rebalance transaction (mocknet) ---");
  console.log("TXID          :", txDetails.txid);
  console.log("New token amt :", newContractTokens);
  console.log("Raw tx hex    :", rawTxHex);

  console.log("\nDone.");
}

// Run if executed as a script
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Error in oracle rebalancer script:", err);
    process.exit(1);
  });
}
