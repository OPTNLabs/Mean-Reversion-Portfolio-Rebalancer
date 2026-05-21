import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizePortfolio } from '../src/domain/portfolio.js';

test('summarizePortfolio counts BCH, stablecoin, and NFT holdings', () => {
  const summary = summarizePortfolio({
    contractUtxos: [
      {
        value: 100_000_000n,
        token: { category: 'ft-category', amount: 120n },
      },
    ],
    treasuryUtxos: [
      {
        value: 2_000n,
        token: {
          category: 'nft-category',
          amount: 0n,
          nft: { commitment: 'nft0', capability: 'none' },
        },
      },
      {
        value: 10_000n,
      },
    ],
    stablecoinCategory: 'ft-category',
    nftCategory: 'nft-category',
    nftCommitment: 'nft0',
  });

  assert.equal(summary.contract.bchSats, 100_000_000n);
  assert.equal(summary.contract.stablecoinTokens, 120n);
  assert.equal(summary.treasury.nftCount, 1);
  assert.equal(summary.totalStablecoinTokens, 120n);
  assert.equal(summary.totalBchSats, 100_012_000n);
});

