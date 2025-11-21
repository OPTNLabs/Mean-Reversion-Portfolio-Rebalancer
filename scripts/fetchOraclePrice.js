// scripts/fetchOraclePrice.js
//
// Simple CLI to print the latest oracle price snapshot.

import { fetchLatestOraclePrice } from "../oracles/fetchOraclePrice.js";

const ORACLE_PUBKEY =
  "02d09db08af1ff4e8453919cc866a4be427d7bfe18f2c05e5444c196fcf6fd2818";

async function main() {
  const snapshot = await fetchLatestOraclePrice({ publicKey: ORACLE_PUBKEY });

  console.log("=== Latest oracle price ===");
  console.log(`Oracle pubkey : ${snapshot.oraclePubKey}`);
  console.log(`Message seq   : ${snapshot.messageSequence}`);
  console.log(`Data seq      : ${snapshot.dataSequence}`);
  console.log(
    `Timestamp     : ${snapshot.timestamp} (${new Date(
      snapshot.timestamp * 1000
    ).toISOString()})`
  );
  console.log(
    `Raw price     : ${snapshot.priceRaw} (scaled by x${snapshot.priceScale})`
  );
  console.log(`Price         : ${snapshot.priceValue} (e.g. USD per BCH)\n`);
  console.log(`Raw message   : ${snapshot.rawMessage}`);
  console.log(`Signature     : ${snapshot.signature}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Error in fetchOraclePrice CLI:", err);
    process.exit(1);
  });
}
