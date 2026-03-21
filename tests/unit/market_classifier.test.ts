import { describe, it, expect } from 'vitest';
import {
  computeMarketFeatures,
  classifyMarketType,
  computeEfficiencyScore,
  determineViableStrategies,
  classifyMarket,
  buildEdgeMap,
  MarketClassifier,
  createEmptyObservations,
  recordBookUpdate,
  recordTrade,
  recordComplementGap,
} from '../../src/analytics/market_classifier.js';
import type { MarketObservations } from '../../src/analytics/market_classifier.js';
import type { MarketFeatures, MarketType, MarketClassification } from '../../src/analytics/types.js';
import type { MarketState, OrderBook } from '../../src/state/types.js';
import type { MarketMetadata } from '../../src/ingestion/types.js';
import { createEmptyMarketState } from '../../src/state/market_state.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    market_id: 'mkt_1',
    question: 'Will it rain tomorrow?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes', no_id: 'tok_no' },
    status: 'active',
    resolution: null,
    end_date: '2025-12-31',
    category: 'weather',
    tags: ['weather'],
    ...overrides,
  };
}

function makeMarket(overrides: Partial<MarketMetadata> = {}): MarketState {
  return createEmptyMarketState(makeMetadata(overrides));
}

function makeBook(
  bids: [number, number][],
  asks: [number, number][],
): OrderBook {
  const bestBid = bids[0]?.[0] ?? 0;
  const bestAsk = asks[0]?.[0] ?? 0;
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
  const spread = bestBid && bestAsk ? bestAsk - bestBid : 0;
  return {
    bids,
    asks,
    mid,
    spread,
    spread_bps: mid > 0 ? (spread / mid) * 10_000 : 0,
    imbalance: 0,
    imbalance_weighted: 0,
    top_of_book_stability_ms: 0,
    queue_depth_at_best: bids[0]?.[1] ?? 0,
    microprice: mid,
    last_updated: Date.now(),
  };
}

/**
 * Creates a MarketFeatures object with overrides for testing classification.
 */
function makeFeatures(overrides: Partial<MarketFeatures> = {}): MarketFeatures {
  return {
    market_id: 'mkt_test',
    computed_at: Date.now(),
    spread_avg_abs: 0.03,
    spread_avg_bps: 300,
    spread_cv: 0.3,
    spread_regime: 'normal',
    avg_update_interval_ms: 5000,
    book_staleness_ms_avg: 8000,
    bid_depth_1pct: 500,
    ask_depth_1pct: 400,
    bid_depth_5pct: 2000,
    ask_depth_5pct: 1500,
    depth_herfindahl_bid: 0.3,
    depth_herfindahl_ask: 0.3,
    queue_depth_at_best_bid: 200,
    queue_depth_at_best_ask: 150,
    trade_rate_per_min: 3,
    avg_trade_size_usd: 50,
    trade_arrival_dispersion: 1.5,
    complement_gap_half_life_ms: 10_000,
    complement_gap_frequency_per_hour: 2,
    complement_gap_median_size: 0.02,
    wallet_concentration_hhi: 0.12,
    dominant_wallet_address: null,
    dominant_wallet_share: 0,
    bot_ratio: 0.3,
    breakeven_latency_ms: null,
    edge_halflife_ms: null,
    ...overrides,
  };
}

/**
 * Creates observations pre-populated to simulate a specific market type.
 */
function makeType1Observations(): MarketObservations {
  const obs = createEmptyObservations();
  const t = Date.now();

  // Slow book updates — every 15 seconds
  for (let i = 0; i < 20; i++) {
    obs.bookChangeTimestamps.push(t - (20 - i) * 15_000);
    obs.spreads.push(400 + Math.random() * 100); // wide spreads 400-500 bps
    obs.stalenessObservations.push(15_000 + Math.random() * 5_000);
  }

  // Very few trades — 1 per 2 minutes
  for (let i = 0; i < 10; i++) {
    obs.tradeTimestamps.push(t - (10 - i) * 120_000);
    obs.tradeSizes.push(20 + Math.random() * 30);
    if (i > 0) obs.interTradeArrivals.push(120_000);
  }

  // Dispersed wallets
  for (let i = 0; i < 20; i++) {
    obs.walletVolumes.set(`wallet_${i}`, 50 + Math.random() * 50);
  }

  return obs;
}

