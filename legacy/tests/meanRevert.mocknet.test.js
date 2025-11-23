// tests/meanRevert.mocknet.test.js
//
// Mocknet tests for MeanRevertSingleTokenNFTAuth.cash
//
// - Uses MockNetworkProvider (no chipnet/electrum).
// - IMPORTANT: any UTXO with a `token` field must use a *token-aware* address:
//     * contract.tokenAddress  (for contract tokens)
//     * aliceTokenAddress      (for Alice's tokens)

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
} from "../../common.js";

// -----------------------------------------------------------------------------
// Dust & token funding rules
// -----------------------------------------------------------------------------

// Minimum sats for standard P2PKH outputs
const DUST_LIMIT = 546n;

// Minimum sats we want to attach to any token output
const TOKEN_OUTPUT_SATS = 1000n;

// -----------------------------------------------------------------------------
// Token "genesis" setup
// -----------------------------------------------------------------------------

// For MockNetworkProvider we can freely choose token categories.
// Here we derive them from randomUtxo() just to have deterministic-ish
// values per test run.
const ftGenesisUtxo = randomUtxo();
const nftGenesisUtxo = randomUtxo();

// Raw (no 0x) hex strings used for token.category in UTXOs
const FT_CATEGORY_RAW = ftGenesisUtxo.txid;
const NFT_CATEGORY_RAW = nftGenesisUtxo.txid;

// 0x-prefixed hex used for contract `bytes` constructor params
const FT_CATEGORY_BYTES = `0x${FT_CATEGORY_RAW}`;
const NFT_CATEGORY_BYTES = `0x${NFT_CATEGORY_RAW}`;

// Deterministic-ish dummy config for the test run
// Commitment is a small hex string – used exactly the same both
// in UTXO token.nft.commitment and as a contract `bytes` param.
const NFT_COMMIT_RAW = "6e667430"; // "nft0" hex
const NFT_COMMIT_BYTES = `0x${NFT_COMMIT_RAW}`;

const TARGET_TOKENS = 1000n; // targetTokenAmount

// -----------------------------------------------------------------------------
// Contract setup helper
// -----------------------------------------------------------------------------

// Compile the contract artifact once per test file.
const artifact = compileFile(
  new URL("../contracts/MeanRevertSingleTokenNFTAuth.cash", import.meta.url)
);

function setupContract() {
  const provider = new MockNetworkProvider();

  const contract = new Contract(
    artifact,
    [
      FT_CATEGORY_BYTES, // tokenCategory (bytes – VM-order)
      TARGET_TOKENS, // targetTokenAmount
      NFT_CATEGORY_BYTES, // rebalancerNftCat (currently unused, but bytes)
      NFT_COMMIT_BYTES, // rebalancerNftCommit (bytes)
      alicePkh, // ownerPkh
    ],
    { provider }
  );

  return { provider, contract };
}

// -----------------------------------------------------------------------------
// UTXO shape helpers (robust FT / NFT assertions)
// -----------------------------------------------------------------------------

function assertFtUtxoShape(utxo, label = "FT UTXO") {
  assert.ok(utxo, `${label} must be defined`);
  assert.ok(utxo.token, `${label} must have a token field`);

  // Fungible token – must have correct category & a positive amount
  assert.equal(
    utxo.token.category,
    FT_CATEGORY_RAW,
    `${label} token.category must equal FT_CATEGORY_RAW`
  );
  assert.ok(
    utxo.token.amount > 0n,
    `${label} token.amount must be > 0n (fungible amount)`
  );

  // Should not have NFT metadata on a pure FT UTXO
  if (utxo.token.nft !== undefined) {
    assert.fail(`${label} must NOT have an nft property for pure FTs`);
  }
}

function assertNftUtxoShape(utxo, label = "NFT UTXO") {
  assert.ok(utxo, `${label} must be defined`);
  assert.ok(utxo.token, `${label} must have a token field`);

  // NFT token – amount 0, correct category, correct commitment
  assert.equal(
    utxo.token.category,
    NFT_CATEGORY_RAW,
    `${label} token.category must equal NFT_CATEGORY_RAW`
  );
  assert.equal(
    utxo.token.amount,
    0n,
    `${label} token.amount must be 0n for pure NFT authority`
  );

  assert.ok(utxo.token.nft, `${label} must have an nft metadata object`);
  assert.equal(
    utxo.token.nft.capability,
    "none",
    `${label} nft.capability must be "none" (non-minting authority)`
  );
  assert.equal(
    utxo.token.nft.commitment,
    NFT_COMMIT_RAW,
    `${label} nft.commitment must equal NFT_COMMIT_RAW`
  );
}

