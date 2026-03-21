// ---------------------------------------------------------------------------
// Feature Extraction Engine — Module 11 (SPEC.md)
//
// The training data factory for the Alpha Research Factory.
//
// Every 60 seconds, for every active market with volume_24h > $1000:
//   - Compute all features from the current WorldState
//   - Write a FeatureSnapshot (JSONL) to data/features/
//   - Include forward_return placeholders (filled in retrospectively)
//
// Features capture the full observable market microstructure.
// This data accumulates continuously — every day of collection
// before strategy validation is a day of training data gained.
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { now, dayKey } from '../utils/time.js';
import { mean, stddev, zScore } from '../utils/statistics.js';
import { getLogger } from '../utils/logger.js';
import {
  computeImbalance,
  computeMultiLevelImbalance,
  computeMicroprice,
} from '../state/derived_metrics.js';
import type {
  MarketState,
  OrderBook,
  WalletState,
  RegimeState,
  MarketGraph,
} from '../state/types.js';
import type { ConsistencyCheck } from '../analytics/types.js';

const log = getLogger('feature_engine');

// ---------------------------------------------------------------------------
// Feature snapshot types
// ---------------------------------------------------------------------------

export interface FeatureSnapshot {
  timestamp: number;
  market_id: string;
  features: Record<string, number>;
  // Forward returns — filled in retrospectively by the backfill process
  forward_return_1m: number | null;
  forward_return_5m: number | null;
  forward_return_1h: number | null;
}

// ---------------------------------------------------------------------------
// Feature definition registry
// ---------------------------------------------------------------------------

export interface FeatureDefinition {
  id: string;
  description: string;
  compute: (ctx: FeatureContext) => number;
}

/** Context passed to each feature computation function. */
export interface FeatureContext {
  market: MarketState;
  allMarkets: MarketState[];
  wallets: WalletState[];
  regime: RegimeState;
  consistencyViolations: ConsistencyCheck[];
  marketGraph: MarketGraph;
  spreadHistory: number[];   // rolling spread_bps history for this market
  volumeHistory: number[];   // rolling volume_1h history for this market
  tradeRateHistory: number[];// rolling trade_count_1h history
  gasPriceGwei: number;      // current gas price
  gasPriceHistory: number[]; // rolling gas price history
  nowMs: number;
}

// ---------------------------------------------------------------------------
// Feature implementations
// ---------------------------------------------------------------------------

/**
 * book_imbalance_l1: Top-of-book imbalance on the YES side.
 * (bidDepth - askDepth) / (bidDepth + askDepth) at level 1.
 */
function bookImbalanceL1(ctx: FeatureContext): number {
  const book = ctx.market.book.yes;
  return computeImbalance(book.bids, book.asks);
}

/**
 * book_imbalance_l5: Multi-level weighted imbalance (levels 1-5) on YES side.
 * More resistant to top-of-book manipulation.
 */
function bookImbalanceL5(ctx: FeatureContext): number {
  const book = ctx.market.book.yes;
  return computeMultiLevelImbalance(book.bids, book.asks, 5);
}

/**
 * microprice_deviation: (microprice - mid) / spread.
 * Measures how far the size-weighted price is from the raw mid.
 * Large deviations predict mid-price direction.
 */
function micropriceDeviation(ctx: FeatureContext): number {
  const book = ctx.market.book.yes;
  if (book.spread <= 0 || book.mid <= 0) return 0;
  const microprice = computeMicroprice(book);
  if (!isFinite(microprice)) return 0;
  return (microprice - book.mid) / book.spread;
}

/**
 * spread_z_score: Current spread vs own rolling history (z-score).
 * Positive = wider than usual. Negative = tighter.
 */
function spreadZScore(ctx: FeatureContext): number {
  const current = (ctx.market.book.yes.spread_bps + ctx.market.book.no.spread_bps) / 2;
  if (ctx.spreadHistory.length < 5) return 0;
  const m = mean(ctx.spreadHistory);
  const s = stddev(ctx.spreadHistory);
  return zScore(current, m, s);
}

