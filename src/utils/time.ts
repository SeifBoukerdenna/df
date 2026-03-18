/**
 * Returns the current wall-clock time in milliseconds.
 * Use this for all timestamps stored in state, ledger entries, and events.
 */
export function now(): number {
  return Date.now();
}

/**
 * Returns a high-resolution monotonic timestamp as a bigint nanoseconds value.
 * Use this to measure elapsed time between two points with sub-millisecond precision.
 * Do NOT use this for wall-clock timestamps — it has no relationship to calendar time.
 */
export function nowHr(): bigint {
  return process.hrtime.bigint();
}

/**
 * Computes elapsed time in milliseconds between a prior `nowHr()` call and now.
 * Precision: sub-millisecond (returned as a float).
 */
export function elapsed(startHr: bigint): number {
  const ns = process.hrtime.bigint() - startHr;
  return Number(ns) / 1_000_000;
}

/**
 * Converts a millisecond epoch timestamp to an ISO 8601 string.
 * Example: 1700000000000 → "2023-11-14T22:13:20.000Z"
 */
export function msToISODate(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Returns the UTC date key for a millisecond epoch timestamp in YYYY-MM-DD format.
 * Used for daily ledger file rotation and log file naming.
 * Example: 1700000000000 → "2023-11-14"
 */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
