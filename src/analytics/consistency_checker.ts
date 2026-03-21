// ---------------------------------------------------------------------------
// Consistency Checker — Module 14
//
// Detects structural probability violations across related markets.
// Four check types:
//   1. Exhaustive partition: outcomes in an event must sum to ~1.0
//   2. Subset/superset: P(by_later_date) >= P(by_earlier_date)
//   3. Conditional: P(general) <= P(primary)
//   4. Temporal: same question at different horizons must be monotonic
//
// For each violation: raw magnitude, executable magnitude after fees/spread,
// tradeability at current depth, and a concrete multi-leg trade plan.
// Tracks violation persistence for determining arb viability at our latency.
// ---------------------------------------------------------------------------

import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { vwap } from '../utils/math.js';
import { tokenize } from '../utils/text_similarity.js';
import { mean } from '../utils/statistics.js';
import type { MarketState, MarketCluster, MarketGraph } from '../state/types.js';
import type {
  ConsistencyCheck,
  ConsistencyCheckType,
  ConsistencyTradeLeg,
  ConsistencyTradePlan,
  ViolationPersistence,
  ConsistencyReport,
} from './types.js';

const log = getLogger('consistency');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum executable violation to be considered tradeable (in price units). */
const MIN_TRADEABLE_VIOLATION = 0.005;
/** Minimum depth on each leg to be considered executable. */
const MIN_LEG_DEPTH = 50;
/** Default trade size for computing executable violations. */
const DEFAULT_TRADE_SIZE = 100;
/** Maximum age before a violation record is considered resolved (ms). */
const VIOLATION_STALE_THRESHOLD_MS = 120_000; // 2 minutes without re-observation

// ---------------------------------------------------------------------------
// Check ID generation
// ---------------------------------------------------------------------------

function makeCheckId(checkType: ConsistencyCheckType, marketIds: string[]): string {
  const sorted = [...marketIds].sort();
  return `${checkType}:${sorted.join(',')}`;
}

// ---------------------------------------------------------------------------
// 1. Exhaustive Partition Check
//
// For a cluster of markets that form an exhaustive partition of outcomes
// (e.g., "Who will win the election?" with one market per candidate),
// the sum of all YES probabilities must equal 1.0.
//
// If sum > 1.0: sell the overpriced leg(s)
// If sum < 1.0: buy the underpriced leg(s)
// ---------------------------------------------------------------------------

