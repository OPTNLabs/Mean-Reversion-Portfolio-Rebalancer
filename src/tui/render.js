import {
  PROJECT_NAME,
  PROJECT_TAGLINE,
  NETWORK,
  CAULDRON_API_BASE_URL,
  CAULDRON_MODE,
  CAULDRON_POOL_ID,
  CAULDRON_TOKEN_ID,
} from '../../config.js';

function fmtSats(value) {
  return `${value.toString()} sats`;
}

function fmtTokens(value) {
  return `${value.toString()} tokens`;
}

function fmtUsd(value, digits = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '$0.00';
  return `$${value.toFixed(digits)}`;
}

function fmtMaybeText(value) {
  if (typeof value !== 'string') return 'n/a';
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : 'n/a';
}

function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function truncateMiddle(value, left = 12, right = 8) {
  const text = fmtMaybeText(value);
  if (text === 'n/a' || text.length <= left + right + 3) return text;
  return `${text.slice(0, left)}...${text.slice(-right)}`;
}

function fmtBps(value) {
  if (typeof value === 'bigint') {
    return `${(Number(value) / 100).toFixed(2)}%`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `${(value / 100).toFixed(2)}%`;
  }
  return 'n/a';
}

function renderSection(title, lines = []) {
  return [title, ...(lines.length > 0 ? lines.map((line) => `  ${line}`) : ['  n/a'])];
}

function renderTabs(view) {
  const tabs = [
    ['overview', 'Overview'],
    ['portfolio', 'Portfolio'],
    ['token', 'Token'],
    ['pools', 'Pools'],
  ];

  return tabs
    .map(([key, label]) => (key === view ? `[${label}]` : label))
    .join('  ');
}

function renderPoolLine(pool, index, selected) {
  const marker = selected ? '>' : ' ';
  return `${marker} #${index + 1} ${fmtMaybeText(pool?.pool_id)} | ${fmtSats(
    toBigInt(pool?.sats ?? pool?.tvl_sats ?? 0)
  )} | ${fmtTokens(toBigInt(pool?.tokens ?? pool?.tvl_tokens ?? 0))} | owner ${truncateMiddle(
    pool?.owner_p2pkh_addr ?? pool?.owner ?? null,
    14,
    10
  )} | tx ${truncateMiddle(pool?.txid ?? null, 10, 8)}:${pool?.tx_pos ?? 'n/a'}`;
}

function renderPoolDetails(pool) {
  if (!pool) {
    return renderSection('Focused pool', ['No active pool selected']);
  }

  return renderSection('Focused pool', [
    `Pool id: ${fmtMaybeText(pool.pool_id)}`,
    `Token id: ${fmtMaybeText(pool.token_id ?? pool.tokenId ?? null)}`,
    `Sats: ${fmtSats(toBigInt(pool.sats ?? pool.tvl_sats ?? 0))}`,
    `Tokens: ${fmtTokens(toBigInt(pool.tokens ?? pool.tvl_tokens ?? 0))}`,
    `Owner: ${fmtMaybeText(pool.owner_p2pkh_addr ?? pool.owner ?? null)}`,
    `Tx: ${fmtMaybeText(pool.txid)}:${pool.tx_pos ?? 'n/a'}`,
    `Bytecode: ${truncateMiddle(pool.locking_bytecode ?? pool.bytecode ?? null, 18, 14)}`,
  ]);
}

function renderPortfolioSection(portfolio, rebalance) {
  if (!portfolio) {
    return renderSection('Portfolio', ['Indexer portfolio snapshot unavailable']);
  }

  const contract = portfolio.contract ?? {};
  const treasury = portfolio.treasury ?? {};
  const totals = portfolio.totals ?? {};

  return [
    ...renderSection('Portfolio', [
      `Indexer: ${portfolio.ok ? 'ok' : 'degraded'} | ${portfolio.health?.payload?.status ?? 'n/a'}`,
      `Contract: ${contract.utxoCount ?? 'n/a'} UTXOs | BCH ${fmtSats(contract.bchSats ?? 0n)} | stable ${fmtTokens(
        contract.stablecoinTokens ?? 0n
      )}`,
      `Treasury: ${treasury.utxoCount ?? 'n/a'} UTXOs | BCH ${fmtSats(treasury.bchSats ?? 0n)} | stable ${fmtTokens(
        treasury.stablecoinTokens ?? 0n
      )} | NFTs ${treasury.nftCount ?? 'n/a'}`,
      `Totals: BCH ${fmtSats(totals.totalBchSats ?? 0n)} | stable ${fmtTokens(
        totals.totalStablecoinTokens ?? 0n
      )}`,
    ]),
    '',
    ...renderSection('Rebalance target', [
      `BCH value: ${fmtUsd(Number(rebalance?.bchUsd ?? 0n))} | Stablecoin value: ${fmtUsd(
        Number(rebalance?.stablecoinUsd ?? 0n)
      )}`,
      `Portfolio value: ${fmtUsd(Number(rebalance?.totalUsd ?? 0n))} | Target per side: ${fmtUsd(
        Number(rebalance?.targetUsd ?? 0n)
      )}`,
      `Current weights: BCH ${fmtBps(rebalance?.bchWeightBps ?? 0n)} | Stablecoin ${fmtBps(
        rebalance?.stableWeightBps ?? 0n
      )}`,
    ]),
    '',
    ...renderSection('Recommendation', [
      `${rebalance?.formatted?.headline ?? 'No rebalance'}${rebalance?.reason ? ` | ${rebalance.reason}` : ''}`,
      rebalance?.formatted?.details ?? rebalance?.reason ?? 'No action required',
    ]),
  ];
}

