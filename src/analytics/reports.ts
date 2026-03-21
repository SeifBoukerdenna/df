import { now } from '../utils/time.js';
import type { WorldState } from '../state/world_state.js';
import type { IngestionMetrics } from '../ingestion/types.js';
import type { MarketClassifier } from './market_classifier.js';
import type { ConsistencyChecker } from './consistency_checker.js';
import type { PropagationModel, PairPropagationStats } from './propagation_model.js';
import type { ConsistencyCheck, EdgeMap, MarketClassification } from './types.js';

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
// Markets report
// ---------------------------------------------------------------------------

export interface MarketsReport {
  timestamp: number;
  markets_classified: number;
  markets_type1: number;
  markets_type2: number;
  markets_type3: number;
  avg_efficiency_score: number;
  classifications: Array<{
    market_id: string;
    question: string;
    market_type: number;
    efficiency_score: number;
    confidence: number;
    viable_strategies: string[];
    classified_at: number;
  }>;
}

/**
 * Builds a market classification report.
 * Called by `quant report markets`.
 */
export function reportMarkets(
  state: WorldState,
  classifier: MarketClassifier,
): MarketsReport {
  const t = now();
  const classifications = classifier.getAllClassifications();
  const allMarkets = state.getAllMarkets();
  const marketQuestions = new Map(allMarkets.map((m) => [m.market_id, m.question]));

  const sorted = Array.from(classifications.values()).sort(
    (a, b) => a.efficiency_score - b.efficiency_score,
  );

  const scores = sorted.map((c) => c.efficiency_score);
  const avgEfficiency = scores.length > 0 ? scores.reduce((s, v) => s + v, 0) / scores.length : 0;

  return {
    timestamp: t,
    markets_classified: sorted.length,
    markets_type1: sorted.filter((c) => c.market_type === 1).length,
    markets_type2: sorted.filter((c) => c.market_type === 2).length,
    markets_type3: sorted.filter((c) => c.market_type === 3).length,
    avg_efficiency_score: avgEfficiency,
    classifications: sorted.map((c) => ({
      market_id: c.market_id,
      question: marketQuestions.get(c.market_id) ?? '(unknown)',
      market_type: c.market_type,
      efficiency_score: c.efficiency_score,
      confidence: c.confidence,
      viable_strategies: c.viable_strategies,
      classified_at: c.classified_at,
    })),
  };
}

/**
 * Builds an edge map report.
 * Called by `quant report markets --edge-only`.
 */
export function reportMarketsEdgeOnly(
  classifier: MarketClassifier,
  totalCapital: number,
): EdgeMap {
  return classifier.buildEdgeMap(totalCapital);
}

// ---------------------------------------------------------------------------
// Wallets report
// ---------------------------------------------------------------------------

export interface WalletReportEntry {
  address: string;
  label: string;
  classification: string;
  confidence: number;
  total_trades: number;
  win_rate: number;
  pnl_realized: number;
  pnl_significance: number;
  sharpe_ratio: number;
  avg_trade_size_usd: number;
  avg_holding_period_seconds: number;
  trade_clustering_score: number;
  delayed_pnl_map: Record<string, number>;
}

export interface WalletsReport {
  timestamp: number;
  wallets_tracked: number;
  wallets_shown: number;
  sort_by: string;
  min_trades: number;
  wallets: WalletReportEntry[];
}

/**
 * Builds a wallet performance report.
 * Called by `quant report wallets`.
 */
export function reportWallets(
  state: WorldState,
  sortBy: string = 'pnl_realized',
  minTrades: number = 0,
): WalletsReport {
  const t = now();
  const allWallets = state.getAllWallets();

  const filtered = allWallets.filter((w) => w.stats.total_trades >= minTrades);

  const sorted = filtered.sort((a, b) => {
    switch (sortBy) {
      case 'delayed_pnl': {
        // Use best delayed PnL across all delay buckets
        const aDelayed = a.stats.profitable_after_delay.size > 0
          ? Math.max(...a.stats.profitable_after_delay.values())
          : a.stats.pnl_realized;
        const bDelayed = b.stats.profitable_after_delay.size > 0
          ? Math.max(...b.stats.profitable_after_delay.values())
          : b.stats.pnl_realized;
        return bDelayed - aDelayed;
      }
      case 'sharpe':
        return b.stats.sharpe_ratio - a.stats.sharpe_ratio;
      case 'win_rate':
        return b.stats.win_rate - a.stats.win_rate;
      case 'total_trades':
        return b.stats.total_trades - a.stats.total_trades;
      case 'pnl_realized':
      default:
        return b.stats.pnl_realized - a.stats.pnl_realized;
    }
  });

  const entries: WalletReportEntry[] = sorted.map((w) => {
    const delayedPnlMap: Record<string, number> = {};
    for (const [delayMs, pnl] of w.stats.profitable_after_delay) {
      delayedPnlMap[String(delayMs)] = pnl;
    }

    return {
      address: w.address,
      label: w.label,
      classification: w.classification,
      confidence: w.confidence,
      total_trades: w.stats.total_trades,
      win_rate: w.stats.win_rate,
      pnl_realized: w.stats.pnl_realized,
      pnl_significance: w.stats.pnl_significance,
      sharpe_ratio: w.stats.sharpe_ratio,
      avg_trade_size_usd: w.stats.avg_trade_size_usd,
      avg_holding_period_seconds: w.stats.avg_holding_period_seconds,
      trade_clustering_score: w.stats.trade_clustering_score,
      delayed_pnl_map: delayedPnlMap,
    };
  });

  return {
    timestamp: t,
    wallets_tracked: allWallets.length,
    wallets_shown: entries.length,
    sort_by: sortBy,
    min_trades: minTrades,
    wallets: entries,
  };
}

