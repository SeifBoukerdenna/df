import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordSignal,
  resolveSignal,
  getRecord,
  getRecordsByStrategy,
  getRecordsByMarket,
  getAllRecords,
  getResolvedRecords,
  reportCounterfactual,
  reportViability,
  resetShadowEngine,
} from '../../src/counterfactual/shadow_engine.js';
import type { ShadowRecord, PriceSnapshot } from '../../src/counterfactual/shadow_engine.js';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Shadow Engine', () => {
  beforeEach(() => {
    resetShadowEngine();
    signalSeq = 0;
  });

  // =========================================================================
  // recordSignal
  // =========================================================================

  describe('recordSignal', () => {
    it('creates a shadow record for a signal', () => {
      const signal = makeSignal();
      const book = makeBook();
      const record = recordSignal(signal, book, 2000);

      expect(record.signal_id).toBe(signal.signal_id);
      expect(record.strategy_id).toBe('test_strategy');
      expect(record.market_id).toBe('mkt_1');
      expect(record.resolved).toBe(false);
    });

    it('captures ideal entry as mid price', () => {
      const book = makeBook({ mid: 0.50 });
      const signal = makeSignal();
      const record = recordSignal(signal, book, 2000);

      expect(record.ideal_entry_price).toBe(0.50);
    });

    it('realistic entry differs from ideal by latency cost', () => {
      const book = makeBook({ mid: 0.50 });
      const signal = makeSignal();
      const record = recordSignal(signal, book, 2000);

      // For BUY, realistic entry should be >= ideal entry
      expect(record.realistic_entry_price).toBeGreaterThan(record.ideal_entry_price);
    });

    it('captures price snapshot correctly', () => {
      const book = makeBook({
        mid: 0.50,
        spread: 0.04,
        spread_bps: 400,
        microprice: 0.51,
        bids: [[0.48, 200]] as [number, number][],
        asks: [[0.52, 150]] as [number, number][],
      });
      const record = recordSignal(makeSignal(), book, 1000);

      expect(record.price_at_signal.mid).toBe(0.50);
      expect(record.price_at_signal.spread).toBe(0.04);
      expect(record.price_at_signal.microprice).toBe(0.51);
      expect(record.price_at_signal.best_bid).toBe(0.48);
      expect(record.price_at_signal.best_ask).toBe(0.52);
    });

    it('computes cost decomposition', () => {
      const record = recordSignal(makeSignal(), makeBook(), 2000);

      expect(record.cost_fees).toBe(0.02);
      expect(record.cost_latency).toBeGreaterThanOrEqual(0);
      expect(record.cost_slippage).toBeGreaterThanOrEqual(0);
      expect(record.cost_market_impact).toBeGreaterThanOrEqual(0);
    });

    it('computes viability at different latencies', () => {
      const record = recordSignal(makeSignal(), makeBook(), 2000);

      expect(record.viability).toBeDefined();
      expect(typeof record.viability[1000]).toBe('boolean');
      expect(typeof record.viability[5000]).toBe('boolean');
      expect(typeof record.viability[10000]).toBe('boolean');
    });

    it('computes parameter sensitivity', () => {
      const record = recordSignal(makeSignal(), makeBook(), 2000);

      expect(record.sensitivity).toBeDefined();
      expect(typeof record.sensitivity.threshold_minus_10pct_pnl).toBe('number');
      expect(typeof record.sensitivity.threshold_plus_10pct_pnl).toBe('number');
      expect(typeof record.sensitivity.size_minus_50pct_pnl).toBe('number');
      expect(typeof record.sensitivity.size_plus_50pct_pnl).toBe('number');
      expect(typeof record.sensitivity.robust).toBe('boolean');
    });

    it('indexes by strategy and market', () => {
      recordSignal(makeSignal({ strategy_id: 'strat_a' }), makeBook(), 2000);
      recordSignal(makeSignal({ strategy_id: 'strat_b' }), makeBook(), 2000);
      recordSignal(makeSignal({ strategy_id: 'strat_a', market_id: 'mkt_2' }), makeBook(), 2000);

      expect(getRecordsByStrategy('strat_a')).toHaveLength(2);
      expect(getRecordsByStrategy('strat_b')).toHaveLength(1);
      expect(getRecordsByMarket('mkt_1')).toHaveLength(2);
      expect(getRecordsByMarket('mkt_2')).toHaveLength(1);
    });

    it('stores decay model from signal', () => {
      const signal = makeSignal({
        decay_model: { half_life_ms: 30_000, initial_ev: 0.08 },
      });
      const record = recordSignal(signal, makeBook(), 2000);

      expect(record.decay_model.half_life_ms).toBe(30_000);
      expect(record.decay_model.initial_ev).toBe(0.08);
    });
  });

  // =========================================================================
  // resolveSignal
  // =========================================================================

  describe('resolveSignal', () => {
    it('computes ideal_pnl for a winning BUY signal', () => {
      const signal = makeSignal({ direction: 'BUY' });
      const book = makeBook({ mid: 0.50 });
      recordSignal(signal, book, 1000);

      const record = resolveSignal(signal.signal_id, 0.55, Date.now() + 60_000);
      expect(record).not.toBeNull();
      expect(record!.ideal_pnl).toBeCloseTo(0.05, 4); // 0.55 - 0.50
    });

    it('computes ideal_pnl for a losing BUY signal', () => {
      const signal = makeSignal({ direction: 'BUY' });
      const book = makeBook({ mid: 0.50 });
      recordSignal(signal, book, 1000);

      const record = resolveSignal(signal.signal_id, 0.45, Date.now() + 60_000);
      expect(record!.ideal_pnl).toBeCloseTo(-0.05, 4);
    });

    it('computes ideal_pnl for a SELL signal', () => {
      const signal = makeSignal({ direction: 'SELL' });
      const book = makeBook({ mid: 0.50 });
      recordSignal(signal, book, 1000);

      // SELL profits when price drops
      const record = resolveSignal(signal.signal_id, 0.45, Date.now() + 60_000);
      expect(record!.ideal_pnl).toBeCloseTo(0.05, 4); // -1 * (0.45 - 0.50)
    });

    it('signal_quality_pnl = ideal_pnl - fees', () => {
      const signal = makeSignal({ direction: 'BUY' });
      const book = makeBook({ mid: 0.50 });
      recordSignal(signal, book, 1000);

      const record = resolveSignal(signal.signal_id, 0.60, Date.now() + 60_000);
      expect(record!.signal_quality_pnl).toBeCloseTo(
        record!.ideal_pnl - 0.02, 4,
      );
    });

    it('actual_pnl accounts for all costs', () => {
      const signal = makeSignal({ direction: 'BUY' });
      const book = makeBook({ mid: 0.50 });
      recordSignal(signal, book, 1000);

      const record = resolveSignal(signal.signal_id, 0.60, Date.now() + 60_000);
      // actual_pnl should be less than ideal_pnl due to costs
      expect(record!.actual_pnl).toBeLessThan(record!.ideal_pnl);
    });

    it('correctly attributes: good_signal_good_exec', () => {
      const signal = makeSignal({ direction: 'BUY', ev_estimate: 0.10 });
      const book = makeBook({ mid: 0.50, spread: 0.005 });
      recordSignal(signal, book, 500);

      // Large price move → positive PnL even after costs
      const record = resolveSignal(signal.signal_id, 0.65, Date.now() + 60_000);
      expect(record!.signal_correct).toBe(true);
      expect(record!.actual_pnl).toBeGreaterThan(0);
      expect(record!.attribution).toBe('good_signal_good_exec');
    });

    it('correctly attributes: good_signal_bad_exec', () => {
      const signal = makeSignal({
        direction: 'BUY',
        ev_estimate: 0.01,
        size_requested: 5000, // huge size → huge impact costs
      });
      const book = makeBook({ mid: 0.50, spread: 0.10 });
      recordSignal(signal, book, 20_000); // high latency

      // Price moved in right direction but costs swamp it
      const record = resolveSignal(signal.signal_id, 0.52, Date.now() + 60_000);
      expect(record!.signal_correct).toBe(true);
      expect(record!.actual_pnl).toBeLessThanOrEqual(0);
      if (record!.actual_pnl <= 0) {
        expect(record!.attribution).toBe('good_signal_bad_exec');
      }
    });

    it('correctly attributes: bad_signal_bad_exec', () => {
      const signal = makeSignal({ direction: 'BUY' });
      const book = makeBook({ mid: 0.50 });
      recordSignal(signal, book, 2000);

      // Price moved against us
      const record = resolveSignal(signal.signal_id, 0.40, Date.now() + 60_000);
      expect(record!.signal_correct).toBe(false);
      expect(record!.attribution).toBe('bad_signal_bad_exec');
    });

    it('returns null for unknown signal', () => {
      expect(resolveSignal('nonexistent', 0.55, Date.now())).toBeNull();
    });

    it('returns null for already resolved signal', () => {
      const signal = makeSignal();
      recordSignal(signal, makeBook(), 1000);
      resolveSignal(signal.signal_id, 0.55, Date.now());
      expect(resolveSignal(signal.signal_id, 0.60, Date.now())).toBeNull();
    });

    it('updates sensitivity on resolution', () => {
      const signal = makeSignal({ ev_estimate: 0.10 });
      const book = makeBook({ mid: 0.50 });
      recordSignal(signal, book, 1000);

      const before = getRecord(signal.signal_id)!.sensitivity;
      resolveSignal(signal.signal_id, 0.60, Date.now() + 60_000);
      const after = getRecord(signal.signal_id)!.sensitivity;

      // Sensitivity should be recomputed based on actual outcome
      expect(after.threshold_minus_10pct_pnl).not.toBe(before.threshold_minus_10pct_pnl);
    });

    it('marks record as resolved', () => {
      const signal = makeSignal();
      recordSignal(signal, makeBook(), 1000);
      resolveSignal(signal.signal_id, 0.55, Date.now());

      const record = getRecord(signal.signal_id)!;
      expect(record.resolved).toBe(true);
      expect(record.outcome_price).toBe(0.55);
    });
  });

  // =========================================================================
  // Query functions
  // =========================================================================

  describe('queries', () => {
    it('getAllRecords returns all', () => {
      recordSignal(makeSignal(), makeBook(), 1000);
      recordSignal(makeSignal(), makeBook(), 1000);
      expect(getAllRecords()).toHaveLength(2);
    });

    it('getResolvedRecords filters unresolved', () => {
      const s1 = makeSignal();
      const s2 = makeSignal();
      recordSignal(s1, makeBook(), 1000);
      recordSignal(s2, makeBook(), 1000);
      resolveSignal(s1.signal_id, 0.55, Date.now());

      expect(getResolvedRecords()).toHaveLength(1);
      expect(getResolvedRecords()[0]!.signal_id).toBe(s1.signal_id);
    });

    it('getRecordsByStrategy returns correct records', () => {
      recordSignal(makeSignal({ strategy_id: 'A' }), makeBook(), 1000);
      recordSignal(makeSignal({ strategy_id: 'B' }), makeBook(), 1000);
      recordSignal(makeSignal({ strategy_id: 'A' }), makeBook(), 1000);

      expect(getRecordsByStrategy('A')).toHaveLength(2);
      expect(getRecordsByStrategy('B')).toHaveLength(1);
      expect(getRecordsByStrategy('C')).toHaveLength(0);
    });
  });

  // =========================================================================
  // reportCounterfactual
  // =========================================================================

  describe('reportCounterfactual', () => {
    it('returns empty report for unknown strategy', () => {
      const r = reportCounterfactual('nonexistent');
      expect(r.total_signals).toBe(0);
      expect(r.resolved_signals).toBe(0);
    });

    it('returns correct counts', () => {
      const s1 = makeSignal({ strategy_id: 'X' });
      const s2 = makeSignal({ strategy_id: 'X' });
      const s3 = makeSignal({ strategy_id: 'X' });
      recordSignal(s1, makeBook(), 1000);
      recordSignal(s2, makeBook(), 1000);
      recordSignal(s3, makeBook(), 1000);
      resolveSignal(s1.signal_id, 0.55, Date.now());
      resolveSignal(s2.signal_id, 0.45, Date.now());

      const r = reportCounterfactual('X');
      expect(r.total_signals).toBe(3);
      expect(r.resolved_signals).toBe(2);
    });

    it('computes averages correctly', () => {
      const book = makeBook({ mid: 0.50, spread: 0.01 });

      const s1 = makeSignal({ strategy_id: 'Y', direction: 'BUY' });
      const s2 = makeSignal({ strategy_id: 'Y', direction: 'BUY' });
      recordSignal(s1, book, 500);
      recordSignal(s2, book, 500);
      resolveSignal(s1.signal_id, 0.60, Date.now()); // +0.10
      resolveSignal(s2.signal_id, 0.55, Date.now()); // +0.05

      const r = reportCounterfactual('Y');
      expect(r.avg_ideal_pnl).toBeCloseTo(0.075, 3); // (0.10+0.05)/2
    });

    it('computes signal accuracy', () => {
      const book = makeBook({ mid: 0.50 });

      const s1 = makeSignal({ strategy_id: 'Z', direction: 'BUY' });
      const s2 = makeSignal({ strategy_id: 'Z', direction: 'BUY' });
      const s3 = makeSignal({ strategy_id: 'Z', direction: 'BUY' });
      recordSignal(s1, book, 1000);
      recordSignal(s2, book, 1000);
      recordSignal(s3, book, 1000);
      resolveSignal(s1.signal_id, 0.55, Date.now()); // correct
      resolveSignal(s2.signal_id, 0.55, Date.now()); // correct
      resolveSignal(s3.signal_id, 0.40, Date.now()); // wrong

      const r = reportCounterfactual('Z');
      expect(r.signal_accuracy).toBeCloseTo(2 / 3, 3);
    });

    it('includes attribution counts', () => {
      const book = makeBook({ mid: 0.50, spread: 0.005 });

      const s1 = makeSignal({ strategy_id: 'W', direction: 'BUY', ev_estimate: 0.10, size_requested: 10 });
      recordSignal(s1, book, 500);
      resolveSignal(s1.signal_id, 0.65, Date.now());

      const r = reportCounterfactual('W');
      expect(r.attribution_counts).toBeDefined();
      const total = Object.values(r.attribution_counts).reduce((s, v) => s + v, 0);
      expect(total).toBe(1);
    });
  });

  // =========================================================================
  // reportViability
  // =========================================================================

  describe('reportViability', () => {
    it('returns report with zero resolved for unknown strategy', () => {
      const r = reportViability('nonexistent');
      expect(r).toHaveLength(1);
      expect(r[0]!.total_resolved).toBe(0);
    });

    it('reports per-latency viability', () => {
      const signal = makeSignal({
        strategy_id: 'V',
        decay_model: { half_life_ms: 5_000, initial_ev: 0.10 },
      });
      const book = makeBook({ mid: 0.50, spread: 0.01 });
      recordSignal(signal, book, 1000);
      resolveSignal(signal.signal_id, 0.60, Date.now());

      const reports = reportViability('V');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.strategy_id).toBe('V');
      expect(reports[0]!.total_resolved).toBe(1);
      expect(reports[0]!.latency_viability[1000]).toBeDefined();
      expect(reports[0]!.latency_viability[5000]).toBeDefined();
    });

    it('shorter latency is more viable than longer', () => {
      const signal = makeSignal({
        strategy_id: 'V2',
        decay_model: { half_life_ms: 3_000, initial_ev: 0.05 },
        size_requested: 50,
      });
      const book = makeBook({ mid: 0.50, spread: 0.01 });
      recordSignal(signal, book, 1000);
      resolveSignal(signal.signal_id, 0.55, Date.now());

      const reports = reportViability('V2');
      const v = reports[0]!.latency_viability;

      // With fast decay, short latency should be more viable
      expect(v[1000]!.viable_pct).toBeGreaterThanOrEqual(v[30000]!.viable_pct);
    });

    it('reports all strategies when no filter', () => {
      recordSignal(makeSignal({ strategy_id: 'A' }), makeBook(), 1000);
      recordSignal(makeSignal({ strategy_id: 'B' }), makeBook(), 1000);

      const reports = reportViability();
      expect(reports.length).toBeGreaterThanOrEqual(2);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    it('handles zero-spread book', () => {
      const book = makeBook({ mid: 0.50, spread: 0, spread_bps: 0 });
      const signal = makeSignal();
      const record = recordSignal(signal, book, 1000);

      expect(record.cost_slippage).toBe(0);
    });

    it('handles zero-size signal', () => {
      const signal = makeSignal({ size_requested: 0 });
      const record = recordSignal(signal, makeBook(), 1000);

      expect(record.cost_market_impact).toBe(0);
    });

    it('handles empty book bids/asks', () => {
      const book = makeBook({
        bids: [] as [number, number][],
        asks: [] as [number, number][],
      });
      const record = recordSignal(makeSignal(), book, 1000);

      expect(record.price_at_signal.best_bid).toBe(0);
      expect(record.price_at_signal.best_ask).toBe(0);
    });

    it('handles very high latency', () => {
      const signal = makeSignal({
        decay_model: { half_life_ms: 1_000, initial_ev: 0.05 },
      });
      const record = recordSignal(signal, makeBook(), 60_000);
      // With 1s half-life and 60s latency, most EV is decayed
      expect(record.realistic_entry_price).toBeGreaterThan(record.ideal_entry_price);
    });
  });

  // =========================================================================
  // reset
  // =========================================================================

  describe('resetShadowEngine', () => {
    it('clears all state', () => {
      recordSignal(makeSignal(), makeBook(), 1000);
      recordSignal(makeSignal(), makeBook(), 1000);

      expect(getAllRecords()).toHaveLength(2);
      resetShadowEngine();
      expect(getAllRecords()).toHaveLength(0);
    });
  });
});
