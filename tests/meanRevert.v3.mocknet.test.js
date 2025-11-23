// tests/meanRevert.v3.mocknet.test.js
//
// Behavioural tests for MeanRevertSingleTokenNFTAuthV3.cash
// – mirrors the style of the V2 mocknet tests, but uses value-based
//   mean reversion (BCH vs FT in USD terms).

import test from "node:test";
import assert from "node:assert/strict";

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

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const DUST_LIMIT = 546n;
const TOKEN_OUTPUT_SATS = 1_000n;

// These MUST match the contract + math-only tests:
//   bchScaled     = bchSats / 10_000
//   bchValueUsd   = (bchScaled * oraclePriceRaw) / 10_000 / 100
//
// Where:
//   - oraclePriceRaw = BCH/USD * 100 (e.g. 100.00 USD/BCH -> 10_000)
//   - tokens represent whole USD units.
const BCH_SCALE_DOWN = 10_000n;
const PRICE_SCALE = 100n;
const ORACLE_PRICE_RAW = 10_000n; // 100.00 USD/BCH (scale=100)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Convert big-endian txid hex (explorer form) -> VM-order (little-endian).
function txidToVmOrderHex(txidHex) {
  return txidHex.match(/../g).reverse().join("");
}

// Local FT/NFT genesis just for this file.
const ftGenesisUtxo = randomUtxo();
const nftGenesisUtxo = randomUtxo();

// Extra FT category for testing "ignore non-stablecoin tokens".
const foreignFtGenesisUtxo = randomUtxo();

// Big-endian categories (as UIs would show them)
const FT_CATEGORY_BE = ftGenesisUtxo.txid;
const NFT_CATEGORY_BE = nftGenesisUtxo.txid;
const FOREIGN_FT_CATEGORY_BE = foreignFtGenesisUtxo.txid;

// VM-order (little-endian) hex for the VM / contract
const FT_CATEGORY_VM = txidToVmOrderHex(FT_CATEGORY_BE);
const NFT_CATEGORY_VM = txidToVmOrderHex(NFT_CATEGORY_BE);
const FOREIGN_FT_CATEGORY_VM = txidToVmOrderHex(FOREIGN_FT_CATEGORY_BE);

// Values passed to the contract as bytes literals (VM-order)
const FT_CATEGORY_BYTES = `0x${FT_CATEGORY_VM}`;
const NFT_CATEGORY_BYTES = `0x${NFT_CATEGORY_VM}`;

const NFT_COMMIT_RAW = "6e667430"; // "nft0"
const NFT_COMMIT_BYTES = `0x${NFT_COMMIT_RAW}`;

// -----------------------------------------------------------------------------
// Contract + helpers
// -----------------------------------------------------------------------------

const artifactV3 = compileFile(
  new URL("../contracts/MeanRevertSingleTokenNFTAuthV3.cash", import.meta.url)
);

/**
 * Instantiate V3 contract.
 *
 * V3 signature:
 *   contract MeanRevertSingleTokenNFTAuthV3(
 *     bytes   tokenCategory,
 *     int     targetTokenAmount,
 *     bytes   rebalancerNftCat,
 *     bytes   rebalancerNftCommit,
 *     bytes20 ownerPkh
 *   )
 *
 * Note: targetTokenAmount and rebalancerNftCat are "touched" but not used
 * in the value-based invariant for now.
 */
function setupContractV3(targetTokenAmount = 0n) {
  const provider = new MockNetworkProvider();

  const contract = new Contract(
    artifactV3,
    [
      FT_CATEGORY_BYTES, // bytes tokenCategory (VM-order)
      targetTokenAmount, // int targetTokenAmount (unused in invariant)
      NFT_CATEGORY_BYTES, // bytes rebalancerNftCat (reserved)
      NFT_COMMIT_BYTES, // bytes rebalancerNftCommit
      alicePkh, // bytes20 ownerPkh
    ],
    { provider }
  );

  return { provider, contract };
}

function assertPureBch(utxo, label = "BCH UTXO") {
  assert.ok(utxo, `${label} must exist`);
  assert.ok(utxo.satoshis >= DUST_LIMIT, `${label} must have dust sats`);
  assert.equal(utxo.token, undefined, `${label} must NOT have token field`);
}

function createContractFtUtxo(contract, provider, amountTokens) {
  const utxo = { ...ftGenesisUtxo };

  // Give the contract a clean 1 BCH backing for nice round numbers.
  utxo.satoshis = 100_000_000n;

  // FT for the portfolio token – category in VM-order (little-endian).
  utxo.token = {
    category: FT_CATEGORY_VM,
    amount: amountTokens,
  };

  provider.addUtxo(contract.tokenAddress, utxo);
  return utxo;
}