export function renderTuiFrame({
  indexerHealth,
  oracle,
  market,
  portfolio,
  rebalance,
  status,
  tick,
  uiState = {},
}) {
  const pools = Array.isArray(market?.pools) ? market.pools : [];
  const selectedPoolIndex =
    pools.length > 0
      ? Math.min(Math.max(Number(uiState.selectedPoolIndex ?? 0), 0), pools.length - 1)
      : 0;
  const selectedPool = pools[selectedPoolIndex] ?? null;
  const activeView = uiState.view ?? 'overview';
  const showHelp = Boolean(uiState.showHelp);
  const tokenRow = market?.tokenRow ?? null;
  const tokenPriceUsd = tokenRow?.price_now_usd ?? market?.priceNowUsd ?? 0;
  const tokenPrice24hUsd = tokenRow?.price_24h_usd ?? tokenPriceUsd;
  const tokenPrice7dUsd = tokenRow?.price_7d_usd ?? tokenPriceUsd;
  const activeApy =
    typeof tokenRow?.apy_30d_bp === 'number' ? `${(tokenRow.apy_30d_bp / 100).toFixed(2)}%` : 'n/a';
  const selectedLabel = pools.length > 0 ? `${selectedPoolIndex + 1}/${pools.length}` : '0/0';
  const navigationLine = [
    `Views: ${renderTabs(activeView)}`,
    `Pool focus: ${selectedLabel}`,
    'Keys: tab cycle',
    '←/→ or h/l view',
    '↑/↓ or j/k select',
    'r refresh',
    '? help',
    'q quit',
  ].join(' | ');

  const lines = [
    `${PROJECT_NAME}`,
    `${PROJECT_TAGLINE}`,
    '',
    `Network: ${NETWORK}`,
    `Mode: ${CAULDRON_MODE}`,
    `View: ${navigationLine}`,
    `Oracle: ${oracle?.source ?? 'unknown'} | price: ${fmtUsd(
      oracle?.priceValue
    )} | raw: ${oracle?.priceRaw ?? 'n/a'}`,
    `DEX: ${CAULDRON_API_BASE_URL} | pool: ${CAULDRON_POOL_ID || 'n/a'} | token: ${
      CAULDRON_TOKEN_ID || 'n/a'
    }`,
    '',
    ...renderSection('Indexer', [
      `Health: ${indexerHealth?.ok ? 'ok' : 'degraded'}`,
      `Chain tip: ${indexerHealth?.payload?.chain_tip ?? 'n/a'} | indexed: ${
        indexerHealth?.payload?.indexed_height ?? 'n/a'
      } | version: ${indexerHealth?.payload?.version ?? 'n/a'}`,
    ]),
    '',
    ...renderSection('Cauldron', [
      `Token: ${tokenRow?.display_name ?? 'n/a'} (${tokenRow?.display_symbol ?? 'n/a'})`,
      `Token id: ${market?.tokenId ?? 'n/a'}`,
      `Price now: ${fmtUsd(tokenPriceUsd)} | TVL: ${fmtSats(
        toBigInt(tokenRow?.tvl_sats ?? market?.tvlSats ?? 0)
      )}`,
      `Pools seen: ${pools.length} | Aggregated APY: ${
        typeof market?.aggregatedApy?.apy === 'string' || typeof market?.aggregatedApy?.apy === 'number'
          ? market.aggregatedApy.apy
          : 'n/a'
      }`,
    ]),
    '',
  ];

  if (activeView === 'overview') {
    lines.push(
      ...renderSection('Snapshot', [
        `Token: ${tokenRow?.display_name ?? 'n/a'} (${tokenRow?.display_symbol ?? 'n/a'})`,
        `Price now: ${fmtUsd(tokenPriceUsd)} | 24h: ${fmtUsd(tokenPrice24hUsd)} | 7d: ${fmtUsd(
          tokenPrice7dUsd
        )}`,
        `APY 30d: ${activeApy} | Aggregated APY: ${
          typeof market?.aggregatedApy?.apy === 'string' || typeof market?.aggregatedApy?.apy === 'number'
            ? market.aggregatedApy.apy
            : 'n/a'
        }`,
        `TVL: ${fmtSats(toBigInt(tokenRow?.tvl_sats ?? market?.tvlSats ?? 0))} | Pools seen: ${
          pools.length
        }`,
      ]),
      '',
      ...renderSection('Token metadata', [
        `Token id: ${market?.tokenId ?? 'n/a'}`,
        `Decimals: ${tokenRow?.decimals ?? 'n/a'} | Trade count: ${
          tokenRow?.trade_count ?? 'n/a'
        } | Score rank: ${tokenRow?.score_rank ?? 'n/a'}`,
        `BCMR: ${fmtMaybeText(tokenRow?.bcmr?.name)} | ${fmtMaybeText(
          tokenRow?.bcmr?.token?.symbol
        )}`,
      ]),
      '',
      ...renderPortfolioSection(portfolio, rebalance),
      '',
      ...renderSection(
        'Active pools',
        pools.length > 0
          ? pools.slice(0, 5).map((pool, index) => renderPoolLine(pool, index, index === selectedPoolIndex))
          : ['No pools found']
      )
    );
  }

  if (activeView === 'portfolio') {
    lines.push(...renderPortfolioSection(portfolio, rebalance));
  }

  if (activeView === 'token') {
    lines.push(
      ...renderSection('Token metadata', [
        `Name: ${tokenRow?.display_name ?? 'n/a'}`,
        `Symbol: ${tokenRow?.display_symbol ?? 'n/a'}`,
        `Token id: ${market?.tokenId ?? 'n/a'}`,
        `Decimals: ${tokenRow?.decimals ?? 'n/a'} | Trade count: ${
          tokenRow?.trade_count ?? 'n/a'
        } | Score rank: ${tokenRow?.score_rank ?? 'n/a'}`,
        `Price now: ${fmtUsd(tokenPriceUsd)} | 24h: ${fmtUsd(tokenPrice24hUsd)} | 7d: ${fmtUsd(
          tokenPrice7dUsd
        )}`,
        `APY 30d: ${activeApy} | Aggregated APY: ${
          typeof market?.aggregatedApy?.apy === 'string' || typeof market?.aggregatedApy?.apy === 'number'
            ? market.aggregatedApy.apy
            : 'n/a'
        }`,
        `TVL: ${fmtSats(toBigInt(tokenRow?.tvl_sats ?? market?.tvlSats ?? 0))} | Price raw: ${
          market?.priceRaw ?? 'n/a'
        }`,
        `BCMR web: ${fmtMaybeText(tokenRow?.bcmr?.uris?.web)}`,
        `BCMR icon: ${fmtMaybeText(tokenRow?.bcmr?.uris?.icon)}`,
      ]),
      '',
      ...renderSection('Token source', [
        `Base URL: ${CAULDRON_API_BASE_URL}`,
        `Pools discovered: ${pools.length}`,
        `Pool ids: ${Array.isArray(market?.poolIds) ? market.poolIds.join(', ') || 'n/a' : 'n/a'}`,
      ]),
      '',
      ...renderSection(
        'Active pools',
        pools.length > 0
          ? pools.map((pool, index) => renderPoolLine(pool, index, index === selectedPoolIndex))
          : ['No pools found']
      )
    );
  }

  if (activeView === 'pools') {
    lines.push(
      ...renderSection(
        'Active pools',
        pools.length > 0
          ? pools.map((pool, index) => renderPoolLine(pool, index, index === selectedPoolIndex))
          : ['No pools found']
      ),
      '',
      ...renderPoolDetails(selectedPool),
      '',
      ...renderSection('Pool stats', [
        `Price raw: ${market?.priceRaw ?? 'n/a'}`,
        `Aggregated APY: ${
          typeof market?.aggregatedApy?.apy === 'string' || typeof market?.aggregatedApy?.apy === 'number'
            ? market.aggregatedApy.apy
            : 'n/a'
        }`,
        `Token pools: ${pools.length}`,
      ])
    );
  }

  if (showHelp) {
    lines.push(
      '',
      ...renderSection('Help', [
        'Overview: market summary plus rebalance preview',
        'Portfolio: live holdings, weights, and rebalance recommendation',
        'Token: full token metadata and source details',
        'Pools: select a pool with ↑/↓ or j/k',
        'Tab / left / right: switch views',
        'r: refresh snapshot',
        'q or Ctrl-C: quit',
      ])
    );
  }

  lines.push(
    '',
    ...renderSection('Status', [`${status ?? 'idle'} | tick ${tick}`]),
    '',
    ...renderSection('Hints', ['Press ? for help'])
  );

  return lines.join('\n');
}
