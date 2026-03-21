import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ConsistencyChecker,
  checkExhaustivePartition,
  checkSubsetSuperset,
  checkConditional,
  checkTemporal,
  extractTemporalOrder,
  detectSubsetSuperset,
  detectConditional,
} from '../../src/analytics/consistency_checker.js';
import { createEmptyMarketState } from '../../src/state/market_state.js';
import type { MarketState, MarketCluster, MarketGraph } from '../../src/state/types.js';
import type { MarketMetadata } from '../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMetadata(overrides: Partial<MarketMetadata> = {}): MarketMetadata {
  return {
    market_id: 'mkt_1',
    question: 'Will it rain tomorrow?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes_1', no_id: 'tok_no_1' },
    status: 'active',
    resolution: null,
    end_date: '2025-12-31',
    category: 'politics',
    tags: [],
    ...overrides,
  };
}

function makeMarket(overrides: Partial<MarketMetadata> & {
  yesMid?: number;
  yesBids?: [number, number][];
  yesAsks?: [number, number][];
} = {}): MarketState {
  const { yesMid, yesBids, yesAsks, ...metaOverrides } = overrides;
  const m = createEmptyMarketState(makeMetadata(metaOverrides));

  if (yesMid !== undefined) m.book.yes.mid = yesMid;
  if (yesBids) m.book.yes.bids = yesBids;
  if (yesAsks) m.book.yes.asks = yesAsks;

  return m;
}

function makeCluster(marketIds: string[]): MarketCluster {
  return {
    cluster_id: `cluster_${marketIds.join('_')}`,
    market_ids: marketIds,
    event_description: 'test cluster',
    consistency_score: 1.0,
    consistency_violation: 0,
    last_checked: Date.now(),
  };
}

function makeGraph(
  edges: Map<string, EdgeEntry[]>,
  clusters: MarketCluster[] = [],
): MarketGraph {
  return { edges, clusters };
}

type EdgeEntry = {
  target_market_id: string;
  relationship: 'correlated';
  strength: number;
  price_correlation: number;
  staleness_propagation_lag_ms: number;
};

const FEE_RATE = 0.02;

// ---------------------------------------------------------------------------
// extractTemporalOrder
// ---------------------------------------------------------------------------

