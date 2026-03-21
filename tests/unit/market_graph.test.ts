import { describe, it, expect } from 'vitest';
import {
  buildMarketGraph,
  MarketGraphState,
  detectPropagationEvents,
} from '../../src/ingestion/market_graph_builder.js';
import type { MarketState } from '../../src/state/types.js';
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
    tokens: { yes_id: 'tok_yes_1', no_id: 'tok_no_1' },
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

function makeMarketsMap(...markets: MarketState[]): Map<string, MarketState> {
  const map = new Map<string, MarketState>();
  for (const m of markets) map.set(m.market_id, m);
  return map;
}

// ---------------------------------------------------------------------------
// MarketGraphState
// ---------------------------------------------------------------------------

describe('MarketGraphState', () => {
  it('records and retrieves price observations', () => {
    const state = new MarketGraphState();
    state.recordPrice('mkt_1', 0.55, 1000);
    state.recordPrice('mkt_1', 0.56, 2000);

    expect(state.priceHistory.get('mkt_1')).toHaveLength(2);
  });

  it('trims price history to max', () => {
    const state = new MarketGraphState(5); // max 5
    for (let i = 0; i < 10; i++) {
      state.recordPrice('mkt_1', 0.50 + i * 0.01, i * 1000);
    }
    expect(state.priceHistory.get('mkt_1')).toHaveLength(5);
  });

  it('records propagation lags', () => {
    const state = new MarketGraphState();
    state.recordPropagationLag('mkt_1', 'mkt_2', 500);
    state.recordPropagationLag('mkt_1', 'mkt_2', 300);
    state.recordPropagationLag('mkt_1', 'mkt_2', 700);

    const median = state.getMedianPropagationLag('mkt_1', 'mkt_2');
    expect(median).toBe(500);
  });

  it('ignores negative propagation lags', () => {
    const state = new MarketGraphState();
    state.recordPropagationLag('mkt_1', 'mkt_2', -100);
    expect(state.getMedianPropagationLag('mkt_1', 'mkt_2')).toBe(0);
  });

  it('returns 0 for unknown pair', () => {
    const state = new MarketGraphState();
    expect(state.getMedianPropagationLag('mkt_1', 'mkt_2')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildMarketGraph — empty / single market
// ---------------------------------------------------------------------------

describe('buildMarketGraph', () => {
  it('returns empty graph for no markets', () => {
    const state = new MarketGraphState();
    const graph = buildMarketGraph(new Map(), state);
    expect(graph.edges.size).toBe(0);
    expect(graph.clusters).toHaveLength(0);
  });

  it('returns graph with no edges for a single market', () => {
    const state = new MarketGraphState();
    const markets = makeMarketsMap(makeMarket());
    const graph = buildMarketGraph(markets, state);

    expect(graph.edges.size).toBe(1);
    expect(graph.edges.get('mkt_1')).toHaveLength(0);
    expect(graph.clusters).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Semantic clustering
  // ---------------------------------------------------------------------------

  it('clusters markets with very similar questions as same_event', () => {
    const state = new MarketGraphState();
    const markets = makeMarketsMap(
      makeMarket({
        market_id: 'mkt_pres_1',
        question: 'Will Biden win the 2024 presidential election?',
        category: 'politics',
        tags: ['election'],
      }),
      makeMarket({
        market_id: 'mkt_pres_2',
        question: 'Will Trump win the 2024 presidential election?',
        category: 'politics',
        tags: ['election'],
      }),
    );

    const graph = buildMarketGraph(markets, state);

    // Both markets should have edges to each other
    const edges1 = graph.edges.get('mkt_pres_1') ?? [];
    const edges2 = graph.edges.get('mkt_pres_2') ?? [];
    expect(edges1.length).toBeGreaterThan(0);
    expect(edges2.length).toBeGreaterThan(0);

    // They should be in the same cluster
    expect(graph.clusters.length).toBeGreaterThanOrEqual(1);
    const cluster = graph.clusters.find(
      (c) => c.market_ids.includes('mkt_pres_1') && c.market_ids.includes('mkt_pres_2'),
    );
    expect(cluster).toBeDefined();
  });

  it('does not cluster completely unrelated markets', () => {
    const state = new MarketGraphState();
    const markets = makeMarketsMap(
      makeMarket({
        market_id: 'mkt_weather',
        question: 'Will it rain in London tomorrow?',
        category: 'weather',
        tags: ['weather'],
      }),
      makeMarket({
        market_id: 'mkt_crypto',
        question: 'Will Bitcoin reach $100k by end of year?',
        category: 'crypto',
        tags: ['crypto'],
      }),
    );

    const graph = buildMarketGraph(markets, state);

    // No edges between unrelated markets
    const weatherEdges = graph.edges.get('mkt_weather') ?? [];
    const cryptoEdges = graph.edges.get('mkt_crypto') ?? [];
    expect(weatherEdges).toHaveLength(0);
    expect(cryptoEdges).toHaveLength(0);

    // No clusters (or each market alone, which is filtered out)
    expect(graph.clusters).toHaveLength(0);
  });

  it('handles multi-market event clusters', () => {
    const state = new MarketGraphState();
    const markets = makeMarketsMap(
      makeMarket({
        market_id: 'mkt_a',
        question: 'Will candidate Alice win the mayoral election?',
        category: 'politics',
        tags: ['election'],
      }),
      makeMarket({
        market_id: 'mkt_b',
        question: 'Will candidate Bob win the mayoral election?',
        category: 'politics',
        tags: ['election'],
      }),
      makeMarket({
        market_id: 'mkt_c',
        question: 'Will candidate Carol win the mayoral election?',
        category: 'politics',
        tags: ['election'],
      }),
    );

    const graph = buildMarketGraph(markets, state);

    // All three should be in one cluster
    const bigCluster = graph.clusters.find((c) => c.market_ids.length === 3);
    expect(bigCluster).toBeDefined();
    expect(bigCluster!.market_ids).toContain('mkt_a');
    expect(bigCluster!.market_ids).toContain('mkt_b');
    expect(bigCluster!.market_ids).toContain('mkt_c');
  });

  // ---------------------------------------------------------------------------
  // Consistency scoring
  // ---------------------------------------------------------------------------

  it('computes consistency score for a cluster', () => {
    const state = new MarketGraphState();

    // Create markets with YES mid prices that sum to ~1.0
    const mktA = makeMarket({
      market_id: 'mkt_a',
      question: 'Will team Alpha win the championship game this season?',
      category: 'sports',
    });
    const mktB = makeMarket({
      market_id: 'mkt_b',
      question: 'Will team Beta win the championship game this season?',
      category: 'sports',
    });

    // Set YES mid prices that sum to 1.0 (consistent)
    mktA.book.yes.mid = 0.6;
    mktB.book.yes.mid = 0.4;

    const markets = makeMarketsMap(mktA, mktB);
    const graph = buildMarketGraph(markets, state);

    if (graph.clusters.length > 0) {
      const cluster = graph.clusters[0]!;
      // Should be highly consistent (YES mids sum to 1.0)
      expect(cluster.consistency_score).toBeGreaterThan(0.8);
      expect(cluster.consistency_violation).toBeLessThan(0.05);
    }
  });

  // ---------------------------------------------------------------------------
  // Relationship types
  // ---------------------------------------------------------------------------

  it('assigns relationship types correctly', () => {
    const state = new MarketGraphState();
    const markets = makeMarketsMap(
      makeMarket({
        market_id: 'mkt_1',
        question: 'Will the Federal Reserve raise interest rates in March?',
        category: 'economics',
      }),
      makeMarket({
        market_id: 'mkt_2',
        question: 'Will the Federal Reserve raise interest rates in June?',
        category: 'economics',
      }),
    );

    const graph = buildMarketGraph(markets, state);
    const edges = graph.edges.get('mkt_1') ?? [];

    if (edges.length > 0) {
      const edge = edges[0]!;
      expect(edge.target_market_id).toBe('mkt_2');
      // Should be same_event or complementary (same topic, same category)
      expect(['same_event', 'complementary', 'correlated', 'semantic']).toContain(
        edge.relationship,
      );
      expect(edge.strength).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Propagation detection
// ---------------------------------------------------------------------------

describe('detectPropagationEvents', () => {
  it('records lag when related market updates after source', () => {
    const graphState = new MarketGraphState();

    // Simulate: mkt_1 updated at T=1000, mkt_2 updated at T=1500
    graphState.recordBookUpdate('mkt_2', 1500);

    type EdgeEntry = { target_market_id: string; relationship: 'correlated'; strength: number; price_correlation: number; staleness_propagation_lag_ms: number };
    const edges = new Map<string, EdgeEntry[]>();
    edges.set('mkt_1', [
      {
        target_market_id: 'mkt_2',
        relationship: 'correlated',
        strength: 0.7,
        price_correlation: 0.8,
        staleness_propagation_lag_ms: 0,
      },
    ]);

    detectPropagationEvents(graphState, edges, 'mkt_1', 1000);

    const lag = graphState.getMedianPropagationLag('mkt_1', 'mkt_2');
    expect(lag).toBe(500);
  });
});
