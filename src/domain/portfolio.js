export function toBigInt(value, fallback = 0n) {
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

export function getUtxoSats(utxo) {
  return toBigInt(utxo?.satoshis ?? utxo?.value ?? utxo?.amount ?? 0n);
}

export function getTokenCategory(utxo) {
  return typeof utxo?.token?.category === 'string' ? utxo.token.category : '';
}

export function getTokenAmount(utxo) {
  return toBigInt(utxo?.token?.amount ?? 0n);
}

export function summarizeAddressUtxos(utxos, { stablecoinCategory, nftCategory, nftCommitment } = {}) {
  const state = {
    utxoCount: utxos.length,
    bchSats: 0n,
    stablecoinTokens: 0n,
    nftCount: 0,
    stablecoinUtxos: [],
    nftUtxos: [],
  };

  for (const utxo of utxos) {
    const sats = getUtxoSats(utxo);
    state.bchSats += sats;

    const category = getTokenCategory(utxo);
    const amount = getTokenAmount(utxo);

    if (stablecoinCategory && category === stablecoinCategory && amount > 0n) {
      state.stablecoinTokens += amount;
      state.stablecoinUtxos.push(utxo);
    }

    const commitment = utxo?.token?.nft?.commitment ?? '';
    if (
      nftCategory &&
      category === nftCategory &&
      amount === 0n &&
      (!nftCommitment || commitment === nftCommitment)
    ) {
      state.nftCount += 1;
      state.nftUtxos.push(utxo);
    }
  }

  return state;
}

export function summarizePortfolio({
  contractUtxos = [],
  treasuryUtxos = [],
  stablecoinCategory,
  nftCategory,
  nftCommitment,
}) {
  const contract = summarizeAddressUtxos(contractUtxos, { stablecoinCategory });
  const treasury = summarizeAddressUtxos(treasuryUtxos, {
    stablecoinCategory,
    nftCategory,
    nftCommitment,
  });

  return {
    contract,
    treasury,
    totalBchSats: contract.bchSats + treasury.bchSats,
    totalStablecoinTokens: contract.stablecoinTokens + treasury.stablecoinTokens,
  };
}