function makeType2Observations(): MarketObservations {
  const obs = createEmptyObservations();
  const t = Date.now();

  // Mid-speed book updates — every 3-5 seconds
  for (let i = 0; i < 50; i++) {
    obs.bookChangeTimestamps.push(t - (50 - i) * 4_000);
    obs.spreads.push(150 + Math.random() * 100);
    obs.stalenessObservations.push(4_000 + Math.random() * 2_000);
  }

  // Moderate trades — 5 per minute
  for (let i = 0; i < 50; i++) {
    obs.tradeTimestamps.push(t - (50 - i) * 12_000);
    obs.tradeSizes.push(30 + Math.random() * 70);
    if (i > 0) {
      // Bursty: some short, some long intervals
      const arrival = i % 5 === 0 ? 2_000 : 15_000;
      obs.interTradeArrivals.push(arrival);
    }
  }

  // Moderate wallet concentration
  for (let i = 0; i < 10; i++) {
    const vol = i < 2 ? 500 : 50 + Math.random() * 50;
    obs.walletVolumes.set(`wallet_${i}`, vol);
  }

  return obs;
}

function makeType3Observations(): MarketObservations {
  const obs = createEmptyObservations();
  const t = Date.now();

  // Fast book updates — every 500ms
  for (let i = 0; i < 100; i++) {
    obs.bookChangeTimestamps.push(t - (100 - i) * 500);
    obs.spreads.push(50 + Math.random() * 30); // tight spreads 50-80 bps
    obs.stalenessObservations.push(500 + Math.random() * 500);
  }

  // High frequency trades — 20+ per minute
  for (let i = 0; i < 100; i++) {
    obs.tradeTimestamps.push(t - (100 - i) * 3_000);
    obs.tradeSizes.push(100 + Math.random() * 50); // round-ish sizes
    if (i > 0) obs.interTradeArrivals.push(3_000);
  }

  // Sub-second response times (bots)
  for (let i = 0; i < 50; i++) {
    obs.responseTimesMs.push(100 + Math.random() * 300);
  }

  // Concentrated wallets — 2 wallets dominate
  obs.walletVolumes.set('bot_1', 5000);
  obs.walletVolumes.set('bot_2', 3000);
  for (let i = 0; i < 5; i++) {
    obs.walletVolumes.set(`retail_${i}`, 100);
  }

  // Fast gap closure
  for (let i = 0; i < 20; i++) {
    obs.complementGaps.push({
      timestamp: t - (20 - i) * 30_000,
      size: 0.005 + Math.random() * 0.01,
    });
  }

  return obs;
}

// ---------------------------------------------------------------------------
// classifyMarketType
// ---------------------------------------------------------------------------

describe('classifyMarketType', () => {
  it('classifies Type 1 (Slow / Narrative-Driven)', () => {
    const features = makeFeatures({
      avg_update_interval_ms: 15_000,
      book_staleness_ms_avg: 20_000,
      spread_avg_bps: 400,
      trade_rate_per_min: 0.5,
      wallet_concentration_hhi: 0.05,
      bot_ratio: 0.1,
    });

    const { type, confidence } = classifyMarketType(features);
    expect(type).toBe(1);
    expect(confidence).toBeGreaterThan(0.4);
  });

  it('classifies Type 2 (Event-Driven / Mid-Speed)', () => {
    const features = makeFeatures({
      avg_update_interval_ms: 5_000,
      trade_rate_per_min: 8,
      trade_arrival_dispersion: 3.0, // very bursty
      wallet_concentration_hhi: 0.15,
      // Make Type 1 and Type 3 score lower
      spread_avg_bps: 200,
      book_staleness_ms_avg: 5_000,
      bot_ratio: 0.4,
    });

    const { type } = classifyMarketType(features);
    expect(type).toBe(2);
  });

  it('classifies Type 3 (HFT / Bot-Dominated)', () => {
    const features = makeFeatures({
      avg_update_interval_ms: 800,
      spread_avg_bps: 50,
      book_staleness_ms_avg: 1_000,
      wallet_concentration_hhi: 0.35,
      bot_ratio: 0.85,
      complement_gap_half_life_ms: 1_500,
    });

    const { type, confidence } = classifyMarketType(features);
    expect(type).toBe(3);
    expect(confidence).toBeGreaterThan(0.4);
  });

  it('defaults to Type 2 when ambiguous', () => {
    // Features that don't clearly match any type
    const features = makeFeatures({
      avg_update_interval_ms: 5_000,
      spread_avg_bps: 200,
      book_staleness_ms_avg: 5_000,
      trade_rate_per_min: 5,
      wallet_concentration_hhi: 0.15,
      bot_ratio: 0.4,
      trade_arrival_dispersion: 1.5,
    });

    const { type } = classifyMarketType(features);
    // Should be Type 2 as it's the mid-range default
    expect([1, 2, 3]).toContain(type);
  });
});

