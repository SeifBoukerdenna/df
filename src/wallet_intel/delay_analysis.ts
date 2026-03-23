// ---------------------------------------------------------------------------
// Delay Analysis Engine — Module 7 (SPEC.md)
//
// The single most important analytical output of the wallet intelligence
// module. For each wallet, for each historical trade: simulate entry at
// delays [1, 2, 3, 5, 7, 10, 15, 20, 30, 60] seconds. Compute per
// (wallet, delay): mean PnL with 95% CI, t-statistic, information ratio.
//
// Output: full wallet_delay_curve — tells us exactly which wallets are
// profitable at our actual execution latency.
//
// The delay curve answers: "If we follow this wallet with N seconds of
// delay, what is our expected PnL per trade?"
//
// Key concept: a wallet that is highly profitable at 0s delay may have
// zero edge at 5s delay (e.g., a sniper). Conversely, a swing trader's
// edge may barely degrade at 30s. The delay curve reveals this.
// ---------------------------------------------------------------------------

import { mean, stddev, tTest, bootstrapCI } from '../utils/statistics.js';
import type { WalletState, WalletClassification } from '../state/types.js';
import type { WalletTransaction } from '../ingestion/types.js';
import type {
  DelayBucketResult,
  WalletDelayCurve,
  PriceTimeseries,
} from './types.js';

// Default delay buckets from config — sub-5s delays are critical
const DEFAULT_DELAY_BUCKETS = [1, 2, 3, 5, 7, 10, 15, 20, 30, 60];

const DEFAULT_SIGNIFICANCE_P = 0.05;

// ---------------------------------------------------------------------------
// Price lookup — find the price at a specific timestamp
// ---------------------------------------------------------------------------

/**
 * Finds the price closest to the target timestamp in a sorted price array.
 * Uses binary search for efficiency. Returns null if no price within
 * maxGapMs of the target.
 */
function findPriceAtTime(
  prices: { timestamp: number; mid_price: number }[],
  targetTimestamp: number,
  maxGapMs: number = 120_000,
): number | null {
  if (prices.length === 0) return null;

  // Binary search for closest timestamp
  let lo = 0;
  let hi = prices.length - 1;

  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (prices[mid]!.timestamp < targetTimestamp) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // Check lo and lo-1 for closest
  let bestIdx = lo;
  if (lo > 0) {
    const diffLo = Math.abs(prices[lo]!.timestamp - targetTimestamp);
    const diffPrev = Math.abs(prices[lo - 1]!.timestamp - targetTimestamp);
    if (diffPrev < diffLo) bestIdx = lo - 1;
  }

  const gap = Math.abs(prices[bestIdx]!.timestamp - targetTimestamp);
  if (gap > maxGapMs) return null;

  return prices[bestIdx]!.mid_price;
}

// ---------------------------------------------------------------------------
// FIFO trade matching to get exit prices
// ---------------------------------------------------------------------------

interface MatchedTrade {
  entry_price: number;
  exit_price: number;
  entry_timestamp: number;
  exit_timestamp: number;
  size: number;
  pnl: number;
  market_id: string;
  token_id: string;
}

