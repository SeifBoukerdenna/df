// ---------------------------------------------------------------------------
// Strategy 3: Complement Arbitrage — Module 3 (SPEC.md)
//
// Monitors complement_gap_executable on each market. When
// gap < -(2*fee_rate + slippage_buffer), buying both YES and NO tokens
// guarantees a profit: payout = 1.0, cost < 1.0 - fees.
//
// Decision flow:
//   1. Check complement_gap_executable — must be meaningfully negative
//   2. Gap persistence tracking — only trade if gap has existed for > 2
//      book updates (filters transient noise from book rebuilds)
//   3. Leg slip probability — estimate P(second_leg_miss) from historical
//      book volatility; skip if > threshold
//   4. Depth check on both YES and NO ask sides
//   5. Compute exact expected profit including realistic slippage per leg
//   6. Generate two-leg BUY signal (buy YES + buy NO)
//
// Tracking metrics:
//   gap_magnitude, gap_persistence_updates, slip_probability_est,
//   expected_profit_per_unit, depth_yes, depth_no
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import type { TradeSignal, KillCondition, DecayModel } from '../ledger/types.js';
import type { Strategy, StrategyContext } from './types.js';
import type { MarketState, OrderBook } from '../state/types.js';

const log = getLogger('complement_arb');

const STRATEGY_ID = 'complement_arb';

// ---------------------------------------------------------------------------
// Gap persistence tracker (module-scoped)
// ---------------------------------------------------------------------------

export interface GapObservation {
  /** Number of consecutive book updates where the gap was profitable. */
  consecutive_updates: number;
  /** Timestamp of first observation in current streak. */
  first_seen_at: number;
  /** Timestamp of last observation. */
  last_seen_at: number;
  /** Book update counter at last check (to detect new updates). */
  last_book_update_yes: number;
  last_book_update_no: number;
}

/** Tracks per-market gap persistence. */
const gapTracker = new Map<string, GapObservation>();

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  /** Fee rate per leg (Polymarket standard). */
  fee_rate: 0.02,
  /** Additional slippage buffer beyond fees (per unit). */
  slippage_buffer: 0.005,
  /** Minimum consecutive book updates with gap before trading. */
  min_gap_persistence_updates: 2,
  /** Maximum probability of second leg miss before we skip. */
  max_leg_slip_probability: 0.05,
  /** Minimum depth on each side (YES ask + NO ask) to trade. */
  min_side_depth: 50,
  /** Default signal half-life (complement arbs close fast). */
  default_signal_half_life_ms: 10_000,
  /** Slippage estimate as fraction of spread for order sizing. */
  slippage_fraction_of_spread: 0.5,
  /** Minimum expected profit per unit to emit signal. */
  min_profit_per_unit: 0.001,
};

// ---------------------------------------------------------------------------
// Monotonic signal counter
// ---------------------------------------------------------------------------

let signalSeq = 0;

function nextSignalId(): string {
  signalSeq++;
  return `${STRATEGY_ID}_${now()}_${signalSeq}`;
}

// ---------------------------------------------------------------------------
// ComplementArbStrategy
// ---------------------------------------------------------------------------

export class ComplementArbStrategy implements Strategy {
  readonly id = STRATEGY_ID;
  readonly name = 'Complement Arbitrage';

