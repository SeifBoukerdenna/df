// ---------------------------------------------------------------------------
// Stale-Price Propagation Model — Continuous Measurement System
//
// For each pair of related markets in MarketGraph:
// 1. Detect significant price moves (>1σ) in market A
// 2. Track pending moves waiting for market B to react
// 3. Measure propagation_lag = B_adjustment_start - A_move_time
// 4. Measure propagation_efficiency = |B's move| / |A's move|
// 5. Compute per-pair statistics: median, p25, p75, exploitability
// 6. Persist propagation timeseries to data/analysis/propagation/
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { mean, stddev } from '../utils/statistics.js';
import type { MarketGraph, MarketRelationship } from '../state/types.js';

const log = getLogger('propagation');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Minimum price move in standard deviations to qualify as a significant move. */
const MOVE_SIGMA_THRESHOLD = 1.0;
/** Minimum observations for computing rolling statistics. */
const MIN_OBSERVATIONS_FOR_SIGMA = 10;
/** Maximum time to wait for B to react after A moves (ms). */
const PROPAGATION_WINDOW_MS = 60_000;
/** Minimum absolute price change to qualify (avoids noise on very stable markets). */
const MIN_ABSOLUTE_MOVE = 0.005;
/** B's price must move at least this fraction of A's move direction to count as reaction. */
const MIN_REACTION_FRACTION = 0.1;
/** Maximum number of propagation events stored per pair. */
const MAX_EVENTS_PER_PAIR = 500;
/** Maximum pending moves tracked per source market. */
const MAX_PENDING_PER_SOURCE = 50;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A recorded propagation event between two markets. */
export interface PropagationEvent {
  source_market_id: string;
  target_market_id: string;
  timestamp: number;
  /** Source market's price move magnitude (signed). */
  source_move: number;
  /** Source market's move in standard deviations. */
  source_move_sigma: number;
  /** Lag from source move to target reaction start (ms). */
  propagation_lag_ms: number;
  /** Fraction of source move that appeared in target. */
  propagation_efficiency: number;
  /** Target's absolute price change. */
  target_move: number;
}

/** A pending move that hasn't been resolved yet. */
interface PendingMove {
  source_market_id: string;
  move_timestamp: number;
  source_price_before: number;
  source_price_after: number;
  source_move: number;
  source_move_sigma: number;
  /** Target markets we're waiting for, keyed by market_id. */
  targets: Map<string, {
    target_market_id: string;
    price_at_source_move: number;
    correlation: number;
  }>;
}

/** Per-pair statistics computed from recorded propagation events. */
export interface PairPropagationStats {
  source_market_id: string;
  target_market_id: string;
  n_events: number;
  median_lag_ms: number;
  p25_lag_ms: number;
  p75_lag_ms: number;
  mean_lag_ms: number;
  median_efficiency: number;
  mean_efficiency: number;
  /** Whether median lag exceeds the estimated execution time. */
  exploitable: boolean;
  estimated_execution_ms: number;
  last_updated: number;
}

/** Summary report of the propagation model state. */
export interface PropagationReport {
  timestamp: number;
  pairs_tracked: number;
  total_events: number;
  pending_moves: number;
  exploitable_pairs: PairPropagationStats[];
  all_pairs: PairPropagationStats[];
}

// ---------------------------------------------------------------------------
// Rolling price tracker — maintains per-market mid-price history for σ
// ---------------------------------------------------------------------------

interface PricePoint {
  timestamp: number;
  mid: number;
}

class RollingPriceTracker {
  private readonly history: Map<string, PricePoint[]> = new Map();
  private readonly maxHistory: number;

  constructor(maxHistory: number = 500) {
    this.maxHistory = maxHistory;
  }

  record(marketId: string, mid: number, timestamp: number): void {
    let h = this.history.get(marketId);
    if (!h) {
      h = [];
      this.history.set(marketId, h);
    }
    h.push({ timestamp, mid });
    if (h.length > this.maxHistory) {
      h.splice(0, h.length - this.maxHistory);
    }
  }

  /** Returns the most recent price for a market, or null. */
  getLastPrice(marketId: string): number | null {
    const h = this.history.get(marketId);
    if (!h || h.length === 0) return null;
    return h[h.length - 1]!.mid;
  }

  /** Computes rolling std dev of price changes. Returns null if insufficient data. */
  getRollingStddev(marketId: string): number | null {
    const h = this.history.get(marketId);
    if (!h || h.length < MIN_OBSERVATIONS_FOR_SIGMA + 1) return null;

    const changes: number[] = [];
    for (let i = 1; i < h.length; i++) {
      changes.push(h[i]!.mid - h[i - 1]!.mid);
    }

    const sd = stddev(changes);
    return isNaN(sd) || sd === 0 ? null : sd;
  }
}

