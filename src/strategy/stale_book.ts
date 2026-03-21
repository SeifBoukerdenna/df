// ---------------------------------------------------------------------------
// Strategy 4: Stale Book Propagation — Module 3 (SPEC.md)
//
// Uses the propagation model from Phase 2. When market A (the leader) moves
// significantly AND market B (the laggard) has not yet adjusted AND the
// propagation lag distribution says median_lag > our execution time:
// trade B in the expected direction.
//
// Edge = correlation × A_move_magnitude × (1 - propagation_efficiency) - execution_costs
//
// Decision flow per pending propagation:
//   1. Confidence filter: pair must have > 30 observed propagation events
//   2. Direction confidence: |correlation| must be > 0.5
//   3. Staleness confirmation: B's book must be stale (staleness > 2× avg update interval)
//   4. Size based on historical edge magnitude at this lag
//   5. Kill condition: cancel if B's book updates before our fill
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { clamp } from '../utils/math.js';
import type { TradeSignal, KillCondition, DecayModel } from '../ledger/types.js';
import type { Strategy, StrategyContext } from './types.js';
import type {
  PairPropagationStats,
  PropagationEvent,
} from '../analytics/propagation_model.js';

const log = getLogger('stale_book');

const STRATEGY_ID = 'stale_book';
const FEE_RATE = 0.02;

// ---------------------------------------------------------------------------
// Provider interface — injected from wiring layer
// ---------------------------------------------------------------------------

/** Information about a pending price move awaiting propagation to a target. */
export interface PendingPropagation {
  source_market_id: string;
  /** Signed price change in source market. */
  source_move: number;
  /** Magnitude of source move in standard deviations. */
  source_move_sigma: number;
  /** Timestamp when the source market moved. */
  move_timestamp: number;
  /** Target market's price at the time the source moved. */
  target_price_at_move: number;
  /** Price correlation between source and target. */
  correlation: number;
}

export interface PropagationProvider {
  computePairStats(sourceId: string, targetId: string): PairPropagationStats | null;
  getEventsForPair(sourceId: string, targetId: string): PropagationEvent[];
  /** Returns pending moves where the given market is expected to react. */
  getActivePendingForTarget(targetId: string): PendingPropagation[];
}

// ---------------------------------------------------------------------------
// Config defaults (overridden by StrategyConfig extras)
// ---------------------------------------------------------------------------