function checkExhaustivePartition(
  cluster: MarketCluster,
  markets: Map<string, MarketState>,
  feeRate: number,
): ConsistencyCheck | null {
  const activeMarkets: MarketState[] = [];
  for (const id of cluster.market_ids) {
    const m = markets.get(id);
    if (m && m.status === 'active' && m.book.yes.mid > 0) {
      activeMarkets.push(m);
    }
  }

  if (activeMarkets.length < 2) return null;

  // Compute sum of YES mid prices
  const actualValues = new Map<string, number>();
  let sumMids = 0;
  for (const m of activeMarkets) {
    actualValues.set(m.market_id, m.book.yes.mid);
    sumMids += m.book.yes.mid;
  }

  const violationMagnitude = Math.abs(sumMids - 1.0);
  if (violationMagnitude < 0.001) return null; // negligible

  // Compute executable violation using actual ask/bid prices
  // If sum > 1.0: we want to sell everything → look at bid prices
  // If sum < 1.0: we want to buy everything → look at ask prices
  const overpriced = sumMids > 1.0;

  let executableSum = 0;
  let allLegsHaveDepth = true;
  const legs: ConsistencyTradeLeg[] = [];

  for (const m of activeMarkets) {
    if (overpriced) {
      // Sell YES on each market — hit bids
      const bestBid = m.book.yes.bids[0];
      if (!bestBid || bestBid[1] < MIN_LEG_DEPTH) {
        allLegsHaveDepth = false;
      }
      const fillPrice = vwap(m.book.yes.bids, DEFAULT_TRADE_SIZE);
      executableSum += isNaN(fillPrice) ? (bestBid?.[0] ?? 0) : fillPrice;
      legs.push({
        market_id: m.market_id,
        token_id: m.tokens.yes_id,
        direction: 'SELL',
        size: DEFAULT_TRADE_SIZE,
      });
    } else {
      // Buy YES on each market — lift asks
      const bestAsk = m.book.yes.asks[0];
      if (!bestAsk || bestAsk[1] < MIN_LEG_DEPTH) {
        allLegsHaveDepth = false;
      }
      const fillPrice = vwap(m.book.yes.asks, DEFAULT_TRADE_SIZE);
      executableSum += isNaN(fillPrice) ? (bestAsk?.[0] ?? 0) : fillPrice;
      legs.push({
        market_id: m.market_id,
        token_id: m.tokens.yes_id,
        direction: 'BUY',
        size: DEFAULT_TRADE_SIZE,
      });
    }
  }

  const totalFees = feeRate * activeMarkets.length;

  // Executable violation:
  // If overpriced (sell basket): profit = executableSum - 1.0 - totalFees
  // If underpriced (buy basket): profit = 1.0 - executableSum - totalFees
  const executableViolation = overpriced
    ? executableSum - 1.0 - totalFees
    : 1.0 - executableSum - totalFees;

  const tradeable = executableViolation > MIN_TRADEABLE_VIOLATION && allLegsHaveDepth;

  const tradePlan: ConsistencyTradePlan | null = tradeable
    ? {
        legs,
        expected_profit: executableViolation * DEFAULT_TRADE_SIZE,
        worst_case_loss: totalFees * DEFAULT_TRADE_SIZE,
        execution_risk: legs.length > 2
          ? 'Multi-leg execution: high risk of partial fill on later legs'
          : 'Two-leg execution: moderate slip risk on second leg',
      }
    : null;

  const marketIds = activeMarkets.map((m) => m.market_id);
  return {
    check_id: makeCheckId('exhaustive_partition', marketIds),
    check_type: 'exhaustive_partition',
    markets_involved: marketIds,
    expected_relationship: `sum(YES_mid) = 1.0 (actual: ${sumMids.toFixed(4)})`,
    actual_values: actualValues,
    violation_magnitude: violationMagnitude,
    executable_violation: Math.max(0, executableViolation),
    tradeable,
    trade_plan: tradePlan,
    detected_at: now(),
  };
}

// ---------------------------------------------------------------------------
// 2. Subset / Superset Check
//
// When one market is a subset of another's condition:
//   "Will X happen by June?" vs "Will X happen by December?"
//   P(by_December) >= P(by_June)
//
// Detected via shared tokens + date/time horizon keywords.
// ---------------------------------------------------------------------------

/** Date-like tokens that indicate time horizons, ordered chronologically. */
const MONTH_ORDER: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const QUARTER_ORDER: Record<string, number> = {
  q1: 1, q2: 2, q3: 3, q4: 4,
};

/**
 * Extracts a temporal ordering key from a market question.
 * Returns a comparable number, or null if no temporal signal found.
 */
function extractTemporalOrder(question: string): number | null {
  const lower = question.toLowerCase();

  // Check months
  for (const [month, order] of Object.entries(MONTH_ORDER)) {
    if (lower.includes(month)) return order;
  }

  // Check quarters
  for (const [quarter, order] of Object.entries(QUARTER_ORDER)) {
    if (lower.includes(quarter)) return order * 3; // scale to month-comparable
  }

  // Check year patterns
  const yearMatch = lower.match(/20(\d{2})/);
  if (yearMatch) return parseInt(yearMatch[1]!, 10) * 12;

  // Check "end of" type phrases
  if (lower.includes('end of year') || lower.includes('eoy')) return 12;
  if (lower.includes('mid year') || lower.includes('midyear')) return 6;

  return null;
}

/**
 * Determines if two markets have a subset/superset relationship.
 * Returns the pair (earlier, later) if found, or null.
 */
function detectSubsetSuperset(
  a: MarketState,
  b: MarketState,
): { earlier: MarketState; later: MarketState } | null {
  // Markets must share enough semantic content to be about the same event
  const tokensA = tokenize(a.question);
  const tokensB = tokenize(b.question);

  const setA = new Set(tokensA);
  const setB = new Set(tokensB);

  let shared = 0;
  for (const t of setA) {
    if (setB.has(t)) shared++;
  }

  const maxTokens = Math.max(setA.size, setB.size, 1);
  if (shared / maxTokens < 0.4) return null; // not similar enough

  const orderA = extractTemporalOrder(a.question);
  const orderB = extractTemporalOrder(b.question);

  if (orderA === null || orderB === null || orderA === orderB) return null;

  return orderA < orderB
    ? { earlier: a, later: b }
    : { earlier: b, later: a };
}

