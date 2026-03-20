import { weightedMid, imbalance as rawImbalance, multiLevelImbalance as rawMultiLevel } from '../utils/math.js';
import type { OrderBook } from './types.js';

/**
 * Size-weighted mid-price (microprice).
 * More predictive of next trade direction than the raw mid.
 *
 * microprice = (askSize * bid + bidSize * ask) / (bidSize + askSize)
 *
 * Returns NaN if the book has no quotes on both sides.
 */
export function computeMicroprice(book: OrderBook): number {
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  if (!bestBid || !bestAsk) return NaN;

  return weightedMid(bestBid[0], bestBid[1], bestAsk[0], bestAsk[1]);
}

/**
 * Top-of-book imbalance: (bidDepth - askDepth) / (bidDepth + askDepth).
 * Uses aggregate size at the best bid/ask only (level 1).
 * Returns 0 if both sides are empty.
 */
export function computeImbalance(
  bids: [number, number][],
  asks: [number, number][],
): number {
  const bidDepth = bids[0]?.[1] ?? 0;
  const askDepth = asks[0]?.[1] ?? 0;
  return rawImbalance(bidDepth, askDepth);
}

/**
 * Multi-level size-weighted imbalance across the top N levels.
 * Each level is weighted by 1/rank, so deeper levels contribute less.
 * More resistant to top-of-book manipulation than single-level imbalance.
 */
export function computeMultiLevelImbalance(
  bids: [number, number][],
  asks: [number, number][],
  levels: number = 5,
): number {
  return rawMultiLevel(bids, asks, levels);
}

/**
 * Liquidity score: weighted depth across top 5 levels of each book side,
 * discounted by distance from mid.
 *
 * For each level i (0-indexed):
 *   weight_i = 1 / (1 + distance_from_mid_in_spread_units)
 *
 * The score is the sum of (size × weight) across both sides, normalised
 * to [0, 1] by applying an asymptotic transform: score / (score + K)
 * where K=10000 is a tunable reference depth.
 */
export function computeLiquidityScore(
  bids: [number, number][],
  asks: [number, number][],
  mid: number,
): number {
  if (mid <= 0 || (bids.length === 0 && asks.length === 0)) return 0;

  const LEVELS = 5;
  const K = 10_000; // reference depth for normalisation
  let weightedDepth = 0;

  for (let i = 0; i < LEVELS; i++) {
    const bid = bids[i];
    if (bid) {
      const dist = Math.abs(mid - bid[0]) / mid;
      const weight = 1 / (1 + dist * 100); // dist*100 puts typical 1% distance at weight 0.5
      weightedDepth += bid[1] * weight;
    }

    const ask = asks[i];
    if (ask) {
      const dist = Math.abs(ask[0] - mid) / mid;
      const weight = 1 / (1 + dist * 100);
      weightedDepth += ask[1] * weight;
    }
  }

  return weightedDepth / (weightedDepth + K);
}

/**
 * Complement gap (mid-based): |yes_mid + no_mid - 1.0|.
 * A non-zero gap indicates mispricing between YES and NO tokens.
 */
export function computeComplementGap(yesMid: number, noMid: number): number {
  return Math.abs(yesMid + noMid - 1.0);
}

/**
 * Complement gap (executable): profit from buying YES ask + NO ask - 1.0 - 2×fees.
 *
 * If yes_best_ask + no_best_ask < 1.0, buying both is guaranteed profit after
 * accounting for fees on both legs.
 *
 * Returns the net executable gap:
 *   positive = profitable arb exists
 *   negative = no arb after costs
 *
 * Returns NaN if either side has no ask.
 */
export function computeComplementGapExecutable(
  yesBestAsk: number,
  noBestAsk: number,
  feeRate: number,
): number {
  if (!isFinite(yesBestAsk) || !isFinite(noBestAsk)) return NaN;

  // Cost to acquire both sides
  const totalCost = yesBestAsk + noBestAsk;
  // Fees on both legs
  const totalFees = feeRate * 2;
  // Guaranteed payout is 1.0 (one side resolves to 1)
  // Profit = 1.0 - totalCost - totalFees
  return 1.0 - totalCost - totalFees;
}

/**
 * Rolling autocorrelation of a return series at the given lag.
 *
 * autocorrelation(lag) = Σ((r_t - μ)(r_{t-lag} - μ)) / Σ((r_t - μ)²)
 *
 * Positive → momentum regime. Negative → mean-reversion regime.
 * Returns 0 if the series is too short or has zero variance.
 */
export function computeRollingAutocorrelation(
  returns: number[],
  lag: number = 1,
): number {
  const n = returns.length;
  if (n <= lag || n < 3) return 0;

  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;

  let variance = 0;
  for (const r of returns) {
    const d = r - mean;
    variance += d * d;
  }
  if (variance === 0) return 0;

  let covariance = 0;
  for (let t = lag; t < n; t++) {
    covariance += (returns[t]! - mean) * (returns[t - lag]! - mean);
  }

  return covariance / variance;
}
