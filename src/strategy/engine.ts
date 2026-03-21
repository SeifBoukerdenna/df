// ---------------------------------------------------------------------------
// Strategy Engine — Module 3 (SPEC.md)
//
// Receives WorldState + EdgeMap, iterates all enabled strategies, checks
// market eligibility, collects signals, applies engine-level filters, and
// logs signal_generated / signal_filtered to the ledger.
//
// Full shadow mode support: when the global paper_mode flag or a strategy's
// paper_only flag is set, signals are generated and logged but tagged so
// downstream layers know not to submit real orders.
//
// The engine does NOT decide sizing or portfolio allocation — that is the
// Portfolio Construction layer's job. It only decides WHAT to trade and WHY.
// ---------------------------------------------------------------------------

import { now, elapsed, nowHr } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import { config } from '../utils/config.js';
import type { Ledger } from '../ledger/ledger.js';
import type { TradeSignal, KillConditionType } from '../ledger/types.js';
import { computeEvAtT } from '../ledger/types.js';
import type { WorldState, MarketState, PositionState, RegimeName } from '../state/types.js';
import type { EdgeMap, EdgeMapEntry, MarketClassification } from '../analytics/types.js';
import type { MarketClassifier } from '../analytics/market_classifier.js';
import type {
  Strategy,
  StrategyContext,
  StrategyRegistration,
  FilteredSignal,
  EngineTickResult,
} from './types.js';
import type { StrategyConfig } from '../utils/config.js';

const log = getLogger('strategy_engine');

// ---------------------------------------------------------------------------
// Deduplication window — prevent the same signal from being emitted twice
// within a short window. Keyed by strategy_id:market_id:direction.
// ---------------------------------------------------------------------------

const DEDUP_WINDOW_MS = 5_000;

// ---------------------------------------------------------------------------
// StrategyEngine
// ---------------------------------------------------------------------------

export class StrategyEngine {
  private readonly ledger: Ledger;
  private readonly strategies: Map<string, StrategyRegistration> = new Map();

  /** Cooldown tracker: strategy_id → resume-after timestamp. */
  private readonly cooldowns: Map<string, number> = new Map();

  /** Recent signal dedup: key → expiry timestamp. */
  private readonly recentSignals: Map<string, number> = new Map();

  /** Live signals being tracked for kill condition evaluation. */
  private readonly liveSignals: Map<string, TradeSignal> = new Map();

  /** Monotonic counter for signal IDs within a process lifetime. */
  private signalSeq = 0;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  // -----------------------------------------------------------------------
  // Strategy registration
  // -----------------------------------------------------------------------

  /**
   * Registers a strategy implementation with the engine.
   * The strategy's `id` must match a key in `config.strategies`.
   */
  register(strategy: Strategy): void {
    const stratConfig = this.lookupConfig(strategy.id);

    if (!stratConfig) {
      log.warn(
        { id: strategy.id },
        'Strategy has no config entry — registering with defaults (disabled)',
      );
    }

    const registration: StrategyRegistration = {
      strategy,
      config: stratConfig ?? makeDisabledConfig(),
    };

    this.strategies.set(strategy.id, registration);
    log.info(
      {
        id: strategy.id,
        name: strategy.name,
        enabled: registration.config.enabled,
        paper_only: registration.config.paper_only,
      },
      'Strategy registered',
    );
  }

  /**
   * Unregisters a strategy (e.g., on retirement).
   */
  unregister(strategyId: string): void {
    this.strategies.delete(strategyId);
    this.cooldowns.delete(strategyId);
    log.info({ id: strategyId }, 'Strategy unregistered');
  }

  /**
   * Returns all registered strategy IDs.
   */
  registeredIds(): string[] {
    return [...this.strategies.keys()];
  }

  /**
   * Returns whether a strategy is registered and enabled.
   */
  isEnabled(strategyId: string): boolean {
    const reg = this.strategies.get(strategyId);
    return reg !== undefined && reg.config.enabled;
  }

  // -----------------------------------------------------------------------
  // Cooldown management
  // -----------------------------------------------------------------------

  /**
   * Puts a strategy into cooldown (e.g., after a loss).
   */
  applyCooldown(strategyId: string): void {
    const reg = this.strategies.get(strategyId);
    if (!reg) return;

    const resumeAt = now() + reg.config.cooldown_after_loss_ms;
    this.cooldowns.set(strategyId, resumeAt);
    log.info(
      { id: strategyId, cooldown_ms: reg.config.cooldown_after_loss_ms },
      'Strategy cooldown applied',
    );
  }