function checkSubsetSuperset(
  a: MarketState,
  b: MarketState,
  feeRate: number,
): ConsistencyCheck | null {
  const pair = detectSubsetSuperset(a, b);
  if (!pair) return null;

  const { earlier, later } = pair;
  const pEarlier = earlier.book.yes.mid;
  const pLater = later.book.yes.mid;

  if (pEarlier <= 0 || pLater <= 0) return null;

  // Constraint: P(later) >= P(earlier)
  // Violation: P(earlier) > P(later)
  if (pEarlier <= pLater) return null; // no violation

  const violationMagnitude = pEarlier - pLater;

  // To exploit: buy YES on later (underpriced), sell YES on earlier (overpriced)
  const laterAsk = later.book.yes.asks[0];
  const earlierBid = earlier.book.yes.bids[0];

  if (!laterAsk || !earlierBid) {
    return makeCheck('subset_superset', [earlier, later], pEarlier, pLater,
      `P(${later.market_id}) >= P(${earlier.market_id})`, violationMagnitude, 0, false, null);
  }

  const laterFill = vwap(later.book.yes.asks, DEFAULT_TRADE_SIZE);
  const earlierFill = vwap(earlier.book.yes.bids, DEFAULT_TRADE_SIZE);
  const buyPrice = isNaN(laterFill) ? laterAsk[0] : laterFill;
  const sellPrice = isNaN(earlierFill) ? earlierBid[0] : earlierFill;

  const executableViolation = sellPrice - buyPrice - 2 * feeRate;
  const hasDepth = (laterAsk[1] >= MIN_LEG_DEPTH) && (earlierBid[1] >= MIN_LEG_DEPTH);
  const tradeable = executableViolation > MIN_TRADEABLE_VIOLATION && hasDepth;

  const legs: ConsistencyTradeLeg[] = [
    { market_id: later.market_id, token_id: later.tokens.yes_id, direction: 'BUY', size: DEFAULT_TRADE_SIZE },
    { market_id: earlier.market_id, token_id: earlier.tokens.yes_id, direction: 'SELL', size: DEFAULT_TRADE_SIZE },
  ];

  const tradePlan: ConsistencyTradePlan | null = tradeable
    ? {
        legs,
        expected_profit: executableViolation * DEFAULT_TRADE_SIZE,
        worst_case_loss: 2 * feeRate * DEFAULT_TRADE_SIZE,
        execution_risk: 'Two-leg directional: risk if time horizon view is wrong',
      }
    : null;

  return makeCheck('subset_superset', [earlier, later], pEarlier, pLater,
    `P(${later.market_id}) >= P(${earlier.market_id})`,
    violationMagnitude, Math.max(0, executableViolation), tradeable, tradePlan);
}

// ---------------------------------------------------------------------------
// 3. Conditional Check
//
// When one outcome requires another:
//   "Will X win the general?" requires "Will X win the primary?"
//   P(win_general) <= P(win_primary)
//
// Detected via structural keyword patterns.
// ---------------------------------------------------------------------------

/** Keywords that indicate a conditional relationship (prerequisite → outcome). */
const CONDITIONAL_PATTERNS: { prerequisite: string[]; outcome: string[] }[] = [
  { prerequisite: ['primary', 'nomination', 'nominate'], outcome: ['general', 'election', 'president'] },
  { prerequisite: ['semifinal', 'semi'], outcome: ['final', 'champion', 'win'] },
  { prerequisite: ['qualify', 'qualification'], outcome: ['win', 'champion', 'medal'] },
  { prerequisite: ['round'], outcome: ['final', 'champion'] },
];

/**
 * Checks if market A is a prerequisite for market B (A must happen for B to happen).
 */
function detectConditional(
  a: MarketState,
  b: MarketState,
): { prerequisite: MarketState; outcome: MarketState } | null {
  const tokensA = new Set(tokenize(a.question));
  const tokensB = new Set(tokenize(b.question));

  // Check shared entity (the subject — must overlap)
  let sharedEntity = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) sharedEntity++;
  }
  if (sharedEntity < 1) return null;

  for (const pattern of CONDITIONAL_PATTERNS) {
    const aHasPre = pattern.prerequisite.some((k) => tokensA.has(k));
    const aHasOut = pattern.outcome.some((k) => tokensA.has(k));
    const bHasPre = pattern.prerequisite.some((k) => tokensB.has(k));
    const bHasOut = pattern.outcome.some((k) => tokensB.has(k));

    if (aHasPre && bHasOut && !aHasOut && !bHasPre) {
      return { prerequisite: a, outcome: b };
    }
    if (bHasPre && aHasOut && !bHasOut && !aHasPre) {
      return { prerequisite: b, outcome: a };
    }
  }

  return null;
}

