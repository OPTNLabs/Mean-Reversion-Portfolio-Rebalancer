import { hash160 } from "@cashscript/utils";
import {
  deriveHdPrivateNodeFromSeed,
  deriveHdPath,
  secp256k1,
  encodeCashAddress,
  deriveSeedFromBip39Mnemonic,
} from "@bitauth/libauth";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const commonDir = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(path = resolve(commonDir, ".env")) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile();

// This is duplicated from common.ts because it is not possible to import from a .ts file in p2pkh.js

const mnemonic = process.env.BIP39_MNEMONIC;
if (!mnemonic) {
  throw new Error(
    "Missing BIP39_MNEMONIC. Put the seed phrase in .env (ignored by git) before running wallet scripts."
  );
}

// Generate entropy from the BIP39 mnemonic phrase and initialise a root HD-wallet node.
const seed = deriveSeedFromBip39Mnemonic(mnemonic);
const rootNode = deriveHdPrivateNodeFromSeed(seed, {
  assumeValidity: true,
  throwErrors: true,
});
const baseDerivationPath = "m/44'/1'/0'/0";

// Derive Alice's private key, public key, public key hash and address
const aliceNode = deriveHdPath(rootNode, `${baseDerivationPath}/0`);
if (typeof aliceNode === "string") throw new Error();
export const alicePub = secp256k1.derivePublicKeyCompressed(
  aliceNode.privateKey
);
export const alicePriv = aliceNode.privateKey;
export const alicePkh = hash160(alicePub);
export const aliceAddress = encodeCashAddress({
  prefix: "bchtest",
  type: "p2pkh",
  payload: alicePkh,
  throwErrors: true,
}).address;
export const aliceTokenAddress = encodeCashAddress({
  prefix: "bchtest",
  type: "p2pkhWithTokens",
  payload: alicePkh,
  throwErrors: true,
}).address;

// Derive Bob's private key, public key, public key hash and address
const bobNode = deriveHdPath(rootNode, `${baseDerivationPath}/1`);
if (typeof bobNode === "string") throw new Error();
export const bobPub = secp256k1.derivePublicKeyCompressed(bobNode.privateKey);
export const bobPriv = bobNode.privateKey;
export const bobPkh = hash160(bobPub);
export const bobAddress = encodeCashAddress({
  prefix: "bchtest",
  type: "p2pkh",
  payload: bobPkh,
  throwErrors: true,
}).address;
export const bobTokenAddress = encodeCashAddress({
  prefix: "bchtest",
  type: "p2pkhWithTokens",
  payload: bobPkh,
  throwErrors: true,
}).address;

// Derive Charlie's private key, public key, public key hash and address
const charlieNode = deriveHdPath(rootNode, `${baseDerivationPath}/2`);
if (typeof charlieNode === "string") throw new Error();
export const charliePub = secp256k1.derivePublicKeyCompressed(
  charlieNode.privateKey
);
export const charliePriv = charlieNode.privateKey;
export const charliePkh = hash160(charliePub);
export const charlieAddress = encodeCashAddress({
  prefix: "bchtest",
  type: "p2pkh",
  payload: charliePkh,
  throwErrors: true,
}).address;
export const charlieTokenAddress = encodeCashAddress({
  prefix: "bchtest",
  type: "p2pkhWithTokens",
  payload: charliePkh,
  throwErrors: true,
}).address;
