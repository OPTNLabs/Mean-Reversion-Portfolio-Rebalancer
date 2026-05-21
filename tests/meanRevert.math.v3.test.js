// tests/meanRevert.math.v3.test.js
// Pure math tests for value-based mean reversion (1:1 BCH:stablecoin in USD terms)

import test from "node:test";
import assert from "node:assert/strict";

// These must match the contract:
//   oldBchScaled = oldBch / 10_000
//   bchValue     = (oldBchScaled * oraclePriceRaw) / 10_000 / 100
const BCH_SCALE_DOWN = 10_000n; // must match contract's /10000
const PRICE_SCALE = 100n; // oraclePriceRaw = USD/BCH * 100

function bchValueUsd(bchSats, oraclePriceRaw) {
  const bchScaled = bchSats / BCH_SCALE_DOWN;
  return (bchScaled * oraclePriceRaw) / BCH_SCALE_DOWN / PRICE_SCALE;
}

function imbalance(bchSats, tokens, oraclePriceRaw) {
  const lhs = bchValueUsd(bchSats, oraclePriceRaw); // BCH side in USD-ish units
  const rhs = tokens; // tokens represent whole USD
  let d = lhs - rhs;
  if (d < 0n) d = -d;
  return d;
}

function isRebalanceAllowed({
  bchIn,
  tokensIn,
  bchOut,
  tokensOut,
  oraclePriceRaw,
}) {
  if (oraclePriceRaw <= 0n) return false;

  const before = imbalance(bchIn, tokensIn, oraclePriceRaw);
  const after = imbalance(bchOut, tokensOut, oraclePriceRaw);

  // V3 rule: must not move further away
  return after <= before;
}

test("Mean-revert 1:1 BCH:stable (math only)", async (t) => {
  await t.test(
    "exactly balanced portfolio stays allowed (no-op rebalance)",
    () => {
      // 1 BCH, price = $100, 100 stablecoins
      const bch = 100_000_000n; // 1 BCH in sats
      const price = 10_000n; // 100.00 USD/BCH (scale=100)
      const tokens = 100n; // 100 USD stable

      assert.equal(
        isRebalanceAllowed({
          bchIn: bch,
          tokensIn: tokens,
          bchOut: bch,
          tokensOut: tokens,
          oraclePriceRaw: price,
        }),
        true
      );
    }
  );

  await t.test("moving closer to 1:1 is allowed", () => {
    // 1 BCH @ $100 = $100 in BCH
    // Start: 200 stable (overweight stable side)
    // Target-ish: 120 stable (closer to 1:1)
    const bch = 100_000_000n;
    const price = 10_000n; // 100.00 USD/BCH

    const tokensBefore = 200n;
    const tokensAfter = 120n;

    const allowed = isRebalanceAllowed({
      bchIn: bch,
      tokensIn: tokensBefore,
      bchOut: bch,
      tokensOut: tokensAfter,
      oraclePriceRaw: price,
    });

    assert.equal(allowed, true);
  });

  await t.test("moving further away from 1:1 is rejected", () => {
    const bch = 100_000_000n;
    const price = 10_000n; // 100.00 USD/BCH

    // Start already pretty close: BCH ~ $100, tokens = 110
    const tokensBefore = 110n;
    const tokensAfter = 200n; // way more imbalanced

    const allowed = isRebalanceAllowed({
      bchIn: bch,
      tokensIn: tokensBefore,
      bchOut: bch,
      tokensOut: tokensAfter,
      oraclePriceRaw: price,
    });

    assert.equal(allowed, false);
  });

  await t.test(
    "changing BCH and tokens but improving 1:1 ratio is allowed",
    () => {
      // Example: portfolio adds BCH and removes stable to get closer
      const price = 20_000n; // 200.00 USD/BCH

      const bchBefore = 100_000_000n; // 1 BCH = $200
      const tokensBefore = 500n; // $500 stable (unbalanced)

      const bchAfter = 200_000_000n; // 2 BCH = $400
      const tokensAfter = 450n; // $450 stable, much closer

      const allowed = isRebalanceAllowed({
        bchIn: bchBefore,
        tokensIn: tokensBefore,
        bchOut: bchAfter,
        tokensOut: tokensAfter,
        oraclePriceRaw: price,
      });

      assert.equal(allowed, true);
    }
  );

  await t.test("oraclePriceRaw must be > 0", () => {
    const bch = 100_000_000n;
    const tokens = 100n;

    assert.equal(
      isRebalanceAllowed({
        bchIn: bch,
        tokensIn: tokens,
        bchOut: bch,
        tokensOut: tokens,
        oraclePriceRaw: 0n,
      }),
      false
    );

    assert.equal(
      isRebalanceAllowed({
        bchIn: bch,
        tokensIn: tokens,
        bchOut: bch,
        tokensOut: tokens,
        oraclePriceRaw: -1n,
      }),
      false
    );
  });
});