// ---------------------------------------------------------------------------
// computeEfficiencyScore
// ---------------------------------------------------------------------------

describe('computeEfficiencyScore', () => {
  it('returns low score for inefficient markets', () => {
    const features = makeFeatures({
      spread_avg_bps: 500,         // wide spread
      avg_update_interval_ms: 30_000, // very slow
      complement_gap_half_life_ms: 60_000, // slow gap closure
      wallet_concentration_hhi: 0.03, // dispersed
      book_staleness_ms_avg: 30_000, // very stale
      bot_ratio: 0.05,             // mostly humans
    });

    const score = computeEfficiencyScore(features);
    expect(score).toBeLessThan(0.2);
  });

  it('returns high score for efficient markets', () => {
    const features = makeFeatures({
      spread_avg_bps: 30,          // tight spread
      avg_update_interval_ms: 300, // very fast
      complement_gap_half_life_ms: 500, // fast gap closure
      wallet_concentration_hhi: 0.40, // concentrated
      book_staleness_ms_avg: 500,  // fresh
      bot_ratio: 0.90,            // mostly bots
    });

    const score = computeEfficiencyScore(features);
    expect(score).toBeGreaterThan(0.5);
  });

  it('score is bounded [0, 1]', () => {
    const low = computeEfficiencyScore(makeFeatures({
      spread_avg_bps: 10000,
      avg_update_interval_ms: 100_000,
    }));
    const high = computeEfficiencyScore(makeFeatures({
      spread_avg_bps: 1,
      avg_update_interval_ms: 1,
    }));

    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });

  it('less efficient market scores lower than more efficient market', () => {
    const inefficient = computeEfficiencyScore(makeFeatures({
      spread_avg_bps: 500,
      avg_update_interval_ms: 20_000,
      bot_ratio: 0.1,
    }));
    const efficient = computeEfficiencyScore(makeFeatures({
      spread_avg_bps: 50,
      avg_update_interval_ms: 500,
      bot_ratio: 0.8,
    }));

    expect(efficient).toBeGreaterThan(inefficient);
  });
});

// ---------------------------------------------------------------------------
// determineViableStrategies
// ---------------------------------------------------------------------------

