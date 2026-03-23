// ---------------------------------------------------------------------------
// Wallet Listener — On-Chain Event Subscription (raw WebSocket, no ethers)
//
// Uses raw JSON-RPC WebSocket to subscribe ONLY to the two eth_subscribe log
// filters we actually need. Eliminates the hidden eth_subscribe newHeads that
// ethers.WebSocketProvider auto-creates (~700K Alchemy CUs/day on Polygon).
//
// CU cost breakdown:
//   ethers.WebSocketProvider: newHeads (every 2s block) + log events
//   This implementation: ONLY log events (~75 CUs per wallet trade)
//
// Reconnection with exponential backoff. Runs continuously in the background.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { now, dayKey } from '../utils/time.js';
import { getLogger } from '../utils/logger.js';
import type { WalletTransaction, RawEvent, IngestionSourceMetrics } from './types.js';

const log = getLogger('wallet_listener');

const SOURCE = 'chain_listener';
const HEARTBEAT_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Polymarket CTF Exchange — ERC-1155 Transfer events
// ---------------------------------------------------------------------------

// keccak256("TransferSingle(address,address,address,uint256,uint256)")
const TRANSFER_SINGLE_TOPIC =
  '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';

const CTF_EXCHANGE_ADDRESS     = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_CTF_ADDRESS     = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

const MONITORED_CONTRACTS = [
  CTF_EXCHANGE_ADDRESS,
  NEG_RISK_CTF_ADDRESS,
  NEG_RISK_ADAPTER_ADDRESS,
];

// ---------------------------------------------------------------------------
// Minimal JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
  params?: { subscription: string; result: unknown };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface WalletListenerEvents {
  wallet_trade: [tx: WalletTransaction];
  connected: [];
  disconnected: [reason: string];
  error: [err: Error];
}

// ---------------------------------------------------------------------------
// WalletListener
// ---------------------------------------------------------------------------

export class WalletListener extends EventEmitter {
  private readonly rpcUrl: string;
  private readonly trackedWallets: Set<string>;
  private readonly rawEventsDir: string;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private ws: WebSocket | null = null;
  private running = false;
  private seqId = 0;
  private rpcId = 0;

  // Active subscription IDs returned by the node
  private subscriptionIds = new Set<string>();
  // Pending RPC calls: id → resolve callback
  private readonly pendingRpc = new Map<number, (res: JsonRpcResponse) => void>();

  // Reconnection state
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  // Dedup
  private readonly dedupCache = new Map<string, number>();
  private dedupCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private readonly dedupTtlMs: number;

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

  private epsWindowStart = now();
  private epsWindowCount = 0;

  constructor(opts: {
    rpcUrl: string;
    trackedWallets: string[];
    rawEventsDir?: string;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    dedupTtlMs?: number;
  }) {
    super();
    this.rpcUrl = opts.rpcUrl;
    this.trackedWallets = new Set(opts.trackedWallets.map((w) => w.toLowerCase()));
    this.rawEventsDir = opts.rawEventsDir ?? 'data/raw_events';
    this.reconnectBaseMs = opts.reconnectBaseMs ?? 2_000;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? 120_000;
    this.dedupTtlMs = opts.dedupTtlMs ?? 120_000;

    this.dedupCleanupTimer = setInterval(() => this.evictDedup(), 60_000);
    this.dedupCleanupTimer.unref();
  }

  // -----------------------------------------------------------------------
  // Tracked wallet management
  // -----------------------------------------------------------------------

  addWallet(address: string): void {
    this.trackedWallets.add(address.toLowerCase());
    log.info({ wallet: address }, 'Wallet added to tracking');
  }

  removeWallet(address: string): void {
    this.trackedWallets.delete(address.toLowerCase());
    log.info({ wallet: address }, 'Wallet removed from tracking');
  }

  getTrackedWallets(): string[] {
    return [...this.trackedWallets];
  }

