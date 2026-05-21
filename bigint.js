// bigint.js
// Helpers for working with BigInt in logging and JSON.
//
// These are purely for developer ergonomics – they never affect
// transaction construction or validation logic.

// Safe JSON stringify that converts BigInt to string.
export function safeJson(value, space = 2) {
  return JSON.stringify(
    value,
    (_, v) => (typeof v === "bigint" ? v.toString() : v),
    space
  );
}

// Format sats as "<n> sats"
export function formatSats(n) {
  if (typeof n !== "bigint") return String(n);
  return `${n.toString()} sats`;
}

// Format a fee line like "<bytes> bytes → <fee> sats"
export function formatFeeInfo(bytesEstimate, satsPerByte, fee) {
  const sizeStr =
    typeof bytesEstimate === "bigint"
      ? bytesEstimate.toString()
      : String(bytesEstimate);
  const feeStr = formatSats(fee);
  const spbStr = formatSats(satsPerByte);

  return `${sizeStr} bytes × ${spbStr} → ${feeStr}`;
}
