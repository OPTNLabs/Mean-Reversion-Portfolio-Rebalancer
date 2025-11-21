// tests/priceCodec.test.js
//
// Unit tests for oracles/priceCodec.js
// - Validates decode of a known oracle payload from General Protocols
// - Ensures encode/roundtrip behaviour is correct

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
const KNOWN_VALUES = {
  timestamp: 1763662906, // 2025-11-20T18:21:46.000Z
  messageSequence: 1409799,
  dataSequence: 1409773,
  priceRaw: 47622,
  priceScale: 100,
  priceValue: 476.22,
};

test("priceCodec: decodePriceMessageHex decodes known oracle payload", () => {
  const decoded = decodePriceMessageHex(KNOWN_MESSAGE_HEX);

  assert.equal(decoded.timestamp, KNOWN_VALUES.timestamp);
  assert.equal(decoded.messageSequence, KNOWN_VALUES.messageSequence);
  assert.equal(decoded.dataSequence, KNOWN_VALUES.dataSequence);
  assert.equal(decoded.priceRaw, KNOWN_VALUES.priceRaw);
  assert.equal(decoded.priceScale, KNOWN_VALUES.priceScale);
  assert.equal(decoded.priceValue, KNOWN_VALUES.priceValue);
  assert.equal(decoded.priceScale, DEFAULT_PRICE_SCALE);
});

test("priceCodec: decodePriceMessage decodes from raw bytes", () => {
  const buf = Buffer.from(KNOWN_MESSAGE_HEX, "hex");
  const decoded = decodePriceMessage(buf);

  assert.equal(decoded.timestamp, KNOWN_VALUES.timestamp);
  assert.equal(decoded.messageSequence, KNOWN_VALUES.messageSequence);
  assert.equal(decoded.dataSequence, KNOWN_VALUES.dataSequence);
  assert.equal(decoded.priceRaw, KNOWN_VALUES.priceRaw);
  assert.equal(decoded.priceValue, KNOWN_VALUES.priceValue);
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

test("priceCodec: encode/decode roundtrip with priceValue is stable", () => {
  const encodedHex = encodePriceMessageHex({
    timestamp: KNOWN_VALUES.timestamp,
    messageSequence: KNOWN_VALUES.messageSequence,
    dataSequence: KNOWN_VALUES.dataSequence,
    priceValue: KNOWN_VALUES.priceValue,
    priceScale: KNOWN_VALUES.priceScale,
  });

  const decoded = decodePriceMessageHex(encodedHex);

  assert.equal(decoded.timestamp, KNOWN_VALUES.timestamp);
  assert.equal(decoded.messageSequence, KNOWN_VALUES.messageSequence);
  assert.equal(decoded.dataSequence, KNOWN_VALUES.dataSequence);
  assert.equal(decoded.priceRaw, KNOWN_VALUES.priceRaw);

  // Allow tiny floating point differences (should normally be exact).
  assert.ok(
    Math.abs(decoded.priceValue - KNOWN_VALUES.priceValue) < 1e-6,
    "decoded.priceValue should match original priceValue"
  );
});
