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
