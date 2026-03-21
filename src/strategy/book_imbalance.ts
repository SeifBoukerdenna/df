// ---------------------------------------------------------------------------
// Strategy 5: Book Imbalance — Module 3 (SPEC.md)
//
// Multi-level imbalance using levels 2–5 (not just top of book — top of book
// is too easily manipulated). Enter in the direction of imbalance when
// |deep_imbalance| > threshold. Exit on mean reversion or 5-minute time limit.
//
// Market eligibility:
//   - volume_24h > $50k
//   - trades/hour > 10
//   - avg update interval < 5s
//   - spread < 500 bps
//
// Size proportional to imbalance magnitude × available depth.
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { clamp } from '../utils/math.js';
import type { TradeSignal, KillCondition, DecayModel } from '../ledger/types.js';
import type { Strategy, StrategyContext } from './types.js';

const log = getLogger('book_imbalance');

const STRATEGY_ID = 'book_imbalance';
const FEE_RATE = 0.02;

// ---------------------------------------------------------------------------
// Config defaults (overridden by StrategyConfig extras)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  imbalance_threshold: 0.60,
  min_volume_24h: 50_000,
  min_trades_per_hour: 10,
  max_update_interval_ms: 5_000,
  max_spread_bps: 500,
  min_ev_threshold: 0.015,
  signal_half_life_ms: 60_000,
  /** Hard time limit — exit after 5 minutes no matter what. */
  time_limit_ms: 300_000,
  max_price_premium: 0.02,
  /** Multiplier for expected move from imbalance × spread. */
  imbalance_alpha: 5.0,
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
export function resetBookImbalanceSeq(): void {
  signalSeq = 0;
}

// ---------------------------------------------------------------------------
// Deep imbalance — levels 2–5 only
// ---------------------------------------------------------------------------

/**
 * Computes size-weighted imbalance across levels 2–5 of the order book,
 * skipping the easily-manipulated top of book (level 1).
 *
 * Each level is weighted by 1/level_index (level 2 = 1, level 3 = 0.5, etc.)
 * so that shallower visible levels contribute more.
 *
 * @returns Imbalance in [-1, 1]. Positive = bid-heavy. 0 if both sides empty.
 */
export function computeDeepImbalance(
  bids: [number, number][],
  asks: [number, number][],
): number {
  let weightedBid = 0;
  let weightedAsk = 0;

  // Indices 1..4 correspond to book levels 2..5
  for (let i = 1; i < 5; i++) {
    const weight = 1 / i;
    const bidSize = bids[i]?.[1] ?? 0;
    const askSize = asks[i]?.[1] ?? 0;
    weightedBid += bidSize * weight;
    weightedAsk += askSize * weight;
  }

  const total = weightedBid + weightedAsk;
  if (total === 0) return 0;
  return (weightedBid - weightedAsk) / total;
}

// ---------------------------------------------------------------------------
// Depth helper
// ---------------------------------------------------------------------------

/** Sum of order sizes across the first `maxLevels` levels of one book side. */
function availableDepth(levels: [number, number][], maxLevels: number = 5): number {
  let d = 0;
  const n = Math.min(levels.length, maxLevels);
  for (let i = 0; i < n; i++) {
    d += levels[i]![1];
  }
  return d;
}

// ---------------------------------------------------------------------------
// BookImbalanceStrategy
// ---------------------------------------------------------------------------

export class BookImbalanceStrategy implements Strategy {
  readonly id = STRATEGY_ID;
  readonly name = 'Book Imbalance';

  evaluate(ctx: StrategyContext): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const { market, regime, config: stratConfig, now: t } = ctx;

    const threshold = (stratConfig['imbalance_threshold'] as number | undefined)
      ?? DEFAULTS.imbalance_threshold;
    const minVolume = (stratConfig['min_volume_24h'] as number | undefined)
      ?? DEFAULTS.min_volume_24h;
    const minTradesPerHour = (stratConfig['min_trades_per_hour'] as number | undefined)
      ?? DEFAULTS.min_trades_per_hour;
    const halfLifeMs = stratConfig.signal_half_life_ms ?? DEFAULTS.signal_half_life_ms;
    const minEvThreshold = stratConfig.min_ev_threshold ?? DEFAULTS.min_ev_threshold;

    // -----------------------------------------------------------------------
    // Market eligibility
    // -----------------------------------------------------------------------

    // Volume > $50k
    if (market.volume_24h < minVolume) return signals;

    // Trades/hour > 10
    if (market.trade_count_1h < minTradesPerHour) return signals;

    // Update interval < 5s
    const avgUpdateMs = ctx.classification.features.avg_update_interval_ms;
    if (avgUpdateMs > DEFAULTS.max_update_interval_ms && avgUpdateMs > 0) return signals;

    // Spread < 500 bps (check YES book as primary)
    const yesBook = market.book.yes;
    if (yesBook.spread_bps > DEFAULTS.max_spread_bps) return signals;

    // Need sufficient book depth to compute imbalance
    if (yesBook.bids.length < 2 && yesBook.asks.length < 2) return signals;

    // -----------------------------------------------------------------------
    // Compute deep imbalance (levels 2–5 of YES book)
    // -----------------------------------------------------------------------

