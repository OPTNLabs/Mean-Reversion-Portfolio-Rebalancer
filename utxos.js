// utxos.js
// Shared UTXO utilities for BCH + CashTokens demo scripts.

import { formatSats } from "./bigint.js";

/**
 * Split UTXOs into BCH-only vs token-bearing.
 *
 * A token UTXO is any UTXO with a non-null `token` field (as returned
 * by ElectrumNetworkProvider).
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
 * Pretty-print summary for any UTXO set.
 *
 * This is intentionally compact – for detailed token listings, use
 * `logTokenUtxosDetailed` below.
 */
export function logUtxoSummary(label, utxos) {
  console.log(`\n=== ${label} UTXOs ===`);
  console.log(`Total UTXOs: ${utxos.length}`);

  if (utxos.length === 0) {
    console.log("(none)\n");
    return;
  }

  const { bchOnly, withTokens } = splitByToken(utxos);
  const totalBch = bchOnly.reduce((sum, u) => sum + u.satoshis, 0n);

  console.log(`BCH-only UTXOs: ${bchOnly.length}`);
  console.log(`  Total BCH: ${formatSats(totalBch)}`);

  if (withTokens.length > 0) {
    console.log(`Token UTXOs: ${withTokens.length}`);
    const grouped = groupTokenUtxosByCategory(withTokens);
    for (const [cat, arr] of grouped.entries()) {
      const tokenTotal = arr.reduce((s, u) => s + (u.token?.amount ?? 0n), 0n);
      const satTotal = arr.reduce((s, u) => s + u.satoshis, 0n);
      console.log(
        `  - category ${cat}: ${
          arr.length
        } UTXOs, ${tokenTotal.toString()} tokens, backing ${formatSats(
          satTotal
        )}`
      );
    }
  }

  console.log("");
}

/**
 * More detailed listing of token UTXOs, including NFT fields.
 *
 * Useful for debugging NFT capability/commitment and exact TXIDs.
 */
export function logTokenUtxosDetailed(label, tokenUtxos) {
  console.log(`\n=== ${label} token UTXOs (detailed) ===`);
  if (tokenUtxos.length === 0) {
    console.log("(none)\n");
    return;
  }

  const grouped = groupTokenUtxosByCategory(tokenUtxos);

  for (const [cat, arr] of grouped.entries()) {
    console.log(`  - category ${cat}`);
    for (const u of arr) {
      const { token } = u;
      const base = `    • txid=${u.txid} vout=${u.vout} | BCH=${formatSats(
        u.satoshis
      )}`;

      if (token?.nft) {
        const nft = token.nft;
        console.log(
          `    • NFT capability=${nft.capability}, commitment=${nft.commitment} | ${base}`
        );
      } else if (token) {
        console.log(`    • FT amount=${token.amount.toString()} | ${base}`);
      } else {
        console.log(`    • (no token) | ${base}`);
      }
    }
  }

  console.log("");
}

/**
 * Pick a BCH UTXO with at least `required` sats.
 *
 * This sorts descending by value so we pick the largest eligible UTXO.
 */
export function selectFundingUtxo(bchOnly, required) {
  const sorted = [...bchOnly].sort((a, b) =>
    a.satoshis === b.satoshis ? 0 : a.satoshis > b.satoshis ? -1 : 1
  );
  return sorted.find((u) => u.satoshis >= required) ?? null;
}

/**
 * Fetch UTXOs for an address via provider and log using `logUtxoSummary`.
 *
 * Returns the raw UTXO array.
 */
export async function logAddressState(label, provider, address) {
  const utxos = await provider.getUtxos(address);
  logUtxoSummary(label, utxos);
  return utxos;
}

/**
 * Fetch UTXOs for a contract via `contract.getUtxos()` and log summary.
 *
 * Returns the raw UTXO array.
 */
export async function logContractState(label, contract) {
  const utxos = await contract.getUtxos();
  logUtxoSummary(label, utxos);
  return utxos;
}
