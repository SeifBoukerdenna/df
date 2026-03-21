// ---------------------------------------------------------------------------
// Wallet Scorer — Module 7 (SPEC.md)
//
// Produces a single composite WalletScore from classification, delay curve,
// and regime analysis. Weighted components:
//
//   delayed_profitability     0.35   (most important — edge at OUR latency)
//   consistency               0.20   (stable across time)
//   statistical_significance  0.15   (real edge, not noise)
//   raw_profitability         0.10   (overall PnL quality)
//   regime_robustness         0.10   (works across regimes)
//   sample_size               0.05   (enough data)
//   recency                   0.05   (recent performance matters more)
//
// Output: follow / shadow_only / ignore / fade recommendation.
// For "follow" wallets: optimal follow parameters.
// ---------------------------------------------------------------------------

import { mean, stddev, tTest, bootstrapCI } from '../utils/statistics.js';
import type { WalletState, WalletStats } from '../state/types.js';
import type {
  WalletScore,
  WalletScoreComponents,
  FollowParameters,
  WalletDelayCurve,
  ClassificationResult,
  WalletRegimeProfile,
} from './types.js';

// ---------------------------------------------------------------------------
// Weights — sum to 1.0
// ---------------------------------------------------------------------------

const WEIGHTS = {
  delayed_profitability: 0.35,
  consistency: 0.20,
  statistical_significance: 0.15,
  raw_profitability: 0.10,
  regime_robustness: 0.10,
  sample_size: 0.05,
  recency: 0.05,
} as const;

// ---------------------------------------------------------------------------
// Component scorers — each returns a value in [0, 1]
// ---------------------------------------------------------------------------

/**
 * Delayed profitability: how profitable is this wallet at our execution latency?
 * Uses the delay curve's bucket closest to our latency.
 * Score based on information ratio (mean_pnl / stddev).
 */
function scoreDelayedProfitability(
  delayCurve: WalletDelayCurve | null,
  executionLatencySeconds: number,
): number {
  if (!delayCurve) return 0;

  // Find bucket closest to our latency
  let bestBucket = delayCurve.delay_buckets[0];
  let bestDist = Infinity;

  for (const bucket of delayCurve.delay_buckets) {
    const dist = Math.abs(bucket.delay_seconds - executionLatencySeconds);
    if (dist < bestDist) {
      bestDist = dist;
      bestBucket = bucket;
    }
  }

  if (!bestBucket || bestBucket.n_trades < 2) return 0;

  // Score from information ratio, capped at 2.0 → 1.0
  const ir = bestBucket.information_ratio;
  if (ir <= 0) return 0;
  return Math.min(1, ir / 2);
}

/**
 * Consistency: low variance in per-trade PnL relative to mean.
 * A wallet with steady small wins scores higher than one with
 * volatile big wins/losses even if the mean is the same.
 */
function scoreConsistency(stats: WalletStats): number {
  if (stats.total_trades < 5) return 0;

  // Use win rate as a consistency proxy — 50% is random, 70%+ is consistent
  const winConsistency = Math.max(0, (stats.win_rate - 0.5) * 4); // 0.5→0, 0.75→1

  // Low consecutive loss streaks → more consistent
  const lossStreakPenalty = Math.max(0, 1 - stats.consecutive_loss_max / 10);

  // Sharpe itself measures risk-adjusted consistency
  const sharpeScore = Math.min(1, Math.max(0, stats.sharpe_ratio / 2));

  return (winConsistency * 0.4 + lossStreakPenalty * 0.3 + sharpeScore * 0.3);
}

/**
 * Statistical significance: is the wallet's edge provably non-random?
 * Based on t-statistic from classification.
 */
function scoreStatisticalSignificance(classification: ClassificationResult | null): number {
  if (!classification) return 0;

  // t-statistic: 0→0, 1.645→0.5 (90% confidence), 2.576→0.8 (99% confidence), 3+→1.0
  const t = classification.t_statistic;
  if (t <= 0) return 0;
  return Math.min(1, t / 3);
}