function assertPureBchUtxoShape(utxo, label = "BCH UTXO") {
  assert.ok(utxo, `${label} must be defined`);
  assert.ok(
    utxo.satoshis >= DUST_LIMIT,
    `${label} must have at least dust sats`
  );
  assert.equal(
    utxo.token,
    undefined,
    `${label} must NOT have a token field (pure BCH)`
  );
}

// -----------------------------------------------------------------------------
// Helpers for creating UTXOs
// -----------------------------------------------------------------------------

/**
 * Create a contract FT UTXO:
 *  - Uses ftGenesisUtxo as the base "genesis" UTXO.
 *  - Holds TARGET_TOKENS of FT_CATEGORY_RAW
 *  - Has enough sats for dust + fee
 *  - LOCKED TO: contract.tokenAddress (token-aware!)
 */
function createContractFtUtxo(contract, provider) {
  // Clone the genesis UTXO so we don't mutate the original.
  const utxo = { ...ftGenesisUtxo };

  // Ensure the token UTXO itself has at least TOKEN_OUTPUT_SATS sats.
  utxo.satoshis = 2_000n;

  utxo.token = {
    category: FT_CATEGORY_RAW,
    amount: TARGET_TOKENS,
  };

  // Extra robustness: verify shape before seeding.
  assertFtUtxoShape(utxo, "Contract FT genesis UTXO");

  // Seed the UTXO at the contract *token-aware* script address.
  provider.addUtxo(contract.tokenAddress, utxo);

  return utxo;
}

/**
 * Create Alice's NFT authority UTXO:
 *  - Based on nftGenesisUtxo.
 *  - token.category          = NFT_CATEGORY_RAW
 *  - token.amount            = 0n (pure NFT)
 *  - token.nft.commitment    = NFT_COMMIT_RAW
 *  - LOCKED TO: aliceTokenAddress (token-aware)
 */
function createNftAuthorityUtxo(provider) {
  // Clone the genesis UTXO so we don't mutate the original.
  const utxo = { ...nftGenesisUtxo };

  // Also ensure NFT UTXO has enough sats attached.
  utxo.satoshis = 2_000n;

  utxo.token = {
    category: NFT_CATEGORY_RAW,
    amount: 0n,
    nft: {
      capability: "none",
      commitment: NFT_COMMIT_RAW,
    },
  };

  // Extra robustness: verify NFT shape before seeding.
  assertNftUtxoShape(utxo, "Alice NFT authority UTXO");

  // ✅ Token UTXO → aliceTokenAddress
  provider.addUtxo(aliceTokenAddress, utxo);

  return utxo;
}

/**
 * Create a pure-BCH funding UTXO for Alice:
 *  - No token field
 *  - Enough sats to comfortably cover fees + change
 *  - LOCKED TO: aliceAddress (standard P2PKH cashaddr)
 */
function createAliceFundingUtxo(provider) {
  const utxo = randomUtxo();

  utxo.satoshis = 4_000n;
  // Ensure this is pure BCH (in case randomUtxo ever adds token metadata)
  utxo.token = undefined;

  // Extra robustness: verify it’s pure BCH.
  assertPureBchUtxoShape(utxo, "Alice BCH funding UTXO");

  provider.addUtxo(aliceAddress, utxo);

  return utxo;
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

test("MeanRevert: rebalance() requires NFT authority UTXO", async () => {
  const { provider, contract } = setupContract();

  // Contract holds FT, but there is NO NFT authority input in this test.
  const contractFtUtxo = createContractFtUtxo(contract, provider);

  // Sanity check: contract FT UTXO really is fungible-only.
  assertFtUtxoShape(contractFtUtxo, "Contract FT UTXO (no-NFT test)");

  // Build a tx that calls rebalance() WITHOUT an NFT authority input.
  // This should fail the `require(hasNftAuthority)` check.
  const txPromise = new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance())
    .addOutput({
      // Keep tokens & sats on contract.tokenAddress,
      // so the mean-reversion invariant itself is satisfied.
      to: contract.tokenAddress, // ✅ token-aware
      amount: contractFtUtxo.satoshis,
      token: contractFtUtxo.token,
    })
    .send();

  // We only care that it rejects – message/details are CashScript-internal.
  await assert.rejects(txPromise);
});