  /** Force a reconnect to refresh topic filters after wallet list changes. */
  forceReconnect(): void {
    if (!this.running) return;
    log.info('WalletListener forcing reconnect for updated wallet list');
    this.handleDisconnect('config_reload');
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  start(): void {
    if (this.running) return;

    if (!this.rpcUrl || !this.rpcUrl.startsWith('wss://')) {
      log.warn('WalletListener disabled: no valid wss:// RPC URL configured');
      return;
    }

    this.running = true;

    if (this.trackedWallets.size === 0) {
      log.warn('WalletListener started with no tracked wallets');
    }

    log.info(
      { wallets: this.trackedWallets.size, rpc: this.rpcUrl.slice(0, 30) + '...' },
      'WalletListener starting (raw WebSocket — no newHeads overhead)',
    );
    this.connect();
  }

  stop(): void {
    this.running = false;
    this.clearHeartbeat();
    this.clearPing();

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.dedupCleanupTimer !== null) {
      clearInterval(this.dedupCleanupTimer);
      this.dedupCleanupTimer = null;
    }
    this.closeSocket('stop');
    log.info('WalletListener stopped');
  }

  // -----------------------------------------------------------------------
  // Connection
  // -----------------------------------------------------------------------

  private connect(): void {
    if (!this.running) return;

    log.info({ attempt: this.reconnectAttempt }, 'WalletListener connecting');

    const ws = new WebSocket(this.rpcUrl);
    this.ws = ws;
    this.subscriptionIds.clear();
    this.pendingRpc.clear();

    ws.on('open', () => {
      if (this.ws !== ws) return;
      log.info('WalletListener WebSocket connected');
      this.reconnectAttempt = 0;
      this.resetHeartbeat();
      this.startPing(ws);
      this.emit('connected');
      this.subscribeToEvents(ws);
    });

    ws.on('message', (data: WebSocket.RawData) => {
      if (this.ws !== ws) return;
      this.resetHeartbeat();
      this.handleMessage(data.toString());
    });

    ws.on('pong', () => {
      // Pong from our 30s ping confirms the connection is alive.
      // Reset heartbeat so we don't reconnect during quiet periods with no wallet trades.
      if (this.ws === ws) this.resetHeartbeat();
    });

    ws.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'WalletListener WebSocket error');
      this.emit('error', err);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws !== ws) return;
      const reasonStr = reason.toString() || 'unknown';
      log.warn({ code, reason: reasonStr }, 'WalletListener WebSocket closed');
      this.handleDisconnect(`ws_close_${code}`);
    });
  }

  private handleDisconnect(reason: string): void {
    log.warn({ reason }, 'WalletListener disconnected');
    this.clearHeartbeat();
    this.clearPing();
    this.closeSocket(reason);
    this.subscriptionIds.clear();
    this.pendingRpc.clear();
    this.emit('disconnected', reason);
    if (this.running) this.scheduleReconnect();
  }

  private closeSocket(reason: string): void {
    const ws = this.ws;
    if (ws === null) return;
    this.ws = null;
    try {
      ws.removeAllListeners();
      ws.terminate();
    } catch {
      // ignore cleanup errors
    }
    log.debug({ reason }, 'WalletListener socket closed');
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer !== null) return;

    const base = Math.min(
      this.reconnectBaseMs * Math.pow(2, this.reconnectAttempt),
      this.reconnectMaxMs,
    );
    const jitter = base * 0.1 * Math.random();
    const delay = Math.round(base + jitter);

    this.reconnectAttempt++;
    this.metrics.reconnect_count++;

    log.info({ delay, attempt: this.reconnectAttempt }, 'WalletListener scheduling reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // -----------------------------------------------------------------------
  // JSON-RPC helpers
  // -----------------------------------------------------------------------

  private sendRpc(ws: WebSocket, method: string, params: unknown[]): Promise<JsonRpcResponse> {
    return new Promise((resolve) => {
      const id = ++this.rpcId;
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.pendingRpc.set(id, resolve);
      try {
        ws.send(JSON.stringify(req));
      } catch (err) {
        this.pendingRpc.delete(id);
        resolve({ jsonrpc: '2.0', id, error: { code: -1, message: String(err) } });
      }
    });
  }

  // -----------------------------------------------------------------------
  // Event subscription
  // -----------------------------------------------------------------------

  private subscribeToEvents(ws: WebSocket): void {
    if (this.trackedWallets.size === 0) {
      log.warn('No tracked wallets — skipping subscription');
      return;
    }

    // Pad each wallet address to a 32-byte topic for server-side filtering.
    // Alchemy delivers ONLY events where our wallets appear in from or to position.
    const walletTopics = [...this.trackedWallets].map(
      (addr) => '0x' + addr.slice(2).padStart(64, '0'),
    );

    // Subscription A: topics[2] = from = tracked wallet (SELLs)
    const filterFrom = {
      address: MONITORED_CONTRACTS,
      topics: [TRANSFER_SINGLE_TOPIC, null, walletTopics],
    };

    // Subscription B: topics[3] = to = tracked wallet (BUYs)
    const filterTo = {
      address: MONITORED_CONTRACTS,
      topics: [TRANSFER_SINGLE_TOPIC, null, null, walletTopics],
    };

    void this.sendRpc(ws, 'eth_subscribe', ['logs', filterFrom]).then((res) => {
      if (res.error) {
        log.error({ err: res.error }, 'Failed to subscribe (from=wallet)');
      } else if (typeof res.result === 'string') {
        this.subscriptionIds.add(res.result);
        log.info({ sub_id: res.result }, 'Subscribed: from=tracked_wallet (SELLs)');
      }
    });

    void this.sendRpc(ws, 'eth_subscribe', ['logs', filterTo]).then((res) => {
      if (res.error) {
        log.error({ err: res.error }, 'Failed to subscribe (to=wallet)');
      } else if (typeof res.result === 'string') {
        this.subscriptionIds.add(res.result);
        log.info({ sub_id: res.result }, 'Subscribed: to=tracked_wallet (BUYs)');
      }
    });

    log.info(
      {
        contracts: MONITORED_CONTRACTS.length,
        wallets: this.trackedWallets.size,
        subscriptions: 2,
      },
      'Subscribing to tracked wallet TransferSingle events (2 log filters, no newHeads)',
    );
  }

  // -----------------------------------------------------------------------
  // Message handling
  // -----------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(raw) as JsonRpcResponse;
    } catch {
      this.metrics.parse_errors++;
      return;
    }

    // RPC response (e.g. eth_subscribe result)
    if (msg.id !== undefined && this.pendingRpc.has(msg.id)) {
      const resolve = this.pendingRpc.get(msg.id)!;
      this.pendingRpc.delete(msg.id);
      resolve(msg);
      return;
    }

    // Subscription notification
    if (msg.method === 'eth_subscription' && msg.params) {
      const { subscription, result } = msg.params;
      if (this.subscriptionIds.has(subscription)) {
        this.handleLogNotification(result);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Log decoding
  // -----------------------------------------------------------------------

  private handleLogNotification(logEntry: unknown): void {
    const t = now();
    this.metrics.events_received++;
    this.updateEps(t);
    this.metrics.last_event_at = t;

    try {
      this.decodeAndEmit(logEntry, t);
    } catch (err) {
      this.metrics.parse_errors++;
      log.warn({ err }, 'Failed to decode transfer log');
    }
  }

  private decodeAndEmit(logEntry: unknown, t: number): void {
    if (!logEntry || typeof logEntry !== 'object') return;
    const entry = logEntry as {
      address?: string;
      topics?: string[];
      data?: string;
      transactionHash?: string;
      blockNumber?: string;
      logIndex?: string;
    };

    const topics = entry.topics;
    if (!Array.isArray(topics) || topics.length < 4) return;
    const [topic0, , topic2, topic3] = topics as string[];
    if (!topic0 || !topic2 || !topic3) return;
    if (topic0.toLowerCase() !== TRANSFER_SINGLE_TOPIC) return;

    // Decode indexed address topics: last 40 hex chars = 20-byte address
    const from = ('0x' + topic2.slice(-40)).toLowerCase();
    const to   = ('0x' + topic3.slice(-40)).toLowerCase();

    const fromTracked = this.trackedWallets.has(from);
    const toTracked   = this.trackedWallets.has(to);
    if (!fromTracked && !toTracked) return;

    // Decode non-indexed data: (uint256 id, uint256 value) = 64 hex chars each
    const data = entry.data ?? '0x';
    const hex  = data.startsWith('0x') ? data.slice(2) : data;
    if (hex.length < 128) return;

    const tokenId = BigInt('0x' + hex.slice(0, 64)).toString();
    const value   = BigInt('0x' + hex.slice(64, 128));
    const size    = Number(value) / 1_000_000;

    const txHash      = entry.transactionHash ?? '';
    const blockNumber = parseInt(entry.blockNumber ?? '0x0', 16);

    // Dedup
    const logIndex = parseInt(entry.logIndex ?? '0x0', 16);
    const dedupKey = `${txHash}:${logIndex}`;
    if (this.isDuplicate(dedupKey)) {
      this.metrics.duplicates_removed++;
      return;
    }
    this.markSeen(dedupKey);

    if (fromTracked) {
      const tx = this.buildWalletTransaction(from, tokenId, 'SELL', size, t, txHash, blockNumber);
      this.emitTransaction(tx, entry, t);
    }

    if (toTracked) {
      const tx = this.buildWalletTransaction(to, tokenId, 'BUY', size, t, txHash, blockNumber);
      this.emitTransaction(tx, entry, t);
    }
  }

  private buildWalletTransaction(
    wallet: string,
    tokenId: string,
    side: 'BUY' | 'SELL',
    size: number,
    timestamp: number,
    txHash: string,
    blockNumber: number,
  ): WalletTransaction {
    return {
      wallet,
      market_id: '',
      token_id: tokenId,
      side,
      price: 0,
      size,
      timestamp,
      tx_hash: txHash,
      block_number: blockNumber,
      gas_price: 0,
    };
  }

  private emitTransaction(
    tx: WalletTransaction,
    logEntry: unknown,
    ingestedAt: number,
  ): void {
    const rawEvent: RawEvent = {
      source: 'chain_listener',
      type: 'wallet_tx',
      timestamp_ingested: ingestedAt,
      timestamp_source: tx.timestamp,
      raw_payload: logEntry as Record<string, unknown>,
      parsed: tx,
      sequence_id: ++this.seqId,
    };

    this.persistRawEvent(rawEvent);
    this.emit('wallet_trade', tx);

    log.debug(
      {
        wallet: tx.wallet.slice(0, 10),
        side: tx.side,
        size: tx.size,
        token: tx.token_id.slice(0, 10),
        block: tx.block_number,
      },
      'Wallet trade detected',
    );
  }

  // -----------------------------------------------------------------------
  // Heartbeat & Ping
  // -----------------------------------------------------------------------

  private resetHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setTimeout(() => {
      log.warn('WalletListener heartbeat timeout — forcing reconnect');
      this.handleDisconnect('heartbeat_timeout');
    }, HEARTBEAT_TIMEOUT_MS);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startPing(ws: WebSocket): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, PING_INTERVAL_MS);
    if (this.pingTimer.unref) this.pingTimer.unref();
  }

  private clearPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // -----------------------------------------------------------------------
  // Dedup
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private persistRawEvent(rawEvent: RawEvent): void {
    const dir = this.rawEventsDir;
    const doWrite = async () => {
      if (!existsSync(dir)) await mkdir(dir, { recursive: true });
      const file = join(dir, `wallet_${dayKey(rawEvent.timestamp_ingested)}.jsonl`);
      await appendFile(file, JSON.stringify(rawEvent) + '\n');
    };
    doWrite().catch((err) => {
      log.warn({ err }, 'WalletListener: failed to persist raw event');
    });
  }

  // -----------------------------------------------------------------------
  // EPS tracking
  // -----------------------------------------------------------------------

  private updateEps(t: number): void {
    this.epsWindowCount++;
    const elapsed = (t - this.epsWindowStart) / 1000;
    if (elapsed >= 5) {
      this.metrics.events_per_second = this.epsWindowCount / elapsed;
      this.epsWindowCount = 0;
      this.epsWindowStart = t;
    }
  }
}
