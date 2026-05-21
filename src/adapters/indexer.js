import {
  ALICE_ADDRESS,
  ALICE_TOKEN_ADDRESS,
  CONTRACT_ADDRESS,
  CONTRACT_TOKEN_ADDRESS,
  INDEXER_BASE_URL as DEFAULT_INDEXER_BASE_URL,
} from '../../config.js';
import { summarizeAddressUtxos } from '../domain/portfolio.js';

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Indexer request failed (${response.status} ${response.statusText}): ${text.slice(0, 160)}`
    );
  }
  if (!text.trim()) return null;
  return JSON.parse(text);
}

async function settle(value, fallback) {
  try {
    return await value;
  } catch {
    return fallback;
  }
}

export async function fetchAddressUtxos(address, { baseUrl = DEFAULT_INDEXER_BASE_URL } = {}) {
  const url = `${baseUrl}/api/utxos/${encodeURIComponent(address)}`;
  const json = await fetchJson(url);
  return Array.isArray(json?.utxos) ? json.utxos : [];
}

export async function fetchPortfolioUtxos({
  contractAddress = CONTRACT_ADDRESS,
  contractTokenAddress = CONTRACT_TOKEN_ADDRESS,
  aliceAddress = ALICE_ADDRESS,
  aliceTokenAddress = ALICE_TOKEN_ADDRESS,
  baseUrl = DEFAULT_INDEXER_BASE_URL,
} = {}) {
  const [contractUtxos, contractTokenUtxos, aliceUtxos, aliceTokenUtxos] =
    await Promise.all([
      fetchAddressUtxos(contractAddress, { baseUrl }),
      fetchAddressUtxos(contractTokenAddress, { baseUrl }),
      fetchAddressUtxos(aliceAddress, { baseUrl }),
      fetchAddressUtxos(aliceTokenAddress, { baseUrl }),
    ]);

  return {
    contractUtxos,
    contractTokenUtxos,
    aliceUtxos,
    aliceTokenUtxos,
  };
}

export async function fetchIndexerSnapshot({
  contractAddress = CONTRACT_ADDRESS,
  contractTokenAddress = CONTRACT_TOKEN_ADDRESS,
  aliceAddress = ALICE_ADDRESS,
  aliceTokenAddress = ALICE_TOKEN_ADDRESS,
  stablecoinCategory,
  nftCategory,
  nftCommitment,
  baseUrl = DEFAULT_INDEXER_BASE_URL,
} = {}) {
  const [contractUtxos, contractTokenUtxos, aliceUtxos, aliceTokenUtxos, health] =
    await Promise.all([
      settle(fetchAddressUtxos(contractAddress, { baseUrl }), []),
      settle(fetchAddressUtxos(contractTokenAddress, { baseUrl }), []),
      settle(fetchAddressUtxos(aliceAddress, { baseUrl }), []),
      settle(fetchAddressUtxos(aliceTokenAddress, { baseUrl }), []),
      settle(fetchIndexerHealth({ baseUrl }), { ok: false, error: 'Indexer health unavailable' }),
    ]);

  const contract = summarizeAddressUtxos(
    contractUtxos.concat(contractTokenUtxos),
    { stablecoinCategory }
  );
  const treasury = summarizeAddressUtxos(
    aliceUtxos.concat(aliceTokenUtxos),
    { stablecoinCategory, nftCategory, nftCommitment }
  );

  return {
    ok: Boolean(health.ok),
    health,
    addresses: {
      contractAddress,
      contractTokenAddress,
      aliceAddress,
      aliceTokenAddress,
    },
    raw: {
      contractUtxos,
      contractTokenUtxos,
      aliceUtxos,
      aliceTokenUtxos,
    },
    contract,
    treasury,
    totals: {
      totalBchSats: contract.bchSats + treasury.bchSats,
      totalStablecoinTokens: contract.stablecoinTokens + treasury.stablecoinTokens,
    },
  };
}

export async function fetchIndexerHealth({ baseUrl = DEFAULT_INDEXER_BASE_URL } = {}) {
  const url = `${baseUrl}/health`;
  try {
    const json = await fetchJson(url);
    return { ok: true, payload: json };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
