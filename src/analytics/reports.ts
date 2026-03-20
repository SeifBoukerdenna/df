import { now } from '../utils/time.js';
import type { WorldState } from '../state/world_state.js';
import type { IngestionMetrics } from '../ingestion/types.js';

// ---------------------------------------------------------------------------
// Health report
// ---------------------------------------------------------------------------

export interface SourceHealthEntry {
  source: string;
  status: 'ok' | 'stale' | 'no_data';
  events_per_second: number;
  reconnect_count: number;
  duplicate_rate: number;
  parse_error_rate: number;
  last_event_age_ms: number | null;
}

export interface HealthReport {
  timestamp: number;
  uptime_seconds: number;
  regime: string;
  regime_confidence: number;
  markets_active: number;
  markets_stale: number; // staleness_ms > 5000
  markets_registered: number;
  sources: SourceHealthEntry[];
  ingestion_lag_p50_ms: number;
  ingestion_lag_p99_ms: number;
  system_ok: boolean;
}

/**
 * Builds a health report from current world state and ingestion metrics.
 * Called by `quant report health`.
 */
export function reportHealth(
  state: WorldState,
  metrics: IngestionMetrics,
  startedAt: number,
): HealthReport {
  const t = now();
  const allMarkets = state.getAllMarkets();
  const staleThresholdMs = 5_000;

  const staleCount = allMarkets.filter((m) => m.staleness_ms > staleThresholdMs).length;

  const sources: SourceHealthEntry[] = [];
  for (const [, src] of metrics.sources) {
    const lastEventAgeMs =
      src.last_event_at !== null ? t - src.last_event_at : null;

    const status: 'ok' | 'stale' | 'no_data' =
      src.last_event_at === null
        ? 'no_data'
        : lastEventAgeMs !== null && lastEventAgeMs > 30_000
          ? 'stale'
          : 'ok';

    const totalEvents = src.events_received;
    const duplicateRate =
      totalEvents > 0 ? src.duplicates_removed / totalEvents : 0;
    const parseErrorRate =
      totalEvents > 0 ? src.parse_errors / totalEvents : 0;

    sources.push({
      source: src.source,
      status,
      events_per_second: src.events_per_second,
      reconnect_count: src.reconnect_count,
      duplicate_rate: duplicateRate,
      parse_error_rate: parseErrorRate,
      last_event_age_ms: lastEventAgeMs,
    });
  }

  const systemOk =
    sources.every((s) => s.status !== 'stale') && staleCount === 0;

  return {
    timestamp: t,
    uptime_seconds: Math.round((t - startedAt) / 1000),
    regime: state.regime.current_regime,
    regime_confidence: state.regime.confidence,
    markets_active: allMarkets.filter((m) => m.status === 'active').length,
    markets_stale: staleCount,
    markets_registered: allMarkets.length,
    sources,
    ingestion_lag_p50_ms: metrics.ingestion_latency_ms_p50,
    ingestion_lag_p99_ms: metrics.ingestion_latency_ms_p99,
    system_ok: systemOk,
  };
}

// ---------------------------------------------------------------------------
// State report
// ---------------------------------------------------------------------------

export interface BookReport {
  mid: number;
  spread: number;
  spread_bps: number;
  best_bid: number | null;
  best_ask: number | null;
  imbalance: number;
  imbalance_weighted: number;
  microprice: number;
  depth_bid_l1: number;
  depth_ask_l1: number;
  liquidity_score: number;
  top_of_book_stability_ms: number;
}

export interface MarketReport {
  market_id: string;
  question: string;
  status: string;
  resolution: string | null;
  end_date: string;
  category: string;
  book_yes: BookReport;
  book_no: BookReport;
  last_trade_price_yes: number;
  last_trade_price_no: number;
  complement_gap: number;
  complement_gap_executable: number;
  volume_1h: number;
  volume_24h: number;
  trade_count_1h: number;
  liquidity_score: number;
  volatility_1h: number;
  autocorrelation_1m: number;
  staleness_ms: number;
  updated_at: number;
}

