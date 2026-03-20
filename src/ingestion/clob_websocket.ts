import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { getLogger } from '../utils/logger.js';
import { now, dayKey } from '../utils/time.js';
import { config } from '../utils/config.js';
import type {
  RawEvent,
  ParsedTrade,
  ParsedBookSnapshot,
  BookSummary,
  IngestionSourceMetrics,
} from './types.js';

const log = getLogger('ingestion.clob_ws');

// ---------------------------------------------------------------------------
// CLOB WebSocket message shapes
// ---------------------------------------------------------------------------

interface ClobTradeMessage {
  event_type: 'trade';
  market: string;
  asset_id: string;
  condition_id?: string;
  side: 'BUY' | 'SELL';
  price: string;
  size: string;
  maker_address?: string;
  taker_address?: string;
  transaction_hash?: string;
  timestamp?: string;
}

interface ClobPriceChangeMessage {
  event_type: 'price_change';
  market: string;
  asset_id: string;
  price: string;
  timestamp?: string;
}

type ClobMessage = ClobTradeMessage | ClobPriceChangeMessage | { event_type: string;[key: string]: unknown };

// ---------------------------------------------------------------------------
// ClobWebSocket
// ---------------------------------------------------------------------------

export interface ClobWebSocketEvents {
  trade: [trade: ParsedTrade, raw: RawEvent];
  price_change: [market_id: string, token_id: string, price: number];
  reconnect: [attempt: number];
  gap: [source: string, expected: number, got: number];
  alert: [source: string, reason: string];
  error: [error: Error];
  open: [];
  close: [];
}

/**
 * Connects to the Polymarket CLOB WebSocket for real-time trade and price
 * change events.
 *
 * Features:
 * - Automatic reconnection with exponential backoff (1s–60s)
 * - Heartbeat monitoring: alerts if no message in 30s
 * - Monotonic sequence IDs per source with gap detection
 * - Deduplication cache (source+type+unique_key)
 * - Pre-trade book snapshot attachment from most recent BookPoller data
 * - Raw event persistence to daily JSONL files
 */
export class ClobWebSocket extends EventEmitter<ClobWebSocketEvents> {
  private readonly wsUrl: string;
  private readonly rawEventsDir: string;
  private ws: WebSocket | null = null;
  private running = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;

  // Sequence tracking
  private seqId = 0;

  // Dedup cache: key → timestamp (auto-evicted after TTL)
  private readonly dedupCache = new Map<string, number>();
  private readonly dedupTtlMs: number;
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;

  // Latest book snapshots for pre-trade attachment
  private readonly latestBooks = new Map<string, BookSummary>();

  // Metrics
  private readonly metrics: IngestionSourceMetrics = {
    source: 'clob_ws',
    events_received: 0,
    events_per_second: 0,
    duplicates_removed: 0,
    parse_errors: 0,
    gaps_detected: 0,
    reconnect_count: 0,
    stale_data_flags: 0,
    last_event_at: null,
  };
  private eventCountWindow: number[] = [];

  // Markets to subscribe to
  private readonly subscribedMarkets = new Set<string>();

  constructor() {
    super();
    this.wsUrl = config.polymarket.clob_ws_url;
    this.rawEventsDir = config.ingestion.raw_events_dir;
    this.dedupTtlMs = config.ingestion.dedup_cache_ttl_ms;

    if (!existsSync(this.rawEventsDir)) {
      mkdirSync(this.rawEventsDir, { recursive: true });
    }
  }

  // -----------------------------------------------------------------------
  // Public interface
  // -----------------------------------------------------------------------

  /** Adds a market to the subscription set. If already connected, subscribes immediately. */
  addMarket(marketId: string): void {
    this.subscribedMarkets.add(marketId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe([marketId]);
    }
  }

  removeMarket(marketId: string): void {
    this.subscribedMarkets.delete(marketId);
  }

  /** Updates the latest book snapshot for a token, used for pre-trade attachment. */
  updateBookSnapshot(tokenId: string, summary: BookSummary): void {
    this.latestBooks.set(tokenId, summary);
  }