function createNftAuthorityUtxo(provider) {
  const utxo = { ...nftGenesisUtxo };
  utxo.satoshis = 2_000n;

  // Pure NFT authority – VM-order category.
  utxo.token = {
    category: NFT_CATEGORY_VM,
    amount: 0n,
    nft: {
      capability: "none",
      commitment: NFT_COMMIT_RAW,
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

// ---- math helper: must mirror contract + math-only test ----

function bchValueUsd(bchSats, oraclePriceRaw) {
  const bchScaled = bchSats / BCH_SCALE_DOWN;
  return (bchScaled * oraclePriceRaw) / BCH_SCALE_DOWN / PRICE_SCALE;
}

/**
 * Imbalance helper – same formula as in the math-only tests and contract:
 *
 *   D = | BCH_value_in_USD - stable_tokens_in_USD |
 *
 * with tokens representing 1 USD each.
 */
function imbalance(bchSats, tokens, oraclePriceRaw) {
  const lhs = bchValueUsd(bchSats, oraclePriceRaw); // BCH side in USD-ish units
  const rhs = tokens; // tokens = whole USD units
  let d = lhs - rhs;
  if (d < 0n) d = -d;
  return d;
}

// -----------------------------------------------------------------------------
// TEST 1 – rebalance that moves closer to 1:1 value is allowed
// -----------------------------------------------------------------------------

test("MeanRevertV3: NFT-authorized rebalance that improves 1:1 value passes", async () => {
  const { provider, contract } = setupContractV3(0n);
  const aliceTemplate = new SignatureTemplate(alicePriv);

  // Start: 1 BCH @ $100 = $100 in BCH
  // Tokens: 200 – overweight stable side.
  const initialTokensOnContract = 200n;

  const contractFtUtxo = createContractFtUtxo(
    contract,
    provider,
    initialTokensOnContract
  );
  const nftAuthorityUtxo = createNftAuthorityUtxo(provider);
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const oldBch = contractFtUtxo.satoshis;
  const oldTokens = initialTokensOnContract;

  // After: keep 1 BCH, reduce tokens to 120 – closer to 1:1 value.
  const newBch = oldBch;
  const newTokens = 120n;

  // Excess tokens leave the contract and go to Alice.
  const tokenDelta = oldTokens - newTokens; // 80
  assert.ok(tokenDelta > 0n, "tokenDelta must be positive");

  const before = imbalance(oldBch, oldTokens, ORACLE_PRICE_RAW);
  const after = imbalance(newBch, newTokens, ORACLE_PRICE_RAW);
  assert.ok(
    after <= before,
    "Sanity: after should be at least as close to 1:1 as before"
  );

  // Inputs:
  //  - contract FT UTXO (1 BCH + 200 tokens)
  //  - NFT authority UTXO
  //  - Alice BCH funding UTXO
  //
  // Outputs:
  //  - contract: 1 BCH + 120 tokens
  //  - Alice: 80 FT tokens (withdrawn from portfolio)
  //  - Alice: NFT back
  //  - Alice: BCH change (balanced with ~1000 sat fee)

  const totalInputSats =
    contractFtUtxo.satoshis +
    nftAuthorityUtxo.satoshis +
    aliceFundingUtxo.satoshis;

  const feeEstimate = 1_000n;
  const aliceTokenChangeSats = TOKEN_OUTPUT_SATS; // sats to carry the 80 tokens

  const aliceChangeSats =
    totalInputSats -
    newBch -
    TOKEN_OUTPUT_SATS - // NFT output sats
    aliceTokenChangeSats - // FT change output sats
    feeEstimate;

  assert.ok(
    aliceChangeSats >= DUST_LIMIT,
    "Alice BCH change should be above dust"
  );

  const txPromise = new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance(ORACLE_PRICE_RAW))
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())

    // Contract portfolio after rebalance (closer to 1:1)
    .addOutput({
      to: contract.tokenAddress,
      amount: newBch,
      token: {
        category: FT_CATEGORY_VM,
        amount: newTokens,
      },
    })

    // FT token "withdrawal" to Alice: 80 tokens leaving the portfolio.
    .addOutput({
      to: aliceTokenAddress,
      amount: aliceTokenChangeSats,
      token: {
        category: FT_CATEGORY_VM,
        amount: tokenDelta,
      },
    })

    // NFT back to Alice
    .addOutput({
      to: aliceTokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: nftAuthorityUtxo.token,
    })

    // BCH change back to Alice
    .addOutput({
      to: aliceAddress,
      amount: aliceChangeSats,
    })

    .send();

  const txDetails = await txPromise;
  assert.ok(
    txDetails,
    "V3 should allow NFT-authorized rebalance that improves value balance"
  );
});

// -----------------------------------------------------------------------------
// TEST 2 – rebalance that moves further away from 1:1 value is rejected
// -----------------------------------------------------------------------------

test("MeanRevertV3: NFT-authorized rebalance that worsens 1:1 value fails", async () => {
  const { provider, contract } = setupContractV3(0n);
  const aliceTemplate = new SignatureTemplate(alicePriv);

  // Design:
  //  - Contract starts with 1 BCH and 110 tokens.
  //  - Alice holds an additional 90 tokens (same category).
  //  - Rebalancer moves ALL 200 tokens onto the contract.
  //  => old: (1 BCH, 110 tokens), new: (1 BCH, 200 tokens) – worse.
  const initialContractTokens = 110n;
  const extraTokensFromAlice = 90n;

  const contractFtUtxo = createContractFtUtxo(
    contract,
    provider,
    initialContractTokens
  );

  const aliceFtUtxo = { ...randomUtxo() };
  aliceFtUtxo.satoshis = 2_000n;
  aliceFtUtxo.token = {
    category: FT_CATEGORY_VM,
    amount: extraTokensFromAlice,
  };
  provider.addUtxo(aliceTokenAddress, aliceFtUtxo);

  const nftAuthorityUtxo = createNftAuthorityUtxo(provider);
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const oldBch = contractFtUtxo.satoshis;
  const oldTokens = initialContractTokens;

  // New portfolio on contract: same BCH, but 200 tokens (worse).
  const newBch = oldBch;
  const newTokens = initialContractTokens + extraTokensFromAlice; // 200

  const before = imbalance(oldBch, oldTokens, ORACLE_PRICE_RAW);
  const after = imbalance(newBch, newTokens, ORACLE_PRICE_RAW);
  assert.ok(
    after > before,
    "Sanity: after should be further from 1:1 than before"
  );

  const totalInputSats =
    contractFtUtxo.satoshis +
    aliceFtUtxo.satoshis +
    nftAuthorityUtxo.satoshis +
    aliceFundingUtxo.satoshis;

  const feeEstimate = 1_000n;
  const aliceChangeSats =
    totalInputSats - newBch - TOKEN_OUTPUT_SATS - feeEstimate;

  assert.ok(
    aliceChangeSats >= DUST_LIMIT,
    "Alice BCH change should be above dust"
  );

  const txPromise = new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance(ORACLE_PRICE_RAW))
    .addInput(aliceFtUtxo, aliceTemplate.unlockP2PKH())
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())

    // Contract ends up *more* imbalanced: 1 BCH + 200 tokens.
    .addOutput({
      to: contract.tokenAddress,
      amount: newBch,
      token: {
        category: FT_CATEGORY_VM,
        amount: newTokens,
      },
    })

    // NFT back to Alice
    .addOutput({
      to: aliceTokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: nftAuthorityUtxo.token,
    })

    // BCH change back to Alice
    .addOutput({
      to: aliceAddress,
      amount: aliceChangeSats,
    })

    .send();

  await assert.rejects(
    txPromise,
    undefined,
    "V3 should reject NFT-authorized rebalances that worsen the value balance"
  );
});

