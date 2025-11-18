// scripts/mintTokensForAlice.js
import { TransactionBuilder, SignatureTemplate } from "cashscript";
import { SATS_PER_BYTE, DUST_THRESHOLD } from "../config.js";
import { alicePriv, aliceAddress, aliceTokenAddress } from "../common.js";
import { logAddressState, splitByToken } from "../utxos.js";
import { getProviderAndContract } from "../contract.js";

/**
 * Helper: get UTXO value as bigint.
 */
function utxoValueBigInt(utxo) {
  const v = utxo.satoshis ?? utxo.value;
  if (v === undefined) throw new Error("UTXO missing satoshi value");
  return BigInt(v);
}

/**
 * Pick all BCH-only UTXOs for Alice with vout === 0.
 * These are eligible to become *token category genesis* inputs.
 */
async function getGenesisCandidates(provider) {
  const aliceUtxos = await logAddressState(
    "Alice (before FT mint)",
    provider,
    aliceAddress
  );

  const { bchOnly } = splitByToken(aliceUtxos);

  const candidates = bchOnly.filter((u) => u.vout === 0);

  if (candidates.length === 0) {
    throw new Error(
      "[mint] No BCH-only UTXOs with vout=0 available as token category genesis inputs."
    );
  }

  return candidates;
}

/**
 * If there are no BCH-only vout=0 UTXOs, create one
 * by doing a simple self-send (1 input → 1 output) to aliceAddress.
 */
async function createGenesisAnchorUtxo(provider) {
  console.log(
    "\n[mint] No vout=0 BCH-only UTXOs found – creating one via self-send..."
  );

  const aliceUtxos = await logAddressState(
    "Alice (before anchor self-send)",
    provider,
    aliceAddress
  );

  const { bchOnly } = splitByToken(aliceUtxos);
  if (!bchOnly.length) {
    throw new Error(
      "[mint] No BCH-only UTXOs available to build anchor self-send."
    );
  }

  // Just pick a BCH-only UTXO with enough value.
  const sig = new SignatureTemplate(alicePriv);
  const fundingUtxo = bchOnly[0];
  const inputValue = utxoValueBigInt(fundingUtxo);

  const fee = 1000n; // static, safe for small 1-in/1-out tx
  const outputAmount = inputValue - fee;

  if (outputAmount <= DUST_THRESHOLD) {
    throw new Error(
      `[mint] Selected UTXO too small for anchor self-send. value=${inputValue} fee=${fee}`
    );
  }

  console.log("[mint] Anchor funding UTXO:");
  console.log(`  txid:  ${fundingUtxo.txid}`);
  console.log(`  vout:  ${fundingUtxo.vout}`);
  console.log(`  value: ${inputValue} sats`);
  console.log(`  outputAmount: ${outputAmount} sats`);
  console.log(`  fee: ${fee} sats\n`);

  const builder = new TransactionBuilder({ provider });
  builder.addInput(fundingUtxo, sig.unlockP2PKH());
  builder.addOutput({
    to: aliceAddress,
    amount: outputAmount,
  });

  const txDetails = await builder.send();
  console.log("[mint] Anchor self-send txid:", txDetails.txid);
  console.log(
    "[mint] The BCH-only output of this tx at vout=0 is now usable as a genesis input."
  );

  await logAddressState(
    "Alice (after anchor self-send)",
    provider,
    aliceAddress
  );
}

/**
 * Build + send a fungible token *genesis* transaction.
 *
 * - Uses a BCH-only UTXO with vout=0
 * - The txid of that UTXO becomes the token category ID
 * - Mints all fungible supply for that category in this single tx
 */
