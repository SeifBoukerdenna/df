import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { now, dayKey } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import type { RawEvent, ParsedTrade, ParsedBookSnapshot, BookSummary } from './types.js';
import type { IngestionSourceMetrics } from './types.js';

const log = getLogger('clob_ws');

const SOURCE = 'clob_ws';
const HEARTBEAT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface ClobWebSocketEvents {
  trade: [trade: ParsedTrade];
  book_snapshot: [snapshot: ParsedBookSnapshot];
  connected: [];
  disconnected: [code: number, reason: string];
  error: [err: Error];
}

// ---------------------------------------------------------------------------
// ClobWebSocket
// ---------------------------------------------------------------------------

/**
 * WebSocket client for the Polymarket CLOB real-time feed.
 * - Reconnects with exponential backoff (1s → 60s, +10% jitter).
 * - Heartbeat monitoring: if no message in 30s, force reconnect.
 * - Deduplication by (type, unique_key) with TTL eviction.
 * - Monotonic sequence IDs per source.
 * - Persists raw events to JSONL.
 * - Attaches pre-trade book snapshot to ParsedTrade.
 */
export class ClobWebSocket extends EventEmitter {
  private readonly wsUrl: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly dedupTtlMs: number;
  private readonly rawEventsDir: string;

  private ws: WebSocket | null = null;
  private running = false;
  private seqId = 0;

  // Reconnect state
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;

  // Dedup cache: key → expiry timestamp
  private readonly dedupCache = new Map<string, number>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Latest book snapshots per token (for pre-trade attachment)
  private readonly latestBooks = new Map<string, ParsedBookSnapshot>();

  // Metrics
  readonly metrics: IngestionSourceMetrics = {
    source: SOURCE,
    events_received: 0,
    events_per_second: 0,
    duplicates_removed: 0,
    parse_errors: 0,
    gaps_detected: 0,
    reconnect_count: 0,
    stale_data_flags: 0,
    last_event_at: null,
  };

  // EPS tracking
  private epsWindowStart = now();
  private epsWindowCount = 0;

