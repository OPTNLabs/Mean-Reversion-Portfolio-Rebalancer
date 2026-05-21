# BCH Rebalancer

Standalone chipnet-first mean-reversion rebalancer for BCH and a stablecoin.

This repo was forked out of the earlier `loops` demo and reorganized around:

- a stricter CashScript covenant with single-portfolio-UTXO semantics,
- a reusable rebalancing planner,
- a terminal UI for chipnet monitoring,
- adapter layers for oracle, indexer, and Cauldron integration,
- a separate Quantumroot customization research spike.

The primary workflow is the live Cauldron server. Mocknet is retained for
internal tests and fixture validation only.

## What is in scope

- BCH vs stablecoin portfolio rebalancing
- chipnet reads for portfolio, oracle, and market state
- TUI-driven inspection and dry-run planning
- contract compilation for the current CashScript `next` line
- vaulting research that stays separate from the wallet app

## What is not in scope yet

- production broadcast automation
- wallet integration inside OPTN Wallet
- custom swap routing across multiple DEXs

## Commands

```bash
npm install
npm run tui
npm run plan
npm run status
npm run compile-contract
npm run research:quantumroot
npm run mock:tui
npm run mock:plan
```

## Environment

The repo runs with chipnet defaults, but these can be overridden:

- `ORACLE_PUBLIC_KEY_HEX`
- `INDEXER_BASE_URL`
- `CAULDRON_API_BASE_URL`
- `CAULDRON_CHIPNET_API_BASE_URL`
- `CAULDRON_POOL_ID`
- `CAULDRON_TOKEN_ID`
- `CAULDRON_PUBLIC_KEY_HASH`
- `CONTRACT_ADDRESS`
- `CONTRACT_TOKEN_ADDRESS`
- `ALICE_ADDRESS`
- `ALICE_TOKEN_ADDRESS`
- `BIP39_MNEMONIC` for the legacy wallet helper scripts in `common.js`
- `CAULDRON_MODE` (`live` or `mock`)
- `MOCK_ORACLE_PRICE_RAW`

Copy `.env.example` to `.env` and fill in the mnemonic locally. The real `.env`
file is ignored by git.

## Mocknet Structure

For internal testing, the repo keeps a seeded mock Cauldron ledger built on
`MockNetworkProvider`.

The required structure is:

- pool UTXO
  - holds BCH reserve + stablecoin reserve
  - keyed by `poolId` and `tokenId`
  - used by the swap quote planner and market snapshot adapter
- trader BCH UTXO
  - pays BCH into the swap and fees
- trader token UTXO
  - represents the stablecoin side of the portfolio
- LP receipt / NFT UTXO
  - stands in for pool authority or LP position tracking
- oracle snapshot
  - provides the BCH/USD reference for the rebalancer
- adapter mode switch
  - `CAULDRON_MODE=mock` uses the local fixture only
  - no chipnet or mainnet broadcast is involved
  - live runs use the Cauldron API server and the indexer instead

The mock ledger is intentionally off-chain:

- it exercises UTXO shape, pool accounting, and planner decisions
- it does not require live DEX infrastructure
- it can be seeded and inspected entirely inside tests

For live runs, the Cauldron API defaults to the Riften chipnet endpoint used by
the OPTN wallet Cauldron add-on setup:

- `https://indexer-chipnet.riften.net/cauldron`

On mainnet, the equivalent default is:

- `https://indexer.riften.net/cauldron`

## Notes

- The covenant source lives at `contracts/MeanRevertSingleTokenNFTAuthV3.cash`.
- The contract is intentionally conservative:
  - one portfolio input,
  - one portfolio output,
  - one pure NFT authority input,
  - no BCH leakage across the rebalance.
- The legacy React dashboard folder from the fork is left in place for reference, but the new workflow is TUI-first.
