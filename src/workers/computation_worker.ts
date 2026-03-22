// ---------------------------------------------------------------------------
// Computation Worker Thread
//
// Runs all CPU-intensive work off the main thread:
//   - Market classification (every 60s)
//   - Strategy engine ticks (every 5s)
//   - Consistency checks (every 60s)
//   - Feature extraction (every 60s)
//   - Propagation model updates
//
// Receives market/book/trade events from main thread via postMessage.
// Sends back signals and diagnostics.
// ---------------------------------------------------------------------------

import { parentPort } from 'node:worker_threads';
import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import { WorldState } from '../state/world_state.js';
import { Ledger } from '../ledger/ledger.js';
import { MarketClassifier, recordBookUpdate, recordTrade, recordComplementGap } from '../analytics/market_classifier.js';
import { ConsistencyChecker } from '../analytics/consistency_checker.js';
import { PropagationModel } from '../analytics/propagation_model.js';
import { FeatureEngine } from '../research/feature_engine.js';
import { StrategyEngine } from '../strategy/engine.js';
import { WalletFollowStrategy } from '../strategy/wallet_follow.js';
import { ComplementArbStrategy } from '../strategy/complement_arb.js';
import { BookImbalanceStrategy } from '../strategy/book_imbalance.js';
import { LargeTradeReactionStrategy } from '../strategy/large_trade_reaction.js';
import { StaleBookStrategy } from '../strategy/stale_book.js';
import { CrossMarketConsistencyStrategy } from '../strategy/cross_market_consistency.js';
import { MicropriceDislocationStrategy } from '../strategy/microprice_dislocation.js';
import { scoreWallet } from '../wallet_intel/scorer.js';
import { classifyWallet } from '../wallet_intel/classifier.js';
import { computeWalletDelayCurve } from '../wallet_intel/delay_analysis.js';
import { computeWalletRegimeProfile, buildRegimeSpans } from '../wallet_intel/regime_conditional.js';
import type { WalletIntelProvider } from '../strategy/wallet_follow.js';
import type { PriceTimeseries } from '../wallet_intel/types.js';
import type { ConsistencyCheck } from '../analytics/types.js';
import type { MainToWorkerMessage, WorkerToMainMessage } from './messages.js';

const log = getLogger('worker');

if (!parentPort) {
  throw new Error('computation_worker must be run as a worker thread');
}

const port = parentPort;

// ---------------------------------------------------------------------------
// State — worker maintains its own copy
// ---------------------------------------------------------------------------

let state: WorldState;
let ledger: Ledger;
let marketClassifier: MarketClassifier;
let consistencyChecker: ConsistencyChecker;
let propagationModel: PropagationModel;
let featureEngine: FeatureEngine;
let strategyEngine: StrategyEngine;

let lastConsistencyChecks: ConsistencyCheck[] = [];
let strategyTickCount = 0;
let totalSignalsGenerated = 0;
let totalSignalsFiltered = 0;
let lastTickEvaluated = 0;
let lastTickElapsedMs = 0;
let initialClassificationDone = false;

// Token → market_id index (mirror of main thread)
const tokenToMarketId = new Map<string, string>();

// Timers
let strategyTickTimer: ReturnType<typeof setInterval> | null = null;
let classifyTimer: ReturnType<typeof setInterval> | null = null;
let consistencyTimer: ReturnType<typeof setInterval> | null = null;

// Config (set on init)
let workerConfig: {
  paper_mode: boolean;
  fee_rate: number;
  default_latency_ms: number;
  max_total_exposure_pct: number;
  features_dir: string;
  features_capture_interval_ms: number;
  tracked_wallets: string[];
  strategies: Record<string, unknown>;
};

// Price history for delay curves
const priceHistory: Map<string, PriceTimeseries> = new Map();

// ---------------------------------------------------------------------------
// Send helper
// ---------------------------------------------------------------------------

