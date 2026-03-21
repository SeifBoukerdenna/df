// ---------------------------------------------------------------------------
// Market Graph Builder
//
// Builds cross-market relationship graph from:
// 1. Semantic similarity of market questions (text_similarity)
// 2. Price correlation between related markets
// 3. Staleness propagation lag tracking
//
// Produces MarketGraph with typed edges and MarketCluster objects.
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { marketSimilarity, tokenize } from '../utils/text_similarity.js';
import { mean, stddev } from '../utils/statistics.js';
import type {
  MarketGraph,
  MarketRelationship,
  MarketRelationshipType,
  MarketCluster,
  MarketState,
} from '../state/types.js';

const log = getLogger('market_graph');

// ---------------------------------------------------------------------------
// Configuration thresholds
// ---------------------------------------------------------------------------

const SEMANTIC_SIMILARITY_THRESHOLD = 0.35;
const SAME_EVENT_THRESHOLD = 0.65;
const COMPLEMENTARY_THRESHOLD = 0.50;
const CORRELATION_MIN_SAMPLES = 5;
const CLUSTER_SIMILARITY_THRESHOLD = 0.30;

// ---------------------------------------------------------------------------
// Price history ring buffer for correlation computation
// ---------------------------------------------------------------------------

export interface PriceObservation {
  timestamp: number;
  mid_yes: number;
}

/**
 * Tracks price history and book update timestamps per market for computing
 * correlations and staleness propagation lags across pairs.
 */
export class MarketGraphState {
  /** Rolling price history per market (most recent N observations). */
  readonly priceHistory: Map<string, PriceObservation[]> = new Map();
  /** Timestamps of book updates per market (for propagation lag). */
  readonly bookUpdateTimestamps: Map<string, number[]> = new Map();
  /** Measured propagation lags per (source, target) pair. */
  readonly propagationLags: Map<string, number[]> = new Map();

  private readonly maxHistory: number;
  private readonly maxLags: number;

  constructor(maxHistory: number = 500, maxLags: number = 200) {
    this.maxHistory = maxHistory;
    this.maxLags = maxLags;
  }

  /** Records a price observation for a market. */
  recordPrice(marketId: string, midYes: number, timestamp: number): void {
    let history = this.priceHistory.get(marketId);
    if (!history) {
      history = [];
      this.priceHistory.set(marketId, history);
    }
    history.push({ timestamp, mid_yes: midYes });
    if (history.length > this.maxHistory) {
      history.splice(0, history.length - this.maxHistory);
    }
  }

  /** Records a book update timestamp for a market. */
  recordBookUpdate(marketId: string, timestamp: number): void {
    let updates = this.bookUpdateTimestamps.get(marketId);
    if (!updates) {
      updates = [];
      this.bookUpdateTimestamps.set(marketId, updates);
    }
    updates.push(timestamp);
    if (updates.length > this.maxHistory) {
      updates.splice(0, updates.length - this.maxHistory);
    }
  }

  /**
   * Records a staleness propagation event: market A moved at timeA,
   * market B responded at timeB. Lag = timeB - timeA.
   */
  recordPropagationLag(sourceId: string, targetId: string, lagMs: number): void {
    if (lagMs < 0) return;
    const key = `${sourceId}→${targetId}`;
    let lags = this.propagationLags.get(key);
    if (!lags) {
      lags = [];
      this.propagationLags.set(key, lags);
    }
    lags.push(lagMs);
    if (lags.length > this.maxLags) {
      lags.splice(0, lags.length - this.maxLags);
    }
  }

  /** Returns the median propagation lag for a pair, or 0 if no data. */
  getMedianPropagationLag(sourceId: string, targetId: string): number {
    const key = `${sourceId}→${targetId}`;
    const lags = this.propagationLags.get(key);
    if (!lags || lags.length === 0) return 0;
    const sorted = [...lags].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  }
}

// ---------------------------------------------------------------------------
// Correlation computation
// ---------------------------------------------------------------------------

/**
 * Computes Pearson correlation between two price series, aligned by timestamp.
 * Uses the most recent overlapping observations within `windowMs`.
 */