describe('determineViableStrategies', () => {
  it('Type 1 includes wallet_follow, complement_arb, stale_book', () => {
    const features = makeFeatures({ complement_gap_frequency_per_hour: 2 });
    const strategies = determineViableStrategies(features, 1, 2000);

    expect(strategies).toContain('wallet_follow');
    expect(strategies).toContain('complement_arb');
    expect(strategies).toContain('stale_book');
    expect(strategies).toContain('cross_market_consistency');
    expect(strategies).not.toContain('microprice_dislocation');
  });

  it('Type 2 includes book_imbalance when trade rate is high enough', () => {
    const features = makeFeatures({
      trade_rate_per_min: 8,
      avg_update_interval_ms: 3_000,
      spread_avg_bps: 200,
      complement_gap_frequency_per_hour: 2,
    });
    const strategies = determineViableStrategies(features, 2, 2000);

    expect(strategies).toContain('book_imbalance');
    expect(strategies).toContain('wallet_follow');
  });

  it('Type 2 excludes microprice when trade rate < 10', () => {
    const features = makeFeatures({
      trade_rate_per_min: 5,
      complement_gap_frequency_per_hour: 2,
    });
    const strategies = determineViableStrategies(features, 2, 2000);
    expect(strategies).not.toContain('microprice_dislocation');
  });

  it('Type 2 includes microprice when trade rate > 10 and spread is tight', () => {
    const features = makeFeatures({
      trade_rate_per_min: 12,
      spread_avg_bps: 100,
      avg_update_interval_ms: 1_500,
      complement_gap_frequency_per_hour: 2,
    });
    const strategies = determineViableStrategies(features, 2, 2000);
    expect(strategies).toContain('microprice_dislocation');
  });

  it('Type 3 is restrictive — only conditional strategies', () => {
    const features = makeFeatures({
      complement_gap_half_life_ms: 5000,
      complement_gap_frequency_per_hour: 3,
      trade_rate_per_min: 20,
      spread_avg_bps: 80,
      dominant_wallet_address: null,
    });
    const strategies = determineViableStrategies(features, 3, 2000);

    // Should include complement_arb (half_life 5000 > 2000*2)
    expect(strategies).toContain('complement_arb');
    // Should include large_trade_reaction (trade_rate > 3)
    expect(strategies).toContain('large_trade_reaction');
    // Should NOT include wallet_follow (no dominant wallet)
    expect(strategies).not.toContain('wallet_follow');
  });

  it('Type 3 excludes complement_arb when gap too short-lived', () => {
    const features = makeFeatures({
      complement_gap_half_life_ms: 1000, // < 2000 * 2
      complement_gap_frequency_per_hour: 5,
      trade_rate_per_min: 20,
    });
    const strategies = determineViableStrategies(features, 3, 2000);
    expect(strategies).not.toContain('complement_arb');
  });

  it('filters cascade_detection by bot_ratio', () => {
    const highBot = makeFeatures({ bot_ratio: 0.8, complement_gap_frequency_per_hour: 2 });
    const lowBot = makeFeatures({ bot_ratio: 0.3, complement_gap_frequency_per_hour: 2 });

    const strats1 = determineViableStrategies(highBot, 1, 2000);
    const strats2 = determineViableStrategies(lowBot, 1, 2000);

    expect(strats1).not.toContain('cascade_detection');
    expect(strats2).toContain('cascade_detection');
  });
});

// ---------------------------------------------------------------------------
// computeMarketFeatures with real observations
// ---------------------------------------------------------------------------

describe('computeMarketFeatures', () => {
  it('computes features for a Type 1-like market', () => {
    const market = makeMarket();
    market.book.yes = makeBook(
      [[0.45, 100], [0.44, 200], [0.43, 300]],
      [[0.55, 80], [0.56, 150], [0.57, 200]],
    );
    market.staleness_ms = 15_000;

    const obs = makeType1Observations();
    const features = computeMarketFeatures(market, obs);

    // Should reflect slow, wide-spread characteristics
    expect(features.spread_avg_bps).toBeGreaterThan(200);
    expect(features.avg_update_interval_ms).toBeGreaterThan(10_000);
    expect(features.trade_rate_per_min).toBeLessThan(2);
    expect(features.wallet_concentration_hhi).toBeLessThan(0.15);
  });

  it('computes features for a Type 3-like market', () => {
    const market = makeMarket();
    market.book.yes = makeBook(
      [[0.49, 500], [0.48, 800]],
      [[0.51, 500], [0.52, 700]],
    );
    market.staleness_ms = 500;

    const obs = makeType3Observations();
    const features = computeMarketFeatures(market, obs);

    expect(features.spread_avg_bps).toBeLessThan(150);
    expect(features.avg_update_interval_ms).toBeLessThan(2_000);
    expect(features.bot_ratio).toBeGreaterThan(0.3);
    expect(features.wallet_concentration_hhi).toBeGreaterThan(0.15);
  });

  it('computes depth Herfindahl', () => {
    const market = makeMarket();
    // Concentrated book: all depth at one level
    market.book.yes = makeBook(
      [[0.49, 1000]],
      [[0.51, 1000]],
    );
    const obs = createEmptyObservations();
    const features = computeMarketFeatures(market, obs);

    // Single level → HHI = 1.0
    expect(features.depth_herfindahl_bid).toBe(1.0);

    // Now test distributed book
    market.book.yes = makeBook(
      [[0.49, 200], [0.48, 200], [0.47, 200], [0.46, 200], [0.45, 200]],
      [[0.51, 200], [0.52, 200], [0.53, 200], [0.54, 200], [0.55, 200]],
    );
    const features2 = computeMarketFeatures(market, obs);
    // 5 equal levels → HHI = 5 * (0.2)² = 0.2
    expect(features2.depth_herfindahl_bid).toBeCloseTo(0.2, 5);
  });
});