/**
 * Raw profitability: overall PnL quality regardless of delay.
 */
function scoreRawProfitability(stats: WalletStats): number {
  if (stats.total_trades < 2) return 0;

  // Combine Sharpe and absolute PnL direction
  const sharpeScore = Math.min(1, Math.max(0, stats.sharpe_ratio / 2));
  const pnlPositive = stats.pnl_realized > 0 ? 0.5 : 0;

  return sharpeScore * 0.7 + pnlPositive * 0.3;
}

/**
 * Regime robustness: does edge persist across different market regimes?
 */
function scoreRegimeRobustness(regimeProfile: WalletRegimeProfile | null): number {
  if (!regimeProfile) return 0.5; // neutral when no data

  return regimeProfile.robustness_score;
}

/**
 * Sample size: ramps from 0 to 1 as n_trades goes from 0 to min_required.
 */
function scoreSampleSize(nTrades: number, minRequired: number = 30): number {
  if (nTrades <= 0) return 0;
  return Math.min(1, nTrades / minRequired);
}

/**
 * Recency: higher score if the wallet has been active recently.
 * Decays from 1.0 at 0 days to 0.0 at recencyWindowDays.
 */
function scoreRecency(
  trades: { timestamp: number }[],
  nowMs: number,
  recencyWindowDays: number = 30,
): number {
  if (trades.length === 0) return 0;

  // Find most recent trade
  let mostRecent = 0;
  for (const t of trades) {
    if (t.timestamp > mostRecent) mostRecent = t.timestamp;
  }

  const daysSinceLast = (nowMs - mostRecent) / (24 * 60 * 60 * 1000);
  if (daysSinceLast <= 0) return 1;
  if (daysSinceLast >= recencyWindowDays) return 0;

  // Exponential decay: half-life at recencyWindowDays/3
  const halfLife = recencyWindowDays / 3;
  return Math.exp(-0.693 * daysSinceLast / halfLife);
}

// ---------------------------------------------------------------------------
// Follow parameters computation
// ---------------------------------------------------------------------------

function computeFollowParameters(
  wallet: WalletState,
  delayCurve: WalletDelayCurve,
  totalCapital: number,
): FollowParameters {
  // Optimal delay in ms
  const optimalDelayMs = (delayCurve.optimal_delay_seconds ?? 3) * 1000;

  // Min trade size: filter out small trades that are likely noise
  const tradeSizes = wallet.trades.map((t) => t.price * t.size).filter((s) => s > 0);
  const sortedSizes = [...tradeSizes].sort((a, b) => a - b);
  const minTradeSize = sortedSizes.length > 0
    ? sortedSizes[Math.floor(sortedSizes.length * 0.25)]! // 25th percentile
    : 10;

  // Max allocation: conservative based on Kelly-like sizing
  // Use the delay bucket at our latency to estimate edge
  const atLatency = delayCurve.delay_buckets.find(
    (b) => b.delay_seconds === (delayCurve.optimal_delay_seconds ?? 3),
  ) ?? delayCurve.delay_buckets[0];

  let maxAllocation = totalCapital * 0.02; // default 2% of capital
  if (atLatency && atLatency.win_rate > 0.5 && atLatency.information_ratio > 0) {
    // Half-Kelly on the information ratio
    const kellyFraction = Math.min(0.1, atLatency.information_ratio * 0.25);
    maxAllocation = totalCapital * kellyFraction;
  }

  // Allowed market types: wallet's preferred markets
  const allowedMarkets = wallet.stats.preferred_markets.length > 0
    ? wallet.stats.preferred_markets
    : ['all'];

  // 90% CI on expected PnL per follow
  const pnls: number[] = [];
  if (atLatency && atLatency.n_trades >= 2) {
    // Use the delay bucket mean and CI directly
    return {
      optimal_delay_ms: optimalDelayMs,
      min_trade_size_to_follow: minTradeSize,
      max_allocation_per_follow: maxAllocation,
      allowed_market_types: allowedMarkets,
      confidence_interval_90: [atLatency.ci_low, atLatency.ci_high],
    };
  }

  return {
    optimal_delay_ms: optimalDelayMs,
    min_trade_size_to_follow: minTradeSize,
    max_allocation_per_follow: maxAllocation,
    allowed_market_types: allowedMarkets,
    confidence_interval_90: [0, 0],
  };
}