  private isOnCooldown(strategyId: string, t: number): boolean {
    const resumeAt = this.cooldowns.get(strategyId);
    if (resumeAt === undefined) return false;
    if (t >= resumeAt) {
      this.cooldowns.delete(strategyId);
      return false;
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Main tick
  // -----------------------------------------------------------------------

  /**
   * Runs a single engine tick: evaluates all enabled strategies against all
   * eligible markets. Returns generated and filtered signals.
   *
   * Call this on every state update cycle (e.g., every 1–5 seconds).
   */
  tick(
    world: WorldState,
    edgeMap: EdgeMap,
    classifier: MarketClassifier,
  ): EngineTickResult {
    const tickStart = nowHr();
    const t = now();
    const regime = world.regime.current_regime;

    // Build lookup: market_id → EdgeMapEntry
    const edgeLookup = new Map<string, EdgeMapEntry>();
    for (const entry of edgeMap.markets_with_edge) {
      edgeLookup.set(entry.market_id, entry);
    }

    const allGenerated: TradeSignal[] = [];
    const allFiltered: FilteredSignal[] = [];
    let marketsEvaluated = 0;
    let strategiesRun = 0;

    // Clean expired dedup entries
    this.cleanDedup(t);

    for (const [strategyId, reg] of this.strategies) {
      // Skip disabled strategies
      if (!reg.config.enabled) continue;

      // Skip strategies on cooldown
      if (this.isOnCooldown(strategyId, t)) {
        log.debug({ id: strategyId }, 'Strategy on cooldown — skipping');
        continue;
      }

      // Regime gate: skip if current regime not in allowed list
      if (
        reg.config.allowed_regimes.length > 0 &&
        !reg.config.allowed_regimes.includes(regime)
      ) {
        log.debug(
          { id: strategyId, regime, allowed: reg.config.allowed_regimes },
          'Strategy skipped — regime not allowed',
        );
        continue;
      }

      strategiesRun++;

      // Count active positions for this strategy (for max_concurrent check)
      const activePositionCount = this.countActivePositions(world, strategyId);

      // Iterate all markets with edge
      for (const edgeEntry of edgeMap.markets_with_edge) {
        const market = world.markets.get(edgeEntry.market_id);
        if (!market || market.status !== 'active') continue;

        // Eligibility: classifier must list this strategy as viable
        if (!edgeEntry.viable_strategies.includes(strategyId)) continue;

        // Max concurrent positions gate
        if (activePositionCount >= reg.config.max_concurrent_positions) {
          break; // no point checking more markets for this strategy
        }

        const classification = classifier.getClassification(edgeEntry.market_id);
        if (!classification) continue;

        marketsEvaluated++;

        // Build context
        const ctx: StrategyContext = {
          world,
          market,
          classification,
          edge: edgeEntry,
          existing_positions: this.getPositionsForMarket(world, market.market_id),
          regime,
          config: reg.config,
          measured_latency_ms: edgeMap.measured_latency_p50_ms,
          now: t,
        };

        // Evaluate — catch strategy errors so one bad strategy doesn't kill the engine
        let rawSignals: TradeSignal[];
        try {
          rawSignals = reg.strategy.evaluate(ctx);
        } catch (err) {
          log.error(
            { strategy: strategyId, market: market.market_id, err },
            'Strategy threw during evaluate — skipping market',
          );
          continue;
        }

        // Engine-level filters on each signal
        for (const signal of rawSignals) {
          const filterReason = this.filterSignal(signal, reg, edgeEntry, world, t);

          if (filterReason !== null) {
            const filtered: FilteredSignal = {
              signal_id: signal.signal_id,
              strategy_id: signal.strategy_id,
              market_id: signal.market_id,
              reason: filterReason.reason,
              filter: filterReason.filter,
            };
            allFiltered.push(filtered);

            this.ledger.append({
              type: 'signal_filtered',
              data: {
                signal_id: signal.signal_id,
                reason: filterReason.reason,
                filter: filterReason.filter,
              },
            });
          } else {
            // Signal passes all engine filters
            allGenerated.push(signal);
            this.recordDedup(signal, t);

            this.ledger.append({
              type: 'signal_generated',
              data: signal,
            });

            log.info(
              {
                signal_id: signal.signal_id,
                strategy: signal.strategy_id,
                market: signal.market_id,
                direction: signal.direction,
                ev: signal.ev_estimate,
                ev_after_costs: signal.ev_after_costs,
                strength: signal.signal_strength,
                paper: reg.config.paper_only || config.paper_mode,
              },
              'Signal generated',
            );
          }
        }
      }
    }

    const elapsedMs = elapsed(tickStart);

    if (allGenerated.length > 0 || allFiltered.length > 0) {
      log.info(
        {
          generated: allGenerated.length,
          filtered: allFiltered.length,
          markets_evaluated: marketsEvaluated,
          strategies_run: strategiesRun,
          elapsed_ms: elapsedMs.toFixed(1),
          regime,
        },
        'Engine tick complete',
      );
    }

    return {
      timestamp: t,
      regime,
      markets_evaluated: marketsEvaluated,
      strategies_run: strategiesRun,
      signals_generated: allGenerated,
      signals_filtered: allFiltered,
      elapsed_ms: elapsedMs,
    };
  }

  // -----------------------------------------------------------------------
  // Live signal management + kill condition checking
  // -----------------------------------------------------------------------

  /**
   * Tracks a signal for kill condition monitoring. Call after a signal is
   * accepted by the portfolio layer and an order is live.
   */
  trackSignal(signal: TradeSignal): void {
    this.liveSignals.set(signal.signal_id, signal);
  }

  /**
   * Removes a signal from live tracking (filled, cancelled, or killed).
   */
  untrackSignal(signalId: string): void {
    this.liveSignals.delete(signalId);
  }

  /**
   * Evaluates kill conditions on all live signals against current world state.
   * Returns signals that should be killed, with the triggering condition.
   * Automatically logs signal_killed to ledger and removes from tracking.
   */
  checkKillConditions(world: WorldState): KilledSignal[] {
    const t = now();
    const killed: KilledSignal[] = [];

    for (const [signalId, signal] of this.liveSignals) {
      const ageMs = t - signal.timestamp;
      const market = world.markets.get(signal.market_id);

      for (const kc of signal.kill_conditions) {
        let actualValue: number | null = null;

        switch (kc.type) {
          case 'time_elapsed':
            actualValue = ageMs;
            break;

          case 'price_moved': {
            if (!market) break;
            const book = market.tokens.yes_id === signal.token_id
              ? market.book.yes : market.book.no;
            const currentMid = book.mid;
            const signalMid = signal.target_price;
            actualValue = Math.abs(currentMid - signalMid);
            break;
          }

          case 'spread_widened': {
            if (!market) break;
            const side = market.tokens.yes_id === signal.token_id ? 'yes' : 'no';
            actualValue = market.book[side].spread_bps;
            break;
          }

          case 'book_thinned': {
            if (!market) break;
            const liqScore = market.liquidity_score;
            // Kill if liquidity drops BELOW threshold (inverted: actual < threshold)
            if (liqScore < kc.threshold) {
              const evAtKill = computeEvAtT(signal.decay_model, ageMs);
              killed.push({ signal, kill_condition: kc.type, threshold: kc.threshold, actual_value: liqScore, age_ms: ageMs, ev_at_kill: evAtKill });
              this.liveSignals.delete(signalId);
              this.ledger.append({
                type: 'signal_killed',
                data: { signal_id: signalId, strategy_id: signal.strategy_id, market_id: signal.market_id, kill_condition: kc.type, threshold: kc.threshold, actual_value: liqScore, age_ms: ageMs, ev_at_kill: evAtKill },
              });
              log.info({ signal_id: signalId, kill_condition: kc.type, actual: liqScore, threshold: kc.threshold }, 'Signal killed');
            }
            continue; // book_thinned uses inverted comparison
          }

          case 'regime_changed': {
            if (signal.regime_assumption !== '' && signal.regime_assumption !== world.regime.current_regime) {
              actualValue = 1; // binary: regime changed
              const evAtKill = computeEvAtT(signal.decay_model, ageMs);
              killed.push({ signal, kill_condition: kc.type, threshold: kc.threshold, actual_value: actualValue, age_ms: ageMs, ev_at_kill: evAtKill });
              this.liveSignals.delete(signalId);
              this.ledger.append({
                type: 'signal_killed',
                data: { signal_id: signalId, strategy_id: signal.strategy_id, market_id: signal.market_id, kill_condition: kc.type, threshold: kc.threshold, actual_value: actualValue, age_ms: ageMs, ev_at_kill: evAtKill },
              });
              log.info({ signal_id: signalId, kill_condition: kc.type, regime: world.regime.current_regime, assumed: signal.regime_assumption }, 'Signal killed');
            }
            continue; // regime_changed uses custom comparison
          }

          case 'ev_decayed': {
            actualValue = computeEvAtT(signal.decay_model, ageMs);
            // Kill if EV has decayed below threshold
            if (actualValue < kc.threshold) {
              killed.push({ signal, kill_condition: kc.type, threshold: kc.threshold, actual_value: actualValue, age_ms: ageMs, ev_at_kill: actualValue });
              this.liveSignals.delete(signalId);
              this.ledger.append({
                type: 'signal_killed',
                data: { signal_id: signalId, strategy_id: signal.strategy_id, market_id: signal.market_id, kill_condition: kc.type, threshold: kc.threshold, actual_value: actualValue, age_ms: ageMs, ev_at_kill: actualValue },
              });
              log.info({ signal_id: signalId, kill_condition: kc.type, ev_remaining: actualValue, threshold: kc.threshold }, 'Signal killed');
            }
            continue; // ev_decayed uses inverted comparison
          }
        }

        // Default comparison: kill if actual >= threshold (time_elapsed, price_moved, spread_widened)
        if (actualValue !== null && actualValue >= kc.threshold) {
          const evAtKill = computeEvAtT(signal.decay_model, ageMs);
          killed.push({ signal, kill_condition: kc.type, threshold: kc.threshold, actual_value: actualValue, age_ms: ageMs, ev_at_kill: evAtKill });
          this.liveSignals.delete(signalId);
          this.ledger.append({
            type: 'signal_killed',
            data: { signal_id: signalId, strategy_id: signal.strategy_id, market_id: signal.market_id, kill_condition: kc.type, threshold: kc.threshold, actual_value: actualValue, age_ms: ageMs, ev_at_kill: evAtKill },
          });
          log.info({ signal_id: signalId, kill_condition: kc.type, actual: actualValue, threshold: kc.threshold }, 'Signal killed');
          break; // first triggered condition kills the signal
        }
      }
    }

    return killed;
  }

  /**
   * Returns the number of live tracked signals.
   */
  liveSignalCount(): number {
    return this.liveSignals.size;
  }

  // -----------------------------------------------------------------------
  // Signal ID generation
  // -----------------------------------------------------------------------

  /**
   * Generates a unique signal ID. Strategies should call this when building
   * TradeSignal objects to ensure global uniqueness.
   */
  nextSignalId(strategyId: string): string {
    this.signalSeq++;
    return `${strategyId}_${now()}_${this.signalSeq}`;
  }

  // -----------------------------------------------------------------------
  // Engine-level signal filters
  // -----------------------------------------------------------------------

  private filterSignal(
    signal: TradeSignal,
    reg: StrategyRegistration,
    edge: EdgeMapEntry,
    world: WorldState,
    t: number,
  ): { reason: string; filter: string } | null {
    // 1. EV threshold
    if (signal.ev_after_costs < reg.config.min_ev_threshold) {
      return {
        reason: `ev_after_costs ${signal.ev_after_costs.toFixed(4)} < min ${reg.config.min_ev_threshold}`,
        filter: 'min_ev_threshold',
      };
    }

    // 2. Signal strength sanity (must be in [0, 1])
    if (signal.signal_strength <= 0 || signal.signal_strength > 1) {
      return {
        reason: `signal_strength ${signal.signal_strength} out of valid range (0, 1]`,
        filter: 'signal_strength_range',
      };
    }

    // 3. Size sanity
    if (signal.size_requested <= 0) {
      return {
        reason: `size_requested ${signal.size_requested} must be positive`,
        filter: 'size_positive',
      };
    }

    // 4. Max position size per strategy config
    if (signal.size_requested > reg.config.max_position_size) {
      return {
        reason: `size_requested ${signal.size_requested} exceeds max ${reg.config.max_position_size}`,
        filter: 'max_position_size',
      };
    }

    // 5. Deduplication: same strategy+market+direction within window
    const dedupKey = `${signal.strategy_id}:${signal.market_id}:${signal.direction}`;
    const dedupExpiry = this.recentSignals.get(dedupKey);
    if (dedupExpiry !== undefined && t < dedupExpiry) {
      return {
        reason: `Duplicate signal within ${DEDUP_WINDOW_MS}ms window`,
        filter: 'dedup',
      };
    }

    // 6. Regime consistency: signal's regime assumption must match current
    if (
      signal.regime_assumption !== '' &&
      signal.regime_assumption !== world.regime.current_regime
    ) {
      return {
        reason: `Signal assumes regime '${signal.regime_assumption}' but current is '${world.regime.current_regime}'`,
        filter: 'regime_mismatch',
      };
    }

    // 7. EV confidence interval: lower bound must not be catastrophically negative
    const [ciLow] = signal.ev_confidence_interval;
    if (ciLow < -0.10) {
      return {
        reason: `CI lower bound ${ciLow.toFixed(4)} is excessively negative`,
        filter: 'ci_lower_bound',
      };
    }

    // 8. Market still active (defensive — should be caught by eligibility)
    const market = world.markets.get(signal.market_id);
    if (!market || market.status !== 'active') {
      return {
        reason: `Market ${signal.market_id} is not active`,
        filter: 'market_inactive',
      };
    }

    // 9. Price sanity: target and max price in (0, 1) for prediction markets
    if (signal.target_price <= 0 || signal.target_price >= 1) {
      return {
        reason: `target_price ${signal.target_price} outside (0, 1)`,
        filter: 'price_range',
      };
    }
    if (signal.max_price <= 0 || signal.max_price >= 1) {
      return {
        reason: `max_price ${signal.max_price} outside (0, 1)`,
        filter: 'price_range',
      };
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Dedup helpers
  // -----------------------------------------------------------------------

  private recordDedup(signal: TradeSignal, t: number): void {
    const key = `${signal.strategy_id}:${signal.market_id}:${signal.direction}`;
    this.recentSignals.set(key, t + DEDUP_WINDOW_MS);
  }

  private cleanDedup(t: number): void {
    for (const [key, expiry] of this.recentSignals) {
      if (t >= expiry) {
        this.recentSignals.delete(key);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Position helpers
  // -----------------------------------------------------------------------

  private countActivePositions(world: WorldState, strategyId: string): number {
    let count = 0;
    for (const pos of world.own_positions.values()) {
      if (pos.strategy_id === strategyId) count++;
    }
    return count;
  }

  private getPositionsForMarket(world: WorldState, marketId: string): PositionState[] {
    const result: PositionState[] = [];
    for (const pos of world.own_positions.values()) {
      if (pos.market_id === marketId) result.push(pos);
    }
    return result;
  }

  // -----------------------------------------------------------------------
  // Config lookup
  // -----------------------------------------------------------------------

  private lookupConfig(strategyId: string): StrategyConfig | null {
    const strategies = config.strategies as unknown as Record<string, unknown>;
    const entry = strategies[strategyId];
    if (entry && typeof entry === 'object') {
      return entry as StrategyConfig;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helper: default disabled config for unrecognised strategies
// ---------------------------------------------------------------------------

function makeDisabledConfig(): StrategyConfig {
  return {
    enabled: false,
    paper_only: true,
    capital_allocation: 0,
    max_position_size: 0,
    min_ev_threshold: 1,
    max_concurrent_positions: 0,
    cooldown_after_loss_ms: 300_000,
    allowed_regimes: [],
    min_statistical_confidence_t: 2,
    max_parameter_sensitivity: 0.20,
    signal_half_life_ms: 60_000,
  };
}

// ---------------------------------------------------------------------------
// Utility: compute EV at time T given a decay model (convenience re-export)
// ---------------------------------------------------------------------------

/**
 * Computes the expected value of a signal at time T milliseconds after
 * generation, given exponential decay with the specified half-life.
 *
 * @deprecated Use `computeEvAtT` from ledger/types.ts (operates on DecayModel directly).
 */
export function evAtTime(ev0: number, halfLifeMs: number, tMs: number): number {
  return computeEvAtT({ half_life_ms: halfLifeMs, initial_ev: ev0 }, tMs);
}

// ---------------------------------------------------------------------------
// Kill condition check result
// ---------------------------------------------------------------------------

export interface KilledSignal {
  signal: TradeSignal;
  kill_condition: KillConditionType;
  threshold: number;
  actual_value: number;
  age_ms: number;
  ev_at_kill: number;
}