    const deepImbalance = computeDeepImbalance(yesBook.bids, yesBook.asks);

    if (Math.abs(deepImbalance) < threshold) return signals;

    // -----------------------------------------------------------------------
    // Direction: positive imbalance = bid-heavy → expect price up → BUY YES
    //            negative imbalance = ask-heavy → expect price down → BUY NO
    // -----------------------------------------------------------------------

    const buyYes = deepImbalance > 0;
    const tokenId = buyYes ? market.tokens.yes_id : market.tokens.no_id;
    const entryBook = buyYes ? yesBook : market.book.no;

    // Must have asks to buy into and a valid mid
    if (entryBook.asks.length === 0) return signals;
    if (entryBook.mid <= 0 || entryBook.mid >= 1) return signals;

    // -----------------------------------------------------------------------
    // Size proportional to |imbalance| × available depth
    // -----------------------------------------------------------------------

    const depth = availableDepth(entryBook.asks);
    const rawSize = Math.abs(deepImbalance) * depth;
    const maxSize = stratConfig.max_position_size;
    const sizeRequested = clamp(rawSize, 1, maxSize);

    // -----------------------------------------------------------------------
    // EV estimate
    // -----------------------------------------------------------------------

    const expectedMove = Math.abs(deepImbalance) * yesBook.spread * DEFAULTS.imbalance_alpha;
    const halfSpread = entryBook.spread / 2;
    const evEstimate = expectedMove - halfSpread - FEE_RATE;

    if (evEstimate < minEvThreshold) return signals;

    // -----------------------------------------------------------------------
    // Build signal
    // -----------------------------------------------------------------------

    const targetPrice = entryBook.mid;
    const maxPrice = clamp(targetPrice + DEFAULTS.max_price_premium, 0.01, 0.99);

    const signalStrength = computeSignalStrength(
      deepImbalance, threshold, evEstimate, market.volume_24h, minVolume,
    );

    const ciLow = evEstimate * 0.5;
    const ciHigh = evEstimate * 1.5;

    const decayModel: DecayModel = {
      half_life_ms: halfLifeMs,
      initial_ev: evEstimate,
    };

    // Kill conditions: 5-minute time limit + mean reversion via EV decay
    const killConditions: KillCondition[] = [
      { type: 'time_elapsed', threshold: DEFAULTS.time_limit_ms },
      { type: 'spread_widened', threshold: DEFAULTS.max_spread_bps },
      { type: 'regime_changed', threshold: 1 },
      { type: 'ev_decayed', threshold: minEvThreshold * 0.5 },
    ];

    signals.push({
      signal_id: nextSignalId(),
      strategy_id: STRATEGY_ID,
      timestamp: t,
      market_id: market.market_id,
      token_id: tokenId,
      direction: 'BUY',
      target_price: targetPrice,
      max_price: maxPrice,
      size_requested: sizeRequested,
      urgency: 'patient',
      ev_estimate: evEstimate,
      ev_confidence_interval: [ciLow, ciHigh],
      ev_after_costs: evEstimate,
      signal_strength: signalStrength,
      expected_holding_period_ms: DEFAULTS.time_limit_ms / 2,
      expected_sharpe_contribution: 0,
      correlation_with_existing: ctx.existing_positions.length > 0 ? 0.5 : 0,
      reasoning:
        `Book imbalance: deep levels (2-5) show ${deepImbalance > 0 ? 'bid' : 'ask'}-heavy ` +
        `imbalance of ${(Math.abs(deepImbalance) * 100).toFixed(1)}% ` +
        `(threshold: ${(threshold * 100).toFixed(1)}%). ` +
        `Volume 24h: $${market.volume_24h.toFixed(0)}, ` +
        `trades/h: ${market.trade_count_1h}, ` +
        `spread: ${yesBook.spread_bps.toFixed(0)}bps. ` +
        `EV: ${(evEstimate * 100).toFixed(2)}%`,
      kill_conditions: killConditions,
      regime_assumption: regime,
      decay_model: decayModel,
    });

    log.debug({
      market: market.market_id,
      deep_imbalance: deepImbalance.toFixed(3),
      ev: evEstimate.toFixed(4),
      direction: buyYes ? 'BUY_YES' : 'BUY_NO',
      size: sizeRequested.toFixed(1),
    }, 'Book imbalance signal generated');

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Signal strength computation
// ---------------------------------------------------------------------------

/**
 * Signal strength from:
 *   imbalance excess (0.40) + EV (0.35) + volume (0.25)
 */
function computeSignalStrength(
  deepImbalance: number,
  threshold: number,
  evEstimate: number,
  volume24h: number,
  minVolume: number,
): number {
  // How much imbalance exceeds threshold, normalised to [0, 1]
  const imbalanceScore = clamp(
    (Math.abs(deepImbalance) - threshold) / (1 - threshold),
    0, 1,
  );
  const evScore = clamp(evEstimate / 0.05, 0, 1);
  const volumeScore = clamp(volume24h / (minVolume * 5), 0, 1);

  const raw = imbalanceScore * 0.40 + evScore * 0.35 + volumeScore * 0.25;
  return clamp(raw, 0.01, 1.0);
}
