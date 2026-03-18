// ---------------------------------------------------------------------------
// MODULE 1: INGESTION — Type Definitions
// ---------------------------------------------------------------------------

export interface BookSummary {
  mid: number;
  spread: number;
  best_bid: number;
  best_ask: number;
  bid_depth_5lvl: number;
  ask_depth_5lvl: number;
}

export interface ParsedTrade {
  market_id: string;
  condition_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  notional: number;
  maker: string;
  taker: string;
  tx_hash: string | null;
  timestamp: number;
  book_state_before: BookSummary | null;
}

export interface ParsedBookSnapshot {
  market_id: string;
  token_id: string;
  bids: [number, number][];
  asks: [number, number][];
  timestamp: number;
  mid_price: number;
  spread: number;
  spread_bps: number;
  bid_depth_1pct: number;
  ask_depth_1pct: number;
  bid_depth_5pct: number;
  ask_depth_5pct: number;
  vwap_bid_1000: number;
  vwap_ask_1000: number;
  queue_position_estimate: number;
}

export interface WalletTransaction {
  wallet: string;
  market_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  timestamp: number;
  tx_hash: string;
  block_number: number;
  gas_price: number;
}

export type ParsedEvent = ParsedTrade | ParsedBookSnapshot | WalletTransaction;

export interface RawEvent {
  source: 'clob_ws' | 'chain_listener' | 'rest_poll';
  type: 'trade' | 'order_placed' | 'order_cancelled' | 'book_snapshot' | 'wallet_tx';
  timestamp_ingested: number;
  timestamp_source: number | null;
  raw_payload: object;
  parsed: ParsedEvent;
  sequence_id: number;
}

// ---------------------------------------------------------------------------
// Market metadata fetched from REST API (used by MetadataFetcher and State)
// ---------------------------------------------------------------------------

export interface MarketTokens {
  yes_id: string;
  no_id: string;
}

export interface MarketMetadata {
  market_id: string;
  question: string;
  condition_id: string;
  tokens: MarketTokens;
  status: 'active' | 'paused' | 'resolved';
  resolution: 'YES' | 'NO' | null;
  end_date: string;
  category: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Ingestion instrumentation metrics (one set per source)
// ---------------------------------------------------------------------------

export interface IngestionSourceMetrics {
  source: string;
  events_received: number;
  events_per_second: number;
  duplicates_removed: number;
  parse_errors: number;
  gaps_detected: number;
  reconnect_count: number;
  stale_data_flags: number;
  last_event_at: number | null;
}

export interface IngestionMetrics {
  sources: Map<string, IngestionSourceMetrics>;
  ingestion_latency_ms_p50: number;
  ingestion_latency_ms_p99: number;
  total_events_24h: number;
  uptime_ms: number;
}