// ---------------------------------------------------------------------------
// Consistency report
// ---------------------------------------------------------------------------

/**
 * Builds a consistency violation report from a checker + current check results.
 * Called by `quant report consistency`.
 */
export function reportConsistency(
  checker: ConsistencyChecker,
  currentChecks: ConsistencyCheck[],
) {
  return checker.buildReport(currentChecks);
}

// ---------------------------------------------------------------------------
// Regime report
// ---------------------------------------------------------------------------

export interface RegimeReport {
  timestamp: number;
  current_regime: string;
  regime_since: number;
  regime_age_seconds: number;
  confidence: number;
  features: {
    avg_spread_z_score: number;
    volume_z_score: number;
    wallet_activity_z_score: number;
    resolution_rate: number;
    new_market_rate: number;
  };
  transition_matrix: Record<string, Record<string, number>>;
  duration_stats: Record<string, number>;
}

/**
 * Builds a regime state report.
 * Called by `quant report regime`.
 */
export function reportRegime(state: WorldState): RegimeReport {
  const t = now();
  const r = state.regime;
  const detector = state.regimeDetector;

  const rawMatrix = detector.getTransitionMatrix();
  const transitionMatrix: Record<string, Record<string, number>> = {};
  for (const [from, row] of rawMatrix.probabilities) {
    transitionMatrix[from] = {};
    for (const [to, prob] of row) {
      transitionMatrix[from]![to] = prob;
    }
  }

  const rawDurations = detector.getDurationStats();
  const durationStats: Record<string, number> = {};
  for (const [regime, avgMs] of rawDurations.avg_duration_ms) {
    durationStats[regime] = avgMs;
  }

  return {
    timestamp: t,
    current_regime: r.current_regime,
    regime_since: r.regime_since,
    regime_age_seconds: Math.round((t - r.regime_since) / 1000),
    confidence: r.confidence,
    features: r.features,
    transition_matrix: transitionMatrix,
    duration_stats: durationStats,
  };
}

// ---------------------------------------------------------------------------
// Propagation report
// ---------------------------------------------------------------------------

export interface PropagationReportSummary {
  timestamp: number;
  pairs_tracked: number;
  total_events: number;
  exploitable_pairs_count: number;
  top_exploitable: Array<{
    source_market_id: string;
    target_market_id: string;
    median_lag_ms: number;
    mean_efficiency: number;
    n_events: number;
    exploitable: boolean;
    estimated_execution_ms: number;
  }>;
  all_pairs: PairPropagationStats[];
}

/**
 * Builds a propagation model report.
 * Called by `quant report propagation`.
 */
export function reportPropagation(model: PropagationModel): PropagationReportSummary {
  const raw = model.buildReport();

  const topExploitable = raw.exploitable_pairs
    .sort((a, b) => b.median_lag_ms - a.median_lag_ms)
    .slice(0, 20)
    .map((p) => ({
      source_market_id: p.source_market_id,
      target_market_id: p.target_market_id,
      median_lag_ms: p.median_lag_ms,
      mean_efficiency: p.mean_efficiency,
      n_events: p.n_events,
      exploitable: p.exploitable,
      estimated_execution_ms: p.estimated_execution_ms,
    }));

  return {
    timestamp: raw.timestamp,
    pairs_tracked: raw.pairs_tracked,
    total_events: raw.total_events,
    exploitable_pairs_count: raw.exploitable_pairs.length,
    top_exploitable: topExploitable,
    all_pairs: raw.all_pairs,
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
