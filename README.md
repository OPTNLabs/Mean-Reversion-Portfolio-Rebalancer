# MRX – Mean-Reversion Portfolio Rebalancer (Chipnet Demo)

MRX is an **NFT-gated, oracle-driven mean-reversion strategy** between:

- BCH locked in a CashScript covenant on **chipnet**, and
- A single CashToken **FT** category behaving like a USD stablecoin (1 FT ≈ 1 USD).

The goal: keep the portfolio close to a **1:1 value balance** between BCH (in USD terms from an oracle) and the stablecoin FT, while:

- Using **loops + introspection** in CashScript V3,
- Using **CashTokens** (FT + NFT) for portfolio + authority,
- Integrating live BCH/USD prices from **oracles.cash**,
- Driving an **off-chain rebalancer** and a **dashboard** that reflect real chain state.

---

## 1. How It Works (On-Chain + Off-Chain Together)

### 1.1 Portfolio Model

- **Contract UTXO (portfolio)**

  - Holds:
    - `oldBch` – BCH in satoshis (e.g. 1 000 000 sats ≈ 0.01 BCH),
    - `oldTokens` – balance of a single stablecoin FT category.
  - Address: `contracts/MeanRevertSingleTokenNFTAuthV3.cash` compiled and deployed to chipnet.

- **Alice Treasury**

  - Two addresses:
    - `aliceAddress` – normal BCH P2PKH (BCH for fees + some backing),
    - `aliceTokenAddress` – CashToken P2PKH holding:
      - remaining stablecoin FTs,
      - a **Rebalancer NFT** (amount 0, known commitment) proving authority.
  - Alice is treated as the **off-chain treasury / LP**.

- **Target**
  - We conceptually want: `BCH_value_in_USD ≈ stablecoin_tokens`.
  - BCH value is derived from a BCH/USD oracle; each FT is treated as 1 USD.

---

### 1.2 On-Chain Logic – `MeanRevertSingleTokenNFTAuthV3.cash`

The contract is written against CashScript `^0.13.0` with loops enabled.

**Constructor parameters**

1. `bytes tokenCategory` – CashToken FT category (VM-order bytes) for the stablecoin.
2. `int targetTokenAmount` – target token balance (used for consistency; also touched to keep compiler happy).
3. `bytes rebalancerNftCat` – NFT category.
4. `bytes rebalancerNftCommit` – NFT commitment for the authorized rebalancer.
5. `bytes20 ownerPkh` – P2PKH hash for the contract owner (drain escape hatch).

#### 1.2.1 NFT-Gated Authority

- The `rebalance(int oraclePriceRaw)` function **loops over all inputs** (`do … while`) and checks:
  - `tx.inputs[k].tokenAmount == 0`
  - `tx.inputs[k].nftCommitment == rebalancerNftCommit`
- If no such pure-NFT input is found, `require(hasNftAuthority)` fails.
- Result: only the holder of the Rebalancer NFT UTXO may execute rebalances.

#### 1.2.2 Aggregating BCH with Loops

The contract identifies its own locking bytecode using `this.activeInputIndex`, then:

- **Inputs (oldBch)**  
  Loops over `tx.inputs` and, when `lockingBytecode == contractLock`, adds `tx.inputs[i].value` to `oldBch`.

- **Outputs (newBch)**  
  Loops over `tx.outputs` and, when `lockingBytecode == contractLock`, adds `tx.outputs[j].value` to `newBch`.

In this demo, the strategy keeps **BCH constant**, so `newBch == oldBch`, but the contract is written to support multiple UTXOs per side.

#### 1.2.3 Token Tracking

- `oldTokens` – token amount on **this contract’s own input** (`tx.inputs[contractIndex].tokenAmount`).
- `newTokens` – first output to the same locking script with `tokenAmount > 0`.
  - The contract loops over outputs; when it finds `lockingBytecode == contractLock` and `tokenAmount > 0`, it sets `newTokens` and stops.
  - If no such output is found, `newTokens` remains 0, allowing full exit from the FT position when improving value balance.

#### 1.2.4 Mean-Reversion Invariant

The covenant uses integer math to approximate BCH value in USD:

