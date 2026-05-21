// src/api/indexer.ts
//
// Frontend helper to fetch UTXOs via the local indexerProxy server.

export type RawUtxo = {
  txid: string;
  vout: number;
  satoshis?: string | number;
  value?: string | number;
  token?: {
    category: string;
    amount: string | number;
    nft?: {
      capability: "none" | "mutable" | "minting";
      commitment: string;
    };
  };
};

export type FetchUtxosResult = {
  utxos: RawUtxo[];
  error?: string | null;
};

const INDEXER_BASE_URL =
  (import.meta.env.VITE_INDEXER_BASE_URL as string | undefined) ??
  "http://localhost:4000";

/**
 * Fetch UTXOs for a chipnet address via the local indexerProxy server.
 */
export async function fetchUtxos(address: string): Promise<FetchUtxosResult> {
  const url = `${INDEXER_BASE_URL}/api/utxos/${encodeURIComponent(address)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const text = await res.text();

    let json: any;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      console.error("Failed to parse indexer JSON", { url, text });
      return {
        utxos: [],
        error: `JSON.parse failed: ${(parseErr as Error).message}`,
      };
    }

    if (!res.ok || !json?.ok) {
      const message =
        json?.error ||
        `HTTP ${res.status} ${res.statusText || "Unknown error from indexer"}`;
      console.error("Indexer returned error", { url, json });
      return {
        utxos: Array.isArray(json?.utxos) ? json.utxos : [],
        error: message,
      };
    }

    const utxos: RawUtxo[] = Array.isArray(json.utxos) ? json.utxos : [];
    return { utxos, error: null };
  } catch (err) {
    console.error("fetchUtxos() failed", { url, err });
    return { utxos: [], error: (err as Error).message };
  }
}
