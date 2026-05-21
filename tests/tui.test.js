import test from 'node:test';
import assert from 'node:assert/strict';

import { renderTuiFrame } from '../src/tui/render.js';

test('renderTuiFrame includes the key sections', () => {
  const text = renderTuiFrame({
    indexerHealth: {
      ok: true,
      payload: { chain_tip: 302432, indexed_height: 302432, version: '0.2.0' },
    },
    oracle: { source: 'fallback', priceValue: 100 },
    market: {
      tokenId: 'token-id',
      tokenRow: {
        display_name: 'ParyonUSD (chipnet-16)',
        display_symbol: 'PUSDTEST',
        price_now_usd: 1.86,
        price_24h_usd: 1.81,
        price_7d_usd: 1.79,
        apy_30d_bp: 301,
        tvl_sats: 4_945_148_590,
        decimals: 2,
        trade_count: 19,
        score_rank: 1,
        bcmr: {
          name: 'ParyonUSD',
          token: { symbol: 'PUSDTEST' },
          uris: {
            web: 'https://example.com',
            icon: 'https://example.com/icon.png',
          },
        },
      },
      priceRaw: 4940.553874896346,
      aggregatedApy: { apy: '3.0139' },
      poolIds: ['pool-1', 'pool-2'],
      pools: [
        {
          pool_id: 'pool-1',
          sats: 2_500_000_000,
          tokens: 500_000,
          owner_p2pkh_addr: 'bchtest:qqexamplepoolone',
          txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          tx_pos: 0,
          locking_bytecode: '76a914abcdef0123456789abcdef0123456789abcdef0188ac',
        },
        {
          pool_id: 'pool-2',
          sats: 2_445_148_590,
          tokens: 500_930,
          owner_p2pkh_addr: 'bchtest:qqexamplepooltwo',
          txid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          tx_pos: 1,
          locking_bytecode: '76a9140123456789abcdef0123456789abcdef0123456788ac',
        },
      ],
    },
    portfolio: {
      ok: true,
      health: { payload: { status: 'healthy' } },
      contract: {
        utxoCount: 2,
        bchSats: 100_000_000n,
        stablecoinTokens: 100n,
      },
      treasury: {
        utxoCount: 2,
        bchSats: 25_000_000n,
        stablecoinTokens: 20n,
        nftCount: 1,
      },
      totals: {
        totalBchSats: 125_000_000n,
        totalStablecoinTokens: 120n,
      },
    },
    rebalance: {
      bchUsd: 100n,
      stablecoinUsd: 120n,
      totalUsd: 220n,
      targetUsd: 110n,
      bchWeightBps: 4545n,
      stableWeightBps: 5454n,
      formatted: {
        headline: 'Sell stablecoin for BCH',
        details: 'Step: 10 tokens | Expected input: 10000 sats | Imbalance: 20 -> 10 | Slippage cap: 150 bps',
      },
      reason: 'Stablecoin is overweight versus BCH',
    },
    status: 'ok',
    tick: 1,
    uiState: { view: 'portfolio', selectedPoolIndex: 1, showHelp: true },
  });

  assert.match(text, /BCH Rebalancer/);
  assert.match(text, /Indexer/);
  assert.match(text, /Cauldron/);
  assert.match(text, /ParyonUSD/);
  assert.match(text, /Portfolio/);
  assert.match(text, /Recommendation/);
  assert.match(text, /Views:/);
  assert.match(text, /Help/);
});