- Constants:

  - `BCH_SCALE_DOWN = 10_000`
  - `PRICE_SCALE = 100`

- Computation:

  - `oldBchScaled = oldBch / BCH_SCALE_DOWN`
  - `oldBchUsd = (oldBchScaled * oraclePriceRaw) / BCH_SCALE_DOWN / PRICE_SCALE`
  - Analogously for `newBchUsd`.

- Imbalance:
  - `beforeDelta = |oldBchUsd - oldTokens|`
  - `afterDelta  = |newBchUsd - newTokens|`
  - Contract requires: `afterDelta <= beforeDelta`

So any valid rebalance **must not make the mismatch between BCH(USD-ish) and FT tokens worse**.

#### 1.2.5 Drain Escape Hatch

`drain(pubkey ownerPk, sig ownerSig)`:

- Verifies `hash160(ownerPk) == ownerPkh`,
- `checkSig(ownerSig, ownerPk)`,
- Then imposes no further restrictions – owner can completely empty the contract (BCH + tokens).

---

### 1.3 Off-Chain Automation – Node Scripts + oracles.cash + Dashboard

#### 1.3.1 Oracle Integration (`oracles/`)

- `oracles/fetchOraclePrice.js`
  - Calls the General Protocols oracle API (`/api/v1/oracleMessages`),
  - Decodes the signed message via `priceCodec.js`,
  - Returns:
    - `priceRaw` (e.g. 54068 for $540.68),
    - `priceScale` (usually 100),
    - `priceValue` (floating USD),
    - timestamp and other metadata.
- `oraclesClient.js` is a small helper wrapper used by scripts.

An environment variable `ORACLE_PUBLIC_KEY_HEX` selects which oracles.cash key to follow.

#### 1.3.2 Rebalancer Script – `scripts/rebalanceWithOracleV3.js`

This is the core off-chain strategy engine for the demo.

High-level flow:

1. **Discover current portfolio**

   - Reconstructs the contract using `compileFile` + constructor args.
   - Calls `contract.getUtxos()` to find the current contract UTXO with the FT category.
   - Reads:
     - `oldBch` – BCH satoshis from that UTXO,
     - `oldTokens` – current FT amount on the contract.

2. **Fetch live oracle price**

   - Uses `fetchLatestOraclePrice({ publicKey: ORACLE_PUBLIC_KEY_HEX })`.
   - Extracts `oraclePriceRaw` (BCH/USD × 100) and logs human-readable price.

3. **Compute mean-reverting tokenDelta (withdraw-only)**

   - Computes `bchUsd` using the same formula as on-chain.
   - Target token amount ≈ `bchUsd`.
   - If `targetTokens >= oldTokens`, the portfolio would need **more** tokens to mean-revert; since this demo only supports withdrawals from the contract, the script exits without action.
   - Otherwise (`targetTokens < oldTokens`):
     - Let `gap = oldTokens - targetTokens`.
     - Start with `step = gap / 2` (at least 1).
     - Define `newTokens = oldTokens - step`.
     - Compute `D_before` and `D_after` using the same integer math as the contract.
     - If `D_after >= D_before`, repeatedly halve `step` until improvement or until `step == 1`.
     - If no improving step is found, skip the rebalance.
     - Otherwise, this `step` becomes `tokenDelta`, and `newTokens = oldTokens - tokenDelta`.

4. **Gather authority + fee UTXOs**

   - From `aliceTokenAddress`, finds:
     - A pure NFT UTXO with:
       - `category == NFT_CATEGORY_HEX`,
       - `amount == 0`,
       - matching `commitment = REBALANCER_NFT_COMMITMENT_HEX`.
   - From `aliceAddress`, selects a BCH-only UTXO for paying fees.

5. **Build rebalance transaction (two-pass)**

   - **Inputs:**
     - Contract portfolio UTXO (unlocked by `contract.unlock.rebalance(oraclePriceRaw)`),
     - NFT authority UTXO (P2PKH),
     - BCH fee UTXO (P2PKH).
   - **Outputs:**

     - Contract token UTXO: same BCH, `newTokens` FT.
     - Alice token UTXO: receives `tokenDelta` FT with dust BCH.
     - NFT UTXO: NFT returned to `aliceTokenAddress`.
     - BCH change: back to `aliceAddress` after fee.

   - First pass (`estBuilder`) builds a provisional tx to estimate size and fees; then the script checks there is enough BCH for:
     - unchanged portfolio BCH,
     - dust for FT outputs,
     - dust for NFT, and
     - miner fees.
   - Second pass builds the final transaction and broadcasts it.

