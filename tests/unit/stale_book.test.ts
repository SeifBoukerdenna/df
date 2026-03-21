import { describe, it, expect, beforeEach } from 'vitest';
import {
  StaleBookStrategy,
  resetStaleBookSeq,
} from '../../src/strategy/stale_book.js';
import type {
  PropagationProvider,
  PendingPropagation,
} from '../../src/strategy/stale_book.js';
import type { PairPropagationStats, PropagationEvent } from '../../src/analytics/propagation_model.js';
import type { StrategyContext } from '../../src/strategy/types.js';
import type {
  MarketState,
  WorldState,
} from '../../src/state/types.js';
import type {
  EdgeMapEntry,
  MarketClassification,
  MarketFeatures,
} from '../../src/analytics/types.js';
import type { StrategyConfig } from '../../src/utils/config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeBook(mid: number, spread: number, lastUpdated: number = NOW) {
  const halfSpread = spread / 2;
  return {
    bids: [[mid - halfSpread, 200]] as [number, number][],
    asks: [[mid + halfSpread, 200]] as [number, number][],
    mid,
    spread,
    spread_bps: mid > 0 ? (spread / mid) * 10_000 : 0,
    imbalance: 0,
    imbalance_weighted: 0,
    top_of_book_stability_ms: 5000,
    queue_depth_at_best: 200,
    microprice: mid,
    last_updated: lastUpdated,
  };
}

function makeMarket(overrides: Partial<MarketState> = {}): MarketState {
  return {
    market_id: 'mkt_target',
    question: 'Will Y happen?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes', no_id: 'tok_no' },
    status: 'active',
    resolution: null,
    end_date: '2026-12-31',
    category: 'politics',
    tags: [],
    book: {
      yes: makeBook(0.50, 0.02, NOW - 40_000), // stale: 40s old
      no: makeBook(0.50, 0.02, NOW - 40_000),
    },
    last_trade_price: { yes: 0.50, no: 0.50 },
    volume_24h: 100_000,
    volume_1h: 5_000,
    trade_count_1h: 50,
    liquidity_score: 0.7,
    complement_gap: 0,
    complement_gap_executable: 0,
    staleness_ms: 40_000,
    volatility_1h: 0.02,
    autocorrelation_1m: 0,
    related_markets: ['mkt_source'],
    event_cluster_id: null,
    updated_at: NOW - 40_000,
    ...overrides,
  } as MarketState;
}

function makePairStats(overrides: Partial<PairPropagationStats> = {}): PairPropagationStats {
  return {
    source_market_id: 'mkt_source',
    target_market_id: 'mkt_target',
    n_events: 50,
    median_lag_ms: 10_000,
    p25_lag_ms: 5_000,
    p75_lag_ms: 15_000,
    mean_lag_ms: 10_000,
    median_efficiency: 0.3,
    mean_efficiency: 0.3,
    exploitable: true,
    estimated_execution_ms: 3_000,
    last_updated: NOW - 60_000,
    ...overrides,
  };
}

function makePending(overrides: Partial<PendingPropagation> = {}): PendingPropagation {
  return {
    source_market_id: 'mkt_source',
    source_move: 0.15, // +15% up (needs to be large enough for edge > min_ev)
    source_move_sigma: 2.5,
    move_timestamp: NOW - 5_000, // 5s ago
    target_price_at_move: 0.50,
    correlation: 0.8,
    ...overrides,
  };
}

function makeEvents(count: number = 20): PropagationEvent[] {
  const events: PropagationEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({
      source_market_id: 'mkt_source',
      target_market_id: 'mkt_target',
      timestamp: NOW - 3_600_000 + i * 60_000,
      source_move: 0.04 + Math.random() * 0.02,
      source_move_sigma: 2.0 + Math.random(),
      propagation_lag_ms: 5_000 + Math.random() * 10_000, // 5s–15s
      propagation_efficiency: 0.3,
      target_move: 0.03 + Math.random() * 0.01,
    });
  }
  return events;
}

function makeProvider(
  stats: PairPropagationStats | null = makePairStats(),
  events: PropagationEvent[] = makeEvents(),
  pending: PendingPropagation[] = [makePending()],
): PropagationProvider {
  return {
    computePairStats: () => stats,
    getEventsForPair: () => events,
    getActivePendingForTarget: () => pending,
  };
}

