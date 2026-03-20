import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { ClobWebSocket } from '../../src/ingestion/clob_websocket.js';
import { BookPoller } from '../../src/ingestion/book_poller.js';
import { WorldState } from '../../src/state/world_state.js';
import type { ParsedTrade, ParsedBookSnapshot, MarketMetadata, BookSummary } from '../../src/ingestion/types.js';

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const TEST_DIR = join(import.meta.dirname, '..', '..', 'tmp_test_ingestion');

/** Finds a free port and returns a WSS on it. */
function createMockServer(): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 }, () => {
      const addr = wss.address();
      const port = typeof addr === 'object' ? addr.port : 0;
      resolve({ wss, port });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForEvent<T>(emitter: EventEmitter, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for event "${event}"`)), timeoutMs);
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args[0] as T);
    });
  });
}

function makeTradeMessage(overrides: Record<string, unknown> = {}): object {
  return {
    event_type: 'trade',
    market: 'mkt_1',
    asset_id: 'tok_yes',
    condition_id: 'cond_1',
    side: 'BUY',
    price: '0.55',
    size: '100',
    maker_address: '0xmaker',
    taker_address: '0xtaker',
    transaction_hash: '0xhash123',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeMetadata(): MarketMetadata {
  return {
    market_id: 'mkt_1',
    question: 'Test market?',
    condition_id: 'cond_1',
    tokens: { yes_id: 'tok_yes', no_id: 'tok_no' },
    status: 'active',
    resolution: null,
    end_date: '2025-12-31',
    category: 'test',
    tags: [],
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ClobWebSocket tests with mock server
// ---------------------------------------------------------------------------

describe('ClobWebSocket', () => {
  let wss: WebSocketServer;
  let port: number;
  let clients: WebSocket[];

  beforeEach(async () => {
    const server = await createMockServer();
    wss = server.wss;
    port = server.port;
    clients = [];
    wss.on('connection', (ws) => clients.push(ws));
  });

  afterEach(() => {
    wss.close();
  });

  function createClient(): ClobWebSocket {
    // Override the WS URL and raw events dir for testing
    const client = new ClobWebSocket();
    // Access private fields for test setup
    (client as unknown as Record<string, unknown>)['wsUrl'] = `ws://127.0.0.1:${port}`;
    (client as unknown as Record<string, unknown>)['rawEventsDir'] = TEST_DIR;
    return client;
  }

  it('connects and receives trade events', async () => {
    const client = createClient();
    client.addMarket('mkt_1');

    const tradePromise = waitForEvent<ParsedTrade>(client, 'trade');
    client.start();

    // Wait for connection
    await wait(200);
    expect(clients.length).toBe(1);

    // Send a trade
    clients[0]!.send(JSON.stringify(makeTradeMessage()));

    const trade = await tradePromise;
    expect(trade.market_id).toBe('mkt_1');
    expect(trade.token_id).toBe('tok_yes');
    expect(trade.side).toBe('BUY');
    expect(trade.price).toBeCloseTo(0.55, 10);
    expect(trade.size).toBe(100);
    expect(trade.notional).toBeCloseTo(55, 10);

    client.stop();
  });

  it('attaches pre-trade book snapshot to trades', async () => {
    const client = createClient();
    client.addMarket('mkt_1');

    // Set a book snapshot before the trade arrives
    const bookSummary: BookSummary = {
      mid: 0.50,
      spread: 0.04,
      best_bid: 0.48,
      best_ask: 0.52,
      bid_depth_5lvl: 1000,
      ask_depth_5lvl: 800,
    };
    client.updateBookSnapshot('tok_yes', bookSummary);

    const tradePromise = waitForEvent<ParsedTrade>(client, 'trade');
    client.start();
    await wait(200);

    clients[0]!.send(JSON.stringify(makeTradeMessage()));

    const trade = await tradePromise;
    expect(trade.book_state_before).not.toBeNull();
    expect(trade.book_state_before!.mid).toBe(0.50);
    expect(trade.book_state_before!.best_bid).toBe(0.48);

    client.stop();
  });

  it('persists raw events to JSONL file', async () => {
    const client = createClient();
    client.addMarket('mkt_1');

    const tradePromise = waitForEvent<ParsedTrade>(client, 'trade');
    client.start();
    await wait(200);

    clients[0]!.send(JSON.stringify(makeTradeMessage()));
    await tradePromise;

    // Give a moment for the sync write to complete
    await wait(50);

    // Check that a raw events file exists
    const files = require('node:fs').readdirSync(TEST_DIR) as string[];
    const jsonlFiles = files.filter((f: string) => f.endsWith('.jsonl'));
    expect(jsonlFiles.length).toBeGreaterThan(0);

    const content = readFileSync(join(TEST_DIR, jsonlFiles[0]!), 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);

    const rawEvent = JSON.parse(lines[0]!) as { source: string; type: string; sequence_id: number };
    expect(rawEvent.source).toBe('clob_ws');
    expect(rawEvent.type).toBe('trade');
    expect(rawEvent.sequence_id).toBe(0);

    client.stop();
  });

  it('deduplicates identical trade messages', async () => {
    const client = createClient();
    client.addMarket('mkt_1');

    const trades: ParsedTrade[] = [];
    client.on('trade', (trade) => trades.push(trade));

    client.start();
    await wait(200);

    const msg = JSON.stringify(makeTradeMessage());
    // Send the same message twice
    clients[0]!.send(msg);
    clients[0]!.send(msg);

    await wait(200);

    // Only one trade should have been emitted
    expect(trades.length).toBe(1);

    // Metrics should show 1 duplicate
    const metrics = client.getMetrics();
    expect(metrics.duplicates_removed).toBe(1);

    client.stop();
  });

  it('handles different trades as non-duplicates', async () => {
    const client = createClient();
    client.addMarket('mkt_1');

    const trades: ParsedTrade[] = [];
    client.on('trade', (trade) => trades.push(trade));

    client.start();
    await wait(200);

    clients[0]!.send(JSON.stringify(makeTradeMessage({ price: '0.55', size: '100' })));
    clients[0]!.send(JSON.stringify(makeTradeMessage({ price: '0.60', size: '200' })));

    await wait(200);

    expect(trades.length).toBe(2);

    client.stop();
  });

  it('reconnects after server disconnects', async () => {
    const client = createClient();
    // Shorten reconnect timing for test
    (client as unknown as Record<string, unknown>)['reconnectAttempt'] = 0;

    const reconnectPromise = waitForEvent<number>(client, 'reconnect', 5000);

    client.start();
    await wait(200);
    expect(clients.length).toBe(1);

    // Server-side close
    clients[0]!.close();

    const attempt = await reconnectPromise;
    expect(attempt).toBe(1);

    // Wait for the reconnect (backoff ~1s)
    await wait(2000);
    expect(clients.length).toBe(2); // second connection

    client.stop();
  });

  it('assigns monotonic sequence IDs', async () => {
    const client = createClient();
    client.addMarket('mkt_1');

    const seqIds: number[] = [];
    client.on('trade', (_trade, raw) => {
      seqIds.push(raw.sequence_id);
    });

    client.start();
    await wait(200);

    // Send 5 different trades
    for (let i = 0; i < 5; i++) {
      clients[0]!.send(JSON.stringify(makeTradeMessage({
        price: (0.50 + i * 0.01).toFixed(2),
        size: String((i + 1) * 10),
      })));
    }

    await wait(300);

    expect(seqIds).toEqual([0, 1, 2, 3, 4]);

    client.stop();
  });

  it('silently handles malformed messages', async () => {
    const client = createClient();
    client.addMarket('mkt_1');

    const trades: ParsedTrade[] = [];
    client.on('trade', (trade) => trades.push(trade));

    client.start();
    await wait(200);

    // Send garbage, then a valid trade
    clients[0]!.send('not json at all {{{');
    clients[0]!.send(JSON.stringify(makeTradeMessage()));

    await wait(200);

    expect(trades.length).toBe(1);
    expect(client.getMetrics().parse_errors).toBe(1);

    client.stop();
  });
});