// ---------------------------------------------------------------------------
// Propagation Model — main class
// ---------------------------------------------------------------------------

export class PropagationModel {
  private readonly prices = new RollingPriceTracker(500);

  /** Pending moves awaiting target reactions. Keyed by source_market_id. */
  private readonly pendingMoves: Map<string, PendingMove[]> = new Map();

  /** Recorded propagation events. Keyed by "source→target". */
  private readonly events: Map<string, PropagationEvent[]> = new Map();

  /** Cached pair stats, recomputed on demand. */
  private readonly statsCache: Map<string, PairPropagationStats> = new Map();
  private statsCacheDirty = true;

  /** Estimated execution latency (ms). Used for exploitability flag. */
  private estimatedExecutionMs: number;

  /** Directory for persisting propagation timeseries. */
  private readonly dataDir: string;

  /** Buffer of events to flush to disk. */
  private readonly writeBuffer: PropagationEvent[] = [];
  private readonly flushThreshold: number = 50;

  constructor(
    estimatedExecutionMs: number = 3000,
    dataDir: string = 'data/analysis/propagation',
  ) {
    this.estimatedExecutionMs = estimatedExecutionMs;
    this.dataDir = resolve(dataDir);

    // Ensure output directory exists
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }
  }

  // -----------------------------------------------------------------------
  // Core API: called on every book update
  // -----------------------------------------------------------------------

  /**
   * Called whenever a market's mid-price is updated.
   * Detects significant moves, creates pending observations, and resolves
   * pending observations from other markets.
   */
  onPriceUpdate(
    marketId: string,
    newMid: number,
    timestamp: number,
    graph: MarketGraph,
  ): void {
    const prevMid = this.prices.getLastPrice(marketId);
    this.prices.record(marketId, newMid, timestamp);

    if (prevMid === null) return;

    const priceChange = newMid - prevMid;
    if (Math.abs(priceChange) < MIN_ABSOLUTE_MOVE * 0.1) {
      // Tiny change — still check if this resolves pending moves as target
      this.resolveAnyPending(marketId, newMid, timestamp);
      return;
    }

    // Check if this market resolves any pending moves (as a target)
    this.resolveAnyPending(marketId, newMid, timestamp);

    // Check if this is a significant move (as a source)
    const sigma = this.prices.getRollingStddev(marketId);
    if (sigma === null) return;

    const moveSigma = Math.abs(priceChange) / sigma;
    if (moveSigma < MOVE_SIGMA_THRESHOLD || Math.abs(priceChange) < MIN_ABSOLUTE_MOVE) {
      return;
    }

    // Significant move detected — create pending observations for each related market
    const neighbors = graph.edges.get(marketId);
    if (!neighbors || neighbors.length === 0) return;

    const targets = new Map<string, {
      target_market_id: string;
      price_at_source_move: number;
      correlation: number;
    }>();

    for (const edge of neighbors) {
      const targetPrice = this.prices.getLastPrice(edge.target_market_id);
      if (targetPrice === null) continue;
      // Only track targets with meaningful correlation
      if (Math.abs(edge.price_correlation) < 0.2) continue;

      targets.set(edge.target_market_id, {
        target_market_id: edge.target_market_id,
        price_at_source_move: targetPrice,
        correlation: edge.price_correlation,
      });
    }

    if (targets.size === 0) return;

    const pending: PendingMove = {
      source_market_id: marketId,
      move_timestamp: timestamp,
      source_price_before: prevMid,
      source_price_after: newMid,
      source_move: priceChange,
      source_move_sigma: moveSigma,
      targets,
    };

    let list = this.pendingMoves.get(marketId);
    if (!list) {
      list = [];
      this.pendingMoves.set(marketId, list);
    }
    list.push(pending);

    // Trim old pending moves
    if (list.length > MAX_PENDING_PER_SOURCE) {
      list.splice(0, list.length - MAX_PENDING_PER_SOURCE);
    }

    log.debug(
      {
        source: marketId,
        move: priceChange.toFixed(4),
        sigma: moveSigma.toFixed(2),
        targets: targets.size,
      },
      'Significant move detected',
    );
  }

  // -----------------------------------------------------------------------
  // Resolve pending moves
  // -----------------------------------------------------------------------

  /**
   * Check if this market's price update resolves any pending moves
   * where this market was a target.
   */
  private resolveAnyPending(targetId: string, targetNewMid: number, timestamp: number): void {
    for (const [sourceId, pendingList] of this.pendingMoves) {
      // Iterate in reverse so we can splice
      for (let i = pendingList.length - 1; i >= 0; i--) {
        const pending = pendingList[i]!;

        // Expire old pending moves
        if (timestamp - pending.move_timestamp > PROPAGATION_WINDOW_MS) {
          // Expire all targets that didn't react — record as no-propagation
          pendingList.splice(i, 1);
          continue;
        }

        const targetInfo = pending.targets.get(targetId);
        if (!targetInfo) continue;

        const targetMove = targetNewMid - targetInfo.price_at_source_move;

        // Check if target moved meaningfully in the expected direction
        // Expected direction depends on correlation sign
        const expectedDirection = Math.sign(pending.source_move) * Math.sign(targetInfo.correlation);
        const actualDirection = Math.sign(targetMove);

        if (
          actualDirection === expectedDirection &&
          Math.abs(targetMove) >= Math.abs(pending.source_move) * MIN_REACTION_FRACTION
        ) {
          // Target reacted — record propagation event
          const lagMs = timestamp - pending.move_timestamp;
          const efficiency = Math.abs(targetMove) / Math.abs(pending.source_move);

          const event: PropagationEvent = {
            source_market_id: sourceId,
            target_market_id: targetId,
            timestamp: pending.move_timestamp,
            source_move: pending.source_move,
            source_move_sigma: pending.source_move_sigma,
            propagation_lag_ms: lagMs,
            propagation_efficiency: Math.min(efficiency, 5.0), // cap at 5x
            target_move: targetMove,
          };

          this.recordEvent(event);

          // Remove this target from pending (it's resolved)
          pending.targets.delete(targetId);

          // If no more targets, remove the pending move
          if (pending.targets.size === 0) {
            pendingList.splice(i, 1);
          }
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Event recording
  // -----------------------------------------------------------------------

  private recordEvent(event: PropagationEvent): void {
    const key = `${event.source_market_id}→${event.target_market_id}`;

    let list = this.events.get(key);
    if (!list) {
      list = [];
      this.events.set(key, list);
    }
    list.push(event);
    if (list.length > MAX_EVENTS_PER_PAIR) {
      list.splice(0, list.length - MAX_EVENTS_PER_PAIR);
    }

    this.statsCacheDirty = true;
    this.writeBuffer.push(event);

    if (this.writeBuffer.length >= this.flushThreshold) {
      this.flushToDisk();
    }

    log.debug(
      {
        source: event.source_market_id,
        target: event.target_market_id,
        lag_ms: event.propagation_lag_ms,
        efficiency: event.propagation_efficiency.toFixed(3),
      },
      'Propagation event recorded',
    );
  }

  // -----------------------------------------------------------------------
  // Periodic maintenance
  // -----------------------------------------------------------------------

  /**
   * Should be called periodically (e.g. every 30s) to clean up expired
   * pending moves and flush data to disk.
   */
  tick(): void {
    const t = now();

    // Expire old pending moves
    for (const [sourceId, pendingList] of this.pendingMoves) {
      for (let i = pendingList.length - 1; i >= 0; i--) {
        if (t - pendingList[i]!.move_timestamp > PROPAGATION_WINDOW_MS) {
          pendingList.splice(i, 1);
        }
      }
      if (pendingList.length === 0) {
        this.pendingMoves.delete(sourceId);
      }
    }

    // Flush write buffer
    if (this.writeBuffer.length > 0) {
      this.flushToDisk();
    }
  }

  // -----------------------------------------------------------------------
  // Statistics computation
  // -----------------------------------------------------------------------

  /** Computes stats for a single pair. Returns null if insufficient data. */
  computePairStats(sourceId: string, targetId: string): PairPropagationStats | null {
    const key = `${sourceId}→${targetId}`;
    const events = this.events.get(key);
    if (!events || events.length < 3) return null;

    const lags = events.map((e) => e.propagation_lag_ms);
    const efficiencies = events.map((e) => e.propagation_efficiency);

    const sortedLags = [...lags].sort((a, b) => a - b);
    const sortedEff = [...efficiencies].sort((a, b) => a - b);
    const n = sortedLags.length;

    const medianLag = sortedLags[Math.floor(n / 2)]!;
    const p25Lag = sortedLags[Math.floor(n * 0.25)]!;
    const p75Lag = sortedLags[Math.floor(n * 0.75)]!;
    const medianEff = sortedEff[Math.floor(n / 2)]!;

    return {
      source_market_id: sourceId,
      target_market_id: targetId,
      n_events: n,
      median_lag_ms: medianLag,
      p25_lag_ms: p25Lag,
      p75_lag_ms: p75Lag,
      mean_lag_ms: mean(lags),
      median_efficiency: medianEff,
      mean_efficiency: mean(efficiencies),
      exploitable: medianLag > this.estimatedExecutionMs,
      estimated_execution_ms: this.estimatedExecutionMs,
      last_updated: events[events.length - 1]!.timestamp,
    };
  }

  /** Returns stats for all tracked pairs. */
  getAllPairStats(): PairPropagationStats[] {
    if (!this.statsCacheDirty && this.statsCache.size > 0) {
      return [...this.statsCache.values()];
    }

    this.statsCache.clear();

    for (const [key, events] of this.events) {
      if (events.length < 3) continue;
      const [sourceId, targetId] = key.split('→') as [string, string];
      const stats = this.computePairStats(sourceId, targetId);
      if (stats) {
        this.statsCache.set(key, stats);
      }
    }

    this.statsCacheDirty = false;
    return [...this.statsCache.values()];
  }

  /** Returns only pairs where propagation is slow enough to exploit. */
  getExploitablePairs(): PairPropagationStats[] {
    return this.getAllPairStats().filter((s) => s.exploitable);
  }

  // -----------------------------------------------------------------------
  // Report
  // -----------------------------------------------------------------------

  buildReport(): PropagationReport {
    const allStats = this.getAllPairStats();
    const exploitable = allStats.filter((s) => s.exploitable);

    let pendingCount = 0;
    for (const list of this.pendingMoves.values()) {
      pendingCount += list.length;
    }

    let totalEvents = 0;
    for (const list of this.events.values()) {
      totalEvents += list.length;
    }

    return {
      timestamp: now(),
      pairs_tracked: this.events.size,
      total_events: totalEvents,
      pending_moves: pendingCount,
      exploitable_pairs: exploitable,
      all_pairs: allStats,
    };
  }

  // -----------------------------------------------------------------------
  // Configuration updates
  // -----------------------------------------------------------------------

  /** Update estimated execution latency (e.g. from execution research). */
  setEstimatedExecutionMs(ms: number): void {
    this.estimatedExecutionMs = ms;
    this.statsCacheDirty = true;
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Flushes buffered events to a JSONL file in data/analysis/propagation/.
   * One file per day, appended.
   */
  private flushToDisk(): void {
    if (this.writeBuffer.length === 0) return;

    const t = now();
    const dateKey = new Date(t).toISOString().slice(0, 10);
    const filePath = resolve(this.dataDir, `propagation_${dateKey}.jsonl`);

    const lines = this.writeBuffer
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n';

    try {
      appendFileSync(filePath, lines, 'utf-8');
    } catch (err) {
      log.warn({ err, path: filePath }, 'Failed to flush propagation events to disk');
    }

    this.writeBuffer.length = 0;
  }

  /**
   * Persists current pair statistics as a JSON snapshot.
   * Called periodically or on shutdown.
   */
  saveStatsSnapshot(): void {
    const stats = this.getAllPairStats();
    if (stats.length === 0) return;

    const filePath = resolve(this.dataDir, 'pair_stats_latest.json');
    try {
      writeFileSync(filePath, JSON.stringify(stats, null, 2), 'utf-8');
    } catch (err) {
      log.warn({ err, path: filePath }, 'Failed to save propagation stats snapshot');
    }
  }

  /**
   * Loads pair statistics from the latest snapshot (for warm-starting).
   * Returns the loaded stats, or an empty array if none found.
   */
  loadStatsSnapshot(): PairPropagationStats[] {
    const filePath = resolve(this.dataDir, 'pair_stats_latest.json');
    try {
      if (!existsSync(filePath)) return [];
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as PairPropagationStats[];
    } catch {
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Introspection (for testing)
  // -----------------------------------------------------------------------

  /** Returns the number of pending moves across all source markets. */
  getPendingMoveCount(): number {
    let count = 0;
    for (const list of this.pendingMoves.values()) {
      count += list.length;
    }
    return count;
  }

  /** Returns recorded events for a specific pair. */
  getEventsForPair(sourceId: string, targetId: string): PropagationEvent[] {
    const key = `${sourceId}→${targetId}`;
    return this.events.get(key) ?? [];
  }

  /** Returns total number of tracked pairs. */
  getTrackedPairCount(): number {
    return this.events.size;
  }
}