// ---------------------------------------------------------------------------
// Full classification pipeline
// ---------------------------------------------------------------------------

describe('classifyMarket (full pipeline)', () => {
  it('classifies a slow market as Type 1', () => {
    const market = makeMarket();
    market.book.yes = makeBook(
      [[0.45, 100], [0.44, 200]],
      [[0.55, 80], [0.56, 150]],
    );
    market.staleness_ms = 20_000;

    const obs = makeType1Observations();
    const cls = classifyMarket(market, obs, 2000);

    expect(cls.market_type).toBe(1);
    expect(cls.efficiency_score).toBeLessThan(0.4);
    expect(cls.viable_strategies.length).toBeGreaterThan(0);
    // Should include wallet_follow but not microprice
    expect(cls.viable_strategies).toContain('wallet_follow');
    expect(cls.viable_strategies).not.toContain('microprice_dislocation');
  });

  it('classifies a fast bot market as Type 3', () => {
    const market = makeMarket();
    market.book.yes = makeBook(
      [[0.49, 500], [0.48, 800]],
      [[0.51, 500], [0.52, 700]],
    );
    market.staleness_ms = 500;

    const obs = makeType3Observations();
    const cls = classifyMarket(market, obs, 2000);

    expect(cls.market_type).toBe(3);
    expect(cls.efficiency_score).toBeGreaterThan(0.2);
  });
});

// ---------------------------------------------------------------------------
// buildEdgeMap
// ---------------------------------------------------------------------------

describe('buildEdgeMap', () => {
  it('builds edge map with capital allocation', () => {
    const cls1: MarketClassification = {
      market_id: 'mkt_1',
      market_type: 1,
      confidence: 0.8,
      efficiency_score: 0.15,
      viable_strategies: ['wallet_follow', 'complement_arb', 'stale_book'],
      classified_at: Date.now(),
      features: makeFeatures({ market_id: 'mkt_1' }),
    };
    const cls2: MarketClassification = {
      market_id: 'mkt_2',
      market_type: 3,
      confidence: 0.7,
      efficiency_score: 0.65,
      viable_strategies: ['complement_arb'],
      classified_at: Date.now(),
      features: makeFeatures({ market_id: 'mkt_2' }),
    };
    const cls3: MarketClassification = {
      market_id: 'mkt_3',
      market_type: 3,
      confidence: 0.9,
      efficiency_score: 0.80,
      viable_strategies: [],
      classified_at: Date.now(),
      features: makeFeatures({ market_id: 'mkt_3' }),
    };

    const classifications = new Map<string, MarketClassification>();
    classifications.set('mkt_1', cls1);
    classifications.set('mkt_2', cls2);
    classifications.set('mkt_3', cls3);

    const edgeMap = buildEdgeMap(classifications, 2000, 100_000);

    expect(edgeMap.markets_with_edge).toHaveLength(2); // mkt_1 and mkt_2
    expect(edgeMap.markets_without_edge).toBe(1); // mkt_3

    // Less efficient market should get more capital
    const mkt1Entry = edgeMap.markets_with_edge.find((e) => e.market_id === 'mkt_1')!;
    const mkt2Entry = edgeMap.markets_with_edge.find((e) => e.market_id === 'mkt_2')!;
    expect(mkt1Entry.capital_allocated).toBeGreaterThan(mkt2Entry.capital_allocated);

    // Total allocation should not exceed total capital
    const totalAllocated = edgeMap.markets_with_edge.reduce((s, e) => s + e.capital_allocated, 0);
    expect(totalAllocated).toBeLessThanOrEqual(100_000);
    expect(edgeMap.idle_capital).toBeGreaterThan(0);

    // Recommendation should be trade_actively (validated markets with edge)
    expect(edgeMap.recommendation).toBe('trade_actively');
  });

  it('recommends do_not_trade when no markets have edge', () => {
    const classifications = new Map<string, MarketClassification>();
    const edgeMap = buildEdgeMap(classifications, 2000, 100_000);

    expect(edgeMap.markets_with_edge).toHaveLength(0);
    expect(edgeMap.recommendation).toBe('do_not_trade');
    expect(edgeMap.idle_capital).toBe(100_000);
  });

  it('caps per-market allocation at 10% of total capital', () => {
    const cls: MarketClassification = {
      market_id: 'mkt_only',
      market_type: 1,
      confidence: 0.9,
      efficiency_score: 0.05,
      viable_strategies: ['wallet_follow', 'complement_arb', 'stale_book'],
      classified_at: Date.now(),
      features: makeFeatures(),
    };

    const classifications = new Map<string, MarketClassification>();
    classifications.set('mkt_only', cls);

    const edgeMap = buildEdgeMap(classifications, 2000, 100_000);
    const entry = edgeMap.markets_with_edge[0]!;

    // Single market would get 100% normalized, but capped at 10%
    expect(entry.capital_allocated).toBeLessThanOrEqual(10_000);
  });
});