  constructor(opts: {
    wsUrl: string;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    dedupTtlMs?: number;
    rawEventsDir?: string;
  }) {
    super();
    this.wsUrl = opts.wsUrl;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 1_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 60_000;
    this.dedupTtlMs = opts.dedupTtlMs ?? 60_000;
    this.rawEventsDir = opts.rawEventsDir ?? 'data/raw_events';

    // Periodic dedup cache eviction
    this.dedupCleanupTimer = setInterval(() => this.evictDedup(), 30_000);
    this.dedupCleanupTimer.unref();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info({ url: this.wsUrl }, 'ClobWebSocket starting');
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.dedupCleanupTimer !== null) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
    if (this.ws !== null) {
      this.ws.terminate();
      this.ws = null;
    }
    log.info('ClobWebSocket stopped');
  }

  /** Called by BookPoller or external code to keep latest book state in sync. */
  updateBookSnapshot(snapshot: ParsedBookSnapshot): void {
    this.latestBooks.set(snapshot.token_id, snapshot);
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  private connect(): void {
    if (!this.running) return;

    log.info(
      { attempt: this.reconnectAttempt, url: this.wsUrl },
      'ClobWebSocket connecting',
    );

    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      log.info('ClobWebSocket connected');
      this.reconnectAttempt = 0;
      this.resetHeartbeat();
      this.emit('connected');

      // Subscribe to all market trades
      ws.send(JSON.stringify({ type: 'subscribe', channel: 'market', markets: [] }));
    });

    ws.on('message', (data: Buffer | string) => {
      this.resetHeartbeat();
      this.handleMessage(data.toString());
    });

    ws.on('close', (code: number, reason: Buffer) => {
      const reasonStr = reason.toString();
      log.warn({ code, reason: reasonStr }, 'ClobWebSocket disconnected');
      this.clearHeartbeat();
      this.ws = null;
      this.emit('disconnected', code, reasonStr);
      if (this.running) this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.warn({ err }, 'ClobWebSocket error');
      this.emit('error', err);
      // close event will fire after error and trigger reconnect
    });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    const base = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxMs,
    );
    const jitter = base * 0.1 * Math.random();
    const delay = Math.round(base + jitter);

    this.reconnectAttempt++;
    this.metrics.reconnect_count++;

    log.info({ delay, attempt: this.reconnectAttempt }, 'ClobWebSocket scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private resetHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      log.warn('ClobWebSocket heartbeat timeout — forcing reconnect');
      if (this.ws !== null) {
        this.ws.terminate();
        this.ws = null;
      }
      if (this.running) this.scheduleReconnect();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private handleMessage(raw: string): void {
    const t = now();

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      this.metrics.parse_errors++;
      log.warn({ raw: raw.slice(0, 200) }, 'ClobWebSocket: failed to parse JSON');
      return;
    }

    // The CLOB feed may send arrays of events
    const events: unknown[] = Array.isArray(data) ? data : [data];

    for (const evt of events) {
      this.handleEvent(evt, t, raw);
    }
  }

  private handleEvent(evt: unknown, t: number, rawStr: string): void {
    if (typeof evt !== 'object' || evt === null) return;

    const e = evt as Record<string, unknown>;
    const type = String(e['event_type'] ?? e['type'] ?? '');

    this.metrics.events_received++;
    this.updateEps(t);
    this.metrics.last_event_at = t;

    if (type === 'trade' || type === 'last_trade_price') {
      this.handleTradeEvent(e, t, rawStr);
    } else if (type === 'price_change' || type === 'book') {
      this.handlePriceChange(e, t, rawStr);
    }
    // Ignore ping / heartbeat / subscribe_ack silently
  }

  private handleTradeEvent(e: Record<string, unknown>, t: number, rawStr: string): void {
    try {
      const dedupKey = `trade:${String(e['transaction_hash'] ?? '')}:${String(e['trade_id'] ?? '')}:${String(e['timestamp'] ?? t)}`;

      if (this.isDuplicate(dedupKey)) {
        this.metrics.duplicates_removed++;
        return;
      }
      this.markSeen(dedupKey);

      const marketId = String(e['market'] ?? e['market_id'] ?? '');
      const tokenId = String(e['asset_id'] ?? e['token_id'] ?? '');
      const price = Number(e['price'] ?? 0);
      const size = Number(e['size'] ?? e['shares_filled'] ?? 0);
      const side = (String(e['side'] ?? 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY') as
        | 'BUY'
        | 'SELL';
      const sourceTs = e['timestamp'] !== undefined ? Number(e['timestamp']) : null;

      const bookBefore = this.buildBookSummary(tokenId);

      const trade: ParsedTrade = {
        market_id: marketId,
        condition_id: String(e['condition_id'] ?? ''),
        token_id: tokenId,
        side,
        price,
        size,
        notional: price * size,
        maker: String(e['maker_address'] ?? e['maker'] ?? ''),
        taker: String(e['taker_address'] ?? e['taker'] ?? ''),
        tx_hash: e['transaction_hash'] ? String(e['transaction_hash']) : null,
        timestamp: sourceTs ?? t,
        book_state_before: bookBefore,
      };

      // Stale data check
      if (sourceTs !== null && t - sourceTs > 5_000) {
        this.metrics.stale_data_flags++;
      }

      const rawEvent: RawEvent = {
        source: 'clob_ws',
        type: 'trade',
        timestamp_ingested: t,
        timestamp_source: sourceTs,
        raw_payload: JSON.parse(rawStr) as object,
        parsed: trade,
        sequence_id: ++this.seqId,
      };

      this.persistRawEvent(rawEvent);
      this.emit('trade', trade);
    } catch (err) {
      this.metrics.parse_errors++;
      log.warn({ err }, 'ClobWebSocket: failed to parse trade event');
    }
  }

  private handlePriceChange(e: Record<string, unknown>, t: number, rawStr: string): void {
    try {
      const changes = e['price_changes'] as unknown[] | undefined;
      const items = Array.isArray(changes) ? changes : [e];

      for (const item of items) {
        const c = item as Record<string, unknown>;
        const tokenId = String(c['asset_id'] ?? c['token_id'] ?? '');
        const marketId = String(c['market'] ?? c['market_id'] ?? '');

        const rawBids = parseLevels(c['bids']);
        const rawAsks = parseLevels(c['asks']);

        if (rawBids.length === 0 && rawAsks.length === 0) continue;

        const dedupKey = `book:${tokenId}:${t}`;
        if (this.isDuplicate(dedupKey)) {
          this.metrics.duplicates_removed++;
          continue;
        }
        this.markSeen(dedupKey);

        const bestBid = rawBids[0]?.[0] ?? 0;
        const bestAsk = rawAsks[0]?.[0] ?? 1;
        const mid = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;
        const spreadBps = mid > 0 ? (spread / mid) * 10_000 : 0;

        const snapshot: ParsedBookSnapshot = {
          market_id: marketId,
          token_id: tokenId,
          bids: rawBids,
          asks: rawAsks,
          timestamp: t,
          mid_price: mid,
          spread,
          spread_bps: spreadBps,
          bid_depth_1pct: 0,
          ask_depth_1pct: 0,
          bid_depth_5pct: 0,
          ask_depth_5pct: 0,
          vwap_bid_1000: bestBid,
          vwap_ask_1000: bestAsk,
          queue_position_estimate: 0,
        };

        this.latestBooks.set(tokenId, snapshot);

        const rawEvent: RawEvent = {
          source: 'clob_ws',
          type: 'book_snapshot',
          timestamp_ingested: t,
          timestamp_source: null,
          raw_payload: c as object,
          parsed: snapshot,
          sequence_id: ++this.seqId,
        };

        this.persistRawEvent(rawEvent);
        this.emit('book_snapshot', snapshot);
      }
    } catch (err) {
      this.metrics.parse_errors++;
      log.warn({ err }, 'ClobWebSocket: failed to parse price_change event');
    }
  }

  // ---------------------------------------------------------------------------
  // Deduplication
  // ---------------------------------------------------------------------------

  private isDuplicate(key: string): boolean {
    const expiry = this.dedupCache.get(key);
    return expiry !== undefined && expiry > now();
  }

  private markSeen(key: string): void {
    this.dedupCache.set(key, now() + this.dedupTtlMs);
  }

  private evictDedup(): void {
    const t = now();
    for (const [key, expiry] of this.dedupCache) {
      if (expiry <= t) this.dedupCache.delete(key);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildBookSummary(tokenId: string): BookSummary | null {
    const snap = this.latestBooks.get(tokenId);
    if (!snap) return null;
    const bidDepth = snap.bids.slice(0, 5).reduce((s, [, sz]) => s + sz, 0);
    const askDepth = snap.asks.slice(0, 5).reduce((s, [, sz]) => s + sz, 0);
    return {
      mid: snap.mid_price,
      spread: snap.spread,
      best_bid: snap.bids[0]?.[0] ?? 0,
      best_ask: snap.asks[0]?.[0] ?? 1,
      bid_depth_5lvl: bidDepth,
      ask_depth_5lvl: askDepth,
    };
  }

  private updateEps(t: number): void {
    this.epsWindowCount++;
    const elapsed = (t - this.epsWindowStart) / 1000;
    if (elapsed >= 5) {
      this.metrics.events_per_second = this.epsWindowCount / elapsed;
      this.epsWindowCount = 0;
      this.epsWindowStart = t;
    }
  }

  private persistRawEvent(rawEvent: RawEvent): void {
    try {
      const dir = this.rawEventsDir;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const file = join(dir, `${dayKey(rawEvent.timestamp_ingested)}.jsonl`);
      appendFileSync(file, JSON.stringify(rawEvent) + '\n');
    } catch (err) {
      log.warn({ err }, 'ClobWebSocket: failed to persist raw event');
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
      if (price > 0) levels.push([price, size]);
    }
  }
  return levels;
}