// ---------------------------------------------------------------------------
// Recommendation logic
// ---------------------------------------------------------------------------

function computeRecommendation(
  score: number,
  delayCurve: WalletDelayCurve | null,
  classification: ClassificationResult | null,
): 'follow' | 'shadow_only' | 'ignore' | 'fade' {
  // Delay curve recommendation takes precedence if available
  if (delayCurve) {
    // If delay curve says fade and score is very low, trust it
    if (delayCurve.recommendation === 'fade' && score < 0.3) return 'fade';
    // If delay curve says follow and score supports it
    if (delayCurve.recommendation === 'follow' && score >= 0.4) return 'follow';
  }

  // Score-based fallback
  if (score >= 0.6) return 'follow';
  if (score >= 0.35) return 'shadow_only';
  if (score < 0.15) {
    // Check if wallet has significantly negative delayed PnL → fade
    if (delayCurve && delayCurve.recommendation === 'fade') return 'fade';
    return 'ignore';
  }

  return 'shadow_only';
}

// ---------------------------------------------------------------------------
// Public API: compute wallet score
// ---------------------------------------------------------------------------

export interface ScoreInputs {
  wallet: WalletState;
  classification: ClassificationResult | null;
  delayCurve: WalletDelayCurve | null;
  regimeProfile: WalletRegimeProfile | null;
  executionLatencySeconds?: number;
  totalCapital?: number;
  nowMs?: number;
  minRequiredTrades?: number;
  recencyWindowDays?: number;
}

export function scoreWallet(inputs: ScoreInputs): WalletScore {
  const {
    wallet,
    classification,
    delayCurve,
    regimeProfile,
    executionLatencySeconds = 3,
    totalCapital = 10_000,
    nowMs = Date.now(),
    minRequiredTrades = 30,
    recencyWindowDays = 30,
  } = inputs;

  const stats = wallet.stats;

  // Compute each component
  const delayedProf = scoreDelayedProfitability(delayCurve, executionLatencySeconds);
  const consistency = scoreConsistency(stats);
  const significance = scoreStatisticalSignificance(classification);
  const rawProf = scoreRawProfitability(stats);
  const regimeRob = scoreRegimeRobustness(regimeProfile);
  const sampleSz = scoreSampleSize(stats.total_trades, minRequiredTrades);
  const recency = scoreRecency(wallet.trades, nowMs, recencyWindowDays);

  const components: WalletScoreComponents = {
    raw_profitability: rawProf,
    delayed_profitability: delayedProf,
    consistency,
    statistical_significance: significance,
    sample_size: sampleSz,
    recency,
    regime_robustness: regimeRob,
  };

  // Weighted sum
  const overall =
    delayedProf * WEIGHTS.delayed_profitability +
    consistency * WEIGHTS.consistency +
    significance * WEIGHTS.statistical_significance +
    rawProf * WEIGHTS.raw_profitability +
    regimeRob * WEIGHTS.regime_robustness +
    sampleSz * WEIGHTS.sample_size +
    recency * WEIGHTS.recency;

  const recommendation = computeRecommendation(overall, delayCurve, classification);

  // Follow parameters only for "follow" wallets
  let followParams: FollowParameters | null = null;
  if (recommendation === 'follow' && delayCurve) {
    followParams = computeFollowParameters(wallet, delayCurve, totalCapital);
  }

  return {
    address: wallet.address,
    label: wallet.label,
    classification: wallet.classification,
    overall_score: overall,
    components,
    recommendation,
    follow_parameters: followParams,
  };
}

// ---------------------------------------------------------------------------
// Batch: score all wallets
// ---------------------------------------------------------------------------

export function scoreAllWallets(
  inputs: ScoreInputs[],
): WalletScore[] {
  return inputs.map(scoreWallet);
}
