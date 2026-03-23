// ---------------------------------------------------------------------------
// Worker Thread Message Protocol
//
// Plain serializable objects for postMessage between main thread and
// computation worker. No class instances or functions.
// ---------------------------------------------------------------------------

import type { ParsedBookSnapshot, ParsedTrade, WalletTransaction } from '../ingestion/types.js';
import type { MarketMetadata } from '../ingestion/types.js';
import type { TradeSignal } from '../ledger/types.js';

// ---------------------------------------------------------------------------
// Main → Worker messages
// ---------------------------------------------------------------------------

export interface InitMessage {
  type: 'init';
  config: {
    paper_mode: boolean;
    fee_rate: number;
    default_latency_ms: number;
    max_total_exposure_pct: number;
    features_dir: string;
    features_capture_interval_ms: number;
    tracked_wallets: string[];
    strategies: Record<string, unknown>;
  };
}

export interface MarketRegisteredMessage {
  type: 'market_registered';
  data: MarketMetadata;
}

export interface BookUpdateMessage {
  type: 'book_update';
  data: ParsedBookSnapshot;
}

/** Batched book updates — sent every FLUSH_INTERVAL_MS from main thread */
export interface BookUpdateBatchMessage {
  type: 'book_update_batch';
  data: ParsedBookSnapshot[];
}

export interface TradeMessage {
  type: 'trade';
  data: ParsedTrade;
}

export interface WalletTradeMessage {
  type: 'wallet_trade';
  data: WalletTransaction;
}

export interface MarketResolvedMessage {
  type: 'market_resolved';
  data: MarketMetadata;
}

/** Batch of historical wallet trades for bootstrapping delay curves */
export interface WalletTradeHistoryMessage {
  type: 'wallet_trade_history';
  data: WalletTransaction[];
}

/** Notify worker of tracked wallet list changes (hot-reload) */
export interface WalletListUpdateMessage {
  type: 'wallet_list_update';
  data: {
    added: string[];
    removed: string[];
  };
}

export type MainToWorkerMessage =
  | InitMessage
  | MarketRegisteredMessage
  | BookUpdateMessage
  | BookUpdateBatchMessage
  | TradeMessage
  | WalletTradeMessage
  | WalletTradeHistoryMessage
  | MarketResolvedMessage
  | WalletListUpdateMessage;

// ---------------------------------------------------------------------------
// Worker → Main messages
// ---------------------------------------------------------------------------

export interface SignalGeneratedMessage {
  type: 'signal_generated';
  data: TradeSignal;
}

export interface SignalFilteredMessage {
  type: 'signal_filtered';
  data: {
    signal_id: string;
    strategy_id: string;
    market_id: string;
    reason: string;
    filter: string;
  };
}

export interface WorkerDiagnosticsMessage {
  type: 'diagnostics';
  data: {
    strategy_ticks: number;
    markets_classified: number;
    markets_with_edge: number;
    markets_evaluated_last_tick: number;
    signals_generated_total: number;
    signals_filtered_total: number;
    consistency_violations: number;
    tick_elapsed_ms: number;
    state_markets: number;
    state_markets_with_books: number;
  };
}

export interface ClassificationDoneMessage {
  type: 'classification_done';
  data: {
    classified: number;
    markets_with_edge: number;
    reclassified: number;
  };
}

export interface WorkerReadyMessage {
  type: 'ready';
}

export type WorkerToMainMessage =
  | SignalGeneratedMessage
  | SignalFilteredMessage
  | WorkerDiagnosticsMessage
  | ClassificationDoneMessage
  | WorkerReadyMessage;
