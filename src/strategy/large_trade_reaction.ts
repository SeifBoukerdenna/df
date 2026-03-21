// ---------------------------------------------------------------------------
// Strategy 6: Large Trade Reaction — Module 3 (SPEC.md)
//
// Detects trades > 2σ of a market's size distribution, builds a per-market
// impact/reversion model measuring price at T+5s/15s/30s/60s/5m, classifies
// as momentum (impact persists) or reversion (impact fades), and generates
// signals accordingly:
//   - Reversion: fade after impact
//   - Momentum: follow immediately
//
// Requires ≥20 calibration events per market before generating signals.
//
// Market eligibility:
//   - volume_24h > $25k
//   - trades/hour > 5
//   - spread < 500 bps
//
// Conditional probabilities on: book state (imbalance), direction (buy/sell),
// market type (1/2/3).
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { clamp } from '../utils/math.js';
import { mean, stddev } from '../utils/statistics.js';
import type { TradeSignal, KillCondition, DecayModel } from '../ledger/types.js';
import type { Strategy, StrategyContext } from './types.js';
import type { ParsedTrade } from '../ingestion/types.js';

const log = getLogger('large_trade_reaction');

const STRATEGY_ID = 'large_trade_reaction';
const FEE_RATE = 0.02;

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  large_trade_sigma_threshold: 2.0,
  min_volume_24h: 25_000,
  min_trades_per_hour: 5,
  max_spread_bps: 500,
  min_ev_threshold: 0.02,
  signal_half_life_ms: 60_000,
  /** Minimum calibration events before model is "hot". */
  min_calibration_events: 20,
  /** Measurement horizons (ms) for price impact. */
  measurement_horizons_ms: [5_000, 15_000, 30_000, 60_000, 300_000] as readonly number[],
  /** Minimum size distribution entries to compute σ. */
  min_size_distribution: 10,
  /** Time limit for signal. */
  time_limit_ms: 300_000,
  max_price_premium: 0.02,
  /** Reversion threshold: fraction of impact that mean-reverts → classify as reversion. */
  reversion_fraction_threshold: 0.5,
};

// ---------------------------------------------------------------------------
// Signal ID
// ---------------------------------------------------------------------------

let signalSeq = 0;

function nextSignalId(): string {
  signalSeq++;
  return `${STRATEGY_ID}_${now()}_${signalSeq}`;
}

/** Reset signal counter (for testing). */
export function resetLargeTradeReactionSeq(): void {
  signalSeq = 0;
}

// ---------------------------------------------------------------------------
// Provider interface — dependency injection for trade data and price lookups
// ---------------------------------------------------------------------------

export interface TradeDataProvider {
  /** Get recent trade sizes for a market (for computing σ). */
  getRecentTradeSizes(marketId: string): number[];
  /** Get the mid price at a specific time, or null if unavailable. */
  getMidPriceAt(marketId: string, timestampMs: number): number | null;
}

// ---------------------------------------------------------------------------
// Impact observation — one row in the per-market model
// ---------------------------------------------------------------------------

export interface ImpactObservation {
  /** Timestamp of the large trade */
  tradeTs: number;
  /** Trade direction: 1 for BUY, -1 for SELL */
  tradeDirection: 1 | -1;
  /** Trade size in notional */
  tradeSize: number;
  /** Number of σ above mean */
  tradeSigma: number;
  /** Mid price just before the trade */
  preBuyMid: number;
  /** Book imbalance at time of trade */
  bookImbalance: number;
  /** Market type */
  marketType: number;
  /** Price impacts at each horizon (signed: positive = moved in trade direction). */
  impacts: (number | null)[];
}

// ---------------------------------------------------------------------------
// Per-market impact model
// ---------------------------------------------------------------------------

