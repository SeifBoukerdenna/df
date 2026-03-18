// ---------------------------------------------------------------------------
// MODULE 2: STATE — Type Definitions
// ---------------------------------------------------------------------------

import type { WalletTransaction } from '../ingestion/types.js';

// ---------------------------------------------------------------------------
// Order Book
// ---------------------------------------------------------------------------

export interface OrderBook {
  bids: [number, number][];
  asks: [number, number][];
  mid: number;
  spread: number;
  spread_bps: number;
  imbalance: number;
  imbalance_weighted: number;
  top_of_book_stability_ms: number;
  queue_depth_at_best: number;
  microprice: number;
  last_updated: number;
}

// ---------------------------------------------------------------------------
// Market State
// ---------------------------------------------------------------------------

export interface MarketBooks {
  yes: OrderBook;
  no: OrderBook;
}

export interface LastTradePrice {
  yes: number;
  no: number;
}

export interface MarketState {
  market_id: string;
  question: string;
  condition_id: string;
  tokens: { yes_id: string; no_id: string };
  status: 'active' | 'paused' | 'resolved';
  resolution: 'YES' | 'NO' | null;
  end_date: string;
  category: string;
  tags: string[];
  book: MarketBooks;
  last_trade_price: LastTradePrice;
  volume_24h: number;
  volume_1h: number;
  trade_count_1h: number;
  liquidity_score: number;
  complement_gap: number;
  complement_gap_executable: number;
  staleness_ms: number;
  volatility_1h: number;
  autocorrelation_1m: number;
  related_markets: string[];
  event_cluster_id: string | null;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Wallet State
// ---------------------------------------------------------------------------

export type WalletClassification =
  | 'sniper'
  | 'arbitrageur'
  | 'swing'
  | 'market_maker'
  | 'noise'
  | 'unclassified';

export interface WalletStats {
  total_trades: number;
  win_rate: number;
  avg_holding_period_seconds: number;
  median_holding_period_seconds: number;
  avg_trade_size_usd: number;
  pnl_realized: number;
  pnl_unrealized: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  calmar_ratio: number;
  max_drawdown: number;
  avg_entry_delay_from_event: number | null;
  preferred_markets: string[];
  active_hours: number[];
  profitable_after_delay: Map<number, number>;
  pnl_significance: number;
  consecutive_loss_max: number;
  trade_clustering_score: number;
}

export interface WalletState {
  address: string;
  label: string;
  classification: WalletClassification;
  confidence: number;
  trades: WalletTransaction[];
  stats: WalletStats;
  regime_performance: Map<string, WalletStats>;
}

// ---------------------------------------------------------------------------
// Position State
// ---------------------------------------------------------------------------

export interface PositionState {
  market_id: string;
  token_id: string;
  side: 'YES' | 'NO';
  size: number;
  avg_entry_price: number;
  current_mark: number;
  unrealized_pnl: number;
  opened_at: number;
  strategy_id: string;
  signal_ev_at_entry: number;
  current_ev_estimate: number;
  time_in_position_ms: number;
  max_favorable_excursion: number;
  max_adverse_excursion: number;
}

// ---------------------------------------------------------------------------
// Market Graph
// ---------------------------------------------------------------------------

export type MarketRelationshipType =
  | 'same_event'
  | 'complementary'
  | 'correlated'
  | 'causal'
  | 'semantic';

export interface MarketRelationship {
  target_market_id: string;
  relationship: MarketRelationshipType;
  strength: number;
  price_correlation: number;
  staleness_propagation_lag_ms: number;
}

export interface MarketCluster {
  cluster_id: string;
  market_ids: string[];
  event_description: string;
  consistency_score: number;
  consistency_violation: number;
  last_checked: number;
}

export interface MarketGraph {
  edges: Map<string, MarketRelationship[]>;
  clusters: MarketCluster[];
}

// ---------------------------------------------------------------------------
// Regime State
// ---------------------------------------------------------------------------

export type RegimeName =
  | 'normal'
  | 'high_volatility'
  | 'low_liquidity'
  | 'event_driven'
  | 'resolution_clustering';

export interface RegimeFeatures {
  avg_spread_z_score: number;
  volume_z_score: number;
  wallet_activity_z_score: number;
  resolution_rate: number;
  new_market_rate: number;
}

export interface RegimeState {
  current_regime: RegimeName;
  regime_since: number;
  confidence: number;
  features: RegimeFeatures;
}

// ---------------------------------------------------------------------------
// World State — single source of truth for current world view
// ---------------------------------------------------------------------------

export interface WorldState {
  markets: Map<string, MarketState>;
  wallets: Map<string, WalletState>;
  own_positions: Map<string, PositionState>;
  market_graph: MarketGraph;
  regime: RegimeState;
  system_clock: number;
}