async function mintFungibleCategoryForAlice({
  provider,
  genesisUtxo,
  tokenAmount,
  backingSats,
}) {
  console.log(">>> MINTING FUNGIBLE TOKEN CATEGORY FOR ALICE <<<");
  console.log(
    `[mint-FT] Using genesis UTXO ${genesisUtxo.txid} (vout=${genesisUtxo.vout}) as category ID`
  );

  const categoryIdHex = genesisUtxo.txid; // big-endian hex string

  const inputValue = utxoValueBigInt(genesisUtxo);
  const backing = BigInt(backingSats); // sats that back the token UTXO
  const tokenSupply = BigInt(tokenAmount); // fungible amount

  if (inputValue <= backing) {
    throw new Error(
      `[mint-FT] Genesis UTXO too small. input=${inputValue} backing=${backing}`
    );
  }

  const sig = new SignatureTemplate(alicePriv);

  // ─────────────────────────────────────────────
  // PASS 1: provisional tx (fee=0) to estimate size
  // ─────────────────────────────────────────────
  const provisionalChange = inputValue - backing;
  if (provisionalChange <= 0n) {
    throw new Error("[mint-FT] Provisional change <= 0.");
  }

  const builder1 = new TransactionBuilder({ provider });

  builder1.addInput(genesisUtxo, sig.unlockP2PKH());

  // Output 0: Alice token-aware address with fungible tokens
  builder1.addOutput({
    to: aliceTokenAddress,
    amount: backing,
    token: {
      category: categoryIdHex,
      amount: tokenSupply, // bigint
    },
  });

  // Output 1: change back to normal BCH P2PKH
  builder1.addOutput({
    to: aliceAddress,
    amount: provisionalChange,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(
    `[mint-FT] Provisional size = ${byteLength} bytes → fee=${fee} sats`
  );

  const realChange = inputValue - backing - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  if (realChange < 0n) {
    throw new Error("[mint-FT] Negative change after fee.");
  }

  // ─────────────────────────────────────────────
  // PASS 2: final tx
  // ─────────────────────────────────────────────
  const builder2 = new TransactionBuilder({ provider });

  builder2.addInput(genesisUtxo, sig.unlockP2PKH());

  // Token output
  builder2.addOutput({
    to: aliceTokenAddress,
    amount: backing,
    token: {
      category: categoryIdHex,
      amount: tokenSupply,
    },
  });

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log("[mint-FT] Broadcast:", txDetails);

  await logAddressState("Alice (after FT mint)", provider, aliceAddress);

  return {
    txDetails,
    categoryIdHex,
  };
}

/**
 * Build + send an NFT token *genesis* transaction.
 *
 * - Uses another BCH-only UTXO with vout=0 (different from FT one if possible)
 * - Mints:
 *   • A minting NFT (capability: "minting")
 *   • An immutable NFT (capability: "none")
 * - For library compatibility, we also attach 1 fungible token to each NFT.
 */
async function mintNftCategoryForAlice({ provider, genesisUtxo }) {
  console.log(`\n>>> MINTING NFT CATEGORY FOR ALICE <<<`);
  console.log(
    `[mint] Chosen genesis UTXO: ${genesisUtxo.txid} (vout=${genesisUtxo.vout}, value=${genesisUtxo.satoshis} sats)`
  );

  const categoryIdHex = genesisUtxo.txid;
  const inputValue = utxoValueBigInt(genesisUtxo);

  // Backing for NFTs (sats per NFT UTXO)
  const NFT_BACKING = 1000n;

  const totalNftBacking = NFT_BACKING * 2n; // two NFT outputs

  if (inputValue <= totalNftBacking) {
    throw new Error(
      `[mint-NFT] Genesis UTXO too small. input=${inputValue}, required>${totalNftBacking}`
    );
  }

  const sig = new SignatureTemplate(alicePriv);

  // Commitments as **hex strings**
  const mintingCommitmentHex = "6d696e74"; // "mint"
  const nftCommitmentHex = "6e667431"; // "nft1"

  // ─────────────────────────────────────────────
  // PASS 1: provisional tx (fee=0)
  // ─────────────────────────────────────────────
  const provisionalChange = inputValue - totalNftBacking;
  if (provisionalChange <= 0n) {
    throw new Error("[mint-NFT] Provisional change <= 0.");
  }

  const builder1 = new TransactionBuilder({ provider });

  builder1.addInput(genesisUtxo, sig.unlockP2PKH());

  // Output 0: Minting NFT + 1 fungible token
  builder1.addOutput({
    to: aliceTokenAddress,
    amount: NFT_BACKING,
    token: {
      category: categoryIdHex,
      amount: 1n,
      nft: {
        capability: "minting",
        commitment: mintingCommitmentHex,
      },
    },
  });

  // Output 1: Immutable NFT + 1 fungible token
  builder1.addOutput({
    to: aliceTokenAddress,
    amount: NFT_BACKING,
    token: {
      category: categoryIdHex,
      amount: 1n,
      nft: {
        capability: "none",
        commitment: nftCommitmentHex,
      },
    },
  });

  // Output 2: pure BCH change
  builder1.addOutput({
    to: aliceAddress,
    amount: provisionalChange,
  });

  const provisionalHex = await builder1.build();
  const byteLength = BigInt(provisionalHex.length / 2);
  const fee = byteLength * SATS_PER_BYTE;

  console.log(`[mint-NFT] Provisional size=${byteLength} bytes → fee=${fee}`);

  const realChange = inputValue - totalNftBacking - fee;
  const includeChange = realChange >= DUST_THRESHOLD;

  if (realChange < 0n) {
    throw new Error("[mint-NFT] Negative change after fee.");
  }

  // ─────────────────────────────────────────────
  // PASS 2: final tx
  // ─────────────────────────────────────────────
  const builder2 = new TransactionBuilder({ provider });

  builder2.addInput(genesisUtxo, sig.unlockP2PKH());

  // Minting NFT
  builder2.addOutput({
    to: aliceTokenAddress,
    amount: NFT_BACKING,
    token: {
      category: categoryIdHex,
      amount: 1n,
      nft: {
        capability: "minting",
        commitment: mintingCommitmentHex,
      },
    },
  });

  // Immutable NFT
  builder2.addOutput({
    to: aliceTokenAddress,
    amount: NFT_BACKING,
    token: {
      category: categoryIdHex,
      amount: 1n,
      nft: {
        capability: "none",
        commitment: nftCommitmentHex,
      },
    },
  });

  if (includeChange) {
    builder2.addOutput({
      to: aliceAddress,
      amount: realChange,
    });
  }

  const txDetails = await builder2.send();
  console.log("[mint-NFT] Broadcast:", txDetails);

  await logAddressState("Alice (after NFT mint)", provider, aliceAddress);

  return {
    txDetails,
    categoryIdHex,
  };
}

/**
 * Top-level script:
 *  - ensures there are vout=0 BCH-only UTXOs (creating one if needed)
 *  - picks 2 distinct vout=0 BCH-only UTXOs as genesis candidates
 *  - mints:
 *    1) Fungible token category → 1000 FT
 *    2) NFT category → minting NFT + immutable NFT
 */
export async function runMintTokensForAlice() {
  const { provider } = getProviderAndContract();

  console.log(">>> Mint Tokens to Alice");
  console.log(`Alice BCH address      : ${aliceAddress}`);
  console.log(`Alice token-aware addr : ${aliceTokenAddress}\n`);

  let candidates;
  try {
    candidates = await getGenesisCandidates(provider);
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes(
        "No BCH-only UTXOs with vout=0 available as token category genesis inputs."
      )
    ) {
      // Create an anchor UTXO, then retry
      await createGenesisAnchorUtxo(provider);
      candidates = await getGenesisCandidates(provider);
    } else {
      throw err;
    }
  }

  if (candidates.length < 2) {
    console.warn(
      `[mint] Only ${candidates.length} genesis candidate(s) found. ` +
        "Fungible and NFT categories will reuse the same input if needed."
    );
  }

  const ftGenesis = candidates[0];
  const nftGenesis = candidates[1] ?? candidates[0];

  // 1) Fungible category
  const ftResult = await mintFungibleCategoryForAlice({
    provider,
    genesisUtxo: ftGenesis,
    tokenAmount: 1000n,
    backingSats: 1000n,
  });

  console.log(`\n[mint] Fungible token category ID: ${ftResult.categoryIdHex}`);

  // Refresh Alice state before NFT mint
  await logAddressState("Alice (after FT mint)", provider, aliceAddress);

  // 2) NFT category
  const nftResult = await mintNftCategoryForAlice({
    provider,
    genesisUtxo: nftGenesis,
  });

  console.log(`\n[mint] NFT token category ID: ${nftResult.categoryIdHex}`);

  console.log("\n>>> Minting complete.\n");
}

// CLI entrypoint: allow `node scripts/mintTokensForAlice.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMintTokensForAlice().catch((err) => {
    console.error("\n❌ Error in runMintTokensForAlice:", err);
    process.exit(1);
  });
}