export interface ImpactModel {
  observations: ImpactObservation[];
  /** Fraction of events where price continued in trade direction at 60s. */
  momentumRate: number;
  /** Fraction of events where price reverted > 50% of initial impact at 60s. */
  reversionRate: number;
  /** Average initial impact (at 5s). */
  avgInitialImpact: number;
  /** Average 60s impact. */
  avg60sImpact: number;
  /** Classification: 'momentum' | 'reversion' | 'inconclusive'. */
  classification: 'momentum' | 'reversion' | 'inconclusive';
}

// ---------------------------------------------------------------------------
// Module-scoped state
// ---------------------------------------------------------------------------

/** Per-market impact models. */
const impactModels: Map<string, ImpactModel> = new Map();

/** Per-market trade size distributions (rolling window of recent sizes). */
const sizeDistributions: Map<string, number[]> = new Map();

/** Maximum size distribution entries to keep per market. */
const MAX_SIZE_DISTRIBUTION = 500;

/** Reset all module state (for testing). */
export function resetLargeTradeState(): void {
  impactModels.clear();
  sizeDistributions.clear();
  signalSeq = 0;
}

/** Get impact model for a market (for testing). */
export function getImpactModel(marketId: string): ImpactModel | undefined {
  return impactModels.get(marketId);
}

// ---------------------------------------------------------------------------
// Trade ingestion — called externally when a trade occurs
// ---------------------------------------------------------------------------

/**
 * Record a trade's size for the market's size distribution.
 * Called for every trade, not just large ones.
 */
export function recordTradeSize(marketId: string, size: number): void {
  let dist = sizeDistributions.get(marketId);
  if (!dist) {
    dist = [];
    sizeDistributions.set(marketId, dist);
  }
  dist.push(size);
  if (dist.length > MAX_SIZE_DISTRIBUTION) {
    dist.splice(0, dist.length - MAX_SIZE_DISTRIBUTION);
  }
}

/**
 * Detects whether a trade is "large" (> threshold σ above mean).
 * Returns the z-score if large, or null if not.
 */
export function detectLargeTrade(
  marketId: string,
  tradeSize: number,
  sigmaThreshold: number = DEFAULTS.large_trade_sigma_threshold,
): number | null {
  const dist = sizeDistributions.get(marketId);
  if (!dist || dist.length < DEFAULTS.min_size_distribution) return null;

  const m = mean(dist);
  const s = stddev(dist);
  if (s <= 0 || isNaN(s)) return null;

  const z = (tradeSize - m) / s;
  return z >= sigmaThreshold ? z : null;
}

/**
 * Record a large trade observation with its impact measurements.
 * This is called when we have price data at measurement horizons
 * to build the calibration model.
 */
export function recordImpactObservation(
  marketId: string,
  obs: ImpactObservation,
): void {
  let model = impactModels.get(marketId);
  if (!model) {
    model = {
      observations: [],
      momentumRate: 0,
      reversionRate: 0,
      avgInitialImpact: 0,
      avg60sImpact: 0,
      classification: 'inconclusive',
    };
    impactModels.set(marketId, model);
  }

  model.observations.push(obs);
  recalibrateModel(model);
}

/**
 * Recalibrate the model's summary statistics from its observations.
 */
