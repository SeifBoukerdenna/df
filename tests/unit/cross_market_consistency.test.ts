import { describe, it, expect } from 'vitest';
import {
  CrossMarketConsistencyStrategy,
} from '../../src/strategy/cross_market_consistency.js';
import type { ConsistencyProvider } from '../../src/strategy/cross_market_consistency.js';
import { createEmptyMarketState } from '../../src/state/market_state.js';
import type { StrategyContext } from '../../src/strategy/types.js';
import type { MarketState, MarketCluster, MarketGraph, WorldState } from '../../src/state/types.js';
import type { MarketMetadata } from '../../src/ingestion/types.js';
import type {
  ConsistencyCheck,
  ConsistencyTradeLeg,
  ConsistencyTradePlan,
  ViolationPersistence,
  EdgeMapEntry,
  MarketClassification,
  MarketFeatures,
} from '../../src/analytics/types.js';
import type { StrategyConfig } from '../../src/utils/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const FEE_RATE = 0.02;

function makeMetadata(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    market_id: 'mkt_1',
    question: 'Will it rain?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes_1', no_id: 'tok_no_1' },
    status: 'active',
    resolution: null,
    end_date: '2026-12-31',
    category: 'politics',
    tags: [],
    ...overrides,
  };
}

function makeMarket(
  overrides: Partial<MarketMetadata> & {
    yesMid?: number; yesBids?: [number, number][]; yesAsks?: [number, number][];
    noMid?: number; noBids?: [number, number][]; noAsks?: [number, number][];
  } = {},
): MarketState {
  const { yesMid, yesBids, yesAsks, noMid, noBids, noAsks, ...metaOverrides } = overrides;
  const m = createEmptyMarketState(makeMetadata(metaOverrides));

  if (yesMid !== undefined) m.book.yes.mid = yesMid;
  if (yesBids) m.book.yes.bids = yesBids;
  if (yesAsks) m.book.yes.asks = yesAsks;
  if (noMid !== undefined) m.book.no.mid = noMid;
  if (noBids) m.book.no.bids = noBids;
  if (noAsks) m.book.no.asks = noAsks;

  m.book.yes.spread = (yesAsks?.[0]?.[0] ?? 0) - (yesBids?.[0]?.[0] ?? 0);
  m.book.yes.spread_bps = m.book.yes.mid > 0
    ? (m.book.yes.spread / m.book.yes.mid) * 10_000 : 0;
  m.updated_at = NOW;

  return m;
}

function makeCluster(marketIds: string[]): MarketCluster {
  return {
    cluster_id: `cluster_${marketIds.join('_')}`,
    market_ids: marketIds,
    event_description: 'test cluster',
    consistency_score: 1.0,
    consistency_violation: 0,
    last_checked: NOW,
  };
}

function makeStrategyConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    enabled: true,
    paper_only: true,
    capital_allocation: 0.05,
    max_position_size: 500,
    min_ev_threshold: 0.005,
    max_concurrent_positions: 5,
    cooldown_after_loss_ms: 60_000,
    allowed_regimes: ['normal', 'event_driven'],
    min_statistical_confidence_t: 1.645,
    max_parameter_sensitivity: 0.20,
    signal_half_life_ms: 300_000,
    ...overrides,
  };
}

function makeEdge(marketId = 'mkt_1'): EdgeMapEntry {
  return {
    market_id: marketId,
    market_type: 2,
    efficiency_score: 0.5,
    viable_strategies: ['cross_market_consistency'],
    estimated_edge_per_trade: 0.03,
    estimated_edge_confidence: 0.7,
    capital_allocated: 1000,
    breakeven_latency_ms: 5000,
  };
}

function makeClassification(marketId = 'mkt_1'): MarketClassification {
  return {
    market_id: marketId,
    market_type: 2,
    confidence: 0.8,
    efficiency_score: 0.5,
    viable_strategies: ['cross_market_consistency'],
    classified_at: NOW,
    features: {} as MarketFeatures,
  };
}

function makeTradePlan(legs: ConsistencyTradeLeg[], profit = 5.0): ConsistencyTradePlan {
  return {
    legs,
    expected_profit: profit,
    worst_case_loss: legs.length * FEE_RATE * 100,
    execution_risk: `${legs.length}-leg execution`,
  };
}

