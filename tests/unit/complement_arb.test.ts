import { describe, it, expect, beforeEach } from 'vitest';
import {
  ComplementArbStrategy,
  clearGapPersistence,
} from '../../src/strategy/complement_arb.js';
import { createEmptyMarketState } from '../../src/state/market_state.js';
import type { StrategyContext } from '../../src/strategy/types.js';
import type { MarketState, WorldState } from '../../src/state/types.js';
import type { MarketMetadata } from '../../src/ingestion/types.js';
import type { EdgeMapEntry, MarketClassification, MarketFeatures } from '../../src/analytics/types.js';
import type { StrategyConfig } from '../../src/utils/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;

function makeMetadata(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    market_id: 'mkt_1',
    question: 'Will it rain?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes_1', no_id: 'tok_no_1' },
    status: 'active',
    resolution: null,
    end_date: '2026-12-31',
    category: 'weather',
    tags: [],
    ...overrides,
  };
}

function makeMarket(opts: {
  market_id?: string;
  yesAsk?: [number, number];
  noAsk?: [number, number];
  yesStability?: number;
  noStability?: number;
  yesSpread?: number;
  noSpread?: number;
} = {}): MarketState {
  const m = createEmptyMarketState(makeMetadata({
    market_id: opts.market_id ?? 'mkt_1',
  }));

  const yesAsk = opts.yesAsk ?? [0.45, 200];
  const noAsk = opts.noAsk ?? [0.45, 200];

  m.book.yes.asks = [yesAsk];
  m.book.yes.bids = [[yesAsk[0] - 0.02, 200]];
  m.book.yes.mid = yesAsk[0] - 0.01;
  m.book.yes.spread = opts.yesSpread ?? 0.02;
  m.book.yes.spread_bps = (m.book.yes.spread / (m.book.yes.mid || 1)) * 10_000;
  m.book.yes.top_of_book_stability_ms = opts.yesStability ?? 30_000;
  m.book.yes.last_updated = NOW;

  m.book.no.asks = [noAsk];
  m.book.no.bids = [[noAsk[0] - 0.02, 200]];
  m.book.no.mid = noAsk[0] - 0.01;
  m.book.no.spread = opts.noSpread ?? 0.02;
  m.book.no.spread_bps = (m.book.no.spread / (m.book.no.mid || 1)) * 10_000;
  m.book.no.top_of_book_stability_ms = opts.noStability ?? 30_000;
  m.book.no.last_updated = NOW;

  m.updated_at = NOW;
  return m;
}

function makeStrategyConfig(overrides: Partial<StrategyConfig> = {}): StrategyConfig {
  return {
    enabled: true,
    paper_only: true,
    capital_allocation: 0.30,
    max_position_size: 1000,
    min_ev_threshold: 0.001,
    max_concurrent_positions: 10,
    cooldown_after_loss_ms: 60_000,
    allowed_regimes: ['normal', 'high_volatility', 'event_driven', 'resolution_clustering', 'low_liquidity'],
    min_statistical_confidence_t: 1.645,
    max_parameter_sensitivity: 0.20,
    max_leg_slip_probability: 0.10,
    signal_half_life_ms: 10_000,
    ...overrides,
  };
}

function makeEdge(): EdgeMapEntry {
  return {
    market_id: 'mkt_1',
    market_type: 2,
    efficiency_score: 0.4,
    viable_strategies: ['complement_arb'],
    estimated_edge_per_trade: 0.02,
    estimated_edge_confidence: 0.8,
    capital_allocated: 3000,
    breakeven_latency_ms: 2000,
  };
}

function makeClassification(): MarketClassification {
  return {
    market_id: 'mkt_1',
    market_type: 2,
    confidence: 0.8,
    efficiency_score: 0.4,
    viable_strategies: ['complement_arb'],
    classified_at: NOW,
    features: {} as MarketFeatures,
  };
}

