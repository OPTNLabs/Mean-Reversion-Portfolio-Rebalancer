// utxos.js

// Split UTXOs into BCH-only vs token-bearing
export function splitByToken(utxos) {
  const bchOnly = [];
  const withTokens = [];
  for (const u of utxos) {
    if (u.token) withTokens.push(u);
    else bchOnly.push(u);
  }
  return { bchOnly, withTokens };
}

// Group token UTXOs by category
export function groupTokenUtxosByCategory(tokenUtxos) {
  const map = new Map();
  for (const u of tokenUtxos) {
    const cat = u.token.category;
    const arr = map.get(cat) ?? [];
    arr.push(u);
    map.set(cat, arr);
  }
  return map;
}

// Pretty-print any UTXO set
export function logUtxoSummary(label, utxos) {
  console.log(`\n=== ${label} UTXOs ===`);
  console.log(`Total UTXOs: ${utxos.length}`);

  if (utxos.length === 0) {
    console.log("(none)\n");
    return;
  }

  const { bchOnly, withTokens } = splitByToken(utxos);
  const totalBch = bchOnly.reduce((sum, u) => sum + u.satoshis, 0n);

  console.log(`BCH-only UTXOs: ${bchOnly.length}`);
  console.log(`  Total BCH: ${totalBch} sats`);

  if (withTokens.length > 0) {
    console.log(`Token UTXOs: ${withTokens.length}`);
    const grouped = groupTokenUtxosByCategory(withTokens);
    for (const [cat, arr] of grouped.entries()) {
      const tokenTotal = arr.reduce((s, u) => s + u.token.amount, 0n);
      const satTotal = arr.reduce((s, u) => s + u.satoshis, 0n);
      console.log(
        `  - category ${cat}: ${arr.length} UTXOs, ${tokenTotal} tokens, backing ${satTotal} sats`
      );
    }
  }

  console.log("");
}

// Pick a BCH UTXO with at least `required` sats
export function selectFundingUtxo(bchOnly, required) {
  const sorted = [...bchOnly].sort((a, b) =>
    a.satoshis > b.satoshis ? -1 : 1
  );
  return sorted.find((u) => u.satoshis >= required) ?? null;
}

// Track address state via provider
export async function logAddressState(label, provider, address) {
  const utxos = await provider.getUtxos(address);
  logUtxoSummary(label, utxos);
  return utxos;
}

// Track contract state via contract.getUtxos()
export async function logContractState(label, contract) {
  const utxos = await contract.getUtxos();
  logUtxoSummary(label, utxos);
  return utxos;
}
