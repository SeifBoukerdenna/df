// ---------------------------------------------------------------------------
// Strategy 7: Microprice Dislocation — Module 3 (SPEC.md)
//
// Microprice diverges from raw mid by > 0.5 × spread → enter in microprice
// direction. Exit when mid converges back or after 2-minute timeout.
//
// Market eligibility:
//   - trade_rate > 10/min
//   - spread < 200 bps
//   - avg update interval < 2s
//   - market_type != 3 (not hft_bot_dominated type 3 market)
//
// High-frequency mean-reversion on top-of-book microstructure.
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { clamp } from '../utils/math.js';
import type { TradeSignal, KillCondition, DecayModel } from '../ledger/types.js';
import type { Strategy, StrategyContext } from './types.js';

const log = getLogger('microprice_dislocation');

const STRATEGY_ID = 'microprice_dislocation';
const FEE_RATE = 0.02;

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  /** Microprice deviation must exceed this multiple of spread. */
  microprice_deviation_threshold_spread_multiple: 0.5,
  min_trade_rate_per_min: 10,
  max_spread_bps: 200,
  max_update_interval_ms: 2_000,
  /** Market type 3 = bot-dominated, excluded. */
  excluded_market_type: 3 as const,
  min_ev_threshold: 0.01,
  signal_half_life_ms: 30_000,
  /** Exit timeout: 2 minutes. */
  time_limit_ms: 120_000,
  max_price_premium: 0.01,
  /** Minimum book depth on both sides to compute meaningful microprice. */
  min_book_depth: 1,
  /** Alpha: predictive multiplier — microprice deviation predicts directional\n   *  moves beyond just the convergence amount. */
  convergence_alpha: 5.0,
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
export function resetMicropriceSeq(): void {
  signalSeq = 0;
}

// ---------------------------------------------------------------------------
// Microprice deviation computation
// ---------------------------------------------------------------------------

/**
 * Computes the signed deviation of microprice from raw mid,
 * normalised by spread.
 *
 * @returns deviation / spread (positive = microprice above mid = buy-side pressure)
 *          Returns NaN if spread is zero or book has no quotes.
 */
export function computeMicropriceDeviation(
  microprice: number,
  mid: number,
  spread: number,
): number {
  if (spread <= 0 || isNaN(microprice) || isNaN(mid)) return NaN;
  return (microprice - mid) / spread;
}

// ---------------------------------------------------------------------------
// MicropriceDislocationStrategy
// ---------------------------------------------------------------------------

export class MicropriceDislocationStrategy implements Strategy {
  readonly id = STRATEGY_ID;
  readonly name = 'Microprice Dislocation';

  evaluate(ctx: StrategyContext): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const { market, regime, config: stratConfig, classification, now: t } = ctx;

    const deviationThreshold =
      (stratConfig['microprice_deviation_threshold_spread_multiple'] as number | undefined)
      ?? DEFAULTS.microprice_deviation_threshold_spread_multiple;
    const halfLifeMs = stratConfig.signal_half_life_ms ?? DEFAULTS.signal_half_life_ms;
    const minEvThreshold = stratConfig.min_ev_threshold ?? DEFAULTS.min_ev_threshold;

    // -----------------------------------------------------------------------
    // Market eligibility
    // -----------------------------------------------------------------------

    const features = classification.features;

    // Trade rate > 10/min
    if (features.trade_rate_per_min < DEFAULTS.min_trade_rate_per_min) return signals;

    // Spread < 200 bps
    const yesBook = market.book.yes;
    if (yesBook.spread_bps > DEFAULTS.max_spread_bps) return signals;

    // Update interval < 2s
    if (features.avg_update_interval_ms > DEFAULTS.max_update_interval_ms
        && features.avg_update_interval_ms > 0) return signals;

    // Not bot-dominated (market_type 3)
    if (classification.market_type === DEFAULTS.excluded_market_type) return signals;

    // -----------------------------------------------------------------------
    // Need valid book on both sides
    // -----------------------------------------------------------------------

    if (yesBook.bids.length < DEFAULTS.min_book_depth) return signals;
    if (yesBook.asks.length < DEFAULTS.min_book_depth) return signals;
    if (yesBook.mid <= 0 || yesBook.mid >= 1) return signals;
    if (yesBook.spread <= 0) return signals;

    // -----------------------------------------------------------------------
    // Compute dislocation
    // -----------------------------------------------------------------------

    const deviation = computeMicropriceDeviation(
      yesBook.microprice, yesBook.mid, yesBook.spread,
    );
    if (isNaN(deviation)) return signals;

