// tests/meanRevert.v2.mocknet.test.js
//
// Behavioural tests for MeanRevertSingleTokenNFTAuthV2.cash
// - Keeps v1 tests intact by using a separate contract.
// - Focuses on contract-centric mean reversion.

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

const DUST_LIMIT = 546n;
const TOKEN_OUTPUT_SATS = 1000n;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Convert a big-endian txid hex string (explorer/UI style) to VM-order hex
// (little-endian, as used in the CashToken category inside the VM).
function txidToVmOrderHex(txidHex) {
  // txidHex: 64 hex chars, big-endian
  // -> reverse per-byte
  return txidHex.match(/../g).reverse().join("");
}

// -----------------------------------------------------------------------------
// Local FT/NFT "genesis" for this test file
// -----------------------------------------------------------------------------

const ftGenesisUtxo = randomUtxo();
const nftGenesisUtxo = randomUtxo();

// Big-endian txids (as typically seen in UIs / explorers)
const FT_CATEGORY_BE = ftGenesisUtxo.txid;
const NFT_CATEGORY_BE = nftGenesisUtxo.txid;

// VM-order (little-endian) hex for the VM / contract
const FT_CATEGORY_VM = txidToVmOrderHex(FT_CATEGORY_BE);
const NFT_CATEGORY_VM = txidToVmOrderHex(NFT_CATEGORY_BE);

// Values passed into the CashScript contract (bytes literals, VM-order)
const FT_CATEGORY_BYTES = `0x${FT_CATEGORY_VM}`;
const NFT_CATEGORY_BYTES = `0x${NFT_CATEGORY_VM}`;

const NFT_COMMIT_RAW = "6e667430"; // "nft0"
const NFT_COMMIT_BYTES = `0x${NFT_COMMIT_RAW}`;

// Default target: 1000 tokens on the contract
const TARGET_TOKENS = 1000n;

// -----------------------------------------------------------------------------
// Contract + helpers
// -----------------------------------------------------------------------------

const artifactV2 = compileFile(
  new URL("../contracts/MeanRevertSingleTokenNFTAuthV2.cash", import.meta.url)
);

// Allow tests to override the target token amount
function setupContractV2(customTarget = TARGET_TOKENS) {
  const provider = new MockNetworkProvider();

  const contract = new Contract(
    artifactV2,
    [
      FT_CATEGORY_BYTES, // VM-order FT category
      customTarget,
      NFT_CATEGORY_BYTES, // VM-order NFT category (reserved for future)
      NFT_COMMIT_BYTES,
      alicePkh,
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

function createContractFtUtxo(contract, provider, amount) {
  const utxo = { ...ftGenesisUtxo };
  utxo.satoshis = 2_000n;

  // FT for the portfolio token – category in VM-order (little-endian)
  utxo.token = {
    category: FT_CATEGORY_VM,
    amount,
  };

  provider.addUtxo(contract.tokenAddress, utxo);
  return utxo;
}

function createNftAuthorityUtxo(provider) {
  const utxo = { ...nftGenesisUtxo };
  utxo.satoshis = 2_000n;

  // Pure NFT authority – also using VM-order category
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

// -----------------------------------------------------------------------------
// TEST 1 – still requires NFT authority
// -----------------------------------------------------------------------------

test("MeanRevertV2: rebalance() still requires NFT authority UTXO", async () => {
  const { provider, contract } = setupContractV2();

  const contractFtUtxo = createContractFtUtxo(
    contract,
    provider,
    TARGET_TOKENS
  );

  const txPromise = new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance())
    // Keep all tokens on contract – but with no NFT, should fail.
    .addOutput({
      to: contract.tokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: FT_CATEGORY_VM, // VM-order, matches contract param
        amount: TARGET_TOKENS,
      },
    })
    .send();

  await assert.rejects(txPromise);
});

// -----------------------------------------------------------------------------
// TEST 2 – NFT rebalancer CAN fully drain contract FTs when target = 0
// -----------------------------------------------------------------------------

test("MeanRevertV2: NFT rebalancer can fully drain contract FTs when target is 0", async () => {
  // Here we set targetTokenAmount = 0, so a full drain is actually
  // perfectly mean-reverting: distBefore = |old - 0|, distAfter = |0 - 0| = 0.
  const { provider, contract } = setupContractV2(0n);

  const initialTokensOnContract = 500n;

  const contractFtUtxo = createContractFtUtxo(
    contract,
    provider,
    initialTokensOnContract
  );
  const nftAuthorityUtxo = createNftAuthorityUtxo(provider);
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const aliceTemplate = new SignatureTemplate(alicePriv);

  const txDetails = await new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance())
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())

    // All FTs leave the contract and go to Alice
    .addOutput({
      to: aliceTokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: FT_CATEGORY_VM, // VM-order
        amount: initialTokensOnContract,
      },
    })
    // NFT back to Alice
    .addOutput({
      to: aliceTokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: nftAuthorityUtxo.token,
    })
    // BCH change back to Alice (rough fee estimate)
    .addOutput({
      to: aliceAddress,
      amount:
        contractFtUtxo.satoshis +
        nftAuthorityUtxo.satoshis +
        aliceFundingUtxo.satoshis -
        3_000n,
    })
    .send();

  assert.ok(
    txDetails,
    "V2 should allow NFT-authorized full drains when targetTokenAmount = 0"
  );
});

// -----------------------------------------------------------------------------
// TEST 3 – a proper mean-reversion towards the FT target passes
// -----------------------------------------------------------------------------

test("MeanRevertV2: NFT rebalancer can move contract FT position towards target", async () => {
  const { provider, contract } = setupContractV2();

  // Start below target: contract has 800 tokens, target is 1000.
  const initialContractTokens = 800n;
  const extraTokensFromAlice = 200n;

  const contractFtUtxo = createContractFtUtxo(
    contract,
    provider,
    initialContractTokens
  );

  // Alice supplies an extra 200 tokens – same VM-order category
  const aliceFtUtxo = { ...randomUtxo() };
  aliceFtUtxo.satoshis = 2_000n;
  aliceFtUtxo.token = {
    category: FT_CATEGORY_VM, // VM-order
    amount: extraTokensFromAlice,
  };
  provider.addUtxo(aliceTokenAddress, aliceFtUtxo);

  const nftAuthorityUtxo = createNftAuthorityUtxo(provider);
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const aliceTemplate = new SignatureTemplate(alicePriv);

  // Inputs:
  //  - contract: 800 tokens
  //  - Alice:   200 tokens
  // Total inputs: 1000 tokens (same as target)
  //
  // Outputs:
  //  - contract: 1000 tokens (exactly on target)
  //  - Alice:    0 tokens (she gives all to treasury in this test)
  //
  // So:
  //  oldTokensOnContract = 800,   distBefore = |800 - 1000| = 200
  //  newTokensOnContract = 1000,  distAfter  = |1000 - 1000| = 0
  //  => distAfter <= distBefore -> should PASS
  const txDetails = await new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance())
    .addInput(aliceFtUtxo, aliceTemplate.unlockP2PKH())
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())

    // Contract ends with full 1000 tokens
    .addOutput({
      to: contract.tokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: {
        category: FT_CATEGORY_VM, // VM-order, matches contract param
        amount: TARGET_TOKENS,
      },
    })

    // NFT back to Alice
    .addOutput({
      to: aliceTokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: nftAuthorityUtxo.token,
    })

    // BCH back to Alice
    .addOutput({
      to: aliceAddress,
      amount: 4_000n,
    })

    .send();

  assert.ok(
    txDetails,
    "V2 should allow NFT rebalancer to move contract FT position towards target"
  );
});
