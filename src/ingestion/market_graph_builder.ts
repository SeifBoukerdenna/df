import type { MarketGraph } from '../state/types.js';
import type { MarketMetadata } from './types.js';

/**
 * Stub market graph builder. Returns an empty graph with no edges or clusters.
 * Full implementation (semantic clustering, relationship detection, consistency
 * checking) is built in Phase 3.
 */
export function buildMarketGraph(_markets: MarketMetadata[]): MarketGraph {
  return {
    edges: new Map(),
    clusters: [],
  };
}
