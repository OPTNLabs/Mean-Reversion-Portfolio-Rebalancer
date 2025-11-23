// tests/meanRevert.behaviour.mocknet.test.js
//
// Behavioural tests for MeanRevertSingleTokenNFTAuth.cash
// These DO NOT modify the contract – they just document what it
// actually allows today, so we can later tighten it against the spec.

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
// Token "genesis" setup (local to this test file)
// -----------------------------------------------------------------------------

const ftGenesisUtxo = randomUtxo();
const nftGenesisUtxo = randomUtxo();

const FT_CATEGORY_RAW = ftGenesisUtxo.txid;
const NFT_CATEGORY_RAW = nftGenesisUtxo.txid;

const FT_CATEGORY_BYTES = `0x${FT_CATEGORY_RAW}`;
const NFT_CATEGORY_BYTES = `0x${NFT_CATEGORY_RAW}`;

const NFT_COMMIT_RAW = "6e667430"; // "nft0"
const NFT_COMMIT_BYTES = `0x${NFT_COMMIT_RAW}`;

const TARGET_TOKENS = 1000n;

// -----------------------------------------------------------------------------
// Contract + helpers (mirrors the main test file)
// -----------------------------------------------------------------------------

const artifact = compileFile(
  new URL("../contracts/MeanRevertSingleTokenNFTAuth.cash", import.meta.url)
);

function setupContract() {
  const provider = new MockNetworkProvider();

  const contract = new Contract(
    artifact,
    [
      FT_CATEGORY_BYTES,
      TARGET_TOKENS,
      NFT_CATEGORY_BYTES,
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

function createContractFtUtxo(contract, provider, amount = TARGET_TOKENS) {
  const utxo = { ...ftGenesisUtxo };
  utxo.satoshis = 2_000n;

  utxo.token = {
    category: FT_CATEGORY_RAW,
    amount,
  };

  provider.addUtxo(contract.tokenAddress, utxo);
  return utxo;
}

function createNftAuthorityUtxo(provider) {
  const utxo = { ...nftGenesisUtxo };
  utxo.satoshis = 2_000n;
  utxo.token = {
    category: NFT_CATEGORY_RAW,
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
// TEST 1 – NFT rebalancer can drain ALL FTs from the contract
// -----------------------------------------------------------------------------

test("MeanRevert behaviour: NFT rebalancer can fully drain contract FTs", async () => {
  const { provider, contract } = setupContract();

  const contractFtUtxo = createContractFtUtxo(contract, provider); // 1000 tokens
  const nftAuthorityUtxo = createNftAuthorityUtxo(provider);
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const aliceTemplate = new SignatureTemplate(alicePriv);

  // Inputs:
  //  - contract FT (1000 tokens, 2000 sats)
  //  - Alice NFT (pure NFT, 2000 sats)
  //  - Alice BCH funding (4000 sats)
  //
  // Outputs:
  //  - Alice FT output: 1000 sats + 1000 tokens (ALL tokens go to Alice)
  //  - NFT output:      1000 sats + NFT (back to Alice)
  //  - Alice BCH change: remaining BCH
  //
  // NOTE: There is NO FT output to contract.tokenAddress.
  //       This documents that the current contract allows the NFT holder
  //       to completely empty the FT position of the contract.
  const aliceFtAmount = TOKEN_OUTPUT_SATS;
  const nftOutAmount = TOKEN_OUTPUT_SATS;

  const txDetails = await new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance())
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())

    // All FTs to Alice's token-aware address
    .addOutput({
      to: aliceTokenAddress,
      amount: aliceFtAmount,
      token: {
        category: FT_CATEGORY_RAW,
        amount: TARGET_TOKENS,
      },
    })

    // NFT back to Alice
    .addOutput({
      to: aliceTokenAddress,
      amount: nftOutAmount,
      token: nftAuthorityUtxo.token,
    })

    // BCH back to Alice (whatever is left, we don't care exactly)
    .addOutput({
      to: aliceAddress,
      amount:
        contractFtUtxo.satoshis +
        nftAuthorityUtxo.satoshis +
        aliceFundingUtxo.satoshis -
        aliceFtAmount -
        nftOutAmount -
        1000n, // rough fee
    })

    .send();

  assert.ok(
    txDetails,
    "Current contract allows NFT holder to fully drain all FTs from contract"
  );
});

// -----------------------------------------------------------------------------
// TEST 2 – Mean-reversion on total FT supply is effectively inert
// -----------------------------------------------------------------------------

test("MeanRevert behaviour: for realistic FT flows oldTokens == newTokens", async () => {
  const { provider, contract } = setupContract();

  // Simulate contract having 1000 tokens and Alice having 500 extra tokens
  const contractFtUtxo = createContractFtUtxo(contract, provider, 1000n);

  const aliceExtraFtUtxo = { ...randomUtxo() };
  aliceExtraFtUtxo.satoshis = 2_000n;
  aliceExtraFtUtxo.token = {
    category: FT_CATEGORY_RAW,
    amount: 500n,
  };
  provider.addUtxo(aliceTokenAddress, aliceExtraFtUtxo);

  const nftAuthorityUtxo = createNftAuthorityUtxo(provider);
  const aliceFundingUtxo = createAliceFundingUtxo(provider);

  const aliceTemplate = new SignatureTemplate(alicePriv);

  // Inputs have 1500 tokens total; outputs also have 1500.
  // The contract's mean-reversion check uses the TOTAL category amount,
  // so distBefore == distAfter, i.e. it can't detect changes in the
  // distribution between contract vs Alice – only gross supply.
  //
  // This test just documents that such a realistic "supply-conserving"
  // trade passes the contract today.
  const txDetails = await new TransactionBuilder({ provider })
    .addInput(contractFtUtxo, contract.unlock.rebalance())
    .addInput(aliceExtraFtUtxo, aliceTemplate.unlockP2PKH())
    .addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH())
    .addInput(aliceFundingUtxo, aliceTemplate.unlockP2PKH())

    // Example split: contract keeps 900, Alice ends with 600 (but total 1500)
    .addOutput({
      to: contract.tokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: { category: FT_CATEGORY_RAW, amount: 900n },
    })
    .addOutput({
      to: aliceTokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: { category: FT_CATEGORY_RAW, amount: 600n },
    })

    // NFT back to Alice
    .addOutput({
      to: aliceTokenAddress,
      amount: TOKEN_OUTPUT_SATS,
      token: nftAuthorityUtxo.token,
    })

    // BCH change back to Alice (not important)
    .addOutput({
      to: aliceAddress,
      amount: 4_000n,
    })

    .send();

  assert.ok(
    txDetails,
    "Mean-reversion check passes for realistic FT-supply-conserving trades"
  );
});