function matchTrades(trades: WalletTransaction[]): MatchedTrade[] {
  const results: MatchedTrade[] = [];
  const openPositions = new Map<string, { price: number; size: number; timestamp: number }[]>();

  for (const trade of trades) {
    // Skip trades with no valid price — they would corrupt delay PnL calculations
    if (trade.price <= 0) continue;

    const key = `${trade.market_id}:${trade.token_id}`;

    if (trade.side === 'BUY') {
      let positions = openPositions.get(key);
      if (!positions) {
        positions = [];
        openPositions.set(key, positions);
      }
      positions.push({ price: trade.price, size: trade.size, timestamp: trade.timestamp });
    } else {
      const positions = openPositions.get(key);
      if (!positions || positions.length === 0) continue;

      let remaining = trade.size;
      while (remaining > 0 && positions.length > 0) {
        const open = positions[0]!;
        const matched = Math.min(remaining, open.size);

        results.push({
          entry_price: open.price,
          exit_price: trade.price,
          entry_timestamp: open.timestamp,
          exit_timestamp: trade.timestamp,
          size: matched,
          pnl: (trade.price - open.price) * matched,
          market_id: trade.market_id,
          token_id: trade.token_id,
        });

        open.size -= matched;
        remaining -= matched;
        if (open.size <= 0.001) positions.shift();
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Compute delayed PnL for a single trade
// ---------------------------------------------------------------------------

/**
 * For a matched trade, compute what our PnL would be if we entered
 * `delaySeconds` after the wallet's entry, but exited at the same time
 * as the wallet.
 *
 * We use the price timeseries to find the price at (entry_time + delay).
 * If we can't find a price, we return null (skip this trade for this delay).
 */
function computeDelayedPnl(
  trade: MatchedTrade,
  delaySeconds: number,
  priceData: Map<string, PriceTimeseries>,
): number | null {
  const delayMs = delaySeconds * 1000;
  const delayedEntryTimestamp = trade.entry_timestamp + delayMs;

  // If the delayed entry would be after or at the exit, skip
  if (delayedEntryTimestamp >= trade.exit_timestamp) return null;

  // Look up price at delayed entry time
  const key = `${trade.market_id}:${trade.token_id}`;
  const timeseries = priceData.get(key);

  if (!timeseries || timeseries.prices.length === 0) {
    // No price data available — use linear interpolation between entry and exit
    // as a rough estimate (conservative: assumes linear price movement)
    const totalDuration = trade.exit_timestamp - trade.entry_timestamp;
    if (totalDuration <= 0) return null;

    const fraction = delayMs / totalDuration;
    const interpolatedPrice = trade.entry_price + (trade.exit_price - trade.entry_price) * fraction;
    return (trade.exit_price - interpolatedPrice) * trade.size;
  }

  const delayedPrice = findPriceAtTime(timeseries.prices, delayedEntryTimestamp);
  if (delayedPrice === null) return null;

  return (trade.exit_price - delayedPrice) * trade.size;
}

// ---------------------------------------------------------------------------
// Compute delay bucket result
// ---------------------------------------------------------------------------

function computeDelayBucket(
  matchedTrades: MatchedTrade[],
  delaySeconds: number,
  priceData: Map<string, PriceTimeseries>,
  significanceP: number,
): DelayBucketResult {
  const pnls: number[] = [];

  for (const trade of matchedTrades) {
    const delayed = computeDelayedPnl(trade, delaySeconds, priceData);
    if (delayed !== null) pnls.push(delayed);
  }

  if (pnls.length < 2) {
    return {
      delay_seconds: delaySeconds,
      mean_pnl: pnls.length === 1 ? pnls[0]! : 0,
      ci_low: 0,
      ci_high: 0,
      t_statistic: 0,
      p_value: 1,
      n_trades: pnls.length,
      win_rate: 0,
      information_ratio: 0,
      significantly_positive: false,
    };
  }

  const m = mean(pnls);
  const sd = stddev(pnls);
  const tResult = tTest(pnls, 0);
  const ci = bootstrapCI(pnls, 0.05, 5_000);
  const wins = pnls.filter((p) => p > 0).length;
  const ir = sd > 0 ? m / sd : (m > 0 ? Infinity : 0);

  return {
    delay_seconds: delaySeconds,
    mean_pnl: m,
    ci_low: ci[0],
    ci_high: ci[1],
    t_statistic: tResult.t,
    p_value: tResult.p,
    n_trades: pnls.length,
    win_rate: wins / pnls.length,
    information_ratio: ir,
    significantly_positive: tResult.p < significanceP && m > 0,
  };
}

// ---------------------------------------------------------------------------
// Edge halflife estimation
// ---------------------------------------------------------------------------

/**
 * Estimates the delay at which edge decays to 50% of zero-delay edge.
 * Uses linear interpolation between delay buckets.
 * Returns null if edge is not positive at zero delay or insufficient data.
 */
function estimateEdgeHalflife(buckets: DelayBucketResult[]): number | null {
  if (buckets.length < 2) return null;

  const zeroDelayPnl = buckets[0]!.mean_pnl;
  if (zeroDelayPnl <= 0) return null;

  const halfEdge = zeroDelayPnl * 0.5;

  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1]!;
    const curr = buckets[i]!;

    if (curr.mean_pnl <= halfEdge) {
      // Interpolate
      const range = prev.mean_pnl - curr.mean_pnl;
      if (range <= 0) return curr.delay_seconds;

      const fraction = (prev.mean_pnl - halfEdge) / range;
      return prev.delay_seconds + fraction * (curr.delay_seconds - prev.delay_seconds);
    }
  }

  // Edge hasn't decayed to 50% even at max delay
  return null;
}

/**
 * Estimates the delay at which edge reaches zero (breakeven).
 * Returns null if edge doesn't reach zero within the measured range.
 */
function estimateBreakevenDelay(buckets: DelayBucketResult[]): number | null {
  if (buckets.length === 0) return null;
  if (buckets[0]!.mean_pnl <= 0) return 0;
  if (buckets.length < 2) return null;

  for (let i = 1; i < buckets.length; i++) {
    const prev = buckets[i - 1]!;
    const curr = buckets[i]!;

    if (curr.mean_pnl <= 0) {
      // Interpolate to find zero crossing
      const range = prev.mean_pnl - curr.mean_pnl;
      if (range <= 0) return curr.delay_seconds;

      const fraction = prev.mean_pnl / range;
      return prev.delay_seconds + fraction * (curr.delay_seconds - prev.delay_seconds);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Recommendation logic
// ---------------------------------------------------------------------------

function computeRecommendation(
  curve: DelayBucketResult[],
  classification: WalletClassification,
  executionLatencySeconds: number,
): 'follow' | 'shadow_only' | 'ignore' | 'fade' {
  // Find the bucket closest to our execution latency
  let bestBucket: DelayBucketResult | null = null;
  let bestDist = Infinity;

  for (const bucket of curve) {
    const dist = Math.abs(bucket.delay_seconds - executionLatencySeconds);
    if (dist < bestDist) {
      bestDist = dist;
      bestBucket = bucket;
    }
  }

  if (!bestBucket || bestBucket.n_trades < 5) return 'shadow_only';

  // If significantly positive at our latency → follow
  if (bestBucket.significantly_positive && bestBucket.mean_pnl > 0) {
    return 'follow';
  }

  // If significantly negative → fade (reverse signal)
  if (bestBucket.mean_pnl < 0 && bestBucket.t_statistic < -1.645) {
    return 'fade';
  }

  // If positive but not significant → shadow
  if (bestBucket.mean_pnl > 0) return 'shadow_only';

  return 'ignore';
}

// ---------------------------------------------------------------------------
// Public API: compute full delay curve for a wallet
// ---------------------------------------------------------------------------

/**
 * Computes the full delay profitability curve for a wallet.
 *
 * @param wallet - The wallet state with trade history
 * @param priceData - Price timeseries per (market_id:token_id) for delay simulation
 * @param delayBuckets - Delay values in seconds to test
 * @param executionLatencySeconds - Our estimated execution latency (for recommendation)
 * @param significanceP - P-value threshold for significance
 */
export function computeWalletDelayCurve(
  wallet: WalletState,
  priceData: Map<string, PriceTimeseries>,
  delayBuckets: number[] = DEFAULT_DELAY_BUCKETS,
  executionLatencySeconds: number = 3,
  significanceP: number = DEFAULT_SIGNIFICANCE_P,
): WalletDelayCurve {
  const matchedTrades = matchTrades(wallet.trades);

  const bucketResults: DelayBucketResult[] = delayBuckets.map((delay) =>
    computeDelayBucket(matchedTrades, delay, priceData, significanceP),
  );

  const halflife = estimateEdgeHalflife(bucketResults);
  const breakevenDelay = estimateBreakevenDelay(bucketResults);

  // Optimal delay: the delay with the highest significantly positive mean PnL
  let optimalDelay: number | null = null;
  let bestPnl = 0;

  for (const bucket of bucketResults) {
    if (bucket.significantly_positive && bucket.mean_pnl > bestPnl) {
      bestPnl = bucket.mean_pnl;
      optimalDelay = bucket.delay_seconds;
    }
  }

  // Followable: is the edge positive at our latency?
  const atLatency = bucketResults.find(
    (b) => Math.abs(b.delay_seconds - executionLatencySeconds) <=
      (executionLatencySeconds <= 3 ? 1 : executionLatencySeconds * 0.3),
  );
  const followable = atLatency !== undefined && atLatency.significantly_positive;

  const recommendation = computeRecommendation(
    bucketResults, wallet.classification, executionLatencySeconds,
  );

  return {
    address: wallet.address,
    label: wallet.label,
    classification: wallet.classification,
    delay_buckets: bucketResults,
    optimal_delay_seconds: optimalDelay,
    edge_halflife_seconds: halflife,
    breakeven_delay_seconds: breakevenDelay,
    followable_at_latency: followable,
    recommendation,
  };
}

// ---------------------------------------------------------------------------
// Batch: compute delay curves for all wallets
// ---------------------------------------------------------------------------

export function computeAllDelayCurves(
  wallets: WalletState[],
  priceData: Map<string, PriceTimeseries>,
  delayBuckets?: number[],
  executionLatencySeconds?: number,
  significanceP?: number,
): WalletDelayCurve[] {
  return wallets.map((w) =>
    computeWalletDelayCurve(w, priceData, delayBuckets, executionLatencySeconds, significanceP),
  );
}

// ---------------------------------------------------------------------------
// Exported for testing
// ---------------------------------------------------------------------------

export { findPriceAtTime, matchTrades, computeDelayedPnl, estimateEdgeHalflife, estimateBreakevenDelay };