export interface PositionReport {
  market_id: string;
  token_id: string;
  side: string;
  size: number;
  avg_entry_price: number;
  current_mark: number;
  unrealized_pnl: number;
  strategy_id: string;
  signal_ev_at_entry: number;
  current_ev_estimate: number;
  time_in_position_ms: number;
}

export interface StateReport {
  timestamp: number;
  regime: string;
  regime_confidence: number;
  system_clock: number;
  markets_total: number;
  positions_open: number;
  wallets_tracked: number;
  markets: MarketReport[];
  positions: PositionReport[];
}

function bookToReport(book: WorldState['markets'] extends Map<string, infer V> ? V extends { book: { yes: infer B } } ? B : never : never): BookReport {
  return {
    mid: book.mid,
    spread: book.spread,
    spread_bps: book.spread_bps,
    best_bid: book.bids[0]?.[0] ?? null,
    best_ask: book.asks[0]?.[0] ?? null,
    imbalance: book.imbalance,
    imbalance_weighted: book.imbalance_weighted,
    microprice: book.microprice,
    depth_bid_l1: book.bids[0]?.[1] ?? 0,
    depth_ask_l1: book.asks[0]?.[1] ?? 0,
    liquidity_score: 0, // computed at market level
    top_of_book_stability_ms: book.top_of_book_stability_ms,
  };
}

/**
 * Builds a full or single-market state report.
 * Called by `quant report state` and `quant report state --market=<id>`.
 */
export function reportState(
  state: WorldState,
  marketId?: string,
): StateReport {
  const t = now();

  const marketsToReport = marketId
    ? state.getMarket(marketId)
      ? [state.getMarket(marketId)!]
      : []
    : state.getAllMarkets();

  const markets: MarketReport[] = marketsToReport.map((m) => {
    const yes = bookToReport(m.book.yes);
    const no = bookToReport(m.book.no);
    yes.liquidity_score = m.liquidity_score;
    no.liquidity_score = m.liquidity_score;

    return {
      market_id: m.market_id,
      question: m.question,
      status: m.status,
      resolution: m.resolution,
      end_date: m.end_date,
      category: m.category,
      book_yes: yes,
      book_no: no,
      last_trade_price_yes: m.last_trade_price.yes,
      last_trade_price_no: m.last_trade_price.no,
      complement_gap: m.complement_gap,
      complement_gap_executable: m.complement_gap_executable,
      volume_1h: m.volume_1h,
      volume_24h: m.volume_24h,
      trade_count_1h: m.trade_count_1h,
      liquidity_score: m.liquidity_score,
      volatility_1h: m.volatility_1h,
      autocorrelation_1m: m.autocorrelation_1m,
      staleness_ms: m.staleness_ms,
      updated_at: m.updated_at,
    };
  });

  const positions: PositionReport[] = Array.from(state.own_positions.values()).map((p) => ({
    market_id: p.market_id,
    token_id: p.token_id,
    side: p.side,
    size: p.size,
    avg_entry_price: p.avg_entry_price,
    current_mark: p.current_mark,
    unrealized_pnl: p.unrealized_pnl,
    strategy_id: p.strategy_id,
    signal_ev_at_entry: p.signal_ev_at_entry,
    current_ev_estimate: p.current_ev_estimate,
    time_in_position_ms: p.time_in_position_ms,
  }));

  return {
    timestamp: t,
    regime: state.regime.current_regime,
    regime_confidence: state.regime.confidence,
    system_clock: state.system_clock,
    markets_total: state.markets.size,
    positions_open: state.own_positions.size,
    wallets_tracked: state.wallets.size,
    markets,
    positions,
  };
}

// ---------------------------------------------------------------------------
// Formatting helper
// ---------------------------------------------------------------------------

/**
 * Pretty-prints a report object to the console.
 * Uses JSON.stringify with indentation for human-readable output.
 */
export function printReport(report: object, pretty: boolean = true): void {
  if (pretty) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(JSON.stringify(report) + '\n');
  }
}
