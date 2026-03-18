/**
 * Clamps `v` to the range [min, max].
 */
export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * Computes the volume-weighted average price (VWAP) by sweeping order book
 * levels until `targetSize` is filled.
 *
 * @param levels - Array of [price, size] tuples, assumed to be ordered
 *   in execution priority (best first — ascending for asks, descending for bids).
 * @param targetSize - The number of units to fill.
 * @returns The VWAP if the book can fill targetSize, or NaN if insufficient depth.
 */
export function vwap(levels: [number, number][], targetSize: number): number {
  if (targetSize <= 0) return NaN;

  let filled = 0;
  let cost = 0;

  for (const level of levels) {
    const price = level[0]!;
    const size = level[1]!;
    const take = Math.min(size, targetSize - filled);
    cost += price * take;
    filled += take;
    if (filled >= targetSize) break;
  }

  if (filled < targetSize) return NaN;
  return cost / filled;
}

/**
 * Computes the size-weighted mid-price (microprice).
 *
 * microprice = (askSize * bidPrice + bidSize * askPrice) / (bidSize + askSize)
 *
 * When the ask side has more depth, the microprice shifts toward the bid
 * (the large ask size exerts "pressure" pushing the price down), and vice versa.
 * Returns NaN if both sizes are zero.
 */
export function weightedMid(
  bidPrice: number,
  bidSize: number,
  askPrice: number,
  askSize: number,
): number {
  const totalSize = bidSize + askSize;
  if (totalSize === 0) return NaN;
  return (askSize * bidPrice + bidSize * askPrice) / totalSize;
}

/**
 * Computes total depth within `pct` (0–1) of `bestPrice` on one side of the book.
 *
 * @param levels - [price, size] tuples for one side (bids or asks).
 * @param pct - Percentage expressed as a decimal (e.g. 0.01 = 1%).
 * @param bestPrice - The best bid or ask price.
 * @returns Sum of sizes at levels within pct distance from bestPrice.
 */
export function bookDepthWithin(
  levels: [number, number][],
  pct: number,
  bestPrice: number,
): number {
  if (bestPrice <= 0 || levels.length === 0) return 0;

  const threshold = bestPrice * pct;
  // Epsilon guards against IEEE 754 rounding at the boundary
  // (e.g. |0.495 - 0.50| computes as 0.00500…04 > 0.005 exactly).
  const eps = threshold * 1e-9;
  let depth = 0;

  for (const level of levels) {
    const price = level[0]!;
    if (Math.abs(price - bestPrice) <= threshold + eps) {
      depth += level[1]!;
    }
  }

  return depth;
}

/**
 * Computes order book imbalance from aggregate bid/ask depth.
 *
 * imbalance = (bidDepth - askDepth) / (bidDepth + askDepth)
 *
 * Returns 0 if both sides are empty. Range: [-1, 1].
 * Positive → more bids (buy pressure). Negative → more asks (sell pressure).
 */
export function imbalance(bidDepth: number, askDepth: number): number {
  const total = bidDepth + askDepth;
  if (total === 0) return 0;
  return (bidDepth - askDepth) / total;
}

/**
 * Computes size-weighted imbalance across the top N levels of the book.
 *
 * Each level is weighted by 1/level_index (level 1 = weight 1, level 2 = 0.5, etc.)
 * so that deeper levels contribute less. This resists top-of-book manipulation.
 *
 * @param bids - [price, size] sorted descending by price.
 * @param asks - [price, size] sorted ascending by price.
 * @param levels - Number of levels to consider (default 5).
 * @returns Weighted imbalance in [-1, 1], or 0 if both sides are empty.
 */
export function multiLevelImbalance(
  bids: [number, number][],
  asks: [number, number][],
  levels: number = 5,
): number {
  let weightedBid = 0;
  let weightedAsk = 0;

  for (let i = 0; i < levels; i++) {
    const weight = 1 / (i + 1);
    const bidSize = bids[i]?.[1] ?? 0;
    const askSize = asks[i]?.[1] ?? 0;
    weightedBid += bidSize * weight;
    weightedAsk += askSize * weight;
  }

  const total = weightedBid + weightedAsk;
  if (total === 0) return 0;
  return (weightedBid - weightedAsk) / total;
}
