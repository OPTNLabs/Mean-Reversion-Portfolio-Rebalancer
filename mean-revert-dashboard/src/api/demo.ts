// src/api/demo.ts
//
// Fetch a small "demo summary" of the BCH/USD price for the MRX dashboard.
// - Tries the local backend at /api/oracle/latest (General Protocols oracle).
// - On error, falls back to the static config PRICE_RAW.

import { PRICE_RAW } from "../meanRevertConfig";

export type DemoSummary = {
  source: "oracle" | "fallback";
  priceRaw: number;
  priceScale: number;
  priceUsd: number; // decoded price (BCH in USD)
  timestamp: number | null; // unix seconds
  error?: string | null;
};

const API_BASE =
  (import.meta.env.VITE_INDEXER_BASE_URL as string | undefined) ??
  "http://localhost:4000";

export async function fetchDemoSummary(): Promise<DemoSummary> {
  const url = `${API_BASE}/api/oracle/latest`;

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
      console.error("Failed to parse oracle JSON", { url, text });
      throw new Error((parseErr as Error).message);
    }

    if (!res.ok || !json?.ok) {
      const message =
        json?.error ||
        `HTTP ${res.status} ${
          res.statusText || "Unknown error from /api/oracle/latest"
        }`;
      console.error("Oracle endpoint returned error", { url, json });
      throw new Error(message);
    }

    const priceRaw = Number(json.priceRaw);
    const priceScale = Number(json.priceScale || 100);
    const priceUsd = Number(json.priceValue ?? priceRaw / priceScale);

    return {
      source: "oracle",
      priceRaw,
      priceScale,
      priceUsd,
      timestamp: typeof json.timestamp === "number" ? json.timestamp : null,
      error: null,
    };
  } catch (err) {
    console.error("fetchDemoSummary() falling back to config price", err);

    // Fallback: use the static PRICE_RAW from meanRevertConfig with scale 100.
    const fallbackScale = 100;
    const raw =
      typeof PRICE_RAW === "number" && !Number.isNaN(PRICE_RAW)
        ? PRICE_RAW
        : 10000;

    return {
      source: "fallback",
      priceRaw: raw,
      priceScale: fallbackScale,
      priceUsd: raw / fallbackScale,
      timestamp: null,
      error: (err as Error).message,
    };
  }
}
