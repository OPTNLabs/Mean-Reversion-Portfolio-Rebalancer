import MockNetworkProvider from 'cashscript/dist/network/MockNetworkProvider.js';
import {
  binToHex,
  encodeCashAddress,
  hash160,
  hash256,
  hexToBin,
  lockingBytecodeToCashAddress,
} from '@bitauth/libauth';

import {
  CAULDRON_TOKEN_ID,
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
} from '../../config.js';

const CHIPNET_PREFIX = 'bchtest';
const TOKEN_OUTPUT_SATS = 2_000n;
const LP_RECEIPT_SATS = 2_000n;
const OP_HASH256 = 0xaa;
const OP_EQUAL = 0x87;
const POOL_V0_PRE_PUBKEY_BIN = hexToBin('44746376a914');
const POOL_V0_POST_PUBKEY_BIN = hexToBin(
  '88ac67c0d1c0ce88c25288c0cdc0c788c0c6c0d095c0c6c0cc9490539502e80396c0cc7c94c0d3957ca268'
);

function toBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return fallback;
    }
  }
  return fallback;
}

function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function textBytes(label) {
  return new TextEncoder().encode(String(label));
}

function coerceByteArray(value) {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return Uint8Array.from(value);
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase().replace(/^0x/, '');
    if (/^[0-9a-f]*$/.test(normalized) && normalized.length % 2 === 0) {
      return Uint8Array.from(
        normalized.match(/.{1,2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? []
      );
    }
  }
  return null;
}

function makeCashAddress(label) {
  const payload = hash160(textBytes(label));
  return encodeCashAddress({
    prefix: CHIPNET_PREFIX,
    type: 'p2pkh',
    payload,
    throwErrors: true,
  }).address;
}

function makeDeterministicHex(label) {
  return binToHex(hash256(textBytes(label)));
}

function makeWithdrawPublicKeyHash(label) {
  return hash160(textBytes(label));
}

function buildCauldronPoolV0RedeemScript(withdrawPublicKeyHash) {
  return Uint8Array.from([
    ...POOL_V0_PRE_PUBKEY_BIN.slice(1),
    ...withdrawPublicKeyHash,
    ...POOL_V0_POST_PUBKEY_BIN,
  ]);
}

function buildCauldronPoolV0LockingBytecode(withdrawPublicKeyHash) {
  const redeemScript = buildCauldronPoolV0RedeemScript(withdrawPublicKeyHash);
  const payload = hash256(redeemScript);
  return Uint8Array.from([OP_HASH256, payload.length, ...payload, OP_EQUAL]);
}

function toCashAddress(bytecode) {
  const result = lockingBytecodeToCashAddress({
    prefix: CHIPNET_PREFIX,
    bytecode,
    tokenSupport: false,
  });
  if (typeof result === 'string') {
    throw new Error(result);
  }
  return result.address;
}

export function quoteConstantProductSwap({
  reserveIn,
  reserveOut,
  amountIn,
  feeBps = 30,
}) {
  const amountInBig = toBigInt(amountIn);
  const reserveInBig = toBigInt(reserveIn);
  const reserveOutBig = toBigInt(reserveOut);
  const fee = (amountInBig * BigInt(feeBps)) / 10_000n;
  const amountInAfterFee = amountInBig - fee;
  if (amountInAfterFee <= 0n) {
    return {
      fee,
      amountOut: 0n,
      nextReserveIn: reserveInBig,
      nextReserveOut: reserveOutBig,
    };
  }

  const k = reserveInBig * reserveOutBig;
  const nextReserveIn = reserveInBig + amountInAfterFee;
  const nextReserveOut = k / nextReserveIn;
  const amountOut = reserveOutBig - nextReserveOut;

  return {
    fee,
    amountOut,
    nextReserveIn,
    nextReserveOut,
  };
}

function createPoolState(spec, index, provider) {
  const withdrawPublicKeyHash =
    coerceByteArray(spec.withdrawPublicKeyHash) ??
    makeWithdrawPublicKeyHash(`${spec.poolId}:withdraw:${index}`);
  const lockingBytecode = buildCauldronPoolV0LockingBytecode(withdrawPublicKeyHash);
  const poolAddress = spec.poolAddress ?? toCashAddress(lockingBytecode);
  const ownerAddress = spec.ownerAddress ?? makeCashAddress(`${spec.poolId}:owner`);
  const ownerPublicKeyHash = binToHex(
    coerceByteArray(spec.ownerPublicKeyHash) ??
      hash160(textBytes(`${spec.poolId}:owner-pkh`))
  );
  const tokenId = spec.tokenId ?? CAULDRON_TOKEN_ID;
  const reserveBchSats = toBigInt(spec.reserveBchSats);
  const reserveTokens = toBigInt(spec.reserveTokens);
  const txHash = spec.txHash ?? makeDeterministicHex(`${spec.poolId}:pool-utxo`);
  const txPos = toNumber(spec.txPos ?? index);
  const poolUtxo = {
    tx_hash: txHash,
    tx_pos: txPos,
    satoshis: reserveBchSats,
    value: reserveBchSats,
    token: {
      category: tokenId,
      amount: reserveTokens,
    },
    lockingBytecode,
    address: poolAddress,
  };

  provider.addUtxo(poolAddress, poolUtxo);

  return {
    poolId: spec.poolId,
    index,
    tokenId,
    feeBps: toNumber(spec.feeBps ?? 30),
    owner_pkh: ownerPublicKeyHash,
    owner_p2pkh_addr: ownerAddress,
    withdrawPublicKeyHash,
    lockingBytecode,
    poolAddress,
    poolUtxo,
    reserveBchSats,
    reserveTokens,
    txHash,
    txPos,
    lpCommitment: spec.lpCommitment ?? `${spec.poolId}:lp`,
    historySeed: spec.historySeed ?? index,
  };
}

function buildDefaultPoolSpecs(options) {
  if (Array.isArray(options.pools) && options.pools.length > 0) {
    return options.pools.map((pool, index) => ({
      poolId: pool.poolId ?? `mock-cauldron-pool-${index + 1}`,
      tokenId: pool.tokenId ?? options.tokenId ?? CAULDRON_TOKEN_ID,
      feeBps: pool.feeBps ?? options.feeBps ?? 30,
      reserveBchSats: pool.reserveBchSats ?? 100_000_000n,
      reserveTokens: pool.reserveTokens ?? 1_000n,
      txHash: pool.txHash,
      txPos: pool.txPos,
      poolAddress: pool.poolAddress,
      ownerAddress: pool.ownerAddress,
      ownerPublicKeyHash: pool.ownerPublicKeyHash,
      withdrawPublicKeyHash: pool.withdrawPublicKeyHash,
      lpCommitment: pool.lpCommitment,
      historySeed: pool.historySeed,
    }));
  }

  const poolCount = Math.max(1, toNumber(options.poolCount ?? 1));
  const baseReserveBchSats = toBigInt(options.poolReserveBchSats ?? 100_000_000n);
  const baseReserveTokens = toBigInt(options.poolReserveTokens ?? 1_000n);
  const bchStep = toBigInt(options.poolReserveBchStepSats ?? 40_000_000n);
  const tokenStep = toBigInt(options.poolReserveTokenStep ?? 120n);
  const feeBps = toNumber(options.feeBps ?? 30);
  const tokenId = options.tokenId ?? CAULDRON_TOKEN_ID;

  return Array.from({ length: poolCount }, (_, index) => ({
    poolId: `${options.poolId ?? 'mock-cauldron-pool'}-${index + 1}`,
    tokenId,
    feeBps: feeBps + index,
    reserveBchSats: baseReserveBchSats + BigInt(index) * bchStep,
    reserveTokens: baseReserveTokens + BigInt(index) * tokenStep,
    txPos: index,
    lpCommitment: `${options.poolId ?? 'mock-cauldron-pool'}-${index + 1}:lp`,
    historySeed: index,
  }));
}

function buildUtxoSummary(pool) {
  return {
    pool_id: pool.poolId,
    token_id: pool.tokenId,
    owner_pkh: pool.owner_pkh,
    owner_p2pkh_addr: pool.owner_p2pkh_addr,
    sats: pool.reserveBchSats,
    tokens: pool.reserveTokens,
    txid: pool.txHash,
    tx_pos: pool.txPos,
    locking_bytecode: pool.lockingBytecode,
    withdraw_pubkey_hash: binToHex(pool.withdrawPublicKeyHash),
  };
}

function createTraderState(options, tokenId) {
  return {
    bchSats: toBigInt(options.traderBchSats ?? 25_000_000n),
    tokenSats: toBigInt(options.traderTokens ?? 250n),
    lpTokens: toBigInt(options.traderLpTokens ?? 0n),
    bchAddress: options.traderBchAddress ?? makeCashAddress('mock-trader-bch'),
    tokenAddress: options.traderTokenAddress ?? makeCashAddress('mock-trader-token'),
    lpAddress: options.lpAddress ?? makeCashAddress('mock-trader-lp'),
    tokenId,
    lpCommitment: options.lpReceiptCommitment ?? 'mock-lp',
  };
}

function createPoolUtxoRecord(pool, reserveBchSats, reserveTokens, txHashSeed) {
  return {
    tx_hash: txHashSeed ?? pool.txHash,
    tx_pos: pool.txPos,
    satoshis: reserveBchSats,
    value: reserveBchSats,
    token: {
      category: pool.tokenId,
      amount: reserveTokens,
    },
    lockingBytecode: pool.lockingBytecode,
    address: pool.poolAddress,
  };
}

function createWalletUtxo(address, value, token) {
  const utxo = {
    tx_hash: makeDeterministicHex(`${address}:${value.toString()}:${token?.category ?? 'bch'}`),
    tx_pos: token ? 1 : 0,
    satoshis: value,
    value,
    address,
  };
  if (token) {
    utxo.token = {
      category: token.category,
      amount: token.amount,
    };
  }
  return utxo;
}

function buildTransactionPreview({
  type,
  pool,
  trader,
  direction,
  amountIn,
  fee,
  amountOut,
  nextPool,
}) {
  const traderInput =
    direction === 'bch-to-token'
      ? createWalletUtxo(trader.bchAddress, amountIn)
      : createWalletUtxo(trader.tokenAddress, amountIn, {
          category: pool.tokenId,
          amount: amountIn,
        });

  if (direction === 'bch-to-token' && trader.bchSats < amountIn + fee) {
    throw new Error('Insufficient mock BCH for swap preview');
  }
  if (direction === 'token-to-bch' && trader.tokenSats < amountIn) {
    throw new Error('Insufficient mock stablecoin for swap preview');
  }

  const settlementOutputs =
    direction === 'bch-to-token'
      ? [
          {
            address: trader.tokenAddress,
            value: TOKEN_OUTPUT_SATS,
            token: {
              category: pool.tokenId,
              amount: amountOut,
            },
          },
          {
            address: trader.bchAddress,
            value: trader.bchSats - amountIn - fee,
          },
        ]
      : [
          {
            address: trader.bchAddress,
            value: amountOut,
          },
          {
            address: trader.tokenAddress,
            value: TOKEN_OUTPUT_SATS,
            token: {
              category: pool.tokenId,
              amount: trader.tokenSats - amountIn,
            },
          },
        ];

  return {
    type,
    poolId: pool.poolId,
    direction,
    amountIn,
    amountOut,
    fee,
    inputs: [
      createPoolUtxoRecord(pool, pool.reserveBchSats, pool.reserveTokens, pool.txHash),
      traderInput,
    ],
    outputs: [
      createPoolUtxoRecord(
        nextPool,
        nextPool.reserveBchSats,
        nextPool.reserveTokens,
        nextPool.txHash
      ),
      ...settlementOutputs,
    ],
  };
}

export function createMockCauldronFixture(options = {}) {
  const provider = options.provider ?? new MockNetworkProvider();
  const poolSpecs = buildDefaultPoolSpecs(options);
  const pools = poolSpecs.map((spec, index) => createPoolState(spec, index, provider));
  const trader = createTraderState(options, pools[0]?.tokenId ?? CAULDRON_TOKEN_ID);
  const oraclePriceRaw = toBigInt(options.oraclePriceRaw ?? 10_000n);

  const state = {
    oraclePriceRaw,
    pools,
    trader,
    primaryPoolId: pools[0]?.poolId ?? null,
    poolId: pools[0]?.poolId ?? null,
    poolAddress: pools[0]?.poolAddress ?? null,
    tokenId: pools[0]?.tokenId ?? CAULDRON_TOKEN_ID,
  };

  function quoteForPool(pool, direction, amountIn) {
    const amountInBig = toBigInt(amountIn);
    if (direction === 'bch-to-token') {
      return quoteConstantProductSwap({
        reserveIn: pool.reserveBchSats,
        reserveOut: pool.reserveTokens,
        amountIn: amountInBig,
        feeBps: pool.feeBps,
      });
    }

    return quoteConstantProductSwap({
      reserveIn: pool.reserveTokens,
      reserveOut: pool.reserveBchSats,
      amountIn: amountInBig,
      feeBps: pool.feeBps,
    });
  }

  function snapshot() {
    return {
      ok: true,
      oraclePriceRaw: state.oraclePriceRaw,
      tokenId: state.tokenId,
      poolId: state.primaryPoolId,
      poolAddress: state.poolAddress,
      primaryPoolId: state.primaryPoolId,
      pools: state.pools.map((pool) => ({
        ...buildUtxoSummary(pool),
        fee_bps: pool.feeBps,
      })),
      trader: {
        bchSats: state.trader.bchSats,
        tokenSats: state.trader.tokenSats,
        lpTokens: state.trader.lpTokens,
      },
      addresses: {
        bchAddress: state.trader.bchAddress,
        tokenAddress: state.trader.tokenAddress,
        lpAddress: state.trader.lpAddress,
      },
    };
  }

  function listActivePools(tokenId = state.tokenId) {
    return state.pools
      .filter((pool) => !tokenId || pool.tokenId === tokenId)
      .map((pool) => buildUtxoSummary(pool));
  }

  function listIndexedTokens() {
    const byToken = new Map();
    for (const pool of state.pools) {
      const current = byToken.get(pool.tokenId) ?? {
        token_id: pool.tokenId,
        tvl_sats: 0n,
        tvl_tokens: 0n,
        trade_volume: 0,
        trade_count: 0,
        score: 0,
        score_rank: 0,
        price_now: Number(state.oraclePriceRaw) / 100,
        price_now_usd: Number(state.oraclePriceRaw) / 100,
        price_24h: null,
        price_7d: null,
        price_24h_usd: null,
        price_7d_usd: null,
        bcmr: null,
        bcmr_well_known: [],
      };
      current.tvl_sats += pool.reserveBchSats;
      current.tvl_tokens += pool.reserveTokens;
      current.trade_volume += Number(pool.reserveBchSats + pool.reserveTokens);
      current.trade_count += 1;
      byToken.set(pool.tokenId, current);
    }
    return [...byToken.values()].map((entry, index) => ({
      ...entry,
      tvl_sats: Number(entry.tvl_sats),
      tvl_tokens: Number(entry.tvl_tokens),
      score_rank: index + 1,
    }));
  }

  function getCurrentPrice() {
    return {
      token_id: state.tokenId,
      price_now_usd: Number(state.oraclePriceRaw) / 100,
      price_now: Number(state.oraclePriceRaw) / 100,
      price_24h_usd: null,
      price_7d_usd: null,
      fee_bps: state.pools[0]?.feeBps ?? 30,
    };
  }

  function findBestPool(direction, amountIn, tokenId = state.tokenId) {
    const candidates = state.pools.filter((pool) => pool.tokenId === tokenId);
    let best = null;
    for (const pool of candidates) {
      const quote = quoteForPool(pool, direction, amountIn);
      if (quote.amountOut <= 0n) continue;
      if (!best || quote.amountOut > best.quote.amountOut) {
        best = { pool, quote };
      }
    }
    return best;
  }

  function buildSwapPreview({
    poolId,
    direction = 'bch-to-token',
    amountIn,
    traderAddress,
  }) {
    const chosen =
      (poolId ? state.pools.find((pool) => pool.poolId === poolId) : null) ??
      findBestPool(direction, amountIn)?.pool ??
      state.pools[0];
    if (!chosen) {
      throw new Error('No mock Cauldron pools are available');
    }

    const quote = quoteForPool(chosen, direction, amountIn);
    const amountInBig = toBigInt(amountIn);
    const nextPool = {
      ...chosen,
      reserveBchSats:
        direction === 'bch-to-token' ? quote.nextReserveIn : quote.nextReserveOut,
      reserveTokens:
        direction === 'bch-to-token' ? quote.nextReserveOut : quote.nextReserveIn,
      txHash: makeDeterministicHex(
        `${chosen.poolId}:${direction}:${amountInBig.toString()}:${quote.amountOut.toString()}`
      ),
      txPos: chosen.txPos,
    };

    const preview = buildTransactionPreview({
      type: 'swap',
      pool: chosen,
      trader: {
        ...state.trader,
        bchAddress: traderAddress ?? state.trader.bchAddress,
      },
      direction,
      amountIn: amountInBig,
      fee: quote.fee,
      amountOut: quote.amountOut,
      nextPool,
    });

    return {
      ...preview,
      pool: buildUtxoSummary(chosen),
      nextPool: buildUtxoSummary(nextPool),
      quote,
    };
  }

  function applySwap({
    poolId,
    direction = 'bch-to-token',
    amountIn,
    traderAddress,
  }) {
    const preview = buildSwapPreview({
      poolId,
      direction,
      amountIn,
      traderAddress,
    });
    const poolIndex = state.pools.findIndex((pool) => pool.poolId === preview.poolId);
    if (poolIndex < 0) {
      throw new Error(`Unknown mock Cauldron pool: ${preview.poolId}`);
    }

    const current = state.pools[poolIndex];
    state.pools[poolIndex] = {
      ...current,
      reserveBchSats: preview.nextPool.sats,
      reserveTokens: preview.nextPool.tokens,
      txHash: preview.nextPool.txid,
    };

    const amountInBig = toBigInt(amountIn);
    if (direction === 'bch-to-token') {
      state.trader.bchSats -= amountInBig;
      state.trader.tokenSats += preview.amountOut;
    } else {
      state.trader.tokenSats -= amountInBig;
      state.trader.bchSats += preview.amountOut;
    }

    return {
      ...preview,
      snapshot: snapshot(),
    };
  }

  function buildLiquidityPreview({
    poolId,
    action = 'add-liquidity',
    bchAmount,
    tokenAmount,
  }) {
    const chosen = state.pools.find((pool) => pool.poolId === poolId) ?? state.pools[0];
    if (!chosen) {
      throw new Error('No mock Cauldron pools are available');
    }

    const bchDelta = toBigInt(bchAmount);
    const tokenDelta = toBigInt(tokenAmount);
    if (action === 'add-liquidity' && (bchDelta <= 0n || tokenDelta <= 0n)) {
      throw new Error('Liquidity additions require positive BCH and token amounts');
    }
    if (action === 'remove-liquidity' && (bchDelta <= 0n || tokenDelta <= 0n)) {
      throw new Error('Liquidity removals require positive BCH and token amounts');
    }
    if (action === 'remove-liquidity' && (
      chosen.reserveBchSats <= bchDelta || chosen.reserveTokens <= tokenDelta
    )) {
      throw new Error('Mock pool reserves are too small for the requested withdrawal');
    }
    const nextPool = {
      ...chosen,
      reserveBchSats:
        action === 'add-liquidity'
          ? chosen.reserveBchSats + bchDelta
          : chosen.reserveBchSats - bchDelta,
      reserveTokens:
        action === 'add-liquidity'
          ? chosen.reserveTokens + tokenDelta
          : chosen.reserveTokens - tokenDelta,
      txHash: makeDeterministicHex(
        `${chosen.poolId}:${action}:${bchDelta.toString()}:${tokenDelta.toString()}`
      ),
    };

    return {
      type: action,
      poolId: chosen.poolId,
      inputs: [
        createPoolUtxoRecord(chosen, chosen.reserveBchSats, chosen.reserveTokens, chosen.txHash),
        createWalletUtxo(state.trader.bchAddress, bchDelta),
        createWalletUtxo(state.trader.tokenAddress, TOKEN_OUTPUT_SATS, {
          category: chosen.tokenId,
          amount: tokenDelta,
        }),
      ],
      outputs: [
        createPoolUtxoRecord(nextPool, nextPool.reserveBchSats, nextPool.reserveTokens, nextPool.txHash),
        {
          address: state.trader.lpAddress,
          value: LP_RECEIPT_SATS,
          token: {
            category: NFT_CATEGORY_HEX,
            amount: 0n,
            nft: {
              capability: 'none',
              commitment: chosen.lpCommitment,
            },
          },
        },
      ],
    };
  }

  function getPoolById(poolId) {
    const pool = state.pools.find((entry) => entry.poolId === poolId) ?? null;
    return pool ? buildUtxoSummary(pool) : null;
  }

  function getMarketSnapshot() {
    const pools = listActivePools();
    const primary = pools[0] ?? null;
    const totalTvlSats = pools.reduce((sum, pool) => sum + toBigInt(pool.sats), 0n);
    const totalTvlTokens = pools.reduce((sum, pool) => sum + toBigInt(pool.tokens), 0n);

    return {
      ok: true,
      mode: 'mock',
      baseUrl: 'mock://cauldron',
      poolId: state.primaryPoolId,
      tokenId: state.tokenId,
      priceNowUsd: Number(state.oraclePriceRaw) / 100,
      tvlSats: Number(totalTvlSats),
      tvlTokens: Number(totalTvlTokens),
      pools,
      rawPrice: getCurrentPrice(),
      snapshot: snapshot(),
      primaryPool: primary,
      indexedTokens: listIndexedTokens(),
    };
  }

  return {
    provider,
    state,
    snapshot,
    listActivePools,
    listIndexedTokens,
    getCurrentPrice,
    getMarketSnapshot,
    getPoolById,
    findBestPool,
    buildSwapPreview,
    buildLiquidityPreview,
    applySwap,
    quoteConstantProductSwap,
  };
}
