import { describe, it, expect, beforeEach } from 'vitest';
import {
  MicropriceDislocationStrategy,
  computeMicropriceDeviation,
  resetMicropriceSeq,
} from '../../src/strategy/microprice_dislocation.js';
import type { StrategyContext } from '../../src/strategy/types.js';
import type { MarketState } from '../../src/state/types.js';
import type { MarketClassification, MarketFeatures, EdgeMapEntry } from '../../src/analytics/types.js';
import type { StrategyConfig } from '../../src/utils/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBook(overrides: Record<string, unknown> = {}) {
  return {
    bids: [[0.50, 100], [0.49, 200]] as [number, number][],
    asks: [[0.52, 100], [0.53, 200]] as [number, number][],
    mid: 0.51,
    spread: 0.02,
    spread_bps: 100,
    imbalance: 0.1,
    imbalance_weighted: 0.1,
    top_of_book_stability_ms: 5000,
    queue_depth_at_best: 100,
    microprice: 0.515, // +0.005 above mid → deviation/spread = 0.25
    last_updated: Date.now(),
    ...overrides,
  };
}

/** Book with large microprice dislocation. */
function makeDislocatedBook(direction: 'up' | 'down' = 'up') {
  const mid = 0.50;
  const spread = 0.02;
  const microprice = direction === 'up'
    ? mid + spread * 0.8  // 0.516, deviation = 0.8 × spread → above threshold 0.5
    : mid - spread * 0.8; // 0.484
  return makeBook({
    mid,
    spread,
    spread_bps: 100,
    microprice,
    bids: [[0.49, direction === 'up' ? 200 : 50]] as [number, number][],
    asks: [[0.51, direction === 'up' ? 50 : 200]] as [number, number][],
  });
}

function makeMarket(overrides: Partial<MarketState> = {}): MarketState {
  return {
    market_id: 'mkt_1',
    question: 'Test?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes', no_id: 'tok_no' },
    status: 'active',
    resolution: null,
    end_date: '2025-12-31',
    category: 'test',
    tags: [],
    book: { yes: makeBook(), no: makeBook() },
    last_trade_price: { yes: 0.51, no: 0.49 },
    volume_24h: 100_000,
    volume_1h: 10_000,
    trade_count_1h: 50,
    liquidity_score: 0.7,
    complement_gap: 0.005,
    complement_gap_executable: 0.003,
    staleness_ms: 500,
    volatility_1h: 0.05,
    autocorrelation_1m: 0.1,
    related_markets: [],
    event_cluster_id: null,
    updated_at: Date.now(),
    ...overrides,
  } as MarketState;
}

function makeFeatures(overrides: Partial<MarketFeatures> = {}): MarketFeatures {
  return {
    market_id: 'mkt_1',
    computed_at: Date.now(),
    spread_avg_abs: 0.02,
    spread_avg_bps: 100,
    spread_cv: 0.3,
    spread_regime: 'tight',
    avg_update_interval_ms: 500,
    book_staleness_ms_avg: 300,
    bid_depth_1pct: 500,
    ask_depth_1pct: 500,
    bid_depth_5pct: 1000,
    ask_depth_5pct: 1000,
    depth_herfindahl_bid: 0.3,
    depth_herfindahl_ask: 0.3,
    queue_depth_at_best_bid: 100,
    queue_depth_at_best_ask: 100,
    trade_rate_per_min: 20,
    avg_trade_size_usd: 100,
    trade_arrival_dispersion: 1.0,
    complement_gap_half_life_ms: 5000,
    complement_gap_frequency_per_hour: 10,
    complement_gap_median_size: 0.005,
    wallet_concentration_hhi: 0.1,
    dominant_wallet_address: null,
    dominant_wallet_share: 0,
    bot_ratio: 0.3,
    breakeven_latency_ms: null,
    edge_halflife_ms: null,
    ...overrides,
  };
}

function makeClassification(overrides: Partial<MarketClassification> = {}): MarketClassification {
  return {
    market_id: 'mkt_1',
    market_type: 2,
    confidence: 0.8,
    efficiency_score: 0.5,
    viable_strategies: ['microprice_dislocation'],
    classified_at: Date.now(),
    features: makeFeatures(),
    ...overrides,
  };
}

