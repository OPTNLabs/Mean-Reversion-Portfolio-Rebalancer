import {
  MAX_SLIPPAGE_BPS,
  MAX_TRADE_BPS,
  MIN_TRADE_SATS,
} from '../../config.js';

const BCH_SCALE_DOWN = 10_000n;
const PRICE_SCALE = 100n;
const CONTRACT_PRICE_DENOMINATOR = BCH_SCALE_DOWN * BCH_SCALE_DOWN * PRICE_SCALE;

function absBigInt(value) {
  return value < 0n ? -value : value;
}

export function bchValueUsdFromSats(bchSats, oraclePriceRaw) {
  const bchScaled = bchSats / BCH_SCALE_DOWN;
  return (bchScaled * oraclePriceRaw) / BCH_SCALE_DOWN / PRICE_SCALE;
}

export function portfolioUsdValue({ bchSats, stablecoinTokens, oraclePriceRaw }) {
  return bchValueUsdFromSats(bchSats, oraclePriceRaw) + stablecoinTokens;
}

export function portfolioImbalance({ bchSats, stablecoinTokens, oraclePriceRaw }) {
  return absBigInt(
    bchValueUsdFromSats(bchSats, oraclePriceRaw) - stablecoinTokens
  );
}

function clampTradeStep(stepTokens, { maxTradeTokens, minTradeSats, oraclePriceRaw, availableBchSats, availableStablecoinTokens, direction }) {
  let nextStep = stepTokens < 0n ? 0n : stepTokens;

  if (maxTradeTokens > 0n && nextStep > maxTradeTokens) {
    nextStep = maxTradeTokens;
  }

  if (direction === 'buy-stablecoin') {
    const maxByBch = (availableBchSats * oraclePriceRaw) / CONTRACT_PRICE_DENOMINATOR;
    if (nextStep > maxByBch) nextStep = maxByBch;
  }

  if (direction === 'sell-stablecoin' && nextStep > availableStablecoinTokens) {
    nextStep = availableStablecoinTokens;
  }

  if (nextStep <= 0n) return 0n;

  const estimatedInputSats = (nextStep * CONTRACT_PRICE_DENOMINATOR) / oraclePriceRaw;

  if (estimatedInputSats < minTradeSats) return 0n;
  return nextStep;
}

export function chooseRebalanceStep({
  bchSats,
  stablecoinTokens,
  oraclePriceRaw,
  maxSlippageBps = MAX_SLIPPAGE_BPS,
  maxTradeBps = MAX_TRADE_BPS,
  minTradeSats = MIN_TRADE_SATS,
}) {
  if (oraclePriceRaw <= 0n) {
    return {
      direction: 'hold',
      reason: 'Oracle price unavailable',
      tradeTokens: 0n,
      expectedInputSats: 0n,
      beforeImbalance: 0n,
      afterImbalance: 0n,
      slippageBps: 0,
      maxSlippageBps,
    };
  }

  const bchUsd = bchValueUsdFromSats(bchSats, oraclePriceRaw);
  const beforeImbalance = absBigInt(bchUsd - stablecoinTokens);
  if (beforeImbalance === 0n) {
    return {
      direction: 'hold',
      reason: 'Already at the target balance',
      tradeTokens: 0n,
      expectedInputSats: 0n,
      beforeImbalance,
      afterImbalance: beforeImbalance,
      slippageBps: 0,
      maxSlippageBps,
    };
  }

  const direction =
    stablecoinTokens > bchUsd ? 'sell-stablecoin' : 'buy-stablecoin';
  const gap = absBigInt(stablecoinTokens - bchUsd);
  const targetStep = gap / 2n > 0n ? gap / 2n : 1n;
  const portfolioValueUsd = portfolioUsdValue({
    bchSats,
    stablecoinTokens,
    oraclePriceRaw,
  });
  const maxTradeTokens = (portfolioValueUsd * BigInt(maxTradeBps)) / 10_000n;

  const tradeTokens = clampTradeStep(targetStep, {
    maxTradeTokens,
    minTradeSats,
    oraclePriceRaw,
    availableBchSats: bchSats,
    availableStablecoinTokens: stablecoinTokens,
    direction,
  });

  if (tradeTokens <= 0n) {
    return {
      direction: 'hold',
      reason: 'Trade step fell below the minimum or exceeded guardrails',
      tradeTokens: 0n,
      expectedInputSats: 0n,
      beforeImbalance,
      afterImbalance: beforeImbalance,
      slippageBps: 0,
      maxSlippageBps,
    };
  }

  const expectedInputSats =
    direction === 'buy-stablecoin'
      ? (tradeTokens * CONTRACT_PRICE_DENOMINATOR) / oraclePriceRaw
      : tradeTokens;

  const expectedTradeValueUsd = tradeTokens;
  const afterImbalance = absBigInt(
    bchValueUsdFromSats(
      direction === 'buy-stablecoin' ? bchSats - expectedInputSats : bchSats + expectedInputSats,
      oraclePriceRaw
    ) -
      (direction === 'buy-stablecoin'
        ? stablecoinTokens + tradeTokens
        : stablecoinTokens - tradeTokens)
  );

  return {
    direction,
    reason:
      direction === 'buy-stablecoin'
        ? 'BCH is overweight versus the stablecoin'
        : 'Stablecoin is overweight versus BCH',
    tradeTokens,
    expectedInputSats,
    expectedTradeValueUsd,
    beforeImbalance,
    afterImbalance,
    slippageBps: Math.min(maxSlippageBps, 25),
    maxSlippageBps,
    maxTradeBps,
  };
}

export function buildPortfolioRebalanceSnapshot({
  bchSats,
  stablecoinTokens,
  oraclePriceRaw,
  maxSlippageBps = MAX_SLIPPAGE_BPS,
  maxTradeBps = MAX_TRADE_BPS,
  minTradeSats = MIN_TRADE_SATS,
}) {
  const plan = chooseRebalanceStep({
    bchSats,
    stablecoinTokens,
    oraclePriceRaw,
    maxSlippageBps,
    maxTradeBps,
    minTradeSats,
  });
  const bchUsd = bchValueUsdFromSats(bchSats, oraclePriceRaw);
  const stablecoinUsd = stablecoinTokens;
  const totalUsd = portfolioUsdValue({
    bchSats,
    stablecoinTokens,
    oraclePriceRaw,
  });
  const targetUsd = totalUsd / 2n;
  const bchWeightBps = totalUsd > 0n ? (bchUsd * 10_000n) / totalUsd : 0n;
  const stableWeightBps = totalUsd > 0n ? (stablecoinUsd * 10_000n) / totalUsd : 0n;

  return {
    ...plan,
    bchUsd,
    stablecoinUsd,
    totalUsd,
    targetUsd,
    bchWeightBps,
    stableWeightBps,
    targetStablecoinTokens: targetUsd,
    formatted: formatRebalancePlan(plan),
  };
}

export function formatRebalancePlan(plan) {
  if (!plan || plan.direction === 'hold') {
    return {
      headline: 'No rebalance',
      details: plan?.reason ?? 'No action required',
    };
  }

  return {
    headline:
      plan.direction === 'buy-stablecoin'
        ? 'Buy stablecoin with BCH'
        : 'Sell stablecoin for BCH',
    details: [
      `Step: ${plan.tradeTokens.toString()} tokens`,
      `Expected input: ${plan.expectedInputSats.toString()} sats`,
      `Imbalance: ${plan.beforeImbalance.toString()} -> ${plan.afterImbalance.toString()}`,
      `Slippage cap: ${plan.maxSlippageBps} bps`,
    ].join(' | '),
  };
}