function makeCheck(overrides: Partial<ConsistencyCheck> = {}): ConsistencyCheck {
  return {
    check_id: 'exhaustive_partition:mkt_1,mkt_2',
    check_type: 'exhaustive_partition',
    markets_involved: ['mkt_1', 'mkt_2'],
    expected_relationship: 'sum(YES_mid) = 1.0',
    actual_values: new Map([['mkt_1', 0.60], ['mkt_2', 0.55]]),
    violation_magnitude: 0.15,
    executable_violation: 0.08,
    tradeable: true,
    trade_plan: makeTradePlan([
      { market_id: 'mkt_1', token_id: 'tok_yes_1', direction: 'SELL', size: 100 },
      { market_id: 'mkt_2', token_id: 'tok_yes_2', direction: 'SELL', size: 100 },
    ]),
    detected_at: NOW - 20_000,
    ...overrides,
  };
}

function makePersistence(overrides: Partial<ViolationPersistence> = {}): ViolationPersistence {
  return {
    check_id: 'exhaustive_partition:mkt_1,mkt_2',
    check_type: 'exhaustive_partition',
    markets_involved: ['mkt_1', 'mkt_2'],
    first_detected_at: NOW - 30_000,
    last_seen_at: NOW,
    resolved_at: null,
    duration_ms: 30_000,
    peak_magnitude: 0.15,
    peak_executable_magnitude: 0.08,
    observation_count: 10,
    was_tradeable: true,
    ...overrides,
  };
}

