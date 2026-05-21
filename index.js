import { compileMeanRevertContract } from './src/contract/compile.js';
import {
  loadSnapshot,
  printPortfolioPlanOnce,
  runTui,
} from './src/tui/app.js';
import { renderQuantumrootSpikeReport } from './src/vaulting/quantumrootSpike.js';
import {
  PROJECT_NAME,
  PROJECT_TAGLINE,
  NETWORK,
} from './config.js';

function usage() {
  console.log(`${PROJECT_NAME}`);
  console.log(PROJECT_TAGLINE);
  console.log('');
  console.log('Usage: node index.js <command>');
  console.log('');
  console.log('Commands:');
  console.log('  tui                start the terminal UI');
  console.log('  plan               print the current portfolio rebalance plan');
  console.log('  status             print the current live indexer snapshot');
  console.log('  compile-contract   compile the covenant artifact');
  console.log('  research quantumroot');
  console.log('');
  console.log(`Network: ${NETWORK}`);
}

async function runStatus() {
  const snapshot = await loadSnapshot();
  console.log(`${PROJECT_NAME} status`);
  console.log('');
  console.log(`Indexer health: ${snapshot.indexerHealth?.ok ? 'ok' : 'degraded'}`);
  console.log(
    `Chain tip: ${snapshot.indexerHealth?.payload?.chain_tip ?? 'n/a'} | indexed: ${
      snapshot.indexerHealth?.payload?.indexed_height ?? 'n/a'
    } | version: ${snapshot.indexerHealth?.payload?.version ?? 'n/a'}`
  );
  console.log(`Oracle source: ${snapshot.oracle?.source ?? 'unknown'}`);
  console.log(`Oracle price: ${snapshot.oracle?.priceValue ?? 'n/a'}`);
  console.log(
    `Token: ${snapshot.market?.tokenRow?.display_name ?? 'n/a'} (${snapshot.market?.tokenRow?.display_symbol ?? 'n/a'})`
  );
  console.log(
    `Price: ${snapshot.market?.tokenRow?.price_now_usd ?? snapshot.market?.priceNowUsd ?? 'n/a'} USD | APY 30d: ${
      snapshot.market?.tokenRow?.apy_30d_bp ?? 'n/a'
    } bp`
  );
  console.log(`Cauldron pools: ${Array.isArray(snapshot.market?.pools) ? snapshot.market.pools.length : 0}`);
  console.log('');
  console.log('Top pools');
  for (const pool of Array.isArray(snapshot.market?.pools)
    ? snapshot.market.pools.slice(0, 3)
    : []) {
    console.log(
      `  ${pool.pool_id ?? 'n/a'} | ${String(pool.sats ?? pool.tvl_sats ?? 0)} sats | ${String(pool.tokens ?? pool.tvl_tokens ?? 0)} tokens | owner ${String(pool.owner_p2pkh_addr ?? 'n/a')}`
    );
  }
}

async function main() {
  const [cmd, subcmd] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'tui') {
    await runTui();
    return;
  }

  if (cmd === 'plan') {
    await printPortfolioPlanOnce();
    return;
  }

  if (cmd === 'status') {
    await runStatus();
    return;
  }

  if (cmd === 'compile-contract') {
    const artifact = compileMeanRevertContract();
    console.log('Compiled artifact written to artifacts/MeanRevertSingleTokenNFTAuthV3.json');
    console.log(`Contract bytecode length: ${artifact.bytecode.length}`);
    return;
  }

  if (cmd === 'research' && subcmd === 'quantumroot') {
    console.log(renderQuantumrootSpikeReport());
    return;
  }

  usage();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