function makeFeatures(overrides: Partial<MarketFeatures> = {}): MarketFeatures {
  return {
    market_id: 'mkt_target',
    computed_at: NOW,
    spread_avg_abs: 0.02,
    spread_avg_bps: 400,
    spread_cv: 0.3,
    spread_regime: 'normal',
    avg_update_interval_ms: 10_000, // 10s → stale threshold = 20s
    book_staleness_ms_avg: 2000,
    bid_depth_1pct: 500,
    ask_depth_1pct: 500,
    bid_depth_5pct: 2000,
    ask_depth_5pct: 2000,
    depth_herfindahl_bid: 0.3,
    depth_herfindahl_ask: 0.3,
    queue_depth_at_best_bid: 200,
    queue_depth_at_best_ask: 200,
    trade_rate_per_min: 2,
    avg_trade_size_usd: 50,
    trade_arrival_dispersion: 1.5,
    complement_gap_half_life_ms: null,
    complement_gap_frequency_per_hour: 0,
    complement_gap_median_size: 0,
    wallet_concentration_hhi: 0.1,
    dominant_wallet_address: null,
    dominant_wallet_share: 0,
    bot_ratio: 0.3,
    breakeven_latency_ms: null,
    edge_halflife_ms: null,
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, unknown> = {}): StrategyConfig {
  return {
    enabled: true,
    paper_only: true,
    capital_allocation: 0.10,
    max_position_size: 200,
    min_ev_threshold: 0.02,
    max_concurrent_positions: 3,
    cooldown_after_loss_ms: 60_000,
    allowed_regimes: ['normal', 'low_liquidity'],
    min_statistical_confidence_t: 1.645,
    max_parameter_sensitivity: 0.20,
    signal_half_life_ms: 15_000,
    ...overrides,
  };
}

function makeClassification(
  features: MarketFeatures = makeFeatures(),
): MarketClassification {
  return {
    market_id: 'mkt_target',
    market_type: 2,
    confidence: 0.8,
    efficiency_score: 0.5,
    viable_strategies: ['stale_book'],
    classified_at: NOW,
    features,
  };
}

function makeEdge(): EdgeMapEntry {
  return {
    market_id: 'mkt_target',
    market_type: 2,
    efficiency_score: 0.5,
    viable_strategies: ['stale_book'],
    estimated_edge_per_trade: 0.03,
    estimated_edge_confidence: 0.7,
    capital_allocated: 1000,
    breakeven_latency_ms: 5000,
  };
}

function makeWorld(market: MarketState): WorldState {
  return {
    markets: new Map([[market.market_id, market]]),
    wallets: new Map(),
    own_positions: new Map(),
    market_graph: { edges: new Map(), clusters: [] },
    regime: {
      current_regime: 'normal',
      regime_since: NOW - 3_600_000,
      confidence: 0.9,
      features: {
        avg_spread_z_score: 0,
        volume_z_score: 0,
        wallet_activity_z_score: 0,
        resolution_rate: 0,
        new_market_rate: 0,
      },
    },
    system_clock: NOW,
  };
}

function makeCtx(
  market: MarketState = makeMarket(),
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    world: makeWorld(market),
    market,
    classification: makeClassification(),
    edge: makeEdge(),
    existing_positions: [],
    regime: 'normal',
    config: makeConfig(),
    measured_latency_ms: 3_000,
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StaleBookStrategy', () => {
  beforeEach(() => resetStaleBookSeq());

  describe('basic signal generation', () => {
    it('generates a BUY YES signal when source moves up with positive correlation', () => {
      const provider = makeProvider();
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);

      const s = signals[0]!;
      expect(s.strategy_id).toBe('stale_book');
      expect(s.direction).toBe('BUY');
      expect(s.token_id).toBe('tok_yes'); // positive direction → YES
      expect(s.ev_estimate).toBeGreaterThan(0);
      expect(s.urgency).toBe('immediate');
    });

    it('generates a BUY NO signal when source moves up with negative correlation', () => {
      const provider = makeProvider(
        makePairStats(),
        makeEvents(),
        [makePending({ correlation: -0.8, source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);

      const s = signals[0]!;
      expect(s.direction).toBe('BUY');
      expect(s.token_id).toBe('tok_no'); // negative direction → NO
    });

    it('generates BUY NO when source moves down with positive correlation', () => {
      const provider = makeProvider(
        makePairStats(),
        makeEvents(),
        [makePending({ correlation: 0.8, source_move: -0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.token_id).toBe('tok_no');
    });
  });

  describe('no pending propagations', () => {
    it('returns empty when no pending moves target this market', () => {
      const provider = makeProvider(makePairStats(), makeEvents(), []);
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('confidence filter — n_events > 30', () => {
    it('skips pairs with fewer than 30 propagation events', () => {
      const provider = makeProvider(
        makePairStats({ n_events: 20 }),
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('generates signal at exactly 30 events', () => {
      const provider = makeProvider(
        makePairStats({ n_events: 30 }),
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      expect(strategy.evaluate(ctx)).toHaveLength(1);
    });

    it('allows custom min events via config', () => {
      const provider = makeProvider(
        makePairStats({ n_events: 15 }),
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx(makeMarket(), {
        config: makeConfig({ min_propagation_events: 10 }),
      });

      expect(strategy.evaluate(ctx)).toHaveLength(1);
    });
  });

  describe('direction confidence — |correlation| > 0.5', () => {
    it('skips when |correlation| <= 0.5', () => {
      const provider = makeProvider(
        makePairStats(),
        makeEvents(),
        [makePending({ correlation: 0.4 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('passes at exactly 0.51', () => {
      const provider = makeProvider(
        makePairStats(),
        makeEvents(),
        [makePending({ correlation: 0.51 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      expect(strategy.evaluate(ctx)).toHaveLength(1);
    });

    it('handles negative correlations correctly', () => {
      const provider = makeProvider(
        makePairStats(),
        makeEvents(),
        [makePending({ correlation: -0.7 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      // Source moved up, negative correlation → expect down → BUY NO
      expect(signals[0]!.token_id).toBe('tok_no');
    });
  });

  describe('staleness confirmation', () => {
    it('skips when book is not stale enough', () => {
      // Make book recently updated (5s ago) with avg update interval 10s
      // staleness threshold = 10s × 2 = 20s, current staleness = 5s → skip
      const market = makeMarket({
        book: {
          yes: makeBook(0.50, 0.02, NOW - 5_000),
          no: makeBook(0.50, 0.02, NOW - 5_000),
        },
      });
      const provider = makeProvider();
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('uses staleness_threshold_ms config when avg_update_interval is 0', () => {
      const market = makeMarket({
        book: {
          yes: makeBook(0.50, 0.02, NOW - 25_000),
          no: makeBook(0.50, 0.02, NOW - 25_000),
        },
      });
      const features = makeFeatures({ avg_update_interval_ms: 0 });
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx(market, {
        classification: makeClassification(features),
        config: makeConfig({ staleness_threshold_ms: 20_000 }),
      });

      expect(strategy.evaluate(ctx)).toHaveLength(1);
    });

    it('uses most recent book side to compute staleness', () => {
      // YES updated recently, NO is old — most recent update = YES at NOW - 5s
      // staleness = 5s < threshold 20s → skip
      const market = makeMarket({
        book: {
          yes: makeBook(0.50, 0.02, NOW - 5_000),
          no: makeBook(0.50, 0.02, NOW - 60_000),
        },
      });
      const provider = makeProvider();
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('exploitability gate', () => {
    it('skips when median lag <= measured execution latency', () => {
      const provider = makeProvider(
        makePairStats({ median_lag_ms: 2_000 }), // 2s < 3s latency
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('edge computation', () => {
    it('computes edge = |corr| × |move| × (1 - efficiency) - costs', () => {
      // |corr|=0.8, |move|=0.15, eff=0.3 → gross=0.8×0.15×0.7=0.084
      // costs = 0.02 fee + 0.01 halfSpread = 0.03
      // edge = 0.084 - 0.03 = 0.054
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ correlation: 0.8, source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);

      const expectedEdge = 0.8 * 0.15 * 0.7 - 0.02 - 0.01;
      expect(signals[0]!.ev_estimate).toBeCloseTo(expectedEdge, 6);
    });

    it('rejects when edge < min_ev_threshold', () => {
      // Small move → small edge → rejected
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.9 }), // high efficiency → low remaining edge
        makeEvents(),
        [makePending({ source_move: 0.02 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('generates signal with correct edge for large moves', () => {
      // |corr|=0.8, |move|=0.15, efficiency=0.3 → 0.8 × 0.15 × 0.7 = 0.084
      // costs = 0.02 + 0.01 = 0.03
      // edge = 0.084 - 0.03 = 0.054
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15, correlation: 0.8 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);

      const s = signals[0]!;
      const expectedEdge = 0.8 * 0.15 * 0.7 - 0.02 - 0.01;
      expect(s.ev_estimate).toBeCloseTo(expectedEdge, 6);
      expect(s.ev_after_costs).toBe(s.ev_estimate);
    });
  });

  describe('size based on historical edge', () => {
    it('scales size with historical edge at this lag', () => {
      // Events with high target moves → high historical edge → larger size scalar
      const highEdgeEvents: PropagationEvent[] = [];
      for (let i = 0; i < 20; i++) {
        highEdgeEvents.push({
          source_market_id: 'mkt_source',
          target_market_id: 'mkt_target',
          timestamp: NOW - 1_000_000 + i * 10_000,
          source_move: 0.10,
          source_move_sigma: 2.5,
          propagation_lag_ms: 8_000, // within p25–p75 (5k–15k)
          propagation_efficiency: 0.3,
          target_move: 0.07, // high target move → 0.07 - 0.02 = 0.05 edge per event
        });
      }
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        highEdgeEvents,
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      // historicalEdge ≈ 0.05 → scalar = clamp(0.05 / 0.05, 0.2, 1.0) = 1.0
      // size = max(1, 200 * 1.0) = 200
      expect(signals[0]!.size_requested).toBe(200);
    });

    it('uses minimum size scalar when historical edge is unclear', () => {
      // Empty events → historicalEdge = 0 → scalar = 0.2
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        [],
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      // scalar = 0.2, size = max(1, 200 * 0.2) = 40
      expect(signals[0]!.size_requested).toBe(40);
    });
  });

  describe('kill conditions', () => {
    it('includes book update kill (price_moved with very small threshold)', () => {
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);

      const kc = signals[0]!.kill_conditions;
      const bookUpdateKill = kc.find(k => k.type === 'price_moved');
      expect(bookUpdateKill).toBeDefined();
      expect(bookUpdateKill!.threshold).toBe(0.001);
    });

    it('includes time limit at p75 lag', () => {
      const provider = makeProvider(
        makePairStats({ p75_lag_ms: 15_000, mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const kc = signals[0]!.kill_conditions;
      const timeKill = kc.find(k => k.type === 'time_elapsed');
      expect(timeKill).toBeDefined();
      expect(timeKill!.threshold).toBe(15_000);
    });

    it('includes ev_decayed at breakeven (= execution costs)', () => {
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const kc = signals[0]!.kill_conditions;
      const evKill = kc.find(k => k.type === 'ev_decayed');
      expect(evKill).toBeDefined();
      // execution costs = 0.02 fee + halfSpread
      expect(evKill!.threshold).toBeGreaterThan(0);
    });
  });

  describe('decay model', () => {
    it('sets half_life_ms from config', () => {
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals[0]!.decay_model.half_life_ms).toBe(15_000);
    });

    it('initial_ev equals the computed edge', () => {
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals[0]!.decay_model.initial_ev).toBe(signals[0]!.ev_estimate);
    });
  });

  describe('reasoning string', () => {
    it('includes source move, staleness, pair stats, and edge', () => {
      const provider = makeProvider(
        makePairStats({ n_events: 50, mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const reason = signals[0]!.reasoning;
      expect(reason).toContain('mkt_source');
      expect(reason).toContain('mkt_target');
      expect(reason).toContain('50 events');
      expect(reason).toContain('Edge:');
    });
  });

  describe('expected holding period', () => {
    it('equals max(0, median_lag - timeSinceMove)', () => {
      const provider = makeProvider(
        makePairStats({ median_lag_ms: 10_000, mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15, move_timestamp: NOW - 3_000 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      // median_lag=10s, timeSinceMove=3s → expected=7s
      expect(signals[0]!.expected_holding_period_ms).toBe(7_000);
    });

    it('floors at 0 when timeSinceMove exceeds median lag', () => {
      const provider = makeProvider(
        makePairStats({ median_lag_ms: 10_000, mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15, move_timestamp: NOW - 15_000 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals[0]!.expected_holding_period_ms).toBe(0);
    });
  });

  describe('null pair stats', () => {
    it('skips when pair stats are null (insufficient data)', () => {
      const provider = makeProvider(null);
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('book validation', () => {
    it('skips when target book has no asks', () => {
      const market = makeMarket();
      market.book.yes.asks = [];
      market.book.no.asks = [];

      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('skips when target book mid is 0', () => {
      const market = makeMarket();
      market.book.yes.mid = 0;
      market.book.no.mid = 0;

      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('multiple pending propagations', () => {
    it('generates signals for each qualifying pending move', () => {
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [
          makePending({ source_market_id: 'src_1', source_move: 0.15, correlation: 0.8 }),
          makePending({ source_market_id: 'src_2', source_move: -0.12, correlation: -0.7 }),
        ],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(2);
      // Both should predict UP (pos×pos and neg×neg both → positive direction)
      expect(signals[0]!.token_id).toBe('tok_yes');
      expect(signals[1]!.token_id).toBe('tok_yes');
    });
  });

  describe('signal strength', () => {
    it('is between 0.01 and 1.0', () => {
      const provider = makeProvider(
        makePairStats({ mean_efficiency: 0.3 }),
        makeEvents(),
        [makePending({ source_move: 0.15 })],
      );
      const strategy = new StaleBookStrategy(provider);
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const strength = signals[0]!.signal_strength;
      expect(strength).toBeGreaterThanOrEqual(0.01);
      expect(strength).toBeLessThanOrEqual(1.0);
    });
  });
});
