// ---------------------------------------------------------------------------
// Wallet Intelligence — Type Definitions
// ---------------------------------------------------------------------------

import type { WalletClassification, WalletStats, RegimeName } from '../state/types.js';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export interface ClassificationResult {
  address: string;
  classification: WalletClassification;
  confidence: number;
  components: ClassificationComponents;
  statistical_significance: boolean;
  t_statistic: number;
  p_value: number;
  n_trades: number;
  bootstrap_ci: [number, number];
}

export interface ClassificationComponents {
  holding_period_score: number;
  return_quality_score: number;
  timing_regularity_score: number;
  market_concentration_hhi: number;
  trade_clustering_score: number;
  regime_consistency: number;
  sample_size_factor: number;
}

export interface TimingPattern {
  active_hours: number[];
  peak_hour: number;
  hour_concentration: number;
  active_days: number[];
  peak_day: number;
  day_concentration: number;
}

// ---------------------------------------------------------------------------
// Delay Analysis
// ---------------------------------------------------------------------------

export interface DelayBucketResult {
  delay_seconds: number;
  mean_pnl: number;
  ci_low: number;
  ci_high: number;
  t_statistic: number;
  p_value: number;
  n_trades: number;
  win_rate: number;
  information_ratio: number;
  significantly_positive: boolean;
}

export interface WalletDelayCurve {
  address: string;
  label: string;
  classification: WalletClassification;
  delay_buckets: DelayBucketResult[];
  optimal_delay_seconds: number | null;
  edge_halflife_seconds: number | null;
  breakeven_delay_seconds: number | null;
  followable_at_latency: boolean;
  recommendation: 'follow' | 'shadow_only' | 'ignore' | 'fade';
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface WalletScoreComponents {
  raw_profitability: number;
  delayed_profitability: number;
  consistency: number;
  statistical_significance: number;
  sample_size: number;
  recency: number;
  regime_robustness: number;
}

export interface FollowParameters {
  optimal_delay_ms: number;
  min_trade_size_to_follow: number;
  max_allocation_per_follow: number;
  allowed_market_types: string[];
  confidence_interval_90: [number, number];
}

export interface WalletScore {
  address: string;
  label: string;
  classification: WalletClassification;
  overall_score: number;
  components: WalletScoreComponents;
  recommendation: 'follow' | 'shadow_only' | 'ignore' | 'fade';
  follow_parameters: FollowParameters | null;
}

// ---------------------------------------------------------------------------
// Regime-Conditional Performance
// ---------------------------------------------------------------------------

export interface RegimePerformanceEntry {
  regime: RegimeName;
  stats: WalletStats;
  n_trades: number;
  sharpe: number;
  win_rate: number;
  pnl_realized: number;
  is_significant: boolean;
  t_statistic: number;
  p_value: number;
}

export interface WalletRegimeProfile {
  address: string;
  label: string;
  regime_entries: RegimePerformanceEntry[];
  best_regime: RegimeName | null;
  worst_regime: RegimeName | null;
  regime_sensitive: boolean;
  robustness_score: number;
}

// ---------------------------------------------------------------------------
// Price data
// ---------------------------------------------------------------------------

export interface PriceAtTime {
  timestamp: number;
  mid_price: number;
}

export interface PriceTimeseries {
  market_id: string;
  token_id: string;
  prices: PriceAtTime[];
}
