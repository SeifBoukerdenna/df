// ---------------------------------------------------------------------------
// Strategy 2: Cross-Market Consistency Arbitrage — Module 3 (SPEC.md)
//
// Uses ConsistencyChecker to find probability axiom violations across
// related markets (exhaustive partitions, subset/superset, conditional,
// temporal). Generates signals to trade toward the structural bound.
//
// Decision flow:
//   1. Run consistency checks on current world state
//   2. Filter by persistence — only trade violations that have persisted
//      longer than a configurable threshold (calibrated from collected data)
//   3. Market eligibility — all legs must have sufficient book depth
//   4. Compute edge = violation_magnitude × estimated_reversion_speed
//      minus total execution cost (spread + fees across all legs)
//   5. Build multi-leg execution plan with worst-case if one leg fails
//   6. Kill condition if violation narrows below breakeven
//
// Tracking metrics:
//   violation_type, violation_magnitude, executable_magnitude,
//   violation_persistence_ms, leg_count, reversion_speed_estimate
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import type { TradeSignal, KillCondition, DecayModel } from '../ledger/types.js';
import type { Strategy, StrategyContext } from './types.js';
import type {
  ConsistencyCheck,
  ConsistencyTradePlan,
  ViolationPersistence,
} from '../analytics/types.js';
import type { ConsistencyChecker } from '../analytics/consistency_checker.js';
import type { MarketState } from '../state/types.js';

const log = getLogger('cross_market_consistency');

const STRATEGY_ID = 'cross_market_consistency';

// ---------------------------------------------------------------------------
// Provider interface — decouples strategy from global ConsistencyChecker
// ---------------------------------------------------------------------------

export interface ConsistencyProvider {
  /** Run all checks and return current violations. */
  checkAll(
    markets: StrategyContext['world']['markets'],
    graph: StrategyContext['world']['market_graph'],
  ): ConsistencyCheck[];
  /** Get persistence record for a specific violation. */
  getViolation(checkId: string): ViolationPersistence | undefined;
  /** Get persistence stats (median duration, etc.). */
  getPersistenceStats(): {
    active_count: number;
    resolved_last_hour: number;
    median_duration_ms: number;
    avg_duration_ms: number;
    pct_tradeable: number;
  };
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
  /** Minimum time a violation must persist before we trade it (ms). */
  min_persistence_ms: 10_000,
  /** Minimum executable violation magnitude (per unit). */
  min_executable_violation: 0.005,
  /** Minimum book depth per leg to consider tradeable. */
  min_leg_depth: 50,
  /** Estimated reversion speed: fraction of violation that closes per second. */
  estimated_reversion_speed_per_sec: 0.02,
  /** Signal half-life for consistency arb (ms). */
  default_signal_half_life_ms: 300_000,
  /** Fee rate per leg. */
  fee_rate: 0.02,
  /** Maximum number of legs before we skip the trade (execution risk). */
  max_legs: 6,
  /** Trade size per leg (default, may be overridden by config). */
  default_trade_size: 100,
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
// CrossMarketConsistencyStrategy
// ---------------------------------------------------------------------------

export class CrossMarketConsistencyStrategy implements Strategy {
  readonly id = STRATEGY_ID;
  readonly name = 'Cross-Market Consistency Arbitrage';

  private readonly provider: ConsistencyProvider;

  constructor(provider: ConsistencyProvider) {
    this.provider = provider;
  }

