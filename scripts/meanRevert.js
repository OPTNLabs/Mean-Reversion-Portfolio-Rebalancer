// scripts/meanRevert.js
//
// MeanRevertSingleTokenNFTAuth flows:
//
//  - runMeanRevertFund()       → FT: Alice → contract
//  - runMeanRevertRebalance()  → FT stays on contract, NFT input authorizes rebalance()
//  - runMeanRevertRoundtrip()  → fund() then rebalance() in one go
//  - runMeanRevertDrainAll()   → drain(): move ALL contract funds back to Alice
//
// CONFIG IS DYNAMIC:
//  - tokenCategory, rebalancerNftCat, rebalancerNftCommit, targetTokenAmount
//    are derived from Alice's current token UTXOs on aliceTokenAddress.
//  - Assumes you minted FT + NFT via runMintAllForAlice():
//      * FT: fungible amount > 0 (no NFT field)
//      * NFT: amount == 0 with nft.capability + nft.commitment

import {
  Contract,
  ElectrumNetworkProvider,
  TransactionBuilder,
  SignatureTemplate,
} from "cashscript";
import { compileFile } from "cashc";

import {
  alicePriv,
  alicePub,
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

function safeJson(o) {
  return JSON.stringify(
    o,
    (k, v) => (typeof v === "bigint" ? v.toString() + "n" : v),
    2
  );
}

// ---------------------------------------------------------------------------
// Dynamic config discovery – derive params from Alice's current tokens
// ---------------------------------------------------------------------------

/**
 * Scan aliceTokenAddress for:
 *  - one FT UTXO (amount > 0n, no nft field) → tokenCategory + targetTokenAmount
 *  - one NFT UTXO (amount == 0n, nft present) → rebalancerNftCat + rebalancerNftCommit
 */
async function deriveMeanRevertParams(provider) {
  console.log(
    "\n[MeanRevert/config] Deriving contract params from Alice's token UTXOs..."
  );

  const aliceTokenUtxos = await logAddressState(
    "Alice (token address, for config discovery)",
    provider,
    aliceTokenAddress
  );
  const { withTokens } = splitByToken(aliceTokenUtxos);

  if (!withTokens.length) {
    throw new Error(
      "MeanRevert/config: no token UTXOs found on aliceTokenAddress.\n" +
        "Mint FT + NFT first (runMintAllForAlice) before using mean-revert flows."
    );
  }

  const ftUtxo =
    withTokens.find(
      (u) =>
        u.token &&
        !u.token.nft &&
        u.token.amount !== undefined &&
        u.token.amount > 0n
    ) ?? null;

  const nftUtxo =
    withTokens.find(
      (u) =>
        u.token &&
        u.token.nft &&
        u.token.amount !== undefined &&
        u.token.amount === 0n
    ) ?? null;

  if (!ftUtxo) {
    throw new Error(
      "MeanRevert/config: no fungible token UTXO found on Alice.\n" +
        "Expected: token.amount > 0n, no nft field. Mint FT first."
    );
  }

  if (!nftUtxo) {
    throw new Error(
      "MeanRevert/config: no pure NFT UTXO found on Alice.\n" +
        "Expected: token.amount == 0n and token.nft present. Mint NFT first."
    );
  }

  const tokenCategory = ftUtxo.token.category;
  const targetTokenAmount = ftUtxo.token.amount; // default target = current FT amount
  const rebalancerNftCat = nftUtxo.token.category;
  const rebalancerNftCommit = nftUtxo.token.nft.commitment;

  const params = {
    tokenCategory,
    targetTokenAmount,
    rebalancerNftCat,
    rebalancerNftCommit,
  };

  console.log("[MeanRevert/config] Derived params:", safeJson(params));

  console.log(
    "[MeanRevert/config] FT UTXO used:",
    safeJson({
      txid: ftUtxo.txid,
      vout: ftUtxo.vout,
      amount: ftUtxo.token.amount,
      category: ftUtxo.token.category,
      bch: ftUtxo.satoshis,
    })
  );
  console.log(
    "[MeanRevert/config] NFT UTXO used:",
    safeJson({
      txid: nftUtxo.txid,
      vout: nftUtxo.vout,
      category: nftUtxo.token.category,
      commitment: nftUtxo.token.nft.commitment,
      capability: nftUtxo.token.nft.capability,
      bch: nftUtxo.satoshis,
    })
  );

  return params;
}

// ---------------------------------------------------------------------------
// Contract instantiation helper
// ---------------------------------------------------------------------------

async function getMeanRevertContract() {
  const provider = new ElectrumNetworkProvider(NETWORK);

  const params = await deriveMeanRevertParams(provider);

  const artifact = compileFile(
    new URL("../contracts/MeanRevertSingleTokenNFTAuth.cash", import.meta.url)
  );

  const {
    tokenCategory,
    targetTokenAmount,
    rebalancerNftCat,
    rebalancerNftCommit,
  } = params;

  const contract = new Contract(
    artifact,
    [
      tokenCategory,
      targetTokenAmount,
      rebalancerNftCat,
      rebalancerNftCommit,
      alicePkh,
    ],
    { provider }
  );

  console.log("\n[MeanRevert] contract address     :", contract.address);
  console.log("[MeanRevert] token-aware address :", contract.tokenAddress);
  console.log(
    "[MeanRevert] constructor params  :",
    safeJson({
      tokenCategory,
      targetTokenAmount,
      rebalancerNftCat,
      rebalancerNftCommit,
      ownerPkh: alicePkh,
    })
  );

  return { provider, contract, params };
}

// ---------------------------------------------------------------------------
// Step 1 – FT funding: Alice → contract.tokenAddress
// ---------------------------------------------------------------------------

async function fundContractWithFt(provider, contract, params) {
  console.log(
    "\n=== MeanRevert – Step 1: FT funding from Alice → contract ==="
  );

  const { tokenCategory } = params;

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
      "MeanRevert/fund: no FT UTXO for current tokenCategory found on Alice's token address.\n" +
        "Hint: ensure mintAllForAlice was run with this wallet."
    );
  }

  console.log(
    `[MeanRevert/fund] Using FT UTXO: category=${ftUtxo.token.category}, ` +
      `amount=${ftUtxo.token.amount}, BCH backing=${ftUtxo.satoshis} sats`
  );

  // BCH-only funding from Alice's main P2PKH for miner fee
  const aliceMainUtxos = await logAddressState(
    "Alice (main BCH address, fee funding for FT)",
    provider,
    aliceAddress
  );
  const { bchOnly: aliceMainBchOnly } = splitByToken(aliceMainUtxos);

  const feeFundingUtxo = selectFundingUtxo(aliceMainBchOnly, 3000n);
  if (!feeFundingUtxo) {
    throw new Error(
      "MeanRevert/fund: no BCH-only UTXO ≥ 3000 sats available for FT funding fee on Alice's main address."
    );
  }

  console.log(
    "[MeanRevert/fund] Using fee funding UTXO:",
    `${feeFundingUtxo.txid}:${feeFundingUtxo.vout}, value=${feeFundingUtxo.satoshis} sats`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);

  const ftValue = ftUtxo.satoshis;
  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional
  const builder1 = new TransactionBuilder({ provider });
  builder1.addInput(ftUtxo, aliceTemplate.unlockP2PKH());
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder1.addOutput({
    to: contract.tokenAddress,
    amount: ftValue,
    token: ftUtxo.token,
  });

  builder1.addOutput({
    to: aliceAddress,
    amount: fundingValue,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[MeanRevert/fund] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[MeanRevert/fund] Final change from fee funding UTXO = ${realChange} sats → ${
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
  console.log("\n[MeanRevert/fund] FT funding tx broadcast:", txDetails);

  await logContractState("MeanRevert contract (after FT fund)", contract);
}

// ---------------------------------------------------------------------------
// Step 2 – NFT-authorised rebalance()
// ---------------------------------------------------------------------------

async function runNftAuthorisedRebalance(provider, contract, params) {
  console.log("\n=== MeanRevert – Step 2: NFT-authorised rebalance() ===");

  const { tokenCategory, rebalancerNftCat, rebalancerNftCommit } = params;

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
      "MeanRevert: contract does not hold an FT UTXO for the configured tokenCategory."
    );
  }

  console.log(
    `[MeanRevert/rebalance] Contract FT UTXO: category=${contractFtUtxo.token.category}, ` +
      `amount=${contractFtUtxo.token.amount}, BCH backing=${contractFtUtxo.satoshis} sats`
  );

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
        u.token.nft.commitment === rebalancerNftCommit &&
        u.token.amount === 0n
    ) ?? null;

  if (!nftAuthorityUtxo) {
    throw new Error(
      "MeanRevert: no PURE NFT authority UTXO found on Alice's token address " +
        "(category + commitment must match, and token.amount must be 0n)."
    );
  }

  console.log(
    `[MeanRevert/rebalance] Using NFT authority UTXO: category=${nftAuthorityUtxo.token.category}, ` +
      `capability=${nftAuthorityUtxo.token.nft.capability}, ` +
      `commitment=${nftAuthorityUtxo.token.nft.commitment}, BCH backing=${nftAuthorityUtxo.satoshis} sats`
  );

  // BCH-only UTXO for fee
  const aliceMainUtxos = await logAddressState(
    "Alice (main BCH address, for rebalance fee)",
    provider,
    aliceAddress
  );
  const { bchOnly: aliceMainBchOnly } = splitByToken(aliceMainUtxos);

  const feeFundingUtxo = selectFundingUtxo(aliceMainBchOnly, 3000n);
  if (!feeFundingUtxo) {
    throw new Error(
      "MeanRevert: no BCH-only UTXO ≥ 3000 sats available for rebalance fee funding on Alice's main address."
    );
  }

  console.log(
    "[MeanRevert/rebalance] Using fee funding UTXO:",
    `${feeFundingUtxo.txid}:${feeFundingUtxo.vout}, value=${feeFundingUtxo.satoshis} sats`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);

  const ftValue = contractFtUtxo.satoshis;
  const nftValue = nftAuthorityUtxo.satoshis;
  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional
  const builder1 = new TransactionBuilder({ provider });

  builder1.addInput(contractFtUtxo, contract.unlock.rebalance());
  builder1.addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH());
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder1.addOutput({
    to: contract.tokenAddress,
    amount: ftValue,
    token: contractFtUtxo.token,
  });

  builder1.addOutput({
    to: aliceTokenAddress,
    amount: nftValue,
    token: nftAuthorityUtxo.token,
  });

  builder1.addOutput({
    to: aliceAddress,
    amount: fundingValue,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[MeanRevert/rebalance] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[MeanRevert/rebalance] Final change from fee funding UTXO = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const builder2 = new TransactionBuilder({ provider });

  builder2.addInput(contractFtUtxo, contract.unlock.rebalance());
  builder2.addInput(nftAuthorityUtxo, aliceTemplate.unlockP2PKH());
  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder2.addOutput({
    to: contract.tokenAddress,
    amount: ftValue,
    token: contractFtUtxo.token,
  });

  builder2.addOutput({
    to: aliceTokenAddress,
    amount: nftValue,
    token: nftAuthorityUtxo.token,
  });

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log(
    "\n[MeanRevert/rebalance] NFT-authorised rebalance tx broadcast:",
    txDetails
  );

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const inputsTotal = ftValue + nftValue + fundingValue;
    const outputsTotal = ftValue + nftValue + (includeChange ? realChange : 0n);
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[MeanRevert/rebalance] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  await logContractState("MeanRevert contract (after rebalance)", contract);
  await logAddressState("Alice (after rebalance)", provider, aliceAddress);
}

// ---------------------------------------------------------------------------
// Step 3 – Drain everything back to Alice (ownerPkh)
// ---------------------------------------------------------------------------

async function drainContractFullyToAlice(provider, contract) {
  console.log(
    "\n=== MeanRevert – Step 3: drain ALL contract funds to Alice ==="
  );

  const contractUtxos = await logContractState(
    "MeanRevert contract (before drain)",
    contract
  );

  if (!contractUtxos.length) {
    console.log(
      "[MeanRevert/drain] No contract UTXOs found – nothing to drain."
    );
    return;
  }

  const { withTokens: contractTokenUtxos, bchOnly: contractBchOnlyUtxos } =
    splitByToken(contractUtxos);

  const contractBchTotal = contractBchOnlyUtxos.reduce(
    (sum, u) => sum + u.satoshis,
    0n
  );

  console.log(
    `[MeanRevert/drain] Contract has ${contractTokenUtxos.length} token UTXOs and ` +
      `${contractBchOnlyUtxos.length} BCH-only UTXOs (BCH-only total: ${contractBchTotal} sats)`
  );

  const providerForFee = new ElectrumNetworkProvider(NETWORK);
  const aliceMainUtxos = await logAddressState(
    "Alice (main BCH address, for drain fee)",
    providerForFee,
    aliceAddress
  );
  const { bchOnly: aliceMainBchOnly } = splitByToken(aliceMainUtxos);

  const feeFundingUtxo = selectFundingUtxo(aliceMainBchOnly, 3000n);
  if (!feeFundingUtxo) {
    throw new Error(
      "MeanRevert/drain: no BCH-only UTXO ≥ 3000 sats available on Alice's main address to pay miner fees."
    );
  }

  console.log(
    "[MeanRevert/drain] Using fee funding UTXO:",
    `${feeFundingUtxo.txid}:${feeFundingUtxo.vout}, value=${feeFundingUtxo.satoshis} sats`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);
  const drainUnlockTemplate = contract.unlock.drain(alicePub, aliceTemplate);

  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional
  const builder1 = new TransactionBuilder({ provider });

  for (const u of contractUtxos) {
    builder1.addInput(u, drainUnlockTemplate);
  }

  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  for (const u of contractTokenUtxos) {
    builder1.addOutput({
      to: aliceTokenAddress,
      amount: u.satoshis,
      token: u.token,
    });
  }

  if (contractBchTotal > 0n) {
    builder1.addOutput({
      to: aliceAddress,
      amount: contractBchTotal,
    });
  }

  builder1.addOutput({
    to: aliceAddress,
    amount: fundingValue,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[MeanRevert/drain] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[MeanRevert/drain] Final change from fee funding UTXO = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const builder2 = new TransactionBuilder({ provider });

  for (const u of contractUtxos) {
    builder2.addInput(u, drainUnlockTemplate);
  }

  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  for (const u of contractTokenUtxos) {
    builder2.addOutput({
      to: aliceTokenAddress,
      amount: u.satoshis,
      token: u.token,
    });
  }

  if (contractBchTotal > 0n) {
    builder2.addOutput({
      to: aliceAddress,
      amount: contractBchTotal,
    });
  }

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log("\n[MeanRevert/drain] Drain tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const contractInputsTotal = contractUtxos.reduce(
      (sum, u) => sum + u.satoshis,
      0n
    );
    const inputsTotal = contractInputsTotal + fundingValue;
    const outputsTotal =
      contractInputsTotal + (includeChange ? realChange : 0n);
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[MeanRevert/drain] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  await logContractState("MeanRevert contract (after drain)", contract);
  await logAddressState("Alice (after drain)", providerForFee, aliceAddress);
}

// ---------------------------------------------------------------------------
// Public orchestrators used from index.js
// ---------------------------------------------------------------------------

export async function runMeanRevertFund() {
  const { provider, contract, params } = await getMeanRevertContract();
  await fundContractWithFt(provider, contract, params);
}

export async function runMeanRevertRebalance() {
  const { provider, contract, params } = await getMeanRevertContract();
  await runNftAuthorisedRebalance(provider, contract, params);
}

export async function runMeanRevertRoundtrip() {
  const { provider, contract, params } = await getMeanRevertContract();
  await fundContractWithFt(provider, contract, params);
  await runNftAuthorisedRebalance(provider, contract, params);
}

export async function runMeanRevertDrainAll() {
  const { provider, contract } = await getMeanRevertContract();
  await drainContractFullyToAlice(provider, contract);
}