6. **Safety / sanity**
   - The script asserts `D_after < D_before` before sending.
   - Total tokens in inputs == total tokens in outputs (no burns), so `allowImplicitFungibleTokenBurn` is not required.

#### 1.3.3 Dashboard (`mean-revert-dashboard/`)

- **Backend:** `server/indexerProxy.mjs`
  - `GET /api/utxos/:address` – proxy to `ElectrumNetworkProvider.getUtxos` (chipnet),
  - `GET /api/oracle/price` – fetches oracle snapshot using the same `fetchOraclePrice.js`.
  - Used by the React app to display live values.
- **Frontend:** `src/MeanRevertDashboard.tsx`
  - Shows:
    - Current FT + BCH balances on the contract and Alice,
    - Live oracle BCH/USD price (with a slider to simulate other prices),
    - Token and BCH distribution bars,
    - An off-chain math panel showing `D` before / after.
  - Reads configuration such as addresses and FT category from `meanRevertConfig.ts`.

All dashboard views are **read-only** and reflect whatever is actually on chipnet.

---

## 2. Running the Demo (Chipnet)

### 2.1 Prerequisites

- Node.js (v18+ recommended),
- NPM,
- Internet access (for chipnet Electrum + oracles.cash),
- Some chipnet BCH to fund Alice (for minting + fees).

### 2.2 Install Dependencies (root + dashboard)

From the `loops/` root:

    npm install
    cd mean-revert-dashboard
    npm install
    cd ..

### 2.3 Seed Demo State

The scripts assume you are on **chipnet** and `config.js` is configured accordingly.

Recommended order:

    node scripts/seedVoutZeroUtxos.js          # optional – create seed UTXOs for tests
    node scripts/mintAllForAlice.js            # mint stablecoin FT + rebalancer NFT to Alice
    node scripts/consolidateAliceFtCategory.js # optional – clean up FT UTXOs
    node scripts/deployMeanRevertV3.chipnet.js # deploy the V3 covenant to chipnet
    node scripts/fundMeanRevertV3FromAlice.js  # fund the contract with BCH + FT
    node scripts/inspectMeanRevertV3State.js   # verify contract portfolio

After this, the contract should hold the demo BCH amount (e.g. 1 000 000 sats) and an FT balance, with Alice holding the remainder FT + the NFT.

### 2.4 Run Oracle-Driven Rebalance

Set your oracles.cash public key:

    export ORACLE_PUBLIC_KEY_HEX="<oracles_cash_pubkey>"

Then run the rebalance:

    node scripts/rebalanceWithOracleV3.js
    node scripts/inspectMeanRevertV3State.js

Each successful run:

- Leaves BCH on the contract unchanged,
- Withdraws a dynamically chosen `tokenDelta` FT to Alice,
- Ensures `D_after < D_before` according to the on-chain math.

If the portfolio is already balanced at the current price, or if the oracle suggests **adding** tokens to the contract, the script logs a message and skips sending a transaction (withdraw-only demo).

To reset everything back to Alice:

    node scripts/resetMeanRevertV3ToAlice.js
    node scripts/inspectMeanRevertV3State.js

### 2.5 Run the Dashboard (Optional but Recommended)

1. Start the backend indexer proxy:

   export ORACLE_PUBLIC_KEY_HEX="<oracles_cash_pubkey>"
   export NETWORK="chipnet"
   node mean-revert-dashboard/server/indexerProxy.mjs

2. Start the React UI:

   cd mean-revert-dashboard
   npm run dev

3. Open the shown URL (typically `http://localhost:5173`) and you’ll see:

   - Live oracle price (BCH/USD),
   - Live FT + BCH balances for the contract + Alice,
   - Visual token/BCH bars and an off-chain `D` preview tied to the oracle price.

---

## 3. Repository Layout (Submission Snapshot)