  evaluate(ctx: StrategyContext): TradeSignal[] {
    const {
      market, config: stratConfig, regime, now: t,
    } = ctx;

    const feeRate = DEFAULTS.fee_rate;
    const slippageBuffer = (stratConfig['slippage_buffer'] as number | undefined)
      ?? DEFAULTS.slippage_buffer;
    const minPersistenceUpdates = (stratConfig['min_gap_persistence_updates'] as number | undefined)
      ?? DEFAULTS.min_gap_persistence_updates;
    const maxSlipProb = (stratConfig['max_leg_slip_probability'] as number | undefined)
      ?? DEFAULTS.max_leg_slip_probability;
    const minSideDepth = (stratConfig['min_side_depth'] as number | undefined)
      ?? DEFAULTS.min_side_depth;
    const minEvThreshold = stratConfig.min_ev_threshold ?? DEFAULTS.min_profit_per_unit;

    // --- Step 1: Check complement_gap_executable ---
    // Gap definition: 1.0 - yesBestAsk - noBestAsk - 2*feeRate
    // Positive gap = profitable arb
    const yesBestAsk = market.book.yes.asks[0];
    const noBestAsk = market.book.no.asks[0];
    if (!yesBestAsk || !noBestAsk) return [];

    const yesAskPrice = yesBestAsk[0];
    const noAskPrice = noBestAsk[0];
    const totalCost = yesAskPrice + noAskPrice;
    const totalFees = 2 * feeRate;
    const rawProfit = 1.0 - totalCost - totalFees;

    // Must exceed the slippage buffer
    if (rawProfit < slippageBuffer) return [];

    // --- Step 2: Gap persistence tracking ---
    const persistence = updateGapPersistence(
      market.market_id, market.book.yes, market.book.no, t,
    );
    if (persistence.consecutive_updates < minPersistenceUpdates) {
      log.debug({
        market: market.market_id,
        updates: persistence.consecutive_updates,
        min: minPersistenceUpdates,
      }, 'Gap not persistent enough — skipping');
      return [];
    }

    // --- Step 3: Leg slip probability ---
    // Estimate P(second_leg_miss) from book stability.
    // If the ask side is volatile (top_of_book_stability is low), the second
    // leg is more likely to move away before we can execute.
    const slipProbability = estimateSlipProbability(
      market.book.yes, market.book.no, ctx.measured_latency_ms,
    );
    if (slipProbability > maxSlipProb) {
      log.debug({
        market: market.market_id,
        slip_prob: slipProbability,
        max: maxSlipProb,
      }, 'Second leg slip probability too high');
      return [];
    }

    // --- Step 4: Depth check ---
    const yesDepth = yesBestAsk[1];
    const noDepth = noBestAsk[1];
    if (yesDepth < minSideDepth || noDepth < minSideDepth) {
      log.debug({
        market: market.market_id,
        yes_depth: yesDepth,
        no_depth: noDepth,
        min: minSideDepth,
      }, 'Insufficient depth on one or both sides');
      return [];
    }

    // --- Step 5: Compute exact expected profit with realistic slippage ---
    const yesSlippage = estimateLegSlippage(market.book.yes);
    const noSlippage = estimateLegSlippage(market.book.no);
    const expectedProfitPerUnit = rawProfit - yesSlippage - noSlippage;

    if (expectedProfitPerUnit < minEvThreshold) {
      log.debug({
        market: market.market_id,
        raw_profit: rawProfit,
        yes_slippage: yesSlippage,
        no_slippage: noSlippage,
        expected_profit: expectedProfitPerUnit,
        min_ev: minEvThreshold,
      }, 'Expected profit below threshold after slippage');
      return [];
    }

    // --- Step 6: Generate two-leg BUY signal ---
    // We generate a signal on the YES side (primary leg). The execution layer
    // must handle the paired NO buy. We encode the two-leg nature in reasoning.
    const maxTradeableSize = Math.min(
      yesDepth, noDepth, stratConfig.max_position_size,
    );
    const tradeSize = Math.max(1, maxTradeableSize);

    const halfLifeMs = stratConfig.signal_half_life_ms ?? DEFAULTS.default_signal_half_life_ms;

    const signalStrength = computeSignalStrength(
      expectedProfitPerUnit, persistence, slipProbability,
    );

    // CI on profit
    const ciLow = expectedProfitPerUnit * 0.5;
    const ciHigh = expectedProfitPerUnit * 1.5;

    const decayModel: DecayModel = {
      half_life_ms: halfLifeMs,
      initial_ev: expectedProfitPerUnit,
    };

    const killConditions: KillCondition[] = [
      { type: 'time_elapsed', threshold: halfLifeMs * 3 },
      // Kill if spread widens enough to close the gap
      { type: 'spread_widened', threshold: market.book.yes.spread_bps * 3 },
      { type: 'regime_changed', threshold: 1 },
      // Kill if gap narrows below breakeven
      { type: 'ev_decayed', threshold: slippageBuffer },
    ];

    const reasoning = buildReasoning(
      market, yesAskPrice, noAskPrice, expectedProfitPerUnit,
      yesSlippage, noSlippage, persistence, slipProbability,
    );

    const signal: TradeSignal = {
      signal_id: nextSignalId(),
      strategy_id: STRATEGY_ID,
      timestamp: t,
      market_id: market.market_id,
      token_id: market.tokens.yes_id, // primary leg is YES buy
      direction: 'BUY',
      target_price: yesAskPrice,
      max_price: Math.min(yesAskPrice + 0.01, 0.99),
      size_requested: tradeSize,
      urgency: 'immediate', // arb gaps close fast — must act immediately
      ev_estimate: rawProfit,
      ev_confidence_interval: [ciLow, ciHigh],
      ev_after_costs: expectedProfitPerUnit,
      signal_strength: signalStrength,
      expected_holding_period_ms: 0, // complement arb resolves at any time
      expected_sharpe_contribution: expectedProfitPerUnit / (rawProfit * 0.3 + 1e-9) * 0.1,
      correlation_with_existing: ctx.existing_positions.length > 0 ? 0.3 : 0,
      reasoning,
      kill_conditions: killConditions,
      regime_assumption: regime,
      decay_model: decayModel,
    };

    log.info({
      gap_magnitude: rawProfit,
      gap_persistence_updates: persistence.consecutive_updates,
      slip_probability_est: slipProbability,
      expected_profit_per_unit: expectedProfitPerUnit,
      depth_yes: yesDepth,
      depth_no: noDepth,
      yes_slippage: yesSlippage,
      no_slippage: noSlippage,
      signal_id: signal.signal_id,
      market: market.market_id,
    }, 'Complement arb signal generated');

    return [signal];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Update gap persistence tracking for a market.
 * Increments consecutive_updates when the book has been updated since last check.
 */
function updateGapPersistence(
  marketId: string,
  yesBook: OrderBook,
  noBook: OrderBook,
  t: number,
): GapObservation {
  const existing = gapTracker.get(marketId);
  const yesUpdate = yesBook.last_updated;
  const noUpdate = noBook.last_updated;

  if (!existing) {
    const obs: GapObservation = {
      consecutive_updates: 1,
      first_seen_at: t,
      last_seen_at: t,
      last_book_update_yes: yesUpdate,
      last_book_update_no: noUpdate,
    };
    gapTracker.set(marketId, obs);
    return obs;
  }

  // Check if either book has been updated since last observation
  const bookUpdated =
    yesUpdate !== existing.last_book_update_yes ||
    noUpdate !== existing.last_book_update_no;

  if (bookUpdated) {
    existing.consecutive_updates++;
    existing.last_seen_at = t;
    existing.last_book_update_yes = yesUpdate;
    existing.last_book_update_no = noUpdate;
  }

  return existing;
}

/**
 * Clear gap persistence for a market (called when gap disappears).
 */
export function clearGapPersistence(marketId: string): void {
  gapTracker.delete(marketId);
}

/**
 * Estimate probability that the second leg's ask will move away before we fill.
 *
 * Uses top_of_book_stability_ms as a proxy: if the ask has been stable for
 * much longer than our execution latency, slip probability is low.
 *
 * P(miss) ≈ latency_ms / (stability_ms + latency_ms)
 */
function estimateSlipProbability(
  yesBook: OrderBook,
  noBook: OrderBook,
  latencyMs: number,
): number {
  // Use the less stable side (higher miss risk)
  const minStability = Math.min(
    yesBook.top_of_book_stability_ms,
    noBook.top_of_book_stability_ms,
  );

  if (minStability <= 0) return 1.0;
  return latencyMs / (minStability + latencyMs);
}

/**
 * Estimate slippage for one leg based on book depth and spread.
 *
 * Conservative: assume we lose half the spread as slippage beyond the best ask.
 */
function estimateLegSlippage(book: OrderBook): number {
  return book.spread * DEFAULTS.slippage_fraction_of_spread;
}

/**
 * Compute signal strength in [0, 1].
 */
function computeSignalStrength(
  expectedProfit: number,
  persistence: GapObservation,
  slipProbability: number,
): number {
  // Profit contribution (caps at ~0.03)
  const profitContrib = Math.min(1, expectedProfit / 0.03);
  // Persistence contribution (more updates = more reliable)
  const persistContrib = Math.min(1, persistence.consecutive_updates / 5);
  // Inverse slip risk
  const slipContrib = 1 - slipProbability;

  const raw = profitContrib * 0.40 + persistContrib * 0.30 + slipContrib * 0.30;
  return Math.max(0.01, Math.min(1, raw));
}

/**
 * Build human-readable reasoning string.
 */
function buildReasoning(
  market: MarketState,
  yesAsk: number,
  noAsk: number,
  expectedProfit: number,
  yesSlippage: number,
  noSlippage: number,
  persistence: GapObservation,
  slipProbability: number,
): string {
  const total = yesAsk + noAsk;
  return `Complement arb on ${market.market_id}: ` +
    `YES ask ${yesAsk.toFixed(4)} + NO ask ${noAsk.toFixed(4)} = ${total.toFixed(4)} < 1.0. ` +
    `Expected profit: ${expectedProfit.toFixed(4)}/unit ` +
    `(slippage: YES ${yesSlippage.toFixed(4)}, NO ${noSlippage.toFixed(4)}). ` +
    `Gap persisted ${persistence.consecutive_updates} book updates. ` +
    `P(second_leg_miss): ${(slipProbability * 100).toFixed(1)}%.`;
}
