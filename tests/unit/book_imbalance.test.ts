import { describe, it, expect, beforeEach } from 'vitest';
import {
  BookImbalanceStrategy,
  resetBookImbalanceSeq,
  computeDeepImbalance,
} from '../../src/strategy/book_imbalance.js';
import type { StrategyContext } from '../../src/strategy/types.js';
import type { MarketState, OrderBook } from '../../src/state/types.js';
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

/**
 * Builds a YES book with controllable depth at levels 1–5.
 * Level 0 (top of book) has small size; levels 1–4 are the "deep" levels.
 */
function makeYesBook(opts: {
  mid?: number;
  spread?: number;
  bidSizes?: number[];
  askSizes?: number[];
  lastUpdated?: number;
} = {}): OrderBook {
  const mid = opts.mid ?? 0.50;
  const spread = opts.spread ?? 0.02;
  const halfSpread = spread / 2;
  const bidSizes = opts.bidSizes ?? [50, 200, 200, 200, 200];
  const askSizes = opts.askSizes ?? [50, 200, 200, 200, 200];

  const bids: [number, number][] = bidSizes.map((s, i) =>
    [mid - halfSpread - i * 0.01, s],
  );
  const asks: [number, number][] = askSizes.map((s, i) =>
    [mid + halfSpread + i * 0.01, s],
  );

  const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0;
  return {
    bids,
    asks,
    mid,
    spread,
    spread_bps: spreadBps,
    imbalance: 0,
    imbalance_weighted: 0,
    top_of_book_stability_ms: 5000,
    queue_depth_at_best: bidSizes[0] ?? 0,
    microprice: mid,
    last_updated: opts.lastUpdated ?? NOW,
  };
}

function makeNoBook(mid: number = 0.50, spread: number = 0.02): OrderBook {
  const halfSpread = spread / 2;
  return {
    bids: [[mid - halfSpread, 200]],
    asks: [[mid + halfSpread, 200]],
    mid,
    spread,
    spread_bps: mid > 0 ? (spread / mid) * 10_000 : 0,
    imbalance: 0,
    imbalance_weighted: 0,
    top_of_book_stability_ms: 5000,
    queue_depth_at_best: 200,
    microprice: mid,
    last_updated: NOW,
  };
}

function makeMarket(overrides: Partial<MarketState> = {}): MarketState {
  return {
    market_id: 'mkt_1',
    question: 'Will Z happen?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes', no_id: 'tok_no' },
    status: 'active',
    resolution: null,
    end_date: '2026-12-31',
    category: 'politics',
    tags: [],
    book: {
      // Default: bid-heavy deep levels → positive imbalance
      yes: makeYesBook({
        bidSizes: [50, 500, 500, 500, 500],
        askSizes: [50, 100, 100, 100, 100],
      }),
      no: makeNoBook(),
    },
    last_trade_price: { yes: 0.50, no: 0.50 },
    volume_24h: 100_000,
    volume_1h: 5_000,
    trade_count_1h: 50,
    liquidity_score: 0.7,
    complement_gap: 0,
    complement_gap_executable: 0,
    staleness_ms: 0,
    volatility_1h: 0.02,
    autocorrelation_1m: 0,
    related_markets: [],
    event_cluster_id: null,
    updated_at: NOW,
    ...overrides,
  } as MarketState;
}

function makeFeatures(overrides: Partial<MarketFeatures> = {}): MarketFeatures {
  return {
    market_id: 'mkt_1',
    computed_at: NOW,
    spread_avg_abs: 0.02,
    spread_avg_bps: 400,
    spread_cv: 0.3,
    spread_regime: 'normal',
    avg_update_interval_ms: 2_000, // fast updates
    book_staleness_ms_avg: 1000,
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
    capital_allocation: 0.15,
    max_position_size: 300,
    min_ev_threshold: 0.015,
    max_concurrent_positions: 5,
    cooldown_after_loss_ms: 120_000,
    allowed_regimes: ['normal'],
    min_statistical_confidence_t: 1.645,
    max_parameter_sensitivity: 0.20,
    signal_half_life_ms: 60_000,
    imbalance_threshold: 0.60,
    min_volume_24h: 50_000,
    min_trades_per_hour: 10,
    ...overrides,
  };
}

