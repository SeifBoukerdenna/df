import { EventEmitter } from 'node:events';
import { getLogger } from '../utils/logger.js';
import { now } from '../utils/time.js';
import { config } from '../utils/config.js';
import { vwap, bookDepthWithin } from '../utils/math.js';
import type { ParsedBookSnapshot, MarketMetadata } from './types.js';

const log = getLogger('ingestion.book_poller');

// ---------------------------------------------------------------------------
// CLOB REST API response shapes
// ---------------------------------------------------------------------------

interface ClobOrderBookResponse {
  market: string;
  asset_id: string;
  hash?: string;
  timestamp?: number;
  bids: { price: string; size: string }[];
  asks: { price: string; size: string }[];
}

// ---------------------------------------------------------------------------
// BookPoller
// ---------------------------------------------------------------------------

export interface BookPollerEvents {
  snapshot: [snapshot: ParsedBookSnapshot];
  stale_data: [market_id: string, token_id: string, age_ms: number];
  error: [error: Error];
}

/**
 * Polls the Polymarket CLOB REST API for order book snapshots at a
 * configurable interval. Computes all derived book fields (mid, spread,
 * VWAP, depth) and emits typed `snapshot` events.
 *
 * Features:
 * - Per-market, per-token polling
 * - Retry with exponential backoff (up to 3 retries)
 * - Stale data detection (alerts if source timestamp > threshold)
 */
export class BookPoller extends EventEmitter<BookPollerEvents> {
  private readonly restUrl: string;
  private readonly pollIntervalMs: number;
  private readonly staleThresholdMs: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** token_id → market_id mapping for active tokens to poll. */
  private readonly tokens: Map<string, { market_id: string; token_id: string }> = new Map();

  constructor() {
    super();
    this.restUrl = config.polymarket.rest_url;
    this.pollIntervalMs = config.ingestion.book_poll_interval_ms;
    this.staleThresholdMs = config.ingestion.stale_data_threshold_ms;
  }

  // -----------------------------------------------------------------------
  // Token registration
  // -----------------------------------------------------------------------

  /** Registers both YES and NO tokens for a market. */
  addMarket(metadata: MarketMetadata): void {
    this.tokens.set(metadata.tokens.yes_id, {
      market_id: metadata.market_id,
      token_id: metadata.tokens.yes_id,
    });
    this.tokens.set(metadata.tokens.no_id, {
      market_id: metadata.market_id,
      token_id: metadata.tokens.no_id,
    });
  }

  removeMarket(metadata: MarketMetadata): void {
    this.tokens.delete(metadata.tokens.yes_id);
    this.tokens.delete(metadata.tokens.no_id);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info({ interval_ms: this.pollIntervalMs, tokens: this.tokens.size }, 'Book poller started');

    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
    if (this.pollTimer.unref) this.pollTimer.unref();

    // Immediate first poll
    void this.pollAll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('Book poller stopped');
  }

  // -----------------------------------------------------------------------
  // Polling
  // -----------------------------------------------------------------------

  private async pollAll(): Promise<void> {
    const entries = Array.from(this.tokens.values());
    // Poll all tokens concurrently
    await Promise.allSettled(
      entries.map((entry) => this.pollOne(entry.market_id, entry.token_id)),
    );
  }

  async pollOne(marketId: string, tokenId: string): Promise<ParsedBookSnapshot | null> {
    try {
      const raw = await this.fetchBookWithRetry(tokenId, 3);
      if (!raw) return null;

      const snapshot = this.parseBook(marketId, tokenId, raw);
      this.checkStaleness(snapshot);
      this.emit('snapshot', snapshot);
      return snapshot;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error({ err: error, marketId, tokenId }, 'Book poll error');
      this.emit('error', error);
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // REST fetch with retry
  // -----------------------------------------------------------------------

  private async fetchBookWithRetry(
    tokenId: string,
    maxRetries: number,
  ): Promise<ClobOrderBookResponse | null> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const url = `${this.restUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
        const response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(8_000),
        });

        if (response.ok) {
          return (await response.json()) as ClobOrderBookResponse;
        }

        if (response.status === 429) {
          const delay = Math.min(1000 * 2 ** attempt, 15_000);
          log.warn({ status: 429, delay, attempt, tokenId }, 'Rate limited');
          await this.sleep(delay);
          continue;
        }

        lastError = new Error(`HTTP ${response.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          const delay = Math.min(500 * 2 ** attempt, 10_000);
          await this.sleep(delay);
        }
      }
    }

    log.warn({ err: lastError, tokenId }, 'Book fetch retries exhausted');
    return null;
  }

  // -----------------------------------------------------------------------
  // Parsing & derived field computation
  // -----------------------------------------------------------------------

  private parseBook(
    marketId: string,
    tokenId: string,
    raw: ClobOrderBookResponse,
  ): ParsedBookSnapshot {
    const t = now();
    const sourceTimestamp = raw.timestamp ?? null;

    // Parse and sort levels
    const bids: [number, number][] = raw.bids
      .map((b): [number, number] => [parseFloat(b.price), parseFloat(b.size)])
      .filter(([p, s]) => isFinite(p) && isFinite(s) && s > 0)
      .sort((a, b) => b[0] - a[0]); // descending by price

    const asks: [number, number][] = raw.asks
      .map((a): [number, number] => [parseFloat(a.price), parseFloat(a.size)])
      .filter(([p, s]) => isFinite(p) && isFinite(s) && s > 0)
      .sort((a, b) => a[0] - b[0]); // ascending by price

    const bestBid = bids[0]?.[0] ?? 0;
    const bestAsk = asks[0]?.[0] ?? 0;
    const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : 0;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : 0;
    const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0;

    return {
      market_id: marketId,
      token_id: tokenId,
      bids,
      asks,
      timestamp: sourceTimestamp ?? t,
      mid_price: mid,
      spread,
      spread_bps: spreadBps,
      bid_depth_1pct: bookDepthWithin(bids, 0.01, bestBid),
      ask_depth_1pct: bookDepthWithin(asks, 0.01, bestAsk),
      bid_depth_5pct: bookDepthWithin(bids, 0.05, bestBid),
      ask_depth_5pct: bookDepthWithin(asks, 0.05, bestAsk),
      vwap_bid_1000: vwap(bids, 1000),
      vwap_ask_1000: vwap(asks, 1000),
      queue_position_estimate: this.estimateQueueTime(bids, asks),
    };
  }

  /**
   * Rough queue-time estimate: total best-level size / assumed arrival rate.
   * This is a placeholder — the real fill model lives in Module 13.
   */
  private estimateQueueTime(
    bids: [number, number][],
    asks: [number, number][],
  ): number {
    const bestBidSize = bids[0]?.[1] ?? 0;
    const bestAskSize = asks[0]?.[1] ?? 0;
    const avgQueueSize = (bestBidSize + bestAskSize) / 2;
    // Assume ~10 units filled per second as a rough baseline
    const fillRate = 10;
    return avgQueueSize > 0 ? (avgQueueSize / fillRate) * 1000 : 0;
  }

  // -----------------------------------------------------------------------
  // Stale data detection
  // -----------------------------------------------------------------------

  private checkStaleness(snapshot: ParsedBookSnapshot): void {
    const age = now() - snapshot.timestamp;
    if (age > this.staleThresholdMs) {
      log.warn(
        { market_id: snapshot.market_id, token_id: snapshot.token_id, age_ms: age },
        'Stale book data detected',
      );
      this.emit('stale_data', snapshot.market_id, snapshot.token_id, age);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
