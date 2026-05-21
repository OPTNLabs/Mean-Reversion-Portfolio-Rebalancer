// oracles/oraclesClient.js
// Thin client for interacting with https://oracles.cash / oracles.generalprotocols.com
//
// Uses the General Protocols REST API as documented at:
// https://oracles.cash/api-docs

import {
  decodePriceMessageHex,
  oracleTimestampToDate,
  scalePrice,
} from "./priceCodec.js";

/**
 * Default oracle base URL.
 * You can point this at a local mirror or staging instance if needed.
 */
export const DEFAULT_ORACLES_BASE_URL = "https://oracles.generalprotocols.com";

/**
 * Default oracle public key.
 *
 * This is the example key used in the public docs; in practice we’ll
 * likely stick with the BCH/USD oracle or make this configurable.
 */
export const GP_BCH_USD_ORACLE_PUBKEY =
  "02d09db08af1ff4e8453919cc866a4be427d7bfe18f2c05e5444c196fcf6fd2818";

/**
 * @typedef {Object} OracleHttpClientOptions
 * @property {string} [baseUrl]   Base URL (default: DEFAULT_ORACLES_BASE_URL)
 * @property {typeof fetch} [fetchImpl] Custom fetch implementation (optional)
 */

/**
 * Internal helper: GET JSON from the oracle service.
 *
 * @param {string} pathWithQuery e.g. `/api/v1/oracles`
 * @param {OracleHttpClientOptions} opts
 */
