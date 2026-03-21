// ---------------------------------------------------------------------------
// MODULE 5: LEDGER — Type Definitions
// ---------------------------------------------------------------------------

import type { PositionState } from '../state/types.js';

// ---------------------------------------------------------------------------
// Kill Condition (used in TradeSignal)
// ---------------------------------------------------------------------------

export type KillConditionType =
  | 'time_elapsed'
  | 'price_moved'
  | 'spread_widened'
  | 'book_thinned'
  | 'regime_changed'
  | 'ev_decayed';

export interface KillCondition {
  type: KillConditionType;
  threshold: number;
}

// ---------------------------------------------------------------------------
// Decay model — inlined in TradeSignal (serialisable form)
//
// The SPEC defines ev_at_t as a function, but since DecayModel must be
// JSON-serialisable for the ledger, we store the parameters and provide
// a companion pure function `computeEvAtT`.
// ---------------------------------------------------------------------------

export interface DecayModel {
  half_life_ms: number;
  initial_ev: number;
}

/**
 * Computes the expected value of a signal at time `tMs` milliseconds after
 * generation, given exponential decay with the specified half-life.
 *
 * ev(t) = initial_ev × 2^(-t / half_life)
 *       = initial_ev × e^(-ln2 × t / half_life)
 */
export function computeEvAtT(decay: DecayModel, tMs: number): number {
  if (decay.half_life_ms <= 0) return 0;
  if (tMs <= 0) return decay.initial_ev;
  return decay.initial_ev * Math.exp(-0.693147 * tMs / decay.half_life_ms);
}

// ---------------------------------------------------------------------------
// Trade Signal (Module 3 — defined here for ledger cross-referencing)
// ---------------------------------------------------------------------------

export interface TradeSignal {
  signal_id: string;
  strategy_id: string;
  timestamp: number;
  market_id: string;
  token_id: string;
  direction: 'BUY' | 'SELL';
  target_price: number;
  max_price: number;
  size_requested: number;
  urgency: 'immediate' | 'patient' | 'scheduled';
  ev_estimate: number;
  ev_confidence_interval: [number, number];
  ev_after_costs: number;
  signal_strength: number;
  expected_holding_period_ms: number;
  expected_sharpe_contribution: number;
  correlation_with_existing: number;
  reasoning: string;
  kill_conditions: KillCondition[];
  regime_assumption: string;
  decay_model: DecayModel;
}

// ---------------------------------------------------------------------------
// Execution Plan (Module 4)
// ---------------------------------------------------------------------------

export type ExecutionStrategyType =
  | 'immediate_cross'
  | 'aggressive_limit'
  | 'passive_limit'
  | 'iceberg'
  | 'scheduled';

export type SpreadRegime = 'tight' | 'normal' | 'wide';
export type LiquidityRegime = 'deep' | 'normal' | 'thin';
export type UrgencyRegime = 'decaying_fast' | 'stable' | 'improving';

export interface ExecutionPlan {
  signal_id: string;
  chosen_strategy: ExecutionStrategyType;
  reasoning: string;
  expected_fill_probability: number;
  expected_fill_price: number;
  expected_fill_time_ms: number;
  expected_cost_vs_mid: number;
  opportunity_cost_of_waiting: number;
  spread_regime: SpreadRegime;
  liquidity_regime: LiquidityRegime;
  urgency_regime: UrgencyRegime;
}

// ---------------------------------------------------------------------------
// Execution Record (Module 4)
// ---------------------------------------------------------------------------

export type ExecutionStatus = 'filled' | 'partial' | 'cancelled' | 'failed';

export interface ExecutionRecord {
  execution_id: string;
  signal_id: string;
  strategy_id: string;
  market_id: string;
  token_id: string;
  direction: 'BUY' | 'SELL';
  execution_strategy: string;
  // Timestamps (all ms)
  t0_signal_generated: number;
  t1_execution_plan_created: number;
  t2_order_submitted: number;
  t3_order_acknowledged: number;
  t4_first_fill: number;
  t5_final_fill: number;
  // Pre-trade estimates
  estimated_fill_price: number;
  estimated_fill_probability: number;
  estimated_cost_vs_mid: number;
  // Actual results
  price_at_signal: number;
  price_at_submission: number;
  fill_price: number;
  fill_prices: number[];
  slippage_vs_signal: number;
  slippage_vs_mid: number;
  slippage_vs_estimate: number;
  // Sizes
  size_requested: number;
  size_filled: number;
  partial: boolean;
  num_fills: number;
  num_cancels: number;
  num_reposts: number;
  // Costs
  fee_paid: number;
  gas_cost: number;
  total_cost: number;
  // Quality attribution
  implementation_shortfall: number;
  timing_cost: number;
  impact_cost: number;
  spread_cost: number;
  // Result
  status: ExecutionStatus;
  failure_reason: string | null;
}

// ---------------------------------------------------------------------------
// Position Close
// ---------------------------------------------------------------------------

export interface PositionClose {
  market_id: string;
  token_id: string;
  entry_price: number;
  exit_price: number;
  size: number;
  pnl_gross: number;
  pnl_net: number;
  holding_period_ms: number;
  strategy_id: string;
  signal_ev_at_entry: number;
  realized_ev: number;
  ev_estimation_error: number;
  execution_cost_realized: number;
  execution_cost_estimated: number;
}

// ---------------------------------------------------------------------------
// PnL Snapshot
// ---------------------------------------------------------------------------

