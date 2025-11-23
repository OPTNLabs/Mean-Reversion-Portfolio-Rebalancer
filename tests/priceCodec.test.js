// tests/priceCodec.test.js
//
// Unit tests for oracles/priceCodec.js
// - Validates decode of a known oracle payload from General Protocols
// - Ensures encode/roundtrip behaviour is correct, using integer priceRaw
//   as the canonical on-wire representation.

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_PRICE_SCALE,
  decodePriceMessage,
  decodePriceMessageHex,
  encodePriceMessage,
  encodePriceMessageHex,
} from "../oracles/priceCodec.js";

const KNOWN_MESSAGE_HEX = "3a5c1f6907831500ed82150006ba0000";

// These are derived from the oracle message spec and confirmed by
// running the live script (scripts/fetchOraclePrice.js).
//
// NOTE: In our codec (Option B), priceRaw/priceValue are the *integer*
// on-wire representation. Human-readable price is derived via:
//   humanPrice = priceRaw / priceScale
const KNOWN_VALUES = {
  timestamp: 1763662906, // 2025-11-20T18:21:46.000Z
  messageSequence: 1409799,
  dataSequence: 1409773,
  priceRaw: 47622,
  priceScale: 100,
};

// For convenience in tests, the human price we expect:
const KNOWN_HUMAN_PRICE = 476.22;

test("priceCodec: decodePriceMessageHex decodes known oracle payload", () => {
  const decoded = decodePriceMessageHex(KNOWN_MESSAGE_HEX);

  assert.equal(decoded.timestamp, KNOWN_VALUES.timestamp);
  assert.equal(decoded.messageSequence, KNOWN_VALUES.messageSequence);
  assert.equal(decoded.dataSequence, KNOWN_VALUES.dataSequence);

  // Canonical integer price
  assert.equal(decoded.priceRaw, KNOWN_VALUES.priceRaw);
  assert.equal(decoded.priceScale, DEFAULT_PRICE_SCALE);

  // In Option B, priceValue is an alias for priceRaw (integer).
  assert.equal(
    decoded.priceValue,
    KNOWN_VALUES.priceRaw,
    "priceValue should be the raw integer price"
  );

  // Human-readable price is derived by scaling:
  const humanPrice = decoded.priceRaw / decoded.priceScale;
  assert.ok(
    Math.abs(humanPrice - KNOWN_HUMAN_PRICE) < 1e-6,
    "scaled human price should match expected"
  );
});

test("priceCodec: decodePriceMessage decodes from raw bytes", () => {
  const buf = Buffer.from(KNOWN_MESSAGE_HEX, "hex");
  const decoded = decodePriceMessage(buf);

  assert.equal(decoded.timestamp, KNOWN_VALUES.timestamp);
  assert.equal(decoded.messageSequence, KNOWN_VALUES.messageSequence);
  assert.equal(decoded.dataSequence, KNOWN_VALUES.dataSequence);

  assert.equal(decoded.priceRaw, KNOWN_VALUES.priceRaw);
  assert.equal(decoded.priceValue, KNOWN_VALUES.priceRaw);

  const humanPrice = decoded.priceRaw / decoded.priceScale;
  assert.ok(
    Math.abs(humanPrice - KNOWN_HUMAN_PRICE) < 1e-6,
    "scaled human price should match expected"
  );
});

test("priceCodec: encodePriceMessage with priceRaw reproduces known hex", () => {
  const hex = encodePriceMessageHex({
    timestamp: KNOWN_VALUES.timestamp,
    messageSequence: KNOWN_VALUES.messageSequence,
    dataSequence: KNOWN_VALUES.dataSequence,
    priceRaw: KNOWN_VALUES.priceRaw,
  });

  assert.equal(
    hex,
    KNOWN_MESSAGE_HEX,
    "encodePriceMessageHex should match the known oracle message hex"
  );

  const bytes = encodePriceMessage({
    timestamp: KNOWN_VALUES.timestamp,
    messageSequence: KNOWN_VALUES.messageSequence,
    dataSequence: KNOWN_VALUES.dataSequence,
    priceRaw: KNOWN_VALUES.priceRaw,
  });

  assert.equal(Buffer.from(bytes).toString("hex"), KNOWN_MESSAGE_HEX);
});

test("priceCodec: encode/decode roundtrip with priceValue is stable (integer canonical)", () => {
  // Here we exercise the priceValue path in encode(), but remember that
  // in Option B, priceValue is *also* integer in the decoded result.
  //
  // We still allow callers to pass a human float, but the decoded
  // priceValue is always the raw integer. Human price must be
  // derived by scaling.
  const encodedHex = encodePriceMessageHex({
    timestamp: KNOWN_VALUES.timestamp,
    messageSequence: KNOWN_VALUES.messageSequence,
    dataSequence: KNOWN_VALUES.dataSequence,
    // Callers may pass a float priceValue; with priceScale=100 this
    // should round to priceRaw=47622.
    priceValue: KNOWN_HUMAN_PRICE,
    priceScale: KNOWN_VALUES.priceScale,
  });

  const decoded = decodePriceMessageHex(encodedHex);

  // Wire integer must match
  assert.equal(decoded.priceRaw, KNOWN_VALUES.priceRaw);
  assert.equal(decoded.priceValue, KNOWN_VALUES.priceRaw);

  const humanPrice = decoded.priceRaw / decoded.priceScale;
  assert.ok(
    Math.abs(humanPrice - KNOWN_HUMAN_PRICE) < 1e-6,
    "scaled human price should match original human price"
  );
});
