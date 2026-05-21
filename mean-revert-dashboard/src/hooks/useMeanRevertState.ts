// mean-revert-dashboard/src/hooks/useMeanRevertState.ts

import { useEffect, useState, useCallback } from "react";
import { fetchAddressUtxos, type RawUtxo } from "../api/utxos";
import {
  ALICE_ADDRESS,
  ALICE_TOKEN_ADDRESS,
  CONTRACT_TOKEN_ADDRESS,
  FT_CATEGORY_HEX,
  NFT_CATEGORY_HEX,
  REBALANCER_NFT_COMMITMENT_HEX,
} from "../meanRevertConfig";

export interface ContractOnChainState {
  bchLocked: bigint;
  ftOnContract: bigint;
}

export interface AliceOnChainState {
  bchP2pkhOnly: bigint;
  ftBackingBch: bigint;
  ftHeld: bigint;
  nftCount: number;
}

export interface MeanRevertStateResult {
  loading: boolean;
  error: string | null;
  contract: ContractOnChainState | null;
  alice: AliceOnChainState | null;
  reload: () => void;
}

// Safely convert sats (string | number | bigint | undefined) to bigint.
function toBigIntSats(utxo: RawUtxo): bigint {
  const v = (utxo as any).satoshis ?? (utxo as any).value ?? 0;
  if (typeof v === "bigint") return v;
  if (typeof v === "string") return v ? BigInt(v) : 0n;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return 0n;
}

function summarizeContract(utxos: RawUtxo[]): ContractOnChainState {
  let bchLocked = 0n;
  let ftOnContract = 0n;

  for (const u of utxos) {
    const sats = toBigIntSats(u);

    if (u.token && u.token.category === FT_CATEGORY_HEX) {
      // This UTXO is the main stablecoin FT we’re tracking.
      bchLocked += sats;
      ftOnContract += BigInt(u.token.amount);
    } else {
      // Contract might also hold BCH-only UTXOs.
      bchLocked += sats;
    }
  }

  return { bchLocked, ftOnContract };
}

function summarizeAlice(
  p2pkhUtxos: RawUtxo[],
  tokenUtxosAll: RawUtxo[]
): AliceOnChainState {
  let bchP2pkhOnly = 0n;
  let ftBackingBch = 0n;
  let ftHeld = 0n;
  let nftCount = 0;

  // Plain P2PKH BCH-only UTXOs for Alice.
  for (const u of p2pkhUtxos) {
    if (!u.token) {
      bchP2pkhOnly += toBigIntSats(u);
    }
  }

  // Token-bearing UTXOs across BOTH Alice addresses.
  for (const u of tokenUtxosAll) {
    const sats = toBigIntSats(u);
    const t = u.token;
    if (!t) continue;

    // Stablecoin FT in this demo’s category.
    if (t.category === FT_CATEGORY_HEX) {
      ftHeld += BigInt(t.amount);
      ftBackingBch += sats;
    }

    // Rebalancer NFT auth UTXO.
    if (
      t.category === NFT_CATEGORY_HEX &&
      t.nft &&
      t.nft.commitment === REBALANCER_NFT_COMMITMENT_HEX
    ) {
      nftCount += 1;
    }
  }

  return {
    bchP2pkhOnly,
    ftBackingBch,
    ftHeld,
    nftCount,
  };
}

export function useMeanRevertState(): MeanRevertStateResult {
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [contract, setContract] = useState<ContractOnChainState | null>(null);
  const [alice, setAlice] = useState<AliceOnChainState | null>(null);
  const [refreshCounter, setRefreshCounter] = useState(0);

  const reload = useCallback(() => {
    setRefreshCounter((c) => c + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);

      try {
        const [contractResp, aliceP2pkhResp, aliceTokenResp] =
          await Promise.all([
            fetchAddressUtxos(CONTRACT_TOKEN_ADDRESS),
            fetchAddressUtxos(ALICE_ADDRESS),
            fetchAddressUtxos(ALICE_TOKEN_ADDRESS),
          ]);

        if (cancelled) return;

        const contractState = summarizeContract(contractResp.utxos);

        // Combine ALL token-bearing UTXOs from BOTH Alice addresses.
        const tokenUtxosAll: RawUtxo[] = [
          ...aliceP2pkhResp.utxos.filter((u) => !!u.token),
          ...aliceTokenResp.utxos,
        ];

        const aliceState = summarizeAlice(aliceP2pkhResp.utxos, tokenUtxosAll);

        setContract(contractState);
        setAlice(aliceState);
        setError(
          contractResp.error ||
            aliceP2pkhResp.error ||
            aliceTokenResp.error ||
            null
        );
      } catch (err: any) {
        if (cancelled) return;
        console.error("useMeanRevertState error:", err);
        setError(err?.message ?? String(err));
        setContract(null);
        setAlice(null);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    run();

    return () => {
      cancelled = true;
    };
  }, [refreshCounter]);

  return { loading, error, contract, alice, reload };
}
