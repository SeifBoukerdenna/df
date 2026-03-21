import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PropagationModel } from '../../src/analytics/propagation_model.js';
import type { MarketGraph, MarketRelationship } from '../../src/state/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGraph(
  edgeMap: Record<string, { target: string; correlation: number }[]>,
): MarketGraph {
  const edges = new Map<string, MarketRelationship[]>();
  for (const [source, targets] of Object.entries(edgeMap)) {
    edges.set(
      source,
      targets.map((t) => ({
        target_market_id: t.target,
        relationship: 'correlated' as const,
        strength: 0.8,
        price_correlation: t.correlation,
        staleness_propagation_lag_ms: 0,
      })),
    );
  }
  return { edges, clusters: [] };
}

// Use a temp dir for test persistence
const TEST_DATA_DIR = '/tmp/propagation_test_' + Date.now();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PropagationModel', () => {
  let model: PropagationModel;
  let graph: MarketGraph;

  beforeEach(() => {
    model = new PropagationModel(3000, TEST_DATA_DIR);
    graph = makeGraph({
      mkt_a: [{ target: 'mkt_b', correlation: 0.8 }],
      mkt_b: [{ target: 'mkt_a', correlation: 0.8 }],
    });
  });

  // -----------------------------------------------------------------------
  // Basic price tracking
  // -----------------------------------------------------------------------

  it('records prices without error', () => {
    model.onPriceUpdate('mkt_a', 0.50, 1000, graph);
    model.onPriceUpdate('mkt_a', 0.51, 2000, graph);
    expect(model.getPendingMoveCount()).toBe(0); // not enough history for sigma
  });

  // -----------------------------------------------------------------------
  // Significant move detection
  // -----------------------------------------------------------------------

  it('detects significant move after enough price history', () => {
    // Build up enough observations for stddev (need MIN_OBSERVATIONS_FOR_SIGMA + 1 = 11)
    let t = 1000;
    for (let i = 0; i < 15; i++) {
      // Small oscillations: 0.50 ± 0.005 → stddev ≈ 0.005
      const price = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
      model.onPriceUpdate('mkt_a', price, t, graph);
      model.onPriceUpdate('mkt_b', 0.40, t, graph); // stable target
      t += 1000;
    }

    expect(model.getPendingMoveCount()).toBe(0);

    // Now make a large move: 0.50 → 0.55 (10x the usual oscillation)
    model.onPriceUpdate('mkt_a', 0.55, t, graph);

    // Should create a pending move targeting mkt_b
    expect(model.getPendingMoveCount()).toBeGreaterThan(0);
  });

  it('does not detect move below sigma threshold', () => {
    let t = 1000;
    // Build history with oscillations of ~0.01
    for (let i = 0; i < 15; i++) {
      const price = 0.50 + (i % 2 === 0 ? 0.01 : -0.01);
      model.onPriceUpdate('mkt_a', price, t, graph);
      model.onPriceUpdate('mkt_b', 0.40, t, graph);
      t += 1000;
    }

    // Move within normal range
    model.onPriceUpdate('mkt_a', 0.505, t, graph);
    expect(model.getPendingMoveCount()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Propagation event recording
  // -----------------------------------------------------------------------

  it('records propagation event when target reacts to source move', () => {
    let t = 1000;

    // Build price history for both markets
    for (let i = 0; i < 15; i++) {
      const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
      model.onPriceUpdate('mkt_a', priceA, t, graph);
      model.onPriceUpdate('mkt_b', 0.40, t, graph);
      t += 1000;
    }

    // Significant upward move in A
    model.onPriceUpdate('mkt_a', 0.55, t, graph);
    expect(model.getPendingMoveCount()).toBeGreaterThan(0);
    const moveTime = t;

    // B reacts 500ms later
    t += 500;
    model.onPriceUpdate('mkt_b', 0.44, t, graph);

    // Should have recorded a propagation event
    const events = model.getEventsForPair('mkt_a', 'mkt_b');
    expect(events.length).toBeGreaterThan(0);

    const event = events[events.length - 1]!;
    expect(event.source_market_id).toBe('mkt_a');
    expect(event.target_market_id).toBe('mkt_b');
    expect(event.propagation_lag_ms).toBe(500);
    expect(event.propagation_efficiency).toBeGreaterThan(0);
    expect(event.source_move).toBeGreaterThan(0);
  });

  it('ignores target move in wrong direction', () => {
    let t = 1000;

    for (let i = 0; i < 15; i++) {
      const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
      model.onPriceUpdate('mkt_a', priceA, t, graph);
      model.onPriceUpdate('mkt_b', 0.40, t, graph);
      t += 1000;
    }

    // A moves up
    model.onPriceUpdate('mkt_a', 0.55, t, graph);
    t += 500;

    // B moves DOWN (wrong direction for positive correlation)
    model.onPriceUpdate('mkt_b', 0.35, t, graph);

    const events = model.getEventsForPair('mkt_a', 'mkt_b');
    expect(events.length).toBe(0);
  });

  it('ignores target move that is too small', () => {
    let t = 1000;

    for (let i = 0; i < 15; i++) {
      const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
      model.onPriceUpdate('mkt_a', priceA, t, graph);
      model.onPriceUpdate('mkt_b', 0.40, t, graph);
      t += 1000;
    }

    // A moves up by 0.05
    model.onPriceUpdate('mkt_a', 0.55, t, graph);
    t += 500;

    // B moves up but only by 0.001 (< 10% of A's 0.05 move)
    model.onPriceUpdate('mkt_b', 0.401, t, graph);

    const events = model.getEventsForPair('mkt_a', 'mkt_b');
    expect(events.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Pending move expiry
  // -----------------------------------------------------------------------

  it('expires pending moves after propagation window', () => {
    let t = 1000;

    for (let i = 0; i < 15; i++) {
      const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
      model.onPriceUpdate('mkt_a', priceA, t, graph);
      model.onPriceUpdate('mkt_b', 0.40, t, graph);
      t += 1000;
    }

    // Significant move
    model.onPriceUpdate('mkt_a', 0.55, t, graph);
    expect(model.getPendingMoveCount()).toBeGreaterThan(0);

    // Wait beyond propagation window (60s) + trigger cleanup
    t += 70_000;
    model.onPriceUpdate('mkt_a', 0.55, t, graph);

    expect(model.getPendingMoveCount()).toBe(0);
  });

  it('tick() cleans up expired pending moves', () => {
    let t = 1000;

    for (let i = 0; i < 15; i++) {
      const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
      model.onPriceUpdate('mkt_a', priceA, t, graph);
      model.onPriceUpdate('mkt_b', 0.40, t, graph);
      t += 1000;
    }

    model.onPriceUpdate('mkt_a', 0.55, t, graph);
    expect(model.getPendingMoveCount()).toBeGreaterThan(0);

    // Mock Date.now to advance past the window
    vi.spyOn(Date, 'now').mockReturnValue(t + 70_000);
    model.tick();
    vi.restoreAllMocks();

    expect(model.getPendingMoveCount()).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Pair statistics
  // -----------------------------------------------------------------------

  it('computes pair stats from multiple events', () => {
    // Use a fresh model for this test to avoid accumulated history
    const m = new PropagationModel(3000, TEST_DATA_DIR);
    let t = 1000;

    // Build initial history with very stable prices (tiny stddev)
    for (let i = 0; i < 15; i++) {
      m.onPriceUpdate('mkt_a', 0.500, t, graph);
      m.onPriceUpdate('mkt_b', 0.400, t, graph);
      t += 1000;
    }

    // Now trigger propagation events with known lags
    // Each: bump A up, wait, bump B up, then reset both to baseline
    const lags = [200, 400, 500, 800, 1200];
    for (const lag of lags) {
      // Small variation to keep stddev stable but tiny
      m.onPriceUpdate('mkt_a', 0.501, t, graph);
      m.onPriceUpdate('mkt_b', 0.400, t, graph);
      t += 1000;

      // Big move in A
      m.onPriceUpdate('mkt_a', 0.550, t, graph);
      t += lag;
      // B reacts
      m.onPriceUpdate('mkt_b', 0.440, t, graph);
      t += 2000;

      // Reset to baseline for next cycle
      m.onPriceUpdate('mkt_a', 0.500, t, graph);
      m.onPriceUpdate('mkt_b', 0.400, t, graph);
      t += 1000;
    }

    const events = m.getEventsForPair('mkt_a', 'mkt_b');
    expect(events.length).toBeGreaterThanOrEqual(5);

    const stats = m.computePairStats('mkt_a', 'mkt_b');
    expect(stats).not.toBeNull();
    expect(stats!.n_events).toBeGreaterThanOrEqual(5);
    expect(stats!.p25_lag_ms).toBeLessThanOrEqual(stats!.median_lag_ms);
    expect(stats!.p75_lag_ms).toBeGreaterThanOrEqual(stats!.median_lag_ms);
    expect(stats!.mean_efficiency).toBeGreaterThan(0);
  });

  it('returns null stats for pairs with insufficient data', () => {
    expect(model.computePairStats('mkt_a', 'mkt_b')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Exploitability
  // -----------------------------------------------------------------------

  it('flags pair as exploitable when median lag > execution time', () => {
    // Model with 1s execution time
    const fastModel = new PropagationModel(1000, TEST_DATA_DIR);
    let t = 1000;

    function triggerProp(lagMs: number): void {
      for (let i = 0; i < 15; i++) {
        const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
        fastModel.onPriceUpdate('mkt_a', priceA, t, graph);
        fastModel.onPriceUpdate('mkt_b', 0.40, t, graph);
        t += 1000;
      }
      fastModel.onPriceUpdate('mkt_a', 0.55, t, graph);
      t += lagMs;
      fastModel.onPriceUpdate('mkt_b', 0.44, t, graph);
      t += 5000;
    }

    // Lags all >1s: exploitable
    triggerProp(2000);
    triggerProp(3000);
    triggerProp(2500);

    const stats = fastModel.computePairStats('mkt_a', 'mkt_b');
    expect(stats).not.toBeNull();
    expect(stats!.exploitable).toBe(true);
  });

  it('flags pair as not exploitable when lag < execution time', () => {
    // Model with 5s execution time
    const slowModel = new PropagationModel(5000, TEST_DATA_DIR);
    let t = 1000;

    function triggerProp(lagMs: number): void {
      for (let i = 0; i < 15; i++) {
        const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
        slowModel.onPriceUpdate('mkt_a', priceA, t, graph);
        slowModel.onPriceUpdate('mkt_b', 0.40, t, graph);
        t += 1000;
      }
      slowModel.onPriceUpdate('mkt_a', 0.55, t, graph);
      t += lagMs;
      slowModel.onPriceUpdate('mkt_b', 0.44, t, graph);
      t += 5000;
    }

    // Lags all <5s: not exploitable
    triggerProp(500);
    triggerProp(1000);
    triggerProp(800);

    const stats = slowModel.computePairStats('mkt_a', 'mkt_b');
    expect(stats).not.toBeNull();
    expect(stats!.exploitable).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------

  it('builds a report', () => {
    const report = model.buildReport();
    expect(report.timestamp).toBeGreaterThan(0);
    expect(report.pairs_tracked).toBe(0);
    expect(report.total_events).toBe(0);
    expect(report.pending_moves).toBe(0);
    expect(report.exploitable_pairs).toHaveLength(0);
    expect(report.all_pairs).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Negative correlation
  // -----------------------------------------------------------------------

  it('handles negatively correlated pairs', () => {
    const negGraph = makeGraph({
      mkt_a: [{ target: 'mkt_b', correlation: -0.8 }],
      mkt_b: [{ target: 'mkt_a', correlation: -0.8 }],
    });

    let t = 1000;
    for (let i = 0; i < 15; i++) {
      const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
      model.onPriceUpdate('mkt_a', priceA, t, negGraph);
      model.onPriceUpdate('mkt_b', 0.50, t, negGraph);
      t += 1000;
    }

    // A moves UP
    model.onPriceUpdate('mkt_a', 0.55, t, negGraph);
    t += 500;

    // B moves DOWN (correct for negative correlation)
    model.onPriceUpdate('mkt_b', 0.45, t, negGraph);

    const events = model.getEventsForPair('mkt_a', 'mkt_b');
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.propagation_lag_ms).toBe(500);
  });

  // -----------------------------------------------------------------------
  // Multiple targets
  // -----------------------------------------------------------------------

  it('tracks propagation to multiple targets from single source', () => {
    const multiGraph = makeGraph({
      mkt_a: [
        { target: 'mkt_b', correlation: 0.8 },
        { target: 'mkt_c', correlation: 0.6 },
      ],
      mkt_b: [{ target: 'mkt_a', correlation: 0.8 }],
      mkt_c: [{ target: 'mkt_a', correlation: 0.6 }],
    });

    let t = 1000;
    for (let i = 0; i < 15; i++) {
      const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
      model.onPriceUpdate('mkt_a', priceA, t, multiGraph);
      model.onPriceUpdate('mkt_b', 0.40, t, multiGraph);
      model.onPriceUpdate('mkt_c', 0.30, t, multiGraph);
      t += 1000;
    }

    // A moves
    model.onPriceUpdate('mkt_a', 0.55, t, multiGraph);

    // B reacts at +300ms
    t += 300;
    model.onPriceUpdate('mkt_b', 0.44, t, multiGraph);

    // C reacts at +700ms (400ms after B)
    t += 400;
    model.onPriceUpdate('mkt_c', 0.34, t, multiGraph);

    expect(model.getEventsForPair('mkt_a', 'mkt_b').length).toBe(1);
    expect(model.getEventsForPair('mkt_a', 'mkt_c').length).toBe(1);

    // B should have 300ms lag, C should have 700ms lag
    expect(model.getEventsForPair('mkt_a', 'mkt_b')[0]!.propagation_lag_ms).toBe(300);
    expect(model.getEventsForPair('mkt_a', 'mkt_c')[0]!.propagation_lag_ms).toBe(700);
  });

  // -----------------------------------------------------------------------
  // Execution time update
  // -----------------------------------------------------------------------

  it('setEstimatedExecutionMs updates exploitability flag', () => {
    let t = 1000;

    function triggerProp(lagMs: number): void {
      for (let i = 0; i < 15; i++) {
        const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
        model.onPriceUpdate('mkt_a', priceA, t, graph);
        model.onPriceUpdate('mkt_b', 0.40, t, graph);
        t += 1000;
      }
      model.onPriceUpdate('mkt_a', 0.55, t, graph);
      t += lagMs;
      model.onPriceUpdate('mkt_b', 0.44, t, graph);
      t += 5000;
    }

    triggerProp(2000);
    triggerProp(2500);
    triggerProp(3000);

    // Default execution is 3000ms — median lag ~2500, not exploitable
    const stats1 = model.computePairStats('mkt_a', 'mkt_b');
    expect(stats1!.exploitable).toBe(false);

    // Lower execution time to 1000ms
    model.setEstimatedExecutionMs(1000);
    const stats2 = model.computePairStats('mkt_a', 'mkt_b');
    expect(stats2!.exploitable).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  it('saveStatsSnapshot and loadStatsSnapshot roundtrip', () => {
    const m = new PropagationModel(3000, TEST_DATA_DIR);
    let t = 1000;

    // Build stable history
    for (let i = 0; i < 15; i++) {
      m.onPriceUpdate('mkt_a', 0.500, t, graph);
      m.onPriceUpdate('mkt_b', 0.400, t, graph);
      t += 1000;
    }

    // Trigger 3 propagation events
    for (const lag of [500, 700, 600]) {
      m.onPriceUpdate('mkt_a', 0.501, t, graph);
      t += 1000;
      m.onPriceUpdate('mkt_a', 0.550, t, graph);
      t += lag;
      m.onPriceUpdate('mkt_b', 0.440, t, graph);
      t += 2000;
      m.onPriceUpdate('mkt_a', 0.500, t, graph);
      m.onPriceUpdate('mkt_b', 0.400, t, graph);
      t += 1000;
    }

    m.saveStatsSnapshot();

    const loaded = m.loadStatsSnapshot();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.source_market_id).toBe('mkt_a');
    expect(loaded[0]!.target_market_id).toBe('mkt_b');
    expect(loaded[0]!.n_events).toBeGreaterThanOrEqual(3);
  });

  it('loadStatsSnapshot returns empty when no file', () => {
    const fresh = new PropagationModel(3000, '/tmp/nonexistent_' + Date.now());
    expect(fresh.loadStatsSnapshot()).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  it('ignores markets not in graph', () => {
    const emptyGraph = makeGraph({});

    let t = 1000;
    for (let i = 0; i < 15; i++) {
      model.onPriceUpdate('mkt_a', 0.50 + (i % 2 === 0 ? 0.005 : -0.005), t, emptyGraph);
      t += 1000;
    }

    model.onPriceUpdate('mkt_a', 0.55, t, emptyGraph);
    expect(model.getPendingMoveCount()).toBe(0);
  });

  it('skips edges with low correlation', () => {
    const weakGraph = makeGraph({
      mkt_a: [{ target: 'mkt_b', correlation: 0.1 }], // below 0.2 threshold
    });

    let t = 1000;
    for (let i = 0; i < 15; i++) {
      model.onPriceUpdate('mkt_a', 0.50 + (i % 2 === 0 ? 0.005 : -0.005), t, weakGraph);
      model.onPriceUpdate('mkt_b', 0.40, t, weakGraph);
      t += 1000;
    }

    model.onPriceUpdate('mkt_a', 0.55, t, weakGraph);
    expect(model.getPendingMoveCount()).toBe(0);
  });

  it('getAllPairStats caches results', () => {
    let t = 1000;

    function triggerProp(lagMs: number): void {
      for (let i = 0; i < 15; i++) {
        const priceA = 0.50 + (i % 2 === 0 ? 0.005 : -0.005);
        model.onPriceUpdate('mkt_a', priceA, t, graph);
        model.onPriceUpdate('mkt_b', 0.40, t, graph);
        t += 1000;
      }
      model.onPriceUpdate('mkt_a', 0.55, t, graph);
      t += lagMs;
      model.onPriceUpdate('mkt_b', 0.44, t, graph);
      t += 5000;
    }

    triggerProp(500);
    triggerProp(700);
    triggerProp(600);

    const stats1 = model.getAllPairStats();
    const stats2 = model.getAllPairStats();
    expect(stats1).toEqual(stats2);
    expect(stats1.length).toBe(1);
  });
});