function checkConditional(
  a: MarketState,
  b: MarketState,
  feeRate: number,
): ConsistencyCheck | null {
  const pair = detectConditional(a, b);
  if (!pair) return null;

  const { prerequisite, outcome } = pair;
  const pPre = prerequisite.book.yes.mid;
  const pOut = outcome.book.yes.mid;

  if (pPre <= 0 || pOut <= 0) return null;

  // Constraint: P(outcome) <= P(prerequisite)
  // Violation: P(outcome) > P(prerequisite)
  if (pOut <= pPre) return null;

  const violationMagnitude = pOut - pPre;

  // To exploit: sell YES on outcome (overpriced), buy YES on prerequisite (underpriced)
  const outBid = outcome.book.yes.bids[0];
  const preBestAsk = prerequisite.book.yes.asks[0];

  if (!outBid || !preBestAsk) {
    return makeCheck('conditional', [prerequisite, outcome], pPre, pOut,
      `P(${outcome.market_id}) <= P(${prerequisite.market_id})`,
      violationMagnitude, 0, false, null);
  }

  const sellPrice = vwap(outcome.book.yes.bids, DEFAULT_TRADE_SIZE);
  const buyPrice = vwap(prerequisite.book.yes.asks, DEFAULT_TRADE_SIZE);
  const execSell = isNaN(sellPrice) ? outBid[0] : sellPrice;
  const execBuy = isNaN(buyPrice) ? preBestAsk[0] : buyPrice;

  const executableViolation = execSell - execBuy - 2 * feeRate;
  const hasDepth = (outBid[1] >= MIN_LEG_DEPTH) && (preBestAsk[1] >= MIN_LEG_DEPTH);
  const tradeable = executableViolation > MIN_TRADEABLE_VIOLATION && hasDepth;

  const legs: ConsistencyTradeLeg[] = [
    { market_id: prerequisite.market_id, token_id: prerequisite.tokens.yes_id, direction: 'BUY', size: DEFAULT_TRADE_SIZE },
    { market_id: outcome.market_id, token_id: outcome.tokens.yes_id, direction: 'SELL', size: DEFAULT_TRADE_SIZE },
  ];

  const tradePlan: ConsistencyTradePlan | null = tradeable
    ? {
        legs,
        expected_profit: executableViolation * DEFAULT_TRADE_SIZE,
        worst_case_loss: 2 * feeRate * DEFAULT_TRADE_SIZE,
        execution_risk: 'Two-leg conditional: risk if prerequisite relationship is misidentified',
      }
    : null;

  return makeCheck('conditional', [prerequisite, outcome], pPre, pOut,
    `P(${outcome.market_id}) <= P(${prerequisite.market_id})`,
    violationMagnitude, Math.max(0, executableViolation), tradeable, tradePlan);
}

// ---------------------------------------------------------------------------
// 4. Temporal Check
//
// Markets on the same question at different time horizons.
// Probabilities should be monotonic (later deadline → higher or equal P).
// ---------------------------------------------------------------------------

