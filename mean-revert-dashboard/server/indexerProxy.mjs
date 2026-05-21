// server/indexerProxy.mjs
//
// Lightweight API for the MRX dashboard:
//  - /api/utxos/:address  -> BCH + CashTokens UTXOs (via ElectrumNetworkProvider)
//  - /api/oracle/latest   -> latest BCH/USD oracle price (via GP oracle)
//
// This reuses the same provider + oracle helper code as your Node scripts.

import express from "express";
import cors from "cors";
import { ElectrumNetworkProvider } from "cashscript";
import { fetchLatestOraclePrice } from "../../oracles/fetchOraclePrice.js";

const app = express();
const PORT = process.env.PORT || 4000;
const NETWORK = process.env.NETWORK || "chipnet";

// You can provide either:
//   ORACLE_PUBLIC_KEY_HEX="03abc..."
// or a comma-separated list:
//   ORACLE_PUBLIC_KEYS="03abc...,02def...,03xyz..."
const SINGLE_KEY = process.env.ORACLE_PUBLIC_KEY_HEX || "";
const MULTI_KEYS = process.env.ORACLE_PUBLIC_KEYS || "";

const ORACLE_KEYS = [
  ...MULTI_KEYS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  ...(SINGLE_KEY ? [SINGLE_KEY] : []),
];

// --- Electrum provider -----------------------------------------------------

const provider = new ElectrumNetworkProvider(NETWORK);

app.use(cors());
app.use(express.json());

// Helper: convert BigInt fields to strings so JSON.stringify works.
function serializeUtxo(u) {
  return {
    ...u,
    satoshis:
      u.satoshis === undefined
        ? undefined
        : typeof u.satoshis === "bigint"
        ? u.satoshis.toString()
        : u.satoshis,
    value:
      u.value === undefined
        ? undefined
        : typeof u.value === "bigint"
        ? u.value.toString()
        : u.value,
    token: u.token
      ? {
          ...u.token,
          amount:
            typeof u.token.amount === "bigint"
              ? u.token.amount.toString()
              : u.token.amount,
          nft: u.token.nft ? { ...u.token.nft } : undefined,
        }
      : undefined,
  };
}

// --- UTXO endpoint ---------------------------------------------------------

app.get("/api/utxos/:address", async (req, res) => {
  const { address } = req.params;
  console.log(`[indexerProxy] /api/utxos/${address}`);

  try {
    const rawUtxos = await provider.getUtxos(address);
    const utxos = rawUtxos.map(serializeUtxo);

    console.log(`[indexerProxy] ok address=${address} utxos=${utxos.length}`);

    res.json({
      ok: true,
      network: NETWORK,
      address,
      utxos,
    });
  } catch (err) {
    console.error("[indexerProxy] error", address, err);

    res.status(500).json({
      ok: false,
      network: NETWORK,
      address,
      utxos: [],
      error:
        err && err.message
          ? err.message
          : "Error from ElectrumNetworkProvider.getUtxos()",
    });
  }
});

// --- Oracle endpoint -------------------------------------------------------
//
// Frontend calls: GET /api/oracle/latest
// Expects JSON:
// {
//   ok: true,
//   priceRaw: number,
//   priceScale: number,
//   priceValue: number,
//   timestamp: number,
//   oraclePubKey: string,
//   source: string,
//   network: string
// }

app.get("/api/oracle/latest", async (_req, res) => {
  console.log("[indexerProxy] /api/oracle/latest");

  if (!ORACLE_KEYS.length) {
    console.warn(
      "[indexerProxy] No oracle keys configured – UI will fall back to config price."
    );
    return res.status(500).json({
      ok: false,
      error:
        "No oracle keys configured. Set ORACLE_PUBLIC_KEY_HEX or ORACLE_PUBLIC_KEYS in the server environment.",
    });
  }

  let lastError = null;

  for (const key of ORACLE_KEYS) {
    try {
      const snap = await fetchLatestOraclePrice({ publicKey: key });

      // Flatten the fields to match src/api/demo.ts expectations.
      return res.json({
        ok: true,
        network: NETWORK,
        source: "general-protocols-oracle",
        oraclePubKey: snap.oraclePubKey,
        priceRaw: snap.priceRaw,
        priceScale: snap.priceScale,
        priceValue: snap.priceValue,
        timestamp: snap.timestamp,
        snapshot: snap, // keep the full thing for debugging
      });
    } catch (err) {
      console.error("[indexerProxy] oracle error for key", key, err);
      lastError = err;
      // try next key (if any)
    }
  }

  res.status(500).json({
    ok: false,
    error:
      lastError && lastError.message
        ? lastError.message
        : "Failed to fetch price from any configured oracle key",
  });
});

// --------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`indexerProxy listening on http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK}`);
  if (!ORACLE_KEYS.length) {
    console.log(
      "WARNING: No oracle keys configured – /api/oracle/latest will error and the UI will use the config fallback."
    );
  } else {
    console.log("Oracle keys configured:", ORACLE_KEYS.length);
  }
});