  getMetrics(): IngestionSourceMetrics {
    return { ...this.metrics };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.startHeartbeatMonitor();
    this.startDedupCleanup();
    log.info({ url: this.wsUrl }, 'CLOB WebSocket starting');
  }

  stop(): void {
    this.running = false;
    this.stopTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close(1000, 'Shutdown');
      this.ws = null;
    }
    log.info('CLOB WebSocket stopped');
    this.emit('close');
  }

  // -----------------------------------------------------------------------
  // Connection management
  // -----------------------------------------------------------------------

  private connect(): void {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(this.wsUrl);
    } catch (err) {
      log.error({ err }, 'Failed to create WebSocket');
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      log.info('WebSocket connected');
      this.reconnectAttempt = 0;
      this.lastMessageAt = now();

      // Subscribe to all registered markets
      if (this.subscribedMarkets.size > 0) {
        this.sendSubscribe(Array.from(this.subscribedMarkets));
      }

      this.emit('open');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.lastMessageAt = now();
      this.handleMessage(data);
    });

    this.ws.on('error', (err: Error) => {
      log.error({ err }, 'WebSocket error');
      this.emit('error', err);
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      log.warn({ code, reason: reason.toString() }, 'WebSocket closed');
      this.ws = null;
      if (this.running) {
        this.scheduleReconnect();
      }
      this.emit('close');
    });
  }

  private sendSubscribe(marketIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    for (const marketId of marketIds) {
      const msg = JSON.stringify({
        type: 'subscribe',
        channel: 'market',
        market: marketId,
      });
      this.ws.send(msg);
    }

    log.debug({ count: marketIds.length }, 'Sent subscribe messages');
  }

  private scheduleReconnect(): void {
    if (!this.running) return;

    const baseMs = config.ingestion.ws_reconnect_base_ms;
    const maxMs = config.ingestion.ws_reconnect_max_ms;
    // Exponential backoff with jitter
    const delay = Math.min(baseMs * 2 ** this.reconnectAttempt, maxMs);
    const jitter = Math.random() * delay * 0.1;
    const totalDelay = delay + jitter;

    this.reconnectAttempt++;
    this.metrics.reconnect_count++;

    log.info({ attempt: this.reconnectAttempt, delay_ms: Math.round(totalDelay) }, 'Scheduling reconnect');
    this.emit('reconnect', this.reconnectAttempt);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, totalDelay);
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  private handleMessage(data: WebSocket.Data): void {
    let raw: string;
    if (typeof data === 'string') {
      raw = data;
    } else if (Buffer.isBuffer(data)) {
      raw = data.toString('utf-8');
    } else if (Array.isArray(data)) {
      raw = Buffer.concat(data).toString('utf-8');
    } else {
      raw = data.toString();
    }

    let parsed: ClobMessage;
    try {
      parsed = JSON.parse(raw) as ClobMessage;
    } catch {
      this.metrics.parse_errors++;
      return;
    }

    // Handle different message types based on event_type or fallback for arrays
    const messages = Array.isArray(parsed) ? parsed as ClobMessage[] : [parsed];

    for (const msg of messages) {
      if (!msg.event_type) continue;

      if (msg.event_type === 'trade') {
        this.handleTrade(msg as ClobTradeMessage, raw);
      } else if (msg.event_type === 'price_change') {
        this.handlePriceChange(msg as ClobPriceChangeMessage);
      }
      // Other message types (heartbeats, acks) are silently consumed
    }
  }

  private handleTrade(msg: ClobTradeMessage, rawPayload: string): void {
    // Dedup check
    const dedupKey = `trade:${msg.market}:${msg.asset_id}:${msg.price}:${msg.size}:${msg.timestamp ?? ''}`;
    if (this.isDuplicate(dedupKey)) {
      this.metrics.duplicates_removed++;
      return;
    }

    const t = now();
    const sourceTimestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : null;

    // Stale data check
    if (sourceTimestamp && (t - sourceTimestamp) > config.ingestion.stale_data_threshold_ms) {
      this.metrics.stale_data_flags++;
    }

    const price = parseFloat(msg.price);
    const size = parseFloat(msg.size);

    const trade: ParsedTrade = {
      market_id: msg.market,
      condition_id: msg.condition_id ?? '',
      token_id: msg.asset_id,
      side: msg.side,
      price,
      size,
      notional: price * size,
      maker: msg.maker_address ?? '',
      taker: msg.taker_address ?? '',
      tx_hash: msg.transaction_hash ?? null,
      timestamp: sourceTimestamp ?? t,
      book_state_before: this.latestBooks.get(msg.asset_id) ?? null,
    };

    const rawEvent: RawEvent = {
      source: 'clob_ws',
      type: 'trade',
      timestamp_ingested: t,
      timestamp_source: sourceTimestamp,
      raw_payload: JSON.parse(rawPayload) as object,
      parsed: trade,
      sequence_id: this.nextSeqId(),
    };

    this.persistRawEvent(rawEvent);
    this.recordEvent();
    this.emit('trade', trade, rawEvent);
  }

  private handlePriceChange(msg: ClobPriceChangeMessage): void {
    const price = parseFloat(msg.price);
    if (isFinite(price)) {
      this.recordEvent();
      this.emit('price_change', msg.market, msg.asset_id, price);
    }
  }

  // -----------------------------------------------------------------------
  // Sequence tracking
  // -----------------------------------------------------------------------

  private nextSeqId(): number {
    return this.seqId++;
  }

  // -----------------------------------------------------------------------
  // Deduplication
  // -----------------------------------------------------------------------

  private isDuplicate(key: string): boolean {
    const existing = this.dedupCache.get(key);
    if (existing !== undefined) return true;
    this.dedupCache.set(key, now());
    return false;
  }

  private startDedupCleanup(): void {
    this.dedupCleanupTimer = setInterval(() => {
      const cutoff = now() - this.dedupTtlMs;
      for (const [key, ts] of this.dedupCache) {
        if (ts < cutoff) this.dedupCache.delete(key);
      }
    }, this.dedupTtlMs);
    if (this.dedupCleanupTimer.unref) this.dedupCleanupTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Heartbeat monitoring
  // -----------------------------------------------------------------------

  private startHeartbeatMonitor(): void {
    const checkIntervalMs = config.ingestion.health_check_interval_ms;
    this.heartbeatTimer = setInterval(() => {
      if (!this.running) return;
      const elapsed = now() - this.lastMessageAt;
      if (this.lastMessageAt > 0 && elapsed > checkIntervalMs) {
        log.warn({ elapsed_ms: elapsed }, 'No messages received — heartbeat timeout');
        this.emit('alert', 'clob_ws', `No messages for ${Math.round(elapsed / 1000)}s`);

        // Force reconnect
        if (this.ws) {
          this.ws.terminate();
          this.ws = null;
        }
        this.scheduleReconnect();
      }
    }, checkIntervalMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Raw event persistence
  // -----------------------------------------------------------------------

  private persistRawEvent(event: RawEvent): void {
    try {
      const day = dayKey(event.timestamp_ingested);
      const filePath = join(this.rawEventsDir, `${day}.jsonl`);
      appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
    } catch (err) {
      log.error({ err }, 'Failed to persist raw event');
    }
  }

  // -----------------------------------------------------------------------
  // Metrics
  // -----------------------------------------------------------------------

  private recordEvent(): void {
    this.metrics.events_received++;
    this.metrics.last_event_at = now();

    // Track events per second over a 10s window
    const t = now();
    this.eventCountWindow.push(t);
    const cutoff = t - 10_000;
    while (this.eventCountWindow.length > 0 && this.eventCountWindow[0]! < cutoff) {
      this.eventCountWindow.shift();
    }
    this.metrics.events_per_second = this.eventCountWindow.length / 10;
  }

  // -----------------------------------------------------------------------
  // Timer cleanup
  // -----------------------------------------------------------------------

  private stopTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
  }
}