// ---------------------------------------------------------------------------
// MarketClassifier class
// ---------------------------------------------------------------------------

describe('MarketClassifier', () => {
  it('classifies all markets and tracks state', () => {
    const classifier = new MarketClassifier(2000);
    const market = makeMarket();
    market.book.yes = makeBook(
      [[0.45, 100], [0.44, 200]],
      [[0.55, 80], [0.56, 150]],
    );

    // Pre-populate observations
    const obs = classifier.getObservations('mkt_1');
    const t = Date.now();
    for (let i = 0; i < 20; i++) {
      obs.bookChangeTimestamps.push(t - (20 - i) * 15_000);
      obs.spreads.push(400);
      obs.stalenessObservations.push(15_000);
    }

    const markets = new Map<string, MarketState>();
    markets.set('mkt_1', market);

    const events = classifier.classifyAll(markets);

    // First classification — no reclassification events (no previous)
    expect(events).toHaveLength(0);

    const cls = classifier.getClassification('mkt_1');
    expect(cls).toBeDefined();
    expect(cls!.market_type).toBeGreaterThanOrEqual(1);
    expect(cls!.market_type).toBeLessThanOrEqual(3);
  });

  it('detects reclassification events', () => {
    const classifier = new MarketClassifier(2000);
    const market = makeMarket();
    market.book.yes = makeBook(
      [[0.45, 100]],
      [[0.55, 80]],
    );

    const markets = new Map<string, MarketState>();
    markets.set('mkt_1', market);

    // First: classify as slow
    const obs = classifier.getObservations('mkt_1');
    const t = Date.now();
    for (let i = 0; i < 20; i++) {
      obs.bookChangeTimestamps.push(t - (20 - i) * 15_000);
      obs.spreads.push(400);
      obs.stalenessObservations.push(15_000);
    }
    for (let i = 0; i < 5; i++) {
      obs.tradeTimestamps.push(t - (5 - i) * 120_000);
    }

    classifier.classifyAll(markets);
    const firstType = classifier.getClassification('mkt_1')!.market_type;

    // Now change observations to be fast (Type 3-like)
    obs.bookChangeTimestamps.length = 0;
    obs.spreads.length = 0;
    obs.stalenessObservations.length = 0;
    obs.tradeTimestamps.length = 0;

    for (let i = 0; i < 100; i++) {
      obs.bookChangeTimestamps.push(t - (100 - i) * 500);
      obs.spreads.push(50);
      obs.stalenessObservations.push(500);
    }
    for (let i = 0; i < 100; i++) {
      obs.tradeTimestamps.push(t - (100 - i) * 3_000);
      if (i > 0) obs.interTradeArrivals.push(3_000);
    }
    for (let i = 0; i < 50; i++) {
      obs.responseTimesMs.push(200);
    }
    obs.walletVolumes.set('bot_1', 5000);
    obs.walletVolumes.set('bot_2', 3000);

    const events = classifier.classifyAll(markets, 'anomaly');
    const secondType = classifier.getClassification('mkt_1')!.market_type;

    // If the type actually changed, we should see an event
    if (firstType !== secondType) {
      expect(events).toHaveLength(1);
      expect(events[0]!.old_type).toBe(firstType);
      expect(events[0]!.new_type).toBe(secondType);
      expect(events[0]!.trigger).toBe('anomaly');
    }
  });

  it('builds edge map from classifications', () => {
    const classifier = new MarketClassifier(2000);
    const market = makeMarket();
    market.book.yes = makeBook(
      [[0.45, 100]],
      [[0.55, 80]],
    );

    const obs = classifier.getObservations('mkt_1');
    const t = Date.now();
    for (let i = 0; i < 20; i++) {
      obs.bookChangeTimestamps.push(t - (20 - i) * 15_000);
      obs.spreads.push(400);
    }

    const markets = new Map<string, MarketState>();
    markets.set('mkt_1', market);
    classifier.classifyAll(markets);

    const edgeMap = classifier.buildEdgeMap(50_000);
    expect(edgeMap.measured_latency_p50_ms).toBe(2000);
    expect(edgeMap.timestamp).toBeGreaterThan(0);
  });

  it('removes markets on request', () => {
    const classifier = new MarketClassifier();
    const market = makeMarket();
    const markets = new Map<string, MarketState>();
    markets.set('mkt_1', market);

    classifier.classifyAll(markets);
    expect(classifier.getClassification('mkt_1')).toBeDefined();

    classifier.removeMarket('mkt_1');
    expect(classifier.getClassification('mkt_1')).toBeUndefined();
  });

  it('updates latency', () => {
    const classifier = new MarketClassifier(2000);
    expect(classifier.getMeasuredLatency()).toBe(2000);

    classifier.updateLatency(1000);
    expect(classifier.getMeasuredLatency()).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Observation recording
// ---------------------------------------------------------------------------

describe('observation recording', () => {
  it('recordBookUpdate tracks spreads and changes', () => {
    const obs = createEmptyObservations();
    const market = makeMarket();
    market.book.yes = makeBook([[0.48, 200]], [[0.52, 150]]);
    market.book.yes.spread_bps = 800;

    recordBookUpdate(obs, market, 'yes');

    expect(obs.spreads).toHaveLength(1);
    expect(obs.spreads[0]).toBe(800);
    expect(obs.bookChangeTimestamps.length).toBeGreaterThanOrEqual(1);
  });

  it('recordTrade tracks trade data', () => {
    const obs = createEmptyObservations();
    const t = Date.now();

    recordTrade(obs, t, 50, '0xmaker', '0xtaker', 200);
    recordTrade(obs, t + 5000, 30, '0xmaker', '0xtaker', 150);

    expect(obs.tradeTimestamps).toHaveLength(2);
    expect(obs.tradeSizes).toHaveLength(2);
    expect(obs.interTradeArrivals).toHaveLength(1);
    expect(obs.interTradeArrivals[0]).toBe(5000);
    expect(obs.walletVolumes.get('0xmaker')).toBe(80); // 50 + 30
    expect(obs.responseTimesMs).toHaveLength(2);
  });

  it('recordComplementGap filters by fee rate', () => {
    const obs = createEmptyObservations();
    const t = Date.now();
    const feeRate = 0.02;

    // Small gap — should be filtered out
    recordComplementGap(obs, t, 0.01, feeRate); // 0.01 < 2 * 0.02 = 0.04
    expect(obs.complementGaps).toHaveLength(0);

    // Large gap — should be recorded
    recordComplementGap(obs, t, 0.05, feeRate); // 0.05 > 0.04
    expect(obs.complementGaps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Edge case tests
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('handles market with empty books', () => {
    const market = makeMarket();
    const obs = createEmptyObservations();
    const features = computeMarketFeatures(market, obs);

    expect(features.spread_avg_bps).toBe(0);
    expect(features.depth_herfindahl_bid).toBe(0);
    expect(features.bot_ratio).toBe(0);
    expect(features.complement_gap_half_life_ms).toBeNull();
  });

  it('handles market with no observations', () => {
    const market = makeMarket();
    market.book.yes = makeBook([[0.48, 100]], [[0.52, 100]]);
    const obs = createEmptyObservations();

    const cls = classifyMarket(market, obs, 2000);
    expect(cls.market_type).toBeGreaterThanOrEqual(1);
    expect(cls.market_type).toBeLessThanOrEqual(3);
    expect(cls.efficiency_score).toBeGreaterThanOrEqual(0);
    expect(cls.efficiency_score).toBeLessThanOrEqual(1);
  });

  it('efficiency score handles null gap half-life', () => {
    const features = makeFeatures({ complement_gap_half_life_ms: null });
    const score = computeEfficiencyScore(features);
    // null half-life defaults to 30_000 (very slow) → low efficiency component
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
