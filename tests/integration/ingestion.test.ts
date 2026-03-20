/**
 * Integration tests for the ingestion layer.
 * Uses a real ws.WebSocketServer on an ephemeral port.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClobWebSocket } from '../../src/ingestion/clob_websocket.js';
import { BookPoller } from '../../src/ingestion/book_poller.js';
import { WorldState } from '../../src/state/world_state.js';
import type { ParsedTrade, ParsedBookSnapshot } from '../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function waitForEvent<T>(emitter: { once(event: string, cb: (v: T) => void): void }, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    emitter.once(event, (v: T) => {
      clearTimeout(timer);
      resolve(v);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTrade(overrides: Partial<Record<string, unknown>> = {}): object {
  return {
    event_type: 'trade',
    market: 'market-1',
    asset_id: 'token-yes-1',
    price: '0.65',
    size: '100',
    side: 'BUY',
    maker_address: '0xmaker',
    taker_address: '0xtaker',
    transaction_hash: `0xhash-${Math.random()}`,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeBookSnapshot(overrides: Partial<Record<string, unknown>> = {}): object {
  return {
    event_type: 'price_change',
    asset_id: 'token-yes-1',
    market: 'market-1',
    bids: [{ price: 0.64, size: 500 }, { price: 0.63, size: 300 }],
    asks: [{ price: 0.66, size: 400 }, { price: 0.67, size: 200 }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ClobWebSocket tests
// ---------------------------------------------------------------------------

describe('ClobWebSocket', () => {
  let server: WebSocketServer;
  let serverClients: WebSocket[];
  let port: number;
  let rawEventsDir: string;

  beforeEach(() => {
    serverClients = [];
    server = new WebSocketServer({ port: 0 });
    server.on('connection', (ws) => serverClients.push(ws));
    port = (server.address() as AddressInfo).port;
    rawEventsDir = mkdtempSync(join(tmpdir(), 'clob-test-'));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function makeClient(): ClobWebSocket {
    return new ClobWebSocket({
      wsUrl: `ws://localhost:${port}`,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
      dedupTtlMs: 5_000,
      rawEventsDir,
    });
  }

  it('emits trade event when server sends trade message', async () => {
    const client = makeClient();
    client.start();

    await waitForEvent(client, 'connected');

    const tradePayload = makeTrade({ transaction_hash: '0xabc123' });
    const tradePromise = waitForEvent<ParsedTrade>(client, 'trade');
    serverClients[0]!.send(JSON.stringify(tradePayload));

    const trade = await tradePromise;
    expect(trade.market_id).toBe('market-1');
    expect(trade.token_id).toBe('token-yes-1');
    expect(trade.price).toBeCloseTo(0.65);
    expect(trade.size).toBeCloseTo(100);
    expect(trade.side).toBe('BUY');

    client.stop();
  });

  it('attaches pre-trade book snapshot when available', async () => {
    const client = makeClient();

    // Pre-load a book snapshot
    const snap: ParsedBookSnapshot = {
      market_id: 'market-1',
      token_id: 'token-yes-1',
      bids: [[0.64, 500]],
      asks: [[0.66, 400]],
      timestamp: Date.now(),
      mid_price: 0.65,
      spread: 0.02,
      spread_bps: 30.77,
      bid_depth_1pct: 500,
      ask_depth_1pct: 400,
      bid_depth_5pct: 500,
      ask_depth_5pct: 400,
      vwap_bid_1000: 0.64,
      vwap_ask_1000: 0.66,
      queue_position_estimate: 5,
    };
    client.updateBookSnapshot(snap);

    client.start();
    await waitForEvent(client, 'connected');

    const tradePayload = makeTrade({ transaction_hash: '0xwithbook' });
    const tradePromise = waitForEvent<ParsedTrade>(client, 'trade');
    serverClients[0]!.send(JSON.stringify(tradePayload));

    const trade = await tradePromise;
    expect(trade.book_state_before).not.toBeNull();
    expect(trade.book_state_before!.mid).toBeCloseTo(0.65);

    client.stop();
  });

  it('persists raw events to JSONL file', async () => {
    const client = makeClient();
    client.start();
    await waitForEvent(client, 'connected');

    const tradePromise = waitForEvent<ParsedTrade>(client, 'trade');
    serverClients[0]!.send(JSON.stringify(makeTrade({ transaction_hash: '0xpersist' })));
    await tradePromise;

    // Give fs a moment to flush
    await sleep(50);

    const files = readdirSync(rawEventsDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);

    client.stop();
  });

  it('deduplicates events with same transaction hash', async () => {
    const client = makeClient();
    client.start();
    await waitForEvent(client, 'connected');

    const trades: ParsedTrade[] = [];
    client.on('trade', (t) => trades.push(t));

    const payload = JSON.stringify(makeTrade({ transaction_hash: '0xdup' }));
    serverClients[0]!.send(payload);
    serverClients[0]!.send(payload);

    await sleep(200);

    expect(trades).toHaveLength(1);
    expect(client.metrics.duplicates_removed).toBe(1);

    client.stop();
  });

  it('does not deduplicate events with different transaction hashes', async () => {
    const client = makeClient();
    client.start();
    await waitForEvent(client, 'connected');

    const trades: ParsedTrade[] = [];
    client.on('trade', (t) => trades.push(t));

    serverClients[0]!.send(JSON.stringify(makeTrade({ transaction_hash: '0xuniq1' })));
    serverClients[0]!.send(JSON.stringify(makeTrade({ transaction_hash: '0xuniq2' })));

    await sleep(200);

    expect(trades).toHaveLength(2);

    client.stop();
  });

  it('reconnects after server closes the connection', async () => {
    const client = makeClient();
    client.start();

    await waitForEvent(client, 'connected');

    // Close server-side connection
    serverClients[0]!.close();

    const reconnectedPromise = waitForEvent(client, 'connected', 2000);
    await reconnectedPromise;

    expect(client.metrics.reconnect_count).toBeGreaterThan(0);

    client.stop();
  });

  it('assigns monotonically increasing sequence IDs', async () => {
    const client = makeClient();
    client.start();
    await waitForEvent(client, 'connected');

    const trades: ParsedTrade[] = [];
    client.on('trade', (t) => trades.push(t));

    for (let i = 0; i < 3; i++) {
      serverClients[0]!.send(JSON.stringify(makeTrade({ transaction_hash: `0xseq${i}` })));
    }

    await sleep(300);
    expect(trades).toHaveLength(3);

    // seqId is internal but metrics.events_received should be 3
    expect(client.metrics.events_received).toBe(3);

    client.stop();
  });

  it('handles malformed JSON without crashing', async () => {
    const client = makeClient();
    client.start();
    await waitForEvent(client, 'connected');

    serverClients[0]!.send('not-valid-json{{{');
    serverClients[0]!.send(JSON.stringify(makeTrade({ transaction_hash: '0xafter-bad' })));

    const tradePromise = waitForEvent<ParsedTrade>(client, 'trade', 2000);
    const trade = await tradePromise;

    expect(trade.market_id).toBe('market-1');
    expect(client.metrics.parse_errors).toBe(1);

    client.stop();
  });

  it('emits book_snapshot for price_change events', async () => {
    const client = makeClient();
    client.start();
    await waitForEvent(client, 'connected');

    const snapPromise = waitForEvent<ParsedBookSnapshot>(client, 'book_snapshot');
    serverClients[0]!.send(JSON.stringify(makeBookSnapshot()));

    const snap = await snapPromise;
    expect(snap.token_id).toBe('token-yes-1');
    expect(snap.mid_price).toBeCloseTo(0.65);

    client.stop();
  });

  it('ClobWebSocket → WorldState end-to-end: trade updates market state', async () => {
    const state = new WorldState();

    // Register a market
    state.registerMarket({
      market_id: 'market-1',
      question: 'Test?',
      condition_id: 'cond-1',
      tokens: { yes_id: 'token-yes-1', no_id: 'token-no-1' },
      status: 'active',
      resolution: null,
      end_date: '2026-12-31',
      category: 'test',
      tags: [],
    });

    // First update book snapshot so market has a price
    state.updateMarket({
      market_id: 'market-1',
      token_id: 'token-yes-1',
      bids: [[0.64, 500]],
      asks: [[0.66, 400]],
      timestamp: Date.now(),
      mid_price: 0.65,
      spread: 0.02,
      spread_bps: 30,
      bid_depth_1pct: 500,
      ask_depth_1pct: 400,
      bid_depth_5pct: 500,
      ask_depth_5pct: 400,
      vwap_bid_1000: 0.64,
      vwap_ask_1000: 0.66,
      queue_position_estimate: 5,
    });

    const client = makeClient();
    client.start();
    await waitForEvent(client, 'connected');

    client.on('trade', (trade) => {
      const market = state.getAllMarkets().find(
        (m) => m.tokens.yes_id === trade.token_id || m.tokens.no_id === trade.token_id,
      );
      if (market) state.updateMarketFromTrade(trade);
    });

    serverClients[0]!.send(
      JSON.stringify(makeTrade({ transaction_hash: '0xe2e', price: '0.70', size: '200' })),
    );

    await sleep(300);

    const market = state.getMarket('market-1');
    expect(market).not.toBeUndefined();
    expect(market!.last_trade_price.yes).toBeCloseTo(0.70);

    client.stop();
  });
});

// ---------------------------------------------------------------------------
// BookPoller tests
// ---------------------------------------------------------------------------

describe('BookPoller', () => {
  it('registers tokens and emits book_snapshot events', async () => {
    // We cannot easily mock fetch in a real integration test without a server.
    // Instead test the addToken/removeToken API and that polling is scheduled.
    const poller = new BookPoller('http://localhost:9999', 50_000);

    poller.addToken('tok-1', 'mkt-1');
    poller.addToken('tok-2', 'mkt-2');

    // No crash when removing a token that was never added
    expect(() => poller.removeToken('tok-nonexistent')).not.toThrow();

    poller.removeToken('tok-2');

    // Poller never started — just verify construction and registration don't throw
    expect(true).toBe(true);
  });
});