function recalibrateModel(model: ImpactModel): void {
  const obs = model.observations;
  if (obs.length === 0) return;

  // Filter observations that have 5s and 60s measurements
  const withInitial = obs.filter(o => o.impacts[0] !== null);
  const with60s = obs.filter(o => o.impacts[3] !== null);

  if (withInitial.length > 0) {
    model.avgInitialImpact = mean(
      withInitial.map(o => Math.abs(o.impacts[0]!)),
    );
  }

  if (with60s.length > 0) {
    model.avg60sImpact = mean(
      with60s.map(o => Math.abs(o.impacts[3]!)),
    );
  }

  // Momentum: 60s impact has same sign as initial and > 50% magnitude
  const bothMeasured = obs.filter(
    o => o.impacts[0] !== null && o.impacts[3] !== null,
  );

  if (bothMeasured.length >= 5) {
    let momentumCount = 0;
    let reversionCount = 0;

    for (const o of bothMeasured) {
      const initial = o.impacts[0]!;
      const later = o.impacts[3]!;
      const sameSign = Math.sign(initial) === Math.sign(later);
      const magnitudeRatio = Math.abs(initial) > 0
        ? Math.abs(later) / Math.abs(initial)
        : 0;

      if (sameSign && magnitudeRatio > DEFAULTS.reversion_fraction_threshold) {
        momentumCount++;
      }
      if (magnitudeRatio < DEFAULTS.reversion_fraction_threshold) {
        reversionCount++;
      }
    }

    model.momentumRate = momentumCount / bothMeasured.length;
    model.reversionRate = reversionCount / bothMeasured.length;

    if (model.reversionRate > model.momentumRate && model.reversionRate > 0.5) {
      model.classification = 'reversion';
    } else if (model.momentumRate > model.reversionRate && model.momentumRate > 0.5) {
      model.classification = 'momentum';
    } else {
      model.classification = 'inconclusive';
    }
  }
}

// ---------------------------------------------------------------------------
// Conditional probability helpers
// ---------------------------------------------------------------------------

interface ConditionalFilter {
  direction?: 1 | -1;
  imbalanceSign?: 1 | -1;
  marketType?: number;
}

/**
 * Compute reversion probability conditionally on filters.
 * Returns null if insufficient data (< 5 matching observations).
 */
export function conditionalReversionProbability(
  marketId: string,
  filter: ConditionalFilter,
): number | null {
  const model = impactModels.get(marketId);
  if (!model) return null;

  let matching = model.observations.filter(
    o => o.impacts[0] !== null && o.impacts[3] !== null,
  );

  if (filter.direction !== undefined) {
    matching = matching.filter(o => o.tradeDirection === filter.direction);
  }
  if (filter.imbalanceSign !== undefined) {
    matching = matching.filter(
      o => Math.sign(o.bookImbalance) === filter.imbalanceSign,
    );
  }
  if (filter.marketType !== undefined) {
    matching = matching.filter(o => o.marketType === filter.marketType);
  }

  if (matching.length < 5) return null;

  let reversionCount = 0;
  for (const o of matching) {
    const initial = o.impacts[0]!;
    const later = o.impacts[3]!;
    const magnitudeRatio = Math.abs(initial) > 0
      ? Math.abs(later) / Math.abs(initial)
      : 0;
    if (magnitudeRatio < DEFAULTS.reversion_fraction_threshold) {
      reversionCount++;
    }
  }

  return reversionCount / matching.length;
}

// ---------------------------------------------------------------------------
// LargeTradeReactionStrategy
// ---------------------------------------------------------------------------

export class LargeTradeReactionStrategy implements Strategy {
  readonly id = STRATEGY_ID;
  readonly name = 'Large Trade Reaction';

  private provider: TradeDataProvider | null = null;

  /** Inject a trade data provider (for DI/testing). */
  setProvider(provider: TradeDataProvider): void {
    this.provider = provider;
  }

  evaluate(ctx: StrategyContext): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const { market, regime, config: stratConfig, classification, now: t } = ctx;

    const sigmaThreshold = (stratConfig['large_trade_sigma_threshold'] as number | undefined)
      ?? DEFAULTS.large_trade_sigma_threshold;
    const minVolume = (stratConfig['min_volume_24h'] as number | undefined)
      ?? DEFAULTS.min_volume_24h;
    const minTradesPerHour = (stratConfig['min_trades_per_hour'] as number | undefined)
      ?? DEFAULTS.min_trades_per_hour;
    const halfLifeMs = stratConfig.signal_half_life_ms ?? DEFAULTS.signal_half_life_ms;
    const minEvThreshold = stratConfig.min_ev_threshold ?? DEFAULTS.min_ev_threshold;
    const minCalibration = (stratConfig['min_calibration_events'] as number | undefined)
      ?? DEFAULTS.min_calibration_events;