export interface PnLSnapshot {
  timestamp: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_fees_paid: number;
  total_slippage_cost: number;
  total_implementation_shortfall: number;
  positions_open: number;
  capital_deployed: number;
  capital_available: number;
  portfolio_sharpe_rolling_7d: number;
  portfolio_sharpe_rolling_30d: number;
  per_strategy_pnl: Map<string, number>;
  regime: string;
}

// ---------------------------------------------------------------------------
// Portfolio Decision (Module 12)
// ---------------------------------------------------------------------------

export interface PortfolioSummary {
  total_exposure: number;
  per_strategy_exposure: Map<string, number>;
  per_cluster_exposure: Map<string, number>;
  portfolio_sharpe_estimate: number;
  diversification_ratio: number;
  drawdown_from_peak: number;
}

export type RebalanceActionType =
  | 'accept_signal'
  | 'reject_signal'
  | 'resize_signal'
  | 'close_position'
  | 'reduce_position';

export interface RebalanceAction {
  type: RebalanceActionType;
  details: object;
  reasoning: string;
}

export interface PortfolioDecision {
  timestamp: number;
  signals_received: string[];
  signals_accepted: string[];
  signals_rejected: { signal_id: string; reason: string }[];
  portfolio_state_before: PortfolioSummary;
  portfolio_state_after: PortfolioSummary;
  rebalance_actions: RebalanceAction[];
}

// ---------------------------------------------------------------------------
// Research types (Module 11) — referenced in ledger entries
// ---------------------------------------------------------------------------

export type HypothesisStatus =
  | 'registered'
  | 'collecting_data'
  | 'testing'
  | 'validated'
  | 'rejected'
  | 'promoted'
  | 'retired';

export type HypothesisCategory =
  | 'microstructure'
  | 'wallet_signal'
  | 'cross_market'
  | 'timing'
  | 'behavioral'
  | 'structural';

export type HypothesisConclusion =
  | 'significant_edge'
  | 'marginal_edge'
  | 'no_edge'
  | 'negative_edge'
  | 'insufficient_data';

export interface WalkForwardResult {
  period_index: number;
  training_start: string;
  training_end: string;
  test_start: string;
  test_end: string;
  training_sharpe: number;
  test_sharpe: number;
  test_pnl: number;
  test_trades: number;
  test_hit_rate: number;
  degradation: number;
}

export interface ParameterSensitivity {
  parameter: string;
  values_tested: number[];
  sharpe_at_each: number[];
  sensitivity: number;
  cliff_risk: boolean;
}

export interface HypothesisTestResult {
  hypothesis_id: string;
  tested_at: number;
  in_sample_sharpe: number;
  out_of_sample_sharpe: number;
  oos_degradation: number;
  t_statistic: number;
  p_value: number;
  effect_size: number;
  information_coefficient: number;
  hit_rate: number;
  avg_pnl_per_trade: number;
  avg_pnl_per_trade_after_costs: number;
  max_drawdown: number;
  parameter_sensitivity: ParameterSensitivity;
  regime_breakdown: Map<string, { sharpe: number; hit_rate: number; n_trades: number }>;
  walk_forward_results: WalkForwardResult[];
  conclusion: HypothesisConclusion;
}

export interface Hypothesis {
  id: string;
  created_at: number;
  author: 'system' | 'manual';
  category: HypothesisCategory;
  statement: string;
  required_features: string[];
  null_hypothesis: string;
  test_methodology: string;
  minimum_sample_size: number;
  significance_level: number;
  status: HypothesisStatus;
  results: HypothesisTestResult | null;
  promoted_to_strategy: string | null;
  rejected_reason: string | null;
}

export interface ExperimentResult {
  experiment_id: string;
  hypothesis_id: string;
  completed_at: number;
  conclusion: HypothesisConclusion;
  promoted: boolean;
}

// ---------------------------------------------------------------------------
// Ledger Entry — union of all recordable event types
// ---------------------------------------------------------------------------

export type LedgerEntry =
  | { type: 'signal_generated'; data: TradeSignal }
  | { type: 'signal_filtered'; data: { signal_id: string; reason: string; filter: string } }
  | { type: 'signal_killed'; data: { signal_id: string; strategy_id: string; market_id: string; kill_condition: KillConditionType; threshold: number; actual_value: number; age_ms: number; ev_at_kill: number } }
  | { type: 'portfolio_decision'; data: PortfolioDecision }
  | { type: 'execution_plan'; data: ExecutionPlan }
  | { type: 'order_submitted'; data: { signal_id: string; order_details: object } }
  | { type: 'order_filled'; data: ExecutionRecord }
  | { type: 'order_cancelled'; data: { signal_id: string; reason: string } }
  | { type: 'position_opened'; data: PositionState }
  | { type: 'position_closed'; data: PositionClose }
  | { type: 'pnl_snapshot'; data: PnLSnapshot }
  | { type: 'regime_change'; data: { from: string; to: string; confidence: number } }
  | { type: 'strategy_promoted'; data: { strategy_id: string; experiment_id: string } }
  | { type: 'strategy_retired'; data: { strategy_id: string; reason: string } }
  | { type: 'hypothesis_registered'; data: Hypothesis }
  | { type: 'experiment_result'; data: ExperimentResult }
  | { type: 'system_event'; data: { event: string; details: object } };

// ---------------------------------------------------------------------------
// Ledger Record — a LedgerEntry wrapped with sequence metadata
// ---------------------------------------------------------------------------

export interface LedgerRecord {
  seq_num: number;
  wall_clock: number;
  entry: LedgerEntry;
}
