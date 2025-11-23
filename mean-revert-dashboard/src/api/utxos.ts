// src/api/utxos.ts
//
// Thin wrapper around the indexer API that does *not* throw on
// indexer-level errors (HTTP 500, invalid address, etc).
// Instead, it always returns { address, utxos, error }.

import { fetchUtxos, type RawUtxo } from "./indexer";

export type AddressUtxoResponse = {
  address: string;
  utxos: RawUtxo[];
  error: string | null;
};

// Re-export RawUtxo so callers can import from "../api/utxos".
export type { RawUtxo } from "./indexer";

export async function fetchAddressUtxos(
  address: string
): Promise<AddressUtxoResponse> {
  const { utxos, error } = await fetchUtxos(address);
  return {
    address,
    utxos,
    error: error ?? null,
  };
}
