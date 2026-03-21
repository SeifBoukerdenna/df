// ---------------------------------------------------------------------------
// Wallet Classifier — Module 7 (SPEC.md)
//
// Classifies tracked wallets into: sniper, arbitrageur, swing,
// market_maker, noise, or unclassified based on behavioral analysis.
//
// Classification criteria (from SPEC):
//   sniper:       median_hold < 300s AND win_rate > 0.6
//   arbitrageur:  trades both YES and NO in same market frequently
//   swing:        median_hold > 3600s AND sharpe > 1.0
//   market_maker: provides liquidity on both sides
//   noise:        sharpe < 0.3
//   unclassified: insufficient data or no clear pattern
//
// Confidence = f(sample_size, consistency, regime_stability)
// ---------------------------------------------------------------------------

import { mean, stddev, tTest, bootstrapCI, cohensD } from '../utils/statistics.js';
import type { WalletState, WalletStats, WalletClassification } from '../state/types.js';
import type { WalletTransaction } from '../ingestion/types.js';
import type { WalletIntelConfig } from '../utils/config.js';
import type {
  ClassificationResult,
  ClassificationComponents,
  TimingPattern,
} from './types.js';

// ---------------------------------------------------------------------------
// Default config values (overridden by WalletIntelConfig at runtime)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  classification_min_trades: 30,
  sniper_max_hold_seconds: 300,
  swing_min_hold_seconds: 3600,
  swing_min_sharpe: 1.0,
  noise_max_sharpe: 0.3,
  min_significance_p: 0.05,
};

// ---------------------------------------------------------------------------
// Holding period computation (FIFO BUY→SELL matching)
// ---------------------------------------------------------------------------

interface TradeResult {
  pnl: number;
  holding_seconds: number;
  market_id: string;
  token_id: string;
  entry_side: 'BUY' | 'SELL';
  exit_side: 'BUY' | 'SELL';
}

