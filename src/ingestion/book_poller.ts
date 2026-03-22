import { EventEmitter } from 'node:events';
import { now } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import { vwap, bookDepthWithin } from '../utils/math.js';
import type { ParsedBookSnapshot } from './types.js';

const log = getLogger('book_poller');

const DEPTH_1PCT = 0.01;
const DEPTH_5PCT = 0.05;
const VWAP_SIZE = 1000;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface BookPollerEvents {
  book_snapshot: [snapshot: ParsedBookSnapshot];
  stale: [tokenId: string, ageMs: number];
  error: [err: Error, tokenId: string];
}

// ---------------------------------------------------------------------------
// BookPoller
// ---------------------------------------------------------------------------

/**
 * Polls the Polymarket CLOB REST API for order book snapshots.
 * Polls all registered token IDs concurrently via Promise.allSettled.
 * Computes full derived fields: depth, VWAP, microprice.
 */
export class BookPoller extends EventEmitter {
  private readonly clobRestUrl: string;
  private readonly pollIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly trackedTokens = new Map<string, string>(); // tokenId → marketId
  private readonly lastPollAt = new Map<string, number>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(clobRestUrl: string, pollIntervalMs: number, staleThresholdMs = 5_000) {
    super();
    this.clobRestUrl = clobRestUrl;
    this.pollIntervalMs = pollIntervalMs;
    this.staleThresholdMs = staleThresholdMs;
  }

  addToken(tokenId: string, marketId: string): void {
    if (!tokenId) return;
    const isNew = !this.trackedTokens.has(tokenId);
    this.trackedTokens.set(tokenId, marketId);
    if (isNew) {
      log.debug({ tokenId: tokenId.slice(0, 16), marketId }, 'Token added to book poller');
    }
  }

  removeToken(tokenId: string): void {
    this.trackedTokens.delete(tokenId);
    this.lastPollAt.delete(tokenId);
  }

  start(): void {
    if (this.pollTimer !== null) return;
    log.info({ tokens: this.trackedTokens.size }, 'BookPoller starting');
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, this.pollIntervalMs);
    // Don't poll immediately — no tokens registered yet, MetadataFetcher will add them
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('BookPoller stopped');
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  // Round-robin index for polling tokens in batches
  private pollIndex = 0;

  private async pollAll(): Promise<void> {
    const tokens = Array.from(this.trackedTokens.entries());
    if (tokens.length === 0) return;

    // Poll a batch of tokens per tick to avoid overwhelming the event loop.
    // With 500+ tokens and 2s interval, we poll ~20 tokens per tick = full
    // cycle in ~50 ticks = ~100 seconds. WS provides real-time updates for
    // the rest, so this is mainly a fallback/reconciliation.
    const BATCH_SIZE = 20;
    const start = this.pollIndex;
    const end = Math.min(start + BATCH_SIZE, tokens.length);
    const batch = tokens.slice(start, end);

    this.pollIndex = end >= tokens.length ? 0 : end;

    const results = await Promise.allSettled(
      batch.map(([tokenId, marketId]) => this.fetchBook(tokenId, marketId)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const [tokenId] = batch[i]!;

      if (result.status === 'fulfilled') {
        if (result.value !== null) {
          this.lastPollAt.set(tokenId, now());
          this.emit('book_snapshot', result.value);
        }
      } else {
        log.debug({ tokenId: tokenId.slice(0, 16) }, 'BookPoller fetch error');
        this.emit('error', result.reason as Error, tokenId);
      }
    }
  }

  private async fetchBook(
    tokenId: string,
    marketId: string,
    attempt = 0,
  ): Promise<ParsedBookSnapshot | null> {
    const url = `${this.clobRestUrl}/book?token_id=${encodeURIComponent(tokenId)}`;

    try {
      const resp = await fetch(url);

      if (resp.status === 429) {
        const retryAfter = Number(resp.headers.get('retry-after') ?? '2');
        if (attempt < 3) {
          await sleep(retryAfter * 1000);
          return this.fetchBook(tokenId, marketId, attempt + 1);
        }
        throw new Error('Rate limited after retries');
      }

      if (!resp.ok) {
        if (attempt < 3) {
          await sleep(500 * Math.pow(2, attempt));
          return this.fetchBook(tokenId, marketId, attempt + 1);
        }
        throw new Error(`HTTP ${resp.status}`);
      }

      const data = (await resp.json()) as unknown;
      return parseBookResponse(data, tokenId, marketId);
    } catch (err) {
      if (attempt < 3) {
        await sleep(500 * Math.pow(2, attempt));
        return this.fetchBook(tokenId, marketId, attempt + 1);
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseBookResponse(
  data: unknown,
  tokenId: string,
  marketId: string,
): ParsedBookSnapshot | null {
  try {
    const r = data as Record<string, unknown>;
    const t = now();

    const bids = parseLevels(r['bids']);
    const asks = parseLevels(r['asks']);

    if (bids.length === 0 && asks.length === 0) return null;

    const bestBid = bids[0]?.[0] ?? 0;
    const bestAsk = asks[0]?.[0] ?? 1;
    const mid = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0;

    const bidDepth1pct = bookDepthWithin(bids, bestBid, DEPTH_1PCT);
    const askDepth1pct = bookDepthWithin(asks, bestAsk, DEPTH_1PCT);
    const bidDepth5pct = bookDepthWithin(bids, bestBid, DEPTH_5PCT);
    const askDepth5pct = bookDepthWithin(asks, bestAsk, DEPTH_5PCT);

    const vwapBid = vwap(bids, VWAP_SIZE);
    const vwapAsk = vwap(asks, VWAP_SIZE);

    // Rough queue position estimate: size at best / avg incoming trade size (assume 100)
    const queueDepthAtBest = bids[0]?.[1] ?? 0;
    const queuePositionEstimate = queueDepthAtBest / 100;

    return {
      market_id: marketId,
      token_id: tokenId,
      bids,
      asks,
      timestamp: t,
      mid_price: mid,
      spread,
      spread_bps: spreadBps,
      bid_depth_1pct: bidDepth1pct,
      ask_depth_1pct: askDepth1pct,
      bid_depth_5pct: bidDepth5pct,
      ask_depth_5pct: askDepth5pct,
      vwap_bid_1000: vwapBid,
      vwap_ask_1000: vwapAsk,
      queue_position_estimate: queuePositionEstimate,
    };
  } catch (err) {
    log.warn({ err, tokenId }, 'Failed to parse book response');
    return null;
  }
}

function parseLevels(raw: unknown): [number, number][] {
  if (!Array.isArray(raw)) return [];

  const levels: [number, number][] = [];
  for (const item of raw as unknown[]) {
    if (Array.isArray(item) && item.length >= 2) {
      levels.push([Number(item[0]), Number(item[1])]);
    } else if (typeof item === 'object' && item !== null) {
      const o = item as Record<string, unknown>;
      const price = Number(o['price'] ?? o['p'] ?? 0);
      const size = Number(o['size'] ?? o['s'] ?? 0);
      if (price > 0 && size >= 0) levels.push([price, size]);
    }
  }
  return levels;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
