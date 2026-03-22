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
import { FeatureEngine } from './research/feature_engine.js';
import { MarketClassifier, recordBookUpdate, recordTrade, recordComplementGap } from './analytics/market_classifier.js';
import { ConsistencyChecker } from './analytics/consistency_checker.js';
import { PropagationModel } from './analytics/propagation_model.js';
import { StrategyEngine } from './strategy/engine.js';
import { WalletFollowStrategy } from './strategy/wallet_follow.js';
import { ComplementArbStrategy } from './strategy/complement_arb.js';
import { BookImbalanceStrategy } from './strategy/book_imbalance.js';
import { LargeTradeReactionStrategy } from './strategy/large_trade_reaction.js';
import { StaleBookStrategy } from './strategy/stale_book.js';
import { CrossMarketConsistencyStrategy } from './strategy/cross_market_consistency.js';
import { MicropriceDislocationStrategy } from './strategy/microprice_dislocation.js';
import { paperExecute } from './execution/executor.js';
import { Reconciliation } from './execution/reconciliation.js';
import { scoreWallet } from './wallet_intel/scorer.js';
import { classifyWallet } from './wallet_intel/classifier.js';
import { computeWalletDelayCurve } from './wallet_intel/delay_analysis.js';
import { computeWalletRegimeProfile } from './wallet_intel/regime_conditional.js';
import { buildRegimeSpans } from './wallet_intel/regime_conditional.js';
import type { WalletIntelProvider } from './strategy/wallet_follow.js';
import type { PriceTimeseries } from './wallet_intel/types.js';
import type { IngestionMetrics, ParsedTrade } from './ingestion/types.js';
import type { ConsistencyCheck } from './analytics/types.js';

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

  log.info({ paper_mode: config.paper_mode }, 'Starting Polymarket Quant Platform');

  // Core components
  const state = new WorldState();
  const ledger = new Ledger(config.ledger.dir);

  // Analytics: market classification, consistency, propagation
  const marketClassifier = new MarketClassifier(
    config.strategies.wallet_follow['default_latency_ms'] as number ?? 2000,
  );
  const consistencyChecker = new ConsistencyChecker(config.polymarket.fee_rate);
  const propagationModel = new PropagationModel(
    config.strategies.wallet_follow['default_latency_ms'] as number ?? 2000,
  );

  // Last consistency check results (shared with featureEngine)
  let lastConsistencyChecks: ConsistencyCheck[] = [];

  // Ingestion
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

  // Register tracked wallets in state
  for (const addr of config.wallet_intel.tracked_wallets) {
    state.registerWallet(addr);
  }

  // ---------------------------------------------------------------------------
  // Regime detection: 60s interval, logs changes to ledger
  // ---------------------------------------------------------------------------

  state.onRegimeChange = (from, to, confidence) => {
    ledger.append({ type: 'regime_change', data: { from, to, confidence } });
    log.info({ from, to, confidence }, 'Regime change logged to ledger');
  };

  // ---------------------------------------------------------------------------
  // Feature extraction engine: captures all features every 60s
  // ---------------------------------------------------------------------------

  const featureEngine = new FeatureEngine({
    outputDir: config.features.dir,
    minVolume24h: 1000,
    captureIntervalMs: config.features.capture_interval_ms,
  });

  featureEngine.start(() => ({
    markets: state.getAllMarkets(),
    wallets: state.getAllWallets(),
    regime: state.regime,
    consistencyViolations: lastConsistencyChecks,
    marketGraph: state.market_graph,
  }));

  // ---------------------------------------------------------------------------
  // Strategy Engine: register all 7 strategies in shadow mode
  // ---------------------------------------------------------------------------

  const strategyEngine = new StrategyEngine(ledger);
  const reconciliation = new Reconciliation(ledger);

  // Build WalletIntelProvider adapter
  // Price history for delay curve computation (built from market state snapshots)
  const priceHistory: Map<string, PriceTimeseries> = new Map();

  const walletIntelProvider: WalletIntelProvider = {
    getScore(address: string) {
      const walletState = state.getWallet(address);
      if (!walletState) return null;
      const classification = classifyWallet(walletState);
      const delayCurve = computeWalletDelayCurve(walletState, priceHistory);
      const regimeSpans = buildRegimeSpans([{
        timestamp: state.regime.regime_since,
        regime: state.regime.current_regime,
      }]);
      const regimeProfile = computeWalletRegimeProfile(walletState, regimeSpans);
      return scoreWallet({
        wallet: walletState,
        classification,
        delayCurve,
        regimeProfile,
      });
    },
    getDelayCurve(address: string) {
      const walletState = state.getWallet(address);
      if (!walletState) return null;
      return computeWalletDelayCurve(walletState, priceHistory);
    },
    getRegimeProfile(address: string) {
      const walletState = state.getWallet(address);
      if (!walletState) return null;
      const regimeSpans = buildRegimeSpans([{
        timestamp: state.regime.regime_since,
        regime: state.regime.current_regime,
      }]);
      return computeWalletRegimeProfile(walletState, regimeSpans);
    },
  };

  // Register strategies
  strategyEngine.register(new WalletFollowStrategy(walletIntelProvider));
  strategyEngine.register(new ComplementArbStrategy());
  strategyEngine.register(new BookImbalanceStrategy());
  strategyEngine.register(new LargeTradeReactionStrategy());
  strategyEngine.register(new StaleBookStrategy(propagationModel));
  strategyEngine.register(new CrossMarketConsistencyStrategy(consistencyChecker));
  strategyEngine.register(new MicropriceDislocationStrategy());

  log.info(
    { strategies: strategyEngine.registeredIds(), paper_mode: config.paper_mode },
    'All strategies registered in shadow mode',
  );

  // Recent CLOB trades buffer for enriching wallet transactions
  const recentClobTrades: ParsedTrade[] = [];
  const MAX_RECENT_TRADES = 500;

  // Token ID → market_id index for O(1) lookups instead of O(n) scans per event
  const tokenToMarketId = new Map<string, string>();

  // Flag: set when markets are loaded, triggers initial classification in next strategy tick
  let needsInitialClassification = false;

  // ---------------------------------------------------------------------------
  // Event wiring: Ingestion → State → Ledger
  // ---------------------------------------------------------------------------

  // Market metadata: register new markets, update book poller token list
  metadataFetcher.on('market_created', (meta) => {
    state.registerMarket(meta);

    // Register both YES and NO tokens with the book poller, WebSocket, and index
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

    // Subscribe ClobWebSocket to the new tokens for real-time trades/price updates
    if (tokenIds.length > 0) {
      clobWs.subscribeAssets(tokenIds);
    }

    // Feed new market event to regime detector
    state.regimeDetector.recordNewMarket(now());

    ledger.append({ type: 'system_event', data: { event: 'market_created', details: meta } });
    log.info({ market_id: meta.market_id, question: meta.question }, 'Market registered');

    // Trigger initial classification once we have enough markets
    needsInitialClassification = true;
  });

  metadataFetcher.on('market_resolved', (meta) => {
    // Feed resolution event to regime detector
    state.regimeDetector.recordResolution(now());

    ledger.append({ type: 'system_event', data: { event: 'market_resolved', details: meta } });
    log.info(
      { market_id: meta.market_id, resolution: meta.resolution },
      'Market resolved',
    );
  });

  // Book snapshots from REST poller → state update + classifier observations + propagation
  bookPoller.on('book_snapshot', (snapshot) => {
    const marketId = tokenToMarketId.get(snapshot.token_id);
    const market = marketId ? state.getMarket(marketId) : undefined;
    if (market) {
      // Ensure market_id matches state key (Gamma API id, not condition_id)
      snapshot.market_id = market.market_id;
      state.updateMarket(snapshot);
      // Keep ClobWebSocket's pre-trade book state in sync
      clobWs.updateBookSnapshot(snapshot);

      // Feed book update to market classifier observations
      const side = market.tokens.yes_id === snapshot.token_id ? 'yes' : 'no';
      const updatedMarket = state.getMarket(market.market_id);
      if (updatedMarket) {
        const obs = marketClassifier.getObservations(market.market_id);
        recordBookUpdate(obs, updatedMarket, side);

        // Record complement gap
        if (updatedMarket.complement_gap_executable !== 0) {
          recordComplementGap(obs, snapshot.timestamp, Math.abs(updatedMarket.complement_gap_executable), config.polymarket.fee_rate);
        }

        // Feed mid-price to propagation model
        const mid = side === 'yes' ? updatedMarket.book.yes.mid : updatedMarket.book.no.mid;
        propagationModel.onPriceUpdate(market.market_id, mid, snapshot.timestamp, state.market_graph);
      }
    }
  });

  // Book snapshots from WebSocket → state update + classifier + propagation
  clobWs.on('book_snapshot', (snapshot) => {
    const marketId = tokenToMarketId.get(snapshot.token_id);
    const market = marketId ? state.getMarket(marketId) : undefined;
    if (market) {
      // WS sends condition_id as market, but state keys by Gamma API id
      snapshot.market_id = market.market_id;
      state.updateMarket(snapshot);

      // Feed book update to classifier observations
      const side = market.tokens.yes_id === snapshot.token_id ? 'yes' : 'no';
      const updatedMarket = state.getMarket(market.market_id);
      if (updatedMarket) {
        const obs = marketClassifier.getObservations(market.market_id);
        recordBookUpdate(obs, updatedMarket, side);

        // Feed mid-price to propagation model
        const mid = side === 'yes' ? updatedMarket.book.yes.mid : updatedMarket.book.no.mid;
        propagationModel.onPriceUpdate(market.market_id, mid, snapshot.timestamp, state.market_graph);
      }
    }
  });

  // Trades from WebSocket → state update + classifier observations + wallet buffer
  clobWs.on('trade', (trade) => {
    const marketId = tokenToMarketId.get(trade.token_id);
    const market = marketId ? state.getMarket(marketId) : undefined;
    if (market) {
      // Fix market_id from WS (condition_id) to Gamma API id
      trade.market_id = market.market_id;
      state.updateMarketFromTrade(trade);

      // Feed trade to classifier observations
      const obs = marketClassifier.getObservations(market.market_id);
      const sizeUsd = trade.price * trade.size;
      recordTrade(obs, trade.timestamp, sizeUsd, trade.maker ?? '', trade.taker ?? '', null);
    }

    // Buffer for wallet trade enrichment
    recentClobTrades.push(trade);
    if (recentClobTrades.length > MAX_RECENT_TRADES) {
      recentClobTrades.splice(0, recentClobTrades.length - MAX_RECENT_TRADES);
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

  // Wallet trades from chain listener → enrich + state update + ledger
  walletListener.on('wallet_trade', (tx) => {
    // Resolve market_id from token_id
    const resolved = state.resolveWalletTradeMarket(tx);
    if (!resolved) {
      log.debug({ token_id: tx.token_id.slice(0, 10) }, 'Wallet trade for unknown token');
      return;
    }

    // Enrich price from recent CLOB trades
    const enriched = state.enrichWalletTradePrice(resolved, recentClobTrades);

    // Update wallet state with running stats
    state.recordWalletTradeWithRegime(enriched);

    // Log to ledger
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

    log.debug(
      {
        wallet: enriched.wallet.slice(0, 10),
        market_id: enriched.market_id,
        side: enriched.side,
        size: enriched.size,
      },
      'wallet_trade processed',
    );
  });

  // Error handlers
  clobWs.on('error', (err) => log.warn({ err }, 'ClobWebSocket error'));
  bookPoller.on('error', (err, tokenId) => log.warn({ err, tokenId }, 'BookPoller error'));
  metadataFetcher.on('error', (err) => log.warn({ err }, 'MetadataFetcher error'));
  walletListener.on('error', (err) => log.warn({ err }, 'WalletListener error'));

  // ---------------------------------------------------------------------------
  // Periodic market classification (every 60s, with initial run after 15s)
  // ---------------------------------------------------------------------------

  const runClassification = () => {
    try {
      const events = marketClassifier.classifyAll(state.markets, 'scheduled');
      for (const evt of events) {
        ledger.append({
          type: 'system_event',
          data: { event: 'market_reclassified', details: evt },
        });
      }
      const classified = marketClassifier.classifications.size;
      const edgeMap = marketClassifier.buildEdgeMap(
        config.risk.max_total_exposure_pct * 10_000,
      );
      log.info(
        {
          markets: state.markets.size,
          classified,
          reclassified: events.length,
          markets_with_edge: edgeMap.markets_with_edge.length,
        },
        'Market classification tick',
      );
    } catch (err) {
      log.warn({ err }, 'Market classification failed');
    }
  };

  // Periodic classification + initial classification triggered by market loading
  let initialClassificationDone = false;

  const classifyInterval = setInterval(() => {
    // On first interval, check if initial classification was missed
    if (!initialClassificationDone && state.markets.size > 0) {
      initialClassificationDone = true;
    }
    runClassification();
  }, 60_000);
  classifyInterval.unref();

  // ---------------------------------------------------------------------------
  // Periodic consistency check (every 60s)
  // ---------------------------------------------------------------------------

  const consistencyInterval = setInterval(() => {
    try {
      const checks = consistencyChecker.checkAll(state.markets, state.market_graph);
      lastConsistencyChecks = checks;

      const tradeable = checks.filter((c) => c.tradeable);
      if (tradeable.length > 0) {
        log.info(
          { total: checks.length, tradeable: tradeable.length },
          'Consistency violations detected',
        );
        ledger.append({
          type: 'system_event',
          data: {
            event: 'consistency_violations',
            details: {
              total: checks.length,
              tradeable: tradeable.length,
              total_executable_profit: tradeable.reduce(
                (s, c) => s + c.executable_violation,
                0,
              ),
            },
          },
        });
      }
    } catch (err) {
      log.warn({ err }, 'Consistency check failed');
    }
  }, 60_000);
  consistencyInterval.unref();

  // ---------------------------------------------------------------------------
  // Periodic state snapshot
  // ---------------------------------------------------------------------------

  const snapshotInterval = setInterval(() => {
    try {
      const snapshotFile = `${config.state.snapshots_dir}/state-${Date.now()}.json`;
      state.saveToDisk(snapshotFile);
      propagationModel.saveStatsSnapshot();
      log.debug('State snapshot saved');
    } catch (err) {
      log.warn({ err }, 'Failed to save state snapshot');
    }
  }, config.state.snapshot_interval_ms);
  snapshotInterval.unref();

  // ---------------------------------------------------------------------------
  // Strategy engine tick: evaluate all strategies every 5s
  // ---------------------------------------------------------------------------

  let strategyTickCount = 0;
  const strategyTickInterval = setInterval(() => {
    try {
      strategyTickCount++;

      // Run initial classification if markets have been loaded but not yet classified
      if (needsInitialClassification && !initialClassificationDone && state.markets.size >= 10) {
        initialClassificationDone = true;
        needsInitialClassification = false;
        log.info({ markets: state.markets.size }, 'Running initial market classification');
        runClassification();
      }

      // Build edge map from classifier
      const edgeMap = marketClassifier.buildEdgeMap(
        config.risk.max_total_exposure_pct * 10_000, // total capital estimate
      );

      const result = strategyEngine.tick(state, edgeMap, marketClassifier);

      // Log every tick (not just when signals are generated) for diagnostics
      log.info(
        {
          tick: strategyTickCount,
          edge_markets: edgeMap.markets_with_edge.length,
          evaluated: result.markets_evaluated,
          strategies_run: result.strategies_run,
          generated: result.signals_generated.length,
          filtered: result.signals_filtered.length,
          elapsed_ms: result.elapsed_ms.toFixed(1),
        },
        'Strategy tick',
      );

      if (result.signals_generated.length > 0) {

        // Paper execution for each signal
        if (config.paper_mode) {
          for (const signal of result.signals_generated) {
            const fillResult = paperExecute(signal, state, ledger, {
              fee_rate: config.polymarket.fee_rate,
              paper_mode: true,
            });

            if (fillResult.filled) {
              reconciliation.openPosition(fillResult.execution, signal.ev_estimate);
              strategyEngine.trackSignal(signal);
            }
          }
        }
      }

      // Check kill conditions on live signals
      const killed = strategyEngine.checkKillConditions(state);
      for (const k of killed) {
        // Close positions for killed signals
        for (const pos of reconciliation.getOpenPositions()) {
          if (pos.market_id === k.signal.market_id && pos.strategy_id === k.signal.strategy_id) {
            const market = state.markets.get(pos.market_id);
            if (market) {
              const isYes = market.tokens.yes_id === pos.token_id;
              const exitPrice = isYes ? market.book.yes.mid : market.book.no.mid;
              reconciliation.closePosition(pos.position_id, exitPrice);
            }
          }
        }
      }
    } catch (err) {
      log.warn({ err }, 'Strategy tick failed');
    }
  }, 5_000);
  strategyTickInterval.unref();

  // ---------------------------------------------------------------------------
  // Mark-to-market: update position PnL every 10s
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
    state.stopRegimeDetection();
    featureEngine.stop();

    clearInterval(classifyInterval);
    clearInterval(consistencyInterval);
    clearInterval(snapshotInterval);
    clearInterval(strategyTickInterval);
    clearInterval(mtmInterval);

    propagationModel.saveStatsSnapshot();

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
  // Start
  // ---------------------------------------------------------------------------

  metadataFetcher.start();
  bookPoller.start();
  clobWs.start();
  walletListener.start();
  state.startRegimeDetection();

  // ---------------------------------------------------------------------------
  // Periodic data flow diagnostics (every 30s for first 5 minutes)
  // ---------------------------------------------------------------------------

  let diagCount = 0;
  const diagInterval = setInterval(() => {
    diagCount++;
    const markets = state.getAllMarkets();
    const marketsWithBooks = markets.filter(m =>
      m.book.yes.mid > 0 || m.book.no.mid > 0
    ).length;
    const marketsWithTrades = markets.filter(m =>
      m.last_trade_price.yes > 0 || m.last_trade_price.no > 0
    ).length;

    log.info({
      total_markets: markets.length,
      markets_with_books: marketsWithBooks,
      markets_with_trades: marketsWithTrades,
      clob_ws_events: clobWs.metrics.events_received,
      clob_ws_eps: Math.round(clobWs.metrics.events_per_second * 100) / 100,
      clob_ws_parse_errors: clobWs.metrics.parse_errors,
      clob_ws_reconnects: clobWs.metrics.reconnect_count,
      wallets_tracked: config.wallet_intel.tracked_wallets.length,
      strategy_ticks: strategyTickCount,
      open_positions: reconciliation.getOpenPositions().length,
    }, 'Data flow diagnostics');

    // Stop diagnostics after 5 minutes (10 ticks at 30s)
    if (diagCount >= 10) {
      clearInterval(diagInterval);
    }
  }, 30_000);
  diagInterval.unref();

  log.info('All ingestion components started (regime detection every 60s)');
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
