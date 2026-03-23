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
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { program } from 'commander';
import { config as cfg } from './utils/config.js';
import type { Config } from './utils/config.js';
import { getLogger } from './utils/logger.js';
import { now, dayKey } from './utils/time.js';
import { WorldState } from './state/world_state.js';
import { Ledger } from './ledger/ledger.js';
import { ClobWebSocket } from './ingestion/clob_websocket.js';
import { BookPoller } from './ingestion/book_poller.js';
import { MarketMetadataFetcher } from './ingestion/market_metadata.js';
import { WalletListener } from './ingestion/wallet_listener.js';
import { WalletActivityPoller } from './ingestion/wallet_activity_poller.js';
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
import type { IngestionMetrics, ParsedTrade, ParsedBookSnapshot, RawEvent, WalletTransaction } from './ingestion/types.js';
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

  // When running via `tsx` (dev mode), import.meta.url ends with .ts.
  // In that case use the .ts worker path and register the tsx loader so the
  // worker thread can also execute TypeScript directly.
  const isTsx = __filename.endsWith('.ts');
  const workerExt = isTsx ? '.ts' : '.js';
  const workerPath = join(__dirname, 'workers', `computation_worker${workerExt}`);
  const workerOptions = isTsx ? { execArgv: ['--import', 'tsx'] } : {};

  const worker = new Worker(workerPath, workerOptions);

  // Worker message helper with type safety
  function sendToWorker(msg: MainToWorkerMessage): void {
    worker.postMessage(msg);
  }

  // Book update batching: collect snapshots and flush every 500ms to avoid
  // saturating the worker's message port with 1500+ individual messages/sec.
  const FLUSH_INTERVAL_MS = 100;
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

      case 'signal_generated': {
        workerSignalsTotal++;
        const sigMarket = state.getMarket(msg.data.market_id)?.question ?? msg.data.market_id;
        const evStr = (msg.data.ev_estimate * 100).toFixed(1);
        log.info(
          {
            signal_id: msg.data.signal_id,
            strategy: msg.data.strategy_id,
            direction: msg.data.direction,
            ev: msg.data.ev_estimate,
            market: sigMarket,
          },
          `signal_generated | ${msg.data.direction} EV=${evStr}¢ — ${sigMarket}`,
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
      }

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

  // CLOB-side wallet detection: polls data-api.polymarket.com for each tracked
  // wallet. This may detect trades BEFORE on-chain settlement, giving us a head
  // start over the Alchemy WalletListener path. Both paths race — whichever
  // fires first triggers strategy eval, and the dedup layer prevents duplicates.
  const walletActivityPoller = new WalletActivityPoller({
    trackedWallets: config.wallet_intel.tracked_wallets,
    pollIntervalMs: 1_000, // 1s — aggressive polling for speed
  });

  // Token ID → market_id index for O(1) lookups
  const tokenToMarketId = new Map<string, string>();

  // Recent CLOB trades buffer for enriching wallet transactions
  const recentClobTrades: ParsedTrade[] = [];
  const MAX_RECENT_TRADES = 2000;

  // Track wallet positions for resolution event generation.
  // When a market resolves, we emit synthetic SELL events at resolution price.
  // Key: `${wallet}:${token_id}`, Value: position info
  const walletPositions = new Map<string, { wallet: string; token_id: string; market_id: string; size: number }>();

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

    // Generate synthetic resolution events for tracked wallet positions
    if (!meta.resolution) return;

    const yesId = meta.tokens.yes_id;
    const noId = meta.tokens.no_id;
    const keysToDelete: string[] = [];

    for (const [key, pos] of walletPositions) {
      if (pos.market_id !== meta.market_id) continue;

      const isYes = pos.token_id === yesId;
      const isNo = pos.token_id === noId;
      if (!isYes && !isNo) continue;

      // Resolution price: winning token = $1.00, losing token = $0.00
      const resolutionPrice =
        (meta.resolution === 'YES' && isYes) || (meta.resolution === 'NO' && isNo)
          ? 1.0
          : 0.0;

      const syntheticTx: WalletTransaction = {
        wallet: pos.wallet,
        market_id: meta.market_id,
        token_id: pos.token_id,
        side: 'SELL',
        price: resolutionPrice,
        size: pos.size,
        timestamp: now(),
        tx_hash: `resolution:${meta.market_id}:${pos.token_id}`,
        block_number: 0,
        gas_price: 0,
      };

      persistWalletEvent(syntheticTx, 'clob_ws');
      state.recordWalletTradeWithRegime(syntheticTx);
      sendToWorker({ type: 'wallet_trade', data: syntheticTx });

      const walletShort = pos.wallet.slice(0, 6) + '\u2026' + pos.wallet.slice(-4);
      log.info(
        { wallet: pos.wallet, market_id: meta.market_id, resolution: meta.resolution, price: resolutionPrice, size: pos.size },
        `wallet_resolution | [${walletShort}] closed @ $${resolutionPrice.toFixed(2)} — ${meta.question}`,
      );

      keysToDelete.push(key);
    }

    for (const key of keysToDelete) walletPositions.delete(key);
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

    // NOTE: CLOB WS does NOT expose maker/taker addresses (they are always empty
    // strings in Polymarket's feed). Wallet detection runs exclusively through
    // the on-chain Alchemy path (WalletListener → TransferSingle events).
    // The CLOB trade feed is used only for book state, price enrichment, and
    // market data — never for wallet identification.
  });

  // Token IDs that have already been queued for on-demand lookup (avoid duplicate calls)
  const pendingTokenLookups = new Set<string>();
  // Cap concurrent Gamma lookups to avoid rate limiting
  const MAX_CONCURRENT_LOOKUPS = 3;
  const lookupQueue: string[] = []; // overflow queue for token IDs waiting to be looked up

  // Trades waiting on market discovery — queued so no trades are dropped
  // Entries older than 60s are dropped to prevent unbounded growth if lookup hangs
  const pendingDiscoveryTrades = new Map<string, { tx: WalletTransaction; source: 'clob_ws' | 'chain_listener'; queued_at: number }[]>();
  setInterval(() => {
    const cutoff = now() - 60_000;
    for (const [tokenId, entries] of pendingDiscoveryTrades) {
      const fresh = entries.filter((e) => e.queued_at > cutoff);
      if (fresh.length === 0) {
        pendingDiscoveryTrades.delete(tokenId);
        pendingTokenLookups.delete(tokenId);
        log.warn({ token_id: tokenId.slice(0, 20), dropped: entries.length }, 'wallet_trade | pending discovery timed out');
      } else if (fresh.length < entries.length) {
        pendingDiscoveryTrades.set(tokenId, fresh);
      }
    }
  }, 15_000).unref();

  // Tracked wallet set for CLOB-side detection
  const trackedWalletsSet = new Set(
    config.wallet_intel.tracked_wallets.map((w: string) => w.toLowerCase()),
  );

  // Cross-source dedup: prevent processing the same tx twice from CLOB + Alchemy
  // CLOB fires ~4s before on-chain. Alchemy event arrives later and hits this dedup.
  const walletTxSeen = new Map<string, number>(); // tx_hash → expiry ms
  const WALLET_TX_TTL = 30_000;
  setInterval(() => {
    const t = now();
    for (const [h, exp] of walletTxSeen) if (exp <= t) walletTxSeen.delete(h);
  }, 30_000).unref();

  function isWalletTxSeen(txHash: string): boolean {
    if (!txHash) return false;
    const exp = walletTxSeen.get(txHash);
    return exp !== undefined && exp > now();
  }
  function markWalletTxSeen(txHash: string): void {
    if (txHash) walletTxSeen.set(txHash, now() + WALLET_TX_TTL);
  }

  /** Persist a wallet trade event to the wallet JSONL for analysis (async, non-blocking). */
  function persistWalletEvent(tx: WalletTransaction, source: 'clob_ws' | 'chain_listener'): void {
    const rawEvent: RawEvent = {
      source,
      type: 'wallet_tx',
      timestamp_ingested: now(),
      timestamp_source: tx.timestamp,
      raw_payload: {},
      parsed: tx,
      sequence_id: 0,
    };
    const dir = config.ingestion.raw_events_dir;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `wallet_${dayKey(rawEvent.timestamp_ingested)}.jsonl`);
    appendFile(file, JSON.stringify(rawEvent) + '\n').catch((err) => {
      log.warn({ err }, 'Failed to persist wallet event');
    });
  }

  /** Drains the token lookup queue, respecting MAX_CONCURRENT_LOOKUPS to avoid Gamma API throttling. */
  let activeLookups = 0;
  async function drainLookupQueue(): Promise<void> {
    while (lookupQueue.length > 0 && activeLookups < MAX_CONCURRENT_LOOKUPS) {
      const tokenId = lookupQueue.shift()!;
      activeLookups++;
      log.info({ tokenId: tokenId.slice(0, 20), queue: lookupQueue.length }, 'wallet_trade | new market — discovering...');

      try {
        const meta = await metadataFetcher.lookupByTokenId(tokenId);
        pendingTokenLookups.delete(tokenId);
        const waiting = pendingDiscoveryTrades.get(tokenId) ?? [];
        pendingDiscoveryTrades.delete(tokenId);

        if (!meta) {
          if (waiting.length > 0) log.warn({ token_id: tokenId.slice(0, 20), dropped: waiting.length }, 'wallet_trade | market lookup failed, trades dropped');
        } else {
          log.info({ token_id: tokenId.slice(0, 20), market: meta.question, trades: waiting.length }, 'wallet_trade | market discovered, replaying');
          try {
            const snap = await bookPoller.fetchBookOnDemand(tokenId, meta.market_id);
            if (snap) { state.updateMarket(snap); clobWs.updateBookSnapshot(snap); }
          } catch { /* non-fatal */ }
          for (const entry of waiting) {
            const retryResolved = state.resolveWalletTradeMarket(entry.tx);
            if (retryResolved) await processWalletTrade(retryResolved, entry.source);
            else await processWalletTrade({ ...entry.tx, market_id: meta.market_id }, entry.source);
          }
        }
      } catch {
        pendingTokenLookups.delete(tokenId);
        const dropped = pendingDiscoveryTrades.get(tokenId)?.length ?? 0;
        pendingDiscoveryTrades.delete(tokenId);
        if (dropped > 0) log.warn({ token_id: tokenId.slice(0, 20), dropped }, 'wallet_trade | lookup error, trades dropped');
      } finally {
        activeLookups--;
      }
    }
    // If there are still items queued, they'll be drained on next call
    if (lookupQueue.length > 0) void drainLookupQueue();
  }

  /** Core wallet trade processor — called from data-api poller, Alchemy, or internal paths. */
  async function processWalletTrade(tx: WalletTransaction, source: 'clob_ws' | 'chain_listener'): Promise<void> {
    // For 'clob_ws' (data-api path): tx has price but may lack market_id.
    // Try to resolve market_id from our token index first.
    let resolved: WalletTransaction | null;
    if (source === 'clob_ws') {
      if (!tx.market_id && tx.token_id) {
        const knownMarketId = tokenToMarketId.get(tx.token_id);
        resolved = knownMarketId ? { ...tx, market_id: knownMarketId } : state.resolveWalletTradeMarket(tx);
      } else {
        resolved = tx;
      }
    } else {
      resolved = state.resolveWalletTradeMarket(tx);
    }

    if (!resolved || !resolved.market_id) {
      // Unknown market — queue trade and trigger on-demand discovery
      const queued = pendingDiscoveryTrades.get(tx.token_id) ?? [];
      queued.push({ tx, source, queued_at: now() });
      pendingDiscoveryTrades.set(tx.token_id, queued);

      if (!pendingTokenLookups.has(tx.token_id)) {
        pendingTokenLookups.add(tx.token_id);
        lookupQueue.push(tx.token_id);
        void drainLookupQueue();
      }
      return;
    }

    let enriched = source === 'clob_ws'
      ? resolved
      : state.enrichWalletTradePrice(resolved, recentClobTrades);

    // FAST PATH: Send to worker immediately with whatever price we have.
    // The worker can start strategy evaluation while we do async price enrichment.
    // The worker uses its own book state for the delay curve anyway.
    if (enriched.market_id) {
      sendToWorker({ type: 'wallet_trade', data: enriched });
    }

    // Fallback 1: fetch recent trade price from CLOB REST API (exact fill price)
    if (enriched.price <= 0 && enriched.token_id) {
      try {
        const tradePrice = await bookPoller.fetchRecentTradePrice(enriched.token_id);
        if (tradePrice !== null) enriched = { ...enriched, price: tradePrice };
      } catch {
        // Non-fatal
      }
    }

    // Fallback 2: use existing book best_ask/best_bid from state (realistic fill price)
    if (enriched.price <= 0 && enriched.market_id) {
      const mkt = state.getMarket(enriched.market_id);
      if (mkt) {
        const bookSide = mkt.tokens.yes_id === enriched.token_id ? 'yes' : 'no';
        const book = mkt.book[bookSide];
        // Use best_ask for BUYs (what buyer pays), best_bid for SELLs (what seller gets)
        // bids sorted desc, asks sorted asc — [0] is best
        const fillPrice = enriched.side === 'BUY'
          ? (book.asks[0]?.[0] ?? book.mid)
          : (book.bids[0]?.[0] ?? book.mid);
        if (fillPrice > 0 && fillPrice < 1) enriched = { ...enriched, price: fillPrice };
      }
    }

    // Fallback 3: on-demand REST book fetch (one fast API call)
    if (enriched.price <= 0 && enriched.market_id) {
      try {
        const snap = await bookPoller.fetchBookOnDemand(enriched.token_id, enriched.market_id);
        if (snap && snap.mid_price > 0) {
          // Use best_ask for BUYs, best_bid for SELLs (realistic fill price)
          const fillPrice = enriched.side === 'BUY'
            ? (snap.asks[0]?.[0] ?? snap.mid_price)
            : (snap.bids[0]?.[0] ?? snap.mid_price);
          enriched = { ...enriched, price: fillPrice };
          // Also update state book for future lookups
          state.updateMarket(snap);
          clobWs.updateBookSnapshot(snap);
        }
      } catch {
        // Non-fatal — proceed with price unknown
      }
    }

    state.recordWalletTradeWithRegime(enriched);
    // Worker already received early notification above (fast path).
    // Send enriched version only if price was updated by fallbacks.
    if (enriched.price > 0 && enriched.market_id) {
      sendToWorker({ type: 'wallet_trade', data: enriched });
    }
    persistWalletEvent(enriched, source);

    const mkt = state.getMarket(enriched.market_id);
    const marketQuestion = mkt?.question ?? enriched.market_id;
    let displayPrice = enriched.price;
    if (displayPrice <= 0 && mkt) {
      const bookSide = mkt.tokens.yes_id === enriched.token_id ? 'yes' : 'no';
      displayPrice = mkt.book[bookSide].mid;
    }
    const priceStr = displayPrice > 0
      ? `@ $${displayPrice.toFixed(3)}${source === 'clob_ws' ? '' : ' (est)'}`
      : '@ price unknown';
    const walletShort = enriched.wallet.slice(0, 6) + '…' + enriched.wallet.slice(-4);
    log.info(
      { wallet: enriched.wallet, side: enriched.side, size: enriched.size.toFixed(1), price: displayPrice > 0 ? displayPrice : undefined, market: marketQuestion, source },
      `wallet_trade | [${walletShort}] ${enriched.side} ${enriched.size.toFixed(1)} shares ${priceStr} — ${marketQuestion} [${source}]`,
    );

    ledger.append({
      type: 'system_event',
      data: {
        event: 'wallet_trade',
        details: {
          wallet: enriched.wallet,
          token_id: enriched.token_id,
          market_id: enriched.market_id,
          side: enriched.side,
          size: enriched.size,
          price: enriched.price,
          block: enriched.block_number,
          ingested_at: enriched.timestamp,
          source,
        },
      },
    });

    // Track wallet positions for resolution event generation
    if (!enriched.tx_hash.startsWith('resolution:')) {
      const posKey = `${enriched.wallet}:${enriched.token_id}`;
      if (enriched.side === 'BUY') {
        const existing = walletPositions.get(posKey);
        walletPositions.set(posKey, {
          wallet: enriched.wallet,
          token_id: enriched.token_id,
          market_id: enriched.market_id,
          size: (existing?.size ?? 0) + enriched.size,
        });
      } else {
        const existing = walletPositions.get(posKey);
        if (existing) {
          const remaining = existing.size - enriched.size;
          if (remaining <= 0) walletPositions.delete(posKey);
          else walletPositions.set(posKey, { ...existing, size: remaining });
        }
      }
    }
  }

  // Wallet trades → local enrichment + forward to worker
  walletListener.on('wallet_trade', (tx) => {
    // Skip if CLOB already processed this tx (CLOB fires ~4s earlier)
    if (tx.tx_hash && isWalletTxSeen(tx.tx_hash)) return;
    // Mark seen so if Alchemy fires twice we don't double-process
    markWalletTxSeen(tx.tx_hash);

    void processWalletTrade(tx, 'chain_listener');
  });

  // CLOB-side wallet trades from data-api polling (may arrive BEFORE on-chain)
  walletActivityPoller.on('wallet_trade', (tx) => {
    // Dedup: if Alchemy already processed this tx, skip
    if (tx.tx_hash && isWalletTxSeen(tx.tx_hash)) return;
    markWalletTxSeen(tx.tx_hash);

    // This path already has price from the data-api — use 'clob_ws' source
    // so processWalletTrade skips the enrichment waterfall
    void processWalletTrade(tx, 'clob_ws');
  });

  // Error handlers
  clobWs.on('error', (err) => log.warn({ err }, 'ClobWebSocket error'));
  bookPoller.on('error', (err, context) => log.warn({ err, context }, 'BookPoller error'));
  metadataFetcher.on('error', (err) => log.warn({ err }, 'MetadataFetcher error'));
  walletListener.on('error', (err) => log.warn({ err }, 'WalletListener error'));
  walletActivityPoller.on('error', (err) => log.warn({ err }, 'WalletActivityPoller error'));

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
    walletActivityPoller.stop();

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

  // Bootstrap historical wallet trades AFTER metadata has loaded.
  // Wait 8s for the initial metadata batch to populate tokenToMarketId,
  // then fetch historical trades so we can resolve token_id → market_id.
  setTimeout(() => {
    walletActivityPoller.bootstrap(100).then((historicalTrades) => {
      if (historicalTrades.length > 0) {
        const resolved = historicalTrades.map(tx => {
          if (!tx.market_id && tx.token_id) {
            const knownMarketId = tokenToMarketId.get(tx.token_id);
            if (knownMarketId) return { ...tx, market_id: knownMarketId };
            const r = state.resolveWalletTradeMarket(tx);
            return r ?? tx;
          }
          return tx;
        }).filter(tx => tx.market_id);

        log.info(
          { total: historicalTrades.length, resolved: resolved.length, known_tokens: tokenToMarketId.size },
          'Sending historical wallet trades to worker for delay curve bootstrap',
        );
        sendToWorker({ type: 'wallet_trade_history', data: resolved });
      }
      // Start live polling AFTER bootstrap completes
      walletActivityPoller.start();
    }).catch((err) => {
      log.warn({ err }, 'Wallet bootstrap failed, starting live polling anyway');
      walletActivityPoller.start();
    });
  }, 8_000);

  // ---------------------------------------------------------------------------
  // Wallet hot-reload: watch config/default.json for tracked_wallets changes
  // ---------------------------------------------------------------------------

  const configPath = join(__dirname, '..', 'config', 'default.json');
  let lastTrackedWallets = JSON.stringify([...trackedWalletsSet].sort());
  const configWatchInterval = setInterval(() => {
    try {
      const fresh = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      const walletIntel = fresh['wallet_intel'] as Record<string, unknown> | undefined;
      const newWallets: string[] = ((walletIntel?.['tracked_wallets'] as string[]) ?? []).map(w => w.toLowerCase());
      const freshStr = JSON.stringify(newWallets.sort());
      if (freshStr === lastTrackedWallets) return;

      const added = newWallets.filter(w => !trackedWalletsSet.has(w));
      const removed = [...trackedWalletsSet].filter(w => !newWallets.includes(w));

      for (const w of added) {
        trackedWalletsSet.add(w);
        walletListener.addWallet(w);
        walletActivityPoller.addWallet(w);
      }
      for (const w of removed) {
        trackedWalletsSet.delete(w);
        walletListener.removeWallet(w);
        walletActivityPoller.removeWallet(w);
      }

      lastTrackedWallets = freshStr;
      if (added.length > 0 || removed.length > 0) {
        walletListener.forceReconnect(); // Re-subscribe with updated wallet list
        // Forward wallet list changes to worker thread
        sendToWorker({ type: 'wallet_list_update', data: { added, removed } });
        log.info(
          { added: added.length, removed: removed.length, total: trackedWalletsSet.size },
          'Wallet list hot-reloaded from config/default.json',
        );
      }
    } catch { /* ignore parse errors from partial writes */ }
  }, 5_000);
  configWatchInterval.unref();

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
      // Data-api poller stats
      data_api_polls: walletActivityPoller.metrics.polls,
      data_api_trades: walletActivityPoller.metrics.trades_detected,
      data_api_avg_ms: Math.round(walletActivityPoller.metrics.avg_poll_ms),
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
