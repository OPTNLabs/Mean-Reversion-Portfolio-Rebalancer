import {
  CAULDRON_API_BASE_URL as DEFAULT_CAULDRON_API_BASE_URL,
  CAULDRON_TOKEN_ID as DEFAULT_CAULDRON_TOKEN_ID,
} from '../../config.js';

const DEFAULT_BASE_URL = DEFAULT_CAULDRON_API_BASE_URL;

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Cauldron request failed (${response.status} ${response.statusText}): ${text.slice(0, 160)}`
    );
  }
  return text.trim() ? JSON.parse(text) : null;
}

function asNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function asBigInt(value, fallback = 0n) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === 'string' && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return fallback;
    }
  }
  return fallback;
}

class MockCauldronAdapter {
  constructor({ fixture } = {}) {
    this.fixture = fixture;
  }

  async listActivePools() {
    return this.fixture?.listActivePools?.() ?? [];
  }

  async getCurrentPrice() {
    return this.fixture?.getCurrentPrice?.() ?? null;
  }

  async getPoolHistory() {
    return [];
  }

  async getMarketSnapshot() {
    if (typeof this.fixture?.getMarketSnapshot === 'function') {
      return this.fixture.getMarketSnapshot();
    }

    const snapshot = this.fixture?.snapshot?.();
    const pools = await this.listActivePools();
    const price = await this.getCurrentPrice();
    const primary = Array.isArray(pools) ? pools[0] : null;
    const tvlSats = Array.isArray(pools)
      ? pools.reduce((sum, pool) => sum + BigInt(asNumber(pool?.sats ?? pool?.tvl_sats, 0)), 0n)
      : 0n;
    const tvlTokens = Array.isArray(pools)
      ? pools.reduce((sum, pool) => sum + BigInt(asNumber(pool?.tokens ?? pool?.tvl_tokens, 0)), 0n)
      : 0n;
    return {
      ok: true,
      mode: 'mock',
      baseUrl: 'mock://cauldron',
      poolId: snapshot?.poolId ?? null,
      tokenId: snapshot?.tokenId ?? null,
      priceNowUsd: price ? asNumber(price.price_now_usd ?? price.price_now, 0) : 0,
      tvlSats: Number(tvlSats),
      tvlTokens: Number(tvlTokens),
      pools,
      rawPrice: price,
      snapshot,
      primaryPool: primary,
    };
  }
}

export class CauldronAdapter {
  constructor({
    baseUrl = DEFAULT_BASE_URL,
    poolId = process.env.CAULDRON_POOL_ID ?? '',
    tokenId = process.env.CAULDRON_TOKEN_ID ?? DEFAULT_CAULDRON_TOKEN_ID,
    publicKeyHash = process.env.CAULDRON_PUBLIC_KEY_HASH ?? '',
  } = {}) {
    this.baseUrl = baseUrl;
    this.poolId = poolId;
    this.tokenId = tokenId;
    this.publicKeyHash = publicKeyHash;
  }

  async listActivePools() {
    const search = new URLSearchParams();
    if (this.tokenId) {
      search.set('token', this.tokenId);
    }
    if (this.publicKeyHash) {
      search.set('pkh', this.publicKeyHash);
    }
    if (!search.toString()) return [];
    const url = `${this.baseUrl}/pool/active?${search.toString()}`;
    const payload = await fetchJson(url);
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.active)) return payload.active;
    if (Array.isArray(payload?.pools)) return payload.pools;
    return [];
  }

  async getCurrentPrice() {
    const pools = await this.listActivePools().catch(() => []);
    const effectiveTokenId =
      this.tokenId ||
      (Array.isArray(pools) && pools.length > 0
        ? pools[0]?.token_id ?? pools[0]?.token ?? pools[0]?.category ?? ''
        : '');
    if (!effectiveTokenId) return null;
    const url = `${this.baseUrl}/price/${encodeURIComponent(effectiveTokenId)}/current`;
    const payload = await fetchJson(url);
    return payload && typeof payload === 'object' ? payload : null;
  }

  async listCachedTokens(params = {}) {
    const search = new URLSearchParams();
    search.set('limit', String(params.limit ?? 500));
    search.set('offset', String(params.offset ?? 0));
    search.set('by', params.by ?? 'score');
    search.set('order', params.order ?? 'desc');
    const url = `${this.baseUrl}/tokens/list_cached?${search.toString()}`;
    const payload = await fetchJson(url);
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.tokens)) return payload.tokens;
    return [];
  }

  async listCachedTokensByIds(tokenIds) {
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) return [];
    const search = new URLSearchParams({
      ids: tokenIds.join(','),
    });
    const url = `${this.baseUrl}/tokens/list_cached_by_ids?${search.toString()}`;
    const payload = await fetchJson(url);
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.tokens)) return payload.tokens;
    return [];
  }

  async getPoolHistory(startTimestamp) {
    if (!this.poolId) return [];
    const search = new URLSearchParams();
    if (typeof startTimestamp === 'number' && Number.isFinite(startTimestamp)) {
      search.set('start', String(Math.trunc(startTimestamp)));
    }
    const url = `${this.baseUrl}/pool/history/${encodeURIComponent(this.poolId)}${
      search.size ? `?${search.toString()}` : ''
    }`;
    const payload = await fetchJson(url);
    return Array.isArray(payload?.history) ? payload.history : [];
  }

  async getMarketSnapshot() {
    try {
      const [price, pools, tokenRows, aggregatedApy] = await Promise.all([
        this.getCurrentPrice().catch(() => null),
        this.listActivePools().catch(() => []),
        this.listCachedTokensByIds([this.tokenId]).catch(() => []),
        this.tokenId
          ? fetchJson(
              `${this.baseUrl}/pool/aggregated_apy?${new URLSearchParams({
                token: this.tokenId,
              }).toString()}`
            ).catch(() => null)
          : Promise.resolve(null),
      ]);

      const primary = Array.isArray(pools) ? pools[0] : null;
      const tokenRow = Array.isArray(tokenRows) ? tokenRows[0] ?? null : null;
      const aggregated = Array.isArray(pools)
        ? pools.reduce(
            (sum, pool) => ({
              sats: sum.sats + BigInt(asNumber(pool?.sats ?? pool?.tvl_sats, 0)),
              tokens:
                sum.tokens + BigInt(asNumber(pool?.tokens ?? pool?.tvl_tokens, 0)),
            }),
            { sats: 0n, tokens: 0n }
          )
        : { sats: 0n, tokens: 0n };
      return {
        ok: true,
        mode: 'live',
        baseUrl: this.baseUrl,
        poolId: this.poolId || null,
        tokenId: this.tokenId || null,
        publicKeyHash: this.publicKeyHash || null,
        priceNowUsd: tokenRow ? asNumber(tokenRow.price_now_usd ?? tokenRow.price_now, 0) : 0,
        priceRaw: price ? asNumber(price.price ?? price.price_now ?? price.price_now_usd, 0) : 0,
        tvlSats: Number(aggregated.sats),
        tvlTokens: Number(aggregated.tokens),
        pools,
        rawPrice: price,
        primaryPool: primary,
        tokenRow,
        aggregatedApy,
        poolIds: Array.isArray(pools)
          ? pools.map((pool) => pool?.pool_id ?? pool?.poolId ?? null).filter(Boolean)
          : [],
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        baseUrl: this.baseUrl,
        poolId: this.poolId || null,
        tokenId: this.tokenId || null,
        publicKeyHash: this.publicKeyHash || null,
        priceNowUsd: 0,
        tvlSats: 0,
        tvlTokens: 0,
        pools: [],
        rawPrice: null,
        primaryPool: null,
        poolIds: [],
      };
    }
  }
}

export function createCauldronAdapter(options = {}) {
  if (options.mode === 'mock' || options.fixture) {
    return new MockCauldronAdapter({ fixture: options.fixture });
  }
  return new CauldronAdapter(options);
}

export { MockCauldronAdapter };
