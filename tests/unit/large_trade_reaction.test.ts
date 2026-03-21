import { describe, it, expect, beforeEach } from 'vitest';
import {
  LargeTradeReactionStrategy,
  recordTradeSize,
  detectLargeTrade,
  recordImpactObservation,
  conditionalReversionProbability,
  getImpactModel,
  resetLargeTradeState,
  resetLargeTradeReactionSeq,
} from '../../src/strategy/large_trade_reaction.js';
import type { ImpactObservation, TradeDataProvider } from '../../src/strategy/large_trade_reaction.js';
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
    spread_bps: 200,
    imbalance: 0.1,
    imbalance_weighted: 0.1,
    top_of_book_stability_ms: 5000,
    queue_depth_at_best: 100,
    microprice: 0.512,
    last_updated: Date.now(),
    ...overrides,
  };
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
    spread_avg_bps: 200,
    spread_cv: 0.3,
    spread_regime: 'normal',
    avg_update_interval_ms: 1000,
    book_staleness_ms_avg: 500,
    bid_depth_1pct: 500,
    ask_depth_1pct: 500,
    bid_depth_5pct: 1000,
    ask_depth_5pct: 1000,
    depth_herfindahl_bid: 0.3,
    depth_herfindahl_ask: 0.3,
    queue_depth_at_best_bid: 100,
    queue_depth_at_best_ask: 100,
    trade_rate_per_min: 15,
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
    viable_strategies: ['large_trade_reaction'],
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
    viable_strategies: ['large_trade_reaction'],
    estimated_edge_per_trade: 0.03,
    estimated_edge_confidence: 0.7,
    capital_allocated: 1000,
    breakeven_latency_ms: null,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    enabled: true,
    paper_only: true,
    capital_allocation: 0.10,
    max_position_size: 200,
    min_ev_threshold: 0.02,
    max_concurrent_positions: 3,
    cooldown_after_loss_ms: 180000,
    allowed_regimes: ['normal', 'high_volatility'],
    min_statistical_confidence_t: 1.645,
    max_parameter_sensitivity: 0.20,
    large_trade_sigma_threshold: 2.0,
    signal_half_life_ms: 60000,
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
    measured_latency_ms: 500,
    now: Date.now(),
    ...overrides,
  };
}

/** Build a reversion-dominant impact model for a market. */
function seedReversionModel(
  marketId: string,
  count: number = 25,
): void {
  // Seed size distribution first (tight around 75)
  for (let i = 0; i < 50; i++) {
    recordTradeSize(marketId, 70 + (i % 10));
  }

  for (let i = 0; i < count; i++) {
    const obs: ImpactObservation = {
      tradeTs: Date.now() - (count - i) * 60_000,
      tradeDirection: 1,
      tradeSize: 200,
      tradeSigma: 2.5,
      preBuyMid: 0.50,
      bookImbalance: 0.1,
      marketType: 2,
      // Large initial impact that fades → reversion
      impacts: [0.10, 0.06, 0.03, 0.015, 0.005],
    };
    recordImpactObservation(marketId, obs);
  }
}

/** Build a momentum-dominant impact model. */
function seedMomentumModel(
  marketId: string,
  count: number = 25,
): void {
  for (let i = 0; i < 50; i++) {
    recordTradeSize(marketId, 70 + (i % 10));
  }

  for (let i = 0; i < count; i++) {
    const obs: ImpactObservation = {
      tradeTs: Date.now() - (count - i) * 60_000,
      tradeDirection: 1,
      tradeSize: 200,
      tradeSigma: 2.5,
      preBuyMid: 0.50,
      bookImbalance: 0.1,
      marketType: 2,
      // Impact persists and grows → momentum
      impacts: [0.05, 0.06, 0.07, 0.08, 0.09],
    };
    recordImpactObservation(marketId, obs);
  }
}