/**
 * volume_z_score_1h: Current 1h volume vs own rolling history (z-score).
 */
function volumeZScore1h(ctx: FeatureContext): number {
  const current = ctx.market.volume_1h;
  if (ctx.volumeHistory.length < 5) return 0;
  const m = mean(ctx.volumeHistory);
  const s = stddev(ctx.volumeHistory);
  return zScore(current, m, s);
}

/**
 * staleness_ms: Time since the market's book was last updated.
 */
function stalenessMs(ctx: FeatureContext): number {
  return ctx.nowMs - ctx.market.updated_at;
}

/**
 * complement_gap_executable: Executable complement gap from MarketState.
 * Positive = arb opportunity exists.
 */
function complementGapExecutable(ctx: FeatureContext): number {
  return ctx.market.complement_gap_executable;
}

/**
 * autocorrelation_1m: 1-minute return autocorrelation.
 * Positive = momentum. Negative = mean reversion.
 */
function autocorrelation1m(ctx: FeatureContext): number {
  return ctx.market.autocorrelation_1m;
}

/**
 * large_trade_imbalance_5m: Net directional pressure from large trades
 * in the last 5 minutes. Uses trade_count_1h as proxy (scaled).
 * Positive = net buying pressure. Computed from market volume patterns.
 */
function largeTradeImbalance5m(ctx: FeatureContext): number {
  // Use the book imbalance weighted by recent volume relative to baseline
  // as a proxy for large-trade pressure
  const book = ctx.market.book.yes;
  const imb = computeImbalance(book.bids, book.asks);
  const volumeRatio = ctx.volumeHistory.length > 0
    ? ctx.market.volume_1h / (mean(ctx.volumeHistory) || 1)
    : 1;
  // Scale imbalance by how unusual the volume is
  return imb * Math.min(3, volumeRatio);
}

/**
 * wallet_heat_score: Number and quality of tracked wallets active
 * in this market right now. Higher = more smart money attention.
 */
function walletHeatScore(ctx: FeatureContext): number {
  const fiveMinAgo = ctx.nowMs - 300_000;
  let score = 0;

  for (const wallet of ctx.wallets) {
    // Check if this wallet has recent trades in this market
    const recentInMarket = wallet.trades.some(
      (t) => t.market_id === ctx.market.market_id && t.timestamp > fiveMinAgo,
    );
    if (!recentInMarket) continue;

    // Weight by wallet quality: classification confidence * profitability signal
    const classWeight =
      wallet.classification === 'sniper' || wallet.classification === 'swing'
        ? 2.0
        : wallet.classification === 'arbitrageur'
          ? 1.5
          : wallet.classification === 'market_maker'
            ? 0.5
            : 0.3; // noise/unclassified

    score += classWeight * wallet.confidence;
  }

  return score;
}

/**
 * consistency_violation_magnitude: Maximum consistency violation magnitude
 * for violations involving this market. 0 if no violations.
 */
function consistencyViolationMagnitude(ctx: FeatureContext): number {
  let maxMag = 0;
  for (const v of ctx.consistencyViolations) {
    if (v.markets_involved.includes(ctx.market.market_id)) {
      maxMag = Math.max(maxMag, Math.abs(v.violation_magnitude));
    }
  }
  return maxMag;
}

/**
 * time_to_resolution_hours: Hours until market end_date.
 * Negative if past resolution. Null-safe.
 */
function timeToResolutionHours(ctx: FeatureContext): number {
  const endMs = new Date(ctx.market.end_date).getTime();
  if (!isFinite(endMs)) return 8760; // default 1 year if unknown
  return (endMs - ctx.nowMs) / 3_600_000;
}

/**
 * volatility_ratio_1h_24h: Ratio of 1h realized vol to proxy 24h vol.
 * > 1.0 = current volatility higher than average. Regime signal.
 */