    const absDeviation = Math.abs(deviation);
    if (absDeviation < deviationThreshold) return signals;

    // -----------------------------------------------------------------------
    // Direction: enter in microprice direction
    //   positive deviation (microprice > mid) → buy-side pressure → BUY YES
    //   negative deviation (microprice < mid) → sell-side pressure → BUY NO
    // -----------------------------------------------------------------------

    const buyYes = deviation > 0;
    const tokenId = buyYes ? market.tokens.yes_id : market.tokens.no_id;
    const entryBook = buyYes ? yesBook : market.book.no;

    if (entryBook.asks.length === 0) return signals;
    if (entryBook.mid <= 0 || entryBook.mid >= 1) return signals;

    // -----------------------------------------------------------------------
    // EV estimate: expected convergence × dislocation magnitude - costs
    // -----------------------------------------------------------------------

    const dislocationMagnitude = absDeviation * yesBook.spread;
    const expectedMove = dislocationMagnitude * DEFAULTS.convergence_alpha;
    const halfSpread = entryBook.spread / 2;
    const evEstimate = expectedMove - halfSpread - FEE_RATE;

    if (evEstimate < minEvThreshold) return signals;

    // -----------------------------------------------------------------------
    // Size: proportional to deviation excess × max position size
    // -----------------------------------------------------------------------

    const excessRatio = (absDeviation - deviationThreshold) / deviationThreshold;
    const rawSize = clamp(excessRatio, 0.1, 1.0) * stratConfig.max_position_size;
    const sizeRequested = clamp(rawSize, 1, stratConfig.max_position_size);

    // -----------------------------------------------------------------------
    // Build signal
    // -----------------------------------------------------------------------

    const targetPrice = entryBook.mid;
    const maxPrice = clamp(targetPrice + DEFAULTS.max_price_premium, 0.01, 0.99);

    const signalStrength = computeSignalStrength(
      absDeviation, deviationThreshold, evEstimate,
      features.trade_rate_per_min, yesBook.spread_bps,
    );

    const ciLow = evEstimate * 0.5;
    const ciHigh = evEstimate * 1.5;

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
      urgency: 'immediate',
      ev_estimate: evEstimate,
      ev_confidence_interval: [ciLow, ciHigh],
      ev_after_costs: evEstimate,
      signal_strength: signalStrength,
      expected_holding_period_ms: DEFAULTS.time_limit_ms / 2,
      expected_sharpe_contribution: 0,
      correlation_with_existing: ctx.existing_positions.length > 0 ? 0.3 : 0,
      reasoning:
        `Microprice dislocation: deviation ${(deviation * 100).toFixed(1)}% of spread ` +
        `(threshold: ${(deviationThreshold * 100).toFixed(1)}%). ` +
        `Microprice: ${yesBook.microprice.toFixed(4)}, mid: ${yesBook.mid.toFixed(4)}, ` +
        `spread: ${yesBook.spread_bps.toFixed(0)}bps. ` +
        `Trade rate: ${features.trade_rate_per_min.toFixed(1)}/min, ` +
        `update interval: ${features.avg_update_interval_ms.toFixed(0)}ms. ` +
        `EV: ${(evEstimate * 100).toFixed(2)}%`,
      kill_conditions: killConditions,
      regime_assumption: regime,
      decay_model: decayModel,
    });

    log.debug({
      market: market.market_id,
      deviation: deviation.toFixed(3),
      ev: evEstimate.toFixed(4),
      direction: buyYes ? 'BUY_YES' : 'BUY_NO',
      size: sizeRequested.toFixed(1),
    }, 'Microprice dislocation signal generated');

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Signal strength computation
// ---------------------------------------------------------------------------

function computeSignalStrength(
  absDeviation: number,
  threshold: number,
  evEstimate: number,
  tradeRate: number,
  spreadBps: number,
): number {
  // Deviation excess (0.35)
  const devScore = clamp(
    (absDeviation - threshold) / (threshold * 2),
    0, 1,
  );
  // EV (0.30)
  const evScore = clamp(evEstimate / 0.03, 0, 1);
  // Trade activity (0.20) — higher = more liquid = better
  const activityScore = clamp(tradeRate / 50, 0, 1);
  // Tight spread (0.15) — tighter = better
  const spreadScore = clamp(1 - spreadBps / DEFAULTS.max_spread_bps, 0, 1);

  const raw = devScore * 0.35 + evScore * 0.30 + activityScore * 0.20 + spreadScore * 0.15;
  return clamp(raw, 0.01, 1.0);
}