function computePriceCorrelation(
  historyA: PriceObservation[],
  historyB: PriceObservation[],
  windowMs: number = 3_600_000, // 1 hour
): number {
  const cutoff = now() - windowMs;

  // Build returns for A
  const returnsA: { timestamp: number; ret: number }[] = [];
  for (let i = 1; i < historyA.length; i++) {
    const prev = historyA[i - 1]!;
    const curr = historyA[i]!;
    if (curr.timestamp < cutoff) continue;
    if (prev.mid_yes > 0 && curr.mid_yes > 0) {
      returnsA.push({ timestamp: curr.timestamp, ret: curr.mid_yes - prev.mid_yes });
    }
  }

  // Build returns for B
  const returnsB: { timestamp: number; ret: number }[] = [];
  for (let i = 1; i < historyB.length; i++) {
    const prev = historyB[i - 1]!;
    const curr = historyB[i]!;
    if (curr.timestamp < cutoff) continue;
    if (prev.mid_yes > 0 && curr.mid_yes > 0) {
      returnsB.push({ timestamp: curr.timestamp, ret: curr.mid_yes - prev.mid_yes });
    }
  }

  if (returnsA.length < CORRELATION_MIN_SAMPLES || returnsB.length < CORRELATION_MIN_SAMPLES) {
    return 0;
  }

  // Align by nearest timestamp (within 10s tolerance)
  const ALIGN_TOLERANCE = 10_000;
  const pairedA: number[] = [];
  const pairedB: number[] = [];

  let bIdx = 0;
  for (const a of returnsA) {
    // Advance bIdx to closest match
    while (bIdx < returnsB.length - 1 && returnsB[bIdx + 1]!.timestamp <= a.timestamp + ALIGN_TOLERANCE) {
      bIdx++;
    }
    if (bIdx < returnsB.length && Math.abs(returnsB[bIdx]!.timestamp - a.timestamp) <= ALIGN_TOLERANCE) {
      pairedA.push(a.ret);
      pairedB.push(returnsB[bIdx]!.ret);
    }
  }

  if (pairedA.length < CORRELATION_MIN_SAMPLES) return 0;

  return pearsonCorrelation(pairedA, pairedB);
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const mx = mean(x);
  const my = mean(y);
  const sx = stddev(x);
  const sy = stddev(y);

  if (sx === 0 || sy === 0) return 0;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += (x[i]! - mx) * (y[i]! - my);
  }

  return sum / ((n - 1) * sx * sy);
}

// ---------------------------------------------------------------------------
// Semantic relationship type detection
// ---------------------------------------------------------------------------

/**
 * Determines the relationship type between two markets based on
 * text similarity and structural cues.
 */
function classifyRelationship(
  a: MarketState,
  b: MarketState,
  similarity: number,
): { type: MarketRelationshipType; strength: number } | null {
  if (similarity < SEMANTIC_SIMILARITY_THRESHOLD) return null;

  // Same event: very high text similarity + same category
  if (similarity >= SAME_EVENT_THRESHOLD && a.category === b.category) {
    return { type: 'same_event', strength: similarity };
  }

  // Complementary: same event structure (e.g., "Will X win?" vs "Will Y win?" in same event)
  const tokensA = tokenize(a.question);
  const tokensB = tokenize(b.question);
  const sharedTokenCount = tokensA.filter((t) => tokensB.includes(t)).length;
  const maxTokens = Math.max(tokensA.length, tokensB.length, 1);
  const sharedRatio = sharedTokenCount / maxTokens;

  if (
    similarity >= COMPLEMENTARY_THRESHOLD &&
    a.category === b.category &&
    sharedRatio >= 0.4
  ) {
    return { type: 'complementary', strength: similarity };
  }

  // Causal: different categories but high textual overlap (cross-domain)
  if (similarity >= 0.45 && a.category !== b.category) {
    return { type: 'causal', strength: similarity * 0.8 };
  }

  // Generic semantic relationship
  return { type: 'semantic', strength: similarity };
}

// ---------------------------------------------------------------------------
// Clustering via union-find
// ---------------------------------------------------------------------------