function volatilityRatio1h24h(ctx: FeatureContext): number {
  const vol1h = ctx.market.volatility_1h;
  // Use volume_24h / volume_1h ratio as proxy for 24h baseline
  // since we track volatility_1h directly
  if (vol1h <= 0) return 0;
  // Estimate 24h vol from history: average of historical volatility readings
  // For now, use the spread history as a volatility proxy
  if (ctx.spreadHistory.length < 10) return 1.0;
  const avgSpread = mean(ctx.spreadHistory);
  if (avgSpread <= 0) return 1.0;
  const currentSpread = (ctx.market.book.yes.spread_bps + ctx.market.book.no.spread_bps) / 2;
  return currentSpread / avgSpread;
}

/**
 * queue_depth_ratio: Ratio of queue depth at best bid/ask.
 * > 1.0 = more resting on bid side. Measures asymmetric liquidity.
 */
function queueDepthRatio(ctx: FeatureContext): number {
  const bidDepth = ctx.market.book.yes.queue_depth_at_best;
  const askDepth = ctx.market.book.no.queue_depth_at_best;
  // Use YES book bid depth vs ask depth
  const yesBidDepth = ctx.market.book.yes.bids[0]?.[1] ?? 0;
  const yesAskDepth = ctx.market.book.yes.asks[0]?.[1] ?? 0;

  if (yesAskDepth <= 0) return yesBidDepth > 0 ? 10 : 1; // cap at 10x
  return Math.min(10, yesBidDepth / yesAskDepth);
}

/**
 * trade_arrival_rate_z: Z-score of current trade rate vs rolling history.
 * Spikes indicate unusual activity.
 */
function tradeArrivalRateZ(ctx: FeatureContext): number {
  const current = ctx.market.trade_count_1h;
  if (ctx.tradeRateHistory.length < 5) return 0;
  const m = mean(ctx.tradeRateHistory);
  const s = stddev(ctx.tradeRateHistory);
  return zScore(current, m, s);
}

/**
 * book_fragility: Depth concentration across levels (Herfindahl index).
 * High = depth concentrated at one level (fragile book).
 * Low = depth distributed across levels (resilient book).
 */
function bookFragility(ctx: FeatureContext): number {
  const book = ctx.market.book.yes;
  const levels = Math.min(5, book.bids.length, book.asks.length);
  if (levels === 0) return 1; // no depth = maximally fragile

  // Compute HHI on the bid side depth distribution
  let totalDepth = 0;
  const depths: number[] = [];
  for (let i = 0; i < levels; i++) {
    const bidSize = book.bids[i]?.[1] ?? 0;
    const askSize = book.asks[i]?.[1] ?? 0;
    const d = bidSize + askSize;
    depths.push(d);
    totalDepth += d;
  }

  if (totalDepth === 0) return 1;

  let hhi = 0;
  for (const d of depths) {
    const share = d / totalDepth;
    hhi += share * share;
  }

  return hhi; // 1/levels = perfectly distributed, 1.0 = all at one level
}

/**
 * spread_regime: Categorical spread classification vs own history.
 * 0 = tight (< -0.5σ), 1 = normal, 2 = wide (> 0.5σ).
 * Encoded as numeric for feature vector.
 */
function spreadRegime(ctx: FeatureContext): number {
  const z = spreadZScore(ctx);
  if (z < -0.5) return 0; // tight
  if (z > 0.5) return 2;  // wide
  return 1;                // normal
}

/**
 * gas_price_z_score: Current gas price vs rolling history.
 * High gas = execution asymmetry (slow participants priced out).
 */
function gasPriceZScore(ctx: FeatureContext): number {
  if (ctx.gasPriceHistory.length < 5) return 0;
  const m = mean(ctx.gasPriceHistory);
  const s = stddev(ctx.gasPriceHistory);
  return zScore(ctx.gasPriceGwei, m, s);
}