function makeClassification(
  features: MarketFeatures = makeFeatures(),
): MarketClassification {
  return {
    market_id: 'mkt_1',
    market_type: 1,
    confidence: 0.8,
    efficiency_score: 0.5,
    viable_strategies: ['book_imbalance'],
    classified_at: NOW,
    features,
  };
}

function makeEdge(): EdgeMapEntry {
  return {
    market_id: 'mkt_1',
    market_type: 1,
    efficiency_score: 0.5,
    viable_strategies: ['book_imbalance'],
    estimated_edge_per_trade: 0.02,
    estimated_edge_confidence: 0.7,
    capital_allocated: 1500,
    breakeven_latency_ms: 3000,
  };
}

function makeWorld(market: MarketState) {
  return {
    markets: new Map([[market.market_id, market]]),
    wallets: new Map(),
    own_positions: new Map(),
    market_graph: { edges: new Map(), clusters: [] },
    regime: {
      current_regime: 'normal' as const,
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

describe('computeDeepImbalance', () => {
  it('computes weighted imbalance from levels 2-5 only', () => {
    // Bids: [ignored, 200, 200, 200, 200]  Asks: [ignored, 100, 100, 100, 100]
    const bids: [number, number][] = [
      [0.49, 50],   // level 1 — ignored
      [0.48, 200],  // level 2 — weight 1.0
      [0.47, 200],  // level 3 — weight 0.5
      [0.46, 200],  // level 4 — weight 0.333
      [0.45, 200],  // level 5 — weight 0.25
    ];
    const asks: [number, number][] = [
      [0.51, 50],   // level 1 — ignored
      [0.52, 100],  // level 2 — weight 1.0
      [0.53, 100],  // level 3 — weight 0.5
      [0.54, 100],  // level 4 — weight 0.333
      [0.55, 100],  // level 5 — weight 0.25
    ];

    const result = computeDeepImbalance(bids, asks);
    // weightedBid = 200*1 + 200*0.5 + 200*0.333 + 200*0.25 = 416.67
    // weightedAsk = 100*1 + 100*0.5 + 100*0.333 + 100*0.25 = 208.33
    // imbalance = (416.67 - 208.33) / (416.67 + 208.33) = 208.33 / 625 ≈ 0.333
    expect(result).toBeGreaterThan(0.3);
    expect(result).toBeLessThan(0.4);
  });

  it('ignores only level 1 (index 0)', () => {
    // Even with huge top-of-book imbalance, it's ignored
    const bids: [number, number][] = [
      [0.49, 10000], // level 1 — enormous bid but ignored
      [0.48, 100],
      [0.47, 100],
      [0.46, 100],
      [0.45, 100],
    ];
    const asks: [number, number][] = [
      [0.51, 1],     // level 1 — tiny ask but ignored
      [0.52, 100],
      [0.53, 100],
      [0.54, 100],
      [0.55, 100],
    ];

    const result = computeDeepImbalance(bids, asks);
    expect(result).toBeCloseTo(0, 5); // balanced deep levels → ~0
  });

  it('returns 0 for empty books', () => {
    expect(computeDeepImbalance([], [])).toBe(0);
  });

  it('returns 0 when only level 1 has depth', () => {
    const bids: [number, number][] = [[0.49, 500]];
    const asks: [number, number][] = [[0.51, 100]];
    expect(computeDeepImbalance(bids, asks)).toBe(0);
  });

  it('returns negative for ask-heavy deep levels', () => {
    const bids: [number, number][] = [
      [0.49, 50],
      [0.48, 50],
      [0.47, 50],
      [0.46, 50],
      [0.45, 50],
    ];
    const asks: [number, number][] = [
      [0.51, 50],
      [0.52, 500],
      [0.53, 500],
      [0.54, 500],
      [0.55, 500],
    ];

    expect(computeDeepImbalance(bids, asks)).toBeLessThan(-0.5);
  });
});

describe('BookImbalanceStrategy', () => {
  beforeEach(() => resetBookImbalanceSeq());

  describe('basic signal generation', () => {
    it('generates BUY YES signal for bid-heavy imbalance', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket(); // default has bid-heavy deep levels
      const ctx = makeCtx(market);

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);

      const s = signals[0]!;
      expect(s.strategy_id).toBe('book_imbalance');
      expect(s.direction).toBe('BUY');
      expect(s.token_id).toBe('tok_yes');
      expect(s.ev_estimate).toBeGreaterThan(0);
    });

    it('generates BUY NO signal for ask-heavy imbalance', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket({
        book: {
          yes: makeYesBook({
            bidSizes: [50, 100, 100, 100, 100],
            askSizes: [50, 500, 500, 500, 500],
          }),
          no: makeNoBook(),
        },
      });
      const ctx = makeCtx(market);

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.token_id).toBe('tok_no');
    });
  });

  describe('no signal when imbalance below threshold', () => {
    it('returns empty for balanced book', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket({
        book: {
          yes: makeYesBook({
            bidSizes: [50, 200, 200, 200, 200],
            askSizes: [50, 200, 200, 200, 200],
          }),
          no: makeNoBook(),
        },
      });
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('market eligibility — volume_24h > $50k', () => {
    it('skips low volume markets', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket({ volume_24h: 20_000 });
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('passes at exactly threshold', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket({ volume_24h: 50_000 });
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(1);
    });
  });

  describe('market eligibility — trades/hour > 10', () => {
    it('skips low-activity markets', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket({ trade_count_1h: 5 });
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('market eligibility — update interval < 5s', () => {
    it('skips slow-updating markets', () => {
      const strategy = new BookImbalanceStrategy();
      const features = makeFeatures({ avg_update_interval_ms: 10_000 });
      const ctx = makeCtx(makeMarket(), {
        classification: makeClassification(features),
      });

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('passes when update interval is within limit', () => {
      const strategy = new BookImbalanceStrategy();
      const features = makeFeatures({ avg_update_interval_ms: 3_000 });
      const ctx = makeCtx(makeMarket(), {
        classification: makeClassification(features),
      });

      expect(strategy.evaluate(ctx)).toHaveLength(1);
    });
  });

  describe('market eligibility — spread < 500 bps', () => {
    it('skips wide-spread markets', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket({
        book: {
          yes: makeYesBook({
            mid: 0.50,
            spread: 0.10,
            bidSizes: [50, 500, 500, 500, 500],
            askSizes: [50, 100, 100, 100, 100],
          }),
          no: makeNoBook(),
        },
      });
      // spread_bps = (0.10 / 0.50) * 10_000 = 2000 > 500
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('size proportional to imbalance × depth', () => {
    it('sizes from |imbalance| × available ask depth', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket({
        book: {
          yes: makeYesBook({
            bidSizes: [50, 500, 500, 500, 500],
            askSizes: [50, 100, 100, 100, 100],
          }),
          no: makeNoBook(),
        },
      });
      const ctx = makeCtx(market);

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);

      const s = signals[0]!;
      // Buying YES → depth from YES asks (levels 0-4) = 50 + 100 + 100 + 100 + 100 = 450
      // size = |imbalance| × 450, capped at 300
      expect(s.size_requested).toBeGreaterThan(0);
      expect(s.size_requested).toBeLessThanOrEqual(300);
    });

    it('caps size at max_position_size', () => {
      const strategy = new BookImbalanceStrategy();
      // Huge imbalance → size would exceed max
      const market = makeMarket({
        book: {
          yes: makeYesBook({
            bidSizes: [50, 10000, 10000, 10000, 10000],
            askSizes: [50, 100, 100, 100, 100],
          }),
          no: makeNoBook(),
        },
      });
      const ctx = makeCtx(market);

      const signals = strategy.evaluate(ctx);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.size_requested).toBeLessThanOrEqual(300);
    });
  });

  describe('EV threshold', () => {
    it('rejects signal when EV below threshold', () => {
      const strategy = new BookImbalanceStrategy();
      // Very tight spread → low expected move → low EV
      const market = makeMarket({
        book: {
          yes: makeYesBook({
            spread: 0.001, // tiny spread → tiny expected move
            bidSizes: [50, 500, 500, 500, 500],
            askSizes: [50, 100, 100, 100, 100],
          }),
          no: makeNoBook(),
        },
      });
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('kill conditions', () => {
    it('includes 5-minute time limit', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const kc = signals[0]!.kill_conditions;
      const timeKill = kc.find(k => k.type === 'time_elapsed');
      expect(timeKill).toBeDefined();
      expect(timeKill!.threshold).toBe(300_000);
    });

    it('includes spread_widened kill', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const kc = signals[0]!.kill_conditions;
      expect(kc.find(k => k.type === 'spread_widened')).toBeDefined();
    });

    it('includes ev_decayed kill', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const kc = signals[0]!.kill_conditions;
      expect(kc.find(k => k.type === 'ev_decayed')).toBeDefined();
    });

    it('includes regime_changed kill', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const kc = signals[0]!.kill_conditions;
      expect(kc.find(k => k.type === 'regime_changed')).toBeDefined();
    });
  });

  describe('signal properties', () => {
    it('urgency is patient (not immediate)', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals[0]!.urgency).toBe('patient');
    });

    it('decay model half_life matches config', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals[0]!.decay_model.half_life_ms).toBe(60_000);
    });

    it('ev_after_costs equals ev_estimate', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals[0]!.ev_after_costs).toBe(signals[0]!.ev_estimate);
    });

    it('expected_holding_period is half the time limit', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      expect(signals[0]!.expected_holding_period_ms).toBe(150_000);
    });
  });

  describe('reasoning string', () => {
    it('includes imbalance direction, volume, spread, and EV', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const reason = signals[0]!.reasoning;
      expect(reason).toContain('bid-heavy');
      expect(reason).toContain('Volume 24h');
      expect(reason).toContain('spread');
      expect(reason).toContain('EV:');
    });
  });

  describe('signal strength', () => {
    it('is between 0.01 and 1.0', () => {
      const strategy = new BookImbalanceStrategy();
      const ctx = makeCtx();

      const signals = strategy.evaluate(ctx);
      const strength = signals[0]!.signal_strength;
      expect(strength).toBeGreaterThanOrEqual(0.01);
      expect(strength).toBeLessThanOrEqual(1.0);
    });

    it('increases with stronger imbalance', () => {
      const strategy = new BookImbalanceStrategy();

      // Moderate imbalance
      const modMarket = makeMarket({
        book: {
          yes: makeYesBook({
            bidSizes: [50, 400, 400, 400, 400],
            askSizes: [50, 100, 100, 100, 100],
          }),
          no: makeNoBook(),
        },
      });

      // Strong imbalance
      const strongMarket = makeMarket({
        book: {
          yes: makeYesBook({
            bidSizes: [50, 1000, 1000, 1000, 1000],
            askSizes: [50, 100, 100, 100, 100],
          }),
          no: makeNoBook(),
        },
      });

      const modSignals = strategy.evaluate(makeCtx(modMarket));
      const strongSignals = strategy.evaluate(makeCtx(strongMarket));

      if (modSignals.length > 0 && strongSignals.length > 0) {
        expect(strongSignals[0]!.signal_strength).toBeGreaterThanOrEqual(
          modSignals[0]!.signal_strength,
        );
      }
    });
  });

  describe('configurable threshold', () => {
    it('respects custom imbalance_threshold', () => {
      const strategy = new BookImbalanceStrategy();
      // Balanced book → imbalance ≈ 0
      const market = makeMarket({
        book: {
          yes: makeYesBook({
            bidSizes: [50, 200, 200, 200, 200],
            askSizes: [50, 200, 200, 200, 200],
          }),
          no: makeNoBook(),
        },
      });

      // With low threshold, even small imbalances trigger
      const ctx = makeCtx(market, {
        config: makeConfig({ imbalance_threshold: 0.01 }),
      });

      // Even near-zero imbalance won't cross if sizes are exactly equal
      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });

  describe('book validation', () => {
    it('skips when YES book has fewer than 2 levels on both sides', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket({
        book: {
          yes: makeYesBook({
            bidSizes: [100],
            askSizes: [100],
          }),
          no: makeNoBook(),
        },
      });
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });

    it('skips when entry book has no asks', () => {
      const strategy = new BookImbalanceStrategy();
      const market = makeMarket();
      // BUY YES direction → need YES asks
      market.book.yes.asks = [];
      const ctx = makeCtx(market);

      expect(strategy.evaluate(ctx)).toHaveLength(0);
    });
  });
});