test("MeanRevert: NFT-authorised rebalance passes and respects fee/dust rules", async () => {
  const { provider, contract } = setupContract();

  // 1) Contract FT UTXO (at contract.tokenAddress)
  const contractFtUtxo = createContractFtUtxo(contract, provider);

  // 2) Alice NFT authority UTXO (at aliceTokenAddress)
  const nftAuthorityUtxo = createNftAuthorityUtxo(provider);

  // 3) Pure BCH funding UTXO for Alice (at aliceAddress)
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const aliceTemplate = new SignatureTemplate(alicePriv);

  // We'll structure the TX like this:
  //
  // Inputs:
  //   - contract FT UTXO:     2000 sats  (FT_CATEGORY_RAW, 1000 tokens)
  //   - Alice NFT UTXO:       2000 sats  (NFT_CATEGORY_RAW, pure NFT)
  //   - Alice BCH funding:    4000 sats
  //
  // Outputs:
  //   - contract FT output:   1000 sats + 600 tokens  (to contract.tokenAddress)
  //   - Alice FT output:      1000 sats + 400 tokens  (to aliceTokenAddress)
  //   - NFT authority output: 1000 sats + NFT        (to aliceTokenAddress)
  //   - Alice BCH change:     4000 sats              (to aliceAddress)
  //
  // Fee:
  //   - 8000 - (1000 + 1000 + 1000 + 4000) = 1000 sats
  //
  // Dust rules:
  //   - All P2PKH outputs (aliceAddress, aliceTokenAddress) >= DUST_LIMIT (546)
  //   - All token outputs >= TOKEN_OUTPUT_SATS (1000)
  const contractOutputAmount = TOKEN_OUTPUT_SATS; // 1000n
  const aliceFtOutputAmount = TOKEN_OUTPUT_SATS; // 1000n
  const nftOutputAmount = TOKEN_OUTPUT_SATS; // 1000n
  const aliceChangeAmount = 4_000n;

  // Token split after rebalance
  const contractTokenAmountAfter = 600n;
  const aliceTokenAmountAfter = TARGET_TOKENS - contractTokenAmountAfter; // 400n

  // --- JS-level sanity checks on token math (mirrors mean-reversion idea) ---

  const oldTokens = TARGET_TOKENS; // all 1000n on contract before
  const newTokens = contractTokenAmountAfter + aliceTokenAmountAfter;

  // Total tokens conserved
  assert.equal(
    newTokens,
    oldTokens,
    "Total FT tokens must be conserved across rebalance"
  );

  const distBefore = oldTokens - TARGET_TOKENS; // == 0
  const distBeforeAbs = distBefore < 0n ? -distBefore : distBefore;

  const distAfter = newTokens - TARGET_TOKENS;
  const distAfterAbs = distAfter < 0n ? -distAfter : distAfter;

  assert.ok(
    distAfterAbs <= distBeforeAbs,
    "Post-rebalance token allocation must be at least as close to target"
  );

  // Dust rules for sats on outputs
  assert.ok(contractOutputAmount >= TOKEN_OUTPUT_SATS);
  assert.ok(aliceFtOutputAmount >= TOKEN_OUTPUT_SATS);
  assert.ok(nftOutputAmount >= TOKEN_OUTPUT_SATS);
  assert.ok(aliceChangeAmount >= DUST_LIMIT);

  const txDetails = await new TransactionBuilder({ provider })
    // Contract FT input unlocked via rebalance()
    .addInput(contractFtUtxo, contract.unlock.rebalance())

    // NFT authority input – pure NFT, signed by Alice.
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())

    // BCH funding input – pure BCH, signed by Alice.
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())

    // Contract FT output: keep part of the FT position on contract.tokenAddress.
    .addOutput({
      to: contract.tokenAddress, // ✅ token-aware contract script
      amount: contractOutputAmount,
      token: {
        category: FT_CATEGORY_RAW,
        amount: contractTokenAmountAfter,
      },
    })

    // Alice FT output: remaining FTs go to Alice's token-aware address.
    .addOutput({
      to: aliceTokenAddress, // ✅ token-aware P2PKH
      amount: aliceFtOutputAmount,
      token: {
        category: FT_CATEGORY_RAW,
        amount: aliceTokenAmountAfter,
      },
    })

    // NFT output: NFT goes back to Alice's token address (still pure NFT).
    .addOutput({
      to: aliceTokenAddress, // ✅ token-aware
      amount: nftOutputAmount,
      token: nftAuthorityUtxo.token,
    })

    // Alice BCH change – standard P2PKH output.
    .addOutput({
      to: aliceAddress,
      amount: aliceChangeAmount,
    })

    .send();

  // If we got here, the contract accepted the tx.
  assert.ok(txDetails);
});