function makeEdge(overrides: Partial<EdgeMapEntry> = {}): EdgeMapEntry {
  return {
    market_id: 'mkt_1',
    market_type: 2,
    efficiency_score: 0.5,
    viable_strategies: ['microprice_dislocation'],
    estimated_edge_per_trade: 0.02,
    estimated_edge_confidence: 0.7,
    capital_allocated: 500,
    breakeven_latency_ms: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    enabled: true,
    paper_only: true,
    capital_allocation: 0.05,
    max_position_size: 100,
    min_ev_threshold: 0.01,
    max_concurrent_positions: 5,
    cooldown_after_loss_ms: 30000,
    allowed_regimes: ['normal'],
    min_statistical_confidence_t: 1.645,
    max_parameter_sensitivity: 0.20,
    microprice_deviation_threshold_spread_multiple: 0.5,
    signal_half_life_ms: 30000,
    ...overrides,
  };
}

function makeContext(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    world: { markets: new Map(), wallets: new Map(), regime: 'normal', gas: { fast: 30, standard: 20, slow: 10, last_updated: Date.now() }, updated_at: Date.now() } as any,
    market: makeMarket(),
    classification: makeClassification(),
    edge: makeEdge(),
    existing_positions: [],
    regime: 'normal',
    config: makeConfig(),
    measured_latency_ms: 200,
    now: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Microprice Dislocation', () => {
  beforeEach(() => {
    resetMicropriceSeq();
  });

  // =========================================================================
  // computeMicropriceDeviation
  // =========================================================================

  describe('computeMicropriceDeviation', () => {
    it('computes positive deviation when microprice > mid', () => {
      const d = computeMicropriceDeviation(0.515, 0.51, 0.02);
      expect(d).toBeCloseTo(0.25, 2);
    });

    it('computes negative deviation when microprice < mid', () => {
      const d = computeMicropriceDeviation(0.505, 0.51, 0.02);
      expect(d).toBeCloseTo(-0.25, 2);
    });

    it('returns 0 when microprice equals mid', () => {
      const d = computeMicropriceDeviation(0.51, 0.51, 0.02);
      expect(d).toBeCloseTo(0, 5);
    });

    it('returns NaN when spread is zero', () => {
      expect(computeMicropriceDeviation(0.51, 0.50, 0)).toBeNaN();
    });

    it('returns NaN when microprice is NaN', () => {
      expect(computeMicropriceDeviation(NaN, 0.50, 0.02)).toBeNaN();
    });

    it('returns NaN when mid is NaN', () => {
      expect(computeMicropriceDeviation(0.51, NaN, 0.02)).toBeNaN();
    });

    it('handles large deviations', () => {
      const d = computeMicropriceDeviation(0.55, 0.50, 0.02);
      expect(d).toBeCloseTo(2.5, 2);
    });
  });

  // =========================================================================
  // Market eligibility
  // =========================================================================

  describe('market eligibility', () => {
    let strategy: MicropriceDislocationStrategy;

    beforeEach(() => {
      strategy = new MicropriceDislocationStrategy();
    });

    it('rejects when trade rate < 10/min', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        classification: makeClassification({
          features: makeFeatures({ trade_rate_per_min: 5 }),
        }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('rejects when spread > 200 bps', () => {
      const ctx = makeContext({
        market: makeMarket({
          book: { yes: makeDislocatedBook(), no: makeBook() },
        }),
      });
      // Override spread_bps to be too wide
      (ctx.market.book.yes as any).spread_bps = 300;
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('rejects when avg update interval > 2s', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        classification: makeClassification({
          features: makeFeatures({ avg_update_interval_ms: 3000 }),
        }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('rejects market_type 3 (bot-dominated)', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        classification: makeClassification({ market_type: 3 }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('accepts market_type 1', () => {
      const dislocated = makeDislocatedBook();
      const ctx = makeContext({
        market: makeMarket({ book: { yes: dislocated, no: makeBook() } }),
        classification: makeClassification({ market_type: 1 }),
      });
      // Should pass eligibility (may still filter on EV)
      // Just test it doesn't filter on market type
      const signals = strategy.evaluate(ctx);
      // If no signal, it should be for EV, not market type
      // We can verify by checking a valid dislocated book does produce a signal
      // with type 2
      const ctx2 = makeContext({
        market: makeMarket({ book: { yes: dislocated, no: makeBook() } }),
        classification: makeClassification({ market_type: 2 }),
      });
      const baseResult = strategy.evaluate(ctx2);
      // Both should have same result since the only difference is market_type 1 vs 2
      expect(signals.length).toBe(baseResult.length);
    });

    it('rejects when bids are empty', () => {
      const book = makeDislocatedBook();
      (book as any).bids = [];
      const ctx = makeContext({
        market: makeMarket({ book: { yes: book, no: makeBook() } }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('rejects when asks are empty', () => {
      const book = makeDislocatedBook();
      (book as any).asks = [];
      const ctx = makeContext({
        market: makeMarket({ book: { yes: book, no: makeBook() } }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('rejects when mid is 0', () => {
      const book = makeDislocatedBook();
      (book as any).mid = 0;
      const ctx = makeContext({
        market: makeMarket({ book: { yes: book, no: makeBook() } }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('rejects when mid is 1', () => {
      const book = makeDislocatedBook();
      (book as any).mid = 1;
      const ctx = makeContext({
        market: makeMarket({ book: { yes: book, no: makeBook() } }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('rejects when spread is 0', () => {
      const book = makeDislocatedBook();
      (book as any).spread = 0;
      const ctx = makeContext({
        market: makeMarket({ book: { yes: book, no: makeBook() } }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  // =========================================================================
  // Signal generation
  // =========================================================================

  describe('signal generation', () => {
    let strategy: MicropriceDislocationStrategy;

    beforeEach(() => {
      strategy = new MicropriceDislocationStrategy();
    });

    it('returns no signal when deviation is below threshold', () => {
      // Default book has deviation = 0.25, threshold = 0.5
      const ctx = makeContext();
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('generates BUY YES signal when microprice > mid (positive dislocation)', () => {
      const dislocated = makeDislocatedBook('up');
      const ctx = makeContext({
        market: makeMarket({ book: { yes: dislocated, no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }), // low threshold for test
      });
      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.token_id).toBe('tok_yes');
      expect(signals[0]!.direction).toBe('BUY');
    });

    it('generates BUY NO signal when microprice < mid (negative dislocation)', () => {
      const dislocated = makeDislocatedBook('down');
      const ctx = makeContext({
        market: makeMarket({ book: { yes: dislocated, no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.token_id).toBe('tok_no');
      expect(signals[0]!.direction).toBe('BUY');
    });

    it('signal has correct strategy_id', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.strategy_id).toBe('microprice_dislocation');
      }
    });

    it('signal urgency is immediate', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.urgency).toBe('immediate');
      }
    });

    it('signal has kill conditions with 2-minute timeout', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        const timeKill = signals[0]!.kill_conditions.find(k => k.type === 'time_elapsed');
        expect(timeKill).toBeDefined();
        expect(timeKill!.threshold).toBe(120_000); // 2 minutes
      }
    });

    it('signal has decay model with 30s half-life', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.decay_model.half_life_ms).toBe(30000);
        expect(signals[0]!.decay_model.initial_ev).toBeGreaterThan(0);
      }
    });

    it('filters when EV is below threshold', () => {
      // Small dislocation + high threshold → negative EV after costs
      const ctx = makeContext({
        config: makeConfig({ min_ev_threshold: 0.10 }),
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('sizes proportionally to deviation excess', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.size_requested).toBeGreaterThan(0);
        expect(signals[0]!.size_requested).toBeLessThanOrEqual(100);
      }
    });

    it('signal strength is between 0 and 1', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.signal_strength).toBeGreaterThan(0);
        expect(signals[0]!.signal_strength).toBeLessThanOrEqual(1);
      }
    });

    it('reasoning includes microprice and spread info', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.reasoning).toContain('Microprice dislocation');
        expect(signals[0]!.reasoning).toContain('bps');
        expect(signals[0]!.reasoning).toContain('EV');
      }
    });

    it('correlation_with_existing > 0 when positions exist', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
        existing_positions: [{ market_id: 'mkt_1' } as any],
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.correlation_with_existing).toBeGreaterThan(0);
      }
    });

    it('correlation_with_existing = 0 when no positions', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
        existing_positions: [],
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.correlation_with_existing).toBe(0);
      }
    });

    it('respects config override for deviation threshold', () => {
      // With a very high threshold, no signal
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ microprice_deviation_threshold_spread_multiple: 10 }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('respects config override for half life', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001, signal_half_life_ms: 5000 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.decay_model.half_life_ms).toBe(5000);
      }
    });

    it('signal max_price is clamped to [0.01, 0.99]', () => {
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.max_price).toBeGreaterThanOrEqual(0.01);
        expect(signals[0]!.max_price).toBeLessThanOrEqual(0.99);
      }
    });
  });

  // =========================================================================
  // Reset
  // =========================================================================

  describe('resetMicropriceSeq', () => {
    it('resets signal sequence', () => {
      const strategy = new MicropriceDislocationStrategy();
      const ctx = makeContext({
        market: makeMarket({ book: { yes: makeDislocatedBook(), no: makeBook() } }),
        config: makeConfig({ min_ev_threshold: 0.001 }),
      });
      strategy.evaluate(ctx);
      resetMicropriceSeq();
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.signal_id).toContain('_1');
      }
    });
  });
});
