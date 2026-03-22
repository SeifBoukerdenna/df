import { EventEmitter } from 'node:events';
import { Pool } from 'undici';
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
  error: [err: Error, context: string];
}

// ---------------------------------------------------------------------------
// BookPoller
// ---------------------------------------------------------------------------

/**
 * Polls the Polymarket CLOB REST API for order book snapshots.
 * Uses a single POST /books batch request per tick via a persistent undici
 * connection pool — no per-request TCP handshakes, no port exhaustion.
 * Computes full derived fields: depth, VWAP, microprice.
 */
export class BookPoller extends EventEmitter {
  private readonly clobRestUrl: string;
  private readonly pollIntervalMs: number;
  private readonly staleThresholdMs: number;
  private readonly trackedTokens = new Map<string, string>(); // tokenId → marketId
  private readonly lastPollAt = new Map<string, number>();
  private readonly pool: Pool;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(clobRestUrl: string, pollIntervalMs: number, staleThresholdMs = 5_000) {
    super();
    this.clobRestUrl = clobRestUrl;
    this.pollIntervalMs = pollIntervalMs;
    this.staleThresholdMs = staleThresholdMs;

    // Persistent connection pool to the CLOB host — reuses TCP/TLS connections
    // across all poll requests, eliminating per-request handshake cost and
    // TIME_WAIT port exhaustion.
    const url = new URL(clobRestUrl);
    this.pool = new Pool(`${url.protocol}//${url.host}`, {
      connections: 4,          // 4 persistent connections is plenty for 1 req/tick
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connect: { timeout: 10_000 },
    });
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
    void this.pool.destroy();
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

    // With 500+ tokens and batch_size=100, we make 1 POST /books request per tick
    // instead of 20 parallel GET /book requests.
    // Full cycle over 1000 tokens = 10 ticks × interval = fast cold-start warm-up.
    const BATCH_SIZE = 100;
    const start = this.pollIndex;
    const end = Math.min(start + BATCH_SIZE, tokens.length);
    const batch = tokens.slice(start, end);

    this.pollIndex = end >= tokens.length ? 0 : end;

    const tokenIds = batch.map(([tokenId]) => tokenId);
    const books = await this.fetchBooks(tokenIds);

    if (books === null) return;

    for (const bookData of books) {
      const r = bookData as Record<string, unknown>;
      const assetId = r['asset_id'] as string | undefined;
      if (!assetId) continue;

      const marketId = this.trackedTokens.get(assetId);
      if (!marketId) continue;

      const snapshot = parseBookResponse(bookData, assetId, marketId);
      if (snapshot !== null) {
        this.lastPollAt.set(assetId, now());
        this.emit('book_snapshot', snapshot);
      }
    }
  }

  private async fetchBooks(
    tokenIds: string[],
    attempt = 0,
  ): Promise<unknown[] | null> {
    const urlObj = new URL(this.clobRestUrl);
    const path = `${urlObj.pathname}/books`.replace('//', '/');
    const body = JSON.stringify(tokenIds.map((id) => ({ token_id: id })));

    try {
      const { statusCode, body: responseBody, headers } = await this.pool.request({
        method: 'POST',
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      });

      if (statusCode === 429) {
        const retryAfter = Number(headers['retry-after'] ?? '2');
        if (attempt < 3) {
          await sleep(retryAfter * 1000);
          return this.fetchBooks(tokenIds, attempt + 1);
        }
        await responseBody.dump();
        const err = new Error('Rate limited after retries');
        log.debug({ count: tokenIds.length }, 'BookPoller batch rate limited');
        this.emit('error', err, `batch(${tokenIds.length} tokens)`);
        return null;
      }

      if (statusCode < 200 || statusCode >= 300) {
        if (attempt < 3) {
          await responseBody.dump();
          await sleep(500 * Math.pow(2, attempt));
          return this.fetchBooks(tokenIds, attempt + 1);
        }
        const text = await responseBody.text().catch(() => '');
        const err = new Error(`HTTP ${statusCode}`);
        log.debug({ count: tokenIds.length, status: statusCode, body: text.slice(0, 200) }, 'BookPoller batch fetch error');
        this.emit('error', err, `batch(${tokenIds.length} tokens)`);
        return null;
      }

      return (await responseBody.json()) as unknown[];
    } catch (err) {
      if (attempt < 3) {
        await sleep(500 * Math.pow(2, attempt));
        return this.fetchBooks(tokenIds, attempt + 1);
      }
      log.debug({ count: tokenIds.length }, 'BookPoller batch fetch error');
      this.emit('error', err as Error, `batch(${tokenIds.length} tokens)`);
      return null;
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