    // -----------------------------------------------------------------------
    // Market eligibility
    // -----------------------------------------------------------------------

    if (market.volume_24h < minVolume) return signals;
    if (market.trade_count_1h < minTradesPerHour) return signals;

    const yesBook = market.book.yes;
    if (yesBook.spread_bps > DEFAULTS.max_spread_bps) return signals;

    // -----------------------------------------------------------------------
    // Check if market has a calibrated impact model
    // -----------------------------------------------------------------------

    const model = impactModels.get(market.market_id);
    if (!model || model.observations.length < minCalibration) return signals;
    if (model.classification === 'inconclusive') return signals;

    // -----------------------------------------------------------------------
    // Check for recent large trade via provider
    // -----------------------------------------------------------------------

    if (!this.provider) return signals;

    const recentSizes = this.provider.getRecentTradeSizes(market.market_id);
    if (recentSizes.length === 0) return signals;

    // Check the most recent trade
    const lastSize = recentSizes[recentSizes.length - 1]!;
    const z = detectLargeTrade(market.market_id, lastSize, sigmaThreshold);
    if (z === null) return signals;

    // -----------------------------------------------------------------------
    // Determine direction based on model classification
    // -----------------------------------------------------------------------

    // We need to know the trade direction — check via conditional model
    // Using book imbalance as a proxy for the trade direction
    const bookImbalance = yesBook.imbalance;
    const imbalanceSign: 1 | -1 = bookImbalance >= 0 ? 1 : -1;

    // Get conditional reversion probability
    const condRevProb = conditionalReversionProbability(
      market.market_id,
      {
        imbalanceSign,
        marketType: classification.market_type,
      },
    );

    // Use conditional if available, otherwise use model-level rate
    const reversionProb = condRevProb ?? model.reversionRate;

    // -----------------------------------------------------------------------
    // Signal direction and EV
    // -----------------------------------------------------------------------

    let direction: 'BUY' | 'SELL';
    let tokenId: string;
    let expectedMove: number;

    if (model.classification === 'reversion') {
      // Fade the large trade: bet against its direction
      // If book is bid-heavy (positive imbalance), large buy just happened,
      // expect reversion → SELL YES / BUY NO
      const fadeYes = bookImbalance < 0; // fade means opposite of imbalance
      tokenId = fadeYes ? market.tokens.yes_id : market.tokens.no_id;
      direction = 'BUY';

      // Expected move = average reversion magnitude
      expectedMove = model.avgInitialImpact * reversionProb;
    } else {
      // Follow momentum: trade in same direction as the large trade
      const followYes = bookImbalance >= 0;
      tokenId = followYes ? market.tokens.yes_id : market.tokens.no_id;
      direction = 'BUY';

      // Expected move = continued momentum
      expectedMove = model.avg60sImpact * model.momentumRate;
    }

    const entryBook = tokenId === market.tokens.yes_id ? yesBook : market.book.no;
    if (entryBook.asks.length === 0) return signals;
    if (entryBook.mid <= 0 || entryBook.mid >= 1) return signals;

    // -----------------------------------------------------------------------
    // EV calculation
    // -----------------------------------------------------------------------

    const halfSpread = entryBook.spread / 2;
    const evEstimate = expectedMove - halfSpread - FEE_RATE;

    if (evEstimate < minEvThreshold) return signals;

    // -----------------------------------------------------------------------
    // Size: proportional to z-score and model confidence
    // -----------------------------------------------------------------------

    const confidence = model.observations.length / (minCalibration * 3);
    const rawSize = clamp(confidence, 0.2, 1.0) *
      (z / sigmaThreshold) *
      stratConfig.max_position_size;
    const sizeRequested = clamp(rawSize, 1, stratConfig.max_position_size);