// ---------------------------------------------------------------------------
// Feature registry — all features the system knows how to compute
// ---------------------------------------------------------------------------

export const FEATURE_REGISTRY: FeatureDefinition[] = [
  { id: 'book_imbalance_l1', description: 'Top-of-book imbalance (level 1)', compute: bookImbalanceL1 },
  { id: 'book_imbalance_l5', description: 'Multi-level weighted imbalance (levels 1-5)', compute: bookImbalanceL5 },
  { id: 'microprice_deviation', description: 'Microprice deviation from mid / spread', compute: micropriceDeviation },
  { id: 'spread_z_score', description: 'Spread z-score vs own history', compute: spreadZScore },
  { id: 'volume_z_score_1h', description: 'Volume z-score vs own history', compute: volumeZScore1h },
  { id: 'staleness_ms', description: 'Time since last book update (ms)', compute: stalenessMs },
  { id: 'complement_gap_executable', description: 'Executable complement gap', compute: complementGapExecutable },
  { id: 'autocorrelation_1m', description: '1-minute return autocorrelation', compute: autocorrelation1m },
  { id: 'large_trade_imbalance_5m', description: 'Volume-weighted trade imbalance (5m proxy)', compute: largeTradeImbalance5m },
  { id: 'wallet_heat_score', description: 'Smart wallet activity score in this market', compute: walletHeatScore },
  { id: 'consistency_violation_magnitude', description: 'Max consistency violation for this market', compute: consistencyViolationMagnitude },
  { id: 'time_to_resolution_hours', description: 'Hours until market end_date', compute: timeToResolutionHours },
  { id: 'volatility_ratio_1h_24h', description: 'Current vs historical volatility ratio', compute: volatilityRatio1h24h },
  { id: 'queue_depth_ratio', description: 'Bid/ask queue depth ratio', compute: queueDepthRatio },
  { id: 'trade_arrival_rate_z', description: 'Trade rate z-score vs history', compute: tradeArrivalRateZ },
  { id: 'book_fragility', description: 'Book depth concentration (HHI)', compute: bookFragility },
  { id: 'spread_regime', description: 'Spread regime (0=tight, 1=normal, 2=wide)', compute: spreadRegime },
  { id: 'gas_price_z_score', description: 'Gas price z-score', compute: gasPriceZScore },
];

// ---------------------------------------------------------------------------
// Per-market rolling history tracker
// ---------------------------------------------------------------------------

interface MarketHistory {
  spreads: number[];
  volumes: number[];
  tradeRates: number[];
  midPrices: { timestamp: number; mid: number }[];
}

const MAX_HISTORY = 120; // 2 hours of 60s ticks

// ---------------------------------------------------------------------------
// Feature Engine class
// ---------------------------------------------------------------------------

export interface FeatureEngineConfig {
  /** Directory to write JSONL feature files */
  outputDir: string;
  /** Minimum volume_24h to include a market (USD) */
  minVolume24h: number;
  /** Capture interval in ms (default 60_000) */
  captureIntervalMs: number;
}

const DEFAULT_ENGINE_CONFIG: FeatureEngineConfig = {
  outputDir: 'data/features',
  minVolume24h: 1000,
  captureIntervalMs: 60_000,
};

export class FeatureEngine {
  private readonly config: FeatureEngineConfig;
  private readonly marketHistories: Map<string, MarketHistory> = new Map();
  private gasPriceHistory: number[] = [];
  private currentGasPriceGwei: number = 0;
  private captureInterval: ReturnType<typeof setInterval> | null = null;
  private snapshotCount: number = 0;