class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    let root = x;
    while (this.parent.get(root)! !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }

  clusters(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      let group = result.get(root);
      if (!group) {
        group = [];
        result.set(root, group);
      }
      group.push(key);
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Consistency scoring for clusters
// ---------------------------------------------------------------------------

/**
 * For a cluster of markets (assumed to be an exhaustive partition of outcomes),
 * computes how close the sum of YES mid prices is to 1.0.
 */
function computeClusterConsistency(
  marketIds: string[],
  marketMap: Map<string, MarketState>,
): { score: number; violation: number } {
  const mids: number[] = [];
  for (const id of marketIds) {
    const m = marketMap.get(id);
    if (m && m.book.yes.mid > 0) {
      mids.push(m.book.yes.mid);
    }
  }

  if (mids.length < 2) return { score: 1.0, violation: 0 };

  const sum = mids.reduce((a, b) => a + b, 0);
  const violation = Math.abs(sum - 1.0);

  // Score: 1.0 when perfectly consistent, decaying toward 0
  // A 10% violation gives score ~0.5
  const score = 1.0 / (1.0 + violation * 10);

  return { score, violation };
}

/**
 * Generates a human-readable cluster description from shared tokens
 * across market questions.
 */
function generateClusterDescription(
  marketIds: string[],
  marketMap: Map<string, MarketState>,
): string {
  const allTokens: Map<string, number> = new Map();

  for (const id of marketIds) {
    const m = marketMap.get(id);
    if (!m) continue;
    const tokens = tokenize(m.question);
    const seen = new Set<string>();
    for (const t of tokens) {
      if (!seen.has(t)) {
        allTokens.set(t, (allTokens.get(t) ?? 0) + 1);
        seen.add(t);
      }
    }
  }

  // Keep tokens that appear in more than half the markets
  const threshold = Math.max(2, Math.ceil(marketIds.length / 2));
  const shared = [...allTokens.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([token]) => token);

  return shared.length > 0 ? shared.join(' ') : 'related markets';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a complete MarketGraph from the current set of active markets.
 *
 * Steps:
 * 1. Compute pairwise text similarity for all market pairs.
 * 2. Classify relationship type for pairs above threshold.
 * 3. Enrich with price correlation from historical data.
 * 4. Add staleness propagation lag from tracked data.
 * 5. Cluster related markets using union-find.
 * 6. Compute consistency score per cluster.
 */
export function buildMarketGraph(
  markets: Map<string, MarketState>,
  graphState: MarketGraphState,
): MarketGraph {
  const t = now();
  const edges = new Map<string, MarketRelationship[]>();
  const marketIds = [...markets.keys()];
  const n = marketIds.length;

  if (n === 0) return { edges, clusters: [] };

  // Initialize edge lists
  for (const id of marketIds) {
    edges.set(id, []);
  }

  const uf = new UnionFind();
  // Ensure all markets are in union-find even if no edges
  for (const id of marketIds) {
    uf.find(id);
  }

  // Pairwise comparison — O(n²) but n is bounded by active market count
  for (let i = 0; i < n; i++) {
    const idA = marketIds[i]!;
    const marketA = markets.get(idA)!;

    for (let j = i + 1; j < n; j++) {
      const idB = marketIds[j]!;
      const marketB = markets.get(idB)!;

      // Text similarity
      const similarity = marketSimilarity(marketA.question, marketB.question);
      const rel = classifyRelationship(marketA, marketB, similarity);
      if (!rel) continue;

      // Price correlation
      const histA = graphState.priceHistory.get(idA) ?? [];
      const histB = graphState.priceHistory.get(idB) ?? [];
      const corr = computePriceCorrelation(histA, histB);

      // Upgrade semantic to correlated if price correlation is strong
      let finalType = rel.type;
      if (finalType === 'semantic' && Math.abs(corr) > 0.5) {
        finalType = 'correlated';
      }

      // Staleness propagation lag (bidirectional)
      const lagAB = graphState.getMedianPropagationLag(idA, idB);
      const lagBA = graphState.getMedianPropagationLag(idB, idA);

      const edgeAB: MarketRelationship = {
        target_market_id: idB,
        relationship: finalType,
        strength: rel.strength,
        price_correlation: corr,
        staleness_propagation_lag_ms: lagAB,
      };

      const edgeBA: MarketRelationship = {
        target_market_id: idA,
        relationship: finalType,
        strength: rel.strength,
        price_correlation: corr,
        staleness_propagation_lag_ms: lagBA,
      };

      edges.get(idA)!.push(edgeAB);
      edges.get(idB)!.push(edgeBA);

      // Cluster if relationship is strong enough
      if (
        rel.strength >= CLUSTER_SIMILARITY_THRESHOLD &&
        (finalType === 'same_event' || finalType === 'complementary' || finalType === 'correlated')
      ) {
        uf.union(idA, idB);
      }
    }
  }

  // Build clusters
  const rawClusters = uf.clusters();
  const clusters: MarketCluster[] = [];

  for (const [, memberIds] of rawClusters) {
    if (memberIds.length < 2) continue;

    const { score, violation } = computeClusterConsistency(memberIds, markets);
    const description = generateClusterDescription(memberIds, markets);

    clusters.push({
      cluster_id: `cluster_${memberIds.sort().join('_').slice(0, 40)}`,
      market_ids: memberIds,
      event_description: description,
      consistency_score: score,
      consistency_violation: violation,
      last_checked: t,
    });
  }

  // Update related_markets and event_cluster_id on MarketState references
  // (caller should apply these back to state)
  log.info(
    {
      markets: n,
      edges: [...edges.values()].reduce((s, e) => s + e.length, 0) / 2,
      clusters: clusters.length,
    },
    'Market graph built',
  );

  return { edges, clusters };
}

/**
 * Detects staleness propagation events by comparing recent book update
 * timestamps across related market pairs.
 *
 * When market A's book updates and a related market B's book updates
 * shortly after, record the lag.
 */
export function detectPropagationEvents(
  graphState: MarketGraphState,
  edges: Map<string, MarketRelationship[]>,
  updatedMarketId: string,
  updateTimestamp: number,
): void {
  const neighbors = edges.get(updatedMarketId);
  if (!neighbors) return;

  for (const edge of neighbors) {
    const targetUpdates = graphState.bookUpdateTimestamps.get(edge.target_market_id);
    if (!targetUpdates || targetUpdates.length === 0) continue;

    // Look for the target's most recent update after our update
    // (within a 30s window — beyond that it's unlikely to be a propagation)
    const lastTargetUpdate = targetUpdates[targetUpdates.length - 1]!;
    const lag = lastTargetUpdate - updateTimestamp;

    if (lag > 0 && lag < 30_000) {
      graphState.recordPropagationLag(updatedMarketId, edge.target_market_id, lag);
    }
  }
}
