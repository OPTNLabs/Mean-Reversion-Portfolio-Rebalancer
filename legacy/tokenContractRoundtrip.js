// scripts/tokenContractRoundtrip.js

import { TransactionBuilder, SignatureTemplate } from "cashscript";

import { getProviderAndContract } from "../contract.js";
import {
  splitByToken,
  logUtxoSummary,
  logAddressState,
  logContractState,
  selectFundingUtxo,
} from "../utxos.js";
import { alicePriv, aliceAddress, aliceTokenAddress } from "../common.js";
import { SATS_PER_BYTE, DUST_THRESHOLD, MIN_TOTAL_SATS } from "../config.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function pickFirstFtUtxo(tokenUtxos) {
  for (const u of tokenUtxos) {
    if (u.token?.amount && u.token.amount > 0n) return u;
  }
  return null;
}

function pickFirstUserNftUtxo(tokenUtxos) {
  for (const u of tokenUtxos) {
    if (u.token?.nft && u.token.nft.capability === "none") return u;
  }
  return null;
}

// ---------------------------------------------------------------------------
// FT: Alice → Contract
// ---------------------------------------------------------------------------
async function sendFtFromAliceToContract({
  provider,
  contract,
  ftUtxo,
  feeFundingUtxo,
}) {
  console.log("\n>>> FT roundtrip via contract (Alice → contract)");

  const aliceTemplate = new SignatureTemplate(alicePriv);

  console.log(
    `[token-fund] Using FT UTXO: FT category ${ftUtxo.token.category}, amount=${ftUtxo.token.amount}, BCH backing=${ftUtxo.satoshis} sats`
  );
  console.log(
    `[token-fund] Using fee funding UTXO from Alice: ${feeFundingUtxo.txid}:${feeFundingUtxo.vout}, value=${feeFundingUtxo.satoshis} sats`
  );

  const ftValue = ftUtxo.satoshis;
  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional tx for size
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
    `[token-fund] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final tx with correct fee
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[token-fund] Final change from funding UTXO = ${realChange} sats → ${
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
  console.log("\n[token-fund] Funding+token tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const outputsTotal = ftValue + (includeChange ? realChange : 0n);
    const inputsTotal = ftValue + fundingValue;
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[token-fund] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  return txDetails;
}

// ---------------------------------------------------------------------------
// FT: Contract → Alice
// ---------------------------------------------------------------------------
async function cycleFtFromContractToAlice({
  provider,
  contract,
  contractFtUtxo,
  feeFundingUtxo,
}) {
  console.log("\n>>> FT roundtrip via contract (contract → Alice)");

  console.log(
    `[token-spend] Contract will spend token UTXO back to Alice: FT category ${contractFtUtxo.token.category}, amount=${contractFtUtxo.token.amount}, BCH backing=${contractFtUtxo.satoshis} sats`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);

  const ftValue = contractFtUtxo.satoshis;
  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional tx
  const builder1 = new TransactionBuilder({ provider });

  builder1.addInput(contractFtUtxo, contract.unlock.spend());
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder1.addOutput({
    to: aliceTokenAddress,
    amount: ftValue,
    token: contractFtUtxo.token,
  });

  builder1.addOutput({
    to: aliceAddress,
    amount: fundingValue,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[token-spend] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final tx
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[token-spend] Final change from BCH-only UTXO = ${realChange} sats (token backing unchanged at ${ftValue} sats)`
  );

  const builder2 = new TransactionBuilder({ provider });

  builder2.addInput(contractFtUtxo, contract.unlock.spend());
  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder2.addOutput({
    to: aliceTokenAddress,
    amount: ftValue,
    token: contractFtUtxo.token,
  });

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log("\n[token-spend] Contract spend tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const outputsTotal = ftValue + (includeChange ? realChange : 0n);
    const inputsTotal = ftValue + fundingValue;
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[token-spend] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  return txDetails;
}