function send(msg: WorkerToMainMessage): void {
  port.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function init(cfg: typeof workerConfig): void {
  workerConfig = cfg;

  state = new WorldState();
  ledger = new Ledger('data/ledger');

  marketClassifier = new MarketClassifier(cfg.default_latency_ms);
  consistencyChecker = new ConsistencyChecker(cfg.fee_rate);
  propagationModel = new PropagationModel(cfg.default_latency_ms);

  // Feature engine
  featureEngine = new FeatureEngine({
    outputDir: cfg.features_dir,
    minVolume24h: 1000,
    captureIntervalMs: cfg.features_capture_interval_ms,
  });
  featureEngine.start(() => ({
    markets: state.getAllMarkets(),
    wallets: state.getAllWallets(),
    regime: state.regime,
    consistencyViolations: lastConsistencyChecks,
    marketGraph: state.market_graph,
  }));

  // Register tracked wallets
  for (const addr of cfg.tracked_wallets) {
    state.registerWallet(addr);
  }

  // Regime change logging
  state.onRegimeChange = (from, to, confidence) => {
    ledger.append({ type: 'regime_change', data: { from, to, confidence } });
    log.info({ from, to, confidence }, 'Regime change');
  };

  // Build wallet intel provider
  const walletIntelProvider: WalletIntelProvider = {
    getScore(address: string) {
      const ws = state.getWallet(address);
      if (!ws) return null;
      const classification = classifyWallet(ws);
      const delayCurve = computeWalletDelayCurve(ws, priceHistory);
      const regimeSpans = buildRegimeSpans([{
        timestamp: state.regime.regime_since,
        regime: state.regime.current_regime,
      }]);
      const regimeProfile = computeWalletRegimeProfile(ws, regimeSpans);
      return scoreWallet({ wallet: ws, classification, delayCurve, regimeProfile });
    },
    getDelayCurve(address: string) {
      const ws = state.getWallet(address);
      if (!ws) return null;
      return computeWalletDelayCurve(ws, priceHistory);
    },
    getRegimeProfile(address: string) {
      const ws = state.getWallet(address);
      if (!ws) return null;
      const regimeSpans = buildRegimeSpans([{
        timestamp: state.regime.regime_since,
        regime: state.regime.current_regime,
      }]);
      return computeWalletRegimeProfile(ws, regimeSpans);
    },
  };

  // Strategy engine with all 7 strategies
  strategyEngine = new StrategyEngine(ledger);
  strategyEngine.register(new WalletFollowStrategy(walletIntelProvider));
  strategyEngine.register(new ComplementArbStrategy());
  strategyEngine.register(new BookImbalanceStrategy());
  strategyEngine.register(new LargeTradeReactionStrategy());
  strategyEngine.register(new StaleBookStrategy(propagationModel));
  strategyEngine.register(new CrossMarketConsistencyStrategy(consistencyChecker));
  strategyEngine.register(new MicropriceDislocationStrategy());

  log.info(
    { strategies: strategyEngine.registeredIds() },
    'Worker: all strategies registered',
  );

  // Start regime detection
  state.startRegimeDetection();

  // ---------------------------------------------------------------------------
  // Periodic computation timers
  // ---------------------------------------------------------------------------

  // Strategy ticks every 5s
  strategyTickTimer = setInterval(runStrategyTick, 5_000);

  // Classification every 60s
  classifyTimer = setInterval(runClassification, 60_000);

  // Consistency checks every 60s (offset by 30s from classification)
  setTimeout(() => {
    consistencyTimer = setInterval(runConsistencyCheck, 60_000);
  }, 30_000);

  send({ type: 'ready' });
  log.info('Computation worker initialized');
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function runClassification(): void {
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
      workerConfig.max_total_exposure_pct * 10_000,
    );

    log.info(
      {
        markets: state.markets.size,
        classified,
        with_edge: edgeMap.markets_with_edge.length,
        reclassified: events.length,
      },
      'Market classification tick',
    );

    send({
      type: 'classification_done',
      data: {
        classified,
        markets_with_edge: edgeMap.markets_with_edge.length,
        reclassified: events.length,
      },
    });
  } catch (err) {
    log.warn({ err }, 'Market classification failed');
  }
}

// ---------------------------------------------------------------------------
// Strategy tick
// ---------------------------------------------------------------------------

function runStrategyTick(): void {
  try {
    strategyTickCount++;

    // Trigger initial classification when enough markets arrive
    if (!initialClassificationDone && state.markets.size >= 10) {
      initialClassificationDone = true;
      log.info({ markets: state.markets.size }, 'Running initial classification');
      runClassification();
    }

    const edgeMap = marketClassifier.buildEdgeMap(
      workerConfig.max_total_exposure_pct * 10_000,
    );

    const result = strategyEngine.tick(state, edgeMap, marketClassifier);

    lastTickEvaluated = result.markets_evaluated;
    lastTickElapsedMs = result.elapsed_ms;

    // Forward signals to main thread
    for (const signal of result.signals_generated) {
      totalSignalsGenerated++;
      send({ type: 'signal_generated', data: signal });
    }

    for (const filtered of result.signals_filtered) {
      totalSignalsFiltered++;
      send({
        type: 'signal_filtered',
        data: {
          signal_id: filtered.signal_id,
          strategy_id: filtered.strategy_id,
          market_id: filtered.market_id,
          reason: filtered.reason,
          filter: filtered.filter,
        },
      });
    }

    // Log every tick for visibility
    log.info(
      {
        tick: strategyTickCount,
        edge_markets: edgeMap.markets_with_edge.length,
        evaluated: result.markets_evaluated,
        generated: result.signals_generated.length,
        filtered: result.signals_filtered.length,
        elapsed_ms: result.elapsed_ms.toFixed(1),
      },
      'Strategy tick',
    );
  } catch (err) {
    log.warn({ err }, 'Strategy tick failed');
  }
}

