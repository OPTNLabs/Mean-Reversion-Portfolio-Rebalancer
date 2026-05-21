import { ORACLE_PUBLIC_KEY_HEX } from '../../config.js';
import { fetchLatestOraclePrice } from '../../oracles/fetchOraclePrice.js';

export async function fetchOracleSnapshot({
  publicKey = ORACLE_PUBLIC_KEY_HEX,
  fallbackPriceRaw = 10_000,
} = {}) {
  if (!publicKey) {
    return {
      source: 'fallback',
      priceRaw: fallbackPriceRaw,
      priceScale: 100,
      priceValue: fallbackPriceRaw / 100,
      error: 'Missing ORACLE_PUBLIC_KEY_HEX',
    };
  }

  try {
    const snap = await fetchLatestOraclePrice({ publicKey });
    return {
      source: 'oracle',
      ...snap,
    };
  } catch (error) {
    return {
      source: 'fallback',
      priceRaw: fallbackPriceRaw,
      priceScale: 100,
      priceValue: fallbackPriceRaw / 100,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