function makeProvider(recentSizes: number[]): TradeDataProvider {
  return {
    getRecentTradeSizes: () => recentSizes,
    getMidPriceAt: () => null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Large Trade Reaction', () => {
  beforeEach(() => {
    resetLargeTradeState();
    resetLargeTradeReactionSeq();
  });

  // =========================================================================
  // recordTradeSize / detectLargeTrade
  // =========================================================================

  describe('recordTradeSize & detectLargeTrade', () => {
    it('returns null when insufficient distribution data', () => {
      recordTradeSize('mkt_1', 100);
      expect(detectLargeTrade('mkt_1', 500)).toBeNull();
    });

    it('returns null for normal-sized trades', () => {
      for (let i = 0; i < 20; i++) recordTradeSize('mkt_1', 100);
      expect(detectLargeTrade('mkt_1', 110)).toBeNull();
    });

    it('detects a trade > 2σ above mean', () => {
      // Seed with tight distribution around 100
      for (let i = 0; i < 50; i++) recordTradeSize('mkt_1', 100);
      // Now add a very large trade (need some variance first)
      for (let i = 0; i < 10; i++) recordTradeSize('mkt_1', 100 + i * 2);
      const z = detectLargeTrade('mkt_1', 500);
      expect(z).not.toBeNull();
      expect(z!).toBeGreaterThan(2.0);
    });

    it('respects custom sigma threshold', () => {
      for (let i = 0; i < 30; i++) recordTradeSize('mkt_1', 100 + (i % 10) * 5);
      // At 1σ threshold, smaller outliers should trigger
      const z1 = detectLargeTrade('mkt_1', 180, 1.0);
      const z3 = detectLargeTrade('mkt_1', 180, 5.0);
      expect(z1).not.toBeNull(); // passes at low threshold
      expect(z3).toBeNull(); // fails at high threshold
    });

    it('handles zero stddev distribution', () => {
      for (let i = 0; i < 20; i++) recordTradeSize('mkt_1', 100);
      expect(detectLargeTrade('mkt_1', 200)).toBeNull();
    });

    it('rolls off old entries beyond MAX_SIZE_DISTRIBUTION', () => {
      for (let i = 0; i < 600; i++) recordTradeSize('mkt_1', 100);
      // Distribution should be capped — check detect still works
      expect(detectLargeTrade('mkt_1', 100)).toBeNull();
    });
  });

  // =========================================================================
  // Impact model
  // =========================================================================

  describe('recordImpactObservation', () => {
    it('creates a new model for unknown market', () => {
      const obs: ImpactObservation = {
        tradeTs: Date.now(),
        tradeDirection: 1,
        tradeSize: 200,
        tradeSigma: 3.0,
        preBuyMid: 0.50,
        bookImbalance: 0.1,
        marketType: 2,
        impacts: [0.02, 0.015, 0.01, 0.005, 0.002],
      };
      recordImpactObservation('mkt_new', obs);
      const model = getImpactModel('mkt_new');
      expect(model).toBeDefined();
      expect(model!.observations).toHaveLength(1);
    });

    it('classifies as reversion when impact fades', () => {
      seedReversionModel('mkt_rev');
      const model = getImpactModel('mkt_rev')!;
      expect(model.classification).toBe('reversion');
      expect(model.reversionRate).toBeGreaterThan(0.5);
    });

    it('classifies as momentum when impact persists', () => {
      seedMomentumModel('mkt_mom');
      const model = getImpactModel('mkt_mom')!;
      expect(model.classification).toBe('momentum');
      expect(model.momentumRate).toBeGreaterThan(0.5);
    });

    it('classifies as inconclusive with mixed data', () => {
      // Alternate between reversion and momentum observations (equal count)
      for (let i = 0; i < 10; i++) {
        recordImpactObservation('mkt_mix', {
          tradeTs: Date.now() - i * 60_000,
          tradeDirection: 1,
          tradeSize: 200,
          tradeSigma: 2.5,
          preBuyMid: 0.50,
          bookImbalance: 0.1,
          marketType: 2,
          impacts: [0.10, 0.06, 0.03, 0.015, 0.005], // reversion
        });
        recordImpactObservation('mkt_mix', {
          tradeTs: Date.now() - i * 60_000 + 30_000,
          tradeDirection: 1,
          tradeSize: 200,
          tradeSigma: 2.5,
          preBuyMid: 0.50,
          bookImbalance: 0.1,
          marketType: 2,
          impacts: [0.05, 0.06, 0.07, 0.08, 0.09], // momentum
        });
      }
      const model = getImpactModel('mkt_mix')!;
      expect(model.classification).toBe('inconclusive');
    });

    it('computes avgInitialImpact correctly', () => {
      for (let i = 0; i < 10; i++) {
        recordImpactObservation('mkt_avg', {
          tradeTs: Date.now() - i * 60_000,
          tradeDirection: 1,
          tradeSize: 200,
          tradeSigma: 2.5,
          preBuyMid: 0.50,
          bookImbalance: 0.1,
          marketType: 2,
          impacts: [0.10, 0.06, 0.03, 0.015, 0.005],
        });
      }
      const model = getImpactModel('mkt_avg')!;
      expect(model.avgInitialImpact).toBeCloseTo(0.10, 3);
    });
  });

  // =========================================================================
  // Conditional probability
  // =========================================================================

  describe('conditionalReversionProbability', () => {
    it('returns null for unknown market', () => {
      expect(conditionalReversionProbability('unknown', {})).toBeNull();
    });

    it('returns null with insufficient matching observations', () => {
      // Only 3 obs — below minimum of 5
      for (let i = 0; i < 3; i++) {
        recordImpactObservation('mkt_few', {
          tradeTs: Date.now() - i * 60_000,
          tradeDirection: 1,
          tradeSize: 200,
          tradeSigma: 2.5,
          preBuyMid: 0.50,
          bookImbalance: 0.1,
          marketType: 2,
          impacts: [0.03, 0.02, 0.01, 0.005, 0.002],
        });
      }
      expect(conditionalReversionProbability('mkt_few', { direction: 1 })).toBeNull();
    });

    it('filters by direction', () => {
      seedReversionModel('mkt_dir');
      // All seeded observations have direction = 1
      const probBuy = conditionalReversionProbability('mkt_dir', { direction: 1 });
      const probSell = conditionalReversionProbability('mkt_dir', { direction: -1 });
      expect(probBuy).not.toBeNull();
      expect(probSell).toBeNull(); // no sell observations
    });

    it('filters by market type', () => {
      seedReversionModel('mkt_type');
      const prob2 = conditionalReversionProbability('mkt_type', { marketType: 2 });
      const prob1 = conditionalReversionProbability('mkt_type', { marketType: 1 });
      expect(prob2).not.toBeNull();
      expect(prob2!).toBeGreaterThan(0.5);
      expect(prob1).toBeNull();
    });

    it('returns correct probability for full model', () => {
      seedReversionModel('mkt_prob', 30);
      const prob = conditionalReversionProbability('mkt_prob', {});
      expect(prob).not.toBeNull();
      expect(prob!).toBeGreaterThan(0.5);
      expect(prob!).toBeLessThanOrEqual(1.0);
    });
  });

  // =========================================================================
  // Strategy evaluate
  // =========================================================================

  describe('LargeTradeReactionStrategy.evaluate', () => {
    let strategy: LargeTradeReactionStrategy;

    beforeEach(() => {
      strategy = new LargeTradeReactionStrategy();
    });

    it('returns no signals without a provider', () => {
      seedReversionModel('mkt_1');
      const ctx = makeContext();
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('returns no signals when volume is too low', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([300]));
      const ctx = makeContext({
        market: makeMarket({ volume_24h: 1000 }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('returns no signals when trade count is too low', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([300]));
      const ctx = makeContext({
        market: makeMarket({ trade_count_1h: 2 }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('returns no signals when spread is too wide', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([300]));
      const ctx = makeContext({
        market: makeMarket({
          book: {
            yes: makeBook({ spread_bps: 600 }),
            no: makeBook(),
          },
        }),
      });
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('returns no signals when model has too few calibration events', () => {
      // Only seed 5 observations (need 20)
      for (let i = 0; i < 5; i++) {
        recordImpactObservation('mkt_1', {
          tradeTs: Date.now(),
          tradeDirection: 1,
          tradeSize: 200,
          tradeSigma: 2.5,
          preBuyMid: 0.50,
          bookImbalance: 0.1,
          marketType: 2,
          impacts: [0.03, 0.02, 0.01, 0.005, 0.002],
        });
      }
      for (let i = 0; i < 50; i++) recordTradeSize('mkt_1', 75);
      strategy.setProvider(makeProvider([300]));
      expect(strategy.evaluate(makeContext())).toHaveLength(0);
    });

    it('returns no signals when model is inconclusive', () => {
      // Mix momentum and reversion equally (even count)
      for (let i = 0; i < 24; i++) {
        recordImpactObservation('mkt_1', {
          tradeTs: Date.now() - i * 60_000,
          tradeDirection: 1,
          tradeSize: 200,
          tradeSigma: 2.5,
          preBuyMid: 0.50,
          bookImbalance: 0.1,
          marketType: 2,
          impacts: i % 2 === 0
            ? [0.10, 0.06, 0.03, 0.015, 0.005] // reversion
            : [0.05, 0.06, 0.07, 0.08, 0.09], // momentum
        });
      }
      for (let i = 0; i < 50; i++) recordTradeSize('mkt_1', 75);
      strategy.setProvider(makeProvider([300]));
      const model = getImpactModel('mkt_1');
      expect(model?.classification).toBe('inconclusive');
      expect(strategy.evaluate(makeContext())).toHaveLength(0);
    });

    it('returns no signals when latest trade is not large', () => {
      seedReversionModel('mkt_1');
      // Provider returns normal-sized trade
      strategy.setProvider(makeProvider([80]));
      expect(strategy.evaluate(makeContext())).toHaveLength(0);
    });

    it('generates a reversion signal for reversion model', () => {
      seedReversionModel('mkt_1');
      // Ensure the size distribution allows detection
      strategy.setProvider(makeProvider([500]));
      const ctx = makeContext();
      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      const sig = signals[0]!;
      expect(sig.strategy_id).toBe('large_trade_reaction');
      expect(sig.urgency).toBe('patient');
      expect(sig.ev_estimate).toBeGreaterThan(0);
      expect(sig.reasoning).toContain('reversion');
    });

    it('generates a momentum signal for momentum model', () => {
      seedMomentumModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const ctx = makeContext();
      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      const sig = signals[0]!;
      expect(sig.strategy_id).toBe('large_trade_reaction');
      expect(sig.urgency).toBe('immediate');
      expect(sig.reasoning).toContain('momentum');
    });

    it('signal has correct kill conditions', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const signals = strategy.evaluate(makeContext());
      expect(signals).toHaveLength(1);
      const sig = signals[0]!;
      expect(sig.kill_conditions.length).toBeGreaterThan(0);
      const types = sig.kill_conditions.map(k => k.type);
      expect(types).toContain('time_elapsed');
      expect(types).toContain('spread_widened');
      expect(types).toContain('ev_decayed');
    });

    it('signal has decay model', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const signals = strategy.evaluate(makeContext());
      expect(signals[0]!.decay_model.half_life_ms).toBe(60000);
      expect(signals[0]!.decay_model.initial_ev).toBeGreaterThan(0);
    });

    it('filters when EV is below threshold', () => {
      // Build a model with very small impacts that won't clear costs
      for (let i = 0; i < 30; i++) {
        recordImpactObservation('mkt_1', {
          tradeTs: Date.now() - i * 60_000,
          tradeDirection: 1,
          tradeSize: 200,
          tradeSigma: 2.5,
          preBuyMid: 0.50,
          bookImbalance: 0.1,
          marketType: 2,
          impacts: [0.005, 0.003, 0.002, 0.001, 0.0005], // tiny impacts
        });
      }
      for (let i = 0; i < 50; i++) recordTradeSize('mkt_1', 75);
      strategy.setProvider(makeProvider([500]));
      expect(strategy.evaluate(makeContext())).toHaveLength(0);
    });

    it('skips when asks are empty on entry book', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const market = makeMarket({
        book: {
          yes: makeBook({ asks: [] }),
          no: makeBook({ asks: [] }),
        },
      });
      expect(strategy.evaluate(makeContext({ market }))).toHaveLength(0);
    });

    it('respects config overrides for sigma threshold', () => {
      seedReversionModel('mkt_1');
      // Use a mildly large trade (z ≈ 2.6), passes at threshold 2 but not 5
      strategy.setProvider(makeProvider([82]));
      // Baseline: generates signal with default threshold 2.0
      const baseSignals = strategy.evaluate(makeContext());
      expect(baseSignals).toHaveLength(1);
      // With high threshold: no signal
      resetLargeTradeReactionSeq();
      const config = makeConfig({ large_trade_sigma_threshold: 5.0 });
      expect(strategy.evaluate(makeContext({ config }))).toHaveLength(0);
    });

    it('sizes proportionally to z-score and model confidence', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const signals = strategy.evaluate(makeContext());
      expect(signals).toHaveLength(1);
      expect(signals[0]!.size_requested).toBeGreaterThan(0);
      expect(signals[0]!.size_requested).toBeLessThanOrEqual(200);
    });

    it('signal strength is between 0 and 1', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const signals = strategy.evaluate(makeContext());
      expect(signals[0]!.signal_strength).toBeGreaterThan(0);
      expect(signals[0]!.signal_strength).toBeLessThanOrEqual(1);
    });

    it('includes conditional reversion probability in reasoning when available', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const signals = strategy.evaluate(makeContext());
      expect(signals[0]!.reasoning).toContain('Conditional reversion prob:');
    });

    it('handles mid at boundary (0 or 1) gracefully', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const market = makeMarket({
        book: {
          yes: makeBook({ mid: 0 }),
          no: makeBook({ mid: 0 }),
        },
      });
      expect(strategy.evaluate(makeContext({ market }))).toHaveLength(0);
    });

    it('correlation_with_existing > 0 when positions exist', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const ctx = makeContext({
        existing_positions: [{ market_id: 'mkt_1' } as any],
      });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.correlation_with_existing).toBeGreaterThan(0);
      }
    });

    it('correlation_with_existing = 0 when no positions exist', () => {
      seedReversionModel('mkt_1');
      strategy.setProvider(makeProvider([500]));
      const ctx = makeContext({ existing_positions: [] });
      const signals = strategy.evaluate(ctx);
      if (signals.length > 0) {
        expect(signals[0]!.correlation_with_existing).toBe(0);
      }
    });
  });

  // =========================================================================
  // Reset
  // =========================================================================

  describe('resetLargeTradeState', () => {
    it('clears all module state', () => {
      seedReversionModel('mkt_1');
      recordTradeSize('mkt_1', 100);
      expect(getImpactModel('mkt_1')).toBeDefined();

      resetLargeTradeState();

      expect(getImpactModel('mkt_1')).toBeUndefined();
      expect(detectLargeTrade('mkt_1', 500)).toBeNull();
    });
  });

  describe('resetLargeTradeReactionSeq', () => {
    it('resets signal sequence', () => {
      seedReversionModel('mkt_1');
      const strategy = new LargeTradeReactionStrategy();
      strategy.setProvider(makeProvider([500]));
      const s1 = strategy.evaluate(makeContext());
      resetLargeTradeReactionSeq();
      const s2 = strategy.evaluate(makeContext());
      // After reset, IDs should restart from _1
      if (s1.length > 0 && s2.length > 0) {
        // Both should have _1 suffix after reset
        expect(s2[0]!.signal_id).toContain('_1');
      }
    });
  });
});