// ---------------------------------------------------------------------------
// NFT: Alice → Contract
// ---------------------------------------------------------------------------
async function sendNftFromAliceToContract({
  provider,
  contract,
  nftUtxo,
  feeFundingUtxo,
}) {
  console.log("\n>>> NFT roundtrip via contract (Alice → contract)");

  const aliceTemplate = new SignatureTemplate(alicePriv);

  console.log(
    `[nft-fund] Using NFT UTXO: NFT category ${nftUtxo.token.category}, capability=${nftUtxo.token.nft.capability}, commitment=${nftUtxo.token.nft.commitment} | BCH backing=${nftUtxo.satoshis} sats`
  );
  console.log(
    `[nft-fund] Using fee funding UTXO from Alice: ${feeFundingUtxo.txid}:${feeFundingUtxo.vout}, value=${feeFundingUtxo.satoshis} sats`
  );

  const nftValue = nftUtxo.satoshis;
  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional tx
  const builder1 = new TransactionBuilder({ provider });
  builder1.addInput(nftUtxo, aliceTemplate.unlockP2PKH());
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder1.addOutput({
    to: contract.tokenAddress,
    amount: nftValue,
    token: nftUtxo.token,
  });

  builder1.addOutput({
    to: aliceAddress,
    amount: fundingValue,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[nft-fund] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final tx
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[nft-fund] Final change from funding UTXO = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const builder2 = new TransactionBuilder({ provider });
  builder2.addInput(nftUtxo, aliceTemplate.unlockP2PKH());
  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder2.addOutput({
    to: contract.tokenAddress,
    amount: nftValue,
    token: nftUtxo.token,
  });

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log("\n[nft-fund] Funding+NFT tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const outputsTotal = nftValue + (includeChange ? realChange : 0n);
    const inputsTotal = nftValue + fundingValue;
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[nft-fund] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  return txDetails;
}

// ---------------------------------------------------------------------------
// NFT: Contract → Alice
// ---------------------------------------------------------------------------
async function cycleNftFromContractToAlice({
  provider,
  contract,
  contractNftUtxo,
  feeFundingUtxo,
}) {
  console.log("\n>>> NFT roundtrip via contract (contract → Alice)");

  console.log(
    `[nft-spend] Contract will spend NFT UTXO back to Alice: NFT category ${contractNftUtxo.token.category}, capability=${contractNftUtxo.token.nft.capability}, commitment=${contractNftUtxo.token.nft.commitment}, BCH backing=${contractNftUtxo.satoshis} sats`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);

  const nftValue = contractNftUtxo.satoshis;
  const fundingValue = feeFundingUtxo.satoshis;

  // PASS 1 – provisional
  const builder1 = new TransactionBuilder({ provider });

  builder1.addInput(contractNftUtxo, contract.unlock.spend());
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder1.addOutput({
    to: aliceTokenAddress,
    amount: nftValue,
    token: contractNftUtxo.token,
  });

  builder1.addOutput({
    to: aliceAddress,
    amount: fundingValue,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[nft-spend] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[nft-spend] Final change from BCH-only UTXO = ${realChange} sats (NFT backing unchanged at ${nftValue} sats)`
  );

  const builder2 = new TransactionBuilder({ provider });

  builder2.addInput(contractNftUtxo, contract.unlock.spend());
  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  builder2.addOutput({
    to: aliceTokenAddress,
    amount: nftValue,
    token: contractNftUtxo.token,
  });

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log("\n[nft-spend] Contract+NFT spend tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const outputsTotal = nftValue + (includeChange ? realChange : 0n);
    const inputsTotal = nftValue + fundingValue;
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[nft-spend] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  return txDetails;
}

// ---------------------------------------------------------------------------
// Batch FT: Alice → Contract
//   - multiple FT UTXOs + 1 BCH funding
// ---------------------------------------------------------------------------
async function sendBatchFtFromAliceToContract({
  provider,
  contract,
  ftUtxos,
  feeFundingUtxo,
}) {
  console.log("\n>>> Batch FT → contract (multi-UTXO Alice → contract)");

  const aliceTemplate = new SignatureTemplate(alicePriv);

  const fundingValue = feeFundingUtxo.satoshis;

  console.log(
    `[batch-ft-fund] Using ${ftUtxos.length} FT UTXOs, plus funding UTXO ${feeFundingUtxo.txid}:${feeFundingUtxo.vout} (${fundingValue} sats)`
  );

  // PASS 1 – provisional
  const builder1 = new TransactionBuilder({ provider });

  for (const u of ftUtxos) {
    builder1.addInput(u, aliceTemplate.unlockP2PKH());
  }
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  for (const u of ftUtxos) {
    builder1.addOutput({
      to: contract.tokenAddress,
      amount: u.satoshis,
      token: u.token,
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
    `[batch-ft-fund] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[batch-ft-fund] Final change from funding UTXO = ${realChange} sats → ${
      includeChange ? "including" : "omitting"
    } change output`
  );

  const builder2 = new TransactionBuilder({ provider });

  for (const u of ftUtxos) {
    builder2.addInput(u, aliceTemplate.unlockP2PKH());
  }
  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  for (const u of ftUtxos) {
    builder2.addOutput({
      to: contract.tokenAddress,
      amount: u.satoshis,
      token: u.token,
    });
  }

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log("\n[batch-ft-fund] Batch FT funding tx broadcast:", txDetails);

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const tokenBackingTotal = ftUtxos.reduce((s, u) => s + u.satoshis, 0n);
    const outputsTotal = tokenBackingTotal + (includeChange ? realChange : 0n);
    const inputsTotal = tokenBackingTotal + fundingValue;
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[batch-ft-fund] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  return txDetails;
}

// ---------------------------------------------------------------------------
// Batch FT: Contract → Alice
//   - contract spends multiple FT UTXOs + 1 BCH funding
// ---------------------------------------------------------------------------
async function cycleBatchFtFromContractToAlice({
  provider,
  contract,
  contractFtUtxos,
  feeFundingUtxo,
}) {
  console.log("\n>>> Batch FT ← contract (multi-UTXO contract → Alice)");

  console.log(
    `[batch-ft-spend] Contract will spend ${contractFtUtxos.length} FT UTXOs back to Alice`
  );

  const aliceTemplate = new SignatureTemplate(alicePriv);

  const fundingValue = feeFundingUtxo.satoshis;
  const tokenBackingTotal = contractFtUtxos.reduce(
    (s, u) => s + u.satoshis,
    0n
  );

  // PASS 1 – provisional
  const builder1 = new TransactionBuilder({ provider });

  for (const u of contractFtUtxos) {
    builder1.addInput(u, contract.unlock.spend());
  }
  builder1.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  for (const u of contractFtUtxos) {
    builder1.addOutput({
      to: aliceTokenAddress,
      amount: u.satoshis,
      token: u.token,
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
    `[batch-ft-spend] Provisional size: ${byteLength} bytes → desired fee = ${fee} sats`
  );

  // PASS 2 – final
  const realChange = fundingValue - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  console.log(
    `[batch-ft-spend] Final change from BCH-only UTXO = ${realChange} sats (token backing total=${tokenBackingTotal} sats)`
  );

  const builder2 = new TransactionBuilder({ provider });

  for (const u of contractFtUtxos) {
    builder2.addInput(u, contract.unlock.spend());
  }
  builder2.addInput(feeFundingUtxo, aliceTemplate.unlockP2PKH());

  for (const u of contractFtUtxos) {
    builder2.addOutput({
      to: aliceTokenAddress,
      amount: u.satoshis,
      token: u.token,
    });
  }

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log(
    "\n[batch-ft-spend] Batch FT contract spend tx broadcast:",
    txDetails
  );

  if (txDetails?.hex) {
    const finalBytes = BigInt(txDetails.hex.length / 2);
    const outputsTotal = tokenBackingTotal + (includeChange ? realChange : 0n);
    const inputsTotal = tokenBackingTotal + fundingValue;
    const actualFee = inputsTotal - outputsTotal;

    console.log(
      `[batch-ft-spend] Final size: ${finalBytes} bytes → actual fee = ${actualFee} sats`
    );
  }

  return txDetails;
}

// ---------------------------------------------------------------------------
// Roundtrip orchestrators
// ---------------------------------------------------------------------------

async function runSingleFtRoundtrip(provider, contract) {
  console.log("\n--- Single FT roundtrip ---");

  const aliceTokenUtxos = await provider.getUtxos(aliceTokenAddress);
  logUtxoSummary("Alice (token address, before FT roundtrip)", aliceTokenUtxos);

  const { withTokens: aliceTokenWithTokens } = splitByToken(aliceTokenUtxos);

  console.log("\n=== Alice token UTXOs (before FT roundtrip, compact) ===");
  for (const u of aliceTokenWithTokens) {
    if (u.token?.amount && u.token.amount > 0n) {
      console.log(
        `  - FT category ${u.token.category}, amount=${u.token.amount}, | txid=${u.txid} vout=${u.vout} | BCH=${u.satoshis}`
      );
    } else if (u.token?.nft) {
      console.log(
        `  - NFT category ${u.token.category}, capability=${u.token.nft.capability}, commitment=${u.token.nft.commitment} | txid=${u.txid} vout=${u.vout} | BCH=${u.satoshis}`
      );
    }
  }

  const ftUtxo = pickFirstFtUtxo(aliceTokenWithTokens);
  if (!ftUtxo) {
    console.log("[FT] No FT UTXOs found – skipping FT roundtrip.");
    return;
  }

  const aliceMainUtxos = await logAddressState(
    "Alice (main BCH address, fee funding for FT)",
    provider,
    aliceAddress
  );
  const { bchOnly: aliceMainBchOnly } = splitByToken(aliceMainUtxos);

  const feeFundingUtxo = selectFundingUtxo(aliceMainBchOnly, 3000n);
  if (!feeFundingUtxo) {
    throw new Error(
      "No BCH-only UTXO ≥ 3000 sats available for FT fee funding on Alice's main address."
    );
  }

  console.log("\n[token-cycle] Selected fee funding UTXO:", {
    txid: feeFundingUtxo.txid,
    vout: feeFundingUtxo.vout,
    satoshis: feeFundingUtxo.satoshis,
    token: feeFundingUtxo.token,
  });

  // Alice → Contract
  await sendFtFromAliceToContract({
    provider,
    contract,
    ftUtxo,
    feeFundingUtxo,
  });

  // Contract state
  const contractUtxos = await logContractState(
    "Contract (before FT spend)",
    contract
  );
  const { withTokens: contractTokenUtxos } = splitByToken(contractUtxos);

  const contractFtUtxo =
    contractTokenUtxos.find(
      (u) => u.token?.category === ftUtxo.token.category && u.token.amount
    ) ?? null;

  if (!contractFtUtxo) {
    throw new Error(
      "Contract does not hold an FT UTXO for the selected category after funding."
    );
  }

  // BCH funding for SumInputs
  const aliceMainForSpend = await logAddressState(
    "Alice (main BCH, for FT contract spend)",
    provider,
    aliceAddress
  );
  const { bchOnly: bchOnlyForSpend } = splitByToken(aliceMainForSpend);

  const requireFunding = selectFundingUtxo(bchOnlyForSpend, MIN_TOTAL_SATS);
  if (!requireFunding) {
    throw new Error(
      `No BCH-only UTXO ≥ MIN_TOTAL_SATS=${MIN_TOTAL_SATS} for FT contract spend.`
    );
  }

  console.log(
    "[token-spend] Selected fee+require funding UTXO:",
    `${requireFunding.txid}:${requireFunding.vout}, value=${requireFunding.satoshis} sats`
  );

  // Contract → Alice
  await cycleFtFromContractToAlice({
    provider,
    contract,
    contractFtUtxo,
    feeFundingUtxo: requireFunding,
  });

  await logContractState("Contract (after FT spend)", contract);
  await logAddressState("Alice (after FT spend)", provider, aliceAddress);
}

// NFT roundtrip orchestrator
async function runNftRoundtrip(provider, contract) {
  console.log("\n--- NFT roundtrip ---");

  const aliceTokenUtxos = await provider.getUtxos(aliceTokenAddress);
  logUtxoSummary(
    "Alice (token address, before NFT roundtrip)",
    aliceTokenUtxos
  );
  const { withTokens: aliceTokenWithTokens } = splitByToken(aliceTokenUtxos);

  const nftUtxo = pickFirstUserNftUtxo(aliceTokenWithTokens);
  if (!nftUtxo) {
    console.log(
      "[NFT] No user NFTs (capability=none) found – skipping NFT roundtrip."
    );
    return;
  }

  const aliceMainUtxos = await logAddressState(
    "Alice (main BCH address, fee funding for NFT)",
    provider,
    aliceAddress
  );
  const { bchOnly: aliceMainBchOnly } = splitByToken(aliceMainUtxos);

  const feeFundingUtxo = selectFundingUtxo(aliceMainBchOnly, 3000n);
  if (!feeFundingUtxo) {
    throw new Error(
      "No BCH-only UTXO ≥ 3000 sats available for NFT fee funding on Alice's main address."
    );
  }

  // Alice → Contract
  await sendNftFromAliceToContract({
    provider,
    contract,
    nftUtxo,
    feeFundingUtxo,
  });

  // Contract state – locate same NFT
  const contractUtxos = await logContractState(
    "Contract (before NFT spend)",
    contract
  );
  const { withTokens: contractTokenUtxos } = splitByToken(contractUtxos);

  const contractNftUtxo =
    contractTokenUtxos.find(
      (u) =>
        u.token?.category === nftUtxo.token.category &&
        u.token?.nft &&
        u.token.nft.commitment === nftUtxo.token.nft.commitment
    ) ?? null;

  if (!contractNftUtxo) {
    throw new Error("Contract does not hold the expected NFT after funding.");
  }

  // BCH funding for SumInputs
  const aliceMainForSpend = await logAddressState(
    "Alice (main BCH, for NFT contract spend)",
    provider,
    aliceAddress
  );
  const { bchOnly: bchOnlyForSpend } = splitByToken(aliceMainForSpend);

  const requireFunding = selectFundingUtxo(bchOnlyForSpend, MIN_TOTAL_SATS);
  if (!requireFunding) {
    throw new Error(
      `No BCH-only UTXO ≥ MIN_TOTAL_SATS=${MIN_TOTAL_SATS} for NFT contract spend.`
    );
  }

  console.log(
    "[nft-spend] Selected fee+require funding UTXO:",
    `${requireFunding.txid}:${requireFunding.vout}, value=${requireFunding.satoshis} sats`
  );

  // Contract → Alice
  await cycleNftFromContractToAlice({
    provider,
    contract,
    contractNftUtxo,
    feeFundingUtxo: requireFunding,
  });

  await logContractState("Contract (after NFT spend)", contract);
  await logAddressState("Alice (after NFT spend)", provider, aliceAddress);
}

// Batch FT roundtrip orchestrator
async function runBatchFtRoundtrip(provider, contract) {
  console.log("\n--- Batch FT multi-UTXO roundtrip ---");

  const aliceTokenUtxos = await provider.getUtxos(aliceTokenAddress);
  logUtxoSummary(
    "Alice (token address, before batch FT roundtrip)",
    aliceTokenUtxos
  );
  const { withTokens: aliceTokenWithTokens } = splitByToken(aliceTokenUtxos);

  const allFtUtxos = aliceTokenWithTokens.filter(
    (u) => u.token?.amount && u.token.amount > 0n
  );

  if (allFtUtxos.length < 2) {
    console.log(
      "[batch-FT] Fewer than 2 FT UTXOs available – skipping batch FT roundtrip."
    );
    return;
  }

  // Take up to 3 for the demo
  const ftUtxos = allFtUtxos.slice(0, 3);

  const aliceMainUtxos = await logAddressState(
    "Alice (main BCH address, fee funding for batch FT)",
    provider,
    aliceAddress
  );
  const { bchOnly: aliceMainBchOnly } = splitByToken(aliceMainUtxos);

  // simple safety: at least MIN_TOTAL_SATS + 2000 sats for fee
  const feeFundingUtxo = selectFundingUtxo(
    aliceMainBchOnly,
    MIN_TOTAL_SATS + 2000n
  );
  if (!feeFundingUtxo) {
    throw new Error(
      "No BCH-only UTXO large enough for batch FT fee + SumInputs requirement."
    );
  }

  // Alice → Contract
  await sendBatchFtFromAliceToContract({
    provider,
    contract,
    ftUtxos,
    feeFundingUtxo,
  });

  // Contract state – collect all FT UTXOs for batch spend
  const contractUtxos = await logContractState(
    "Contract (before batch FT spend)",
    contract
  );
  const { withTokens: contractTokenUtxos } = splitByToken(contractUtxos);

  const contractFtUtxos = contractTokenUtxos.filter(
    (u) => u.token?.amount && u.token.amount > 0n
  );

  if (contractFtUtxos.length === 0) {
    console.log(
      "[batch-FT] No contract FT UTXOs found after funding – skipping batch spend."
    );
    return;
  }

  // BCH funding for SumInputs
  const aliceMainForSpend = await logAddressState(
    "Alice (main BCH, for batch FT contract spend)",
    provider,
    aliceAddress
  );
  const { bchOnly: bchOnlyForSpend } = splitByToken(aliceMainForSpend);

  const requireFunding = selectFundingUtxo(bchOnlyForSpend, MIN_TOTAL_SATS);
  if (!requireFunding) {
    throw new Error(
      `No BCH-only UTXO ≥ MIN_TOTAL_SATS=${MIN_TOTAL_SATS} for batch FT contract spend.`
    );
  }

  console.log(
    "[batch-ft-spend] Selected fee+require funding UTXO:",
    `${requireFunding.txid}:${requireFunding.vout}, value=${requireFunding.satoshis} sats`
  );

  // Contract → Alice (batch)
  await cycleBatchFtFromContractToAlice({
    provider,
    contract,
    contractFtUtxos,
    feeFundingUtxo: requireFunding,
  });

  await logContractState("Contract (after batch FT spend)", contract);
  await logAddressState("Alice (after batch FT spend)", provider, aliceAddress);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function runTokenContractRoundtrip() {
  const { provider, contract } = getProviderAndContract();

  console.log("\n>>> Token / contract roundtrip demo");
  console.log("SumInputs contract address      :", contract.address);
  console.log("SumInputs token-aware address   :", contract.tokenAddress);
  console.log("Alice BCH address               :", aliceAddress);
  console.log("Alice token-aware address       :", aliceTokenAddress);

  // 1) Single FT roundtrip (already confirmed working)
  await runSingleFtRoundtrip(provider, contract);

  // 2) Single NFT roundtrip (user NFT, capability=none)
  await runNftRoundtrip(provider, contract);

  // 3) Batch multi-UTXO FT roundtrip
  await runBatchFtRoundtrip(provider, contract);

  console.log("\n>>> All roundtrips complete.");
}
