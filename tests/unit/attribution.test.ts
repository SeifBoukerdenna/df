import { describe, it, expect, beforeEach } from 'vitest';
import {
  reportAttribution,
  parsePeriod,
} from '../../src/counterfactual/attribution.js';
import {
  recordSignal,
  resolveSignal,
  resetShadowEngine,
} from '../../src/counterfactual/shadow_engine.js';
import type { TradeSignal } from '../../src/ledger/types.js';
import type { OrderBook } from '../../src/state/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let signalSeq = 0;

function makeBook(overrides: Partial<OrderBook> = {}): OrderBook {
  return {
    bids: [[0.48, 200], [0.47, 300]] as [number, number][],
    asks: [[0.52, 200], [0.53, 300]] as [number, number][],
    mid: 0.50,
    spread: 0.04,
    spread_bps: 400,
    imbalance: 0.0,
    imbalance_weighted: 0.0,
    top_of_book_stability_ms: 5000,
    queue_depth_at_best: 200,
    microprice: 0.50,
    last_updated: Date.now(),
    ...overrides,
  };
}

function makeSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  signalSeq++;
  return {
    signal_id: `sig_${signalSeq}`,
    strategy_id: 'test_strategy',
    timestamp: Date.now(),
    market_id: 'mkt_1',
    token_id: 'tok_yes',
    direction: 'BUY',
    target_price: 0.50,
    max_price: 0.55,
    size_requested: 100,
    urgency: 'patient',
    ev_estimate: 0.05,
    ev_confidence_interval: [0.02, 0.08] as [number, number],
    ev_after_costs: 0.03,
    signal_strength: 0.7,
    expected_holding_period_ms: 60_000,
    expected_sharpe_contribution: 0,
    correlation_with_existing: 0,
    reasoning: 'Test signal',
    kill_conditions: [{ type: 'time_elapsed', threshold: 300_000 }],
    regime_assumption: 'normal',
    decay_model: { half_life_ms: 60_000, initial_ev: 0.05 },
    ...overrides,
  };
}

