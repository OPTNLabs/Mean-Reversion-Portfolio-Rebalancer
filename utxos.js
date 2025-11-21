// utxos.js
// Shared UTXO utilities for BCH + CashTokens demo scripts.
//
// Design goals:
//  - Keep each script small and focused (mint, burn, contract spend, etc.)
//  - Centralize "view of the world" here: inspecting address/contract state,
//    grouping by token category, and pretty-printing.
//  - All UTXO shape assumptions are isolated here, so switching providers
//    later is less painful.

import { formatSats } from "./bigint.js";

/**
 * Internal helper: normalize a UTXO's satoshi value to BigInt.
 */
function utxoValueBigInt(utxo) {
  const v = utxo.satoshis ?? utxo.value;
  if (v === undefined) return 0n;
  return BigInt(v);
}

/**
 * Split UTXOs into BCH-only vs token-bearing.
 *
 * A token UTXO is any UTXO with a non-null `token` field (as returned
 * by ElectrumNetworkProvider).
 * This is the first thing you'll usually call when you want to reason
 * about "pure BCH" vs "BCH backing tokens".
 */
export function splitByToken(utxos) {
  const bchOnly = [];
  const withTokens = [];
  for (const u of utxos) {
    if (u.token) withTokens.push(u);
    else bchOnly.push(u);
  }
  return { bchOnly, withTokens };
}

/**
 * Group token UTXOs by category ID.
 *
 * Returns a Map<categoryHex, UTXO[]>.
 * Useful for "per-token" operations like treasury balances and burns.
 */
export function groupTokenUtxosByCategory(tokenUtxos) {
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
 * Pretty-print the state of an address (or contract address).
 *
 * - Fetches UTXOs via the provided `provider`
 * - Logs total count, BCH-only vs token-bearing counts
 * - Logs total BCH balance
 * - Returns the raw UTXO array so callers can continue processing.
 */
export async function logAddressState(label, provider, address) {
  console.log(`\n=== ${label} UTXOs ===`);
  console.log(`Address: ${address}`);

  const utxos = await provider.getUtxos(address);
  console.log(`Total UTXOs: ${utxos.length}`);

  const { bchOnly, withTokens } = splitByToken(utxos);
  console.log(`  BCH-only UTXOs  : ${bchOnly.length}`);
  console.log(`  Token UTXOs     : ${withTokens.length}`);

  const total = utxos.reduce((s, u) => s + utxoValueBigInt(u), 0n);
  console.log(`Total BCH (all UTXOs): ${formatSats(total)} (sats)`);

  return utxos;
}

/**
 * Detailed logging of token-bearing UTXOs.
 *
 * For each UTXO, logs:
 *  - txid:vout
 *  - BCH value
 *  - token.category
 *  - token.amount
 *  - NFT commitment (if present)
 */
export function logTokenUtxosDetailed(label, tokenUtxos) {
  console.log(`\n=== ${label} token UTXOs ===`);
  if (!tokenUtxos.length) {
    console.log("(none)");
    return;
  }

  tokenUtxos.forEach((u, i) => {
    const v = utxoValueBigInt(u);
    const t = u.token;
    const nftCommit = t?.nft?.commitment;
    console.log(
      ` [${i}] txid=${u.txid} vout=${u.vout} ` +
        `value=${formatSats(v)} sats | ` +
        `category=${t?.category} amount=${t?.amount}` +
        (nftCommit ? ` nftCommit=${nftCommit}` : "")
    );
  });
}

export async function logContractState(label, contract) {
  const utxos = await contract.getUtxos();
  logUtxoSummary(label, utxos);
  return utxos;
}

// --- CLI runner ---
if (import.meta.url === `file://${process.argv[1]}`) {
  runMintAllForAlice().catch((err) => {
    console.error("Error in mintAllForAlice script:", err);
    process.exit(1);
  });
}