function makeWorldState(markets: MarketState[]): WorldState {
  const mMap = new Map<string, MarketState>();
  for (const m of markets) mMap.set(m.market_id, m);
  return {
    markets: mMap,
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

function makeProvider(
  checks: ConsistencyCheck[] = [],
  violations: Map<string, ViolationPersistence> = new Map(),
): ConsistencyProvider {
  return {
    checkAll: () => checks,
    getViolation: (id: string) => violations.get(id),
    getPersistenceStats: () => ({
      active_count: violations.size,
      resolved_last_hour: 0,
      median_duration_ms: 30_000,
      avg_duration_ms: 30_000,
      pct_tradeable: 1.0,
    }),
  };
}

function makeContext(
  world: WorldState,
  market: MarketState,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    world,
    market,
    classification: makeClassification(),
    edge: makeEdge(),
    existing_positions: [],
    regime: 'normal',
    config: makeStrategyConfig(),
    measured_latency_ms: 3000,
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossMarketConsistencyStrategy', () => {
  describe('basic signal generation', () => {
    it('generates a signal for a tradeable exhaustive partition violation', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.60,
        yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.55,
        yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]],
      });
      const world = makeWorldState([mkt1, mkt2]);

      const check = makeCheck();
      const persistence = makePersistence();
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const ctx = makeContext(world, mkt1);
      const signals = strategy.evaluate(ctx);

      expect(signals.length).toBe(1);
      const sig = signals[0]!;
      expect(sig.strategy_id).toBe('cross_market_consistency');
      expect(sig.market_id).toBe('mkt_1'); // primary leg
      expect(sig.direction).toBe('SELL'); // overpriced so sell
      expect(sig.ev_after_costs).toBeGreaterThan(0);
      expect(sig.signal_strength).toBeGreaterThan(0);
      expect(sig.signal_strength).toBeLessThanOrEqual(1);
      expect(sig.kill_conditions.length).toBeGreaterThan(0);
      expect(sig.reasoning).toContain('exhaustive partition');
      expect(sig.reasoning).toContain('mkt_1');
      expect(sig.reasoning).toContain('mkt_2');
    });

    it('returns empty when no violations exist', () => {
      const mkt = makeMarket({ market_id: 'mkt_1', yesMid: 0.50 });
      const world = makeWorldState([mkt]);
      const provider = makeProvider([], new Map());
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt));
      expect(signals).toHaveLength(0);
    });

    it('returns empty when market is not involved in any violation', () => {
      const mkt1 = makeMarket({ market_id: 'mkt_1', yesMid: 0.50 });
      const mkt3 = makeMarket({ market_id: 'mkt_3', yesMid: 0.50 });
      const world = makeWorldState([mkt1, mkt3]);

      // Violation is on mkt_1 and mkt_2, we evaluate mkt_3
      const check = makeCheck();
      const persistence = makePersistence();
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt3));
      expect(signals).toHaveLength(0);
    });
  });

  describe('violation persistence filter', () => {
    it('skips violations that have not persisted long enough', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.60,
        yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]],
      });
      const world = makeWorldState([mkt1]);

      const check = makeCheck();
      // Violation first detected very recently (2s ago, threshold is 10s)
      const persistence = makePersistence({
        first_detected_at: NOW - 2_000,
        duration_ms: 2_000,
      });
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt1));
      expect(signals).toHaveLength(0);
    });

    it('generates signal once violation exceeds persistence threshold', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.60,
        yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.55,
        yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]],
      });
      const world = makeWorldState([mkt1, mkt2]);

      const check = makeCheck();
      // 15s > default 10s threshold
      const persistence = makePersistence({
        first_detected_at: NOW - 15_000,
        duration_ms: 15_000,
        observation_count: 5,
      });
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt1));
      expect(signals.length).toBe(1);
    });

    it('respects configurable persistence threshold', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.60,
        yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.55,
        yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]],
      });
      const world = makeWorldState([mkt1, mkt2]);

      const check = makeCheck();
      // 15s old, but we require 30s
      const persistence = makePersistence({
        first_detected_at: NOW - 15_000,
        duration_ms: 15_000,
      });
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const config = makeStrategyConfig({ min_persistence_ms: 30_000 } as Record<string, unknown>);
      const signals = strategy.evaluate(makeContext(world, mkt1, { config }));
      expect(signals).toHaveLength(0);
    });
  });

  describe('market eligibility — depth check', () => {
    it('skips when a leg has insufficient book depth', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.60,
        yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.55,
        // Very thin book on mkt_2
        yesBids: [[0.54, 5]], yesAsks: [[0.56, 5]],
      });
      const world = makeWorldState([mkt1, mkt2]);

      const check = makeCheck({
        trade_plan: makeTradePlan([
          { market_id: 'mkt_1', token_id: 'tok_yes_1', direction: 'SELL', size: 100 },
          { market_id: 'mkt_2', token_id: 'tok_yes_2', direction: 'SELL', size: 100 },
        ]),
      });
      const persistence = makePersistence();
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt1));
      expect(signals).toHaveLength(0);
    });
  });

  describe('multi-leg execution plan', () => {
    it('generates signal with multi-leg trade plan', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.40,
        yesBids: [[0.39, 200]], yesAsks: [[0.41, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.35,
        yesBids: [[0.34, 200]], yesAsks: [[0.36, 200]],
      });
      const mkt3 = makeMarket({
        market_id: 'mkt_3', yesMid: 0.40,
        yesBids: [[0.39, 200]], yesAsks: [[0.41, 200]],
      });
      const world = makeWorldState([mkt1, mkt2, mkt3]);

      const check = makeCheck({
        check_id: 'exhaustive_partition:mkt_1,mkt_2,mkt_3',
        markets_involved: ['mkt_1', 'mkt_2', 'mkt_3'],
        violation_magnitude: 0.15,
        executable_violation: 0.06,
        trade_plan: makeTradePlan([
          { market_id: 'mkt_1', token_id: 'tok_yes_1', direction: 'SELL', size: 100 },
          { market_id: 'mkt_2', token_id: 'tok_yes_2', direction: 'SELL', size: 100 },
          { market_id: 'mkt_3', token_id: 'tok_yes_3', direction: 'SELL', size: 100 },
        ], 6.0),
      });
      const persistence = makePersistence({
        check_id: check.check_id,
        markets_involved: ['mkt_1', 'mkt_2', 'mkt_3'],
      });
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt1));
      expect(signals.length).toBe(1);
      expect(signals[0]!.reasoning).toContain('3 markets');
    });

    it('skips violations with too many legs', () => {
      const markets: MarketState[] = [];
      const legs: ConsistencyTradeLeg[] = [];
      const ids: string[] = [];
      for (let i = 1; i <= 8; i++) {
        const id = `mkt_${i}`;
        ids.push(id);
        markets.push(makeMarket({
          market_id: id, yesMid: 0.15,
          yesBids: [[0.14, 200]], yesAsks: [[0.16, 200]],
        }));
        legs.push({
          market_id: id,
          token_id: `tok_yes_${i}`,
          direction: 'SELL',
          size: 100,
        });
      }
      const world = makeWorldState(markets);
      const sortedIds = [...ids].sort();

      const check = makeCheck({
        check_id: `exhaustive_partition:${sortedIds.join(',')}`,
        markets_involved: sortedIds,
        violation_magnitude: 0.20,
        executable_violation: 0.10,
        trade_plan: makeTradePlan(legs, 10),
      });
      const persistence = makePersistence({
        check_id: check.check_id,
        markets_involved: sortedIds,
      });
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      // Default max_legs is 6, we have 8
      const signals = strategy.evaluate(makeContext(world, markets[0]!));
      expect(signals).toHaveLength(0);
    });
  });

  describe('kill conditions', () => {
    it('includes ev_decayed kill at breakeven level', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.60,
        yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.55,
        yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]],
      });
      const world = makeWorldState([mkt1, mkt2]);

      const check = makeCheck();
      const persistence = makePersistence();
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt1));
      expect(signals.length).toBe(1);

      const kc = signals[0]!.kill_conditions;
      const types = kc.map((k) => k.type);
      expect(types).toContain('time_elapsed');
      expect(types).toContain('spread_widened');
      expect(types).toContain('regime_changed');
      expect(types).toContain('ev_decayed');

      // ev_decayed threshold should be at total execution cost (breakeven)
      const evDecayed = kc.find((k) => k.type === 'ev_decayed')!;
      expect(evDecayed.threshold).toBeGreaterThan(0);
    });
  });

  describe('deduplication — only fires on first sorted market', () => {
    it('generates signal only when evaluating first sorted market', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.60,
        yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.55,
        yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]],
      });
      const world = makeWorldState([mkt1, mkt2]);

      const check = makeCheck();
      const persistence = makePersistence();
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      // Evaluate on mkt_1 (first sorted) → should generate
      const sig1 = strategy.evaluate(makeContext(world, mkt1));
      expect(sig1.length).toBe(1);

      // Evaluate on mkt_2 (second sorted) → should NOT generate
      const sig2 = strategy.evaluate(makeContext(world, mkt2));
      expect(sig2).toHaveLength(0);
    });
  });

  describe('non-tradeable violations', () => {
    it('skips violations marked as non-tradeable', () => {
      const mkt1 = makeMarket({ market_id: 'mkt_1', yesMid: 0.60 });
      const world = makeWorldState([mkt1]);

      const check = makeCheck({ tradeable: false, trade_plan: null });
      const persistence = makePersistence();
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt1));
      expect(signals).toHaveLength(0);
    });
  });

  describe('EV threshold', () => {
    it('skips violations with executable_violation below min_ev_threshold', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.50,
        yesBids: [[0.49, 200]], yesAsks: [[0.51, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.51,
        yesBids: [[0.50, 200]], yesAsks: [[0.52, 200]],
      });
      const world = makeWorldState([mkt1, mkt2]);

      const check = makeCheck({
        violation_magnitude: 0.01,
        executable_violation: 0.001, // below 0.005 default threshold
      });
      const persistence = makePersistence();
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt1));
      expect(signals).toHaveLength(0);
    });
  });

  describe('check type handling', () => {
    it('handles subset_superset violations', () => {
      const mkt1 = makeMarket({
        market_id: 'mkt_1', yesMid: 0.60,
        yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]],
      });
      const mkt2 = makeMarket({
        market_id: 'mkt_2', yesMid: 0.55,
        yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]],
      });
      const world = makeWorldState([mkt1, mkt2]);

      const check = makeCheck({
        check_type: 'subset_superset',
        check_id: 'subset_superset:mkt_1,mkt_2',
        violation_magnitude: 0.10,
        executable_violation: 0.06,
        trade_plan: makeTradePlan([
          { market_id: 'mkt_2', token_id: 'tok_yes_2', direction: 'BUY', size: 100 },
          { market_id: 'mkt_1', token_id: 'tok_yes_1', direction: 'SELL', size: 100 },
        ]),
      });
      const persistence = makePersistence({
        check_id: check.check_id,
        check_type: 'subset_superset',
      });
      const violations = new Map([[check.check_id, persistence]]);
      const provider = makeProvider([check], violations);
      const strategy = new CrossMarketConsistencyStrategy(provider);

      const signals = strategy.evaluate(makeContext(world, mkt1));
      expect(signals.length).toBe(1);
      expect(signals[0]!.reasoning).toContain('subset superset');
    });
  });
});