function makeWorldState(market: MarketState): WorldState {
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

function makeContext(
  market: MarketState,
  overrides: Partial<StrategyContext> = {},
): StrategyContext {
  return {
    world: makeWorldState(market),
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

/**
 * Helper: evaluate the strategy multiple times to build up gap persistence.
 * Each call simulates a new book update by tweaking last_updated.
 */
function evaluateNTimes(
  strategy: ComplementArbStrategy,
  market: MarketState,
  n: number,
  overrides: Partial<StrategyContext> = {},
): ReturnType<typeof strategy.evaluate> {
  let signals: ReturnType<typeof strategy.evaluate> = [];
  for (let i = 0; i < n; i++) {
    // Simulate book update by advancing last_updated
    market.book.yes.last_updated = NOW + i * 2000;
    market.book.no.last_updated = NOW + i * 2000;
    signals = strategy.evaluate(makeContext(market, {
      ...overrides,
      now: NOW + i * 2000,
    }));
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ComplementArbStrategy', () => {
  // Clear module-scoped gap tracker between tests
  beforeEach(() => {
    clearGapPersistence('mkt_1');
    clearGapPersistence('mkt_2');
  });

  describe('basic signal generation', () => {
    it('generates signal when complement gap is profitable after fees + slippage', () => {
      // YES ask 0.45 + NO ask 0.45 = 0.90 < 1.0
      // Raw profit = 1.0 - 0.90 - 0.04 (2*fee) = 0.06
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      // Need 2+ book updates for persistence
      const signals = evaluateNTimes(strategy, market, 3);

      expect(signals.length).toBe(1);
      const sig = signals[0]!;
      expect(sig.strategy_id).toBe('complement_arb');
      expect(sig.market_id).toBe('mkt_1');
      expect(sig.direction).toBe('BUY');
      expect(sig.token_id).toBe('tok_yes_1'); // primary leg is YES
      expect(sig.ev_estimate).toBeGreaterThan(0);
      expect(sig.ev_after_costs).toBeGreaterThan(0);
      expect(sig.urgency).toBe('immediate');
      expect(sig.reasoning).toContain('Complement arb');
      expect(sig.reasoning).toContain('YES ask');
      expect(sig.reasoning).toContain('NO ask');
    });

    it('returns empty when no arb exists (sum >= 1.0)', () => {
      // YES ask 0.55 + NO ask 0.55 = 1.10 > 1.0
      const market = makeMarket({ yesAsk: [0.55, 200], noAsk: [0.55, 200] });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals).toHaveLength(0);
    });

    it('returns empty when gap is too small to cover fees + slippage', () => {
      // YES ask 0.49 + NO ask 0.49 = 0.98
      // Raw profit = 1.0 - 0.98 - 0.04 = -0.02 (negative)
      const market = makeMarket({ yesAsk: [0.49, 200], noAsk: [0.49, 200] });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals).toHaveLength(0);
    });

    it('returns empty when either side has no asks', () => {
      const market = makeMarket();
      market.book.yes.asks = []; // no YES asks
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals).toHaveLength(0);
    });
  });

  describe('gap persistence tracking', () => {
    it('requires at least 2 book updates before generating signal', () => {
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      // First evaluation: persistence = 1 update
      const signals1 = strategy.evaluate(makeContext(market));
      expect(signals1).toHaveLength(0);

      // Second evaluation with updated book timestamps
      market.book.yes.last_updated = NOW + 2000;
      market.book.no.last_updated = NOW + 2000;
      const signals2 = strategy.evaluate(makeContext(market, { now: NOW + 2000 }));
      expect(signals2.length).toBe(1);
    });

    it('does not increment persistence without book update', () => {
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      // First call
      strategy.evaluate(makeContext(market));
      // Second call with SAME book timestamps — should not increment
      const signals = strategy.evaluate(makeContext(market, { now: NOW + 1000 }));
      expect(signals).toHaveLength(0);
    });

    it('resets persistence when gap disappears and reappears', () => {
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      // Build up persistence to 2
      evaluateNTimes(strategy, market, 3);

      // Gap disappears — clear persistence
      clearGapPersistence('mkt_1');

      // Gap reappears — need fresh 2 updates
      const signals = strategy.evaluate(makeContext(market, { now: NOW + 10_000 }));
      expect(signals).toHaveLength(0);
    });
  });

  describe('leg slip probability', () => {
    it('skips when book stability is too low (high slip risk)', () => {
      // Very low stability → high slip probability
      const market = makeMarket({
        yesAsk: [0.45, 200],
        noAsk: [0.45, 200],
        yesStability: 100, // only 100ms stable
        noStability: 100,
      });
      const strategy = new ComplementArbStrategy();

      // P(miss) = 3000 / (100 + 3000) = 0.968 → way above 0.05 threshold
      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals).toHaveLength(0);
    });

    it('generates signal when book is sufficiently stable', () => {
      // High stability → low slip probability
      const market = makeMarket({
        yesAsk: [0.45, 200],
        noAsk: [0.45, 200],
        yesStability: 60_000, // 60s stable
        noStability: 60_000,
      });
      const strategy = new ComplementArbStrategy();

      // P(miss) = 3000 / (60000 + 3000) = 0.048 → below 0.05
      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals.length).toBe(1);
    });

    it('respects configurable max slip probability', () => {
      const market = makeMarket({
        yesAsk: [0.45, 200],
        noAsk: [0.45, 200],
        yesStability: 30_000, // P(miss) = 3000/33000 = 0.091
        noStability: 30_000,
      });
      const strategy = new ComplementArbStrategy();

      // Default max 0.05 → should skip (0.091 > 0.05)
      const signals1 = evaluateNTimes(strategy, market, 3, {
        config: makeStrategyConfig({ max_leg_slip_probability: 0.05 } as Record<string, unknown>),
      });
      expect(signals1).toHaveLength(0);

      // Set higher threshold → should pass
      clearGapPersistence('mkt_1');
      const signals2 = evaluateNTimes(strategy, market, 3, {
        config: makeStrategyConfig({ max_leg_slip_probability: 0.15 } as Record<string, unknown>),
      });
      expect(signals2.length).toBe(1);
    });
  });

  describe('depth check', () => {
    it('skips when YES side depth is insufficient', () => {
      const market = makeMarket({
        yesAsk: [0.45, 10], // only 10 depth
        noAsk: [0.45, 200],
      });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals).toHaveLength(0);
    });

    it('skips when NO side depth is insufficient', () => {
      const market = makeMarket({
        yesAsk: [0.45, 200],
        noAsk: [0.45, 10], // only 10 depth
      });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals).toHaveLength(0);
    });
  });

  describe('expected profit computation', () => {
    it('subtracts slippage from raw profit', () => {
      // YES ask 0.40 + NO ask 0.40 = 0.80
      // Raw profit = 1.0 - 0.80 - 0.04 = 0.16
      // Slippage = 0.5 * spread per leg = 0.5 * 0.02 * 2 = 0.02
      // Expected = 0.16 - 0.02 = 0.14
      const market = makeMarket({
        yesAsk: [0.40, 200], noAsk: [0.40, 200],
        yesSpread: 0.02, noSpread: 0.02,
      });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals.length).toBe(1);

      const sig = signals[0]!;
      // ev_estimate = raw profit (0.16), ev_after_costs includes slippage
      expect(sig.ev_estimate).toBeCloseTo(0.16, 2);
      expect(sig.ev_after_costs).toBeCloseTo(0.14, 2);
    });

    it('rejects when slippage eats all profit', () => {
      // YES 0.47 + NO 0.47 = 0.94
      // Raw profit = 1.0 - 0.94 - 0.04 = 0.02
      // Slippage with wide spread (0.10 each): 0.5 * 0.10 * 2 = 0.10
      // Expected = 0.02 - 0.10 = -0.08 → negative
      const market = makeMarket({
        yesAsk: [0.47, 200], noAsk: [0.47, 200],
        yesSpread: 0.10, noSpread: 0.10,
      });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals).toHaveLength(0);
    });
  });

  describe('signal properties', () => {
    it('sets urgency to immediate', () => {
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals[0]!.urgency).toBe('immediate');
    });

    it('includes kill conditions', () => {
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      const kc = signals[0]!.kill_conditions;
      const types = kc.map((k) => k.type);
      expect(types).toContain('time_elapsed');
      expect(types).toContain('spread_widened');
      expect(types).toContain('regime_changed');
      expect(types).toContain('ev_decayed');
    });

    it('sets decay model with short half-life', () => {
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      expect(signals[0]!.decay_model.half_life_ms).toBe(10_000);
      expect(signals[0]!.decay_model.initial_ev).toBeGreaterThan(0);
    });

    it('uses max_position_size from config for trade sizing', () => {
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      const config = makeStrategyConfig({ max_position_size: 150 });
      const signals = evaluateNTimes(strategy, market, 3, { config });
      expect(signals[0]!.size_requested).toBeLessThanOrEqual(150);
    });

    it('signal strength increases with profit and persistence', () => {
      // Large gap (high profit)
      const market1 = makeMarket({ yesAsk: [0.35, 200], noAsk: [0.35, 200] });
      const strategy1 = new ComplementArbStrategy();
      const signals1 = evaluateNTimes(strategy1, market1, 5);

      // Small gap (lower profit)
      clearGapPersistence('mkt_1');
      const market2 = makeMarket({ yesAsk: [0.44, 200], noAsk: [0.44, 200] });
      const strategy2 = new ComplementArbStrategy();
      const signals2 = evaluateNTimes(strategy2, market2, 3);

      expect(signals1[0]!.signal_strength).toBeGreaterThan(signals2[0]!.signal_strength);
    });
  });

  describe('reasoning', () => {
    it('includes relevant information in reasoning string', () => {
      const market = makeMarket({ yesAsk: [0.45, 200], noAsk: [0.45, 200] });
      const strategy = new ComplementArbStrategy();

      const signals = evaluateNTimes(strategy, market, 3);
      const reasoning = signals[0]!.reasoning;
      expect(reasoning).toContain('mkt_1');
      expect(reasoning).toContain('YES ask');
      expect(reasoning).toContain('NO ask');
      expect(reasoning).toContain('Expected profit');
      expect(reasoning).toContain('P(second_leg_miss)');
    });
  });
});