function checkTemporal(
  a: MarketState,
  b: MarketState,
  feeRate: number,
): ConsistencyCheck | null {
  // Temporal is a special case of subset/superset for positive events
  // The same logic applies: P(later) >= P(earlier)
  // We differentiate by requiring explicit temporal markers and same category
  if (a.category !== b.category) return null;

  const orderA = extractTemporalOrder(a.question);
  const orderB = extractTemporalOrder(b.question);
  if (orderA === null || orderB === null || orderA === orderB) return null;

  // Must be about the same underlying question
  const tokensA = tokenize(a.question);
  const tokensB = tokenize(b.question);
  const setA = new Set(tokensA);

  let shared = 0;
  for (const t of tokensB) {
    if (setA.has(t)) shared++;
  }
  const maxTokens = Math.max(tokensA.length, tokensB.length, 1);
  if (shared / maxTokens < 0.4) return null;

  const earlier = orderA < orderB ? a : b;
  const later = orderA < orderB ? b : a;
  const pEarlier = earlier.book.yes.mid;
  const pLater = later.book.yes.mid;

  if (pEarlier <= 0 || pLater <= 0) return null;

  // For "will X happen by date?" — later deadline should have higher P
  // Violation: P(earlier) > P(later)
  if (pEarlier <= pLater) return null;

  const violationMagnitude = pEarlier - pLater;

  // Trade plan: buy later (underpriced), sell earlier (overpriced)
  const laterAsk = later.book.yes.asks[0];
  const earlierBid = earlier.book.yes.bids[0];

  if (!laterAsk || !earlierBid) {
    return makeCheck('temporal', [earlier, later], pEarlier, pLater,
      `P(${later.market_id}) >= P(${earlier.market_id}) [temporal monotonicity]`,
      violationMagnitude, 0, false, null);
  }

  const laterFill = vwap(later.book.yes.asks, DEFAULT_TRADE_SIZE);
  const earlierFill = vwap(earlier.book.yes.bids, DEFAULT_TRADE_SIZE);
  const buyPrice = isNaN(laterFill) ? laterAsk[0] : laterFill;
  const sellPrice = isNaN(earlierFill) ? earlierBid[0] : earlierFill;

  const executableViolation = sellPrice - buyPrice - 2 * feeRate;
  const hasDepth = (laterAsk[1] >= MIN_LEG_DEPTH) && (earlierBid[1] >= MIN_LEG_DEPTH);
  const tradeable = executableViolation > MIN_TRADEABLE_VIOLATION && hasDepth;

  const legs: ConsistencyTradeLeg[] = [
    { market_id: later.market_id, token_id: later.tokens.yes_id, direction: 'BUY', size: DEFAULT_TRADE_SIZE },
    { market_id: earlier.market_id, token_id: earlier.tokens.yes_id, direction: 'SELL', size: DEFAULT_TRADE_SIZE },
  ];

  const tradePlan: ConsistencyTradePlan | null = tradeable
    ? {
        legs,
        expected_profit: executableViolation * DEFAULT_TRADE_SIZE,
        worst_case_loss: 2 * feeRate * DEFAULT_TRADE_SIZE,
        execution_risk: 'Two-leg temporal: risk if monotonicity assumption is wrong (event timing uncertainty)',
      }
    : null;

  return makeCheck('temporal', [earlier, later], pEarlier, pLater,
    `P(${later.market_id}) >= P(${earlier.market_id}) [temporal monotonicity]`,
    violationMagnitude, Math.max(0, executableViolation), tradeable, tradePlan);
}

// ---------------------------------------------------------------------------
// Helper: construct a ConsistencyCheck
// ---------------------------------------------------------------------------

function makeCheck(
  checkType: ConsistencyCheckType,
  marketsOrdered: MarketState[],
  val1: number,
  val2: number,
  expectedRelationship: string,
  violationMagnitude: number,
  executableViolation: number,
  tradeable: boolean,
  tradePlan: ConsistencyTradePlan | null,
): ConsistencyCheck {
  const marketIds = marketsOrdered.map((m) => m.market_id);
  const actualValues = new Map<string, number>();
  actualValues.set(marketsOrdered[0]!.market_id, val1);
  actualValues.set(marketsOrdered[1]!.market_id, val2);

  return {
    check_id: makeCheckId(checkType, marketIds),
    check_type: checkType,
    markets_involved: marketIds,
    expected_relationship: expectedRelationship,
    actual_values: actualValues,
    violation_magnitude: violationMagnitude,
    executable_violation: executableViolation,
    tradeable,
    trade_plan: tradePlan,
    detected_at: now(),
  };
}

// ---------------------------------------------------------------------------
// ConsistencyChecker — stateful checker with persistence tracking
// ---------------------------------------------------------------------------

export class ConsistencyChecker {
  private readonly feeRate: number;
  /** Active and recently-resolved violations, keyed by check_id. */
  private readonly violations: Map<string, ViolationPersistence> = new Map();
  /** Resolved violations archived for statistics (last hour). */
  private readonly resolvedArchive: ViolationPersistence[] = [];
  private readonly maxArchiveSize: number = 500;

