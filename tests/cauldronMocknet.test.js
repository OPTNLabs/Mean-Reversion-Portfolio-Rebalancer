import test from 'node:test';
import assert from 'node:assert/strict';

import { createMockCauldronFixture, quoteConstantProductSwap } from '../src/mocknet/cauldronFixture.js';
import { createCauldronAdapter } from '../src/adapters/cauldron.js';

test('mock cauldron fixture seeds multiple live-shaped pools and swap previews', async () => {
  const fixture = createMockCauldronFixture({
    poolCount: 3,
    poolReserveBchSats: 100_000_000n,
    poolReserveTokens: 1_000n,
    traderBchSats: 50_000_000n,
    traderTokens: 250n,
    oraclePriceRaw: 12_500n,
  });

  const snapshot = fixture.snapshot();
  assert.equal(snapshot.pools.length, 3);
  assert.equal(snapshot.trader.bchSats, 50_000_000n);
  assert.equal(snapshot.trader.tokenSats, 250n);

  const pools = fixture.listActivePools();
  assert.equal(pools.length, 3);
  assert.equal(pools[0].token_id, fixture.state.tokenId);
  assert.ok(pools[1].sats > pools[0].sats);

  const bestPool = fixture.findBestPool('bch-to-token', 10_000_000n);
  assert.ok(bestPool);
  assert.ok(pools.some((pool) => pool.pool_id === bestPool.pool.poolId));

  const preview = fixture.buildSwapPreview({
    direction: 'bch-to-token',
    amountIn: 10_000_000n,
  });
  assert.equal(preview.type, 'swap');
  assert.equal(preview.inputs.length, 2);
  assert.equal(preview.outputs.length, 3);
  assert.ok(preview.quote.amountOut > 0n);

  const liquidityPreview = fixture.buildLiquidityPreview({
    poolId: pools[0].pool_id,
    action: 'add-liquidity',
    bchAmount: 1_000_000n,
    tokenAmount: 10n,
  });
  assert.equal(liquidityPreview.type, 'add-liquidity');
  assert.equal(liquidityPreview.outputs.length, 2);

  const quote = quoteConstantProductSwap({
    reserveIn: 100_000_000n,
    reserveOut: 1_000n,
    amountIn: 10_000_000n,
    feeBps: 30,
  });
  assert.ok(quote.amountOut > 0n);
  assert.ok(quote.nextReserveIn > 100_000_000n);

  const adapter = createCauldronAdapter({ mode: 'mock', fixture });
  const market = await adapter.getMarketSnapshot();
  assert.equal(market.ok, true);
  assert.equal(market.mode, 'mock');
  assert.equal(market.pools.length, 3);
  assert.equal(market.poolId, fixture.state.poolId);
  assert.equal(market.primaryPool.pool_id, fixture.state.primaryPoolId);
  assert.equal(market.indexedTokens.length, 1);
});