From the `loops/` root:

    .
    ├─ README.md                            # This file
    ├─ contracts/
    │   └─ MeanRevertSingleTokenNFTAuthV3.cash   # Final loops-based NFT-gated covenant
    ├─ scripts/
    │   ├─ mintAllForAlice.js              # Mint FT + NFT to Alice
    │   ├─ fundMeanRevertV3FromAlice.js    # Fund portfolio on contract
    │   ├─ rebalanceWithOracleV3.js        # Oracle-driven mean reversion (withdraw-only)
    │   ├─ inspectMeanRevertV3State.js     # Inspect contract balances on chipnet
    │   ├─ resetMeanRevertV3ToAlice.js     # Drain portfolio back to Alice
    │   ├─ burnAllTokensFromAlice.js       # Cleanup helper
    │   ├─ consolidateAliceFtCategory.js   # FT UTXO consolidation helper
    │   ├─ deployMeanRevertV3.chipnet.js   # Covenant deploy script
    │   └─ seedVoutZeroUtxos.js            # Optional test funding helper
    ├─ oracles/
    │   ├─ fetchOraclePrice.js             # oracles.cash client (used by scripts + dashboard)
    │   ├─ oraclesClient.js                # small wrapper for CLI usage
    │   └─ priceCodec.js                   # oracle message decoding
    ├─ mean-revert-dashboard/
    │   ├─ server/indexerProxy.mjs         # UTXO + oracle proxy (Electrum + oracles.cash)
    │   └─ src/…                           # React + Vite dashboard UI
    ├─ tests/
    │   ├─ meanRevert.math.v3.test.js      # unit tests for the mean-reversion math
    │   ├─ meanRevert.v3.mocknet.test.js   # mocknet integration tests for the covenant
    │   └─ priceCodec.test.js              # oracle message decoding tests
    ├─ common.js                           # shared key/address derivation (Alice, etc.)
    ├─ config.js                           # network, categories, dust, fees, etc.
    ├─ contract.js                         # helper to compile/instantiate the covenant
    ├─ bigint.js                           # safe BigInt formatting utilities
    ├─ utxos.js                            # UTXO helpers (BCH vs token-bearing)
    ├─ package.json / package-lock.json
    └─ index.js                            # legacy entry (kept minimal for this demo)

---

## 4. Key Results (Wins)

- Loops-based CashScript V3 covenant that:
  - Iterates over transaction inputs/outputs with `do … while`, and
  - Aggregates BCH + token balances for the contract.
- NFT-gated authority:
  - Only a specific Rebalancer NFT (amount 0, known commitment) can authorize rebalances.
- On-chain **value-based mean reversion**:
  - Enforces `D_after ≤ D_before` where `D = | BCH(USD-ish) − tokens |`.
- Live **oracles.cash integration**:
  - Scripts fetch signed BCH/USD prices and feed them directly into covenant calls.
- Dynamic off-chain strategy:
  - `rebalanceWithOracleV3.js` computes a **variable tokenDelta** based on oracle price, rather than a fixed step.
- End-to-end chipnet demo:
  - Mint → fund → oracle-driven rebalance → visualize state in dashboard.
- Tests:
  - Math tests, mocknet covenant tests, and oracle decoding tests to keep behavior stable.

---

## 5. Areas for Improvement / Next Steps

- **Bidirectional rebalancing**

  - Current demo only **withdraws** tokens from the contract when over-exposed to FT.
  - Next: support adding tokens back when BCH value drops below the FT balance.

- **Multi-UTXO portfolios**

  - Scripts currently focus on a single main portfolio UTXO.
  - Next: handle arbitrary sets of contract UTXOs on both input and output sides.

- **Richer strategy constraints**

  - Add configurable maximum `tokenDelta` per rebalance,
  - Add time-based rate limits or multi-signature NFT control.

- **Dashboard enhancements**

  - Historical charts (price vs portfolio imbalance),
  - Tx history with links to block explorers,
  - Simulated “what-if” paths over a price series.

- **Production-grade security**
  - Harden oracle key rotation handling,
  - Monitor oracle liveness / sanity checks,
  - Add monitoring/alerting for failed or skipped rebalances.

---

### License

MIT (or equivalent permissive license) – © OPTNLabs 2025.
