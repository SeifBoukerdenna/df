// ---------------------------------------------------------------------------
// Analytics — Type Definitions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Market Features — raw feature vector computed for every active market
// ---------------------------------------------------------------------------

export interface MarketFeatures {
  market_id: string;
  computed_at: number;

  // Spread characteristics
  spread_avg_abs: number;          // absolute average spread
  spread_avg_bps: number;          // average spread in basis points
  spread_cv: number;               // coefficient of variation (std/mean)
  spread_regime: 'tight' | 'normal' | 'wide';

  // Book dynamics
  avg_update_interval_ms: number;  // mean time between distinct book changes
  book_staleness_ms_avg: number;   // rolling average staleness
  bid_depth_1pct: number;          // total size within 1% of best bid
  ask_depth_1pct: number;
  bid_depth_5pct: number;
  ask_depth_5pct: number;
  depth_herfindahl_bid: number;    // Herfindahl across top 5 bid levels
  depth_herfindahl_ask: number;
  queue_depth_at_best_bid: number;
  queue_depth_at_best_ask: number;

  // Trade activity
  trade_rate_per_min: number;      // trades per minute (1h rolling)
  avg_trade_size_usd: number;
  trade_arrival_dispersion: number; // coefficient of dispersion (var/mean of inter-arrival)

  // Complement gap dynamics
  complement_gap_half_life_ms: number | null; // null until enough observations
  complement_gap_frequency_per_hour: number;
  complement_gap_median_size: number;

  // Participant structure
  wallet_concentration_hhi: number;
  dominant_wallet_address: string | null;  // address if >20% volume share
  dominant_wallet_share: number;
  bot_ratio: number;               // 0.0–1.0 estimated fraction automated

  // Latency sensitivity (populated by execution research, initially null)
  breakeven_latency_ms: number | null;
  edge_halflife_ms: number | null;
}

// ---------------------------------------------------------------------------
// Market Classification
// ---------------------------------------------------------------------------

export type MarketType = 1 | 2 | 3;

export interface MarketClassification {
  market_id: string;
  market_type: MarketType;
  confidence: number;              // 0–1 how clearly it fits the type
  efficiency_score: number;        // 0.0–1.0 (higher = more efficient = harder)
  viable_strategies: string[];     // strategy IDs eligible for this market
  classified_at: number;
  features: MarketFeatures;
}

// ---------------------------------------------------------------------------
// Reclassification event (for ledger logging)
// ---------------------------------------------------------------------------

export interface ReclassificationEvent {
  market_id: string;
  old_type: MarketType | null;
  new_type: MarketType;
  old_efficiency: number;
  new_efficiency: number;
  trigger: 'scheduled' | 'regime_change' | 'anomaly' | 'lifecycle' | 'latency_change';
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Edge Map — the core output of the market classifier
// ---------------------------------------------------------------------------

export interface EdgeMapEntry {
  market_id: string;
  market_type: MarketType;
  efficiency_score: number;
  viable_strategies: string[];
  estimated_edge_per_trade: number;
  estimated_edge_confidence: number;
  capital_allocated: number;
  breakeven_latency_ms: number | null;
}

export type EdgeRecommendation =
  | 'trade_actively'
  | 'trade_selectively'
  | 'reduce_exposure'
  | 'do_not_trade';

export interface EdgeMap {
  timestamp: number;
  measured_latency_p50_ms: number;
  markets_with_edge: EdgeMapEntry[];
  markets_without_edge: number;
  total_exploitable_capital: number;
  idle_capital: number;
  recommendation: EdgeRecommendation;
}

// ---------------------------------------------------------------------------
// Consistency check types (Module 14)
// ---------------------------------------------------------------------------

export type ConsistencyCheckType =
  | 'exhaustive_partition'
  | 'subset_superset'
  | 'conditional'
  | 'temporal';

export interface ConsistencyTradeLeg {
  market_id: string;
  token_id: string;
  direction: 'BUY' | 'SELL';
  size: number;
}

export interface ConsistencyTradePlan {
  legs: ConsistencyTradeLeg[];
  expected_profit: number;
  worst_case_loss: number;
  execution_risk: string;
}

export interface ConsistencyCheck {
  check_type: ConsistencyCheckType;
  markets_involved: string[];
  expected_relationship: string;
  actual_values: Map<string, number>;
  violation_magnitude: number;
  executable_violation: number;
  tradeable: boolean;
  trade_plan: ConsistencyTradePlan | null;
}