  /**
   * Evaluate the current market for cross-market consistency signals.
   *
   * Note: unlike wallet_follow which is per-market, consistency arb is
   * inherently cross-market. The engine calls evaluate() per market, so we
   * only generate a signal when ctx.market is the PRIMARY leg of a violation
   * (the leg we'd trade first). This avoids duplicate signals.
   */
  evaluate(ctx: StrategyContext): TradeSignal[] {
    const signals: TradeSignal[] = [];
    const {
      world, market, config: stratConfig, regime, now: t,
    } = ctx;

    const minPersistenceMs = (stratConfig['min_persistence_ms'] as number | undefined)
      ?? DEFAULTS.min_persistence_ms;
    const minExecViolation = stratConfig.min_ev_threshold ?? DEFAULTS.min_executable_violation;
    const minLegDepth = (stratConfig['min_leg_depth'] as number | undefined)
      ?? DEFAULTS.min_leg_depth;
    const maxLegs = (stratConfig['max_legs'] as number | undefined) ?? DEFAULTS.max_legs;
    const feeRate = DEFAULTS.fee_rate;

    // Run consistency checks (the checker tracks persistence internally)
    const violations = this.provider.checkAll(world.markets, world.market_graph);

    for (const check of violations) {
      // Only trigger on violations involving this market (avoid duplicate signals
      // across multiple engine-per-market calls)
      if (!check.markets_involved.includes(market.market_id)) continue;

      // Only fire on the FIRST market in the sorted list (deterministic dedup)
      const sortedInvolved = [...check.markets_involved].sort();
      if (sortedInvolved[0] !== market.market_id) continue;

      // Must have a trade plan from the checker
      if (!check.trade_plan || !check.tradeable) continue;

      // --- Gate 1: Violation persistence filter ---
      const persistence = this.provider.getViolation(check.check_id);
      if (!persistence) continue;

      const violationAge = t - persistence.first_detected_at;
      if (violationAge < minPersistenceMs) {
        log.debug({
          check_id: check.check_id,
          age_ms: violationAge,
          min_ms: minPersistenceMs,
        }, 'Violation too young — skipping');
        continue;
      }

      // --- Gate 2: Executable magnitude above threshold ---
      if (check.executable_violation < minExecViolation) continue;

      // --- Gate 3: Market eligibility — all legs must have depth ---
      const legDepthOk = checkAllLegsDepth(
        check.trade_plan, world.markets, minLegDepth,
      );
      if (!legDepthOk) {
        log.debug({
          check_id: check.check_id,
          type: check.check_type,
        }, 'Insufficient depth on one or more legs');
        continue;
      }

      // --- Gate 4: Max legs ---
      if (check.trade_plan.legs.length > maxLegs) continue;

      // --- Compute edge ---
      // edge = violation_magnitude × reversion_speed_est - total_execution_cost
      const numLegs = check.trade_plan.legs.length;
      const totalSpreadCost = computeTotalSpreadCost(check.trade_plan, world.markets);
      const totalFeeCost = feeRate * numLegs;
      const totalExecutionCost = totalSpreadCost + totalFeeCost;

      const reversionSpeedPerSec = DEFAULTS.estimated_reversion_speed_per_sec;
      const evEstimate = check.violation_magnitude * reversionSpeedPerSec;
      const evAfterCosts = check.executable_violation; // checker already deducts fees

      if (evAfterCosts < minExecViolation) continue;

      // --- Build worst-case analysis for multi-leg execution ---
      const worstCase = computeWorstCase(check.trade_plan, world.markets, feeRate);

      // --- Signal properties ---
      const halfLifeMs = stratConfig.signal_half_life_ms ?? DEFAULTS.default_signal_half_life_ms;
      const tradeSize = Math.min(
        stratConfig.max_position_size,
        DEFAULTS.default_trade_size,
      );

      // Primary leg = first leg in the plan
      const primaryLeg = check.trade_plan.legs[0]!;
      const primaryMarket = world.markets.get(primaryLeg.market_id);
      if (!primaryMarket) continue;

      const primaryBook = primaryLeg.direction === 'BUY'
        ? primaryMarket.book.yes
        : primaryMarket.book.yes;
      const targetPrice = primaryBook.mid;
      const maxPrice = primaryLeg.direction === 'BUY'
        ? Math.min(targetPrice + 0.03, 0.99)
        : Math.max(targetPrice - 0.03, 0.01);

      // Signal strength: composite of violation magnitude, persistence, and executability
      const signalStrength = computeSignalStrength(
        check, persistence, evAfterCosts,
      );

      // Confidence interval
      const ciHalf = check.violation_magnitude * 0.3; // rough estimate
      const ciLow = evAfterCosts - ciHalf;
      const ciHigh = evAfterCosts + ciHalf;

      // Expected holding period: inversely proportional to reversion speed
      const expectedHoldMs = Math.min(
        check.violation_magnitude / (reversionSpeedPerSec + 1e-9) * 1000,
        halfLifeMs * 2,
      );

      const decayModel: DecayModel = {
        half_life_ms: halfLifeMs,
        initial_ev: evAfterCosts,
      };

      // Kill conditions
      const killConditions: KillCondition[] = [
        { type: 'time_elapsed', threshold: halfLifeMs * 3 },
        { type: 'spread_widened', threshold: primaryBook.spread_bps * 3 },
        { type: 'regime_changed', threshold: 1 },
        // Kill if violation narrows below breakeven
        { type: 'ev_decayed', threshold: totalExecutionCost },
      ];

      const reasoning = buildReasoning(check, persistence, evAfterCosts, worstCase);

      const signal: TradeSignal = {
        signal_id: nextSignalId(),
        strategy_id: STRATEGY_ID,
        timestamp: t,
        market_id: primaryLeg.market_id,
        token_id: primaryLeg.token_id,
        direction: primaryLeg.direction,
        target_price: targetPrice,
        max_price: maxPrice,
        size_requested: tradeSize,
        urgency: 'patient', // arb signals are patient — no urgency premium
        ev_estimate: evEstimate,
        ev_confidence_interval: [ciLow, ciHigh],
        ev_after_costs: evAfterCosts,
        signal_strength: signalStrength,
        expected_holding_period_ms: expectedHoldMs,
        expected_sharpe_contribution: evAfterCosts / (ciHalf + 1e-9) * 0.1,
        correlation_with_existing: ctx.existing_positions.length > 0 ? 0.5 : 0,
        reasoning,
        kill_conditions: killConditions,
        regime_assumption: regime,
        decay_model: decayModel,
      };

      signals.push(signal);

      log.info({
        check_type: check.check_type,
        check_id: check.check_id,
        violation_magnitude: check.violation_magnitude,
        executable_magnitude: check.executable_violation,
        violation_persistence_ms: violationAge,
        leg_count: numLegs,
        reversion_speed_estimate: reversionSpeedPerSec,
        ev_after_costs: evAfterCosts,
        worst_case_loss: worstCase.worstCaseLoss,
        signal_id: signal.signal_id,
      }, 'Consistency arb signal generated');
    }

    return signals;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check that every leg in the trade plan has sufficient book depth.
 */
function checkAllLegsDepth(
  plan: ConsistencyTradePlan,
  markets: Map<string, MarketState>,
  minDepth: number,
): boolean {
  for (const leg of plan.legs) {
    const m = markets.get(leg.market_id);
    if (!m) return false;

    if (leg.direction === 'BUY') {
      const bestAsk = m.book.yes.asks[0];
      if (!bestAsk || bestAsk[1] < minDepth) return false;
    } else {
      const bestBid = m.book.yes.bids[0];
      if (!bestBid || bestBid[1] < minDepth) return false;
    }
  }
  return true;
}

/**
 * Compute total half-spread cost across all legs.
 */
function computeTotalSpreadCost(
  plan: ConsistencyTradePlan,
  markets: Map<string, MarketState>,
): number {
  let total = 0;
  for (const leg of plan.legs) {
    const m = markets.get(leg.market_id);
    if (!m) continue;
    total += m.book.yes.spread / 2;
  }
  return total;
}

/**
 * Compute worst-case outcome if one leg fails during multi-leg execution.
 */
function computeWorstCase(
  plan: ConsistencyTradePlan,
  markets: Map<string, MarketState>,
  feeRate: number,
): { worstCaseLoss: number; failedLegId: string | null; description: string } {
  if (plan.legs.length <= 1) {
    return {
      worstCaseLoss: plan.worst_case_loss,
      failedLegId: null,
      description: 'Single leg: loss limited to fees',
    };
  }

  // Worst case: we fill the first N-1 legs but the last leg fails.
  // For each possible failed leg, compute directional exposure.
  let maxLoss = 0;
  let worstLegId: string | null = null;

  for (let i = 0; i < plan.legs.length; i++) {
    const failedLeg = plan.legs[i]!;
    // If this leg fails, we have executed all other legs
    // Cost = fees on executed legs + directional exposure from the missing leg
    const executedFees = (plan.legs.length - 1) * feeRate;
    const failedMarket = markets.get(failedLeg.market_id);
    if (!failedMarket) continue;

    // Directional exposure: if we bought on the executed legs but couldn't
    // hedge with the failed leg, our max loss is the spread of the failed leg
    // times the size, plus the fees on executed legs
    const failedLegSpread = failedMarket.book.yes.spread;
    const positionLoss = failedLegSpread * failedLeg.size;
    const totalLoss = executedFees * failedLeg.size + positionLoss;

    if (totalLoss > maxLoss) {
      maxLoss = totalLoss;
      worstLegId = failedLeg.market_id;
    }
  }

  return {
    worstCaseLoss: maxLoss,
    failedLegId: worstLegId,
    description: worstLegId
      ? `Worst case: leg ${worstLegId} fails → directional exposure + fees on ${plan.legs.length - 1} executed legs`
      : 'No leg failure risk computed',
  };
}

/**
 * Compute signal strength in [0, 1].
 */
function computeSignalStrength(
  check: ConsistencyCheck,
  persistence: ViolationPersistence,
  evAfterCosts: number,
): number {
  // Violation magnitude contribution (caps at 0.10)
  const magContrib = Math.min(1, check.violation_magnitude / 0.10);
  // Persistence contribution (longer = more confident, caps at 60s)
  const persistContrib = Math.min(1, persistence.duration_ms / 60_000);
  // Observation count (more re-observations = more trustworthy)
  const obsContrib = Math.min(1, persistence.observation_count / 10);
  // EV magnitude (caps at 0.05)
  const evContrib = Math.min(1, evAfterCosts / 0.05);

  const raw = magContrib * 0.30 + persistContrib * 0.25 + obsContrib * 0.20 + evContrib * 0.25;
  return Math.max(0.01, Math.min(1, raw));
}

/**
 * Build human-readable reasoning string.
 */
function buildReasoning(
  check: ConsistencyCheck,
  persistence: ViolationPersistence,
  evAfterCosts: number,
  worstCase: { worstCaseLoss: number; description: string },
): string {
  const typeName = check.check_type.replace(/_/g, ' ');
  const legCount = check.trade_plan?.legs.length ?? 0;
  const durationSec = (persistence.duration_ms / 1000).toFixed(1);
  const obs = persistence.observation_count;

  return `${typeName} violation across ${check.markets_involved.length} markets ` +
    `(${check.markets_involved.join(', ')}). ` +
    `Magnitude: ${check.violation_magnitude.toFixed(4)}, ` +
    `executable: ${check.executable_violation.toFixed(4)}. ` +
    `Persisted ${durationSec}s (${obs} observations). ` +
    `${legCount}-leg trade, EV after costs: ${evAfterCosts.toFixed(4)}. ` +
    `Worst case: ${worstCase.description}.`;
}
