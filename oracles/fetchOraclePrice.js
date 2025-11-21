// oracles/fetchOraclePrice.js
//
// Shared helper to fetch & decode the latest oracle price message
// from General Protocols' price oracle.
//
// Uses:
//   - REST API: /api/v1/oracleMessages
//   - priceCodec.decodePriceMessageHex for decoding the payload
//
// Returns a rich "snapshot" object:
//
// {
//   oraclePubKey: string,
//   rawMessage: string,
//   signature: string,
//   messageSequence: number,
//   dataSequence: number,
//   timestamp: number,     // unix seconds
//   priceRaw: number,
//   priceScale: number,    // e.g. 100
//   priceValue: number     // priceRaw / priceScale
// }
//
// This is designed to be reused by both:
//   - scripts/fetchOraclePrice.js (CLI)
//   - scripts/meanRevert.oracleRebalancer.js (strategy daemon)

import { decodePriceMessageHex } from "./priceCodec.js";

const DEFAULT_API_BASE = "https://oracles.generalprotocols.com";

/**
 * Fetch the latest oracle price for a given oracle public key.
 *
 * @param {object} opts
 * @param {string} opts.publicKey - Oracle compressed pubkey (hex)
 * @param {string} [opts.apiBaseUrl] - Override API base (for testing/self-host)
 */
export async function fetchLatestOraclePrice({
  publicKey,
  apiBaseUrl = DEFAULT_API_BASE,
} = {}) {
  if (!publicKey) {
    throw new Error("fetchLatestOraclePrice: 'publicKey' is required");
  }

  const url = `${apiBaseUrl}/api/v1/oracleMessages?publicKey=${publicKey}&count=1`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Oracle API error (${res.status}): ${res.statusText} ${text}`
    );
  }

  const json = await res.json();

  if (
    !json ||
    !Array.isArray(json.oracleMessages) ||
    json.oracleMessages.length === 0
  ) {
    throw new Error("Oracle API returned no messages for this public key");
  }

  const latest = json.oracleMessages[0];

  const messageHex = latest.message;
  const signatureHex = latest.signature;

  const decoded = decodePriceMessageHex(messageHex);

  const priceValue = decoded.priceRaw / decoded.priceScale;

  return {
    oraclePubKey: publicKey,
    rawMessage: messageHex,
    signature: signatureHex,
    messageSequence: decoded.messageSequence,
    dataSequence: decoded.dataSequence,
    timestamp: decoded.timestamp,
    priceRaw: decoded.priceRaw,
    priceScale: decoded.priceScale,
    priceValue,
  };
}