    // -----------------------------------------------------------------------
    // Build signal
    // -----------------------------------------------------------------------

    const targetPrice = entryBook.mid;
    const maxPrice = clamp(targetPrice + DEFAULTS.max_price_premium, 0.01, 0.99);

    const signalStrength = computeSignalStrength(
      z, sigmaThreshold, evEstimate, reversionProb, model,
    );

    const ciLow = evEstimate * 0.4;
    const ciHigh = evEstimate * 1.6;

    const decayModel: DecayModel = {
      half_life_ms: halfLifeMs,
      initial_ev: evEstimate,
    };

    const killConditions: KillCondition[] = [
      { type: 'time_elapsed', threshold: DEFAULTS.time_limit_ms },
      { type: 'spread_widened', threshold: DEFAULTS.max_spread_bps },
      { type: 'regime_changed', threshold: 1 },
      { type: 'ev_decayed', threshold: minEvThreshold * 0.5 },
    ];

    const classLabel = model.classification;

    signals.push({
      signal_id: nextSignalId(),
      strategy_id: STRATEGY_ID,
      timestamp: t,
      market_id: market.market_id,
      token_id: tokenId,
      direction,
      target_price: targetPrice,
      max_price: maxPrice,
      size_requested: sizeRequested,
      urgency: classLabel === 'momentum' ? 'immediate' : 'patient',
      ev_estimate: evEstimate,
      ev_confidence_interval: [ciLow, ciHigh],
      ev_after_costs: evEstimate,
      signal_strength: signalStrength,
      expected_holding_period_ms: classLabel === 'momentum' ? 30_000 : 120_000,
      expected_sharpe_contribution: 0,
      correlation_with_existing: ctx.existing_positions.length > 0 ? 0.4 : 0,
      reasoning:
        `Large trade detected (${z.toFixed(1)}σ). ` +
        `Model: ${classLabel} (${model.observations.length} calibration events). ` +
        `Reversion rate: ${(model.reversionRate * 100).toFixed(0)}%, ` +
        `momentum rate: ${(model.momentumRate * 100).toFixed(0)}%. ` +
        `Avg initial impact: ${(model.avgInitialImpact * 100).toFixed(2)}%, ` +
        `avg 60s impact: ${(model.avg60sImpact * 100).toFixed(2)}%. ` +
        `Conditional reversion prob: ${condRevProb !== null ? (condRevProb * 100).toFixed(0) + '%' : 'N/A'}. ` +
        `EV: ${(evEstimate * 100).toFixed(2)}%`,
      kill_conditions: killConditions,
      regime_assumption: regime,
      decay_model: decayModel,
    });

    log.debug({
      market: market.market_id,
      z: z.toFixed(2),
      classification: classLabel,
      ev: evEstimate.toFixed(4),
      size: sizeRequested.toFixed(1),
    }, 'Large trade reaction signal generated');

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Signal strength computation
// ---------------------------------------------------------------------------

function computeSignalStrength(
  z: number,
  sigmaThreshold: number,
  evEstimate: number,
  reversionProb: number,
  model: ImpactModel,
): number {
  // z-score excess (0.30)
  const zScore = clamp((z - sigmaThreshold) / (sigmaThreshold * 2), 0, 1);
  // EV (0.25)
  const evScore = clamp(evEstimate / 0.05, 0, 1);
  // Calibration confidence (0.25) — more obs = better
  const calibScore = clamp(model.observations.length / 60, 0, 1);
  // Model clarity (0.20) — how clearly momentum vs reversion
  const clarity = Math.abs(model.momentumRate - model.reversionRate);
  const clarityScore = clamp(clarity / 0.5, 0, 1);

  const raw = zScore * 0.30 + evScore * 0.25 + calibScore * 0.25 + clarityScore * 0.20;
  return clamp(raw, 0.01, 1.0);
}