const DEFAULTS = {
  /** Minimum propagation events to trust the pair relationship. */
  min_propagation_events: 30,
  /** Minimum |correlation| to trust direction. */
  min_correlation: 0.5,
  /** B's staleness must exceed avg_update_interval × this multiplier. */
  staleness_multiplier: 2.0,
  /** Fallback staleness threshold when avg_update_interval is unknown. */
  staleness_threshold_ms: 30_000,
  /** Minimum EV after costs to emit a signal. */
  min_ev_threshold: 0.02,
  /** Default signal half-life. */
  signal_half_life_ms: 15_000,
  /** Max additional price above mid we'll pay. */
  max_price_premium: 0.03,
  /** Kill threshold for book update detection (any mid change > this). */
  book_update_kill_threshold: 0.001,
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
export function resetStaleBookSeq(): void {
  signalSeq = 0;
}

// ---------------------------------------------------------------------------
// StaleBookStrategy
// ---------------------------------------------------------------------------

export class StaleBookStrategy implements Strategy {
  readonly id = STRATEGY_ID;
  readonly name = 'Stale Book Propagation';

  private readonly propagation: PropagationProvider;

  constructor(propagation: PropagationProvider) {
    this.propagation = propagation;
  }

  evaluate(ctx: StrategyContext): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const { market, regime, config: stratConfig, measured_latency_ms, now: t } = ctx;

    const minEvents = (stratConfig['min_propagation_events'] as number | undefined)
      ?? DEFAULTS.min_propagation_events;
    const minCorrelation = (stratConfig['min_correlation'] as number | undefined)
      ?? DEFAULTS.min_correlation;
    const stalenessMultiplier = (stratConfig['staleness_multiplier'] as number | undefined)
      ?? DEFAULTS.staleness_multiplier;
    const halfLifeMs = stratConfig.signal_half_life_ms ?? DEFAULTS.signal_half_life_ms;
    const minEvThreshold = stratConfig.min_ev_threshold ?? DEFAULTS.min_ev_threshold;

    // Get active pending propagations targeting this market (B)
    const pending = this.propagation.getActivePendingForTarget(market.market_id);
    if (pending.length === 0) return signals;

    // (3) Staleness confirmation: B's book must be stale
    //     Use the more recent of the two book sides to detect true staleness
    const latestBookUpdate = Math.max(
      market.book.yes.last_updated || 0,
      market.book.no.last_updated || 0,
    );
    const currentStaleness = latestBookUpdate > 0 ? t - latestBookUpdate : 0;

    const avgUpdateInterval = ctx.classification.features.avg_update_interval_ms;
    const stalenessThreshold = avgUpdateInterval > 0
      ? avgUpdateInterval * stalenessMultiplier
      : (stratConfig['staleness_threshold_ms'] as number | undefined)
        ?? DEFAULTS.staleness_threshold_ms;

    if (currentStaleness < stalenessThreshold) return signals;

    for (const pm of pending) {
      // (1) Confidence filter: pair needs > 30 observed propagation events
      const pairStats = this.propagation.computePairStats(
        pm.source_market_id, market.market_id,
      );
      if (!pairStats || pairStats.n_events < minEvents) continue;

      // (2) Direction confidence: |correlation| > 0.5
      if (Math.abs(pm.correlation) < minCorrelation) continue;

      // Exploitability gate: median lag must exceed our execution time
      if (pairStats.median_lag_ms <= measured_latency_ms) continue;

      // Expected direction: positive correlation → same direction as A, negative → opposite
      const expectedDirection = Math.sign(pm.source_move) * Math.sign(pm.correlation);

      // Select the appropriate book side to trade
      const buyYes = expectedDirection > 0;
      const book = buyYes ? market.book.yes : market.book.no;

      // Must have an ask to buy into
      if (book.asks.length === 0) continue;
      if (book.mid <= 0 || book.mid >= 1) continue;

      // Edge = |correlation| × |A_move| × (1 - propagation_efficiency) - execution_costs
      const grossEdge = Math.abs(pm.correlation)
        * Math.abs(pm.source_move)
        * (1 - pairStats.mean_efficiency);
      const halfSpread = book.spread / 2;
      const executionCosts = FEE_RATE + halfSpread;
      const edge = grossEdge - executionCosts;

      if (edge < minEvThreshold) continue;

      // (4) Size based on historical edge magnitude at this lag
      const historicalEdge = computeHistoricalEdgeAtLag(
        this.propagation.getEventsForPair(pm.source_market_id, market.market_id),
        pairStats.p25_lag_ms,
        pairStats.p75_lag_ms,
      );

      const maxSize = stratConfig.max_position_size;
      const sizeScalar = historicalEdge > 0
        ? clamp(historicalEdge / 0.05, 0.2, 1.0)
        : 0.2;
      const sizeRequested = Math.max(1, maxSize * sizeScalar);

      const tokenId = buyYes ? market.tokens.yes_id : market.tokens.no_id;
      const targetPrice = book.mid;
      const maxPrice = clamp(targetPrice + DEFAULTS.max_price_premium, 0.01, 0.99);

      const signalStrength = computeSignalStrength(
        pairStats, pm, edge, currentStaleness, stalenessThreshold,
      );

      const ciSpread = edge * 0.3;

      const decayModel: DecayModel = {
        half_life_ms: halfLifeMs,
        initial_ev: edge,
      };

      // (5) Kill condition: cancel if B's book updates before our fill
      const killConditions: KillCondition[] = [
        // Primary kill: any mid-price change means the stale condition resolved
        { type: 'price_moved', threshold: DEFAULTS.book_update_kill_threshold },
        // Safety: don't wait longer than the p75 lag window
        { type: 'time_elapsed', threshold: pairStats.p75_lag_ms },
        { type: 'spread_widened', threshold: Math.max(book.spread_bps * 2.5, 500) },
        { type: 'regime_changed', threshold: 1 },
        // EV decay: kill if EV drops below breakeven (= execution costs)
        { type: 'ev_decayed', threshold: executionCosts },
      ];

      const timeSinceMove = t - pm.move_timestamp;

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
        ev_estimate: edge,
        ev_confidence_interval: [edge - ciSpread, edge + ciSpread],
        ev_after_costs: edge,
        signal_strength: signalStrength,
        expected_holding_period_ms: Math.max(0, pairStats.median_lag_ms - timeSinceMove),
        expected_sharpe_contribution: 0,
        correlation_with_existing: ctx.existing_positions.length > 0 ? 0.5 : 0,
        reasoning:
          `Stale book: ${pm.source_market_id} moved ${(pm.source_move * 100).toFixed(1)}% ` +
          `(${pm.source_move_sigma.toFixed(1)}σ) at t-${timeSinceMove}ms. ` +
          `${market.market_id} stale for ${currentStaleness}ms ` +
          `(threshold: ${stalenessThreshold.toFixed(0)}ms). ` +
          `Pair: ${pairStats.n_events} events, median_lag=${pairStats.median_lag_ms}ms, ` +
          `efficiency=${(pairStats.mean_efficiency * 100).toFixed(0)}%. ` +
          `Edge: ${(edge * 100).toFixed(2)}%`,
        kill_conditions: killConditions,
        regime_assumption: regime,
        decay_model: decayModel,
      });

      log.debug({
        source: pm.source_market_id,
        target: market.market_id,
        edge: edge.toFixed(4),
        staleness_ms: currentStaleness,
        direction: buyYes ? 'BUY_YES' : 'BUY_NO',
      }, 'Stale book signal generated');
    }

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Computes the average historical edge at the pair's typical lag range.
 * Filters events within the IQR of lag values and averages |target_move| - fees.
 */
function computeHistoricalEdgeAtLag(
  events: PropagationEvent[],
  p25Lag: number,
  p75Lag: number,
): number {
  if (events.length === 0) return 0;

  const relevant = events.filter(
    e => e.propagation_lag_ms >= p25Lag && e.propagation_lag_ms <= p75Lag,
  );
  if (relevant.length === 0) return 0;

  let total = 0;
  for (const e of relevant) {
    total += Math.abs(e.target_move) - FEE_RATE;
  }
  return total / relevant.length;
}

/**
 * Signal strength from multiple factors:
 *   correlation (0.25) + n_events (0.25) + edge (0.25) + staleness (0.25)
 */
function computeSignalStrength(
  stats: PairPropagationStats,
  pending: PendingPropagation,
  edge: number,
  stalenessMs: number,
  stalenessThreshold: number,
): number {
  const corrScore = clamp(Math.abs(pending.correlation), 0, 1);
  const eventsScore = clamp(stats.n_events / 100, 0, 1);
  const edgeScore = clamp(edge / 0.05, 0, 1);
  const stalenessScore = clamp(stalenessMs / (stalenessThreshold * 3), 0, 1);

  const raw = corrScore * 0.25 + eventsScore * 0.25 + edgeScore * 0.25 + stalenessScore * 0.25;
  return clamp(raw, 0.01, 1.0);
}
