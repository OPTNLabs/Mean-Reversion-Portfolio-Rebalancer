import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchIndexerSnapshot } from '../src/adapters/indexer.js';

test('fetchIndexerSnapshot summarizes live indexer UTXOs', async () => {
  const originalFetch = global.fetch;

  const responses = new Map([
    [
      'http://indexer.test/api/utxos/contract',
      {
        utxos: [
          {
            tx_hash: 'aa',
            tx_pos: 0,
            satoshis: 100_000_000,
            token: { category: 'stable', amount: 100 },
          },
        ],
      },
    ],
    [
      'http://indexer.test/api/utxos/contract-token',
      {
        utxos: [
          {
            tx_hash: 'bb',
            tx_pos: 1,
            satoshis: 2_000,
            token: { category: 'stable', amount: 1 },
          },
        ],
      },
    ],
    [
      'http://indexer.test/api/utxos/alice',
      {
        utxos: [
          {
            tx_hash: 'cc',
            tx_pos: 2,
            satoshis: 50_000,
          },
        ],
      },
    ],
    [
      'http://indexer.test/api/utxos/alice-token',
      {
        utxos: [
          {
            tx_hash: 'dd',
            tx_pos: 3,
            satoshis: 2_000,
            token: {
              category: 'nft',
              amount: 0,
              nft: { commitment: 'nft0', capability: 'none' },
            },
          },
        ],
      },
    ],
    ['http://indexer.test/health', { ok: true }],
  ]);

  global.fetch = async (url) => {
    const payload = responses.get(String(url));
    if (!payload) {
      throw new Error(`Unexpected fetch url: ${String(url)}`);
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify(payload),
    };
  };

  try {
    const snapshot = await fetchIndexerSnapshot({
      baseUrl: 'http://indexer.test',
      contractAddress: 'contract',
      contractTokenAddress: 'contract-token',
      aliceAddress: 'alice',
      aliceTokenAddress: 'alice-token',
      stablecoinCategory: 'stable',
      nftCategory: 'nft',
      nftCommitment: 'nft0',
    });

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.health.ok, true);
    assert.equal(snapshot.contract.utxoCount, 2);
    assert.equal(snapshot.contract.stablecoinTokens, 101n);
    assert.equal(snapshot.treasury.nftCount, 1);
    assert.equal(snapshot.totals.totalBchSats, 100_054_000n);
  } finally {
    global.fetch = originalFetch;
  }
});
