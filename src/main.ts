/**
 * Entry point for the Polymarket Quantitative Trading Platform.
 *
 * Architecture (multi-threaded):
 *   Main thread:  Ingestion (WS, REST, metadata) — never blocked by computation
 *   Worker thread: Strategy engine, classification, consistency, features
 *
 * Communication: Main → Worker (events), Worker → Main (signals)
 * Book updates are batched (500ms flush) to avoid message port saturation.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { program } from 'commander';
import { config as cfg } from './utils/config.js';
import type { Config } from './utils/config.js';
import { getLogger } from './utils/logger.js';
import { now } from './utils/time.js';
import { WorldState } from './state/world_state.js';
import { Ledger } from './ledger/ledger.js';
import { ClobWebSocket } from './ingestion/clob_websocket.js';
import { BookPoller } from './ingestion/book_poller.js';
import { MarketMetadataFetcher } from './ingestion/market_metadata.js';
import { WalletListener } from './ingestion/wallet_listener.js';
import {
  reportHealth,
  reportState,
  reportMarkets,
  reportMarketsEdgeOnly,
  reportWallets,
  reportConsistency,
  reportRegime,
  reportPropagation,
  printReport,
} from './analytics/reports.js';
import {
  reportCounterfactual,
  reportViability,
} from './counterfactual/shadow_engine.js';
import {
  reportAttribution,
  parsePeriod,
} from './counterfactual/attribution.js';
import { MarketClassifier } from './analytics/market_classifier.js';
import { ConsistencyChecker } from './analytics/consistency_checker.js';
import { PropagationModel } from './analytics/propagation_model.js';
import { paperExecute } from './execution/executor.js';
import { Reconciliation } from './execution/reconciliation.js';
import type { IngestionMetrics, ParsedTrade, ParsedBookSnapshot } from './ingestion/types.js';
import type { MainToWorkerMessage, WorkerToMainMessage } from './workers/messages.js';

const log = getLogger('main');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

program
  .name('quant')
  .description('Polymarket Quantitative Trading Platform')
  .version('1.0.0');

const reportCmd = program.command('report').description('Generate system reports');

reportCmd
  .command('health')
  .description('System health report: sources, latency, regime, market staleness')
  .option('--json', 'Output raw JSON (default: pretty-printed)', false)
  .action(async (opts: { json: boolean }) => {
    const config = cfg;
    const state = await loadOrCreateState(config);
    const metrics = buildEmptyMetrics();

    const report = reportHealth(state, metrics, now());
    printReport(report, !opts.json);
  });

reportCmd
  .command('state')
  .description('Full world state: markets, books, positions')
  .option('--json', 'Output raw JSON (default: pretty-printed)', false)
  .option('--market <id>', 'Filter to a specific market ID')
  .action(async (opts: { json: boolean; market?: string }) => {
    const config = cfg;
    const state = await loadOrCreateState(config);

    const report = reportState(state, opts.market);
    printReport(report, !opts.json);
  });

reportCmd
  .command('markets')
  .description('Market classification report (Type 1/2/3, efficiency, viable strategies)')
  .option('--json', 'Output raw JSON', false)
  .option('--edge-only', 'Show EdgeMap only (capital allocation per market)', false)
  .action(async (opts: { json: boolean; edgeOnly: boolean }) => {
    const config = cfg;
    const state = await loadOrCreateState(config);
    const classifier = new MarketClassifier(config.strategies.wallet_follow['default_latency_ms'] as number ?? 2000);
    classifier.classifyAll(state.markets, 'scheduled');

    if (opts.edgeOnly) {
      const edgeMap = reportMarketsEdgeOnly(classifier, 10_000);
      printReport(edgeMap, !opts.json);
    } else {
      const report = reportMarkets(state, classifier);
      printReport(report, !opts.json);
    }
  });

reportCmd
  .command('wallets')
  .description('Wallet performance analysis with PnL, Sharpe, and delay curves')
  .option('--json', 'Output raw JSON', false)
  .option('--sort <field>', 'Sort by: pnl_realized | delayed_pnl | sharpe | win_rate | total_trades', 'pnl_realized')
  .option('--min-trades <n>', 'Minimum trade count to include', '0')
  .action(async (opts: { json: boolean; sort: string; minTrades: string }) => {
    const config = cfg;
    const state = await loadOrCreateState(config);
    const report = reportWallets(state, opts.sort, parseInt(opts.minTrades, 10));
    printReport(report, !opts.json);
  });

reportCmd
  .command('consistency')
  .description('Cross-market probability consistency violations')
  .option('--json', 'Output raw JSON', false)
  .action(async (opts: { json: boolean }) => {
    const config = cfg;
    const state = await loadOrCreateState(config);
    const checker = new ConsistencyChecker(config.polymarket.fee_rate);
    const checks = checker.checkAll(state.markets, state.market_graph);
    const report = reportConsistency(checker, checks);
    printReport(report, !opts.json);
  });

reportCmd
  .command('regime')
  .description('Current market regime, features, transition matrix, and duration stats')
  .option('--json', 'Output raw JSON', false)
  .action(async (opts: { json: boolean }) => {
    const config = cfg;
    const state = await loadOrCreateState(config);
    const report = reportRegime(state);
    printReport(report, !opts.json);
  });

reportCmd
  .command('propagation')
  .description('Stale-price propagation pairs sorted by exploitable lag')
  .option('--json', 'Output raw JSON', false)
  .action(async (opts: { json: boolean }) => {
    const config = cfg;
    const propagationModel = new PropagationModel(
      config.strategies.wallet_follow['default_latency_ms'] as number ?? 2000,
    );
    const report = reportPropagation(propagationModel);
    printReport(report, !opts.json);
  });

reportCmd
  .command('counterfactual')
  .description('Counterfactual PnL analysis per strategy: ideal vs actual, cost decomposition')
  .option('--json', 'Output raw JSON', false)
  .option('--strategy <id>', 'Filter to a specific strategy ID')
  .action(async (opts: { json: boolean; strategy?: string }) => {
    if (opts.strategy) {
      const report = reportCounterfactual(opts.strategy);
      printReport(report, !opts.json);
    } else {
      // Report all strategies that have records
      const allReports = [
        'wallet_follow', 'complement_arb', 'book_imbalance',
        'large_trade_reaction', 'stale_book', 'cross_market_consistency',
        'microprice_dislocation',
      ].map(sid => reportCounterfactual(sid))
        .filter(r => r.total_signals > 0);
      printReport(allReports, !opts.json);
    }
  });

reportCmd
  .command('viability')
  .description('Signal viability at different latencies per strategy')
  .option('--json', 'Output raw JSON', false)
  .option('--strategy <id>', 'Filter to a specific strategy ID')
  .action(async (opts: { json: boolean; strategy?: string }) => {
    const report = reportViability(opts.strategy);
    printReport(report, !opts.json);
  });

reportCmd
  .command('attribution')
  .description('Signal vs execution attribution per strategy per time period')
  .option('--json', 'Output raw JSON', false)
  .option('--period <period>', 'Time period: 1d, 7d, 14d, 30d', '7d')
  .option('--strategy <id>', 'Filter to a specific strategy ID')
  .action(async (opts: { json: boolean; period: string; strategy?: string }) => {
    const periodMs = parsePeriod(opts.period);
    const { now: nowFn } = await import('./utils/time.js');
    const report = reportAttribution(periodMs, nowFn(), opts.strategy);
    printReport(report, !opts.json);
  });

reportCmd
  .command('pnl')
  .description('PnL report with statistical significance per strategy')
  .option('--json', 'Output raw JSON', false)
  .option('--period <period>', 'Time period: 1h, 6h, 12h, 24h, 7d, 30d', '24h')
  .option('--by <group>', 'Group by: strategy', 'strategy')
  .option('--significance', 'Show only significant strategies (p < 0.05)', false)
  .action(async (opts: { json: boolean; period: string; by: string; significance: boolean }) => {
    // PnL report requires a running reconciliation engine — report from ledger replay
    printReport({
      note: 'PnL report available during live run. Start the system with `quant start` and use the report endpoint.',
      period: opts.period,
      group_by: opts.by,
      significance_filter: opts.significance,
    }, !opts.json);
  });

reportCmd
  .command('positions')
  .description('Open paper positions with unrealized PnL')
  .option('--json', 'Output raw JSON', false)
  .option('--show-ev', 'Show signal EV estimates', false)
  .action(async (opts: { json: boolean; showEv: boolean }) => {
    printReport({
      note: 'Positions report available during live run. Start the system with `quant start`.',
      show_ev: opts.showEv,
    }, !opts.json);
  });

// ---------------------------------------------------------------------------
// Daemon command (default: runs the full system)
// ---------------------------------------------------------------------------

program
  .command('start', { isDefault: true })
  .description('Start the trading system')
  .action(async () => {
    await runSystem();
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  log.error({ err }, 'Fatal error');
  process.exit(1);
});

// ---------------------------------------------------------------------------
// System startup
// ---------------------------------------------------------------------------

async function runSystem(): Promise<void> {
  const config = cfg;
  const startedAt = now();

  log.info({ paper_mode: config.paper_mode, threaded: true }, 'Starting Polymarket Quant Platform');

  // Core components (main thread: ingestion + lightweight state for WS book sync)
  const state = new WorldState();
  const ledger = new Ledger(config.ledger.dir);
  const reconciliation = new Reconciliation(ledger);

  // ---------------------------------------------------------------------------
  // Computation Worker Thread
  // ---------------------------------------------------------------------------

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const workerPath = join(__dirname, 'workers', 'computation_worker.js');

  const worker = new Worker(workerPath);

  // Worker message helper with type safety
  function sendToWorker(msg: MainToWorkerMessage): void {
    worker.postMessage(msg);
  }

  // Book update batching: collect snapshots and flush every 500ms to avoid
  // saturating the worker's message port with 1500+ individual messages/sec.
  const FLUSH_INTERVAL_MS = 500;
  let pendingBookUpdates: ParsedBookSnapshot[] = [];

  const flushTimer = setInterval(() => {
    if (pendingBookUpdates.length > 0) {
      sendToWorker({ type: 'book_update_batch', data: pendingBookUpdates });
      pendingBookUpdates = [];
    }
  }, FLUSH_INTERVAL_MS);

  // Initialize worker with config
  sendToWorker({
    type: 'init',
    config: {
      paper_mode: config.paper_mode,
      fee_rate: config.polymarket.fee_rate,
      default_latency_ms: config.strategies.wallet_follow['default_latency_ms'] as number ?? 2000,
      max_total_exposure_pct: config.risk.max_total_exposure_pct,
      features_dir: config.features.dir,
      features_capture_interval_ms: config.features.capture_interval_ms,
      tracked_wallets: config.wallet_intel.tracked_wallets,
      strategies: config.strategies as unknown as Record<string, unknown>,
    },
  });

  // Handle worker messages (signals, diagnostics)
  let workerStrategyTicks = 0;
  let workerSignalsTotal = 0;
  let workerMarketsWithEdge = 0;
  worker.on('message', (msg: WorkerToMainMessage) => {
    switch (msg.type) {
      case 'ready':
        log.info('Computation worker ready');
        break;

      case 'signal_generated':
        workerSignalsTotal++;
        log.info(
          {
            signal_id: msg.data.signal_id,
            strategy: msg.data.strategy_id,
            market: msg.data.market_id,
            direction: msg.data.direction,
            ev: msg.data.ev_estimate,
          },
          'Signal received from worker',
        );

        // Paper execution on main thread (needs live state for fill simulation)
        if (config.paper_mode) {
          try {
            const fillResult = paperExecute(msg.data, state, ledger, {
              fee_rate: config.polymarket.fee_rate,
              paper_mode: true,
            });
            if (fillResult.filled) {
              reconciliation.openPosition(fillResult.execution, msg.data.ev_estimate);
            }
          } catch (err) {
            log.warn({ err, signal_id: msg.data.signal_id }, 'Paper execution failed');
          }
        }
        break;

      case 'signal_filtered':
        // Already logged to ledger by worker
        break;

      case 'classification_done':
        workerMarketsWithEdge = msg.data.markets_with_edge;
        log.info(msg.data, 'Classification complete (worker)');
        break;

      case 'diagnostics':
        workerStrategyTicks = msg.data.strategy_ticks;
        break;
    }
  });

  worker.on('error', (err) => {
    log.error({ err }, 'Computation worker error');
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      log.error({ code }, 'Computation worker exited unexpectedly');
    }
  });

  // ---------------------------------------------------------------------------
  // Ingestion components (main thread only — never blocked by computation)
  // ---------------------------------------------------------------------------

  const metadataFetcher = new MarketMetadataFetcher(
    config.polymarket.gamma_url,
    config.ingestion.metadata_poll_interval_ms,
    {
      minLiquidity: config.ingestion.min_market_liquidity,
      maxMarkets: config.ingestion.max_markets,
    },
  );

  const bookPoller = new BookPoller(
    config.polymarket.rest_url,
    config.ingestion.book_poll_interval_ms,
    config.ingestion.stale_data_threshold_ms,
  );

  const clobWs = new ClobWebSocket({
    wsUrl: config.polymarket.clob_ws_url,
    reconnectBaseMs: config.ingestion.ws_reconnect_base_ms,
    reconnectMaxMs: config.ingestion.ws_reconnect_max_ms,
    dedupTtlMs: config.ingestion.dedup_cache_ttl_ms,
    rawEventsDir: config.ingestion.raw_events_dir,
  });

  const walletListener = new WalletListener({
    rpcUrl: config.polymarket.rpc_url,
    trackedWallets: config.wallet_intel.tracked_wallets,
    rawEventsDir: config.ingestion.raw_events_dir,
    reconnectBaseMs: config.ingestion.ws_reconnect_base_ms,
    reconnectMaxMs: config.ingestion.ws_reconnect_max_ms,
  });

  // Token ID → market_id index for O(1) lookups
  const tokenToMarketId = new Map<string, string>();

  // Recent CLOB trades buffer for enriching wallet transactions
  const recentClobTrades: ParsedTrade[] = [];
  const MAX_RECENT_TRADES = 500;

  // ---------------------------------------------------------------------------
  // Event wiring: Ingestion → State (local) + Worker (forwarded)
  // ---------------------------------------------------------------------------

  metadataFetcher.on('market_created', (meta) => {
    // Local state (for book sync, wallet resolution, state snapshots)
    state.registerMarket(meta);

    // Token registration
    const tokenIds: string[] = [];
    if (meta.tokens.yes_id) {
      bookPoller.addToken(meta.tokens.yes_id, meta.market_id);
      tokenIds.push(meta.tokens.yes_id);
      tokenToMarketId.set(meta.tokens.yes_id, meta.market_id);
    }
    if (meta.tokens.no_id) {
      bookPoller.addToken(meta.tokens.no_id, meta.market_id);
      tokenIds.push(meta.tokens.no_id);
      tokenToMarketId.set(meta.tokens.no_id, meta.market_id);
    }

    if (tokenIds.length > 0) {
      clobWs.subscribeAssets(tokenIds);
    }

    // Forward to worker
    sendToWorker({ type: 'market_registered', data: meta });

    ledger.append({ type: 'system_event', data: { event: 'market_created', details: meta } });
    log.info({ market_id: meta.market_id, question: meta.question }, 'Market registered');
  });

  metadataFetcher.on('market_resolved', (meta) => {
    sendToWorker({ type: 'market_resolved', data: meta });
    ledger.append({ type: 'system_event', data: { event: 'market_resolved', details: meta } });
    log.info({ market_id: meta.market_id, resolution: meta.resolution }, 'Market resolved');
  });

  // Book snapshots from REST poller → local state + batch to worker
  bookPoller.on('book_snapshot', (snapshot) => {
    const marketId = tokenToMarketId.get(snapshot.token_id);
    if (marketId) {
      snapshot.market_id = marketId;
      state.updateMarket(snapshot);
      clobWs.updateBookSnapshot(snapshot);
      pendingBookUpdates.push(snapshot);
    }
  });

  // Book snapshots from WebSocket → local state + batch to worker
  clobWs.on('book_snapshot', (snapshot) => {
    const marketId = tokenToMarketId.get(snapshot.token_id);
    if (marketId) {
      snapshot.market_id = marketId;
      state.updateMarket(snapshot);
      pendingBookUpdates.push(snapshot);
    }
  });

  // Trades from WebSocket → local state + forward to worker
  clobWs.on('trade', (trade) => {
    const marketId = tokenToMarketId.get(trade.token_id);
    if (marketId) {
      trade.market_id = marketId;
      state.updateMarketFromTrade(trade);
      sendToWorker({ type: 'trade', data: trade });
    }

    recentClobTrades.push(trade);
    if (recentClobTrades.length > MAX_RECENT_TRADES) {
      recentClobTrades.splice(0, recentClobTrades.length - MAX_RECENT_TRADES);
    }
  });

  // Wallet trades → local enrichment + forward to worker
  walletListener.on('wallet_trade', (tx) => {
    const resolved = state.resolveWalletTradeMarket(tx);
    if (!resolved) return;

    const enriched = state.enrichWalletTradePrice(resolved, recentClobTrades);
    state.recordWalletTradeWithRegime(enriched);
    sendToWorker({ type: 'wallet_trade', data: enriched });

    ledger.append({
      type: 'system_event',
      data: {
        event: 'wallet_trade',
        details: {
          wallet: enriched.wallet.slice(0, 10),
          market_id: enriched.market_id,
          side: enriched.side,
          size: enriched.size,
          price: enriched.price,
          block: enriched.block_number,
        },
      },
    });
  });

  // Error handlers
  clobWs.on('error', (err) => log.warn({ err }, 'ClobWebSocket error'));
  bookPoller.on('error', (err, tokenId) => log.warn({ err, tokenId }, 'BookPoller error'));
  metadataFetcher.on('error', (err) => log.warn({ err }, 'MetadataFetcher error'));
  walletListener.on('error', (err) => log.warn({ err }, 'WalletListener error'));

  // ---------------------------------------------------------------------------
  // State snapshots (main thread, every 5 min)
  // ---------------------------------------------------------------------------

  const snapshotInterval = setInterval(() => {
    try {
      const snapshotFile = `${config.state.snapshots_dir}/state-${Date.now()}.json`;
      state.saveToDisk(snapshotFile);
    } catch (err) {
      log.warn({ err }, 'Failed to save state snapshot');
    }
  }, config.state.snapshot_interval_ms);
  snapshotInterval.unref();

  // ---------------------------------------------------------------------------
  // Mark-to-market: update position PnL every 10s (main thread, needs state)
  // ---------------------------------------------------------------------------

  const mtmInterval = setInterval(() => {
    try {
      reconciliation.markToMarket(state);
    } catch (err) {
      log.warn({ err }, 'Mark-to-market failed');
    }
  }, 10_000);
  mtmInterval.unref();

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'Shutting down...');

    clobWs.stop();
    bookPoller.stop();
    metadataFetcher.stop();
    walletListener.stop();

    clearInterval(flushTimer);
    clearInterval(snapshotInterval);
    clearInterval(mtmInterval);

    // Terminate worker
    worker.terminate().catch(() => {});

    try {
      const snapshotFile = `${config.state.snapshots_dir}/state-${Date.now()}.json`;
      state.saveToDisk(snapshotFile);
      log.info('Final state snapshot saved');
    } catch (err) {
      log.warn({ err }, 'Failed to save final state snapshot');
    }

    const uptime = Math.round((now() - startedAt) / 1000);
    log.info({ uptime_seconds: uptime }, 'Shutdown complete');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // ---------------------------------------------------------------------------
  // Start ingestion
  // ---------------------------------------------------------------------------

  metadataFetcher.start();
  bookPoller.start();
  clobWs.start();
  walletListener.start();

  // ---------------------------------------------------------------------------
  // Periodic diagnostics (every 30s for first 5 minutes)
  // ---------------------------------------------------------------------------

  let diagCount = 0;
  const diagInterval = setInterval(() => {
    diagCount++;
    const markets = state.getAllMarkets();
    const marketsWithBooks = markets.filter(m =>
      m.book.yes.mid > 0 || m.book.no.mid > 0,
    ).length;
    const marketsWithTrades = markets.filter(m =>
      m.last_trade_price.yes > 0 || m.last_trade_price.no > 0,
    ).length;

    log.info({
      total_markets: markets.length,
      markets_with_books: marketsWithBooks,
      markets_with_trades: marketsWithTrades,
      clob_ws_events: clobWs.metrics.events_received,
      clob_ws_eps: Math.round(clobWs.metrics.events_per_second * 100) / 100,
      // Worker stats
      worker_strategy_ticks: workerStrategyTicks,
      worker_signals_total: workerSignalsTotal,
      worker_markets_with_edge: workerMarketsWithEdge,
      open_positions: reconciliation.getOpenPositions().length,
    }, 'Data flow diagnostics');

    if (diagCount >= 10) {
      clearInterval(diagInterval);
    }
  }, 30_000);
  diagInterval.unref();

  log.info('Main thread: ingestion started. Worker thread: computation started.');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadOrCreateState(config: Config): Promise<WorldState> {
  const state = new WorldState();
  try {
    state.loadFromDisk(config.state.snapshots_dir);
  } catch {
    // No snapshot — fresh start
  }
  return state;
}

function buildEmptyMetrics(): IngestionMetrics {
  return {
    sources: new Map(),
    ingestion_latency_ms_p50: 0,
    ingestion_latency_ms_p99: 0,
    total_events_24h: 0,
    uptime_ms: 0,
  };
}
