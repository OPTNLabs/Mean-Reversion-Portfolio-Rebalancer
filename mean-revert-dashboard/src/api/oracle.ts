// src/api/oracle.ts
//
// Fetch the latest oracle priceRaw from the local Node backend.

const INDEXER_BASE_URL =
  (import.meta.env.VITE_INDEXER_BASE_URL as string | undefined) ??
  "http://localhost:4000";

export interface OraclePriceResult {
  ok: boolean;
  priceRaw: string | null;
  error?: string;
}

export async function fetchOraclePriceRaw(): Promise<OraclePriceResult> {
  const url = `${INDEXER_BASE_URL}/api/oracle-price`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const json = await res.json();

    if (!res.ok || !json?.ok || !json.priceRaw) {
      return {
        ok: false,
        priceRaw: json?.priceRaw ?? null,
        error:
          json?.error ||
          `HTTP ${res.status} ${res.statusText || "Unknown oracle error"}`,
      };
    }

    return { ok: true, priceRaw: String(json.priceRaw) };
  } catch (err: any) {
    return {
      ok: false,
      priceRaw: null,
      error: err?.message ?? String(err),
    };
  }
}