async function httpGetJson(pathWithQuery, opts = {}) {
  const { baseUrl = DEFAULT_ORACLES_BASE_URL, fetchImpl } = opts;
  const f = fetchImpl ?? globalThis.fetch;

  if (typeof f !== "function") {
    throw new Error(
      "No global fetch available. Use Node 18+ or pass fetchImpl explicitly."
    );
  }

  const url = `${baseUrl}${pathWithQuery}`;
  const res = await f(url);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Oracle HTTP error ${res.status} ${res.statusText}: ${text}`.trim()
    );
  }

  return res.json();
}

/**
 * Fetch the list of available oracles.
 *
 * Wraps: GET /api/v1/oracles
 *
 * @param {OracleHttpClientOptions} [opts]
 * @returns {Promise<any>} Raw JSON response from the API.
 */
export async function listOracles(opts = {}) {
  return httpGetJson("/api/v1/oracles", opts);
}

/**
 * @typedef {Object} OracleMessageRecord
 * @property {string} message   Hex-encoded oracle message
 * @property {string} publicKey Compressed secp256k1 public key (33 bytes, hex)
 * @property {string} signature Compact signature (64 bytes, hex)
 */

/**
 * Fetch recent raw oracle messages for a particular oracle public key.
 *
 * Wraps: GET /api/v1/oracleMessages
 *
 * @param {Object} params
 * @param {string} params.publicKey Oracle public key (hex, compressed)
 * @param {number} [params.count]   Max number of messages to retrieve (default: 1)
 * @param {number} [params.minMessageTimestamp]
 * @param {number} [params.maxMessageTimestamp]
 * @param {number} [params.minMessageSequence]
 * @param {number} [params.maxMessageSequence]
 * @param {OracleHttpClientOptions} [params.http]
 * @returns {Promise<OracleMessageRecord[]>}
 */
export async function fetchOracleMessages(params) {
  const {
    publicKey,
    count = 1,
    minMessageTimestamp,
    maxMessageTimestamp,
    minMessageSequence,
    maxMessageSequence,
    http = {},
  } = params;

  if (!publicKey) {
    throw new Error("publicKey is required to fetch oracle messages");
  }

  const qs = new URLSearchParams();
  qs.set("publicKey", publicKey);
  if (count) qs.set("count", String(count));
  if (minMessageTimestamp !== undefined)
    qs.set("minMessageTimestamp", String(minMessageTimestamp));
  if (maxMessageTimestamp !== undefined)
    qs.set("maxMessageTimestamp", String(maxMessageTimestamp));
  if (minMessageSequence !== undefined)
    qs.set("minMessageSequence", String(minMessageSequence));
  if (maxMessageSequence !== undefined)
    qs.set("maxMessageSequence", String(maxMessageSequence));

  const data = await httpGetJson(
    `/api/v1/oracleMessages?${qs.toString()}`,
    http
  );

  const messages = data.oracleMessages ?? data;
  if (!Array.isArray(messages)) {
    throw new Error("Unexpected oracleMessages response shape");
  }

  return /** @type {OracleMessageRecord[]} */ (messages);
}

/**
 * Fetch the latest raw oracle message for a given oracle.
 *
 * @param {Object} params
 * @param {string} [params.publicKey] Oracle public key (default: GP_BCH_USD_ORACLE_PUBKEY)
 * @param {OracleHttpClientOptions} [params.http]
 * @returns {Promise<OracleMessageRecord>}
 */
export async function fetchLatestRawPriceMessage(params = {}) {
  const { publicKey = GP_BCH_USD_ORACLE_PUBKEY, http = {} } = params;

  const messages = await fetchOracleMessages({
    publicKey,
    count: 1,
    http,
  });

  if (!messages.length) {
    throw new Error("No oracle messages returned");
  }

  return messages[0];
}

/**
 * @typedef {Object} DecodedOraclePrice
 * @property {string} oraclePublicKey
 * @property {string} messageHex
 * @property {string} signatureHex
 * @property {number} messageTimestamp
 * @property {Date}   messageDate
 * @property {number} messageSequence
 * @property {number} dataSequence
 * @property {number} priceValue     Raw integer price (e.g. 47622 ≈ 476.22 USD/BCH with scaling=100)
 * @property {number} scaling        Scaling factor
 * @property {number} price          Scaled price (e.g. USD per BCH)
 */

/**
 * Fetch and decode the latest price message for an oracle.
 *
 * This:
 *   1. Calls GET /api/v1/oracleMessages?publicKey=...&count=1
 *   2. Decodes the binary `message` using priceCodec
 *   3. Applies a simple scaling factor (default 100)
 *
 * Later we can:
 *   - Parse metadata messages to derive scaling automatically.
 *   - Verify signatures using @bitauth/libauth and the oracle public key.
 *
 * @param {Object} params
 * @param {string} [params.publicKey] Oracle public key (default: GP_BCH_USD_ORACLE_PUBKEY)
 * @param {number} [params.scaling]   Price scaling factor (default: 100)
 * @param {OracleHttpClientOptions} [params.http]
 * @returns {Promise<DecodedOraclePrice>}
 */
export async function fetchLatestDecodedPrice(params = {}) {
  const {
    publicKey = GP_BCH_USD_ORACLE_PUBKEY,
    scaling = 100,
    http = {},
  } = params;

  const raw = await fetchLatestRawPriceMessage({ publicKey, http });
  const decoded = decodePriceMessageHex(raw.message);

  // decoded.priceValue is the raw integer (e.g. 47622)
  const price = scalePrice(decoded.priceValue, scaling);

  return {
    oraclePublicKey: raw.publicKey,
    messageHex: raw.message,
    signatureHex: raw.signature,
    messageTimestamp: decoded.messageTimestamp,
    messageDate: oracleTimestampToDate(decoded.messageTimestamp),
    messageSequence: decoded.messageSequence,
    dataSequence: decoded.dataSequence,
    priceValue: decoded.priceValue,
    scaling,
    price,
  };
}

/**
 * Lightweight helper used by CLI scripts:
 *
 * Returns:
 *   {
 *     oraclePublicKey: string,
 *     messageHex: string,
 *     raw: OracleMessageRecord
 *   }
 *
 * This matches what scripts like `rebalanceWithOracleV2.js` expect.
 *
 * @param {Object} params
 * @param {string} [params.oraclePublicKey] Oracle public key (default: GP_BCH_USD_ORACLE_PUBKEY)
 * @param {OracleHttpClientOptions} [params.http]
 */
export async function getLatestPriceMessageForOracle(params = {}) {
  const { oraclePublicKey = GP_BCH_USD_ORACLE_PUBKEY, http = {} } = params;

  const raw = await fetchLatestRawPriceMessage({
    publicKey: oraclePublicKey,
    http,
  });

  return {
    oraclePublicKey: raw.publicKey,
    messageHex: raw.message,
    raw,
  };
}