function computeTradeResults(trades: WalletTransaction[]): TradeResult[] {
  const results: TradeResult[] = [];
  const openPositions = new Map<string, { price: number; size: number; timestamp: number }[]>();

  for (const trade of trades) {
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
          pnl: (trade.price - open.price) * matched,
          holding_seconds: (trade.timestamp - open.timestamp) / 1000,
          market_id: trade.market_id,
          token_id: trade.token_id,
          entry_side: 'BUY',
          exit_side: 'SELL',
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
// Arbitrageur detection — round-trips in same market
// ---------------------------------------------------------------------------

function computeRoundTripRate(trades: WalletTransaction[]): number {
  // Count markets where wallet trades both YES and NO tokens
  const marketTokenSides = new Map<string, Set<string>>();

  for (const t of trades) {
    const key = t.market_id;
    if (!key) continue;
    let sides = marketTokenSides.get(key);
    if (!sides) {
      sides = new Set();
      marketTokenSides.set(key, sides);
    }
    sides.add(t.token_id);
  }

  if (marketTokenSides.size === 0) return 0;

  let bothSidesCount = 0;
  for (const sides of marketTokenSides.values()) {
    if (sides.size >= 2) bothSidesCount++;
  }

  return bothSidesCount / marketTokenSides.size;
}

// ---------------------------------------------------------------------------
// Market maker detection — balanced buy/sell on both sides
// ---------------------------------------------------------------------------

function computeMarketMakerScore(trades: WalletTransaction[]): number {
  // Market makers provide liquidity on both sides of a market.
  // High buy/sell ratio balance AND presence on both token sides.
  const marketActivity = new Map<string, { buys: number; sells: number; tokens: Set<string> }>();

  for (const t of trades) {
    const key = t.market_id;
    if (!key) continue;
    let activity = marketActivity.get(key);
    if (!activity) {
      activity = { buys: 0, sells: 0, tokens: new Set() };
      marketActivity.set(key, activity);
    }
    if (t.side === 'BUY') activity.buys++;
    else activity.sells++;
    activity.tokens.add(t.token_id);
  }

  if (marketActivity.size === 0) return 0;

  let mmScore = 0;
  let counted = 0;

  for (const activity of marketActivity.values()) {
    const total = activity.buys + activity.sells;
    if (total < 4) continue; // need enough trades to judge

    // Balance: 1.0 = perfectly balanced, 0.0 = all one side
    const balance = 1 - Math.abs(activity.buys - activity.sells) / total;
    // Both-sided: do they trade multiple token IDs in this market?
    const bothSided = activity.tokens.size >= 2 ? 1 : 0;

    mmScore += balance * 0.6 + bothSided * 0.4;
    counted++;
  }

  return counted > 0 ? mmScore / counted : 0;
}

// ---------------------------------------------------------------------------
// Timing pattern analysis
// ---------------------------------------------------------------------------

function computeTimingPattern(trades: WalletTransaction[]): TimingPattern {
  const hours = new Array(24).fill(0) as number[];
  const days = new Array(7).fill(0) as number[];

  for (const t of trades) {
    const d = new Date(t.timestamp);
    hours[d.getUTCHours()]!++;
    days[d.getUTCDay()]!++;
  }

  // Peak hour and concentration (Herfindahl on hour distribution)
  const totalTrades = trades.length || 1;
  let peakHour = 0;
  let maxHourCount = 0;
  let hourHHI = 0;

  for (let h = 0; h < 24; h++) {
    if (hours[h]! > maxHourCount) {
      maxHourCount = hours[h]!;
      peakHour = h;
    }
    const share = hours[h]! / totalTrades;
    hourHHI += share * share;
  }

  // Peak day and concentration
  let peakDay = 0;
  let maxDayCount = 0;
  let dayHHI = 0;

  for (let d = 0; d < 7; d++) {
    if (days[d]! > maxDayCount) {
      maxDayCount = days[d]!;
      peakDay = d;
    }
    const share = days[d]! / totalTrades;
    dayHHI += share * share;
  }

  return {
    active_hours: hours,
    peak_hour: peakHour,
    hour_concentration: hourHHI,
    active_days: days,
    peak_day: peakDay,
    day_concentration: dayHHI,
  };
}

// ---------------------------------------------------------------------------
// Market concentration (Herfindahl-Hirschman Index)
// ---------------------------------------------------------------------------

function computeHHI(trades: WalletTransaction[]): number {
  const volumeByMarket = new Map<string, number>();
  let totalVolume = 0;

  for (const t of trades) {
    const vol = t.price * t.size;
    volumeByMarket.set(t.market_id, (volumeByMarket.get(t.market_id) ?? 0) + vol);
    totalVolume += vol;
  }

  if (totalVolume === 0) return 0;

  let hhi = 0;
  for (const vol of volumeByMarket.values()) {
    const share = vol / totalVolume;
    hhi += share * share;
  }

  return hhi;
}

// ---------------------------------------------------------------------------
// Trade clustering score
// ---------------------------------------------------------------------------

function computeClusteringScore(trades: WalletTransaction[]): number {
  if (trades.length < 3) return 0;

  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  const interArrivals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    interArrivals.push(sorted[i]!.timestamp - sorted[i - 1]!.timestamp);
  }

  const m = mean(interArrivals);
  if (m === 0) return 0;

  const v = interArrivals.reduce((sum, ia) => sum + (ia - m) ** 2, 0) / interArrivals.length;
  const cod = v / m;
  return m > 0 ? cod / m : 0;
}

// ---------------------------------------------------------------------------
// Regime consistency — does wallet perform consistently across regimes?
// ---------------------------------------------------------------------------

function computeRegimeConsistency(regimePerformance: Map<string, WalletStats>): number {
  if (regimePerformance.size < 2) return 0.5; // insufficient data, neutral

  const sharpes: number[] = [];
  for (const stats of regimePerformance.values()) {
    if (stats.total_trades >= 5) {
      sharpes.push(stats.sharpe_ratio);
    }
  }

  if (sharpes.length < 2) return 0.5;

  // Consistency = 1 - coefficient of variation of Sharpe across regimes
  const m = mean(sharpes);
  const sd = stddev(sharpes);
  if (m === 0) return 0;

  const cv = Math.abs(sd / m);
  return Math.max(0, Math.min(1, 1 - cv));
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function classifyWallet(
  wallet: WalletState,
  configOverrides?: Partial<WalletIntelConfig>,
): ClassificationResult {
  const cfg = { ...DEFAULTS, ...configOverrides };
  const trades = wallet.trades;
  const stats = wallet.stats;

  // Default empty result
  const emptyComponents: ClassificationComponents = {
    holding_period_score: 0,
    return_quality_score: 0,
    timing_regularity_score: 0,
    market_concentration_hhi: 0,
    trade_clustering_score: 0,
    regime_consistency: 0.5,
    sample_size_factor: 0,
  };

  if (trades.length < 2) {
    return {
      address: wallet.address,
      classification: 'unclassified',
      confidence: 0,
      components: emptyComponents,
      statistical_significance: false,
      t_statistic: 0,
      p_value: 1,
      n_trades: trades.length,
      bootstrap_ci: [0, 0],
    };
  }

  // Compute trade results for PnL analysis
  const tradeResults = computeTradeResults(trades);
  const pnls = tradeResults.map((r) => r.pnl);
  const holdingPeriods = tradeResults.map((r) => r.holding_seconds);

  // Statistical significance of PnL
  const tResult = pnls.length >= 2 ? tTest(pnls, 0) : { t: 0, p: 1, n: pnls.length, df: 0 };
  const isSignificant = tResult.p < cfg.min_significance_p && pnls.length >= cfg.classification_min_trades;

  // Bootstrap CI on mean PnL
  const ci = pnls.length >= 2 ? bootstrapCI(pnls, 0.05, 5_000) : [0, 0] as [number, number];

  // Compute components
  const roundTripRate = computeRoundTripRate(trades);
  const mmScore = computeMarketMakerScore(trades);
  const hhi = computeHHI(trades);
  const clusteringScore = computeClusteringScore(trades);
  const regimeConsistency = computeRegimeConsistency(wallet.regime_performance);

  // Holding period stats
  const sortedHolding = [...holdingPeriods].sort((a, b) => a - b);
  const medianHolding = sortedHolding.length > 0
    ? sortedHolding[Math.floor(sortedHolding.length / 2)]!
    : 0;

  // Sample size factor: ramps from 0 to 1 as n goes from 0 to classification_min_trades
  const sampleSizeFactor = Math.min(1, trades.length / cfg.classification_min_trades);

  // Return quality: Sharpe-based score normalized to [0, 1]
  const returnQuality = Math.min(1, Math.max(0, stats.sharpe_ratio / 2));

  // Timing regularity from hour concentration
  const timing = computeTimingPattern(trades);
  // HHI for uniform dist across 24 hours = 1/24 ≈ 0.042
  // High concentration = regular pattern
  const timingRegularity = Math.min(1, timing.hour_concentration / 0.2);

  const components: ClassificationComponents = {
    holding_period_score: medianHolding,
    return_quality_score: returnQuality,
    timing_regularity_score: timingRegularity,
    market_concentration_hhi: hhi,
    trade_clustering_score: clusteringScore,
    regime_consistency: regimeConsistency,
    sample_size_factor: sampleSizeFactor,
  };

  // Classification logic — ordered by specificity
  let classification: WalletClassification = 'unclassified';
  let confidence = 0;

  if (trades.length < cfg.classification_min_trades) {
    // Insufficient data — tentative classification with low confidence
    classification = tentativeClassify(medianHolding, stats, roundTripRate, mmScore, cfg);
    confidence = sampleSizeFactor * 0.3; // max 30% confidence with insufficient data
  } else {
    // Full classification
    const result = fullClassify(
      medianHolding, stats, roundTripRate, mmScore,
      isSignificant, regimeConsistency, sampleSizeFactor, cfg,
    );
    classification = result.classification;
    confidence = result.confidence;
  }

  return {
    address: wallet.address,
    classification,
    confidence,
    components,
    statistical_significance: isSignificant,
    t_statistic: tResult.t,
    p_value: tResult.p,
    n_trades: trades.length,
    bootstrap_ci: ci,
  };
}

// ---------------------------------------------------------------------------
// Tentative classification (insufficient trades)
// ---------------------------------------------------------------------------

function tentativeClassify(
  medianHolding: number,
  stats: WalletStats,
  roundTripRate: number,
  mmScore: number,
  cfg: typeof DEFAULTS,
): WalletClassification {
  // Apply same rules but return 'unclassified' if no strong signal
  if (medianHolding > 0 && medianHolding < cfg.sniper_max_hold_seconds && stats.win_rate > 0.6) {
    return 'sniper';
  }
  if (roundTripRate > 0.5) return 'arbitrageur';
  if (mmScore > 0.7) return 'market_maker';
  if (medianHolding > cfg.swing_min_hold_seconds && stats.sharpe_ratio > cfg.swing_min_sharpe) {
    return 'swing';
  }
  return 'unclassified';
}

// ---------------------------------------------------------------------------
// Full classification (sufficient data)
// ---------------------------------------------------------------------------

function fullClassify(
  medianHolding: number,
  stats: WalletStats,
  roundTripRate: number,
  mmScore: number,
  isSignificant: boolean,
  regimeConsistency: number,
  sampleSizeFactor: number,
  cfg: typeof DEFAULTS,
): { classification: WalletClassification; confidence: number } {
  // Score each classification and pick the best fit

  const scores: { classification: WalletClassification; score: number }[] = [];

  // Sniper: median_hold < 300s AND win_rate > 0.6
  if (medianHolding > 0 && medianHolding < cfg.sniper_max_hold_seconds) {
    const holdScore = 1 - medianHolding / cfg.sniper_max_hold_seconds;
    const winScore = Math.max(0, (stats.win_rate - 0.5) * 5); // 0.5→0, 0.7→1
    scores.push({ classification: 'sniper', score: holdScore * 0.5 + winScore * 0.5 });
  }

  // Arbitrageur: trades both YES and NO in same market
  if (roundTripRate > 0.3) {
    scores.push({ classification: 'arbitrageur', score: roundTripRate });
  }

  // Market maker: balanced buy/sell on both sides
  if (mmScore > 0.5) {
    scores.push({ classification: 'market_maker', score: mmScore });
  }

  // Swing: median_hold > 3600s AND sharpe > 1.0
  if (medianHolding > cfg.swing_min_hold_seconds) {
    const holdScore = Math.min(1, medianHolding / (cfg.swing_min_hold_seconds * 4));
    const sharpeScore = Math.min(1, Math.max(0, stats.sharpe_ratio / 2));
    scores.push({ classification: 'swing', score: holdScore * 0.4 + sharpeScore * 0.6 });
  }

  // Noise: sharpe < 0.3 (or negative)
  const noiseScore = Math.max(0, 1 - stats.sharpe_ratio / cfg.noise_max_sharpe);
  if (stats.sharpe_ratio < cfg.noise_max_sharpe) {
    scores.push({ classification: 'noise', score: noiseScore * 0.8 });
  }

  if (scores.length === 0) {
    return { classification: 'unclassified', confidence: 0.3 };
  }

  // Pick the highest-scoring classification
  scores.sort((a, b) => b.score - a.score);
  const best = scores[0]!;

  // Confidence = base score × sample factor × regime consistency bonus
  const baseConfidence = best.score;
  const significanceBonus = isSignificant ? 0.15 : 0;
  const regimeBonus = regimeConsistency * 0.1;

  const confidence = Math.min(1, baseConfidence * sampleSizeFactor + significanceBonus + regimeBonus);

  return { classification: best.classification, confidence };
}

// ---------------------------------------------------------------------------
// Batch classify all wallets
// ---------------------------------------------------------------------------

export function classifyAllWallets(
  wallets: WalletState[],
  configOverrides?: Partial<WalletIntelConfig>,
): ClassificationResult[] {
  return wallets.map((w) => classifyWallet(w, configOverrides));
}