function seedRecords(
  strategyId: string,
  count: number,
  opts: { outcomePrice?: number; baseTimestamp?: number } = {},
): void {
  const base = opts.baseTimestamp ?? Date.now();
  for (let i = 0; i < count; i++) {
    const signal = makeSignal({
      strategy_id: strategyId,
      timestamp: base - i * 1000,
      direction: 'BUY',
    });
    const book = makeBook({ mid: 0.50 });
    recordSignal(signal, book, 1000);
    if (opts.outcomePrice !== undefined) {
      resolveSignal(signal.signal_id, opts.outcomePrice, base + 60_000);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Attribution', () => {
  beforeEach(() => {
    resetShadowEngine();
    signalSeq = 0;
  });

  // =========================================================================
  // parsePeriod
  // =========================================================================

  describe('parsePeriod', () => {
    it('parses 1d', () => {
      expect(parsePeriod('1d')).toBe(86_400_000);
    });

    it('parses 7d', () => {
      expect(parsePeriod('7d')).toBe(7 * 86_400_000);
    });

    it('parses 14d', () => {
      expect(parsePeriod('14d')).toBe(14 * 86_400_000);
    });

    it('parses 30d', () => {
      expect(parsePeriod('30d')).toBe(30 * 86_400_000);
    });

    it('parses arbitrary Nd format', () => {
      expect(parsePeriod('2d')).toBe(2 * 86_400_000);
      expect(parsePeriod('90d')).toBe(90 * 86_400_000);
    });

    it('defaults to 7d for unparseable string', () => {
      expect(parsePeriod('')).toBe(604_800_000);
      expect(parsePeriod('foo')).toBe(604_800_000);
    });
  });

  // =========================================================================
  // reportAttribution basics
  // =========================================================================

  describe('reportAttribution', () => {
    it('returns empty strategies array when no records', () => {
      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000);
      expect(r.strategies).toHaveLength(0);
    });

    it('returns all strategies when no filter', () => {
      seedRecords('strat_A', 3, { outcomePrice: 0.55 });
      seedRecords('strat_B', 2, { outcomePrice: 0.55 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000);
      expect(r.strategies).toHaveLength(2);
    });

    it('filters by strategy when specified', () => {
      seedRecords('strat_A', 3, { outcomePrice: 0.55 });
      seedRecords('strat_B', 2, { outcomePrice: 0.55 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'strat_A');
      expect(r.strategies).toHaveLength(1);
      expect(r.strategies[0]!.strategy_id).toBe('strat_A');
    });

    it('excludes unresolved records', () => {
      const now = Date.now();
      seedRecords('strat_X', 3, { outcomePrice: 0.55, baseTimestamp: now });
      // Add unresolved
      const sig = makeSignal({ strategy_id: 'strat_X', timestamp: now });
      recordSignal(sig, makeBook(), 1000);

      const r = reportAttribution(parsePeriod('7d'), now + 120_000, 'strat_X');
      expect(r.strategies[0]!.resolved_signals).toBe(3);
    });

    it('filters by time period', () => {
      const now = Date.now();
      const oneDayAgo = now - 86_400_000;
      const twoDaysAgo = now - 2 * 86_400_000;

      // Records from today
      seedRecords('strat_T', 2, { outcomePrice: 0.55, baseTimestamp: now });
      // Records from 2 days ago — outside 1d window
      seedRecords('strat_T', 3, { outcomePrice: 0.55, baseTimestamp: twoDaysAgo });

      const r = reportAttribution(parsePeriod('1d'), now + 120_000, 'strat_T');
      // Only recent records should count
      expect(r.strategies[0]!.resolved_signals).toBe(2);
    });
  });

  // =========================================================================
  // Attribution values
  // =========================================================================

  describe('attribution values', () => {
    it('avg_ideal_pnl is positive for winning signals', () => {
      seedRecords('win', 5, { outcomePrice: 0.60 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'win');
      expect(r.strategies[0]!.avg_ideal_pnl).toBeGreaterThan(0);
    });

    it('avg_ideal_pnl is negative for losing signals', () => {
      seedRecords('lose', 5, { outcomePrice: 0.40 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'lose');
      expect(r.strategies[0]!.avg_ideal_pnl).toBeLessThan(0);
    });

    it('signal_alpha equals avg_ideal_pnl (pure signal quality)', () => {
      seedRecords('alpha', 5, { outcomePrice: 0.60 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'alpha');
      const s = r.strategies[0]!;
      // signal_alpha = avg_ideal_pnl by definition
      expect(s.signal_alpha).toBeCloseTo(s.avg_ideal_pnl, 6);
    });

    it('execution_alpha is avg_actual_pnl - avg_ideal_pnl (negative due to costs)', () => {
      seedRecords('exec', 5, { outcomePrice: 0.60 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'exec');
      const s = r.strategies[0]!;
      // execution_alpha = avg_actual - avg_ideal, negative when costs erode
      expect(s.execution_alpha).toBeCloseTo(s.avg_actual_pnl - s.avg_ideal_pnl, 6);
      expect(s.execution_alpha).toBeLessThanOrEqual(0);
    });

    it('signal_accuracy reflects correct/total', () => {
      const now = Date.now();
      
      // 3 winning signals  
      for (let i = 0; i < 3; i++) {
        const sig = makeSignal({ strategy_id: 'acc', direction: 'BUY', timestamp: now - i * 1000 });
        recordSignal(sig, makeBook({ mid: 0.50 }), 1000);
        resolveSignal(sig.signal_id, 0.55, now + 60_000);
      }
      // 2 losing signals
      for (let i = 0; i < 2; i++) {
        const sig = makeSignal({ strategy_id: 'acc', direction: 'BUY', timestamp: now - (i + 3) * 1000 });
        recordSignal(sig, makeBook({ mid: 0.50 }), 1000);
        resolveSignal(sig.signal_id, 0.45, now + 60_000);
      }

      const r = reportAttribution(parsePeriod('7d'), now + 120_000, 'acc');
      expect(r.strategies[0]!.signal_accuracy).toBeCloseTo(0.6, 2);
    });

    it('cost_breakdown_pct values sum to approximately 1', () => {
      seedRecords('cost', 10, { outcomePrice: 0.60 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'cost');
      const breakdown = r.strategies[0]!.cost_breakdown_pct;
      const sum = breakdown.latency_pct + breakdown.slippage_pct + breakdown.fees_pct + breakdown.market_impact_pct;
      // Should sum to ~1.0 (allowing small float errors)
      expect(sum).toBeCloseTo(1.0, 1);
    });

    it('cost_breakdown_abs values are non-negative', () => {
      seedRecords('abs', 5, { outcomePrice: 0.55 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'abs');
      const abs = r.strategies[0]!.cost_breakdown_abs;
      expect(abs.avg_latency).toBeGreaterThanOrEqual(0);
      expect(abs.avg_slippage).toBeGreaterThanOrEqual(0);
      expect(abs.avg_fees).toBeGreaterThanOrEqual(0);
      expect(abs.avg_market_impact).toBeGreaterThanOrEqual(0);
    });

    it('attribution_counts tally correctly', () => {
      seedRecords('tally', 5, { outcomePrice: 0.55 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'tally');
      const counts = r.strategies[0]!.attribution_counts;
      const total = counts.good_signal_good_exec +
        counts.good_signal_bad_exec +
        counts.bad_signal_good_exec +
        counts.bad_signal_bad_exec;
      expect(total).toBe(5);
    });

    it('robust_signal_pct is between 0 and 1', () => {
      seedRecords('rob', 5, { outcomePrice: 0.55 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000, 'rob');
      const pct = r.strategies[0]!.robust_signal_pct;
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(1);
    });
  });

  // =========================================================================
  // Portfolio-level metrics
  // =========================================================================

  describe('portfolio-level', () => {
    it('computes portfolio_avg_ideal_pnl', () => {
      seedRecords('P1', 3, { outcomePrice: 0.60 });
      seedRecords('P2', 3, { outcomePrice: 0.55 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000);
      expect(r.portfolio_avg_ideal_pnl).toBeDefined();
      expect(typeof r.portfolio_avg_ideal_pnl).toBe('number');
    });

    it('computes portfolio_avg_actual_pnl', () => {
      seedRecords('Q1', 3, { outcomePrice: 0.60 });
      seedRecords('Q2', 3, { outcomePrice: 0.55 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000);
      expect(typeof r.portfolio_avg_actual_pnl).toBe('number');
      expect(r.portfolio_avg_actual_pnl).toBeLessThanOrEqual(r.portfolio_avg_ideal_pnl);
    });

    it('total_signals sums all strategies', () => {
      seedRecords('R1', 3, { outcomePrice: 0.55 });
      seedRecords('R2', 5, { outcomePrice: 0.55 });

      const r = reportAttribution(parsePeriod('7d'), Date.now() + 120_000);
      expect(r.total_signals).toBe(8);
    });
  });
});
