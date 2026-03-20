/**
 * Entry point for the Polymarket Quantitative Trading Platform.
 *
 * Wires together: Ingestion → State → Ledger
 * CLI: `quant report health` and `quant report state`
 */

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
import { reportHealth, reportState, printReport } from './analytics/reports.js';
import type { IngestionMetrics } from './ingestion/types.js';

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

  log.info({ paper_mode: config.paper_mode }, 'Starting Polymarket Quant Platform');

  // Core components
  const state = new WorldState();
  const ledger = new Ledger(config.ledger.dir);

  // Ingestion
  const metadataFetcher = new MarketMetadataFetcher(
    config.polymarket.gamma_url,
    config.ingestion.metadata_poll_interval_ms,
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

  // ---------------------------------------------------------------------------
  // Event wiring: Ingestion → State → Ledger
  // ---------------------------------------------------------------------------

  // Market metadata: register new markets, update book poller token list
  metadataFetcher.on('market_created', (meta) => {
    state.registerMarket(meta);

    // Register both YES and NO tokens with the book poller
    if (meta.tokens.yes_id) bookPoller.addToken(meta.tokens.yes_id, meta.market_id);
    if (meta.tokens.no_id) bookPoller.addToken(meta.tokens.no_id, meta.market_id);

    ledger.append({ type: 'system_event', data: { event: 'market_created', details: meta } });
    log.info({ market_id: meta.market_id, question: meta.question }, 'Market registered');
  });

  metadataFetcher.on('market_resolved', (meta) => {
    ledger.append({ type: 'system_event', data: { event: 'market_resolved', details: meta } });
    log.info(
      { market_id: meta.market_id, resolution: meta.resolution },
      'Market resolved',
    );
  });

  // Book snapshots from REST poller → state update
  bookPoller.on('book_snapshot', (snapshot) => {
    const markets = state.getAllMarkets();
    const market = markets.find(
      (m) => m.tokens.yes_id === snapshot.token_id || m.tokens.no_id === snapshot.token_id,
    );
    if (market) {
      state.updateMarket(snapshot);
      // Keep ClobWebSocket's pre-trade book state in sync
      clobWs.updateBookSnapshot(snapshot);
    }
  });

  // Book snapshots from WebSocket → state update
  clobWs.on('book_snapshot', (snapshot) => {
    const markets = state.getAllMarkets();
    const market = markets.find(
      (m) => m.tokens.yes_id === snapshot.token_id || m.tokens.no_id === snapshot.token_id,
    );
    if (market) {
      state.updateMarket(snapshot);
    }
  });

  // Trades from WebSocket → state update + ledger
  clobWs.on('trade', (trade) => {
    const markets = state.getAllMarkets();
    const market = markets.find(
      (m) => m.tokens.yes_id === trade.token_id || m.tokens.no_id === trade.token_id,
    );
    if (market) {
      state.updateMarketFromTrade(trade);
    }
    log.debug(
      {
        market_id: trade.market_id,
        side: trade.side,
        price: trade.price,
        size: trade.size,
      },
      'trade',
    );
  });

  // Error handlers
  clobWs.on('error', (err) => log.warn({ err }, 'ClobWebSocket error'));
  bookPoller.on('error', (err, tokenId) => log.warn({ err, tokenId }, 'BookPoller error'));
  metadataFetcher.on('error', (err) => log.warn({ err }, 'MetadataFetcher error'));

  // ---------------------------------------------------------------------------
  // Periodic state snapshot
  // ---------------------------------------------------------------------------

  const snapshotInterval = setInterval(() => {
    try {
      state.saveToDisk(config.state.snapshots_dir);
      log.debug('State snapshot saved');
    } catch (err) {
      log.warn({ err }, 'Failed to save state snapshot');
    }
  }, config.state.snapshot_interval_ms);
  snapshotInterval.unref();

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  const shutdown = (signal: string): void => {
    log.info({ signal }, 'Shutting down...');

    clobWs.stop();
    bookPoller.stop();
    metadataFetcher.stop();

    clearInterval(snapshotInterval);

    try {
      state.saveToDisk(config.state.snapshots_dir);
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
  // Start
  // ---------------------------------------------------------------------------

  metadataFetcher.start();
  bookPoller.start();
  clobWs.start();

  log.info('All ingestion components started');
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
