// mean-revert-dashboard/src/MeanRevertDashboard.tsx

import "./App.css";
import { useEffect, useMemo, useState } from "react";

import {
  NETWORK_NAME,
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
  CONTRACT_TOKEN_ADDRESS,
  ALICE_ADDRESS,
  ALICE_TOKEN_ADDRESS,
  PRICE_RAW,
  TARGET_TOKENS,
  INITIAL_TOKENS_ON_CONTRACT,
} from "./meanRevertConfig";
import { useMeanRevertState } from "./hooks/useMeanRevertState";
import { fetchDemoSummary, type DemoSummary } from "./api/demo";

function formatBigInt(v: bigint | null | undefined): string {
  if (v == null) return "Error";
  return v.toString();
}

function formatUsd(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "$–";
  return `$${x.toFixed(2)}`;
}

export function MeanRevertDashboard() {
  const {
    loading,
    error: utxoError,
    contract,
    alice,
    reload,
  } = useMeanRevertState();

  // --- oracle / slider state ------------------------------------------------

  const [demo, setDemo] = useState<DemoSummary | null>(null);
  const [oracleError, setOracleError] = useState<string | null>(null);

  const [sliderMinUsd, setSliderMinUsd] = useState(500);
  const [sliderMaxUsd, setSliderMaxUsd] = useState(600);
  const [sliderUsd, setSliderUsd] = useState(550);
  const [sliderInitialised, setSliderInitialised] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loadOnceAndSchedule() {
      try {
        const summary = await fetchDemoSummary();
        if (cancelled) return;

        setDemo(summary);
        setOracleError(
          summary.source === "fallback" ? summary.error ?? null : null
        );

        // Initialise slider range around the live oracle price.
        if (!sliderInitialised) {
          const center =
            summary.priceUsd && Number.isFinite(summary.priceUsd)
              ? summary.priceUsd
              : PRICE_RAW / 100; // rough fallback

          const span = 50;
          setSliderMinUsd(Math.max(1, Math.floor(center - span)));
          setSliderMaxUsd(Math.floor(center + span));
          setSliderUsd(center);
          setSliderInitialised(true);
        }
      } catch (e: any) {
        if (cancelled) return;
        console.error("Oracle load failed:", e);
        setOracleError(e?.message ?? String(e));
      } finally {
        if (!cancelled) {
          timer = setTimeout(loadOnceAndSchedule, 30_000); // refresh every 30s
        }
      }
    }

    loadOnceAndSchedule();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sliderInitialised]);

  const visualPriceUsd = sliderUsd;
  const livePriceUsd = demo?.priceUsd ?? null;
  const priceRawForMath = demo?.priceRaw ?? PRICE_RAW;
  const priceScaleForMath = demo?.priceScale ?? 100;

  // --- derived on-chain state ----------------------------------------------

  const contractBchText = contract
    ? `${formatBigInt(contract.bchLocked)} sats`
    : "Error";

  const contractFtText = contract
    ? `${formatBigInt(contract.ftOnContract)} FT`
    : "Error";

  const aliceBchP2pkhText = alice
    ? `${formatBigInt(alice.bchP2pkhOnly)} sats`
    : "Error";

  const aliceFtBackingText = alice
    ? `${formatBigInt(alice.ftBackingBch)} sats`
    : "Error";

  const aliceFtHeldText = alice ? `${formatBigInt(alice.ftHeld)} FT` : "Error";
  const aliceNftCountText = alice ? `${alice.nftCount}` : "Error";

  const contractTokens = contract?.ftOnContract ?? 0n;
  const aliceTokens = alice?.ftHeld ?? 0n;
  const totalTokens = contractTokens + aliceTokens;

  const contractVsTargetText = useMemo(() => {
    if (!contract) return "Error";
    const current = contract.ftOnContract;
    if (current === TARGET_TOKENS) return "On target (0 token gap)";
    if (current < TARGET_TOKENS) {
      const gap = TARGET_TOKENS - current;
      return `${gap.toString()} tokens below target`;
    }
    const surplus = current - TARGET_TOKENS;
    return `${surplus.toString()} tokens above target`;
  }, [contract]);

  // As percentages for visual bars.
  const tokenDistribution = useMemo(() => {
    if (totalTokens <= 0n) {
      return { contractPct: 0, alicePct: 0 };
    }
    const contractPct = Number((contractTokens * 10000n) / totalTokens) / 100; // 2dp
    const alicePct = 100 - contractPct;
    return { contractPct, alicePct };
  }, [contractTokens, totalTokens]);

  const bchDistribution = useMemo(() => {
    const contractSats = contract?.bchLocked ?? 0n;
    const aliceSats = alice?.ftBackingBch ?? 0n; // "backing" BCH at token address
    const total = contractSats + aliceSats;
    if (total <= 0n) {
      return { contractPct: 0, alicePct: 0 };
    }
    const contractPct = Number((contractSats * 10000n) / total) / 100;
    const alicePct = 100 - contractPct;
    return { contractPct, alicePct };
  }, [contract, alice]);

  const satsToUsd = (s: bigint): number =>
    (Number(s) / 1e8) * (visualPriceUsd || 0);

  const contractBchUsd = satsToUsd(contract?.bchLocked ?? 0n);
  const aliceBchUsd = satsToUsd(alice?.ftBackingBch ?? 0n);

  // NEW: contract value mix (BCH vs FT) at visual price
  const contractTokenUsd = Number(contractTokens); // 1 FT ≈ 1 USD
  const contractTotalUsd = contractBchUsd + contractTokenUsd;

  const contractValueMix = useMemo(() => {
    if (contractTotalUsd <= 0) {
      return { bchPct: 0, tokenPct: 0 };
    }
    const bchPct = (contractBchUsd / contractTotalUsd) * 100;
    const tokenPct = 100 - bchPct;
    return { bchPct, tokenPct };
  }, [contractTotalUsd, contractBchUsd]);

  // Covenant-like imbalance metric (very approximate, just for off-chain preview)
  const D_before = useMemo(() => {
    const bchUsdish =
      (Number(contract?.bchLocked ?? 0n) * priceRawForMath) / 1e10; // satoshis * priceRaw / 10^10
    const tokens = Number(contractTokens); // assume 1 token ≈ 1 USD
    return Math.abs(bchUsdish - tokens);
  }, [contract, contractTokens, priceRawForMath]);

  // --- error merge ---------------------------------------------------------

  const combinedError = oracleError || utxoError;

  // --- handlers ------------------------------------------------------------

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSliderUsd(Number(e.target.value));
  };

  // --- render --------------------------------------------------------------

  return (
    <div className="mrx-root">
      <header className="mrx-header">
        <h1>MRX – Mean-Revert Rebalancer (Chipnet)</h1>
        <p>
          NFT-gated, on-chain mean-reversion of a BCH + stablecoin portfolio.
        </p>
        <p className="mrx-network-line">
          <strong>Network:</strong> {NETWORK_NAME} · <strong>FT:</strong>{" "}
          {FT_CATEGORY_HEX.slice(0, 8)}…{FT_CATEGORY_HEX.slice(-8)} ·{" "}
          <strong>NFT:</strong> {NFT_CATEGORY_HEX.slice(0, 8)}…
          {NFT_CATEGORY_HEX.slice(-8)} · <strong>commit:</strong>{" "}
          {REBALANCER_NFT_COMMITMENT_HEX}
        </p>

        <div className="mrx-top-cards">
          <div className="mrx-stat-card">
            <div className="mrx-stat-label">Oracle price (live)</div>
            <div className="mrx-stat-value">
              {formatUsd(livePriceUsd ?? demo?.priceUsd)}
            </div>
            <div className="mrx-stat-caption">
              Source:{" "}
              {demo?.source === "oracle"
                ? "General Protocols oracle"
                : "config fallback"}
            </div>
          </div>

          <div className="mrx-stat-card">
            <div className="mrx-stat-label">Contract FT</div>
            <div className="mrx-stat-value">
              {contract ? contract.ftOnContract.toString() : "–"} FT
            </div>
            <div className="mrx-stat-caption">
              Target: {TARGET_TOKENS.toString()} FT
            </div>
          </div>

          <div className="mrx-stat-card">
            <div className="mrx-stat-label">Contract BCH</div>
            <div className="mrx-stat-value">
              {contract ? contract.bchLocked.toString() : "–"} sats
            </div>
            <div className="mrx-stat-caption">
              ≈ {formatUsd(contractBchUsd)} at visual price
            </div>
          </div>

          <div className="mrx-stat-card">
            <div className="mrx-stat-label">Alice FT</div>
            <div className="mrx-stat-value">
              {alice ? alice.ftHeld.toString() : "–"} FT
            </div>
            <div className="mrx-stat-caption">
              Rebalancer NFT UTXOs: {alice ? alice.nftCount : "–"}
            </div>
          </div>
        </div>

        <button className="mrx-refresh-btn" onClick={reload} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh chain data"}
        </button>

        {combinedError && (
          <p className="mrx-error">
            {oracleError && <span>Oracle error: {oracleError}. </span>}
            {utxoError && <span>Indexer error: {utxoError}</span>}
          </p>
        )}
      </header>

      <main className="mrx-main mrx-main-grid">
        {/* Left column ------------------------------------------------------ */}
        <div className="mrx-col">
          {/* Contract Portfolio */}
          <section className="mrx-card">
            <h2>Contract Portfolio</h2>

            <p className="mrx-label">Contract token address</p>
            <p className="mrx-mono mrx-address">{CONTRACT_TOKEN_ADDRESS}</p>

            <p className="mrx-muted">
              Live balances are read from the BCH chipnet indexer used by our
              Node scripts. This dashboard is deliberately read-only: it just
              mirrors the on-chain state for judges.
            </p>

            <h3>Current on-chain state</h3>
            <ul>
              <li>
                <strong>BCH locked in contract:</strong> {contractBchText}
              </li>
              <li>
                <strong>Stablecoin FT on contract:</strong> {contractFtText}
              </li>
            </ul>

            <p className="mrx-note">To see the same state from the CLI, run:</p>
            <pre className="mrx-code">
              node scripts/inspectMeanRevertV3State.js
            </pre>
          </section>

          {/* Alice Treasury */}
          <section className="mrx-card">
            <h2>Alice Treasury</h2>

            <h3>Alice BCH (P2PKH)</h3>
            <p className="mrx-mono mrx-address">{ALICE_ADDRESS}</p>

            <h3>Alice tokens (p2pkhWithTokens)</h3>
            <p className="mrx-mono mrx-address">{ALICE_TOKEN_ADDRESS}</p>

            <p className="mrx-muted">
              Alice acts as the off-chain treasury / liquidity provider in this
              demo. All BCH and FT flows are between Alice and the contract,
              with an NFT proving that Alice is the authorized rebalancer.
            </p>

            <h3>Current on-chain state</h3>
            <ul>
              <li>
                <strong>BCH at Alice (P2PKH only):</strong> {aliceBchP2pkhText}
              </li>
              <li>
                <strong>BCH backing Alice token UTXOs:</strong>{" "}
                {aliceFtBackingText}
              </li>
              <li>
                <strong>Stablecoin FT held by Alice:</strong> {aliceFtHeldText}
              </li>
              <li>
                <strong>Rebalancer NFT (auth UTXO) count:</strong>{" "}
                {aliceNftCountText}
              </li>
            </ul>
          </section>

          {/* How to Drive the Flow */}
          <section className="mrx-card">
            <h2>How to Drive the Flow (Demo Script Order)</h2>
            <p>
              Use the existing Node scripts in the <code>loops/</code> repo to
              move real BCH + CashTokens on chipnet, then refresh this page or
              re-run the inspection script.
            </p>
            <ol className="mrx-steps">
              <li>
                <code>node scripts/mintAllForAlice.js</code> – mint FT + NFT to
                Alice.
              </li>
              <li>
                <code>node scripts/consolidateAliceFtCategory.js</code> –
                optional, merge FT UTXOs so the contract funding step is clean.
              </li>
              <li>
                <code>node scripts/fundMeanRevertV3FromAlice.js</code> – fund
                the contract with 1,000,000 sats + 800 FT.
              </li>
              <li>
                <code>node scripts/rebalanceWithOracleV3.js</code> – perform a{" "}
                “good” rebalance that reduces imbalance and withdraws tokens to
                Alice.
              </li>
              <li>
                <code>node scripts/inspectMeanRevertV3State.js</code> – show the
                new contract UTXO; BCH stays fixed at 1,000,000 sats, tokens
                step from 800 → 720 → 640….
              </li>
              <li>
                <code>node scripts/resetMeanRevertV3ToAlice.js</code> – drain
                the contract back to Alice to reset the demo.
              </li>
            </ol>
          </section>
        </div>

        {/* Right column ----------------------------------------------------- */}
        <div className="mrx-col">
          {/* Mean-Reversion Policy */}
          <section className="mrx-card">
            <h2>Mean-Reversion Policy</h2>
            <p>
              The contract uses the same integer math as our off-chain tests:
            </p>
            <ul>
              <li>
                <code>priceRaw = {PRICE_RAW}</code> (contract-scale; display
                uses <code>priceRaw / priceScale</code> in USD).
              </li>
              <li>
                Target: {TARGET_TOKENS.toString()} stablecoin tokens against
                1,000,000 sats (~0.01 BCH).
              </li>
              <li>
                A rebalance is only allowed if the absolute imbalance{" "}
                <code>|BCH(USD-ish) − tokens|</code>{" "}
                <strong>strictly decreases</strong>.
              </li>
              <li>
                <strong>Current contract vs target:</strong>{" "}
                {contractVsTargetText}
              </li>
            </ul>
            <p className="mrx-muted">
              Initial chipnet run starts with{" "}
              {INITIAL_TOKENS_ON_CONTRACT.toString()} tokens on contract, so the
              first rebalance withdraws tokens to Alice while keeping the BCH
              value constant.
            </p>
          </section>

          {/* Price & Balance Visualizer */}
          <section className="mrx-card">
            <h2>Price &amp; Balance Visualizer</h2>
            <p className="mrx-muted">
              Slide the oracle price between ~${sliderMinUsd} and ~$
              {sliderMaxUsd} to see how BCH vs token exposure shifts for the
              contract and Alice (off-chain visualization only).
            </p>

            <div className="mrx-slider-row">
              <label className="mrx-label" htmlFor="oracle-slider">
                Oracle price (visual)
              </label>
              <input
                id="oracle-slider"
                type="range"
                min={sliderMinUsd}
                max={sliderMaxUsd}
                step={1}
                value={visualPriceUsd}
                onChange={handleSliderChange}
              />
            </div>

            <p className="mrx-muted">
              Visual price ≈ <strong>{formatUsd(visualPriceUsd)}</strong>{" "}
              {livePriceUsd != null && (
                <>
                  (live oracle: <strong>{formatUsd(livePriceUsd)}</strong>)
                </>
              )}
            </p>

            {/* Token distribution bar */}
            {/* <div className="mrx-bar-group">
              <div className="mrx-bar-label-row">
                <span>Tokens</span>
                <span className="mrx-bar-caption">
                  Total: {totalTokens.toString()} FT
                </span>
              </div>
              <div className="mrx-bar">
                <div
                  className="mrx-bar-contract"
                  style={{ width: `${tokenDistribution.contractPct}%` }}
                >
                  Contract ({tokenDistribution.contractPct.toFixed(1)}%)
                </div>
                <div
                  className="mrx-bar-alice"
                  style={{ width: `${tokenDistribution.alicePct}%` }}
                >
                  Alice ({tokenDistribution.alicePct.toFixed(1)}%)
                </div>
              </div>
            </div> */}

            {/* BCH distribution bar */}
            {/* <div className="mrx-bar-group">
              <div className="mrx-bar-label-row">
                <span>BCH (USD-ish at visual price)</span>
                <span className="mrx-bar-caption">
                  Contract ≈ {formatUsd(contractBchUsd)}, Alice backing ≈{" "}
                  {formatUsd(aliceBchUsd)}
                </span>
              </div>
              <div className="mrx-bar">
                <div
                  className="mrx-bar-contract"
                  style={{ width: `${bchDistribution.contractPct}%` }}
                >
                  Contract ({bchDistribution.contractPct.toFixed(1)}%)
                </div>
                <div
                  className="mrx-bar-alice"
                  style={{ width: `${bchDistribution.alicePct}%` }}
                >
                  Alice ({bchDistribution.alicePct.toFixed(1)}%)
                </div>
              </div>
            </div>*/}
          </section>

          {/* Contract value mix bar (BCH vs FT) */}
          <div className="mrx-bar-group">
            <div className="mrx-bar-label-row">
              <span>Contract value mix (BCH vs FT)</span>
              <span className="mrx-bar-caption">
                BCH ≈ {formatUsd(contractBchUsd)}, FT ≈{" "}
                {formatUsd(contractTokenUsd)}
              </span>
            </div>
            <div className="mrx-bar">
              <div
                className="mrx-bar-contract"
                style={{ width: `${contractValueMix.bchPct}%` }}
              >
                BCH ({contractValueMix.bchPct.toFixed(1)}%)
              </div>
              <div
                className="mrx-bar-alice"
                style={{ width: `${contractValueMix.tokenPct}%` }}
              >
                FT ({contractValueMix.tokenPct.toFixed(1)}%)
              </div>
            </div>
          </div>

          {/* Math Preview --------------------------------------------------- */}
          <section className="mrx-card">
            <h2>Math Preview (Off-chain)</h2>
            <p className="mrx-muted">
              Uses the same imbalance metric as the covenant:{" "}
              <code>D ≈ |BCH(USD-ish) − tokens|</code>. BCH(USD-ish) is
              approximated as <code>(satoshis × priceRaw) / 10¹⁰</code>. This
              never broadcasts a transaction; it&apos;s just a visual guide.
            </p>

            <div className="mrx-math-row">
              <div>
                <div className="mrx-label">Oracle priceRaw for math</div>
                <div className="mrx-mono">
                  {priceRawForMath} (scale {priceScaleForMath})
                </div>
              </div>
              <div>
                <div className="mrx-label">Current tokens on contract</div>
                <div className="mrx-mono">{contractTokens.toString()} FT</div>
              </div>
            </div>

            <div className="mrx-math-row">
              <div>
                <div className="mrx-label">BCH(USD-ish)</div>
                <div className="mrx-mono">
                  {(Number(contract?.bchLocked ?? 0n) * priceRawForMath) / 1e10}
                </div>
              </div>
              <div>
                <div className="mrx-label">D_before</div>
                <div className="mrx-mono">{D_before}</div>
              </div>
            </div>

            <p className="mrx-muted">
              After each successful rebalance on chipnet you should see{" "}
              <code>D_after &lt; D_before</code>, while BCH on contract remains
              fixed at 1,000,000 sats.
            </p>
          </section>

          {/* Loops explanation --------------------------------------------- */}
          <section className="mrx-card">
            <h2>What Loops are Doing Here</h2>
            <p>
              The rebalancer covenant is written in CashScript V3 against
              BCH&apos;s upcoming loops CHIPs. On-chain, we:
            </p>
            <ul>
              <li>
                <strong>Iterate</strong> over transaction inputs in Script using
                a <code>do … while</code> loop to aggregate BCH and token
                values.
              </li>
              <li>
                <strong>Compute</strong> the before/after imbalance purely in
                integer arithmetic, using the oracle price as an input.
              </li>
              <li>
                <strong>Require</strong> that the after-imbalance is strictly
                lower than the before-imbalance. If not, the entire spend fails.
              </li>
            </ul>
            <p className="mrx-muted">
              This page is intended to complement the source contracts + tests
              in the <code>loops/</code> repo, giving judges a quick mental
              model of the flow before they dive into the code.
            </p>
          </section>
        </div>
      </main>
    </div>
  );
}
