// ---------------------------------------------------------------------------
// MODULE 3: STRATEGY ENGINE — Type Definitions
//
// TradeSignal, KillCondition, and DecayModel are defined in ledger/types.ts
// (the ledger must serialize them). This file re-exports those and adds
// strategy-engine-specific types: the Strategy interface, engine context,
// engine output, and signal filtering records.
// ---------------------------------------------------------------------------

import type {
  WorldState,
  MarketState,
  RegimeName,
  PositionState,
} from '../state/types.js';
import type { EdgeMapEntry, EdgeMap, MarketClassification } from '../analytics/types.js';
import type { StrategyConfig } from '../utils/config.js';

// Re-export ledger-defined signal types for single-import convenience
export type {
  TradeSignal,
  KillCondition,
  KillConditionType,
  DecayModel,
} from '../ledger/types.js';

export { computeEvAtT } from '../ledger/types.js';

import type { TradeSignal } from '../ledger/types.js';

// ---------------------------------------------------------------------------
// Strategy interface — every strategy module implements this
// ---------------------------------------------------------------------------

/**
 * Context provided to a strategy when evaluating a single market.
 * Contains the full world state plus market-specific pre-computed data.
 */
export interface StrategyContext {
  /** Full world view. */
  world: WorldState;
  /** The specific market being evaluated. */
  market: MarketState;
  /** Market classifier output for this market. */
  classification: MarketClassification;
  /** EdgeMap entry for this market (capital budget, edge estimate). */
  edge: EdgeMapEntry;
  /** Existing positions in this market (may be empty). */
  existing_positions: PositionState[];
  /** Current regime name. */
  regime: RegimeName;
  /** Strategy-specific configuration from config/default.json. */
  config: StrategyConfig;
  /** Measured detection-to-order latency p50 in ms. */
  measured_latency_ms: number;
  /** Current timestamp (ms). */
  now: number;
}

/**
 * Every strategy module must export a class or object that satisfies this
 * interface. The engine calls `evaluate()` once per eligible market per
 * engine tick.
 */
export interface Strategy {
  /** Unique strategy identifier (must match config key and classifier ID). */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;

  /**
   * Evaluate one market and return zero or more trade signals.
   * The engine guarantees that `ctx.market` has already passed eligibility
   * (active status, classifier viability, regime allowlist).
   *
   * Return an empty array to indicate no signal for this market/tick.
   */
  evaluate(ctx: StrategyContext): TradeSignal[];
}

// ---------------------------------------------------------------------------
// Signal filter reasons
// ---------------------------------------------------------------------------

export interface FilteredSignal {
  signal_id: string;
  strategy_id: string;
  market_id: string;
  reason: string;
  filter: string;
}

// ---------------------------------------------------------------------------
// Engine tick output
// ---------------------------------------------------------------------------

export interface EngineTickResult {
  timestamp: number;
  regime: RegimeName;
  markets_evaluated: number;
  strategies_run: number;
  signals_generated: TradeSignal[];
  signals_filtered: FilteredSignal[];
  /** Total elapsed time for this tick (ms). */
  elapsed_ms: number;
}

// ---------------------------------------------------------------------------
// Strategy registration entry (internal to engine)
// ---------------------------------------------------------------------------

export interface StrategyRegistration {
  strategy: Strategy;
  config: StrategyConfig;
}