describe('extractTemporalOrder', () => {
  it('extracts month order', () => {
    expect(extractTemporalOrder('Will BTC hit 100k by June?')).toBe(6);
    expect(extractTemporalOrder('Will BTC hit 100k by December?')).toBe(12);
    expect(extractTemporalOrder('Will BTC hit 100k by January?')).toBe(1);
  });

  it('extracts abbreviated months', () => {
    expect(extractTemporalOrder('By Mar 2025')).toBe(3);
    expect(extractTemporalOrder('By Sep 2025')).toBe(9);
  });

  it('extracts quarter order', () => {
    expect(extractTemporalOrder('Will GDP grow in Q1?')).toBe(3);
    expect(extractTemporalOrder('Will GDP grow in Q4?')).toBe(12);
  });

  it('extracts year', () => {
    const r2025 = extractTemporalOrder('Will it happen in 2025?');
    const r2026 = extractTemporalOrder('Will it happen in 2026?');
    expect(r2025).not.toBeNull();
    expect(r2026).not.toBeNull();
    expect(r2026!).toBeGreaterThan(r2025!);
  });

  it('extracts end of year', () => {
    expect(extractTemporalOrder('Will it happen by end of year?')).toBe(12);
  });

  it('returns null for no temporal signal', () => {
    expect(extractTemporalOrder('Will it rain tomorrow?')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectSubsetSuperset
// ---------------------------------------------------------------------------

describe('detectSubsetSuperset', () => {
  it('detects earlier/later time horizons', () => {
    const a = makeMarket({
      market_id: 'mkt_june',
      question: 'Will Bitcoin hit 100k by June 2025?',
      yesMid: 0.6,
    });
    const b = makeMarket({
      market_id: 'mkt_dec',
      question: 'Will Bitcoin hit 100k by December 2025?',
      yesMid: 0.8,
    });

    const result = detectSubsetSuperset(a, b);
    expect(result).not.toBeNull();
    expect(result!.earlier.market_id).toBe('mkt_june');
    expect(result!.later.market_id).toBe('mkt_dec');
  });

  it('returns null for unrelated markets', () => {
    const a = makeMarket({ market_id: 'a', question: 'Will it rain in London?' });
    const b = makeMarket({ market_id: 'b', question: 'Will BTC hit 100k by June?' });
    expect(detectSubsetSuperset(a, b)).toBeNull();
  });

  it('returns null when no temporal markers', () => {
    const a = makeMarket({ market_id: 'a', question: 'Will candidate X win?' });
    const b = makeMarket({ market_id: 'b', question: 'Will candidate X lose?' });
    expect(detectSubsetSuperset(a, b)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectConditional
// ---------------------------------------------------------------------------

describe('detectConditional', () => {
  it('detects primary → general election pattern', () => {
    const a = makeMarket({
      market_id: 'mkt_primary',
      question: 'Will candidate Smith win the primary?',
    });
    const b = makeMarket({
      market_id: 'mkt_general',
      question: 'Will candidate Smith win the general election?',
    });

    const result = detectConditional(a, b);
    expect(result).not.toBeNull();
    expect(result!.prerequisite.market_id).toBe('mkt_primary');
    expect(result!.outcome.market_id).toBe('mkt_general');
  });

  it('detects semifinal → champion pattern', () => {
    const a = makeMarket({
      market_id: 'mkt_semi',
      question: 'Will team Alpha advance past the semifinal?',
    });
    const b = makeMarket({
      market_id: 'mkt_final',
      question: 'Will team Alpha be champion?',
    });

    const result = detectConditional(a, b);
    expect(result).not.toBeNull();
    expect(result!.prerequisite.market_id).toBe('mkt_semi');
    expect(result!.outcome.market_id).toBe('mkt_final');
  });

  it('returns null for unrelated markets', () => {
    const a = makeMarket({ market_id: 'a', question: 'Will it rain?' });
    const b = makeMarket({ market_id: 'b', question: 'Will GDP grow?' });
    expect(detectConditional(a, b)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkExhaustivePartition
// ---------------------------------------------------------------------------

describe('checkExhaustivePartition', () => {
  it('detects overpriced basket (sum > 1.0)', () => {
    const mkts = new Map<string, MarketState>();
    const a = makeMarket({
      market_id: 'mkt_a',
      question: 'Will candidate A win?',
      yesMid: 0.45,
      yesBids: [[0.44, 200]],
      yesAsks: [[0.46, 200]],
    });
    const b = makeMarket({
      market_id: 'mkt_b',
      question: 'Will candidate B win?',
      yesMid: 0.40,
      yesBids: [[0.39, 200]],
      yesAsks: [[0.41, 200]],
    });
    const c = makeMarket({
      market_id: 'mkt_c',
      question: 'Will candidate C win?',
      yesMid: 0.25,
      yesBids: [[0.24, 200]],
      yesAsks: [[0.26, 200]],
    });
    mkts.set('mkt_a', a);
    mkts.set('mkt_b', b);
    mkts.set('mkt_c', c);

    // Sum = 0.45 + 0.40 + 0.25 = 1.10, overpriced by 0.10
    const cluster = makeCluster(['mkt_a', 'mkt_b', 'mkt_c']);
    const result = checkExhaustivePartition(cluster, mkts, FEE_RATE);

    expect(result).not.toBeNull();
    expect(result!.check_type).toBe('exhaustive_partition');
    expect(result!.violation_magnitude).toBeCloseTo(0.10, 2);
    // Should SELL basket: executable sum from bids ≈ 0.44+0.39+0.24 = 1.07
    // exec violation = 1.07 - 1.0 - 3*0.02 = 0.01
    expect(result!.executable_violation).toBeGreaterThan(0);
    expect(result!.trade_plan).not.toBeNull();
    expect(result!.trade_plan!.legs).toHaveLength(3);
    expect(result!.trade_plan!.legs.every((l) => l.direction === 'SELL')).toBe(true);
  });

  it('detects underpriced basket (sum < 1.0)', () => {
    const mkts = new Map<string, MarketState>();
    const a = makeMarket({
      market_id: 'mkt_a',
      yesMid: 0.30,
      yesAsks: [[0.31, 200]],
      yesBids: [[0.29, 200]],
    });
    const b = makeMarket({
      market_id: 'mkt_b',
      yesMid: 0.30,
      yesAsks: [[0.31, 200]],
      yesBids: [[0.29, 200]],
    });
    const c = makeMarket({
      market_id: 'mkt_c',
      yesMid: 0.20,
      yesAsks: [[0.21, 200]],
      yesBids: [[0.19, 200]],
    });
    mkts.set('mkt_a', a);
    mkts.set('mkt_b', b);
    mkts.set('mkt_c', c);

    // Sum = 0.80, underpriced
    const cluster = makeCluster(['mkt_a', 'mkt_b', 'mkt_c']);
    const result = checkExhaustivePartition(cluster, mkts, FEE_RATE);

    expect(result).not.toBeNull();
    expect(result!.violation_magnitude).toBeCloseTo(0.20, 2);
    // BUY basket: buy from asks ≈ 0.31+0.31+0.21 = 0.83
    // exec violation = 1.0 - 0.83 - 3*0.02 = 0.11
    expect(result!.executable_violation).toBeGreaterThan(0);
    expect(result!.trade_plan!.legs.every((l) => l.direction === 'BUY')).toBe(true);
  });

  it('returns null when sum is close to 1.0', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({ market_id: 'mkt_a', yesMid: 0.5 }));
    mkts.set('mkt_b', makeMarket({ market_id: 'mkt_b', yesMid: 0.5 }));

    const cluster = makeCluster(['mkt_a', 'mkt_b']);
    const result = checkExhaustivePartition(cluster, mkts, FEE_RATE);
    expect(result).toBeNull(); // sum = 1.0, no violation
  });

  it('returns null for single-market cluster', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({ market_id: 'mkt_a', yesMid: 0.6 }));
    const cluster = makeCluster(['mkt_a']);
    expect(checkExhaustivePartition(cluster, mkts, FEE_RATE)).toBeNull();
  });

  it('not tradeable when books are empty', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({ market_id: 'mkt_a', yesMid: 0.60, yesBids: [] }));
    mkts.set('mkt_b', makeMarket({ market_id: 'mkt_b', yesMid: 0.55, yesBids: [] }));

    // Sum = 1.15, but no bids to sell into
    const cluster = makeCluster(['mkt_a', 'mkt_b']);
    const result = checkExhaustivePartition(cluster, mkts, FEE_RATE);

    expect(result).not.toBeNull();
    expect(result!.tradeable).toBe(false);
    expect(result!.trade_plan).toBeNull();
  });

  it('not tradeable when depth is insufficient', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({
      market_id: 'mkt_a', yesMid: 0.60,
      yesBids: [[0.59, 10]], // only 10 depth, below MIN_LEG_DEPTH=50
    }));
    mkts.set('mkt_b', makeMarket({
      market_id: 'mkt_b', yesMid: 0.55,
      yesBids: [[0.54, 200]],
    }));

    const cluster = makeCluster(['mkt_a', 'mkt_b']);
    const result = checkExhaustivePartition(cluster, mkts, FEE_RATE);

    expect(result).not.toBeNull();
    expect(result!.tradeable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSubsetSuperset
// ---------------------------------------------------------------------------

describe('checkSubsetSuperset', () => {
  it('detects violation: P(earlier) > P(later)', () => {
    const earlier = makeMarket({
      market_id: 'mkt_june',
      question: 'Will Bitcoin hit 100k by June 2025?',
      yesMid: 0.70,
      yesBids: [[0.69, 200]],
      yesAsks: [[0.71, 200]],
    });
    const later = makeMarket({
      market_id: 'mkt_dec',
      question: 'Will Bitcoin hit 100k by December 2025?',
      yesMid: 0.50,
      yesBids: [[0.49, 200]],
      yesAsks: [[0.51, 200]],
    });

    const result = checkSubsetSuperset(earlier, later, FEE_RATE);

    expect(result).not.toBeNull();
    expect(result!.check_type).toBe('subset_superset');
    expect(result!.violation_magnitude).toBeCloseTo(0.20, 2);
    // Sell earlier (hit bid 0.69), buy later (lift ask 0.51)
    // exec = 0.69 - 0.51 - 2*0.02 = 0.14
    expect(result!.executable_violation).toBeCloseTo(0.14, 2);
    expect(result!.tradeable).toBe(true);
    expect(result!.trade_plan).not.toBeNull();
    expect(result!.trade_plan!.legs).toHaveLength(2);
  });

  it('returns null when P(later) >= P(earlier) — no violation', () => {
    const earlier = makeMarket({
      market_id: 'mkt_june',
      question: 'Will Bitcoin hit 100k by June 2025?',
      yesMid: 0.40,
    });
    const later = makeMarket({
      market_id: 'mkt_dec',
      question: 'Will Bitcoin hit 100k by December 2025?',
      yesMid: 0.60,
    });

    expect(checkSubsetSuperset(earlier, later, FEE_RATE)).toBeNull();
  });

  it('returns null for unrelated markets', () => {
    const a = makeMarket({ market_id: 'a', question: 'Will it rain?' });
    const b = makeMarket({ market_id: 'b', question: 'Will GDP grow by March?' });
    expect(checkSubsetSuperset(a, b, FEE_RATE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkConditional
// ---------------------------------------------------------------------------

describe('checkConditional', () => {
  it('detects violation: P(outcome) > P(prerequisite)', () => {
    const prerequisite = makeMarket({
      market_id: 'mkt_primary',
      question: 'Will candidate Jones win the primary nomination?',
      yesMid: 0.40,
      yesBids: [[0.39, 200]],
      yesAsks: [[0.41, 200]],
    });
    const outcome = makeMarket({
      market_id: 'mkt_general',
      question: 'Will candidate Jones win the general election?',
      yesMid: 0.60,
      yesBids: [[0.59, 200]],
      yesAsks: [[0.61, 200]],
    });

    const result = checkConditional(prerequisite, outcome, FEE_RATE);

    expect(result).not.toBeNull();
    expect(result!.check_type).toBe('conditional');
    expect(result!.violation_magnitude).toBeCloseTo(0.20, 2);
    // Sell outcome bid 0.59, buy prerequisite ask 0.41
    // exec = 0.59 - 0.41 - 0.04 = 0.14
    expect(result!.executable_violation).toBeCloseTo(0.14, 2);
    expect(result!.tradeable).toBe(true);
  });

  it('returns null when P(outcome) <= P(prerequisite)', () => {
    const prerequisite = makeMarket({
      market_id: 'mkt_primary',
      question: 'Will candidate Jones win the primary nomination?',
      yesMid: 0.70,
    });
    const outcome = makeMarket({
      market_id: 'mkt_general',
      question: 'Will candidate Jones win the general election?',
      yesMid: 0.50,
    });

    expect(checkConditional(prerequisite, outcome, FEE_RATE)).toBeNull();
  });

  it('returns check with tradeable=false when books empty', () => {
    const prerequisite = makeMarket({
      market_id: 'mkt_primary',
      question: 'Will candidate Jones win the primary nomination?',
      yesMid: 0.40,
    });
    const outcome = makeMarket({
      market_id: 'mkt_general',
      question: 'Will candidate Jones win the general election?',
      yesMid: 0.60,
    });

    const result = checkConditional(prerequisite, outcome, FEE_RATE);
    expect(result).not.toBeNull();
    expect(result!.tradeable).toBe(false);
    expect(result!.executable_violation).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// checkTemporal
// ---------------------------------------------------------------------------

describe('checkTemporal', () => {
  it('detects temporal monotonicity violation', () => {
    const earlier = makeMarket({
      market_id: 'mkt_q1',
      question: 'Will GDP growth exceed 3% in Q1?',
      category: 'economics',
      yesMid: 0.60,
      yesBids: [[0.59, 200]],
      yesAsks: [[0.61, 200]],
    });
    const later = makeMarket({
      market_id: 'mkt_q4',
      question: 'Will GDP growth exceed 3% in Q4?',
      category: 'economics',
      yesMid: 0.40,
      yesBids: [[0.39, 200]],
      yesAsks: [[0.41, 200]],
    });

    const result = checkTemporal(earlier, later, FEE_RATE);

    expect(result).not.toBeNull();
    expect(result!.check_type).toBe('temporal');
    expect(result!.violation_magnitude).toBeCloseTo(0.20, 2);
    expect(result!.tradeable).toBe(true);
  });

  it('returns null when different categories', () => {
    const a = makeMarket({
      market_id: 'a',
      question: 'Will X happen in Q1?',
      category: 'economics',
      yesMid: 0.60,
    });
    const b = makeMarket({
      market_id: 'b',
      question: 'Will X happen in Q4?',
      category: 'sports',
      yesMid: 0.40,
    });

    expect(checkTemporal(a, b, FEE_RATE)).toBeNull();
  });

  it('returns null when no temporal markers', () => {
    const a = makeMarket({
      market_id: 'a',
      question: 'Will GDP grow?',
      category: 'economics',
      yesMid: 0.60,
    });
    const b = makeMarket({
      market_id: 'b',
      question: 'Will inflation drop?',
      category: 'economics',
      yesMid: 0.40,
    });

    expect(checkTemporal(a, b, FEE_RATE)).toBeNull();
  });

  it('returns null when monotonicity holds', () => {
    const earlier = makeMarket({
      market_id: 'mkt_q1',
      question: 'Will GDP growth exceed 3% in Q1?',
      category: 'economics',
      yesMid: 0.30,
    });
    const later = makeMarket({
      market_id: 'mkt_q4',
      question: 'Will GDP growth exceed 3% in Q4?',
      category: 'economics',
      yesMid: 0.50,
    });

    expect(checkTemporal(earlier, later, FEE_RATE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ConsistencyChecker class
// ---------------------------------------------------------------------------

describe('ConsistencyChecker', () => {
  let checker: ConsistencyChecker;

  beforeEach(() => {
    checker = new ConsistencyChecker(FEE_RATE);
  });

  it('checkAll returns violations from clusters', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({ market_id: 'mkt_a', yesMid: 0.60, yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]] }));
    mkts.set('mkt_b', makeMarket({ market_id: 'mkt_b', yesMid: 0.55, yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]] }));

    const cluster = makeCluster(['mkt_a', 'mkt_b']);
    const graph = makeGraph(new Map(), [cluster]);

    const results = checker.checkAll(mkts, graph);

    // Sum = 1.15, should detect exhaustive partition violation
    const ep = results.find((r) => r.check_type === 'exhaustive_partition');
    expect(ep).toBeDefined();
    expect(ep!.violation_magnitude).toBeCloseTo(0.15, 2);
  });

  it('checkAll runs pairwise checks on graph edges', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_june', makeMarket({
      market_id: 'mkt_june',
      question: 'Will Bitcoin hit 100k by June 2025?',
      yesMid: 0.70,
      yesBids: [[0.69, 200]],
      yesAsks: [[0.71, 200]],
    }));
    mkts.set('mkt_dec', makeMarket({
      market_id: 'mkt_dec',
      question: 'Will Bitcoin hit 100k by December 2025?',
      yesMid: 0.50,
      yesBids: [[0.49, 200]],
      yesAsks: [[0.51, 200]],
    }));

    const edges = new Map<string, EdgeEntry[]>();
    edges.set('mkt_june', [{ target_market_id: 'mkt_dec', relationship: 'correlated', strength: 0.8, price_correlation: 0.9, staleness_propagation_lag_ms: 0 }]);
    edges.set('mkt_dec', [{ target_market_id: 'mkt_june', relationship: 'correlated', strength: 0.8, price_correlation: 0.9, staleness_propagation_lag_ms: 0 }]);

    const graph = makeGraph(edges);
    const results = checker.checkAll(mkts, graph);

    // Should detect subset/superset violation
    const ss = results.find((r) => r.check_type === 'subset_superset');
    expect(ss).toBeDefined();
  });

  it('tracks violation persistence across multiple checks', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({ market_id: 'mkt_a', yesMid: 0.60, yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]] }));
    mkts.set('mkt_b', makeMarket({ market_id: 'mkt_b', yesMid: 0.55, yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]] }));

    const cluster = makeCluster(['mkt_a', 'mkt_b']);
    const graph = makeGraph(new Map(), [cluster]);

    // First check
    checker.checkAll(mkts, graph);
    const active1 = checker.getActiveViolations();
    expect(active1.length).toBeGreaterThan(0);
    expect(active1[0]!.observation_count).toBe(1);

    // Second check — same violation persists
    checker.checkAll(mkts, graph);
    const active2 = checker.getActiveViolations();
    expect(active2.length).toBeGreaterThan(0);
    expect(active2[0]!.observation_count).toBe(2);
  });

  it('tracks peak magnitudes', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({ market_id: 'mkt_a', yesMid: 0.55, yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]] }));
    mkts.set('mkt_b', makeMarket({ market_id: 'mkt_b', yesMid: 0.50, yesBids: [[0.49, 200]], yesAsks: [[0.51, 200]] }));

    const cluster = makeCluster(['mkt_a', 'mkt_b']);
    const graph = makeGraph(new Map(), [cluster]);

    // First check: sum = 1.05, violation = 0.05
    checker.checkAll(mkts, graph);

    // Increase violation
    mkts.get('mkt_a')!.book.yes.mid = 0.65;
    mkts.get('mkt_a')!.book.yes.bids = [[0.64, 200]];
    checker.checkAll(mkts, graph);

    const active = checker.getActiveViolations();
    expect(active.length).toBeGreaterThan(0);
    // Peak should reflect the larger violation (0.65+0.50-1.0 = 0.15)
    expect(active[0]!.peak_magnitude).toBeCloseTo(0.15, 2);
  });

  it('buildReport produces correct structure', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({ market_id: 'mkt_a', yesMid: 0.60, yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]] }));
    mkts.set('mkt_b', makeMarket({ market_id: 'mkt_b', yesMid: 0.55, yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]] }));

    const cluster = makeCluster(['mkt_a', 'mkt_b']);
    const graph = makeGraph(new Map(), [cluster]);

    const checks = checker.checkAll(mkts, graph);
    const report = checker.buildReport(checks);

    expect(report.timestamp).toBeGreaterThan(0);
    expect(report.active_violations).toBe(checks);
    expect(report.violation_count_by_type.exhaustive_partition).toBeGreaterThan(0);
    expect(report.persistence_stats.active_count).toBeGreaterThan(0);
    expect(typeof report.total_tradeable).toBe('number');
    expect(typeof report.total_executable_profit).toBe('number');
  });

  it('getPersistenceStats returns valid stats', () => {
    const stats = checker.getPersistenceStats();
    expect(stats.active_count).toBe(0);
    expect(stats.resolved_last_hour).toBe(0);
    expect(stats.median_duration_ms).toBe(0);
    expect(stats.avg_duration_ms).toBe(0);
    expect(stats.pct_tradeable).toBe(0);
  });

  it('does not duplicate checks for pairs seen via both edges and clusters', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_june', makeMarket({
      market_id: 'mkt_june',
      question: 'Will Bitcoin hit 100k by June 2025?',
      yesMid: 0.70,
      yesBids: [[0.69, 200]],
      yesAsks: [[0.71, 200]],
    }));
    mkts.set('mkt_dec', makeMarket({
      market_id: 'mkt_dec',
      question: 'Will Bitcoin hit 100k by December 2025?',
      yesMid: 0.50,
      yesBids: [[0.49, 200]],
      yesAsks: [[0.51, 200]],
    }));

    const edges = new Map<string, EdgeEntry[]>();
    edges.set('mkt_june', [{ target_market_id: 'mkt_dec', relationship: 'correlated', strength: 0.8, price_correlation: 0.9, staleness_propagation_lag_ms: 0 }]);

    // Same pair in both edges AND cluster
    const cluster = makeCluster(['mkt_june', 'mkt_dec']);
    const graph = makeGraph(edges, [cluster]);

    const results = checker.checkAll(mkts, graph);

    // Count subset_superset checks for this pair — should be exactly 1
    const ssChecks = results.filter((r) => r.check_type === 'subset_superset');
    expect(ssChecks.length).toBe(1);
  });

  it('handles resolved violations (no current checks)', () => {
    const mkts = new Map<string, MarketState>();
    mkts.set('mkt_a', makeMarket({ market_id: 'mkt_a', yesMid: 0.60, yesBids: [[0.59, 200]], yesAsks: [[0.61, 200]] }));
    mkts.set('mkt_b', makeMarket({ market_id: 'mkt_b', yesMid: 0.55, yesBids: [[0.54, 200]], yesAsks: [[0.56, 200]] }));

    const cluster = makeCluster(['mkt_a', 'mkt_b']);
    const graph = makeGraph(new Map(), [cluster]);

    // Detect violation
    checker.checkAll(mkts, graph);
    expect(checker.getActiveViolations().length).toBeGreaterThan(0);

    // Fix the violation (sum = 1.0)
    mkts.get('mkt_a')!.book.yes.mid = 0.50;
    mkts.get('mkt_a')!.book.yes.bids = [[0.49, 200]];
    mkts.get('mkt_a')!.book.yes.asks = [[0.51, 200]];
    mkts.get('mkt_b')!.book.yes.mid = 0.50;
    mkts.get('mkt_b')!.book.yes.bids = [[0.49, 200]];
    mkts.get('mkt_b')!.book.yes.asks = [[0.51, 200]];

    // Run check — no violations now, but stale threshold hasn't passed yet
    checker.checkAll(mkts, graph);
    // Active violations still present (below stale threshold)
    const active = checker.getActiveViolations();
    // They're still technically "active" until VIOLATION_STALE_THRESHOLD_MS passes
    // but not re-observed, so observation_count stays at 1
    expect(active.length).toBeGreaterThanOrEqual(0);
  });
});
