import readline from 'node:readline';

import {
  TUI_REFRESH_MS,
  CAULDRON_MODE,
  CAULDRON_PUBLIC_KEY_HASH,
  CAULDRON_TOKEN_ID,
  INDEXER_BASE_URL,
  MOCK_ORACLE_PRICE_RAW,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
  STABLECOIN_CATEGORY_HEX,
  CONTRACT_ADDRESS,
  CONTRACT_TOKEN_ADDRESS,
  ALICE_ADDRESS,
  ALICE_TOKEN_ADDRESS,
} from '../../config.js';
import { createCauldronAdapter } from '../adapters/cauldron.js';
import { fetchIndexerHealth, fetchIndexerSnapshot } from '../adapters/indexer.js';
import { fetchOracleSnapshot } from '../adapters/oracle.js';
import { createMockCauldronFixture } from '../mocknet/cauldronFixture.js';
import { renderTuiFrame } from './render.js';
import { buildPortfolioRebalanceSnapshot } from '../domain/rebalance.js';
import { toBigInt } from '../domain/portfolio.js';

readline.emitKeypressEvents(process.stdin);

function clampIndex(index, length) {
  if (!Number.isFinite(length) || length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function cycleView(view, direction) {
  const views = ['overview', 'portfolio', 'token', 'pools'];
  const currentIndex = views.indexOf(view);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + views.length) % views.length;
  return views[nextIndex];
}

export async function loadSnapshot() {
  const cauldronMode = String(CAULDRON_MODE ?? 'live').toLowerCase();
  const mockFixture =
    cauldronMode === 'mock'
      ? createMockCauldronFixture({
          poolId: process.env.CAULDRON_POOL_ID ?? 'mock-cauldron-pool-1',
          tokenId: CAULDRON_TOKEN_ID,
          oraclePriceRaw: MOCK_ORACLE_PRICE_RAW,
          poolCount: Number(process.env.CAULDRON_MOCK_POOL_COUNT ?? 3),
        })
      : null;

  const [indexerHealth, oracle, market, portfolioSnapshot] = await Promise.all([
    fetchIndexerHealth({
      baseUrl: INDEXER_BASE_URL,
    }),
    cauldronMode === 'mock'
      ? Promise.resolve({
          source: 'mock',
          ...mockFixture.getCurrentPrice(),
          priceRaw: mockFixture.state.oraclePriceRaw,
          priceScale: 100,
          priceValue: Number(mockFixture.state.oraclePriceRaw) / 100,
        })
      : fetchOracleSnapshot(),
    createCauldronAdapter(
      cauldronMode === 'mock'
        ? { mode: 'mock', fixture: mockFixture }
        : {
            tokenId: CAULDRON_TOKEN_ID,
            poolId: process.env.CAULDRON_POOL_ID ?? '',
            publicKeyHash: CAULDRON_PUBLIC_KEY_HASH,
          }
    ).getMarketSnapshot(),
    cauldronMode === 'mock'
      ? Promise.resolve(null)
      : fetchIndexerSnapshot({
          baseUrl: INDEXER_BASE_URL,
          stablecoinCategory: STABLECOIN_CATEGORY_HEX,
          nftCategory: NFT_CATEGORY_HEX,
          nftCommitment: REBALANCER_NFT_COMMITMENT_HEX,
          contractAddress: CONTRACT_ADDRESS,
          contractTokenAddress: CONTRACT_TOKEN_ADDRESS,
          aliceAddress: ALICE_ADDRESS,
          aliceTokenAddress: ALICE_TOKEN_ADDRESS,
        }).catch((error) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
  ]);

  const rebalance = portfolioSnapshot?.ok
    ? buildPortfolioRebalanceSnapshot({
        bchSats: portfolioSnapshot.totals?.totalBchSats ?? 0n,
        stablecoinTokens: portfolioSnapshot.totals?.totalStablecoinTokens ?? 0n,
        oraclePriceRaw: toBigInt(oracle?.priceRaw ?? 0),
      })
    : null;

  return {
    indexerHealth,
    oracle,
    market,
    portfolioSnapshot,
    rebalance,
    mockFixture,
  };
}

export async function runTui({ refreshMs = TUI_REFRESH_MS } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  let rawModeEnabled = false;
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    rawModeEnabled = true;
  }

  let stopped = false;
  let tick = 0;
  let status = 'loading';
  let latestSnapshot = null;
  let renderInFlight = false;
  let renderQueued = false;
  const uiState = {
    view: 'overview',
    selectedPoolIndex: 0,
    showHelp: false,
  };

  const refreshUiSelection = (snapshot) => {
    const pools = Array.isArray(snapshot?.market?.pools) ? snapshot.market.pools : [];
    uiState.selectedPoolIndex = clampIndex(uiState.selectedPoolIndex, pools.length);
    if (uiState.view === 'pools' && pools.length === 0) {
      uiState.selectedPoolIndex = 0;
    }
  };

  const requestRender = () => {
    void render();
  };

  const render = async () => {
    if (stopped) return;
    if (renderInFlight) {
      renderQueued = true;
      return;
    }
    renderInFlight = true;
    tick += 1;
    status = 'refreshing';

    let snapshot;
    try {
      snapshot = await loadSnapshot();
      latestSnapshot = snapshot;
      refreshUiSelection(snapshot);
      status = snapshot.indexerHealth?.ok ? 'ok' : 'indexer-degraded';
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
      snapshot = null;
    }

    process.stdout.write('\u001b[2J\u001b[0f');
    process.stdout.write(
      `${renderTuiFrame({
        indexerHealth: snapshot?.indexerHealth,
        oracle: snapshot?.oracle,
        market: snapshot?.market,
        portfolio: snapshot?.portfolioSnapshot,
        rebalance: snapshot?.rebalance,
        status,
        tick,
        uiState,
      })}\n`
    );

    renderInFlight = false;
    if (renderQueued && !stopped) {
      renderQueued = false;
      requestRender();
    }
  };

  const timer = setInterval(() => {
    requestRender();
  }, refreshMs);

  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    rl.close();
    if (rawModeEnabled) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write('\n');
    process.exit(0);
  };

  rl.input.on('keypress', (_str, key) => {
    if (stopped) return;
    if (key?.ctrl && key.name === 'c') {
      shutdown();
      return;
    }
    if (key?.name === 'q') {
      shutdown();
      return;
    }
    if (key?.name === 'r') {
      requestRender();
      return;
    }
    if (key?.name === 'tab') {
      uiState.view = cycleView(uiState.view, key.shift ? -1 : 1);
      if (uiState.view !== 'pools') {
        uiState.showHelp = false;
      }
      requestRender();
      return;
    }
    if (key?.name === 'left' || key?.name === 'h' || key?.name === '1') {
      uiState.view = 'overview';
      if (uiState.view !== 'pools') {
        uiState.showHelp = false;
      }
      requestRender();
      return;
    }
    if (key?.name === 'right' || key?.name === 'l' || key?.name === '2') {
      uiState.view = 'portfolio';
      if (uiState.view !== 'pools') {
        uiState.showHelp = false;
      }
      requestRender();
      return;
    }
    if (key?.name === 't' || key?.name === '3') {
      uiState.view = 'token';
      requestRender();
      return;
    }
    if (key?.name === 'p' || key?.name === '4') {
      uiState.view = 'pools';
      requestRender();
      return;
    }
    if (key?.name === 'up' || key?.name === 'k') {
      const poolCount = Array.isArray(latestSnapshot?.market?.pools)
        ? latestSnapshot.market.pools.length
        : 0;
      if (poolCount > 0) {
        uiState.view = 'pools';
        uiState.selectedPoolIndex = clampIndex(uiState.selectedPoolIndex - 1, poolCount);
        requestRender();
      }
      return;
    }
    if (key?.name === 'down' || key?.name === 'j') {
      const poolCount = Array.isArray(latestSnapshot?.market?.pools)
        ? latestSnapshot.market.pools.length
        : 0;
      if (poolCount > 0) {
        uiState.view = 'pools';
        uiState.selectedPoolIndex = clampIndex(uiState.selectedPoolIndex + 1, poolCount);
        requestRender();
      }
      return;
    }
    if (key?.sequence === '?') {
      uiState.showHelp = !uiState.showHelp;
      requestRender();
    }
  });

  process.on('SIGINT', shutdown);
  await render();
}

export async function printStatusOnce() {
  const snapshot = await loadSnapshot();
  console.log(JSON.stringify(snapshot.indexerHealth, null, 2));
}

export async function printPortfolioPlanOnce() {
  const snapshot = await loadSnapshot();
  console.log(`${snapshot.market?.tokenRow?.display_name ?? 'Portfolio'} rebalance plan`);
  console.log('');
  console.log(`Indexer: ${snapshot.portfolioSnapshot?.ok ? 'ok' : 'degraded'}`);
  console.log(
    `Totals: BCH ${snapshot.portfolioSnapshot?.totals?.totalBchSats?.toString?.() ?? '0'} sats | stablecoin ${
      snapshot.portfolioSnapshot?.totals?.totalStablecoinTokens?.toString?.() ?? '0'
    } tokens`
  );
  if (snapshot.rebalance) {
    console.log(`Recommendation: ${snapshot.rebalance.formatted?.headline ?? snapshot.rebalance.reason}`);
    console.log(snapshot.rebalance.formatted?.details ?? snapshot.rebalance.reason ?? 'No action required');
  } else {
    console.log('Recommendation: unavailable');
  }
}
