// oracles/priceCodec.js
//
// Encoding/decoding helper for General Protocols oracle price messages.
//
// Current GP BCH/USD oracle payload layout (16 bytes, little-endian):
//
//   offset  size    field
//   ------  ----    -----------------------------
//   0       4       timestamp (unix seconds, uint32 LE)
//   4       4       messageSequence (uint32 LE)
//   8       4       dataSequence (uint32 LE)
//   12      4       priceRaw (uint32 LE)
//
// The oracle’s on-chain convention today is typically:
//   priceRaw = price * SCALE  (e.g. SCALE = 100 for 2 decimal places)
//
// In this module we keep `priceRaw` as the canonical integer value, and
// let callers decide how to scale it (via `scalePrice`).
// For convenience and backwards compatibility we also expose:
//   - `messageTimestamp` aliasing `timestamp`
//   - `priceValue` aliasing `priceRaw`
//
// So older callers that did `priceValue / 100` still work.

import { Buffer } from "node:buffer";

const MESSAGE_LENGTH_BYTES = 16;

// Default price scale commonly used: priceRaw = price * DEFAULT_PRICE_SCALE
export const DEFAULT_PRICE_SCALE = 100;

/**
 * Decode a 16-byte oracle message payload (Uint8Array or Buffer).
 *
 * @param {Uint8Array | Buffer} messageBytes
 * @returns {{
 *   timestamp: number,
 *   messageTimestamp: number,
 *   messageSequence: number,
 *   dataSequence: number,
 *   priceRaw: number,
 *   priceScale: number,
 *   priceValue: number
 * }}
 */
export function decodePriceMessage(messageBytes) {
  if (!messageBytes) {
    throw new Error("decodePriceMessage: messageBytes is required");
  }

  // Normalize to Buffer so we can use Node APIs easily.
  const buf =
    messageBytes instanceof Buffer ? messageBytes : Buffer.from(messageBytes);

  if (buf.length !== MESSAGE_LENGTH_BYTES) {
    throw new Error(
      `decodePriceMessage: expected ${MESSAGE_LENGTH_BYTES} bytes, got ${buf.length}`
    );
  }

  // Little-endian uint32s for all four fields.
  const timestamp = buf.readUInt32LE(0);
  const messageSequence = buf.readUInt32LE(4);
  const dataSequence = buf.readUInt32LE(8);
  const priceRaw = buf.readUInt32LE(12);

  const priceScale = DEFAULT_PRICE_SCALE;

  return {
    // Base fields
    timestamp,
    messageTimestamp: timestamp, // alias for convenience
    messageSequence,
    dataSequence,
    priceRaw,
    priceScale,

    // For backwards-compatibility: priceValue is the *raw* integer.
    // Callers should divide by `priceScale` or their own scaling factor.
    priceValue: priceRaw,
  };
}

/**
 * Decode a hex string oracle message (16 bytes -> 32 hex chars).
 *
 * @param {string} messageHex
 * @returns {ReturnType<typeof decodePriceMessage>}
 */
export function decodePriceMessageHex(messageHex) {
  if (typeof messageHex !== "string") {
    throw new Error("decodePriceMessageHex: messageHex must be a string");
  }

  const cleaned = messageHex.startsWith("0x")
    ? messageHex.slice(2)
    : messageHex;

  const buf = Buffer.from(cleaned, "hex");
  return decodePriceMessage(buf);
}

/**
 * Encode an oracle price payload into bytes (Uint8Array, 16 bytes).
 *
 * You can either:
 *   - Provide `priceRaw` directly, OR
 *   - Provide `priceValue` + optional `priceScale` (default 100).
 *
 * @param {{
 *   timestamp: number,
 *   messageSequence: number,
 *   dataSequence: number,
 *   priceRaw?: number,
 *   priceValue?: number,
 *   priceScale?: number
 * }} params
 * @returns {Uint8Array}
 */
export function encodePriceMessage(params) {
  if (!params) {
    throw new Error("encodePriceMessage: params are required");
  }

  const {
    timestamp,
    messageSequence,
    dataSequence,
    priceRaw,
    priceValue,
    priceScale = DEFAULT_PRICE_SCALE,
  } = params;

  if (
    typeof timestamp !== "number" ||
    typeof messageSequence !== "number" ||
    typeof dataSequence !== "number"
  ) {
    throw new Error(
      "encodePriceMessage: timestamp, messageSequence, dataSequence must be numbers"
    );
  }

  let raw;
  if (typeof priceRaw === "number") {
    raw = priceRaw;
  } else if (typeof priceValue === "number") {
    raw = Math.round(priceValue * priceScale);
  } else {
    throw new Error(
      "encodePriceMessage: either priceRaw or priceValue must be provided"
    );
  }

  if (!Number.isInteger(raw) || raw < 0) {
    throw new Error(
      "encodePriceMessage: priceRaw must be a non-negative integer"
    );
  }

  const buf = Buffer.allocUnsafe(MESSAGE_LENGTH_BYTES);
  buf.writeUInt32LE(timestamp >>> 0, 0);
  buf.writeUInt32LE(messageSequence >>> 0, 4);
  buf.writeUInt32LE(dataSequence >>> 0, 8);
  buf.writeUInt32LE(raw >>> 0, 12);

  // Return Uint8Array for general compatibility (still a Buffer underneath).
  return new Uint8Array(buf);
}

/**
 * Encode an oracle price payload into a hex string (lowercase, no 0x prefix).
 *
 * @param {Parameters<typeof encodePriceMessage>[0]} params
 * @returns {string}
 */
export function encodePriceMessageHex(params) {
  const bytes = encodePriceMessage(params);
  return Buffer.from(bytes).toString("hex");
}

/**
 * Convenience helper: scale a raw integer price using a scaling factor.
 *
 * @param {number} priceValue  Raw integer (typically `priceRaw`)
 * @param {number} [scaling]   Scaling factor (e.g. 100 for 2 decimal places)
 * @returns {number}
 */
export function scalePrice(priceValue, scaling = DEFAULT_PRICE_SCALE) {
  if (typeof priceValue !== "number") {
    throw new Error("scalePrice: priceValue must be a number");
  }
  if (typeof scaling !== "number" || scaling <= 0) {
    throw new Error("scalePrice: scaling must be a positive number");
  }
  return priceValue / scaling;
}

/**
 * Convenience helper: convert an oracle timestamp (seconds since epoch)
 * to a JavaScript Date object.
 */
export function oracleTimestampToDate(timestamp) {
  if (typeof timestamp === "bigint") {
    return new Date(Number(timestamp) * 1000);
  }
  return new Date(Number(timestamp) * 1000);
}
