// ---------------------------------------------------------------------------
// MODULE 11: ALPHA RESEARCH FACTORY — Type Definitions
//
// Core types live in ledger/types.ts (Hypothesis, HypothesisTestResult,
// HypothesisStatus, HypothesisCategory, HypothesisConclusion,
// WalkForwardResult, ParameterSensitivity, ExperimentResult) because
// the ledger records them. This file re-exports those and adds types
// that are research-internal: sweep configs, ablation, decay, walk-forward
// config.
// ---------------------------------------------------------------------------

import type { RegimeName } from '../state/types.js';

// Re-export ledger-defined research types for convenient single-import
export type {
  Hypothesis,
  HypothesisTestResult,
  HypothesisStatus,
  HypothesisCategory,
  HypothesisConclusion,
  WalkForwardResult,
  ParameterSensitivity,
  ExperimentResult,
} from '../ledger/types.js';

// ---------------------------------------------------------------------------
// Walk-Forward Configuration
// ---------------------------------------------------------------------------

export interface WalkForwardConfig {
  training_window_days: number;
  test_window_days: number;
  step_days: number;
  min_trades_per_window: number;
  total_periods: number;
}

// ---------------------------------------------------------------------------
// Parameter Sweep
// ---------------------------------------------------------------------------

export interface ParameterSweepEntry {
  sharpe: number;
  pnl: number;
  n_trades: number;
  hit_rate: number;
}

export interface ParameterSweep {
  hypothesis_id: string;
  parameter: string;
  values: number[];
  results: Map<number, ParameterSweepEntry>;
  optimal_value: number;
  sensitivity: number;
  cliff_risk: boolean;
}

// ---------------------------------------------------------------------------
// Ablation Study
// ---------------------------------------------------------------------------

export interface AblationFeatureResult {
  sharpe_without: number;
  sharpe_delta: number;
  is_critical: boolean;
}

export interface AblationResult {
  hypothesis_id: string;
  full_model_sharpe: number;
  ablations: Map<string, AblationFeatureResult>;
}

// ---------------------------------------------------------------------------
// Decay Monitor
// ---------------------------------------------------------------------------

export interface DecayMonitor {
  strategy_id: string;
  sharpe_timeseries: { timestamp: number; rolling_sharpe_7d: number }[];
  slope: number;
  slope_significance: number;
  estimated_halflife_days: number;
  estimated_zero_crossing_days: number;
  recommendation: 'healthy' | 'monitor' | 'reduce_allocation' | 'retire';
}

// ---------------------------------------------------------------------------
// Hypothesis Lifecycle Event (logged to ledger via system_event)
// ---------------------------------------------------------------------------

export interface HypothesisLifecycleEvent {
  hypothesis_id: string;
  from_status: string;
  to_status: string;
  reason: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Serialisable hypothesis (Maps → plain objects for JSON persistence)
// ---------------------------------------------------------------------------

export interface HypothesisTestResultSerialised {
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
  parameter_sensitivity: {
    parameter: string;
    values_tested: number[];
    sharpe_at_each: number[];
    sensitivity: number;
    cliff_risk: boolean;
  };
  regime_breakdown: Record<string, { sharpe: number; hit_rate: number; n_trades: number }>;
  walk_forward_results: {
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
  }[];
  conclusion: string;
}

export interface HypothesisSerialised {
  id: string;
  created_at: number;
  author: 'system' | 'manual';
  category: string;
  statement: string;
  required_features: string[];
  null_hypothesis: string;
  test_methodology: string;
  minimum_sample_size: number;
  significance_level: number;
  status: string;
  results: HypothesisTestResultSerialised | null;
  promoted_to_strategy: string | null;
  rejected_reason: string | null;
}