  constructor(feeRate: number) {
    this.feeRate = feeRate;
  }

  // -----------------------------------------------------------------------
  // Run all check types
  // -----------------------------------------------------------------------

  /**
   * Runs all consistency checks against the current world state.
   * Returns all detected violations (new and ongoing).
   */
  checkAll(
    markets: Map<string, MarketState>,
    graph: MarketGraph,
  ): ConsistencyCheck[] {
    const results: ConsistencyCheck[] = [];

    // 1. Exhaustive partition checks — run on each cluster
    for (const cluster of graph.clusters) {
      const check = checkExhaustivePartition(cluster, markets, this.feeRate);
      if (check) results.push(check);
    }

    // 2–4. Pairwise checks — run on all edges in the graph
    const checkedPairs = new Set<string>();
    for (const [marketId, edges] of graph.edges) {
      const marketA = markets.get(marketId);
      if (!marketA || marketA.status !== 'active') continue;

      for (const edge of edges) {
        const pairKey = [marketId, edge.target_market_id].sort().join(':');
        if (checkedPairs.has(pairKey)) continue;
        checkedPairs.add(pairKey);

        const marketB = markets.get(edge.target_market_id);
        if (!marketB || marketB.status !== 'active') continue;

        // Subset/superset
        const ssCheck = checkSubsetSuperset(marketA, marketB, this.feeRate);
        if (ssCheck) results.push(ssCheck);

        // Conditional
        const condCheck = checkConditional(marketA, marketB, this.feeRate);
        if (condCheck) results.push(condCheck);

        // Temporal
        const tempCheck = checkTemporal(marketA, marketB, this.feeRate);
        if (tempCheck) results.push(tempCheck);
      }
    }

    // Also run pairwise on all markets in each cluster (covers pairs without
    // explicit graph edges that were still clustered together)
    for (const cluster of graph.clusters) {
      for (let i = 0; i < cluster.market_ids.length; i++) {
        for (let j = i + 1; j < cluster.market_ids.length; j++) {
          const pairKey = [cluster.market_ids[i]!, cluster.market_ids[j]!].sort().join(':');
          if (checkedPairs.has(pairKey)) continue;
          checkedPairs.add(pairKey);

          const a = markets.get(cluster.market_ids[i]!);
          const b = markets.get(cluster.market_ids[j]!);
          if (!a || !b || a.status !== 'active' || b.status !== 'active') continue;

          const ssCheck = checkSubsetSuperset(a, b, this.feeRate);
          if (ssCheck) results.push(ssCheck);

          const condCheck = checkConditional(a, b, this.feeRate);
          if (condCheck) results.push(condCheck);

          const tempCheck = checkTemporal(a, b, this.feeRate);
          if (tempCheck) results.push(tempCheck);
        }
      }
    }

    // Update persistence tracking
    this.updatePersistence(results);

    if (results.length > 0) {
      const tradeableCount = results.filter((r) => r.tradeable).length;
      log.info(
        {
          total: results.length,
          tradeable: tradeableCount,
          by_type: {
            exhaustive_partition: results.filter((r) => r.check_type === 'exhaustive_partition').length,
            subset_superset: results.filter((r) => r.check_type === 'subset_superset').length,
            conditional: results.filter((r) => r.check_type === 'conditional').length,
            temporal: results.filter((r) => r.check_type === 'temporal').length,
          },
        },
        'Consistency check complete',
      );
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // Persistence tracking
  // -----------------------------------------------------------------------

  /**
   * Updates violation persistence records based on the latest check results.
   * New violations get created; existing ones get their last_seen updated;
   * violations not seen in this round may be marked resolved.
   */
  private updatePersistence(currentChecks: ConsistencyCheck[]): void {
    const t = now();
    const seenIds = new Set<string>();

    for (const check of currentChecks) {
      seenIds.add(check.check_id);

      const existing = this.violations.get(check.check_id);
      if (existing) {
        // Update existing
        existing.last_seen_at = t;
        existing.duration_ms = t - existing.first_detected_at;
        existing.observation_count++;
        existing.peak_magnitude = Math.max(existing.peak_magnitude, check.violation_magnitude);
        existing.peak_executable_magnitude = Math.max(
          existing.peak_executable_magnitude,
          check.executable_violation,
        );
        if (check.tradeable) existing.was_tradeable = true;
      } else {
        // New violation
        this.violations.set(check.check_id, {
          check_id: check.check_id,
          check_type: check.check_type,
          markets_involved: check.markets_involved,
          first_detected_at: t,
          last_seen_at: t,
          resolved_at: null,
          duration_ms: 0,
          peak_magnitude: check.violation_magnitude,
          peak_executable_magnitude: check.executable_violation,
          observation_count: 1,
          was_tradeable: check.tradeable,
        });
      }
    }

    // Mark violations not seen as potentially resolved
    for (const [checkId, v] of this.violations) {
      if (!seenIds.has(checkId) && v.resolved_at === null) {
        if (t - v.last_seen_at > VIOLATION_STALE_THRESHOLD_MS) {
          v.resolved_at = t;
          v.duration_ms = v.last_seen_at - v.first_detected_at;

          // Archive
          this.resolvedArchive.push({ ...v });
          if (this.resolvedArchive.length > this.maxArchiveSize) {
            this.resolvedArchive.splice(0, this.resolvedArchive.length - this.maxArchiveSize);
          }

          this.violations.delete(checkId);
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Query methods
  // -----------------------------------------------------------------------

  /** Returns all active (unresolved) violation persistence records. */
  getActiveViolations(): ViolationPersistence[] {
    return [...this.violations.values()].filter((v) => v.resolved_at === null);
  }

  /** Returns recently resolved violations (within the archive window). */
  getResolvedViolations(): ViolationPersistence[] {
    return [...this.resolvedArchive];
  }

  /** Returns a specific violation's persistence record. */
  getViolation(checkId: string): ViolationPersistence | undefined {
    return this.violations.get(checkId);
  }

  /**
   * Computes persistence statistics for determining whether consistency arb
   * is viable at a given latency.
   */
  getPersistenceStats(): {
    active_count: number;
    resolved_last_hour: number;
    median_duration_ms: number;
    avg_duration_ms: number;
    pct_tradeable: number;
  } {
    const t = now();
    const hourAgo = t - 3_600_000;

    const active = this.getActiveViolations();
    const recentResolved = this.resolvedArchive.filter(
      (v) => v.resolved_at !== null && v.resolved_at > hourAgo,
    );

    const allDurations = [
      ...active.map((v) => t - v.first_detected_at),
      ...recentResolved.map((v) => v.duration_ms),
    ];

    let medianDuration = 0;
    let avgDuration = 0;
    if (allDurations.length > 0) {
      const sorted = [...allDurations].sort((a, b) => a - b);
      medianDuration = sorted[Math.floor(sorted.length / 2)]!;
      avgDuration = mean(allDurations);
    }

    const allViolations = [...active, ...recentResolved];
    const tradeableCount = allViolations.filter((v) => v.was_tradeable).length;

    return {
      active_count: active.length,
      resolved_last_hour: recentResolved.length,
      median_duration_ms: medianDuration,
      avg_duration_ms: avgDuration,
      pct_tradeable: allViolations.length > 0 ? tradeableCount / allViolations.length : 0,
    };
  }

  /**
   * Builds a full consistency report for CLI output.
   */
  buildReport(currentChecks: ConsistencyCheck[]): ConsistencyReport {
    const t = now();
    const stats = this.getPersistenceStats();

    const countByType: Record<ConsistencyCheckType, number> = {
      exhaustive_partition: 0,
      subset_superset: 0,
      conditional: 0,
      temporal: 0,
    };

    let totalTradeable = 0;
    let totalProfit = 0;

    for (const check of currentChecks) {
      countByType[check.check_type]++;
      if (check.tradeable) {
        totalTradeable++;
        totalProfit += check.executable_violation;
      }
    }

    return {
      timestamp: t,
      active_violations: currentChecks,
      violation_count_by_type: countByType,
      total_tradeable: totalTradeable,
      total_executable_profit: totalProfit,
      persistence_stats: {
        active_count: stats.active_count,
        resolved_last_hour: stats.resolved_last_hour,
        median_duration_ms: stats.median_duration_ms,
        avg_duration_ms: stats.avg_duration_ms,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Standalone check functions (for testing / use without the class)
// ---------------------------------------------------------------------------

export {
  checkExhaustivePartition,
  checkSubsetSuperset,
  checkConditional,
  checkTemporal,
  extractTemporalOrder,
  detectSubsetSuperset,
  detectConditional,
};