// -----------------------------------------------------------------------------
// TEST 3 – still requires NFT authority
// -----------------------------------------------------------------------------

test("MeanRevertV3: rebalance() still requires NFT authority UTXO", async () => {
  const { provider, contract } = setupContractV3(0n);

  const contractFtUtxo = createContractFtUtxo(contract, provider, 200n);

  const txPromise = new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance(ORACLE_PRICE_RAW))
    // NOTE: deliberately no NFT or Alice P2PKH inputs.
    .addOutput({
      to: contract.tokenAddress,
      amount: contractFtUtxo.satoshis,
      token: {
        category: FT_CATEGORY_VM,
        amount: 200n,
      },
    })
    .send();

  await assert.rejects(
    txPromise,
    undefined,
    "V3 rebalance should fail without NFT authority"
  );
});

// -----------------------------------------------------------------------------
// TEST 4 – ignores non-stablecoin token categories in value math
// -----------------------------------------------------------------------------

test("MeanRevertV3: ignores non-stablecoin token categories in value math", async () => {
  const { provider, contract } = setupContractV3(0n);
  const aliceTemplate = new SignatureTemplate(alicePriv);

  // Start: contract is perfectly balanced on the *stablecoin* side:
  //
  //   - 1 BCH @ $100 = $100 BCH-side value
  //   - 100 stable tokens = $100
  //
  // Alice holds 200 units of a *different* FT category (FOREIGN_FT_CATEGORY_VM),
  // which will be deposited onto the contract in the rebalance.
  const initialStableTokens = 100n;
  const extraForeignTokensFromAlice = 200n;

  const contractFtUtxo = createContractFtUtxo(
    contract,
    provider,
    initialStableTokens
  );

  const aliceForeignFtUtxo = { ...foreignFtGenesisUtxo };
  aliceForeignFtUtxo.satoshis = 2_000n;
  aliceForeignFtUtxo.token = {
    category: FOREIGN_FT_CATEGORY_VM,
    amount: extraForeignTokensFromAlice,
  };
  provider.addUtxo(aliceTokenAddress, aliceForeignFtUtxo);

  const nftAuthorityUtxo = createNftAuthorityUtxo(provider);
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const oldBch = contractFtUtxo.satoshis; // Contract only has the 1 BCH input
  const oldTokens = initialStableTokens; // Only stablecoin category

  // New portfolio on contract:
  //   - BCH: effectively unchanged in value terms (extra 1000 sats truncates away)
  //   - Stablecoin: still 100 tokens (still $100)
  //   - PLUS 200 foreign FT tokens (ignored by the value invariant)
  // Keep the *total* BCH for this contract exactly the same before and after.
  // We just split it across two outputs: one for stable, one for foreign.
  const newBch = oldBch + TOKEN_OUTPUT_SATS; // 100_000_000 + 1_000; bchValueUsd stays 100
  const newStableTokens = initialStableTokens; // still 100

  const before = imbalance(oldBch, oldTokens, ORACLE_PRICE_RAW);
  const after = imbalance(newBch, newStableTokens, ORACLE_PRICE_RAW);

  // Because of the integer downscaling, 100_000_000 and 100_001_000 sats
  // both map to the same USD value at this oracle price (100 USD).
  assert.equal(
    before,
    0n,
    "Sanity: before portfolio is exactly balanced (1 BCH vs 100 tokens)"
  );
  assert.equal(
    after,
    0n,
    "Sanity: after portfolio is also exactly balanced on the stablecoin side"
  );

  const totalInputSats =
    contractFtUtxo.satoshis +
    aliceForeignFtUtxo.satoshis +
    nftAuthorityUtxo.satoshis +
    aliceFundingUtxo.satoshis;

  const feeEstimate = 1_000n;

  const contractForeignOutputSats = TOKEN_OUTPUT_SATS; // sats carrying foreign FTs
  const contractStableOutputSats =
    contractFtUtxo.satoshis - contractForeignOutputSats; // 100_000_000 - 1_000
  const nftOutputSats = TOKEN_OUTPUT_SATS;

  const aliceChangeSats =
    totalInputSats -
    contractStableOutputSats -
    contractForeignOutputSats -
    nftOutputSats -
    feeEstimate;

  assert.ok(
    aliceChangeSats >= DUST_LIMIT,
    "Alice BCH change should be above dust"
  );

  const txPromise = new TransactionBuilder({ provider })
    // Contract stablecoin portfolio input
    .addInput(contractFtUtxo, contract.unlock.rebalance(ORACLE_PRICE_RAW))

    // Alice's foreign FT input
    .addInput(aliceForeignFtUtxo, aliceTemplate.unlockP2PKH())

    // NFT authority + extra BCH for fees
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())

    // Contract stablecoin portfolio after rebalance: 1 BCH + 100 stable tokens.
    .addOutput({
      to: contract.tokenAddress,
      amount: contractStableOutputSats,
      token: {
        category: FT_CATEGORY_VM,
        amount: newStableTokens,
      },
    })

    // Foreign FTs deposited onto the contract in a *different* category.
    // These MUST be ignored by the value-balance invariant.
    .addOutput({
      to: contract.tokenAddress,
      amount: contractForeignOutputSats,
      token: {
        category: FOREIGN_FT_CATEGORY_VM,
        amount: extraForeignTokensFromAlice,
      },
    })

    // NFT back to Alice
    .addOutput({
      to: aliceTokenAddress,
      amount: nftOutputSats,
      token: nftAuthorityUtxo.token,
    })

    // BCH change back to Alice
    .addOutput({
      to: aliceAddress,
      amount: aliceChangeSats,
    })

    .send();

  const txDetails = await txPromise;
  assert.ok(
    txDetails,
    "V3 should ignore non-stablecoin token categories when enforcing value balance"
  );
});
