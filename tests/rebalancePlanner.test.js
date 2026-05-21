import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPortfolioRebalanceSnapshot,
  chooseRebalanceStep,
  portfolioImbalance,
} from '../src/domain/rebalance.js';

test('chooseRebalanceStep holds when the portfolio is already balanced', () => {
  const plan = chooseRebalanceStep({
    bchSats: 100_000_000n,
    stablecoinTokens: 100n,
    oraclePriceRaw: 10_000n,
  });

  assert.equal(plan.direction, 'hold');
  assert.equal(plan.tradeTokens, 0n);
  assert.equal(plan.beforeImbalance, 0n);
  assert.equal(plan.afterImbalance, 0n);
});

test('chooseRebalanceStep sells stablecoin when the portfolio is overweight stablecoin', () => {
  const plan = chooseRebalanceStep({
    bchSats: 100_000_000n,
    stablecoinTokens: 200n,
    oraclePriceRaw: 10_000n,
  });

  assert.equal(plan.direction, 'sell-stablecoin');
  assert.ok(plan.tradeTokens > 0n);
  assert.ok(plan.afterImbalance <= plan.beforeImbalance);
});

test('portfolioImbalance increases when a rebalance moves away from the target', () => {
  const before = portfolioImbalance({
    bchSats: 100_000_000n,
    stablecoinTokens: 110n,
    oraclePriceRaw: 10_000n,
  });
  const after = portfolioImbalance({
    bchSats: 100_000_000n,
    stablecoinTokens: 200n,
    oraclePriceRaw: 10_000n,
  });

  assert.ok(after > before);
});

test('buildPortfolioRebalanceSnapshot includes target weights and formatted guidance', () => {
  const summary = buildPortfolioRebalanceSnapshot({
    bchSats: 100_000_000n,
    stablecoinTokens: 150n,
    oraclePriceRaw: 10_000n,
  });

  assert.equal(summary.totalUsd, 250n);
  assert.equal(summary.targetUsd, 125n);
  assert.equal(summary.bchWeightBps, 4000n);
  assert.equal(summary.stableWeightBps, 6000n);
  assert.match(summary.formatted.headline, /Sell stablecoin|Buy stablecoin|No rebalance/);
});
