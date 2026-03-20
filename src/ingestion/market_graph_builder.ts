import type { MarketGraph } from '../state/types.js';

/**
 * Builds cross-market relationship graph from semantic similarity and price correlation.
 * Phase 1 stub — returns empty graph. Full implementation in Phase 3.
 */
export function buildMarketGraph(): MarketGraph {
  return {
    edges: new Map(),
    clusters: [],
  };
}