// ---------------------------------------------------------------------------
// Integration: ClobWebSocket → WorldState
// ---------------------------------------------------------------------------

describe('ClobWebSocket → WorldState integration', () => {
  let wss: WebSocketServer;
  let port: number;
  let clients: WebSocket[];

  beforeEach(async () => {
    const server = await createMockServer();
    wss = server.wss;
    port = server.port;
    clients = [];
    wss.on('connection', (ws) => clients.push(ws));
  });

  afterEach(() => {
    wss.close();
  });

  it('trade events update WorldState', async () => {
    const state = new WorldState();
    state.registerMarket(makeMetadata());

    const client = new ClobWebSocket();
    (client as unknown as Record<string, unknown>)['wsUrl'] = `ws://127.0.0.1:${port}`;
    (client as unknown as Record<string, unknown>)['rawEventsDir'] = TEST_DIR;

    client.on('trade', (trade) => {
      state.updateMarketFromTrade(trade);
    });

    client.start();
    await wait(200);

    // Send two trades
    clients[0]!.send(JSON.stringify(makeTradeMessage({ price: '0.55', size: '100' })));
    clients[0]!.send(JSON.stringify(makeTradeMessage({ price: '0.60', size: '50', timestamp: new Date(Date.now() + 1).toISOString() })));

    await wait(300);

    const mkt = state.getMarket('mkt_1')!;
    expect(mkt.trade_count_1h).toBe(2);
    expect(mkt.last_trade_price.yes).toBe(0.60);
    expect(mkt.volume_1h).toBeCloseTo(55 + 30, 5); // 0.55*100 + 0.60*50

    client.stop();
  });
});

// ---------------------------------------------------------------------------
// BookPoller (unit-level, no real HTTP)
// ---------------------------------------------------------------------------

describe('BookPoller', () => {
  it('registers and removes markets', () => {
    const poller = new BookPoller();
    const meta = makeMetadata();
    poller.addMarket(meta);

    // Internally tracks both YES and NO tokens
    const tokens = (poller as unknown as Record<string, Map<string, unknown>>)['tokens'];
    expect(tokens.size).toBe(2);
    expect(tokens.has('tok_yes')).toBe(true);
    expect(tokens.has('tok_no')).toBe(true);

    poller.removeMarket(meta);
    expect(tokens.size).toBe(0);
  });
});