// ---------------------------------------------------------------------------
// Consistency check
// ---------------------------------------------------------------------------

function runConsistencyCheck(): void {
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
              (s, c) => s + c.executable_violation, 0,
            ),
          },
        },
      });
    }
  } catch (err) {
    log.warn({ err }, 'Consistency check failed');
  }
}

// ---------------------------------------------------------------------------
// Event handlers (from main thread)
// ---------------------------------------------------------------------------

function handleMarketRegistered(meta: MainToWorkerMessage & { type: 'market_registered' }): void {
  state.registerMarket(meta.data);

  if (meta.data.tokens.yes_id) {
    tokenToMarketId.set(meta.data.tokens.yes_id, meta.data.market_id);
  }
  if (meta.data.tokens.no_id) {
    tokenToMarketId.set(meta.data.tokens.no_id, meta.data.market_id);
  }

  state.regimeDetector.recordNewMarket(now());
}

function handleBookUpdate(snapshot: import('../ingestion/types.js').ParsedBookSnapshot): void {
  const marketId = tokenToMarketId.get(snapshot.token_id);
  if (!marketId) return;

  const market = state.getMarket(marketId);
  if (!market) return;

  // Fix market_id to match state key
  snapshot.market_id = market.market_id;
  state.updateMarket(snapshot);

  // Feed to classifier and propagation model
  const side = market.tokens.yes_id === snapshot.token_id ? 'yes' : 'no';
  const updatedMarket = state.getMarket(market.market_id);
  if (updatedMarket) {
    const obs = marketClassifier.getObservations(market.market_id);
    recordBookUpdate(obs, updatedMarket, side as 'yes' | 'no');

    if (updatedMarket.complement_gap_executable !== 0) {
      recordComplementGap(
        obs, snapshot.timestamp,
        Math.abs(updatedMarket.complement_gap_executable),
        workerConfig.fee_rate,
      );
    }

    const mid = side === 'yes' ? updatedMarket.book.yes.mid : updatedMarket.book.no.mid;
    propagationModel.onPriceUpdate(
      market.market_id, mid, snapshot.timestamp, state.market_graph,
    );
  }
}

function handleTrade(trade: import('../ingestion/types.js').ParsedTrade): void {
  const marketId = tokenToMarketId.get(trade.token_id);
  if (!marketId) return;

  const market = state.getMarket(marketId);
  if (!market) return;

  trade.market_id = market.market_id;
  state.updateMarketFromTrade(trade);

  const obs = marketClassifier.getObservations(market.market_id);
  const sizeUsd = trade.price * trade.size;
  recordTrade(obs, trade.timestamp, sizeUsd, trade.maker ?? '', trade.taker ?? '', null);
}

function handleWalletTrade(tx: import('../ingestion/types.js').WalletTransaction): void {
  const resolved = state.resolveWalletTradeMarket(tx);
  if (!resolved) return;
  state.recordWalletTradeWithRegime(resolved);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

port.on('message', (msg: MainToWorkerMessage) => {
  switch (msg.type) {
    case 'init':
      init(msg.config);
      break;

    case 'market_registered':
      handleMarketRegistered(msg);
      break;

    case 'book_update':
      handleBookUpdate(msg.data);
      break;

    case 'book_update_batch':
      for (const snapshot of msg.data) {
        handleBookUpdate(snapshot);
      }
      break;

    case 'trade':
      handleTrade(msg.data);
      break;

    case 'wallet_trade':
      handleWalletTrade(msg.data);
      break;

    case 'market_resolved':
      state.regimeDetector.recordResolution(now());
      break;
  }
});

// Diagnostics: send stats to main thread every 30s
setInterval(() => {
  const markets = state.getAllMarkets();
  const marketsWithBooks = markets.filter(
    m => m.book.yes.mid > 0 || m.book.no.mid > 0,
  ).length;

  send({
    type: 'diagnostics',
    data: {
      strategy_ticks: strategyTickCount,
      markets_classified: marketClassifier.classifications.size,
      markets_with_edge: marketClassifier.buildEdgeMap(
        (workerConfig?.max_total_exposure_pct ?? 0.8) * 10_000,
      ).markets_with_edge.length,
      markets_evaluated_last_tick: lastTickEvaluated,
      signals_generated_total: totalSignalsGenerated,
      signals_filtered_total: totalSignalsFiltered,
      consistency_violations: lastConsistencyChecks.filter(c => c.tradeable).length,
      tick_elapsed_ms: lastTickElapsedMs,
      state_markets: markets.length,
      state_markets_with_books: marketsWithBooks,
    },
  });
}, 30_000);

log.info('Computation worker loaded, waiting for init');