  constructor(config: Partial<FeatureEngineConfig> = {}) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...config };

    if (!existsSync(this.config.outputDir)) {
      mkdirSync(this.config.outputDir, { recursive: true });
    }
  }

  // -----------------------------------------------------------------------
  // External state setters
  // -----------------------------------------------------------------------

  /** Update the current gas price (call from gas price poller) */
  setGasPrice(gwei: number): void {
    this.currentGasPriceGwei = gwei;
    this.gasPriceHistory.push(gwei);
    if (this.gasPriceHistory.length > MAX_HISTORY) {
      this.gasPriceHistory = this.gasPriceHistory.slice(-MAX_HISTORY);
    }
  }

  // -----------------------------------------------------------------------
  // Capture interval management
  // -----------------------------------------------------------------------

  /**
   * Starts the periodic feature capture.
   * @param getState - Callback that returns the current world state components
   */
  start(getState: () => CaptureState): void {
    if (this.captureInterval) return;

    this.captureInterval = setInterval(() => {
      try {
        const state = getState();
        this.capture(state);
      } catch (err) {
        log.warn({ err }, 'Feature capture tick failed');
      }
    }, this.config.captureIntervalMs);

    if (this.captureInterval.unref) this.captureInterval.unref();
    log.info(
      { dir: this.config.outputDir, interval_ms: this.config.captureIntervalMs },
      'Feature engine started',
    );
  }

  /** Stops the periodic capture. */
  stop(): void {
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }
  }

  // -----------------------------------------------------------------------
  // State bundle passed to capture()
  // -----------------------------------------------------------------------

  /** Returns the total number of snapshots written */
  getSnapshotCount(): number {
    return this.snapshotCount;
  }

  // -----------------------------------------------------------------------
  // Core: compute all features for all eligible markets and write JSONL
  // -----------------------------------------------------------------------

  /**
   * Single capture tick. Computes features for all eligible markets and
   * appends FeatureSnapshot lines to the daily JSONL file.
   * Can be called directly for testing.
   */
  capture(state: CaptureState, nowMs: number = now()): FeatureSnapshot[] {
    const { markets, wallets, regime, consistencyViolations, marketGraph } = state;

    // Filter to active markets above volume threshold
    const eligible = markets.filter(
      (m) => m.status === 'active' && m.volume_24h >= this.config.minVolume24h,
    );

    if (eligible.length === 0) return [];

    const snapshots: FeatureSnapshot[] = [];

    for (const market of eligible) {
      // Update per-market rolling history
      const history = this.getOrCreateHistory(market.market_id);
      this.updateHistory(history, market);

      // Build feature context
      const ctx: FeatureContext = {
        market,
        allMarkets: markets,
        wallets,
        regime,
        consistencyViolations,
        marketGraph,
        spreadHistory: history.spreads,
        volumeHistory: history.volumes,
        tradeRateHistory: history.tradeRates,
        gasPriceGwei: this.currentGasPriceGwei,
        gasPriceHistory: this.gasPriceHistory,
        nowMs,
      };

      // Compute all features
      const features: Record<string, number> = {};
      for (const def of FEATURE_REGISTRY) {
        try {
          features[def.id] = def.compute(ctx);
        } catch {
          features[def.id] = NaN;
        }
      }

      // Record mid-price for retrospective forward return computation
      const mid = market.book.yes.mid;
      if (mid > 0) {
        history.midPrices.push({ timestamp: nowMs, mid });
        if (history.midPrices.length > MAX_HISTORY * 60) {
          // Keep ~2 hours at 1s resolution (generous)
          history.midPrices = history.midPrices.slice(-MAX_HISTORY * 60);
        }
      }

      const snapshot: FeatureSnapshot = {
        timestamp: nowMs,
        market_id: market.market_id,
        features,
        forward_return_1m: null,
        forward_return_5m: null,
        forward_return_1h: null,
      };

      snapshots.push(snapshot);
    }

    // Write all snapshots to daily JSONL file
    this.writeSnapshots(snapshots, nowMs);
    this.snapshotCount += snapshots.length;

    log.debug(
      { markets: snapshots.length, total: this.snapshotCount },
      'Feature snapshots captured',
    );

    return snapshots;
  }

  // -----------------------------------------------------------------------
  // Retrospective forward return backfill
  // -----------------------------------------------------------------------

  /**
   * Computes forward returns for a past snapshot using stored mid-price history.
   * Returns updated snapshot with forward_return fields filled in.
   */
  backfillForwardReturns(
    snapshot: FeatureSnapshot,
    currentMid: number,
    nowMs: number,
  ): FeatureSnapshot {
    const history = this.marketHistories.get(snapshot.market_id);
    if (!history) return snapshot;

    const elapsed = nowMs - snapshot.timestamp;

    // Find mid-price at snapshot time
    const snapshotMid = this.findMidAt(history, snapshot.timestamp);
    if (snapshotMid <= 0) return snapshot;

    const updated = { ...snapshot };

    // Fill forward returns based on how much time has elapsed
    if (elapsed >= 60_000) {
      const mid1m = this.findMidAt(history, snapshot.timestamp + 60_000);
      if (mid1m > 0) {
        updated.forward_return_1m = (mid1m - snapshotMid) / snapshotMid;
      }
    }
    if (elapsed >= 300_000) {
      const mid5m = this.findMidAt(history, snapshot.timestamp + 300_000);
      if (mid5m > 0) {
        updated.forward_return_5m = (mid5m - snapshotMid) / snapshotMid;
      }
    }
    if (elapsed >= 3_600_000) {
      const mid1h = this.findMidAt(history, snapshot.timestamp + 3_600_000);
      if (mid1h > 0) {
        updated.forward_return_1h = (mid1h - snapshotMid) / snapshotMid;
      }
    }

    return updated;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  private getOrCreateHistory(marketId: string): MarketHistory {
    let h = this.marketHistories.get(marketId);
    if (!h) {
      h = { spreads: [], volumes: [], tradeRates: [], midPrices: [] };
      this.marketHistories.set(marketId, h);
    }
    return h;
  }

  private updateHistory(history: MarketHistory, market: MarketState): void {
    const spread = (market.book.yes.spread_bps + market.book.no.spread_bps) / 2;
    history.spreads.push(spread);
    history.volumes.push(market.volume_1h);
    history.tradeRates.push(market.trade_count_1h);

    if (history.spreads.length > MAX_HISTORY) {
      history.spreads = history.spreads.slice(-MAX_HISTORY);
    }
    if (history.volumes.length > MAX_HISTORY) {
      history.volumes = history.volumes.slice(-MAX_HISTORY);
    }
    if (history.tradeRates.length > MAX_HISTORY) {
      history.tradeRates = history.tradeRates.slice(-MAX_HISTORY);
    }
  }

  private findMidAt(history: MarketHistory, targetMs: number): number {
    // Binary search for closest mid-price to target timestamp
    const prices = history.midPrices;
    if (prices.length === 0) return 0;

    let lo = 0;
    let hi = prices.length - 1;
    let bestIdx = 0;
    let bestDist = Infinity;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const dist = Math.abs(prices[mid]!.timestamp - targetMs);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = mid;
      }
      if (prices[mid]!.timestamp < targetMs) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // Only return if within 30s of target
    if (bestDist > 30_000) return 0;
    return prices[bestIdx]!.mid;
  }

  private writeSnapshots(snapshots: FeatureSnapshot[], nowMs: number): void {
    if (snapshots.length === 0) return;

    const day = dayKey(nowMs);
    const filePath = join(this.config.outputDir, `${day}.jsonl`);

    const lines = snapshots.map((s) => JSON.stringify(s)).join('\n') + '\n';

    try {
      appendFileSync(filePath, lines, 'utf-8');
    } catch (err) {
      log.warn({ err, filePath }, 'Failed to write feature snapshots');
    }
  }
}

// ---------------------------------------------------------------------------
// State bundle type for capture()
// ---------------------------------------------------------------------------

export interface CaptureState {
  markets: MarketState[];
  wallets: WalletState[];
  regime: RegimeState;
  consistencyViolations: ConsistencyCheck[];
  marketGraph: MarketGraph;
}
